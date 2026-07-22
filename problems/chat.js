window.DATA = window.DATA || {};
window.DATA['chat'] = {
  cat:"realtime · fan-out · ordering",
  title:"Design a real-time chat system (WhatsApp / Messenger)",
  blurb:"1:1 and group messaging with receipts, presence, and offline delivery across hundreds of millions of live connections.",
  prompt:"Let's design a real-time chat system like WhatsApp or Messenger. It handles 1:1 and group conversations, shows delivery and read receipts and presence, delivers messages to people who are offline, and pushes notifications — all across hundreds of millions of simultaneously connected clients. Start with the high-level architecture and rough numbers, then we'll drill into components — and I'll be throwing failure scenarios at you.",
  opening:"Let me frame it before drawing boxes.<br><br><strong>Functional:</strong> 1:1 and group messaging, delivery + read receipts, presence (online / last-seen / typing), offline delivery when a recipient is disconnected, and push notifications. <strong>Non-functional:</strong> delivery feels instant (p99 well under a second), no message ever lost once accepted, correct per-conversation ordering, and hundreds of millions of concurrent connections held cheaply.<br><br><strong>Back-of-envelope:</strong> ~2B users, ~500M concurrent connections, ~100B messages/day ≈ 1.16M msg/s average and 3-5x at peak (~5M/s). Messages are small (~200 bytes of ciphertext + metadata) → ~20 TB/day of history, so a sharded wide-column store, never one box. Heartbeats from 500M live connections would be ~17M/s if done naively — a number I'll have to design around.<br><br>I'll start deliberately minimal: <strong>client → WebSocket gateway → chat service → message store</strong>. The gateway holds the persistent connection, the chat service routes and applies logic, the store keeps durable history. That skeleton delivers a 1:1 message correctly. As we add groups, presence, offline users and failure pressure I'll grow it. Pick a box and let's push.",
  nodes:[
    {id:"client",name:"Client",sub:"phone app",x:40,y:150},
    {id:"gw",name:"WebSocket gateway",sub:"persistent conns",x:210,y:150},
    {id:"chat",name:"Chat service",sub:"routing + logic",x:380,y:150},
    {id:"store",name:"Message store",sub:"durable history",x:550,y:150},
    {id:"queue",name:"Message queue",sub:"decouple + fanout",x:380,y:40},
    {id:"presence",name:"Presence service",sub:"online status",x:210,y:40},
    {id:"push",name:"Notification svc",sub:"APNs / FCM",x:550,y:40},
  ],
  edges:[["client","gw"],["gw","chat"],["chat","store"],["chat","queue"],["queue","push"],["gw","presence"],["chat","push"]],
  core:["client","gw","chat","store"],
  basic:["client","gw","chat","store"],
  schema:{tables:[
    {name:"messages",pk:"conversation_id, seq",columns:[
      ["conversation_id","uuid","partition key — which conversation"],
      ["seq","bigint","per-conversation monotonic order (clustering key)"],
      ["message_id","uuid","server id"],
      ["client_msg_id","uuid","sender-generated idempotency/dedupe key"],
      ["sender_id","bigint","who sent it"],
      ["ciphertext","blob","E2EE payload — server never sees plaintext"],
      ["created_at","timestamptz","accept time"],
    ],rows:[
      ["c-9f2a","4470","m-01","b3f1-aa","42","0x9e2c…","2026-07-22 10:04:59"],
      ["c-9f2a","4471","m-02","b3f1-bb","42","0x71a4…","2026-07-22 10:05:01"],
      ["c-1b30","881","m-03","c7d2-01","88","0x0fce…","2026-07-22 10:05:03"],
    ]},
    {name:"conversations",pk:"conversation_id",columns:[
      ["conversation_id","uuid","primary key"],
      ["type","varchar(8)","1:1 or group"],
      ["member_ids","list<bigint>","participant user ids"],
      ["last_seq","bigint","highest assigned seq (seq allocator)"],
      ["created_at","timestamptz","creation time"],
    ],rows:[
      ["c-9f2a","1:1","[42, 77]","4471","2026-07-01 08:00:00"],
      ["c-1b30","group","[88, 42, 91, 12]","881","2026-07-10 14:20:00"],
    ]},
    {name:"user_inbox",pk:"user_id, conversation_id",columns:[
      ["user_id","bigint","recipient (partition key)"],
      ["conversation_id","uuid","which conversation (clustering key)"],
      ["last_delivered_seq","bigint","delivery cursor — highest seq acked by device"],
      ["last_read_seq","bigint","read-receipt cursor"],
      ["updated_at","timestamptz","last cursor advance"],
    ],rows:[
      ["77","c-9f2a","4471","4470","2026-07-22 10:05:02"],
      ["12","c-1b30","880","880","2026-07-22 09:40:00"],
      ["91","c-1b30","(null)","(null)","(null)"],
    ]},
    {name:"connection_registry",pk:"user_id",columns:[
      ["user_id","bigint","primary key"],
      ["gateway_node","varchar(32)","node currently holding the socket"],
      ["conn_id","varchar(32)","socket/connection id on that node"],
      ["connected_at","timestamptz","when the socket was established"],
    ],rows:[
      ["42","gw-07","ab12","2026-07-22 09:58:10"],
      ["77","gw-31","cd34","2026-07-22 10:01:44"],
      ["91","(null)","(null)","(null)"],
    ]},
  ]},
  flows:[
    {id:"send",name:"Send a 1:1 message",steps:[
      {node:"client",text:"A assigns a <code>client_msg_id</code>, renders optimistically, and sends over its open WebSocket."},
      {node:"gw",text:"A's gateway receives the frame on the persistent socket and forwards it to a chat service instance."},
      {node:"chat",text:"Dedupes on <code>client_msg_id</code>, assigns a per-conversation monotonic <code>seq</code>."},
      {node:"store",text:"Persists the message row durably <strong>before</strong> acking — the store is the source of truth."},
      {node:"client",text:"Chat acks A with the assigned <code>seq</code>; A's pending tick becomes a sent tick."},
    ]},
    {id:"deliver",name:"Deliver to recipient (online + offline)",steps:[
      {node:"chat",text:"Looks up B in the connection registry to find B's gateway node."},
      {node:"gw",text:"If B is online, B's gateway pushes the message down B's socket and B's device acks (delivered)."},
      {node:"store",text:"If B is offline, the message stays undelivered against B's cursor for later pull."},
      {node:"queue",requires:["queue"],text:"For group fan-out, a single task is enqueued and workers deliver per-recipient asynchronously."},
      {node:"push",requires:["push"],text:"For an offline B, a notification service sends an APNs/FCM alert to wake the app."},
      {node:"client",text:"B reconnects and pulls all messages with <code>seq &gt; last_delivered_seq</code>, then advances its cursor."},
    ]},
  ],
  requirements:{
    functional:[
      "Send and receive 1:1 and group messages in real time, with delivery and read receipts",
      "Show presence — online, last-seen, and typing indicators",
      "Deliver messages to users who are offline, then wake them with a push notification",
      "Sync a user's full history and order across all of their devices",
    ],
    nonFunctional:[
      "Delivery feels instant — p99 well under a second — and no message is ever lost once accepted",
      "Correct per-conversation ordering with no duplicates, even on retries and out-of-order arrival",
      "Hold hundreds of millions of concurrent connections cheaply (~500M sockets)",
      "Scale to ~100B messages/day (~1M msg/s average, ~5M/s peak) and huge groups",
    ],
  },
  reqBuild:[
    {req:"Send and receive 1:1 messages in real time",turns:[
      {who:"intv",text:"Start with the simplest thing that satisfies requirement one: A types a message to B and B sees it appear live. What's the minimal path through your four core boxes?"},
      {who:"cand",text:"A holds an open <strong>WebSocket</strong> to the <strong>gateway</strong>; the send travels gateway to <strong>chat service</strong>, which <strong>persists</strong> the message to the <strong>store</strong>, acks A, then looks up B and pushes it down B's socket. Persist-before-deliver means the message is durable the instant I ack, and the store is the source of truth that a later offline pull or a second device reads from. That skeleton delivers a 1:1 message correctly.<span class='eg'>A sends → chat persists seq 4471 → ack A (sent tick) → push to B → B acks (delivered tick).</span>"},
      {who:"intv",text:"A and B are connected to different gateway nodes. How does the chat service get the message onto B's specific socket?"},
      {who:"cand",text:"Through an indirection: on connect each gateway records B in a <strong>connection registry</strong> (userId to nodeId), so the chat service looks B up, forwards to the node holding B, and that node writes the bytes. I'm keeping the chat service <strong>stateless</strong> — all durable state is in the store and registry — so any instance handles any message. I'll defer how the registry survives churn and crashes to the deep dives; right now the minimal correct path is persist, ack, route, push."},
    ],resources:[
      {title:"MDN — WebSockets API",url:"https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API"},
      {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
    ]},
    {req:"Show presence — who is online (adds a presence service)",reveal:["presence"],turns:[
      {who:"intv",text:"Requirement two: A opens a chat and wants to see whether B is online right now. Does the gateway just answer that?"},
      {who:"cand",text:"A single gateway only knows its own sockets, and B is almost always on a different node, so no one gateway has the global view. Let me add a shared <strong>presence service</strong> that aggregates connection state across all gateways: every gateway reports connects and disconnects, and presence keeps a <code>userId to online</code> map any gateway or the chat service can query.<span class='eg'>A opens chat with B → A's gateway asks presence for userB → online, last-seen now.</span>That's a cross-cutting shared service, not something a single connection-holding node can answer."},
      {who:"intv",text:"Why is presence its own service rather than a column you update on the store next to the messages?"},
      {who:"cand",text:"Because presence is <strong>soft, high-churn, ephemeral state</strong> with completely different properties from messages. It flips constantly, tolerates being slightly stale, and must never sit on the message path — the store is durable and authoritative and I don't want heartbeat churn hammering it. Keeping presence in its own service (fronted by an in-memory TTL store) lets it be approximate and cheap while the store stays exact. I'll work its heartbeat volume and failure behaviour in the presence box itself."},
    ],resources:[
      {title:"Redis documentation",url:"https://redis.io/docs/"},
      {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
    ]},
    {req:"Deliver messages to users who are offline (adds a notification service)",reveal:["push"],turns:[
      {who:"intv",text:"Requirement three: A messages B but B's app is killed with no live socket. The push down the socket fails. What's the delivery story so B still gets it?"},
      {who:"cand",text:"Delivery already half-works because I persisted before delivering: the message sits durably in the store marked undelivered against B's <strong>cursor</strong>, so when B reconnects it pulls everything after its last-delivered seq — nothing is lost. But to <em>alert</em> B now, let me add a <strong>notification service</strong> that sends a push through APNs or FCM. The push just wakes the device, which then pulls the real message.<span class='eg'>B offline → socket push fails → mark undelivered + enqueue push → APNs wakes app → B pulls seq greater than cursor.</span>"},
      {who:"intv",text:"So is the push itself the delivery — do you put the message text in it?"},
      {who:"cand",text:"No — push is a best-effort <strong>alert to come pull</strong>, never the delivery channel; the store plus cursor is the real delivery. The payload carries only a lightweight nudge (and with end-to-end encryption it can't carry content anyway), so the device wakes and fetches the actual message. That framing means a dropped or delayed push only costs timeliness of the buzz, never the message — B still gets everything on next reconnect. I'll cover coalescing and provider outages in the notification box."},
    ],resources:[
      {title:"WhatsApp architecture (HighScalability)",url:"http://highscalability.com/blog/2014/2/26/the-whatsapp-architecture-facebook-bought-for-19-billion.html"},
      {title:"Signal Protocol documentation",url:"https://signal.org/docs/"},
    ]},
  ],
  systemDives:[
    {title:"A group of 100K members gets a message — fan-out storm",tag:"scaling",reveal:["queue"],turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> A posts one message to a group of <b>100,000</b> members. Done naively the chat service now does 100K registry lookups and 100K pushes synchronously on A's send path — A blocks for many seconds. And a busy group sees this thousands of times an hour. Fix the fan-out.</span>"},
      {who:"cand",text:"Fan-out must come off the send path entirely. I <strong>persist once</strong> (one row, one seq in the conversation), ack A immediately, then drop a single fan-out task onto a <strong>message queue</strong> — let me add it. Workers consume that task and do the per-recipient deliveries asynchronously and in parallel. A's latency is one persist plus one enqueue, independent of group size.<span class='eg'>A's send: persist + enqueue ≈ a few ms; the 100K deliveries drain behind the queue.</span>"},
      {who:"intv",text:"Even async, 100K deliveries per message thousands of times an hour is enormous. Do you really push to every one of the 100K?"},
      {who:"cand",text:"No — above a size threshold I flip huge groups to <strong>fan-out-on-read (pull)</strong>: write the message once to the conversation, and members pull it via their last-delivered cursor when active, with one lightweight coalesced push as the nudge. Small, active groups stay fan-out-on-write for instant delivery. So it's a hybrid keyed on group size and activity — write-fanout where it's cheap, read-fanout where write-fanout would explode.<span class='eg'>100K eager pushes → 1 write + lazy cursor pulls by the few hundred currently active.</span>"},
      {who:"intv",text:"Fan-out-on-read just moves the storm to reads — everyone in that active group pulling the same conversation."},
      {who:"cand",text:"But reads are cheaper and cache-friendly: they all hit <em>one</em> conversation partition, which caches beautifully, and only <em>active</em> members pull — idle ones get a push and pull lazily on open. So the concurrent read set is a fraction of 100K, served largely from cache. The queue also <strong>absorbs bursts</strong> for the groups still on write-fanout, applying backpressure so delivery degrades to slightly-delayed, never dropped. Neither side is allowed to explode."},
      {who:"intv",text:"How does the queue keep per-conversation order while parallelizing across groups?"},
      {who:"cand",text:"<strong>Partition by conversationId</strong> so every event for one conversation lands on one partition and is consumed in order, while different conversations parallelize across partitions. For a giant hot conversation I sub-key it (conversationId + bucket), accepting weaker cross-bucket ordering — which is fine because the real ordering guarantee is the <strong>server-assigned seq</strong>, not queue arrival order; clients always sort by seq. I'll detail the queue's durability in its own box."},
    ],resources:[
      {title:"Apache Kafka documentation",url:"https://kafka.apache.org/documentation/"},
      {title:"System Design Primer — asynchronism",url:"https://github.com/donnemartin/system-design-primer#asynchronism"},
    ]},
    {title:"A gateway node holding 500K sockets crashes",tag:"failover",turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a gateway node holding <b>500,000</b> live sockets loses power — no graceful shutdown. Half a million users are instantly disconnected. Walk me through the next 30 seconds and prove nothing is lost.</span>"},
      {who:"cand",text:"All 500K clients detect the dead socket and reconnect with <strong>exponential backoff plus jitter</strong>; the load balancer spreads them across surviving nodes and each rewrites its <strong>connection registry</strong> entry to the new node. <strong>No message is lost</strong>: any in-flight message is already durable in the store — the sender either got an ack (persisted) or didn't (it stays in the on-device <strong>outbox</strong> and resends with the same client-msg-id). Presence keys' TTLs lapse and mark those users offline until they reconnect.<span class='eg'>node dies → 500K reconnect over ~30s → registry rewrites → clients pull seq greater than cursor.</span>"},
      {who:"intv",text:"500K reconnecting at once is its own mini storm, and each one writes the registry. Does that tip over the next node or the registry?"},
      {who:"cand",text:"The jittered backoff spreads the 500K over tens of seconds so no single surviving node gets a synchronized spike, and I rate-limit connection accepts per node as a guardrail. The registry is a <strong>sharded store</strong> — 500K writes over that window is well within it. Messages that arrived during the gap aren't pushed blindly; each client <strong>pulls by last-delivered cursor</strong> right after reconnect. So the crash degrades to a brief reconnect wave, not data loss."},
      {who:"intv",text:"The registry still says those users are on the dead node for a while. Doesn't that misroute their messages?"},
      {who:"cand",text:"Briefly, yes — a <strong>stale registry entry</strong>. A forward to the dead node fails or times out, so I treat the user as effectively offline: the message is already durable, I mark it undelivered against the cursor and fall through to the offline plus push path. A TTL plus heartbeat refresh means the stale entry self-heals as the client reconnects and rewrites it. Crucially the <em>delivered</em> receipt only fires on a real device ack, never on a successful forward, so a stale route can never manufacture a false delivered."},
    ],resources:[
      {title:"WhatsApp architecture (HighScalability)",url:"http://highscalability.com/blog/2014/2/26/the-whatsapp-architecture-facebook-bought-for-19-billion.html"},
      {title:"Redis documentation",url:"https://redis.io/docs/"},
    ]},
    {title:"Guarantee per-conversation ordering and no duplicates",tag:"durability",turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> on a flaky link A's client retries a send, and meanwhile two of A's messages reach the service out of order — <b>A2 arrives before A1</b>. Left alone, recipients could see a duplicate and scrambled order. How do you guarantee correct, dupe-free ordering?</span>"},
      {who:"cand",text:"Two mechanisms together. <strong>Ordering:</strong> the server assigns a <strong>per-conversation monotonic seq</strong> on accept, and every client renders strictly by seq — so A2 physically arriving first still displays after A1 once both have seqs. <strong>Idempotency:</strong> the <strong>client-msg-id</strong> is the dedupe key — before assigning a seq I check whether that id already exists; a retry maps to the same seq and never becomes a second message.<span class='eg'>retry of client-msg-id b3f1 → lookup hits → return existing seq 4471, no new row.</span>"},
      {who:"intv",text:"That per-conversation seq counter — where does it live without becoming a per-conversation bottleneck or a single point of failure?"},
      {who:"cand",text:"Because it's scoped <em>per conversation</em>, contention only exists among writers to one conversation, which is naturally small. I allocate it where the conversation is anchored: an atomic conditional increment on that conversation's store partition, or a single owning chat partition per conversation (<strong>partition-by-conversationId</strong>). Different conversations advance fully in parallel — there's no global counter. That same partition choice is what lets the queue preserve order too, so ordering is consistent end to end."},
      {who:"intv",text:"B has three devices. How do they all end up with the same order and no dupes?"},
      {who:"cand",text:"Each device keeps its own <strong>last-delivered cursor</strong> per conversation and pulls messages with <code>seq greater than cursor</code> in seq order, then advances. Since seq is monotonic and server-assigned, all three devices converge on the identical ordering independently, and the client-msg-id dedupe means a redelivery (from a queue retry or a reconnect) collapses to a no-op. So ordering and dedupe are properties of seq plus client-msg-id, not of arrival timing — which is exactly why out-of-order arrival is harmless."},
    ],resources:[
      {title:"Idempotence (Wikipedia)",url:"https://en.wikipedia.org/wiki/Idempotence"},
      {title:"How Discord stores billions of messages",url:"https://discord.com/blog/how-discord-stores-billions-of-messages"},
    ]},
    {title:"Add end-to-end encryption — what can the server still do",tag:"durability",turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> product now requires <b>end-to-end encryption</b> for all 1:1 and group chats. The server must never see plaintext. Which of your existing functions survive, and which break?</span>"},
      {who:"cand",text:"With E2EE (Signal protocol) the <strong>clients hold the keys</strong> and the server only ever stores and routes <em>ciphertext plus routing metadata</em> — senderId, conversationId, seq, timestamps. What <strong>survives</strong> is almost everything structural: persist-then-deliver, seq ordering, client-msg-id dedupe, cursors, offline pull, fan-out — they all operate on an opaque blob and don't care what's inside. Key exchange runs through a key-distribution service handing out prekeys, and groups use sender keys so one encryption fans out to members.<span class='eg'>store row = seq, senderId, conversationId, ciphertext-blob — no plaintext server-side.</span>"},
      {who:"intv",text:"So what actually breaks — what could the server do before that it now can't?"},
      {who:"cand",text:"Anything that reads <em>content</em>. <strong>Server-side search</strong> is gone — search moves client-side over locally-decrypted history. <strong>Content-based spam and abuse detection</strong> is gone — abuse handling now leans on <em>metadata</em> (send rates, fan-out patterns, brand-new accounts blasting strangers) and user reports that can attach decrypted samples with consent. Rich server-composed push previews are gone too, since the notification service only sees ciphertext. It genuinely constrains features, but confidentiality is the hard requirement, so I design around metadata rather than weaken E2EE."},
      {who:"intv",text:"Does encryption change your no-loss and ordering guarantees at all?"},
      {who:"cand",text:"No — those are deliberately content-agnostic. The store still quorum-replicates the ciphertext blob, still acks only after a durable write, and seq is assigned on the metadata envelope, not the plaintext, so ordering and dedupe are untouched. The one real addition is <strong>key management</strong>: losing a device shouldn't lose history, so I back up an encrypted key store the user controls, and new-device onboarding re-runs key exchange. Durability of <em>messages</em> is unchanged; I just add durability of <em>keys</em> as a client-owned concern."},
    ],resources:[
      {title:"Signal Protocol documentation",url:"https://signal.org/docs/"},
      {title:"How Discord stores billions of messages",url:"https://discord.com/blog/how-discord-stores-billions-of-messages"},
    ]},
  ],
  q:{
    client:[
      {l:"easy",tag:"concept",q:"Trace a send from the phone's point of view.",turns:[
        {who:"intv",text:"Take me through what happens on the phone when I type a message and hit send. Be precise about what the client owns before anything hits the network."},
        {who:"cand",text:"<ul><li><strong>Assign a client-msg-id</strong> — a client-generated UUID that is the idempotency key for this message.</li><li><strong>Optimistic render</strong> — show it immediately with a single grey 'pending' tick.</li><li><strong>Persist to a local outbox</strong> (on-device SQLite) so it survives an app kill.</li><li><strong>Send</strong> over the already-open WebSocket.</li><li><strong>On server ack</strong> (carrying the server-assigned seq) mark it 'sent'; later delivered / read receipts flip the ticks.</li></ul>The client owns identity and durability of its own outbound queue.<span class='eg'>client-msg-id b3f1... sent → server acks with seq 4471 → UI: pending tick becomes sent tick.</span>"},
        {who:"intv",text:"You render optimistically before the server acks. What if that ack never comes?"},
        {who:"cand",text:"The outbox entry stays 'pending' and the client retries on a timer / on reconnect — <em>with the same client-msg-id</em>. Because the server dedupes on that id, a resend is a no-op if the original actually landed, so I never create a duplicate. After N failed attempts the UI shows a 'failed, tap to retry' state. The invariant: an unacked message lives in the durable outbox, not just in memory."},
      ],resources:[
        {title:"MDN — WebSockets API",url:"https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API"},
        {title:"Idempotence (Wikipedia)",url:"https://en.wikipedia.org/wiki/Idempotence"},
      ]},
      {l:"hard",tag:"scaling",q:"20M clients drop and reconnect in seconds.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a regional mobile carrier blips and <b>20M</b> clients drop their sockets and try to reconnect within a few seconds. That reconnect storm slams your gateway tier. What in the client design keeps this from becoming an outage?</span>"},
        {who:"cand",text:"The client must reconnect <em>politely</em>: <strong>exponential backoff with jitter</strong> so 20M devices don't retry on the same tick, and a <strong>resume token</strong> so reconnect is cheap — it re-establishes the socket and syncs a delta, not a full state reload. The client also shouldn't re-send its whole outbox blindly; it resumes from where it left off. So the storm spreads over tens of seconds and each reconnect is lightweight."},
        {who:"intv",text:"On reconnect, how does the client avoid re-downloading a day of history for every conversation?"},
        {who:"cand",text:"It syncs by <strong>last-delivered cursor</strong> per conversation — it asks only for messages with seq greater than what it already has, in order. So a reconnect after a blip pulls the handful of missed messages, not the backlog. That's the same cursor mechanism the offline path uses; it keeps reconnect bandwidth proportional to what actually changed, which is what makes a 20M-client storm survivable."},
      ],resources:[
        {title:"MDN — WebSockets API",url:"https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"medium",tag:"failover",q:"Phone dies mid-send, reboots later.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a user fires off 5 messages in a subway with no signal, the phone battery then dies, and it reboots on wifi 20 minutes later. What happens to those 5 messages?</span>"},
        {who:"cand",text:"They were written to the on-device <strong>outbox</strong> before the send was attempted, so they survive the reboot. On reconnect the client flushes the outbox in order, each carrying its original <strong>client-msg-id</strong>. The server assigns a per-conversation seq to each and acks; the client flips them to 'sent'. Nothing is lost because durability started on the device, before the network was ever involved."},
        {who:"intv",text:"During those 20 minutes other people also messaged that conversation. When your 5 flush, won't ordering be scrambled — theirs and yours interleaved wrong?"},
        {who:"cand",text:"No, because arrival order at the server does not decide display order — the <strong>server-assigned monotonic seq</strong> does. My 5 get seqs at flush time, others' messages already have earlier seqs, and every client renders strictly by seq. So the late flush slots my messages after the ones that were accepted while I was dark, which is the honest ordering. If two clients truly raced, seq assignment at the server breaks the tie deterministically for everyone."},
      ],resources:[
        {title:"Idempotence (Wikipedia)",url:"https://en.wikipedia.org/wiki/Idempotence"},
        {title:"WhatsApp architecture (HighScalability)",url:"http://highscalability.com/blog/2014/2/26/the-whatsapp-architecture-facebook-bought-for-19-billion.html"},
      ]},
      {l:"medium",tag:"capacity",q:"Size local storage and the reconnect delta.",turns:[
        {who:"intv",text:"Size the client's footprint. The phone caches history locally and syncs on reconnect. Roughly how much on-device storage does a heavy user need, and how big is a typical reconnect delta?"},
        {who:"cand",text:"Per-user volume is modest: ~2B users against 100B messages/day is ~50 sent per user/day, and even a chatty user receiving a few hundred a day at ~1 KB stored (ciphertext plus metadata) is tiny. A year for a heavy user at ~300/day is ~110K messages ≈ ~100 MB — nothing for a modern phone. The outbox holds only <em>unacked</em> sends, normally zero and a handful in a tunnel. A reconnect delta is just messages with <code>seq &gt; cursor</code> — usually single digits per active conversation, not the backlog.<span class='eg'>300 msgs/day × 365 ≈ 110K × ~1 KB ≈ 110 MB local; reconnect after a 5-min blip ≈ a few msgs per active chat.</span>"},
        {who:"intv",text:"Storing a year locally is cheap. So why not keep <em>everything</em> on the device and never read server history at all?"},
        {who:"cand",text:"Because local-only breaks the moment there's a second device, a reinstall, or storage pressure — the phone is a cache, not the source of truth. Trade-off: unbounded local history gives instant scroll-back but loses on multi-device sync, recovery after a wipe, and low-end devices. Decision: cap the local cache to a rolling recent window and page older messages from the store on demand, keeping the phone lean while the store stays authoritative.<span class='eg'>keep recent ~N months hot on device → older scroll-back pages from the store by seq range.</span>"},
      ],resources:[
        {title:"MDN — WebSockets API",url:"https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API"},
        {title:"System Design Primer — back-of-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
      ]},
    ],
    gw:[
      {l:"medium",tag:"concept",q:"Why persistent WebSockets and not polling?",turns:[
        {who:"intv",text:"You put a WebSocket gateway between the client and everything else. Why a persistent connection — why not have the phone poll <code>GET /messages</code> every couple of seconds?"},
        {who:"cand",text:"A new message is a <em>server-initiated</em> event — the server has to push it, and polling can't push. At this scale polling is also brutal: 500M clients polling every 2s is ~250M req/s of mostly-empty responses, plus up to seconds of delivery latency. A <strong>WebSocket</strong> is a single upgraded TCP connection kept open for bidirectional push; the gateway holds it and delivers the instant a message arrives.<span class='eg'>500M conns polling / 2s ≈ 250M req/s of overhead vs a WS that sends bytes only when there's an actual message.</span>Long-polling is the fallback only where WS is blocked by a proxy."},
        {who:"intv",text:"WebSockets are stateful and you hold hundreds of millions of them. What does one idle connection actually cost?"},
        {who:"cand",text:"A file descriptor, socket send/receive buffers, and a little app-level per-connection state — call it a few KB to tens of KB each, plus a periodic keepalive frame. CPU is near zero while idle; the cost is <strong>memory and fd density</strong>. That's exactly why the gateway is its own tier, tuned for connection count rather than compute — you scale it by how many sockets a node can hold, independent of how much message logic runs elsewhere."},
      ],resources:[
        {title:"MDN — WebSockets API",url:"https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API"},
        {title:"WhatsApp architecture (HighScalability)",url:"http://highscalability.com/blog/2014/2/26/the-whatsapp-architecture-facebook-bought-for-19-billion.html"},
      ]},
      {l:"medium",tag:"concept",q:"How does a message find the right gateway node?",turns:[
        {who:"intv",text:"A message for user B arrives at the chat service. B's phone is connected to exactly one gateway node out of a thousand. How does the message find that node?"},
        {who:"cand",text:"A <strong>connection registry</strong> in Redis: on connect the gateway writes <code>userId → {nodeId, connId}</code>; on disconnect it deletes it (with a TTL as a safety net). The chat service looks up B, finds node 42, and forwards the message to node 42 over an internal channel (RPC or pub-sub), and that node pushes it down B's socket.<span class='eg'>registry: userB → {node:42, conn:ab12}; chat forwards to node 42 → socket push → device ack.</span>The registry decouples 'who is B' from 'which box holds B right now'."},
        {who:"intv",text:"The registry says B is on node 42, but node 42 crashed 3 seconds ago and B hasn't reconnected yet. What happens to the message?"},
        {who:"cand",text:"The forward to node 42 fails or times out — a <strong>stale registry entry</strong>. I treat B as effectively offline: the message is already durable in the store, so I mark it undelivered against B's cursor and fall through to the offline / push path. The TTL plus heartbeat refresh means the stale entry self-heals, and crucially the <em>delivered</em> receipt only fires on a real ack from B's device, never on a successful forward — so a stale route can never produce a false 'delivered'."},
      ],resources:[
        {title:"Redis documentation",url:"https://redis.io/docs/"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"medium",tag:"concept",q:"How does A learn B is online? (adds presence)",reveal:["presence"],turns:[
        {who:"intv",text:"The UI shows whether B is 'online'. A gateway knows its own connections. But A is on a different gateway than B — how does A find out B is online right now?"},
        {who:"cand",text:"No single gateway has the global view — each only knows its own sockets. I need a shared <strong>presence</strong> service that aggregates connection state across all gateways — let me add it. Every gateway reports its connects/disconnects, and presence keeps a <code>userId → online</code> map (Redis with TTL) that any gateway or the chat service can query or subscribe to.<span class='eg'>A opens the chat with B → A's gateway asks presence for userB → 'online, last-seen now'.</span>"},
        {who:"intv",text:"Does every gateway push every connect and disconnect into presence? At your connection churn that's a firehose."},
        {who:"cand",text:"It would be — which is why presence isn't event-per-flap. It uses <strong>TTL heartbeats with debounce</strong>: online means a key is being refreshed, offline means it quietly expires, and a brief socket drop doesn't immediately broadcast 'offline'. I'll work the volume and failure behaviour in the presence box itself; the point here is that online status is a cross-cutting <em>shared</em> service, not something a single gateway can answer."},
      ],resources:[
        {title:"Redis documentation",url:"https://redis.io/docs/"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"hard",tag:"scaling",q:"Grow the gateway tier to 500M connections.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> you're scaling toward <b>500M concurrent connections</b>. How many gateway nodes is that, and how do you route a brand-new connection to a node — and later find it again?</span>"},
        {who:"cand",text:"With a tuned node holding on the order of <strong>500K to 1M sockets</strong> (WhatsApp famously pushed millions per box), that's roughly <strong>500-1000 gateway nodes</strong>. New connections land via an L4 load balancer across healthy nodes — I don't need consistent hashing for placement because placement is <em>recorded</em>, not computed: the node writes <code>userId → nodeId</code> into the connection registry, and that explicit lookup is how anyone finds the connection later. Scale is just adding nodes; the registry absorbs the mapping."},
        {who:"intv",text:"You add and drain nodes for deploys. Doesn't every reshuffle break routing?"},
        {who:"cand",text:"Because routing is an explicit registry lookup, moving a connection just rewrites its registry entry on reconnect — there's no hash ring to rebalance. To drain a node I stop accepting new sockets and let clients reconnect elsewhere (backoff + jitter, resume token), and their registry entries update to the new node. So a rolling deploy is a controlled wave of cheap reconnects, not a routing rebuild."},
      ],resources:[
        {title:"WhatsApp architecture (HighScalability)",url:"http://highscalability.com/blog/2014/2/26/the-whatsapp-architecture-facebook-bought-for-19-billion.html"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"hard",tag:"failover",q:"A node holding 500K live sockets crashes.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a gateway node holding <b>500K</b> live sockets crashes hard — power loss, no graceful shutdown. Half a million users are instantly disconnected. Walk me through the next 30 seconds and prove nothing is lost.</span>"},
        {who:"cand",text:"All 500K clients detect the dead socket and reconnect with <strong>backoff + jitter</strong>; the LB spreads them across the surviving nodes and each rewrites its registry entry to the new node. <strong>No message is lost</strong>, because any in-flight message is already durable in the store — the sender either got an ack (it's persisted) or didn't (it stays in the sender's outbox and resends). Presence sees those keys' TTLs lapse and marks the users offline until they reconnect. Receipts that were pending simply re-resolve once the device re-acks."},
        {who:"intv",text:"500K reconnecting at once is itself a mini storm, and every one writes to the registry. Does that tip over the next node or the registry?"},
        {who:"cand",text:"The jittered backoff spreads the 500K over tens of seconds, so no single surviving node gets a synchronized spike, and I can rate-limit connection accepts per node as a guardrail. The registry is a sharded Redis cluster — 500K writes spread over that window is well within it. And messages that arrived during the gap aren't pushed blindly; the client <strong>pulls them by last-delivered cursor</strong> right after it reconnects. So the crash degrades to a brief reconnect wave, not data loss."},
      ],resources:[
        {title:"WhatsApp architecture (HighScalability)",url:"http://highscalability.com/blog/2014/2/26/the-whatsapp-architecture-facebook-bought-for-19-billion.html"},
        {title:"Redis documentation",url:"https://redis.io/docs/"},
      ]},
      {l:"hard",tag:"capacity",q:"How many gateway nodes for 500M connections?",turns:[
        {who:"intv",text:"Size the gateway tier. You have to hold ~500M concurrent WebSocket connections. Given a per-node connection budget, how many nodes is that, and what's the binding resource?"},
        {who:"cand",text:"Connections, not CPU, bind a gateway node — an idle socket costs a file descriptor, send/receive buffers, and a little per-connection state, call it ~10 KB, with near-zero CPU. A conservatively tuned node holds ~500K sockets (WhatsApp famously pushed millions per box). So 500M ÷ 500K ≈ 1000 nodes, or ~500 at 1M/node. The binding resources are memory and fd density, so I tune the kernel (fd limits, buffer sizes) and size by socket count, not by message logic that lives elsewhere.<span class='eg'>500M ÷ 500K conns/node ≈ 1000 nodes; 500K × ~10 KB ≈ 5 GB RAM/node just for socket state.</span>"},
        {who:"intv",text:"Why not push each node to 2-3M connections to cut the node count and the bill?"},
        {who:"cand",text:"You can, but density trades against blast radius and tail behaviour. A denser node is cheaper but a crash drops far more users at once — a 2M-socket node failing is a 2M reconnect storm versus 500K — and huge per-process socket counts strain GC, epoll, and kernel buffers, hurting p99. Decision: target ~500K-1M sockets/node to balance cost against blast radius, and scale horizontally by adding nodes, since routing is an explicit registry lookup rather than a hash ring."},
      ],resources:[
        {title:"WhatsApp architecture (HighScalability)",url:"http://highscalability.com/blog/2014/2/26/the-whatsapp-architecture-facebook-bought-for-19-billion.html"},
        {title:"System Design Primer — back-of-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
      ]},
      {l:"medium",tag:"concept",q:"Which store for the connection registry, and why?",turns:[
        {who:"intv",text:"The connection registry maps userId to gateway node — read on the hot delivery path, written on every connect and disconnect. Which store backs it, and why?"},
        {who:"cand",text:"Three candidates. <strong>Redis</strong>: in-memory, sub-millisecond reads, native TTL, and it shrugs off connection churn — a natural fit. <strong>etcd / ZooKeeper</strong>: strongly consistent, but they are low-write-throughput coordination stores and would fall over under millions of connect/disconnect writes a second. <strong>The message DB (Cassandra/Dynamo)</strong>: durable, but higher latency on the delivery path and overkill for throwaway routing state. The registry is high-churn and read-hot, which pulls hard toward an in-memory store.<span class='eg'>connect → SET userId to {node,conn} with a TTL; deliver → GET userId → forward to that node.</span>"},
        {who:"intv",text:"Redis isn't strongly consistent and can lose a little on failover. Isn't a stale registry entry dangerous?"},
        {who:"cand",text:"It's tolerable by construction — a stale entry just makes a forward fail or time out, and I already treat that as offline: the message is durable, so it falls through to the cursor-pull plus push path, and <em>delivered</em> only fires on a real device ack. So I don't need strong consistency; I need speed, TTL-based self-healing, and churn tolerance. Decision: sharded Redis keyed by userId with a TTL and heartbeat refresh, accepting soft state because the registry is a routing hint, not a source of truth."},
      ],resources:[
        {title:"Redis documentation",url:"https://redis.io/docs/"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
    ],
    chat:[
      {l:"medium",tag:"concept",q:"Route a 1:1 message end to end.",turns:[
        {who:"intv",text:"Message from A to B, both online. Trace it through the chat service — every step it performs."},
        {who:"cand",text:"<ul><li><strong>Receive</strong> from A's gateway; validate.</li><li><strong>Dedupe</strong> on client-msg-id; if it's a retry, return the existing seq.</li><li><strong>Assign a per-conversation monotonic seq.</strong></li><li><strong>Persist</strong> the message durably to the store.</li><li><strong>Ack A</strong> (sent tick).</li><li><strong>Look up B</strong> in the registry, forward to B's gateway, which pushes it.</li><li><strong>On B's device ack</strong> → delivered receipt to A; on B reading → read receipt.</li></ul>The service is <strong>stateless</strong> — every bit of durable state is in the store and registry, so any instance handles any message.<span class='eg'>A→B seq 4471: persist → ack A → push to B on node 42 → B acks → A sees double tick.</span>"},
        {who:"intv",text:"You persist <em>before</em> delivering. Why not deliver first for lower latency, then persist?"},
        {who:"cand",text:"Because durability is the promise the moment I ack A. Deliver-then-persist means a crash after the push but before the write loses the message from history and from B's <em>other</em> devices, even though B saw it once — an un-reproducible loss. Persist-then-deliver's worst case is a message that's both delivered and safely stored, at most redelivered and deduped on the client. The store is the source of truth; delivery is a fast path layered on top of it."},
      ],resources:[
        {title:"How Discord stores billions of messages",url:"https://discord.com/blog/how-discord-stores-billions-of-messages"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"medium",tag:"concept",q:"Where does encryption live?",turns:[
        {who:"intv",text:"Can your chat service read messages? Where does encryption sit in this design?"},
        {who:"cand",text:"With end-to-end encryption (Signal protocol) the <strong>clients hold the keys</strong> and the server only ever sees <em>ciphertext plus routing metadata</em> — sender, conversation, seq, timestamps. The chat service routes an opaque blob; it can't decrypt content. Key exchange runs through a key-distribution service that hands out prekeys, and group messaging uses sender keys so one encryption fans out to members.<span class='eg'>store row = {seq, senderId, conversationId, ciphertext-blob} — no plaintext anywhere server-side.</span>"},
        {who:"intv",text:"If the server only sees ciphertext, how do you do server-side search or spam detection?"},
        {who:"cand",text:"On content, you largely can't — that's the deliberate trade for privacy. <strong>Search is client-side</strong> over the locally-decrypted history. Abuse handling leans on <em>metadata</em> (send rates, fan-out patterns, brand-new accounts blasting strangers) and on user reports, which can attach decrypted samples with consent — never on server-read content. It genuinely constrains features, but confidentiality is a hard requirement here, so I design around metadata signals rather than weakening E2EE."},
      ],resources:[
        {title:"Signal Protocol documentation",url:"https://signal.org/docs/"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"hard",tag:"scaling",q:"One message to a 2,000-member group. (adds queue)",reveal:["queue"],turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> A sends one message to a group of <b>2,000</b> members. Done naively the chat service now does 2,000 registry lookups and 2,000 pushes synchronously on A's send path — A's send blocks for seconds. Fix the fan-out.</span>"},
        {who:"cand",text:"Fan-out has to come off the send path entirely. I <strong>persist the message once</strong> (one row, one seq in the conversation), ack A immediately, then drop a single fan-out task onto a <strong>message queue</strong> — let me add it. Workers consume that task and do the 2,000 per-recipient deliveries asynchronously and in parallel: online members get a gateway push, offline members get marked for pull + a push. A's latency is one persist + one enqueue, independent of group size.<span class='eg'>A's send: persist + enqueue ≈ a few ms; the 2,000 deliveries drain behind the queue.</span>"},
        {who:"intv",text:"Now a group of 100K members that chats constantly — even async, that's 100K deliveries per message, thousands of times an hour. Still push to everyone?"},
        {who:"cand",text:"No — above a threshold I flip huge groups to <strong>fan-out-on-read (pull)</strong>: write the message once to the conversation, and members pull it via their last-delivered cursor when they're active, with a lightweight coalesced push as the nudge. Small and active groups stay fan-out-on-write for instant delivery. So it's a hybrid keyed on group size and activity — write-fanout where it's cheap, read-fanout where write-fanout would explode. I'll detail the queue's ordering and durability in its own box."},
      ],resources:[
        {title:"Apache Kafka documentation",url:"https://kafka.apache.org/documentation/"},
        {title:"System Design Primer — asynchronism",url:"https://github.com/donnemartin/system-design-primer#asynchronism"},
      ]},
      {l:"hard",tag:"durability",q:"Out-of-order arrivals and a retried duplicate.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> on a flaky link A's client retries a send, and meanwhile two of A's messages reach the service out of order — A2 arrives before A1. Left alone, recipients could see a duplicate and scrambled order. How do you guarantee correct, dupe-free ordering?</span>"},
        {who:"cand",text:"Two mechanisms working together. <strong>Ordering:</strong> the server assigns a <strong>per-conversation monotonic seq</strong> on accept, and every client renders strictly by seq — so A2 physically arriving first still displays after A1 once both have seqs. <strong>Idempotency:</strong> the <strong>client-msg-id</strong> is the dedupe key — before assigning a seq I check whether that id already exists; a retry maps to the same seq and never becomes a second message.<span class='eg'>retry of client-msg-id b3f1 → lookup hits → return existing seq 4471, no new row.</span>"},
        {who:"intv",text:"That per-conversation monotonic seq — where does the counter live without becoming a per-conversation bottleneck or SPOF?"},
        {who:"cand",text:"Because it's scoped <em>per conversation</em>, contention only ever exists among writers to one conversation, which is naturally small. I allocate it where the conversation is anchored: an atomic conditional increment on that conversation's store partition, or a single owning chat partition per conversation (<strong>partition-by-conversation-id</strong>). Different conversations advance fully in parallel — there's no global counter. That same partition-by-conversation choice is what lets the queue preserve order too, so ordering is consistent end to end."},
      ],resources:[
        {title:"Idempotence (Wikipedia)",url:"https://en.wikipedia.org/wiki/Idempotence"},
        {title:"How Discord stores billions of messages",url:"https://discord.com/blog/how-discord-stores-billions-of-messages"},
      ]},
      {l:"hard",tag:"failover",q:"The recipient is offline. (adds notification svc)",reveal:["push"],turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> A sends to B, but B's phone is offline — app killed, no network. The socket push fails. If you do nothing, B may not see the message for hours and gets no alert. What's the delivery story?</span>"},
        {who:"cand",text:"Delivery has to survive B being gone, and it already partly does: I persisted before delivering, so the message sits durably in the store marked undelivered against B's cursor. When B reconnects, B pulls everything after last-delivered — no loss. But to <em>alert</em> B now, I route to a <strong>notification service</strong> that sends a push via APNs/FCM — let me add it. The push wakes the device, which then pulls the real message.<span class='eg'>B offline → forward fails → mark undelivered + enqueue push → APNs wakes B → B pulls by cursor.</span>"},
        {who:"intv",text:"So every undelivered message fires a push? And if B comes online a second later, do they get both a push and the in-app message?"},
        {who:"cand",text:"I <strong>debounce and coalesce</strong> — one push per conversation burst, not per message — and treat push as a best-effort <em>alert</em>, never the delivery channel; the store + cursor is the real delivery. For the race, the push carries the message id, so when B reconnects and pulls in-app, the client <strong>dedupes and can cancel or collapse</strong> the notification. Worst case B sees a redundant buzz, never a lost or doubled message. I'll cover push retries and provider outages in the notification box."},
      ],resources:[
        {title:"WhatsApp architecture (HighScalability)",url:"http://highscalability.com/blog/2014/2/26/the-whatsapp-architecture-facebook-bought-for-19-billion.html"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"hard",tag:"capacity",q:"How many chat-service instances at peak msg/s?",turns:[
        {who:"intv",text:"Size the chat service. At ~1M msg/s average and ~5M/s at peak, how many stateless instances do you provision, and what work does each instance do per message?"},
        {who:"cand",text:"Per message the service validates, dedupes on client-msg-id, assigns a seq, kicks off a persist, and enqueues fan-out — mostly I/O wait, so one instance comfortably handles ~10K msg/s. At peak that's 5M ÷ 10K ≈ 500 instances, and ~120 at the 1.16M/s average. Because the service is <strong>stateless</strong> — all durable state is in the store, registry, and queue — this scales linearly by adding instances behind a load balancer.<span class='eg'>5M msg/s ÷ 10K per instance ≈ 500 at peak; 1.16M/s ÷ 10K ≈ 120 at average.</span>"},
        {who:"intv",text:"Group fan-out means one send becomes thousands of deliveries. Doesn't that blow up this instance count?"},
        {who:"cand",text:"No — the accept path is decoupled from delivery. An instance does one persist plus one enqueue regardless of group size; the thousands of deliveries drain on queue <em>workers</em>, which I size separately against delivery-event throughput. Trade-off: I could size to peak and eat idle boxes at 3am, or autoscale. Decision: autoscale on msg/s but keep a warm floor, because connection-bound spikes like reconnect storms arrive faster than cold instances boot — stateless makes the warm floor cheap insurance."},
      ],resources:[
        {title:"How Discord stores billions of messages",url:"https://discord.com/blog/how-discord-stores-billions-of-messages"},
        {title:"System Design Primer — back-of-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
      ]},
    ],
    store:[
      {l:"medium",tag:"concept",q:"Datastore and schema for billions of messages.",turns:[
        {who:"intv",text:"Design the message store schema and pick the datastore, so that opening any chat is instant even with billions of messages."},
        {who:"cand",text:"A <strong>wide-column NoSQL</strong> store — Cassandra or ScyllaDB, the way Discord runs it. <strong>Partition key = conversationId, clustering key = seq</strong> ascending. All of a conversation's messages are co-located and sorted on disk, so opening a chat is a single-partition range scan of the latest N by seq — one seek, ordered, no join.<span class='eg'>row: (conversationId) / (seq) → {senderId, client-msg-id, ciphertext, ts}; open chat = last 50 by seq desc.</span>The value is the ciphertext blob plus metadata."},
        {who:"intv",text:"Why partition by conversation rather than by user, or by message-id?"},
        {who:"cand",text:"Because the dominant read is always 'give me this conversation's recent / paged messages' — partitioning by conversation makes that one partition, one ordered seek. Partition-by-user scatters a single conversation across all its members; partition-by-message-id turns every history read into a scatter-gather across the cluster. You match the partition key to the access pattern, and here that's the conversation."},
      ],resources:[
        {title:"How Discord stores billions of messages",url:"https://discord.com/blog/how-discord-stores-billions-of-messages"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"medium",tag:"concept",q:"Offline sync across a user's 3 devices.",turns:[
        {who:"intv",text:"B was offline for a day, on three devices. B reconnects. How does each device get exactly what it missed, in order, with no duplicates?"},
        {who:"cand",text:"A per-device <strong>last-delivered cursor</strong> — the highest seq that device has acked, per conversation. On reconnect, for each conversation the device fetches messages with <code>seq &gt; cursor</code> in seq order, then advances its cursor. Since seq is monotonic per conversation, this is exact and dupe-free, and the three devices keep independent cursors so each catches up on its own.<span class='eg'>phone cursor at seq 4470, laptop at 4460 → phone pulls 4471+, laptop pulls 4461+.</span>"},
        {who:"intv",text:"A heavy user has millions of conversations. Scanning every one on reconnect is expensive."},
        {who:"cand",text:"So I don't. I keep a per-user <strong>index of conversations with activity since the cursor</strong> — a 'dirty conversations' list updated on each write to that user's inbox. On reconnect the device syncs only conversations in that set, not the whole address book. That turns catch-up cost into 'proportional to what changed while you were away', which for most users is a handful of conversations even after a full day offline."},
      ],resources:[
        {title:"How Discord stores billions of messages",url:"https://discord.com/blog/how-discord-stores-billions-of-messages"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"hard",tag:"scaling",q:"20 TB/day forever, plus giant hot conversations.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> you're ingesting <b>100B messages/day (~20 TB/day)</b>, growing forever, and a few broadcast-style conversations are enormous and extremely hot. How does the store hold up on both storage and write hotspots?</span>"},
        {who:"cand",text:"Shard by <strong>hash of conversationId</strong> across many nodes so writes and storage spread uniformly, and add capacity by adding nodes. For the giant conversations I <strong>time-bucket the partition key</strong> (conversationId + time bucket) so no single partition grows into an unbounded wide row and the write load of a hot conversation spreads across buckets. On storage, tiered retention: recent hot data in the cluster, old cold history aged out to cheap object storage.<span class='eg'>20 TB/day × 365 ≈ 7+ PB/year → sharded cluster + cold tier, never one ring of hot nodes.</span>"},
        {who:"intv",text:"One broadcast conversation takes 50K msg/s — that's a single-partition hotspot even after hashing."},
        {who:"cand",text:"Right, hashing balances <em>across</em> conversations, not <em>within</em> one. So I sub-partition that conversation (conversationId + bucket) to spread its writes across nodes, and broadcast-style conversations are fan-out-on-read anyway, so writers are few and readers pull. It's the same hot-partition remedy any wide-column store needs — detect the heavy partition and split its key — and the seq still gives correct in-conversation order across buckets."},
      ],resources:[
        {title:"How Discord stores billions of messages",url:"https://discord.com/blog/how-discord-stores-billions-of-messages"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"hard",tag:"durability",q:"A shard node dies with un-flushed writes.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> the node holding a shard suffers a disk failure right after acking a batch of writes that were still in its in-memory memtable, not yet flushed to disk. Are recently-acked messages gone?</span>"},
        {who:"cand",text:"They must not be — once acked, never lost. <strong>Replication:</strong> every partition has N=3 replicas across AZs, and a write is acked only after a <strong>quorum (W=2)</strong> has it plus a commit-log / WAL append. So a single node's loss loses nothing: the other replicas hold the data, and even the un-flushed memtable is recoverable from the WAL. A replacement replica rebuilds from peers.<span class='eg'>write acks at 2-of-3; node dies → surviving 2 serve reads → new replica streams from them.</span>"},
        {who:"intv",text:"A quorum write on the hot send path — doesn't that blow your sub-second latency budget?"},
        {who:"cand",text:"A 2-of-3 quorum within a region is single-digit milliseconds, comfortably inside the budget, and durability on an acked message is non-negotiable. Reads I tune per guarantee: recent messages I read at <strong>quorum</strong> so I never miss the newest seq from a lagging replica, while older, immutable history can be read from a single replica for cheapness. So one replication mechanism buys me both durability and read-scaling."},
      ],resources:[
        {title:"System Design Primer — replication",url:"https://github.com/donnemartin/system-design-primer#replication"},
        {title:"How Discord stores billions of messages",url:"https://discord.com/blog/how-discord-stores-billions-of-messages"},
      ]},
      {l:"hard",tag:"failover",q:"Promote a shard replica without split-brain.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> the write-primary for a shard crashes, you promote a replica, and two minutes later the old primary rejoins still believing it's primary. Now two nodes could assign seq and accept writes. What breaks and how do you prevent it?</span>"},
        {who:"cand",text:"That's <strong>split-brain</strong>, and for ordered writes it forks the conversation — two nodes minting seqs → divergent, conflicting history, which is corruption. Prevention: promotion goes through <strong>consensus / leader election</strong> (Raft, or a fencing coordinator) that issues a monotonically increasing <strong>epoch</strong>. The new leader writes under a higher epoch; when the old primary rejoins with a stale epoch, replicas <strong>reject its writes via the fencing token</strong>, and it demotes to replica and re-syncs. seq allocation is bound to the current epoch, so ordering can never fork."},
        {who:"intv",text:"During the election window, seq for that conversation can't advance — writes to it pause. Acceptable?"},
        {who:"cand",text:"Yes, briefly. I choose <strong>consistency over availability for writes</strong> during the partition to preserve ordering and no-loss — a few seconds of retries on that one shard beats a forked conversation. Reads keep serving from replicas throughout, so history reads and delivery are unaffected, and other shards are entirely independent. Clients buffer in their outbox and resend, so the user sees a slight send delay, not a loss. Managed stores (DynamoDB, Spanner) do this fencing internally, which is a strong reason not to hand-roll failover."},
      ],resources:[
        {title:"System Design Primer — availability patterns",url:"https://github.com/donnemartin/system-design-primer#availability-patterns"},
        {title:"How Discord stores billions of messages",url:"https://discord.com/blog/how-discord-stores-billions-of-messages"},
      ]},
      {l:"hard",tag:"capacity",q:"Shards and storage for the message history.",turns:[
        {who:"intv",text:"Size the message store. ~100B messages/day at ~200 bytes of ciphertext. How much storage per year, how many write ops, and roughly how many shards?"},
        {who:"cand",text:"Storage: ~20 TB/day of history logical, × 365 ≈ ~7 PB/year, and with 3× replication ≈ ~21 PB/year. Writes: 5M msg/s at peak × 3 replicas = 15M replica-writes/s; if a node sustains ~75K writes/s that is ~200 shard-nodes just for the hot write tier. It has to be a sharded wide-column cluster — never one box — sharded by hash of conversationId so writes and bytes spread uniformly.<span class='eg'>20 TB/day × 365 ≈ 7 PB/yr logical → × 3 ≈ 21 PB; 5M/s × 3 ÷ ~75K/node ≈ 200 write shards.</span>"},
        {who:"intv",text:"That grows forever. Do you keep all 21 PB a year in the hot cluster?"},
        {who:"cand",text:"No — almost all reads are recent, so hot storage should be bounded. Trade-off: everything-hot gives uniform low-latency history at a runaway cost, while tiering adds a slow path for old data. Decision: tiered retention — keep recent history (weeks to a few months) in the wide-column cluster, and age cold history out to cheap object storage, fetched on demand for rare deep scroll-back. That keeps the hot cluster sized to the working set, not to all-time volume."},
      ],resources:[
        {title:"How Discord stores billions of messages",url:"https://discord.com/blog/how-discord-stores-billions-of-messages"},
        {title:"System Design Primer — back-of-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
      ]},
      {l:"medium",tag:"concept",q:"Which wide-column store for messages, and why?",turns:[
        {who:"intv",text:"You picked wide-column. Which actual store — Cassandra, HBase, or a managed option like DynamoDB — and what decides it?"},
        {who:"cand",text:"<strong>Cassandra / ScyllaDB</strong>: masterless, tunable quorum, excellent write throughput, and clustering by seq within a conversationId partition matches the access pattern exactly — Discord moved to Scylla for tail latency. <strong>HBase</strong>: strongly consistent, but HDFS plus region-server ops are heavy and region hotspots bite on skewed conversations. <strong>DynamoDB / Spanner</strong>: managed, with fencing and failover built in, but per-partition throughput caps and cost climb at this volume. The axes are write throughput, operational burden, and how much consistency I actually need.<span class='eg'>partition = conversationId, clustering = seq asc → open chat is one ordered single-partition scan.</span>"},
        {who:"intv",text:"So which, and what's the deciding factor?"},
        {who:"cand",text:"For self-managed at this scale I'd take <strong>ScyllaDB/Cassandra</strong>: the workload is write-heavy with per-partition-ordered reads and needs no global consistency beyond one conversation, which is exactly masterless wide-column's sweet spot, and masterless means no single write-primary to fail. I'd reach for <strong>DynamoDB</strong> instead only if I wanted managed failover and could absorb the cost. Decision: masterless wide-column, because partition-by-conversation and seq-clustering fit the store's job and there's no cross-partition transaction to justify HBase or Spanner."},
      ],resources:[
        {title:"How Discord stores billions of messages",url:"https://discord.com/blog/how-discord-stores-billions-of-messages"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
    ],
    queue:[
      {l:"hard",tag:"scaling",q:"A 100K-member group storms the fan-out.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a 100K-member group, and at a peak moment 500 members post within a few seconds. Naive fan-out-on-write is 500 × 100K = <b>50M</b> deliveries in seconds — the workers and gateways drown. Contain it.</span>"},
        {who:"cand",text:"This is exactly why huge groups are <strong>fan-out-on-read</strong>: each message is written once to the conversation (a 100K× reduction in delivery work), active members pull via their cursor, and a single coalesced push nudges the rest. For the medium groups still on fan-out-on-write, the <strong>queue absorbs the burst</strong> — it buffers and applies backpressure while workers drain at a sustainable rate, so delivery degrades to slightly-delayed, never dropped.<span class='eg'>50M eager deliveries → 500 writes + lazy pulls; the queue smooths any residual spike.</span>"},
        {who:"intv",text:"Fan-out-on-read just moves the storm to reads — 100K clients all pulling that active group."},
        {who:"cand",text:"But reads are cheaper and cache-friendly: they all hit one conversation partition, which caches beautifully, and only <em>active</em> members pull — idle members get a push and pull lazily when they open the app. So the concurrent read set is a fraction of 100K, served largely from cache. The hybrid, tuned by group size and activity, keeps <em>both</em> write and read fan-out bounded; neither side is allowed to explode."},
      ],resources:[
        {title:"Apache Kafka documentation",url:"https://kafka.apache.org/documentation/"},
        {title:"System Design Primer — asynchronism",url:"https://github.com/donnemartin/system-design-primer#asynchronism"},
      ]},
      {l:"medium",tag:"concept",q:"Why a queue, and how does it keep order?",turns:[
        {who:"intv",text:"Why introduce a message queue at all instead of the chat service just calling delivery directly? And once it's there, how do you keep per-conversation order?"},
        {who:"cand",text:"The queue <strong>decouples accept from deliver</strong>: the send path acks fast and durably, while fan-out, delivery and push happen asynchronously, can retry, absorb bursts, and scale their workers independently of the send path. Kafka gives a durable, replayable, partitioned log. Ordering: <strong>partition by conversationId</strong> so all events for one conversation land on one partition and are consumed in order, while different conversations parallelize across partitions.<span class='eg'>conversationId hashes to partition 7 → every event for it is ordered on partition 7's consumer.</span>"},
        {who:"intv",text:"Partition by conversationId — a giant conversation overloads one partition."},
        {who:"cand",text:"Same hot-key story as the store: I sub-key big conversations (conversationId + bucket), accepting slightly weaker <em>cross-bucket</em> ordering — which is fine, because the real ordering guarantee comes from the <strong>server-assigned seq</strong>, not from queue arrival order. The partition just preserves seq cheaply for the common case; clients always sort by seq, so splitting a hot conversation across buckets never scrambles what the user sees."},
      ],resources:[
        {title:"Apache Kafka documentation",url:"https://kafka.apache.org/documentation/"},
        {title:"System Design Primer — asynchronism",url:"https://github.com/donnemartin/system-design-primer#asynchronism"},
      ]},
      {l:"hard",tag:"durability",q:"A broker holding pending deliveries dies.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a Kafka broker holding partitions for millions of pending fan-out tasks dies. Are those queued deliveries lost?</span>"},
        {who:"cand",text:"No — the partitions are <strong>replicated</strong> (replication.factor=3, acks=all with min.insync.replicas=2) across brokers. A broker loss triggers leader re-election to an in-sync replica with no data loss, and the producer — the chat service — only got its ack after the write was replicated. Consumers track committed <strong>offsets</strong>, so on failover a worker resumes from the last committed offset and keeps draining.<span class='eg'>broker with partition 7 dies → ISR replica becomes leader → workers resume at last committed offset.</span>"},
        {who:"intv",text:"A consumer crashes after it delivered a message but before it committed its offset. Redelivery?"},
        {who:"cand",text:"Yes — that's <strong>at-least-once</strong>, so a redelivery can happen, and I design for it rather than fight it. Delivery is <strong>idempotent on message id / client-msg-id</strong>: the receipt logic and the client both dedupe, so a redelivered message is a no-op — no duplicate shown, no doubled receipt. I deliberately choose at-least-once plus idempotent consumers over the cost and fragility of exactly-once semantics; the seq + client-msg-id machinery already makes dedupe free."},
      ],resources:[
        {title:"Apache Kafka documentation",url:"https://kafka.apache.org/documentation/"},
        {title:"Idempotence (Wikipedia)",url:"https://en.wikipedia.org/wiki/Idempotence"},
      ]},
      {l:"hard",tag:"capacity",q:"How many partitions for the fan-out log?",turns:[
        {who:"intv",text:"Size the queue. Accepted sends plus group fan-out flow through it. Given peak throughput, how many partitions do you need, and why that count?"},
        {who:"cand",text:"The accept rate is ~5M msg/s at peak, but fan-out multiplies it — deliveries and push tasks push effective throughput to maybe ~10-20M events/s. If one partition-consumer safely sustains ~50K events/s, that is 20M ÷ 50K ≈ 400 partitions as a floor. I'd over-provision to a couple thousand for parallelism headroom, future growth, and sub-keying hot conversations, and partition by conversationId so each conversation stays ordered on one partition.<span class='eg'>~20M events/s ÷ ~50K/s per partition ≈ 400 partitions floor → provision ~2000 for headroom + hot-key buckets.</span>"},
        {who:"intv",text:"Why not just crank it to 100K partitions for maximum parallelism?"},
        {who:"cand",text:"Because partitions are not free. Trade-off: more partitions buy parallelism but cost open files, longer rebalances, more leader elections, replication overhead, and they fragment ordering into more streams to reason about. Decision: size partition count to target-throughput ÷ per-partition budget with modest headroom — thousands, not 100K — keep the conversationId partitioning for order, and sub-key only the genuinely hot conversations rather than shattering everything."},
      ],resources:[
        {title:"Apache Kafka documentation",url:"https://kafka.apache.org/documentation/"},
        {title:"System Design Primer — back-of-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
      ]},
      {l:"medium",tag:"concept",q:"Which queue — Kafka, RabbitMQ, or SQS?",turns:[
        {who:"intv",text:"Which messaging system backs fan-out — Kafka, RabbitMQ, or a managed queue like SQS — and why?"},
        {who:"cand",text:"<strong>Kafka</strong>: a durable, replicated, partitioned log with per-partition ordering, consumer offsets, and retention for replay — it fits ordering-by-conversationId, at-least-once with idempotent consumers, and replay after a worker crash. <strong>RabbitMQ</strong>: rich routing and per-message acks, but it is a broker, not a retained log — ordered high-throughput streaming and replay are awkward, and deep backlogs strain it. <strong>SQS</strong>: fully managed and simple, but standard queues don't guarantee order and FIFO caps throughput, with no real replay. The deciding needs are ordering, replay, and millions of events/s.<span class='eg'>conversationId → partition 7 → consumed in seq order; worker crash → resume at last committed offset.</span>"},
        {who:"intv",text:"So which, and the deciding property?"},
        {who:"cand",text:"<strong>Kafka</strong> — because I need partition-level ordering keyed by conversationId, durable retention so a crashed consumer replays from its committed offset, and headroom for tens of millions of events/s, none of which RabbitMQ's per-message model or SQS's ordering and replay limits deliver. Decision: Kafka, partitioned by conversationId, acks=all with min.insync.replicas=2, and idempotent at-least-once consumers rather than fragile exactly-once."},
      ],resources:[
        {title:"Apache Kafka documentation",url:"https://kafka.apache.org/documentation/"},
        {title:"System Design Primer — asynchronism",url:"https://github.com/donnemartin/system-design-primer#asynchronism"},
      ]},
    ],
    presence:[
      {l:"medium",tag:"concept",q:"Track 500M online statuses without a firehose.",turns:[
        {who:"intv",text:"How does presence actually know that up to 500M people are online, without drowning in events?"},
        {who:"cand",text:"Each client sends a lightweight <strong>heartbeat</strong> roughly every 30s over its existing socket, and the gateway refreshes a Redis key <code>presence:userId</code> with a TTL of ~45-60s. <strong>Online = the key exists; offline = it silently expired</strong> — no explicit 'went offline' event needed. last-seen is the key's last write time. I <strong>debounce</strong> flaps by not broadcasting 'offline' the instant a socket drops — I wait for the TTL, so a 3-second blip doesn't flicker the dot.<span class='eg'>heartbeat every 30s refreshes TTL=45s; miss two → key expires → offline.</span>"},
        {who:"intv",text:"Even at 30s, 500M clients is ~17M heartbeat writes/s into Redis. That's a lot."},
        {who:"cand",text:"So heartbeats <strong>terminate at the gateway</strong>, which already holds the socket and knows liveness for free — it batches and writes presence in bulk (or keeps presence sharded per-gateway with periodic rollups), so Redis sees far fewer ops than raw heartbeats. The presence keyspace is sharded across a Redis cluster by userId, and a TTL refresh is a cheap write. Presence is <em>soft state</em> — approximate and slightly stale is completely acceptable, which is what lets me batch aggressively."},
      ],resources:[
        {title:"Redis documentation",url:"https://redis.io/docs/"},
        {title:"WhatsApp architecture (HighScalability)",url:"http://highscalability.com/blog/2014/2/26/the-whatsapp-architecture-facebook-bought-for-19-billion.html"},
      ]},
      {l:"hard",tag:"scaling",q:"A user with 5,000 contacts comes online.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a user with <b>5,000</b> contacts comes online. Done naively you notify all 5,000 watchers, and at millions of state changes per second that presence fan-out dwarfs your actual messaging traffic. Rein it in.</span>"},
        {who:"cand",text:"Don't push presence eagerly to everyone. <strong>Subscribe-on-view:</strong> A only receives B's presence when A actually has a chat or contact with B open or visible, so the live watcher set per user is tiny and relevant — a pull / targeted subscribe against the presence service, not a broadcast to 5,000. Rapid on/off flaps are coalesced and debounced.<span class='eg'>5,000 contacts but only ~3 chats open → 3 presence subscriptions, not 5,000 pushes.</span>"},
        {who:"intv",text:"A 1,000-member group where everyone has it open — presence and typing indicators for all of them?"},
        {who:"cand",text:"I scope ephemeral signals — typing, presence — to the <strong>active viewers of that conversation</strong>, sampled and debounced: typing throttled to about once every few seconds, presence updated on a coarse interval, and none of it persisted. These are best-effort soft signals, so under load they're the <em>first</em> thing I shed — I'll drop a typing indicator long before I ever delay a message. Correctness of messaging never depends on presence fidelity."},
      ],resources:[
        {title:"Redis documentation",url:"https://redis.io/docs/"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"hard",tag:"failover",q:"The Redis presence store goes down.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> the Redis cluster backing presence has a full outage. What do users experience, and does messaging survive?</span>"},
        {who:"cand",text:"Messaging survives completely, because presence is <strong>soft state</strong> and sits off the delivery path by design. On Redis loss the UI falls back to 'presence unknown' — hide the online dot, drop last-seen — while sending, receipts, delivery and offline pull all keep working, since none of them read presence. Recovery is automatic: heartbeats <strong>repopulate the whole keyspace within one TTL window</strong> (~1 minute) once Redis is back, no manual rebuild.<span class='eg'>Redis down → dots vanish, messages flow normally → Redis back → dots return in ~60s.</span>"},
        {who:"intv",text:"Could you avoid the outage in the first place?"},
        {who:"cand",text:"I'd run presence as a <strong>replicated Redis cluster</strong> (primary + replicas per shard) with automatic failover, so a single node loss isn't a tier outage, and shard the presence keyspace so any blast radius is a fraction of users. But the real design choice is that a presence failure is <em>cosmetic by construction</em> — I deliberately keep it off the message path so that even a total presence outage degrades to 'we can't show who's online', never 'messages stop'."},
      ],resources:[
        {title:"Redis documentation",url:"https://redis.io/docs/"},
        {title:"System Design Primer — availability patterns",url:"https://github.com/donnemartin/system-design-primer#availability-patterns"},
      ]},
      {l:"hard",tag:"capacity",q:"Heartbeat volume and Redis memory for presence.",turns:[
        {who:"intv",text:"Size presence. Up to 500M connections heartbeat to keep their status fresh. What's the write rate into the presence store, and how much memory does the keyspace need?"},
        {who:"cand",text:"A naive heartbeat every 30s is 500M ÷ 30 ≈ 17M writes/s — the number the framing flagged. I don't send that to Redis: heartbeats <strong>terminate at the gateway</strong>, which already knows socket liveness, and it rolls up and bulk-writes presence, so Redis sees far fewer ops — call it ~100K-1M/s. Memory is small: 500M keys × ~100 bytes (userId, node, timestamp, TTL overhead) ≈ ~50 GB, sharded across a Redis cluster of ~10-20 nodes.<span class='eg'>500M ÷ 30s ≈ 17M raw hb/s → gateway rollup → ~100K-1M Redis ops/s; 500M × ~100 B ≈ 50 GB sharded.</span>"},
        {who:"intv",text:"Could you shorten the heartbeat interval to make presence more accurate?"},
        {who:"cand",text:"I could, but it trades directly against load and battery. A 10s interval triples the write rate and drains phone radio and battery, while a 60s interval is cheaper but makes last-seen and the online dot staler. Decision: a ~30s heartbeat with a 45-60s TTL, because presence is <strong>soft state</strong> — slightly stale is completely acceptable — so I bias toward lower write load and better battery over pinpoint freshness."},
      ],resources:[
        {title:"Redis documentation",url:"https://redis.io/docs/"},
        {title:"System Design Primer — back-of-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
      ]},
      {l:"medium",tag:"concept",q:"Which store for presence, and why?",turns:[
        {who:"intv",text:"Presence is high-churn, ephemeral, TTL-driven state. Which store backs it — Redis, Memcached, or your message DB — and why?"},
        {who:"cand",text:"<strong>Redis</strong>: in-memory with native TTL expiry and pub/sub, sharded as a cluster — online-is-a-key-that-exists and subscribe-on-view map straight onto it. <strong>Memcached</strong>: also in-memory with TTL, but no pub/sub and LRU eviction can drop live keys unpredictably, which is the wrong semantics for liveness. <strong>The message DB (Cassandra)</strong>: durable, but heartbeat churn would hammer a store built for permanence and it is wasteful for state that rebuilds itself in one TTL window. The job wants fast, expiring, subscribable state.<span class='eg'>SET presence:userId with a 45s TTL on heartbeat; key exists = online; publish on change to viewers.</span>"},
        {who:"intv",text:"So which, and the deciding factor?"},
        {who:"cand",text:"<strong>Redis</strong> — TTL-as-liveness plus pub/sub for targeted presence subscriptions is exactly the model, Memcached's eviction semantics and missing pub/sub rule it out, and a durable DB is both overkill and a churn magnet for throwaway state. Decision: a sharded, replicated Redis cluster keyed by userId, accepting soft state precisely because the whole keyspace repopulates within one TTL window after any loss."},
      ],resources:[
        {title:"Redis documentation",url:"https://redis.io/docs/"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
    ],
    push:[
      {l:"medium",tag:"concept",q:"Deliver a notification to an offline iPhone.",turns:[
        {who:"intv",text:"Walk me through delivering a notification to an offline iPhone. What does the notification service actually own?"},
        {who:"cand",text:"It owns the integration with <strong>APNs (iOS) and FCM (Android)</strong> and the mapping <code>userId/device → push token</code>. When the chat service marks a message undelivered for an offline user, it enqueues a push task; the notification service builds the payload — for E2EE just a 'new message' plus conversation, never content, since content stays encrypted — and calls APNs/FCM, which wakes the device. The device then pulls the real message by cursor.<span class='eg'>B offline → enqueue push(tokenB) → APNs wakes app → app pulls seq &gt; cursor.</span>"},
        {who:"intv",text:"The payload can't contain the message. So what does the user actually see on the lock screen?"},
        {who:"cand",text:"For E2EE, a generic 'New message' (or the sender's name if the user allows it), and the app <strong>decrypts locally on open</strong> to show content. If I want a rich preview I send a <em>silent / data push</em> that wakes the app to fetch and render a <strong>local</strong> notification on-device — so plaintext is composed on the phone, never on my servers. Push is an <em>alert to come pull</em>, not the delivery channel; that framing is what keeps content off the notification path."},
      ],resources:[
        {title:"Signal Protocol documentation",url:"https://signal.org/docs/"},
        {title:"WhatsApp architecture (HighScalability)",url:"http://highscalability.com/blog/2014/2/26/the-whatsapp-architecture-facebook-bought-for-19-billion.html"},
      ]},
      {l:"hard",tag:"scaling",q:"A morning backlog fires 2M pushes/s.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> overnight hundreds of millions of users are offline; the morning backlog produces a burst of ~<b>2M pushes/s</b> to APNs/FCM. How do you keep from melting yourself and the providers?</span>"},
        {who:"cand",text:"<strong>Batch and coalesce:</strong> one push per conversation burst per device, not per message — a 50-message group thread collapses to one 'N new messages' push, cutting volume enormously. Push tasks go through a <strong>durable queue</strong> drained at the rate APNs/FCM accept (they rate-limit), using their batch APIs and multiplexed connections. Under pressure I prioritize — collapse or shed low-value pushes first.<span class='eg'>50 messages across a group → 1 summary push; 2M/s of raw events → far fewer actual sends.</span>"},
        {who:"intv",text:"APNs enforces its own rate limits and can throttle you. How do you not lose notifications when it does?"},
        {who:"cand",text:"The push tasks live in a <strong>durable retry queue with backoff</strong>, so throttling just slows the drain — tasks persist, nothing is dropped on the floor. Coalescing keeps volume low enough that I rarely hit the limits at all. And because push is a <em>best-effort alert</em> and the store + cursor is the real delivery, the worst case of a throttled or delayed push is simply that the user gets the message when they next open the app or reconnect — annoying, not lossy."},
      ],resources:[
        {title:"Apache Kafka documentation",url:"https://kafka.apache.org/documentation/"},
        {title:"WhatsApp architecture (HighScalability)",url:"http://highscalability.com/blog/2014/2/26/the-whatsapp-architecture-facebook-bought-for-19-billion.html"},
      ]},
      {l:"hard",tag:"failover",q:"APNs/FCM is down or slow for 20 minutes.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> APNs is down or crawling for <b>20 minutes</b>. What happens to notifications, and does it touch message delivery at all?</span>"},
        {who:"cand",text:"It must not touch delivery — message delivery runs off the store + cursor and never waits on a push. The push tasks sit in the <strong>durable retry queue with backoff</strong>, so when APNs recovers they flush. Anyone who opens the app during the outage pulls their messages normally, and their pending push is then cancelled. So a 20-minute provider outage costs some <em>timeliness of alerts</em>, and zero messages.<span class='eg'>APNs down → messages still delivered in-app on open → queued pushes flush on recovery, coalesced.</span>"},
        {who:"intv",text:"When it recovers, 20 minutes of backlog fires at once — now it's notification spam."},
        {who:"cand",text:"So I <strong>coalesce on flush</strong> — one summary push per conversation rather than replaying every buzz — and <strong>drop superseded / stale</strong> pushes: if the user already read a message on another device, cancel its notification, and any push older than its usefulness is discarded by a max-age check. Better a missed buzz than a spam storm, and since the message is already delivered in-app regardless, aggressively pruning the notification backlog is safe."},
      ],resources:[
        {title:"WhatsApp architecture (HighScalability)",url:"http://highscalability.com/blog/2014/2/26/the-whatsapp-architecture-facebook-bought-for-19-billion.html"},
        {title:"System Design Primer — availability patterns",url:"https://github.com/donnemartin/system-design-primer#availability-patterns"},
      ]},
      {l:"hard",tag:"capacity",q:"Size the morning push burst and worker fleet.",turns:[
        {who:"intv",text:"Size the notification tier. A morning backlog can spike to ~2M push events/s toward APNs and FCM. How many workers and connections, and what does coalescing buy you first?"},
        {who:"cand",text:"Coalescing is the first lever: one push per conversation-burst per device instead of per message can cut volume ~10:1, so ~2M raw events/s becomes ~200K actual sends/s. Each worker holds multiplexed HTTP/2 connections to APNs/FCM and pushes maybe ~5K/s, so ~200K ÷ 5K ≈ 40 workers as a floor, provisioned higher for retries, backoff, and the APNs/FCM split. The tasks sit in a durable queue so the fleet drains at the rate the providers accept.<span class='eg'>2M raw events/s → ~10:1 coalesce → ~200K sends/s ÷ ~5K/s per worker ≈ 40 workers + retry headroom.</span>"},
        {who:"intv",text:"Why not just add workers and blast the raw 2M/s straight through?"},
        {who:"cand",text:"Because the ceiling is the provider, not my fleet — APNs and FCM rate-limit and will throttle or ban a blaster, so more workers can't beat their limit and just waste effort and battery. Trade-off: raw blasting is simple but hits a wall and spams users; a metered drain is slightly slower but safe. Decision: aggressive coalescing plus a durable retry queue drained at the provider-accepted rate, because push is a best-effort <em>alert</em> and the store-plus-cursor is the real delivery — so smooth and prune, never blast."},
      ],resources:[
        {title:"WhatsApp architecture (HighScalability)",url:"http://highscalability.com/blog/2014/2/26/the-whatsapp-architecture-facebook-bought-for-19-billion.html"},
        {title:"System Design Primer — back-of-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
      ]},
    ],
  }
};
