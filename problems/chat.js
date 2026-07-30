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
  edges:[["client","gw","WS"],["gw","chat","send"],["chat","store","persist"],["chat","queue","enqueue"],["queue","push","deliver"],["gw","presence","heartbeat"],["chat","push","notify"]],
  core:["client","gw","chat","store"],
  basic:["client","gw","chat","store"],
  deepDive:{
    client:{
      role:"The phone app that <strong>owns identity and durability of its own outbound messages</strong>: it mints a <code>client-msg-id</code> (the idempotency key), renders optimistically, and persists to a local outbox before a byte hits the network. Its most consequential lever is that durability starts <em>on the device</em> — an unacked message lives in on-disk SQLite, not memory, so a phone dying mid-send never loses it.",
      capacity:[
        ["Per-user volume","~50 sent/day","2B users vs 100B msgs/day"],
        ["Heavy-user history","~110K msgs/yr ≈ 100MB","~300/day × ~1KB stored"],
        ["Outbox size","normally 0","only unacked sends, a handful in a tunnel"],
        ["Reconnect delta","single digits per active chat","messages with seq > cursor"],
      ],
      data:"The phone is a <strong>cache, not the source of truth</strong>. It holds a durable outbox of unacked sends (each with its <code>client-msg-id</code>), a rolling recent window of decrypted history, and per-conversation <strong>last-delivered cursors</strong>. E2EE keys live here too — only the client can decrypt content.",
      scaling:[
        "Reconnect <strong>politely</strong>: exponential backoff with jitter so 20M devices don't retry on the same tick, plus a resume token for a delta sync not a full reload.",
        "Sync by <strong>last-delivered cursor</strong> per conversation — pull only <code>seq &gt; cursor</code>, so reconnect bandwidth is proportional to what changed.",
        "Cap local cache to a rolling recent window and page older scroll-back from the store on demand, keeping low-end devices lean.",
      ],
      failures:[
        {t:"Phone dies mid-send, reboots 20 min later",b:"In-flight messages would vanish if they lived only in memory.",m:"Write to the on-device outbox before attempting send; on reconnect flush in order, each carrying its original <code>client-msg-id</code> so the server dedupes."},
        {t:"Server ack never arrives",b:"The client can't tell if the message landed — a blind resend risks a duplicate.",m:"Keep the entry 'pending' and retry with the same id; the server maps a retry to the existing seq, so a resend is a no-op if the original landed."},
      ],
      tradeoffs:[
        {a:"Keep everything local forever",b:"Rolling recent window + server paging",pick:"Unbounded local history gives instant scroll-back but breaks multi-device sync, reinstall recovery, and low-end storage; a capped window keeps the phone lean while the store stays authoritative."},
      ],
      probes:[
        "You render optimistically before the server acks — what if that ack never comes?",
        "A user sends 5 messages in a tunnel, then others message the same chat before those 5 flush — how is ordering not scrambled?",
        "20M clients drop and reconnect in seconds — what in the client design keeps that from becoming an outage?",
      ],
    },
    gw:{
      role:"The WebSocket gateway tier that <strong>holds hundreds of millions of persistent connections</strong> and pushes messages the instant they arrive. Its single most consequential property is being connection-bound, not compute-bound — you scale it by how many sockets a node can hold, and routing to a specific user is an explicit <strong>connection-registry lookup</strong> (<code>userId → nodeId</code>), never a hash computation.",
      capacity:[
        ["Concurrent connections","~500M","held across the tier"],
        ["Sockets per node","~500K-1M","WhatsApp pushed millions/box"],
        ["Nodes","~500-1000","500M ÷ 500K-1M"],
        ["Per-socket cost","~10KB, ~0 CPU idle","fd + buffers + a little state"],
      ],
      data:"Holds volatile per-connection state (socket, buffers, a little session data) but no durable truth. The <strong>connection registry</strong> (<code>userId → {nodeId, connId}</code>) lives in sharded Redis with a TTL — soft state, a routing hint, self-healing on reconnect, never a source of truth.",
      scaling:[
        "Scale by adding nodes behind an L4 LB; placement is <strong>recorded, not computed</strong>, so there's no hash ring to rebalance on add/drain.",
        "Tune the kernel (fd limits, socket buffer sizes) and size by socket count, since memory and fd density bind before CPU.",
        "Drain a node by refusing new sockets and letting clients reconnect elsewhere (backoff + jitter, resume token), updating their registry entries.",
      ],
      failures:[
        {t:"A node holding 500K live sockets crashes hard",b:"Half a million users instantly disconnected; a synchronized reconnect could stampede a surviving node.",m:"Jittered backoff spreads reconnects over tens of seconds; the LB scatters them; per-node accept rate-limits guard the rest. No message lost — in-flight ones are durable in the store or the sender's outbox."},
        {t:"Registry says B is on node 42, but node 42 just crashed",b:"A stale route — the forward to node 42 fails or times out.",m:"Treat B as offline, fall through to the durable store + cursor-pull + push path; the TTL + heartbeat self-heals the entry, and 'delivered' only fires on a real device ack."},
      ],
      tradeoffs:[
        {a:"~500K-1M sockets/node",b:"2-3M sockets/node",pick:"Denser nodes cut count and cost but a crash drops far more users (a 2M reconnect storm vs 500K) and huge socket counts strain GC/epoll and hurt p99 — balance cost against blast radius."},
        {a:"Redis connection registry",b:"etcd/ZooKeeper or the message DB",pick:"The registry is high-churn and read-hot; Redis gives sub-ms reads, native TTL, and churn tolerance, while coordination stores can't take millions of connect/disconnect writes/s and the DB is too slow on the delivery path."},
      ],
      probes:[
        "A message for B arrives at the chat service — how does it find the one gateway node out of a thousand holding B's socket?",
        "Why persistent WebSockets over the phone polling <code>GET /messages</code> every couple seconds?",
        "You add and drain nodes for deploys — doesn't every reshuffle break routing?",
      ],
    },
    chat:{
      role:"The stateless routing-and-logic tier: validate, <strong>dedupe on client-msg-id</strong>, assign a per-conversation <strong>monotonic seq</strong>, persist, ack the sender, then forward to the recipient's gateway. Its most consequential lever is <strong>persist-then-deliver</strong> — durability is the promise the moment it acks, so history and other devices can never lose a message the sender saw acked.",
      capacity:[
        ["Peak throughput","~5M msg/s","~1.16M/s average"],
        ["Per-instance","~10K msg/s","mostly I/O wait"],
        ["Instances","~500 peak, ~120 avg","5M ÷ 10K; warm floor kept"],
        ["Accept-path work","1 persist + 1 enqueue","independent of group size"],
      ],
      data:"<strong>Stateless</strong> — every bit of durable state lives in the store, registry, and queue, so any instance handles any message. Ordering state is the per-conversation seq, allocated where the conversation is anchored (partition-by-conversation-id), so different conversations advance fully in parallel with no global counter.",
      scaling:[
        "Stateless → scale linearly by adding instances behind an LB; keep a warm floor because reconnect storms arrive faster than cold instances boot.",
        "Decouple accept from delivery: one persist + one enqueue regardless of group size, so group fan-out drains on queue workers sized separately.",
        "Above a group-size threshold, flip huge groups to <strong>fan-out-on-read</strong> (write once, members pull by cursor) so a 100K-member group doesn't become 100K deliveries per message.",
      ],
      failures:[
        {t:"Crash after push but before persist (deliver-first)",b:"A message B saw once is lost from history and from B's other devices — an un-reproducible loss.",m:"Persist-then-deliver: the store is the source of truth, delivery is a fast path on top; worst case is a delivered+stored message redelivered and deduped on the client."},
        {t:"Retried duplicate + out-of-order arrival (A2 before A1)",b:"Recipients could see a duplicate and scrambled order.",m:"Server-assigned monotonic seq decides display order (clients render by seq); client-msg-id dedupes so a retry maps to the same seq, never a second row."},
      ],
      tradeoffs:[
        {a:"Persist then deliver",b:"Deliver then persist",pick:"Persist-first guarantees no acked message is ever lost, at the cost of a few ms before the push; deliver-first shaves latency but risks losing a message from history after a mid-flight crash."},
        {a:"Fan-out-on-write for groups",b:"Fan-out-on-read for groups",pick:"Write-fanout gives instant delivery for small active groups; read-fanout (write once, pull by cursor) is the only thing that survives a 100K-member group — a hybrid keyed on size and activity."},
      ],
      probes:[
        "You persist before delivering — why not deliver first for lower latency, then persist?",
        "That per-conversation monotonic seq — where does the counter live without becoming a bottleneck or SPOF?",
        "Can your chat service read message content, and if not, how do you do spam detection?",
      ],
    },
    store:{
      role:"The durable message history: a <strong>masterless wide-column store</strong> (ScyllaDB/Cassandra) with <strong>partition key = conversation_id, clustering key = seq</strong>. Its most consequential lever is that key design — every conversation's messages are co-located and pre-sorted, so 'open a chat, load latest N' is a single-partition ordered scan, one seek, no scatter.",
      capacity:[
        ["Write rate","~5M msg/s peak → ~15M replica-writes/s","×3 replication"],
        ["Storage","~20TB/day → ~7PB/yr logical, ~21PB/yr replicated","~200 bytes/msg"],
        ["Hot write nodes","~300 (Scylla) vs ~500 (Cassandra)","15M/s ÷ per-node ceiling"],
        ["Dominant read","last N by seq + seq > cursor","single-conversation range"],
      ],
      data:"Rows are <code>(conversation_id) / (seq desc) → {senderId, client_msg_id, ciphertext, ts}</code> — server sees ciphertext + metadata only. Consistency is <strong>tunable quorum</strong> (RF=3, W=2): acked after a quorum + WAL append, needing no consistency beyond a single partition. Dedupe is partition-scoped on <code>client_msg_id</code>; <em>no</em> global secondary index on the hot path.",
      scaling:[
        "Shard by <strong>hash of conversation_id</strong> so writes and bytes spread uniformly; add capacity by adding nodes.",
        "<strong>Time-bucket the partition key</strong> (conversation_id + bucket) for giant broadcast conversations so no single partition grows unbounded or hotspots.",
        "Tiered retention: recent weeks-to-months hot in the cluster, cold history aged to cheap object storage for rare deep scroll-back.",
      ],
      failures:[
        {t:"A shard node dies with un-flushed memtable writes",b:"Recently-acked messages appear to be gone.",m:"RF=3 across AZs with quorum (W=2) + commit-log/WAL — a lost node loses nothing; survivors serve reads and the memtable replays from the WAL; a replacement streams from peers."},
        {t:"Write-primary crashes, old primary rejoins as primary",b:"Split-brain: two nodes mint seqs → a forked, conflicting conversation (corruption).",m:"Consensus leader-election with a monotonic epoch; the stale primary's writes are rejected via fencing token. seq is bound to the epoch so ordering can't fork; that shard's writes pause a few seconds (consistency over availability), reads stay up."},
      ],
      tradeoffs:[
        {a:"ScyllaDB / Cassandra (masterless)",b:"HBase or DynamoDB",pick:"Masterless LSM fits write-heavy, per-conversation-ordered reads with no write-primary SPOF; HBase adds unneeded global consistency + HDFS ops and region hotspots, and DynamoDB's ~1K WCU/partition cap throttles hot conversations at ~15M writes/s."},
        {a:"No global secondary index",b:"Global index by sender_id",pick:"A global index is a second table every write updates (write amplification) whose reads scatter across partitions — exactly the pattern the conversation_id key removes; keep dedupe partition-scoped instead."},
      ],
      probes:[
        "Why partition by conversation rather than by user or by message-id?",
        "A single broadcast conversation takes 50K msg/s — that's a hotspot even after hashing. Fix it.",
        "Give me the node math: candidates with per-node write ceilings, and why ~300 Scylla vs ~500 Cassandra.",
      ],
    },
    queue:{
      role:"The durable, partitioned log (Kafka) that <strong>decouples accept from deliver</strong>: the send path acks fast, and fan-out, delivery, and push drain asynchronously with retry and burst absorption. Its most consequential lever is <strong>partition-by-conversation-id</strong>, which preserves per-conversation order cheaply while different conversations parallelize across partitions.",
      capacity:[
        ["Effective throughput","~10-20M events/s peak","accept ~5M/s × fan-out multiplier"],
        ["Per-partition budget","~50K events/s","one consumer's safe sustain"],
        ["Partitions","~400 floor, ~2000 provisioned","20M ÷ 50K + headroom + hot-key buckets"],
        ["Config","RF=3, acks=all, min.insync=2","durability on enqueue"],
      ],
      data:"A replicated retained log — holds fan-out/delivery/push tasks, not the source of truth (that's the store). Ordering is per-partition by conversation_id; consumers track committed <strong>offsets</strong>. Delivery is <strong>at-least-once</strong>; correctness comes from idempotent consumers keyed on message-id / client-msg-id, not exactly-once semantics.",
      scaling:[
        "Size partition count to target-throughput ÷ per-partition budget with modest headroom — thousands, not 100K, since partitions cost open files, rebalances, and leader elections.",
        "Sub-key genuinely hot conversations (conversation_id + bucket); cross-bucket order is fine because the <strong>server-assigned seq</strong>, not queue arrival order, is the real ordering guarantee.",
        "Scale delivery by adding consumer instances up to the partition count; workers are stateless.",
      ],
      failures:[
        {t:"A broker holding partitions for millions of pending tasks dies",b:"Queued deliveries appear at risk.",m:"RF=3, acks=all, min.insync.replicas=2 — leader re-elects to an in-sync replica with no loss; producers only got acked after replication, consumers resume from committed offsets."},
        {t:"Consumer crashes after delivering but before committing offset",b:"The task redelivers — a potential duplicate message/receipt.",m:"At-least-once + idempotent consumers: dedupe on message-id / client-msg-id so a redelivery is a no-op, chosen over fragile exactly-once."},
      ],
      tradeoffs:[
        {a:"Kafka (retained log)",b:"RabbitMQ / SQS",pick:"Kafka gives partition-ordering by conversation_id, durable replay from committed offset, and tens-of-millions-of-events/s headroom; RabbitMQ is a broker not a log (replay is awkward) and SQS standard loses order while FIFO caps throughput."},
        {a:"~2000 partitions",b:"100K partitions",pick:"More partitions buy parallelism but cost open files, longer rebalances, more leader elections, and fragment ordering — size to throughput ÷ budget with headroom, not maximum."},
      ],
      probes:[
        "Why a queue at all instead of the chat service calling delivery directly — and how do you keep per-conversation order?",
        "A 100K-member group has 500 members post in seconds — naive fan-out is 50M deliveries. Contain it.",
        "Fan-out-on-read just moves the storm to reads — 100K clients pulling one active group. Why is that better?",
      ],
    },
    presence:{
      role:"The online/last-seen/typing service — a <strong>shared cross-gateway view</strong> no single gateway can answer. Its most consequential property is being <strong>soft state</strong>, off the delivery path: online is a Redis key that exists, offline is that key silently expiring, so a total presence outage is cosmetic and never stops messaging.",
      capacity:[
        ["Raw heartbeats","~17M/s naive","500M ÷ 30s"],
        ["Redis ops after rollup","~100K-1M/s","gateway batches liveness it already knows"],
        ["Keyspace memory","~50GB","500M keys × ~100 bytes"],
        ["Redis nodes","~10-20","sharded by userId"],
      ],
      data:"Ephemeral TTL-driven state in a sharded, replicated Redis cluster: <code>presence:userId</code> refreshed by heartbeat with a ~45-60s TTL. Online = key exists; offline = expired; last-seen = last write time. Deliberately approximate — soft state that rebuilds itself within one TTL window, which is what licenses aggressive batching.",
      scaling:[
        "Terminate heartbeats <strong>at the gateway</strong> (it already knows socket liveness) and bulk-write rollups, so Redis sees far fewer ops than 17M/s of raw heartbeats.",
        "<strong>Subscribe-on-view</strong>: a user only receives B's presence when a chat with B is open, so the live watcher set is tiny — not a broadcast to 5,000 contacts.",
        "Scope typing/presence to active viewers of a conversation, sampled and debounced; shed these signals first under load.",
      ],
      failures:[
        {t:"The Redis presence cluster has a full outage",b:"Online dots and last-seen vanish for everyone.",m:"Messaging survives completely (nothing on the delivery path reads presence); UI falls back to 'presence unknown', and heartbeats repopulate the whole keyspace within one TTL window (~1 min) on recovery."},
        {t:"A user with 5,000 contacts comes online",b:"Naive eager fan-out notifies all 5,000 watchers — presence traffic dwarfs messaging.",m:"Subscribe-on-view keeps the watcher set to open chats (~3, not 5,000); rapid on/off flaps are coalesced and debounced."},
      ],
      tradeoffs:[
        {a:"~30s heartbeat / 45-60s TTL",b:"10s heartbeat for accuracy",pick:"A shorter interval triples write rate and drains phone battery/radio for pinpoint freshness nobody needs; presence is soft state, so bias to lower load and better battery over accuracy."},
        {a:"Redis (TTL + pub/sub)",b:"Memcached or the message DB",pick:"TTL-as-liveness plus pub/sub for targeted subscriptions is exactly the model; Memcached's LRU can evict live keys and lacks pub/sub, and a durable DB is overkill and a churn magnet for throwaway state."},
      ],
      probes:[
        "Even at 30s, 500M clients is ~17M heartbeat writes/s into Redis — how do you not drown?",
        "A 1,000-member group with everyone watching — presence and typing for all of them?",
        "The presence store goes fully down — what do users experience, and does messaging survive?",
      ],
    },
    push:{
      role:"The notification service that owns the <strong>APNs/FCM integration</strong> and the <code>userId/device → push token</code> map, waking offline devices so they pull the real message. Its most consequential framing is that push is a <strong>best-effort alert to come pull</strong>, never the delivery channel — the store + cursor is the real delivery, so a push outage costs alert timeliness, not messages.",
      capacity:[
        ["Morning burst","~2M push events/s","overnight offline backlog"],
        ["After coalescing","~200K sends/s","~10:1 one-per-conversation-burst"],
        ["Per worker","~5K/s","multiplexed HTTP/2 to APNs/FCM"],
        ["Workers","~40 floor + retry headroom","200K ÷ 5K"],
      ],
      data:"Holds the device-token mapping and a <strong>durable retry queue</strong> of push tasks. For E2EE the payload carries no content — a generic 'new message' + conversation id; rich previews come from a silent data-push that wakes the app to render a <strong>local</strong> notification on-device, so plaintext is never composed server-side.",
      scaling:[
        "<strong>Coalesce</strong> — one push per conversation-burst per device, not per message — cutting a 50-message thread to one 'N new messages' push (~10:1).",
        "Drain the durable queue at the <strong>provider-accepted rate</strong> using batch APIs and multiplexed connections; the provider, not your fleet, is the ceiling.",
        "On flush after an outage, coalesce and <strong>drop superseded/stale</strong> pushes (already-read, or past a max-age) to avoid a spam storm.",
      ],
      failures:[
        {t:"APNs/FCM is down or crawling for 20 minutes",b:"Notifications stall; risk of touching message delivery.",m:"Delivery runs off store + cursor and never waits on push; tasks sit in the durable retry queue with backoff and flush on recovery — zero messages lost, only alert timeliness."},
        {t:"Recovery fires 20 minutes of backlog at once",b:"Notification spam — every buffered buzz replays.",m:"Coalesce on flush to one summary per conversation and drop superseded/stale pushes; the message is already deliverable in-app, so pruning the backlog is safe."},
      ],
      tradeoffs:[
        {a:"Coalesce + metered drain",b:"Add workers and blast 2M/s raw",pick:"The ceiling is the provider (APNs/FCM rate-limit and will throttle a blaster), so more workers can't beat the limit and just spam users and drain battery; coalesce ~10:1 and drain at the accepted rate."},
        {a:"Generic 'new message' payload",b:"Content in the push",pick:"E2EE means content never leaves the client, so the payload is a bare alert; a silent data-push lets the app compose a rich local notification on-device without exposing plaintext server-side."},
      ],
      probes:[
        "The payload can't contain the message under E2EE — what does the user see on the lock screen?",
        "A morning backlog fires ~2M pushes/s at APNs/FCM — how do you not melt yourself or the providers?",
        "APNs throttles you — how do you not lose notifications, and does it touch message delivery?",
      ],
    },
  },
  dbDoc:{
    component:"Message store",
    load:"Write-dominated: ~1.16M msg/s average, ~5M/s at peak, each quorum-replicated 3x ≈ ~15M replica-writes/s at peak against ~20 TB/day of new history (~7 PB/yr logical, ~21 PB/yr replicated). Reads are lighter and narrow: <strong>open a chat, latest N by seq</strong> plus cursor catch-up (<code>seq &gt; cursor</code>) — a single-conversation range, never a cross-conversation scatter.",
    candidates:[
      {name:"Cassandra (masterless wide-column)",ceiling:"~10-30K writes/s per node",nodes:"15M writes/s ÷ ~30K/node ≈ <strong>500 nodes</strong> for the hot write tier",pick:false,note:"correct data model and no write-primary SPOF, but the lower per-node ceiling pushes node count to ~500 — the runner-up, and the fallback if a JVM/OSS stack is mandated over Scylla."},
      {name:"ScyllaDB (shard-per-core wide-column)",ceiling:"~50K+ writes/s per node",nodes:"15M writes/s ÷ ~50K/node ≈ <strong>300 nodes</strong>",pick:true,note:"chosen — same masterless LSM model as Cassandra, C++ shard-per-core pushes the per-node ceiling far higher, so ~300 nodes not ~500; tunable quorum buys durability + sub-second latency together with no failover SPOF."},
      {name:"DynamoDB (managed KV)",ceiling:"~1K WCU (1 KB writes/s) per partition, auto-splits",nodes:"managed, but 15M writes/s ÷ 1K WCU ≈ <strong>15K+ hot partitions</strong> to stay under the per-partition cap",pick:false,note:"the per-partition write cap throttles hot broadcast conversations and cost climbs steeply at this write rate — reach for it only if managed failover matters more than the bill."},
    ],
    indexing:"Primary key = <strong>partition key <code>conversation_id</code>, clustering key <code>seq</code> (descending)</strong>. Every message in a conversation is co-located on one partition and stored already sorted by seq, so <strong>load latest N</strong> is a <strong>single-partition scan</strong> — one node, one seek, N contiguous rows, no merge, no scatter-gather; catch-up is the same primitive with a <code>seq &gt; cursor</code> bound. A <strong>global secondary index</strong> (say by sender_id) is a second physical table every write must also update — write amplification — and its reads fan out across partitions, the exact scatter this key design removes. So dedupe stays partition-scoped (<code>client_msg_id</code> within the conversation) and there is <em>no</em> global secondary index on the hot path.",
    decision:"Pick <strong>masterless wide-column, ScyllaDB (or Cassandra)</strong>. The workload is write-heavy with strictly per-conversation-ordered reads and needs no consistency beyond a single partition — masterless LSM's sweet spot, where tunable quorum gives durability and sub-second latency and no write-primary means no failover SPOF. <strong>Not HBase</strong>: strong global consistency we do not need, plus heavy HDFS / region-server ops and region hotspots that punish skewed broadcast conversations. <strong>Not DynamoDB</strong>: the ~1K WCU/partition cap throttles hot conversations and cost climbs steeply at ~15M writes/s. Scylla's higher per-node ceiling also keeps the count near ~300 rather than ~500 — real money at this scale.",
  },
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
  deepFlows:[
    {id:"send-1-1-e2e",name:"Send 1:1 message",summary:"**Client WebSocket frame** → gateway forwards → chat dedupes and assigns a **per-conversation <code>seq</code>** → Scylla write on **<code>conversation_id</code>** with **QUORUM (W=2/RF=3)** → lookup <code>connection_registry</code> → recipient gateway pushes → receipt advances <code>user_inbox</code>.",steps:[
      {node:"client",title:"Client sends a durable outbox frame",snap:{cap:"No server mutation yet: A has only written its durable phone outbox and sent a frame. The authoritative store and B's delivery cursor remain at seq 4471.",tables:[{name:"messages (conversation c-9f2a)",note:"authoritative history before the frame is accepted",cols:["conversation_id","seq","message_id","client_msg_id","sender_id","ciphertext","created_at"],rows:[{c:["c-9f2a","4470","m-01","b3f1-aa","42","0x9e2c…","2026-07-22 10:04:59"]},{c:["c-9f2a","4471","m-02","b3f1-bb","42","0x71a4…","2026-07-22 10:05:01"],hi:1,tag:"latest durable"}]},{name:"user_inbox",cols:["user_id","conversation_id","last_delivered_seq","last_read_seq","updated_at"],rows:[{c:["77","c-9f2a","4471","4470","2026-07-22 10:05:02"],hi:1,tag:"B caught up"}]}]},narrate:"A's phone first writes the ciphertext to its local outbox, mints <code>client_msg_id</code>, renders optimistically, then sends a WebSocket frame. If the network drops, the same <code>client_msg_id</code> is retried so the server can collapse duplicates.",details:[
        {k:"wire",label:"WebSocket frame",lang:"json",code:"{\n  \"op\": \"message.send\",\n  \"conversation_id\": \"c-9f2a\",\n  \"client_msg_id\": \"b3f1-bc\",\n  \"sender_id\": 42,\n  \"ciphertext\": \"0xa5d91c...\",\n  \"client_ts\": \"2026-07-22T10:05:04Z\"\n}"},
        {k:"note",label:"Why the client id matters",text:"The phone may never receive the ack even after the store committed. Retrying the same <code>client_msg_id</code> lets chat return the already-assigned <code>seq</code> instead of creating a second message."},
      ]},
      {node:"gw",title:"Gateway forwards without owning truth",snap:{cap:"The gateway forwards bytes but owns no durable truth. If it crashes now, A retries the same <code>client_msg_id</code>; the server tables are still unchanged.",tables:[{name:"connection_registry",note:"routing hint for A's existing socket",cols:["user_id","gateway_node","conn_id","connected_at"],rows:[{c:["42","gw-07","ab12","2026-07-22 09:58:10"],hi:1,tag:"source socket"},{c:["77","gw-31","cd34","2026-07-22 10:01:44"]}]},{name:"messages (conversation c-9f2a)",cols:["conversation_id","seq","message_id","client_msg_id"],rows:[{c:["c-9f2a","4471","m-02","b3f1-bb"],hi:1,tag:"still latest"}]}]},narrate:"The gateway only owns the socket. It authenticates the session, adds connection metadata, and forwards the frame to any chat service instance; no durable message state is kept on the gateway.",details:[
        {k:"wire",label:"Gateway → chat RPC",lang:"json",code:"{\n  \"method\": \"SendMessage\",\n  \"from_gateway\": \"gw-07\",\n  \"conn_id\": \"ab12\",\n  \"user_id\": 42,\n  \"conversation_id\": \"c-9f2a\",\n  \"client_msg_id\": \"b3f1-bc\",\n  \"ciphertext\": \"0xa5d91c...\"\n}"},
        {k:"gotcha",label:"Do not ack here",text:"An ack from the gateway would only mean bytes reached one process. The sender's sent tick waits for the chat service to persist the row durably."},
      ]},
      {node:"chat",title:"Dedupe and allocate the next seq",snap:{cap:"The partition-local dedupe check misses, so <code>conversations.last_seq</code> advances 4471&rarr;4472. The message row is not durable until the next step.",tables:[{name:"conversations (shard hash(c-9f2a))",cols:["conversation_id","type","member_ids","last_seq","created_at"],rows:[{c:["c-9f2a","1:1","[42, 77]","4472","2026-07-01 08:00:00"],hi:1,tag:"seq allocated"},{c:["c-1b30","group","[88, 42, 91, 12]","881","2026-07-10 14:20:00"]}]},{name:"messages (conversation c-9f2a)",note:"no row for seq 4472 yet",cols:["conversation_id","seq","message_id","client_msg_id"],rows:[{c:["c-9f2a","4471","m-02","b3f1-bb"],hi:1,tag:"latest persisted"}]}]},narrate:"Chat scopes ordering to one conversation. It checks the partition-local dedupe key, then advances <code>conversations.last_seq</code> from 4471 to 4472; different conversations do this independently, so there is no global counter.",details:[
        {k:"query",label:"Per-conversation seq allocation",lang:"text",code:"-- partition-scoped dedupe entry, colocated with conversation_id = c-9f2a\nGET dedupe:c-9f2a:b3f1-bc\n-- hit => { seq: 4472, message_id: 'm-04' }, return it\n\n-- miss: advance the conversation row atomically\nUPDATE conversations\nSET last_seq = 4472\nWHERE conversation_id = 'c-9f2a'\nIF last_seq = 4471;"},
        {k:"route",label:"Routing key",text:"Both the dedupe probe and seq update route by <code>hash(conversation_id)</code>. That co-locates ordering state with the message rows, and it is why reads such as <code>seq &gt; cursor</code> are one-partition scans."},
        {k:"gotcha",label:"Hot conversation trade-off",text:"A 50K msg/s broadcast conversation can still hotspot one partition. The existing design mitigates with <code>conversation_id + bucket</code> for giant conversations and relies on server-assigned <code>seq</code> for display order."},
      ]},
      {node:"store",title:"Persist ciphertext before ack",snap:{cap:"The ciphertext is now the source of truth: one row is inserted at <code>(c-9f2a, 4472)</code> after quorum replication, so the sender can be acked safely.",tables:[{name:"messages (conversation c-9f2a · RF=3/W=2)",cols:["conversation_id","seq","message_id","client_msg_id","sender_id","ciphertext","created_at"],rows:[{c:["c-9f2a","4471","m-02","b3f1-bb","42","0x71a4…","2026-07-22 10:05:01"]},{c:["c-9f2a","4472","m-04","b3f1-bc","42","0xa5d91c…","2026-07-22 10:05:04"],hi:1,tag:"inserted"}]},{name:"conversations",cols:["conversation_id","type","member_ids","last_seq","created_at"],rows:[{c:["c-9f2a","1:1","[42, 77]","4472","2026-07-01 08:00:00"],hi:1,tag:"allocator state"}]}]},narrate:"The message row is inserted into the <code>messages</code> wide row for <code>c-9f2a</code>, clustered by <code>seq</code>. This is the source of truth for live delivery, reconnect sync, and every device's history.",details:[
        {k:"query",label:"Message write",lang:"sql",code:"CONSISTENCY QUORUM;\nINSERT INTO messages\n  (conversation_id, seq, message_id, client_msg_id,\n   sender_id, ciphertext, created_at)\nVALUES\n  ('c-9f2a', 4472, 'm-04', 'b3f1-bc',\n   42, 0xa5d91c..., '2026-07-22 10:05:04');"},
        {k:"route",label:"Why shard by conversation_id",text:"The dominant reads are <code>latest N</code> and <code>seq &gt; last_delivered_seq</code> within one conversation. Partitioning by <code>conversation_id</code> makes those reads contiguous and ordered; partitioning by sender or message id would scatter a chat history across many nodes."},
        {k:"repl",label:"Durability",text:"Scylla/Cassandra stores RF=3 replicas across AZs and acks with <strong>QUORUM</strong> (W=2). An accepted message survives one replica loss because at least two commit logs have the row before chat acks the sender."},
      ]},
      {node:"presence",title:"Find B's live socket",snap:{cap:"This is a read-only routing lookup: B's registry row points at <code>gw-31/cd34</code>. The message is already durable, so a stale miss would simply fall to offline sync.",tables:[{name:"connection_registry",note:"read only &mdash; no mutation",cols:["user_id","gateway_node","conn_id","connected_at"],rows:[{c:["42","gw-07","ab12","2026-07-22 09:58:10"]},{c:["77","gw-31","cd34","2026-07-22 10:01:44"],hi:1,tag:"route found"}]},{name:"messages (conversation c-9f2a)",cols:["conversation_id","seq","message_id","client_msg_id"],rows:[{c:["c-9f2a","4472","m-04","b3f1-bc"],hi:1,tag:"durable before route"}]}]},narrate:"After the durable write, chat asks the connection registry for recipient 77. The registry is a Redis-like TTL map and is only a routing hint; a stale or missing entry falls through to the offline flow.",details:[
        {k:"query",label:"Connected-server lookup",lang:"sql",code:"SELECT gateway_node, conn_id\nFROM connection_registry\nWHERE user_id = 77;\n-- returns gw-31 / cd34 while B is online"},
        {k:"route",label:"Recorded, not computed",text:"The destination gateway is not <code>hash(user_id)</code>. Gateways write <code>user_id → gateway_node, conn_id</code> on connect because a user's socket can land on any of ~500-1000 gateway nodes."},
      ]},
      {node:"gw",title:"Recipient gateway pushes and gets device ack",snap:{cap:"B's device has acknowledged the frame, but no delivery state is durable until the receipt write runs. The cursor still shows 4471 after this push step.",tables:[{name:"messages (conversation c-9f2a)",cols:["conversation_id","seq","message_id","sender_id","ciphertext","created_at"],rows:[{c:["c-9f2a","4472","m-04","42","0xa5d91c…","2026-07-22 10:05:04"],hi:1,tag:"pushed frame"}]},{name:"user_inbox",note:"awaiting receipt write",cols:["user_id","conversation_id","last_delivered_seq","last_read_seq","updated_at"],rows:[{c:["77","c-9f2a","4471","4470","2026-07-22 10:05:02"],hi:1,tag:"not advanced yet"}]}]},narrate:"Chat forwards the persisted envelope to <code>gw-31</code>, which writes it to B's socket. Only B's device ack advances delivery; a successful server-to-gateway forward is not a delivered receipt.",details:[
        {k:"wire",label:"Push frame to B",lang:"json",code:"{\n  \"op\": \"message.new\",\n  \"conversation_id\": \"c-9f2a\",\n  \"seq\": 4472,\n  \"message_id\": \"m-04\",\n  \"sender_id\": 42,\n  \"ciphertext\": \"0xa5d91c...\",\n  \"created_at\": \"2026-07-22T10:05:04Z\"\n}"},
        {k:"wire",label:"Device delivery ack",lang:"json",code:"{\n  \"op\": \"receipt.delivered\",\n  \"conversation_id\": \"c-9f2a\",\n  \"user_id\": 77,\n  \"last_delivered_seq\": 4472\n}"},
      ]},
      {node:"store",title:"Advance B's cursor idempotently",snap:{cap:"The delivered receipt becomes a monotonic cursor update: B's <code>last_delivered_seq</code> advances 4471&rarr;4472. Replays repeat the same conditional write and do not move it backward.",tables:[{name:"user_inbox",cols:["user_id","conversation_id","last_delivered_seq","last_read_seq","updated_at"],rows:[{c:["77","c-9f2a","4472","4470","2026-07-22 10:05:05"],hi:1,tag:"advanced"}]},{name:"messages (conversation c-9f2a)",cols:["conversation_id","seq","message_id","client_msg_id"],rows:[{c:["c-9f2a","4472","m-04","b3f1-bc"],hi:1,tag:"covered by cursor"}]}]},narrate:"Delivery/read receipts are monotonic cursor updates in <code>user_inbox</code>. Redelivered frames, reconnect replays, and duplicated queue tasks can all repeat the same update safely.",details:[
        {k:"query",label:"Receipt write",lang:"sql",code:"UPDATE user_inbox\nSET last_delivered_seq = 4472,\n    updated_at = '2026-07-22 10:05:05'\nWHERE user_id = 77\n  AND conversation_id = 'c-9f2a'\nIF last_delivered_seq < 4472;"},
        {k:"note",label:"Ordering guarantee",text:"Clients render by server <code>seq</code>, not arrival order. If two frames arrive out of order, B buffers or sorts by <code>seq</code>; the cursor only moves forward when all prior seqs are present."},
      ]},
    ]},

    {id:"offline-delivery-e2e",name:"Offline delivery",summary:"Recipient registry lookup misses → the message is already durable in <code>messages</code> and B's <code>user_inbox</code> cursor stays behind → push sends a **best-effort wake-up** → on reconnect the client pulls **<code>seq &gt; last_delivered_seq</code>** and advances the cursor.",steps:[
      {node:"chat",title:"Online route fails after persist",snap:{cap:"The message row already exists, but B's live-route hint is gone or stale. Delivery switches to offline semantics without creating a second message copy.",tables:[{name:"messages (conversation c-9f2a)",cols:["conversation_id","seq","message_id","client_msg_id","sender_id","ciphertext","created_at"],rows:[{c:["c-9f2a","4472","m-04","b3f1-bc","42","0xa5d91c…","2026-07-22 10:05:04"],hi:1,tag:"durable"}]},{name:"connection_registry",cols:["user_id","gateway_node","conn_id","connected_at"],rows:[{c:["77","gw-31","cd34","2026-07-22 10:01:44"],gone:1,hi:1,tag:"expired / timed out"}]}]},narrate:"The send path has already written <code>messages(c-9f2a, 4472)</code>. Now chat tries to route to B, but the registry has no live socket or the gateway forward times out, so B is treated as offline.",details:[
        {k:"query",label:"Registry miss",lang:"sql",code:"SELECT gateway_node, conn_id\nFROM connection_registry\nWHERE user_id = 77;\n-- no row, expired TTL, or gw-31 forward timed out"},
        {k:"note",label:"No special offline copy",text:"The durable row in <code>messages</code> is the delivery backlog. Offline is represented by B's <code>user_inbox.last_delivered_seq</code> lagging behind the conversation's latest <code>seq</code>."},
      ]},
      {node:"store",title:"Leave B's cursor behind",snap:{cap:"Offline backlog is represented by the gap between latest message seq 4472 and B's cursor 4471. No extra offline-message table is needed.",tables:[{name:"user_inbox",cols:["user_id","conversation_id","last_delivered_seq","last_read_seq","updated_at"],rows:[{c:["77","c-9f2a","4471","4470","2026-07-22 10:05:02"],hi:1,tag:"behind by 1"}]},{name:"messages (conversation c-9f2a)",cols:["conversation_id","seq","message_id","client_msg_id"],rows:[{c:["c-9f2a","4472","m-04","b3f1-bc"],hi:1,tag:"waiting to pull"}]}]},narrate:"Because B did not ack the frame, <code>user_inbox</code> is not advanced. That single cursor value is enough to know exactly which messages B must pull later.",details:[
        {k:"query",label:"Cursor state",lang:"sql",code:"SELECT last_delivered_seq, last_read_seq\nFROM user_inbox\nWHERE user_id = 77\n  AND conversation_id = 'c-9f2a';\n-- last_delivered_seq = 4471, latest message seq = 4472"},
        {k:"repl",label:"Backlog durability",text:"The backlog is as durable as the message itself: RF=3, QUORUM write, commit-log on two replicas before ack. Push can fail for minutes without affecting message delivery correctness."},
      ]},
      {node:"push",title:"Send a wake-up, not the message",snap:{cap:"Push carries only a wake-up with <code>conversation_id</code> and <code>max_seq</code>. The message bytes stay in <code>messages</code>, and B's cursor still records the real delivery state.",tables:[{name:"messages (conversation c-9f2a)",cols:["conversation_id","seq","message_id","sender_id","ciphertext","created_at"],rows:[{c:["c-9f2a","4472","m-04","42","0xa5d91c…","2026-07-22 10:05:04"],hi:1,tag:"not in push"}]},{name:"user_inbox",cols:["user_id","conversation_id","last_delivered_seq","last_read_seq","updated_at"],rows:[{c:["77","c-9f2a","4471","4470","2026-07-22 10:05:02"],hi:1,tag:"still undelivered"}]}]},narrate:"Chat notifies the notification service to alert B. For E2EE, the payload carries only routing metadata; the device must wake and pull the ciphertext from the store-backed API.",details:[
        {k:"wire",label:"Push task",lang:"json",code:"{\n  \"type\": \"new_message_alert\",\n  \"user_id\": 77,\n  \"conversation_id\": \"c-9f2a\",\n  \"max_seq\": 4472,\n  \"collapse_key\": \"c-9f2a\"\n}"},
        {k:"gotcha",label:"Push is not delivery",text:"APNs/FCM is best-effort and rate-limited. The system can coalesce or drop stale pushes because the real message remains available by cursor sync."},
      ]},
      {node:"client",title:"B reconnects with its cursor",snap:{cap:"The resume frame is a read of B's own checkpoint: <code>last_delivered_seq=4471</code>. No mutation yet; it just defines the lower bound for catch-up.",tables:[{name:"user_inbox",note:"read only &mdash; no mutation",cols:["user_id","conversation_id","last_delivered_seq","last_read_seq","updated_at"],rows:[{c:["77","c-9f2a","4471","4470","2026-07-22 10:05:02"],hi:1,tag:"resume cursor"}]},{name:"messages (conversation c-9f2a)",cols:["conversation_id","seq","message_id","client_msg_id"],rows:[{c:["c-9f2a","4472","m-04","b3f1-bc"],hi:1,tag:"above cursor"}]}]},narrate:"When B opens the app or receives the push, it establishes a WebSocket and sends its per-conversation cursor. This is a delta sync, not a full history reload.",details:[
        {k:"wire",label:"Resume frame",lang:"json",code:"{\n  \"op\": \"sync.resume\",\n  \"user_id\": 77,\n  \"cursors\": {\n    \"c-9f2a\": { \"last_delivered_seq\": 4471 }\n  }\n}"},
        {k:"note",label:"Reconnect storm control",text:"Clients use exponential backoff plus jitter, so a gateway crash does not make millions of phones reconnect and pull at the same instant."},
      ]},
      {node:"gw",title:"Gateway refreshes the registry",snap:{cap:"The new socket rewrites B's soft-state route to <code>gw-12/ef56</code>. Future live sends can use this hint, while already-missed messages still come from cursor sync.",tables:[{name:"connection_registry",cols:["user_id","gateway_node","conn_id","connected_at"],rows:[{c:["42","gw-07","ab12","2026-07-22 09:58:10"]},{c:["77","gw-12","ef56","2026-07-22 10:08:10"],hi:1,tag:"refreshed"}]},{name:"user_inbox",cols:["user_id","conversation_id","last_delivered_seq","last_read_seq","updated_at"],rows:[{c:["77","c-9f2a","4471","4470","2026-07-22 10:05:02"],hi:1,tag:"still needs sync"}]}]},narrate:"The new socket lands on some gateway and rewrites the connection registry. Future live messages for B can now route directly to this node again.",details:[
        {k:"query",label:"Registry write",lang:"sql",code:"INSERT INTO connection_registry\n  (user_id, gateway_node, conn_id, connected_at)\nVALUES\n  (77, 'gw-12', 'ef56', '2026-07-22 10:08:10');\n-- TTL refreshed by gateway heartbeats"},
        {k:"route",label:"Soft-state self-healing",text:"Old entries expire by TTL; the newest connect overwrites <code>gateway_node</code>/<code>conn_id</code>. The registry can be stale without losing messages because delivery is cursor based."},
      ]},
      {node:"store",title:"Pull missing messages by seq",snap:{cap:"Read-only catch-up: the store scans <code>seq &gt; 4471</code> and returns row 4472 in order. The cursor does not advance until B stores/decrypts and acks it.",tables:[{name:"messages (conversation c-9f2a · single-partition range read)",note:"no mutation",cols:["conversation_id","seq","message_id","sender_id","ciphertext","created_at"],rows:[{c:["c-9f2a","4472","m-04","42","0xa5d91c…","2026-07-22 10:05:04"],hi:1,tag:"read row"}]},{name:"user_inbox",cols:["user_id","conversation_id","last_delivered_seq","last_read_seq","updated_at"],rows:[{c:["77","c-9f2a","4471","4470","2026-07-22 10:05:02"],hi:1,tag:"not mutated"}]}]},narrate:"The sync read is a single-partition range scan: conversation <code>c-9f2a</code>, clustering key greater than B's cursor. Rows are returned already ordered by server <code>seq</code>.",details:[
        {k:"query",label:"Catch-up read",lang:"sql",code:"CONSISTENCY QUORUM;\nSELECT seq, message_id, sender_id, ciphertext, created_at\nFROM messages\nWHERE conversation_id = 'c-9f2a'\n  AND seq > 4471\nORDER BY seq ASC\nLIMIT 100;"},
        {k:"route",label:"Read routing",text:"The API hashes <code>conversation_id</code> to the replica set holding that conversation. Use QUORUM or leader/primary owner for read-your-writes; follower/LOCAL_ONE is cheaper for older scroll-back if slight staleness is acceptable."},
      ]},
      {node:"store",title:"Ack and advance the cursor",snap:{cap:"After local durability/decrypt, B's receipt advances <code>last_delivered_seq</code> to 4472. Duplicate pulls or repeated acks collapse into this same monotonic checkpoint.",tables:[{name:"user_inbox",cols:["user_id","conversation_id","last_delivered_seq","last_read_seq","updated_at"],rows:[{c:["77","c-9f2a","4472","4470","2026-07-22 10:08:11"],hi:1,tag:"advanced"}]},{name:"messages (conversation c-9f2a)",cols:["conversation_id","seq","message_id","client_msg_id"],rows:[{c:["c-9f2a","4472","m-04","b3f1-bc"],hi:1,tag:"now delivered"}]}]},narrate:"After B durably stores/decrypts the messages locally, it sends a delivered receipt. The cursor update is monotonic, so duplicate pulls or repeated acks cannot move it backward.",details:[
        {k:"query",label:"Advance delivered/read cursors",lang:"sql",code:"UPDATE user_inbox\nSET last_delivered_seq = 4472,\n    updated_at = '2026-07-22 10:08:11'\nWHERE user_id = 77\n  AND conversation_id = 'c-9f2a'\nIF last_delivered_seq < 4472;"},
        {k:"note",label:"Dedup on reconnect",text:"If the same row is pulled twice, <code>message_id</code>/<code>seq</code> identifies it. The client renders one copy and the cursor write remains a no-op after the first success."},
      ]},
    ]},

    {id:"group-fanout-e2e",name:"Group fan-out",summary:"Group send still **persists once** in <code>messages</code> with one conversation <code>seq</code>, then Kafka fan-out keyed by <code>conversation_id</code> delivers to online members or nudges offline members; huge groups switch to **fan-out-on-read** so 100K members do not sit on the sender's latency path.",steps:[
      {node:"client",title:"Member posts to a group",snap:{cap:"The group frame has not changed server state yet. Conversation <code>c-1b30</code> is still at seq 881 with one latest group message row.",tables:[{name:"conversations",cols:["conversation_id","type","member_ids","last_seq","created_at"],rows:[{c:["c-1b30","group","[88, 42, 91, 12]","881","2026-07-10 14:20:00"],hi:1,tag:"current seq"}]},{name:"messages (conversation c-1b30)",cols:["conversation_id","seq","message_id","client_msg_id","sender_id","ciphertext","created_at"],rows:[{c:["c-1b30","881","m-03","c7d2-01","88","0x0fce…","2026-07-22 10:05:03"],hi:1,tag:"latest durable"}]}]},narrate:"For a group, the wire frame looks like 1:1: one ciphertext envelope for conversation <code>c-1b30</code>. The sender still gets one server <code>seq</code>; delivery to members is not done synchronously on the send request.",details:[
        {k:"wire",label:"Group send frame",lang:"json",code:"{\n  \"op\": \"message.send\",\n  \"conversation_id\": \"c-1b30\",\n  \"client_msg_id\": \"c7d2-02\",\n  \"sender_id\": 88,\n  \"ciphertext\": \"0x6e0a...\"\n}"},
        {k:"note",label:"Sender-key friendly",text:"With E2EE group sender keys, the server still sees only routing metadata and one ciphertext blob; fan-out operates on the envelope, not plaintext."},
      ]},
      {node:"store",title:"Persist once for the whole group",snap:{cap:"One atomic seq allocation and one message row serve the whole group: <code>last_seq</code> advances 881&rarr;882 and <code>m-05</code> is inserted once, not per member.",tables:[{name:"conversations (shard hash(c-1b30))",cols:["conversation_id","type","member_ids","last_seq","created_at"],rows:[{c:["c-1b30","group","[88, 42, 91, 12]","882","2026-07-10 14:20:00"],hi:1,tag:"seq allocated"}]},{name:"messages (conversation c-1b30)",cols:["conversation_id","seq","message_id","client_msg_id","sender_id","ciphertext","created_at"],rows:[{c:["c-1b30","881","m-03","c7d2-01","88","0x0fce…","2026-07-22 10:05:03"]},{c:["c-1b30","882","m-05","c7d2-02","88","0x6e0a…","2026-07-22 10:06:00"],hi:1,tag:"inserted once"}]}]},narrate:"Chat allocates the next per-conversation sequence and inserts one row. A 100K-member group still creates one durable message row, not 100K message copies.",details:[
        {k:"query",label:"Group message write",lang:"sql",code:"UPDATE conversations\nSET last_seq = 882\nWHERE conversation_id = 'c-1b30'\nIF last_seq = 881;\n\nCONSISTENCY QUORUM;\nINSERT INTO messages\n  (conversation_id, seq, message_id, client_msg_id,\n   sender_id, ciphertext, created_at)\nVALUES\n  ('c-1b30', 882, 'm-05', 'c7d2-02',\n   88, 0x6e0a..., '2026-07-22 10:06:00');"},
        {k:"repl",label:"Same durability promise",text:"The sender is acked only after the RF=3 / QUORUM write succeeds. Fan-out can lag, replay, or fail independently without losing the accepted group message."},
      ]},
      {node:"queue",title:"Enqueue one fan-out task",snap:{cap:"Kafka appends one fan-out event keyed by <code>conversation_id=c-1b30</code>. Partition P130 log-end advances to 129 while the message store remains the source of truth.",tables:[{name:"messages (conversation c-1b30)",cols:["conversation_id","seq","message_id","client_msg_id"],rows:[{c:["c-1b30","882","m-05","c7d2-02"],hi:1,tag:"source of truth"}]},{name:"conversations",cols:["conversation_id","type","member_ids","last_seq","created_at"],rows:[{c:["c-1b30","group","[88, 42, 91, 12]","882","2026-07-10 14:20:00"],hi:1,tag:"queue key"}]}],queues:[{name:"chat-fanout",kind:"kafka",by:"key = conversation_id · 2000 partitions",parts:[{id:"P130",key:"hash(c-1b30)",msgs:[{v:"fanout c-1b30 seq 882",hi:1,tag:"appended @128"}],commit:128,end:129},{id:"P017",key:"hash(c-5aa0)",msgs:[{v:"fanout c-5aa0 seq 19"}],commit:64,end:65},{id:"P884",key:"other group keys",msgs:[{v:"fanout c-8ce2 seq 704"}],commit:311,end:312}]}]},narrate:"After persistence, chat publishes one durable fan-out event. Kafka is partitioned by <code>conversation_id</code> so events for the same group are consumed in order while different groups parallelize across ~2000 partitions.",details:[
        {k:"route",label:"Kafka partition",lang:"python",code:"partition = hash('c-1b30') % 2000\nproducer.send(\n  topic='chat-fanout',\n  key='c-1b30',\n  value={ 'conversation_id': 'c-1b30', 'seq': 882 }\n)"},
        {k:"repl",label:"Queue durability",text:"Kafka RF=3 with <code>acks=all</code> and <code>min.insync.replicas=2</code> means the fan-out task is not acknowledged until at least two brokers have it; consumers can replay from committed offsets."},
        {k:"gotcha",label:"Hot group bucket",text:"For a truly hot broadcast conversation, use <code>conversation_id + bucket</code> to split queue load. Cross-bucket delivery arrival can vary, so clients still order by server <code>seq</code>."},
        {k:"queue",label:"How Kafka adds the fan-out task",lang:"python",code:"producer.send('chat-fanout', key='c-1b30', value={'seq': 882}, acks='all')\n# partition = hash('c-1b30') % 2000 -> P130\n# broker appends at offset 128; log-end 128 -> 129\n# nothing is removed; every consumer group tracks its own offset"},
        {k:"queue",label:"Ordering vs parallelism",text:"Keying by <code>conversation_id</code> keeps all events for one group on P130 in order. The trade-off is that one partition is consumed by one worker at a time, so ~2000 partitions are also the ceiling for parallel fan-out workers before hot groups need bucketing."},
      ]},
      {node:"chat",title:"Choose write-fanout or read-fanout",snap:{cap:"Fan-out policy is a read of the group metadata: this four-member group stays on write-fanout. No message, cursor, or queue offset is mutated by the decision itself.",tables:[{name:"conversations",note:"read only &mdash; no mutation",cols:["conversation_id","type","member_ids","last_seq","created_at"],rows:[{c:["c-1b30","group","[88, 42, 91, 12]","882","2026-07-10 14:20:00"],hi:1,tag:"policy input"}]},{name:"messages (conversation c-1b30)",cols:["conversation_id","seq","message_id","client_msg_id"],rows:[{c:["c-1b30","882","m-05","c7d2-02"],hi:1,tag:"already durable"}]}]},narrate:"Fan-out workers inspect membership and policy. Small/active groups get per-recipient delivery tasks; huge groups keep the single stored row and let active members pull by cursor, with only coalesced push nudges.",details:[
        {k:"query",label:"Membership and policy",lang:"sql",code:"SELECT type, member_ids, last_seq\nFROM conversations\nWHERE conversation_id = 'c-1b30';\n-- sample row: type='group', member_ids=[88,42,91,12], last_seq=882"},
        {k:"route",label:"Hybrid fan-out",text:"Small groups: fan-out-on-write gives instant socket delivery. Very large groups (for example 100K members): fan-out-on-read prevents 100K registry lookups and pushes from sitting behind every send."},
      ]},
      {node:"presence",title:"Resolve online recipients",snap:{cap:"The worker batch-reads routing hints for members. User 42 is online at <code>gw-07</code>; user 91 has no live route and will stay cursor-behind/offline.",tables:[{name:"connection_registry",note:"read only &mdash; soft routing hints",cols:["user_id","gateway_node","conn_id","connected_at"],rows:[{c:["42","gw-07","ab12","2026-07-22 09:58:10"],hi:1,tag:"online"},{c:["91","(null)","(null)","(null)"],hi:1,tag:"offline"}]},{name:"user_inbox",cols:["user_id","conversation_id","last_delivered_seq","last_read_seq","updated_at"],rows:[{c:["12","c-1b30","880","880","2026-07-22 09:40:00"]},{c:["91","c-1b30","(null)","(null)","(null)"]}]}]},narrate:"For members selected for live delivery, workers batch lookup the connection registry. Online members get a gateway route; offline members keep their cursor behind and receive a coalesced push.",details:[
        {k:"query",label:"Batch registry lookups",lang:"sql",code:"SELECT user_id, gateway_node, conn_id\nFROM connection_registry\nWHERE user_id IN (42, 91, 12);\n-- 42 => gw-07/ab12, 91 => null, 12 => maybe offline"},
        {k:"note",label:"Registry is a hint",text:"A stale route just converts that member to the offline path. Delivered receipts are based on device acks, never on the worker successfully finding a gateway node."},
      ]},
      {node:"gw",title:"Push online members, retry safely",snap:{cap:"The fan-out consumer reads P130 at offset 128, pushes member 42, advances that member's cursor to 882, then commits offset 129. A crash before commit replays the same task, and the cursor update is idempotent.",tables:[{name:"user_inbox",cols:["user_id","conversation_id","last_delivered_seq","last_read_seq","updated_at"],rows:[{c:["42","c-1b30","882","881","2026-07-22 10:06:01"],hi:1,tag:"advanced"},{c:["12","c-1b30","880","880","2026-07-22 09:40:00"]},{c:["91","c-1b30","(null)","(null)","(null)"]}]},{name:"messages (conversation c-1b30)",cols:["conversation_id","seq","message_id","sender_id"],rows:[{c:["c-1b30","882","m-05","88"],hi:1,tag:"pushed envelope"}]}],queues:[{name:"chat-fanout",kind:"kafka",by:"consumer group fanout-workers",parts:[{id:"P130",key:"hash(c-1b30)",msgs:[{v:"fanout c-1b30 seq 882",hi:1,tag:"read @128"}],commit:129,end:129},{id:"P017",key:"hash(c-5aa0)",msgs:[{v:"fanout c-5aa0 seq 19"}],commit:64,end:65},{id:"P884",key:"other group keys",msgs:[{v:"fanout c-8ce2 seq 704"}],commit:311,end:312}]}]},narrate:"Each online recipient receives the same message envelope with <code>conversation_id</code> and <code>seq</code>. Queue redelivery is expected, so gateway/client delivery is idempotent by <code>message_id</code> and cursor.",details:[
        {k:"wire",label:"Group message frame",lang:"json",code:"{\n  \"op\": \"message.new\",\n  \"conversation_id\": \"c-1b30\",\n  \"seq\": 882,\n  \"message_id\": \"m-05\",\n  \"sender_id\": 88,\n  \"ciphertext\": \"0x6e0a...\"\n}"},
        {k:"query",label:"Per-recipient cursor advance",lang:"sql",code:"UPDATE user_inbox\nSET last_delivered_seq = 882,\n    updated_at = '2026-07-22 10:06:01'\nWHERE user_id = 42\n  AND conversation_id = 'c-1b30'\nIF last_delivered_seq < 882;"},
        {k:"queue",label:"How Kafka is consumed",lang:"python",code:"recs = consumer.poll()          # fanout-workers read P130 @128\n# push online recipients and write monotonic cursors\nconsumer.commit()               # commit offset 128 -> 129 only after success\n# crash before commit => offset 128 is read again"},
        {k:"queue",label:"At-least-once without duplicates",text:"Kafka can redeliver the same fan-out task, so correctness lives in idempotent side effects: the gateway/client dedupe by <code>message_id</code>, and <code>user_inbox.last_delivered_seq</code> only moves forward with <code>IF last_delivered_seq &lt; 882</code>."},
      ]},
      {node:"push",title:"Nudge offline or lazy members",snap:{cap:"Offline/lazy members keep their cursor behind and receive a collapsed wake-up. When user 91 opens the group, <code>seq &gt; cursor</code> will return the same durable row 882.",tables:[{name:"user_inbox",cols:["user_id","conversation_id","last_delivered_seq","last_read_seq","updated_at"],rows:[{c:["42","c-1b30","882","881","2026-07-22 10:06:01"]},{c:["91","c-1b30","(null)","(null)","(null)"],hi:1,tag:"cursor behind"},{c:["12","c-1b30","880","880","2026-07-22 09:40:00"]}]},{name:"messages (conversation c-1b30)",cols:["conversation_id","seq","message_id","client_msg_id"],rows:[{c:["c-1b30","882","m-05","c7d2-02"],hi:1,tag:"pull later"}]}]},narrate:"Offline members and fan-out-on-read group members get a collapsed notification, not one push per message. When they open the group, they run the same <code>seq &gt; cursor</code> pull against <code>messages</code>.",details:[
        {k:"wire",label:"Coalesced notification",lang:"json",code:"{\n  \"type\": \"group_new_messages\",\n  \"user_id\": 91,\n  \"conversation_id\": \"c-1b30\",\n  \"max_seq\": 882,\n  \"collapse_key\": \"c-1b30\"\n}"},
        {k:"gotcha",label:"Why this survives 100K members",text:"The sender path is one persist plus one enqueue. The expensive per-member work is asynchronous, coalesced, and for huge groups often replaced by pull-on-open, so a fan-out storm degrades to delayed delivery rather than failed sends."},
      ]},
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
      {l:"hard",tag:"concept",q:"Pick the actual datastore — Cassandra vs HBase vs DynamoDB.",turns:[
        {who:"intv",text:"You settled on wide-column in the abstract. Before you name a product, put numbers on the workload this store must survive — what write and read load is the datastore actually taking?"},
        {who:"cand",text:"It's a <strong>write-dominated</strong> workload. Writes are ~1.16M msg/s average and ~5M/s at peak, and every message is quorum-replicated 3x, so the store sees ~15M replica-writes/s at peak against ~20 TB/day of new history. Reads are lighter and shaped narrowly: the dominant read is 'open a chat, show the latest N' plus cursor-driven catch-up — a range over one conversation, never a scatter. Most messages are read once or twice and never again, so I optimise for cheap ordered writes and cheap single-conversation reads, not for ad-hoc query flexibility.<span class='eg'>peak 5M msg/s × 3 replicas ≈ 15M replica-writes/s; reads ≈ open-chat 'last 50 by seq' + delta-by-cursor, no cross-conversation joins.</span>"},
        {who:"intv",text:"Good. Now give me two or three concrete candidates with their per-node write ceiling — I want the node math, not just a brand name."},
        {who:"cand",text:"<strong>Cassandra</strong>: masterless LSM writes, a ballpark <strong>~10-30K writes/s/node</strong> sustained; <strong>ScyllaDB</strong> is the same data model shard-per-core in C++ and pushes <strong>~50K+/node</strong>. <strong>HBase</strong>: a region server sustains <strong>~10-20K writes/s</strong> before region hotspots and compaction stalls bite, on top of HDFS. <strong>DynamoDB</strong>: fully managed but capped per partition at <strong>~1K WCU (1 KB writes/s)</strong>, so hot conversations throttle unless the key spreads them. Doing the node math on the 15M replica-writes/s hot tier is what separates them.<span class='eg'>15M writes/s ÷ ~30K/node ≈ 500 Cassandra nodes; ÷ ~50K/node ≈ 300 Scylla nodes; DynamoDB ÷ 1K WCU/partition ≈ 15K+ hot partitions to stay under the cap.</span>"},
        {who:"intv",text:"How does your indexing make 'open a chat, load the latest 50' cheap — and what would adding a secondary index cost you?"},
        {who:"cand",text:"The primary key does the work: <strong>partition key = conversation_id, clustering key = seq</strong> (descending). Every message in a conversation is co-located on one partition and stored already sorted by seq, so 'latest 50' is a <strong>single-partition scan</strong> — one node, one seek, read 50 contiguous rows, no merge and no scatter-gather. Catch-up is the same primitive with a <code>seq &gt; cursor</code> bound. A <strong>secondary index</strong> is expensive here: a global index (say by sender_id) is a second physical table that every write must also update — write amplification — and its reads fan out across partitions, exactly the scatter I designed away. So I keep dedupe scoped to the partition (client_msg_id within the conversation) and add <em>no</em> global secondary index on the hot path.<span class='eg'>(conversation_id) / (seq desc) → open chat = 1 partition, 50 sequential rows; a global-by-sender index = 2x writes + N-node scatter read.</span>"},
        {who:"intv",text:"So commit — which one, and why not the other two?"},
        {who:"cand",text:"<strong>Decision: masterless wide-column, ScyllaDB (or Cassandra).</strong> The workload is write-heavy with strictly per-conversation-ordered reads and needs no consistency beyond a single partition, which is exactly masterless LSM's sweet spot — tunable quorum buys me the durability and sub-second latency together, and no write-primary means no failover SPOF. <strong>Not HBase</strong>: strong global consistency I don't need, plus HDFS and region-server ops are heavy and region hotspots punish skewed broadcast conversations. <strong>Not DynamoDB</strong>: the ~1K WCU/partition cap throttles hot conversations and cost climbs steeply at 15M writes/s — I'd reach for it only if managed failover mattered more than that bill. Scylla's per-node ceiling also keeps the node count near ~300 rather than ~500, which is real money at this scale.<span class='eg'>chosen: partition=conversation_id, cluster=seq, RF=3, quorum W=2 — ~300 Scylla nodes for the hot write tier vs ~500 on Cassandra.</span>"},
      ],resources:[
        {title:"How Discord stores billions of messages",url:"https://discord.com/blog/how-discord-stores-billions-of-messages"},
        {title:"ScyllaDB vs Cassandra benchmarks",url:"https://www.scylladb.com/product/benchmarks/"},
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
  },
  mockTest:[
    {q:"Why hold persistent WebSockets for 500M clients instead of HTTP polling, and what binds a gateway node's capacity?",a:"A new message is server-initiated, so the server must push it — polling can't, and 500M clients polling every 2s is ~250M req/s of mostly-empty responses plus seconds of latency. A WebSocket is one upgraded TCP connection kept open for bidirectional push. A gateway node is bound by memory and file-descriptor density (a few to tens of KB per idle socket), not CPU, so it holds ~500K-1M sockets and you scale the tier by socket count."},
    {q:"How does a message for user B reach the exact gateway node holding B's socket?",a:"An indirection layer: on connect each gateway writes userId to {nodeId, connId} into a connection registry (sharded Redis with TTL). The chat service looks B up, forwards to that node over an internal channel, and the node pushes down B's socket. If the entry is stale (node crashed), the forward fails and B is treated as offline — the message is already durable, so it falls through to cursor-pull plus push, and delivered only fires on a real device ack."},
    {q:"How do you guarantee correct per-conversation ordering with no duplicates under retries and out-of-order arrival?",a:"Two mechanisms. Ordering: the server assigns a per-conversation monotonic seq on accept and every client renders strictly by seq, so physical arrival order is irrelevant. Idempotency: the client-generated client_msg_id is the dedupe key — a retry maps to the existing seq and never creates a second row. The seq counter is scoped per conversation (partition-by-conversation-id), so contention is tiny and there is no global counter."},
    {q:"Size the WebSocket gateway tier for ~500M concurrent connections and name the binding resource.",a:"An idle socket costs a file descriptor, send/receive buffers, and a little per-connection state — call it ~10 KB, near-zero CPU. At ~500K sockets/node, 500M ÷ 500K ≈ 1000 nodes (or ~500 at 1M/node). The binding resource is memory and fd density, so you tune kernel fd limits and buffer sizes and size by socket count. Denser nodes cut cost but raise blast radius, so ~500K-1M/node balances the two."},
    {q:"Which datastore backs the message history, and what is the deciding factor?",a:"Masterless wide-column — ScyllaDB or Cassandra — with partition key conversation_id and clustering key seq. The workload is write-heavy (~5M msg/s peak, ~15M replica-writes/s at RF=3) with strictly per-conversation-ordered reads and no cross-conversation transaction, which fits masterless LSM exactly. HBase adds unneeded strong consistency plus heavy HDFS ops; DynamoDB's ~1K WCU/partition cap throttles hot conversations and costs more at this volume. Scylla holds ~50K writes/s/node (~300 nodes) vs Cassandra ~30K (~500)."},
    {q:"A message goes to a 100K-member group. How do you fan it out without blocking the sender?",a:"Persist once (one row, one seq), ack the sender immediately, then enqueue a single fan-out task. Workers do the per-recipient deliveries asynchronously — online members get a gateway push, offline members are marked for cursor-pull plus a push. Above a size threshold, flip huge groups to fan-out-on-read: write once and let members pull by cursor with a coalesced nudge. Small active groups stay fan-out-on-write, so it's a hybrid keyed on group size and activity."},
    {q:"B was offline for a day on three devices. How does each device sync exactly what it missed, in order and dupe-free?",a:"A per-device last-delivered cursor (highest acked seq per conversation). On reconnect each device fetches messages with seq &gt; cursor in seq order, then advances its cursor; since seq is monotonic per conversation this is exact and dupe-free, and the three devices keep independent cursors. To avoid scanning millions of conversations, a per-user dirty-conversations index (updated on each inbox write) limits sync to conversations that changed while the device was away."},
    {q:"With end-to-end encryption, what survives and what breaks server-side?",a:"Clients hold the keys; the server stores and routes only ciphertext plus routing metadata (senderId, conversationId, seq, timestamps). Everything structural survives — persist-then-deliver, seq ordering, client_msg_id dedupe, cursors, offline pull, fan-out all operate on an opaque blob. What breaks is anything reading content: server-side search moves client-side, spam/abuse detection leans on metadata and user reports, and push previews are gone. Durability and ordering are untouched; you add key management (encrypted, user-controlled key backup) as a new concern."},
  ]
};


/* ---- scaling journey ---- */
(function(){
var d = window.DATA["chat"];
var scaling = {id:"scaling",name:"From one socket path to global delivery",kind:"scale",
  live:["client","gw","chat","store"],
  summary:"Start with one durable 1:1 send path, then let connection count, offline delivery, group fan-out, and device wakeups force presence, a durable queue, and push notifications.",
  steps:[
    {node:"store",stage:"Stage 0 · Baseline",title:"Persist a 1:1 message, then push if the recipient is local",
      live:["client","gw","chat","store"],
      edges:[["chat","store","persist before ack"]],
      narrate:"The MVP accepts a WebSocket frame, dedupes by client message id, assigns a per-conversation sequence number, writes the message to durable history, then tries to push over the recipient socket if this gateway happens to hold it. Durability comes before delivery.",
      details:[
        {k:"win",label:"Why start here",text:"It preserves the most important promise: once the sender sees an ack, the ciphertext is in the store and can be recovered by every device. A dropped live push can be retried; a lost stored message cannot."},
        {k:"query",label:"Baseline write",code:"-- partition = conversation_id, clustering = seq\nINSERT INTO messages\n  (conversation_id, seq, message_id, client_msg_id, sender_id, ciphertext)\nVALUES\n  ('c-9f2a', 4472, 'm-04', 'b3f1-bc', 42, 0xa5d91c);\n-- ack sender only after quorum persistence"},
        {k:"scale",label:"Working numbers",text:"The target workload is **~1.16M messages/s average** and **~5M/s peak**, with **~500M concurrent sockets**. A one-node socket assumption will fail before the storage model does."}
      ],
      snap:{title:"Load & capacity — Stage 0",cap:"The send path is correct for one gateway locality; global routing is the looming gap.",tables:[{name:"signals",cols:["signal","value","verdict"],rows:[
        {c:["Peak sends","~5M /s","store must shard"]},
        {c:["Concurrent sockets","~500M","cannot be one gateway"],hi:1,tag:"risk"},
        {c:["Delivery rule","recipient on same node only","not enough"]},
        {c:["Ordering","per-conversation seq","correct base"]}
      ]}]}},
    {node:"presence",stage:"Stage 1 · Presence registry",title:"Recipients live on different gateways &rarr; record user to gateway",
      live:["client","gw","chat","store","presence"],
      edges:[["gw","presence","heartbeat"],["chat","presence","route lookup"]],
      narrate:"At real scale, connections are spread across hundreds or thousands of gateway nodes. The sender's gateway almost never holds the recipient's socket, so delivery needs a fast routing hint from user id to gateway node.",
      details:[
        {k:"scale",label:"The number that forces it",text:"With **~500M live connections** and **~500K−1M sockets per node**, the fleet is hundreds of gateway nodes. A message for B must find the one node holding B's current socket."},
        {k:"pain",label:"What breaks without it",text:"The chat service either broadcasts delivery attempts to gateways or treats online users as offline. Broadcast is impossible at this connection count, and false-offline delivery ruins realtime feel."},
        {k:"fix",label:"The fix — soft presence registry",text:"Gateways refresh `presence:userId` with gateway node and connection id in a sharded Redis-style registry. Chat looks it up, forwards to that node, and falls back to offline flow if the entry is stale.",pill:"routing hint"},
        {k:"gotcha",label:"Presence is not truth",text:"A registry entry can be stale after a gateway crash. Delivered receipts require a real device ack; otherwise the store plus cursor remains authoritative."}
      ],
      snap:{title:"Load & capacity — Stage 1",cap:"Routing is now a lookup, not a broadcast, and stale entries are safe.",tables:[{name:"signals",cols:["signal","before","after"],rows:[
        {c:["Find recipient socket","local guess or broadcast","presence lookup"],hi:1,tag:"fixed"},
        {c:["Gateway fleet","500−1000 nodes","explicit node id"]},
        {c:["Raw heartbeats","~17M /s naive","batched by gateway"]},
        {c:["Stale route","delivery timeout","offline fallback"]}
      ]}]}},
    {node:"queue",stage:"Stage 2 · Durable delivery queue",title:"Offline and group delivery need buffering &rarr; enqueue ordered tasks",
      live:["client","gw","chat","store","presence","queue"],
      edges:[["chat","queue","delivery task"]],
      narrate:"Presence solves online routing, but delivery is still not a single RPC. Recipients disconnect, devices reconnect by cursor, and groups can turn one accepted message into many delivery tasks. The accept path must stay one persist plus one enqueue.",
      details:[
        {k:"scale",label:"The number that forces it",text:"Peak accept is **~5M messages/s**, while group delivery can lift effective queue traffic toward **~10−20M events/s**. A durable log with thousands of partitions absorbs bursts and retries."},
        {k:"pain",label:"What breaks without it",text:"Without a queue, chat workers block on offline users, slow gateways, and group fan-out. A worker crash loses in-memory delivery state or duplicates pushes with no replay boundary."},
        {k:"fix",label:"The fix — partitioned durable log",text:"After persistence, chat enqueues delivery and fan-out tasks partitioned by conversation id. Consumers deliver at least once, advance cursors on ack, and rely on message id plus seq for idempotency and order.",pill:"buffer"},
        {k:"key",label:"Ordering lives in seq",text:"The queue preserves common-case per-conversation order, but the server-assigned sequence number is the display truth. Hot conversations can be bucketed without scrambling clients because clients sort by seq."}
      ],
      snap:{title:"Load & capacity — Stage 2",cap:"Accept stays fast while delivery becomes retryable, buffered, and independently scalable.",tables:[{name:"signals",cols:["signal","value","verdict"],rows:[
        {c:["Accept path","1 store write + 1 enqueue","bounded"],hi:1,tag:"fixed"},
        {c:["Queue throughput","~10−20M events/s peak","partitioned log"]},
        {c:["Partitions","~400 floor, ~2000 provisioned","headroom"]},
        {c:["Delivery semantics","at least once + dedupe","safe redelivery"]}
      ]}]}},
    {node:"push",stage:"Stage 3 · Push notifications",title:"Offline devices need a wakeup &rarr; send APNs and FCM alerts",
      live:["client","gw","chat","store","presence","queue","push"],
      edges:[["queue","push","offline alert"],["chat","push","notify"]],
      narrate:"A stored message is durable, and the queue can remember delivery work, but an offline phone will not pull until the app wakes. Push is the out-of-band nudge that tells the device to reconnect and fetch by cursor.",
      details:[
        {k:"scale",label:"The number that forces it",text:"A morning recovery can create **~2M push events/s** before coalescing. The push tier must meter provider calls and collapse bursts, not spray one notification per message."},
        {k:"pain",label:"What breaks without it",text:"Offline users receive messages only when they manually open the app. If push is mixed into the send path, APNs or FCM throttling can slow message acceptance for everyone."},
        {k:"fix",label:"The fix — best-effort wakeups",text:"A notification service consumes offline tasks, coalesces per device and conversation, calls APNs or FCM at the provider-accepted rate, and lets the app pull real messages from the store.",pill:"wake up"},
        {k:"gotcha",label:"Push is not delivery",text:"Under E2EE the payload is generic and may be dropped or delayed. The authoritative message is already in the store; push only improves timeliness."}
      ],
      snap:{title:"Load & capacity — Stage 3",cap:"The full design separates acceptance, durable delivery, realtime routing, and offline wakeups.",tables:[{name:"signals",cols:["concern","mechanism","result"],rows:[
        {c:["Offline wakeup","APNs or FCM","device reconnects"]},
        {c:["Morning burst","2M /s raw","~200K /s after coalescing"],hi:1,tag:"fixed"},
        {c:["Provider outage","durable retry queue","messages safe"]},
        {c:["E2EE payload","generic alert","content stays on clients"]}
      ]}]}}
  ]};
d.deepFlows = [scaling].concat(d.deepFlows);
})();
