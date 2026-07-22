window.DATA = window.DATA || {};
window.DATA['gdocs'] = {
  cat:"concurrency · OT · CRDT",
  title:"Design a collaborative document editor (Google Docs)",
  blurb:"Many users edit one document at once in real time, with correct conflict resolution, live cursors, and offline support.",
  prompt:"Let's design a collaborative document editor like Google Docs. Many people open the same document and type into it simultaneously; everyone must see a consistent result in near real time, cursors and selections show live, and a user who goes offline can keep editing and sync later. Start with the high-level architecture and rough numbers, then we'll drill into components — and I'll throw failure scenarios at you.",
  opening:"Let me frame it before drawing boxes.<br><br><strong>Functional:</strong> multiple users edit one document concurrently, changes propagate live to all editors, live cursors/selections, offline editing with later sync, undo/redo, and sharing/access control. <strong>Non-functional:</strong> edits land on collaborators' screens in < 200ms (it has to feel real-time), <strong>convergence</strong> — every editor ends at the identical document regardless of order — and durability: once the editor shows an edit as saved, we never lose it.<br><br><strong>Back-of-envelope:</strong> ~50M daily active docs; most have 1-3 editors but hot docs hit <strong>hundreds of concurrent editors</strong>. A typing user emits ~2-5 small ops/s, so a 500-editor doc is ~1-2.5K ops/s of tiny operations, plus a higher-churn stream of cursor movements. Ops are small (a char + position); the durable log and snapshots are what grow.<br><br>I'll start deliberately minimal: <strong>client editor → WS gateway → collab service → document store</strong>. The client holds a local copy and sends ops over a persistent connection; the gateway owns the socket; one collab service owns the live session for a doc and broadcasts; the document store is the durable op log. As conflict, scale and failure pressure mount I'll grow it — a conflict-resolution engine, presence, snapshots/persistence. Pick a box and let's push on it.",
  nodes:[
    {id:"client",name:"Client",sub:"editor",x:40,y:150},
    {id:"gw",name:"WS gateway",sub:"persistent conns",x:210,y:150},
    {id:"collab",name:"Collab service",sub:"session + broadcast",x:380,y:150},
    {id:"doc",name:"Document store",sub:"op log + snapshots",x:550,y:150},
    {id:"engine",name:"OT / CRDT engine",sub:"conflict resolution",x:380,y:40},
    {id:"presence",name:"Presence / cursors",sub:"live state",x:210,y:40},
    {id:"persist",name:"Persistence",sub:"snapshot + durability",x:550,y:40},
  ],
  edges:[["client","gw"],["gw","collab"],["collab","doc"],["collab","engine"],["gw","presence"],["doc","persist"]],
  core:["client","gw","collab","doc"],
  basic:["client","gw","collab","doc"],
  schema:{tables:[
    {name:"documents",pk:"doc_id",columns:[
      ["doc_id","uuid","document id, primary key"],
      ["owner_id","bigint","user who created the doc"],
      ["title","text","document title"],
      ["current_version","bigint","latest committed op seq"],
      ["created_at","timestamptz","creation time"],
    ],rows:[
      ["d-1a2b","42","Q3 Planning Notes","10432","2026-07-20 09:00:00"],
      ["d-9f7c","7","Untitled document","0","2026-07-22 11:05:00"],
      ["d-3c4d","42","Launch Checklist","288","2026-07-21 14:30:00"],
    ]},
    {name:"operations",pk:"doc_id + seq",columns:[
      ["doc_id","uuid","which document (part of key)"],
      ["seq","bigint","position in the doc total order"],
      ["author_id","bigint","user who authored the op"],
      ["op_json","jsonb","the operation, e.g. insert/delete"],
      ["created_at","timestamptz","when the op was appended"],
    ],rows:[
      ["d-1a2b","10431","42","{op:insert, pos:120, char:h}","2026-07-22 10:15:03"],
      ["d-1a2b","10432","7","{op:delete, pos:88}","2026-07-22 10:15:03"],
      ["d-3c4d","288","42","{op:insert, pos:12, char:X}","2026-07-21 14:30:11"],
    ]},
    {name:"snapshots",pk:"doc_id + version",columns:[
      ["doc_id","uuid","which document (part of key)"],
      ["version","bigint","op seq this snapshot folds up to"],
      ["content_blob_url","text","object-storage URL of folded content"],
      ["created_at","timestamptz","when the snapshot was written"],
    ],rows:[
      ["d-1a2b","10000","s3://docs/d-1a2b/v10000.blob","2026-07-22 10:00:00"],
      ["d-3c4d","250","s3://docs/d-3c4d/v250.blob","2026-07-21 14:00:00"],
    ]},
    {name:"acl",pk:"doc_id + user_id",columns:[
      ["doc_id","uuid","which document (part of key)"],
      ["user_id","bigint","the collaborator"],
      ["role","varchar(6)","viewer or editor"],
    ],rows:[
      ["d-1a2b","42","editor"],
      ["d-1a2b","7","editor"],
      ["d-1a2b","55","viewer"],
    ]},
  ]},
  flows:[
    {id:"edit",name:"Apply a concurrent edit (OT/CRDT)",steps:[
      {node:"client",text:"Client applies the keystroke to its local replica instantly and ships <code>insert(char, pos, baseVersion)</code> over the persistent socket."},
      {node:"gw",text:"WS gateway routes the op up to the collab session that owns this doc."},
      {node:"collab",text:"Collab session assigns the op the next position in the doc total order."},
      {node:"engine",requires:["engine"],text:"Engine transforms (OT) or merges (CRDT) the op against the concurrent ops ordered before it so every client converges."},
      {node:"doc",text:"Appends the transformed op to the append-only op-log (source of truth)."},
      {node:"persist",requires:["persist"],text:"A background job periodically folds the log into a snapshot flushed to durable object storage."},
      {node:"collab",text:"Acks the sender only after durable append, then broadcasts the ordered op to the other editors."},
      {node:"presence",requires:["presence"],text:"Cursor and selection moves ride a separate throttled path, broadcast live to collaborators without touching the op-log."},
    ]},
    {id:"open",name:"Open / load a document",steps:[
      {node:"client",text:"Client opens the doc and requests its current state over a new WebSocket."},
      {node:"gw",text:"Gateway authenticates the connection and routes it to the doc owner collab session."},
      {node:"collab",text:"Session verifies the user role against the ACL, then serves the load."},
      {node:"doc",text:"Reads the latest snapshot plus the small tail of ops after it."},
      {node:"persist",requires:["persist"],text:"Fetches the snapshot blob from durable object storage for a cold-open doc."},
      {node:"engine",requires:["engine"],text:"Folds the op tail onto the snapshot to reconstruct the current document version."},
      {node:"presence",requires:["presence"],text:"Sends the client the live cursors and the set of collaborators currently editing."},
      {node:"client",text:"Renders the materialized document and starts streaming subsequent ops."},
    ]},
  ],
  requirements:{
    functional:[
      "Multiple users edit one document concurrently, with changes propagating live to every editor",
      "Show live cursors, selections, and who is currently editing",
      "Persist the document durably with version history, and let a user edit offline and sync on reconnect",
    ],
    nonFunctional:[
      "Convergence — every editor ends at the identical document regardless of the order ops arrive",
      "Edits land on collaborators' screens in &lt; 200ms so it feels real-time",
      "Durability — once an edit shows as saved, it is never lost",
      "Scale to hundreds of concurrent editors on a hot doc, across ~50M daily active docs",
    ],
  },
  reqBuild:[
    {req:"Multiple users edit the same doc concurrently (adds the conflict engine)",reveal:["engine"],turns:[
      {who:"intv",text:"Start with requirement one: two people open the same document and type at the same time. What's the minimal path that gets both edits onto everyone's screen?"},
      {who:"cand",text:"The <strong>client</strong> holds a local replica and applies my keystroke instantly, turning it into a small <strong>operation</strong> — <code>insert(char, position, baseVersion)</code> — that it ships over a persistent connection to the <strong>WS gateway</strong>, up to the <strong>collab service</strong> that owns the doc's live session, which assigns it an order, appends it to the <strong>document store</strong>, and broadcasts it to the other editors. My four core boxes cover the happy path. The catch is that applying ops as-written races: positions go stale the moment someone else edits."},
      {who:"intv",text:"Right — so if A and B both insert at the same position based on the same version, do they end up with the same document?"},
      {who:"cand",text:"Not with raw positions — they diverge, which is the classic corruption. So the collab service can't just apply ops in arrival order; each op has to be reconciled against the concurrent ops it didn't know about. That reconciliation is a distinct, correctness-critical job, so let me add a dedicated <strong>OT / CRDT engine</strong>: the collab service hands it each op to <em>transform</em> (OT) or <em>merge</em> (CRDT) against what was ordered before it, guaranteeing every client converges to the same result. That satisfies requirement one; I'll keep it minimal and harden it later."},
    ],resources:[
      {title:"Operational transformation",url:"https://en.wikipedia.org/wiki/Operational_transformation"},
      {title:"Figma: how multiplayer works",url:"https://www.figma.com/blog/how-figmas-multiplayer-technology-works/"},
    ]},
    {req:"Show live cursors and who is editing (adds presence)",reveal:["presence"],turns:[
      {who:"intv",text:"Requirement two: everyone should see each collaborator's cursor, selection, and name flag moving live. Does that ride the same path as edits?"},
      {who:"cand",text:"I'd give it a separate path — let me add a <strong>presence</strong> component. Cursor position, selection, and name/color are <strong>ephemeral live state</strong>: extremely high-churn, tiny, self-correcting, and — crucially — <strong>not durable</strong>. If I drop a cursor update, the next one fixes it a few ms later. So presence rides the same WebSocket through the gateway but branches to a presence service rather than flowing through the op log and the conflict engine."},
      {who:"intv",text:"Why not just push cursors through the same op stream as edits, and save yourself a component?"},
      {who:"cand",text:"Because it would pollute the durable, ordered edit log with millions of throwaway updates that must never be persisted, replayed, or conflict-resolved. Cursors need <em>freshness</em>, not total ordering or durability. Mixing them would bloat the log, slow snapshots and replay, and waste the engine on data that has no conflicts. Keeping presence separate lets me throttle and drop it aggressively without ever touching the correctness path for edits — different guarantees, different pipe."},
    ],resources:[
      {title:"Figma: how multiplayer works",url:"https://www.figma.com/blog/how-figmas-multiplayer-technology-works/"},
      {title:"CRDT resources",url:"https://crdt.tech/"},
    ]},
    {req:"Persist the doc durably with history and offline sync (adds persistence)",reveal:["persist"],turns:[
      {who:"intv",text:"Requirement three: the document must survive crashes, offer version history, and let a user who went offline keep editing and sync later. What do you add to the store side?"},
      {who:"cand",text:"The document store is an <strong>append-only op log</strong> per doc — the source of truth, since the document at any version is just the fold of its ops — plus periodic <strong>snapshots</strong> so I don't replay from zero. For true durability across a node or whole-AZ loss I need a dedicated <strong>persistence</strong> layer, so let me add it: the log is replicated with quorum writes, and snapshots plus sealed old segments are flushed to durable object storage. Offline sync falls straight out of the log — the client queues its ops while disconnected and replays them through the engine on reconnect."},
      {who:"intv",text:"Why keep the whole op log at all — why not just store the current document text and overwrite it?"},
      {who:"cand",text:"Because the log is what makes everything else work: real-time convergence (clients sync by seq range), offline replay, undo/redo, version history, and audit. Overwriting current-state-only throws all that away and reintroduces last-writer-wins clobbering — the exact corruption requirement one forbids. The op log is cheap (tiny ops, sequential writes); its only cost is unbounded growth and replay time, which is precisely what snapshots and compaction handle in the deep dives. That covers all three requirements — now I'd move to hardening it under scale and failure."},
    ],resources:[
      {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      {title:"ByteByteGo",url:"https://bytebytego.com/"},
    ]},
  ],
  systemDives:[
    {title:"The authoritative process for a hot doc crashes",tag:"failover",turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a single collab process is the sole authoritative owner of a hot doc with <b>500</b> live editors. It gets OOM-killed having accepted and broadcast ~<b>3,000</b> ops in its final 2 seconds. Do those edits survive, and what do the 500 users see?</span>"},
      {who:"cand",text:"Whether anything is lost hinges on one rule: <strong>an op is only acked and broadcast after it's durably appended to the log</strong>. If I enforce that, everything the 500 users saw as applied was already persisted — the crash loses nothing committed. Ops that were mid-flight (received but not yet logged) were never acked, so their clients still hold them as <strong>unacknowledged</strong> and re-send. The 500 sockets drop, clients reconnect through the gateway, a <strong>new owner is elected</strong> for that doc, it rehydrates from the latest snapshot plus op-log tail and resumes. Users see a ~1-3s stall, then resync."},
      {who:"intv",text:"Electing a new owner sounds racy — what stops two processes both believing they own the doc?"},
      {who:"cand",text:"Ownership is granted through a <strong>lease / consensus with a fencing epoch</strong>: exactly one process holds a valid lease for a doc at a time, placed via consistent hashing over doc id. When a new owner takes over it writes under a higher epoch; if the old process comes back thinking it's still owner, its writes are <strong>rejected by the higher epoch</strong> and it steps down. That's what prevents <em>split-brain</em> — two divergent op logs for one doc that can't be cleanly merged."},
      {who:"intv",text:"You said broadcast only after durable append. Doesn't a durable write on every op add latency for all 500 people?"},
      {who:"cand",text:"A few ms, and I accept it — durability is the whole point of a document. But I keep it cheap: the store is an <strong>append-only log</strong> (sequential writes), and I <strong>batch/pipeline</strong> appends so one quorum round-trip commits dozens of the concurrent ops on a hot doc. Clients already applied their own op locally, so the ack latency never affects <em>their</em> typing feel — only how fast <em>others</em> see it, which stays well under 200ms. Broadcast-then-persist would let a crash show users edits that then vanish on recovery, which is unacceptable — durable-first is the correct ordering."},
    ],resources:[
      {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      {title:"ByteByteGo",url:"https://bytebytego.com/"},
    ]},
    {title:"Two users edit offline for an hour, then reconnect",tag:"durability",turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a user loses wifi on a train and keeps typing for <b>60 minutes</b>, accumulating ~<b>4,000</b> local ops. Meanwhile 3 other editors made ~<b>10,000</b> ops to the same regions. The train arrives and the client reconnects. What happens, and how do you guarantee no lost work?</span>"},
      {who:"cand",text:"Offline is a first-class requirement, so this is a non-event. While offline the client kept applying ops to its <strong>local replica</strong> and queued all 4,000 as <strong>unacknowledged ops</strong>, each tagged with the base version it was made against. On reconnect it does a <strong>catch-up</strong>: fetches everything the server saw since that base version, then <strong>replays its queued ops through the engine</strong>, each one transformed (or merged, if CRDT) against the concurrent remote ops so it lands in the right place rather than at a now-stale position. Nothing is dropped."},
      {who:"intv",text:"Transforming 4,000 ops against 10,000 remote ops sounds expensive and error-prone. Isn't that fragile?"},
      {who:"cand",text:"It's the heaviest case, so I bound it. The client sends its queue in order and the server transforms <strong>incrementally</strong>, not all-pairs. If the divergence is huge I fall back to <strong>rebasing onto a recent snapshot</strong> plus the op delta instead of replaying from a very old base. Correctness comes from the engine's transform/merge being <em>associative and convergent</em>. And if a region genuinely can't be auto-reconciled, the user's content is preserved as a suggestion rather than silently dropped — losing an hour of writing is the cardinal sin."},
      {who:"intv",text:"What actually guarantees the offline user and the online users all end at the identical document?"},
      {who:"cand",text:"The <strong>single authoritative total order per doc</strong> plus convergent transforms. The offline user's ops fold into the same global sequence every other client already has, so once reconciled everyone holds the same document. Durability closes the loop: their work lived in the local replica and unacked queue, and on reconnect it's committed to the <strong>quorum-replicated log</strong> before being acked — so from that point it can never be lost. A long offline period degrades to 'catch up on reconnect,' never to corruption or loss."},
    ],resources:[
      {title:"Automerge (offline-first CRDT)",url:"https://automerge.org/"},
      {title:"CRDT resources",url:"https://crdt.tech/"},
    ]},
    {title:"The op log grows unbounded — replay takes minutes",tag:"scaling",turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a long-lived doc has accumulated <b>50M</b> ops over two years. Recovery, version history, and open all touch the log, and full replays now take minutes. Storage per hot doc is ballooning. Fix the growth and the replay cost.</span>"},
      {who:"cand",text:"Replay cost is already bounded by <strong>snapshots</strong> — nothing reads from op 0; recovery and open read the latest snapshot plus the tail after it. For the log itself I <strong>compact</strong>: once a snapshot at seq S is durable in persistence, log segments before S aren't needed for current operation, so I archive them to cold object storage and truncate the hot log. The live store then holds only a recent window of ops, staying small regardless of the doc's age."},
      {who:"intv",text:"But you promised version history — 'restore to last Tuesday.' If you compacted those ops away, is history gone?"},
      {who:"cand",text:"No — compaction <strong>archives</strong>, it doesn't delete. Old segments and periodic snapshots live in cold object storage, so 'restore to last Tuesday' loads the nearest older snapshot plus the archived op delta — slower cold path, but fully available. I also <strong>coarsen retention</strong>: keep fine-grained ops for recent edits, then thin older history to periodic snapshots (hourly, then daily), so I'm not storing every keystroke from two years ago forever."},
      {who:"intv",text:"How often do you snapshot, given the tension between recovery speed and write overhead?"},
      {who:"cand",text:"A rolling policy — <strong>every N ops or T seconds, whichever first</strong> (say every 1,000 ops or 60s on an active doc), plus a snapshot when a doc goes idle so cold-open is cheap. Snapshotting runs as a <strong>background job</strong> off the hot path: it folds the log to a seq, writes the snapshot to persistence, and only then are older segments compacted. Frequent enough that the replay tail stays tiny, infrequent enough that it's a background cost, not per-op. The log stays the source of truth; snapshots are just a cache of folded state to bound recovery and open."},
    ],resources:[
      {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      {title:"ByteByteGo",url:"https://bytebytego.com/"},
    ]},
    {title:"Scale to many concurrent editors across many docs",tag:"scaling",turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> you have <b>50M</b> active docs and you've claimed each doc has a single authoritative owner process. At ~<b>10K</b> live sessions per collab node, how do you place and scale owners without a central bottleneck?</span>"},
      {who:"cand",text:"I <strong>shard docs across the collab fleet</strong>: <code>owner(docId)</code> maps each doc to exactly one live process, via <strong>consistent hashing</strong> on doc id (or a placement service). 50M docs at ~10K sessions per node is a few thousand nodes, and each doc still has a single owner — I get the simple-ordering benefit <em>per doc</em> while scaling horizontally across docs. There's no global bottleneck because the sequencer is per-doc, not global, and idle docs hold no live session at all — I'm sized by <em>concurrent</em> sessions, not total docs."},
      {who:"intv",text:"Consistent hashing spreads docs evenly, but a single doc with 500 editors is still one owner. What if one doc is too hot for one process?"},
      {who:"cand",text:"For text editing one process comfortably handles a 500-editor doc — it's ~1-2.5K tiny ops/s and the fan-out is offloaded, so the owner's real work is just transform + append + publish, which fits one core. If a doc were ever pathologically hot I'd <strong>split it into independently-owned sub-sections</strong> (per page/section), each with its own sequencer, since edits rarely span sections — but only when measurements demand it. The key win is that ordering stays per-doc, so hot docs never contend with each other."},
      {who:"intv",text:"An op on that 500-editor doc must reach 499 sockets spread across many gateway nodes. How does that fan-out not crush the owner?"},
      {who:"cand",text:"The owner publishes each accepted op <strong>once</strong> to a <strong>pub/sub layer keyed by doc</strong>, and every gateway node subscribed to that doc pushes to its local subset of that doc's sockets. So fan-out becomes 'publish once, gateways deliver locally' instead of the collab process holding 500 sockets itself. I shard pub/sub <strong>by doc id</strong> so a hot doc's traffic lands on one partition without disturbing others, and co-locate the doc's session with its partition to cut hops. Only tiny, rate-limited edit ops flow through it — the heavy cursor churn is on the presence path, which I can shard and drop under load."},
    ],resources:[
      {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      {title:"ByteByteGo",url:"https://bytebytego.com/"},
    ]},
  ],
  q:{
    client:[
      {l:"easy",tag:"concept",q:"What actually runs on the client editor?",turns:[
        {who:"intv",text:"You said the client holds a local copy. Be precise — when I press a key in the browser, what does the client do before, during, and after the server hears about it?"},
        {who:"cand",text:"The client is not a dumb terminal — it owns a <strong>local replica</strong> of the document and applies my keystroke <em>immediately</em> to that replica, so typing feels instant with zero round-trip. In parallel it turns the keystroke into a small <strong>operation</strong> — e.g. <code>insert(char, position, baseVersion)</code> — and ships it over the persistent connection. It keeps a queue of <strong>unacknowledged local ops</strong> and the last server version it has seen, so it can reconcile when the server's view comes back."},
        {who:"intv",text:"Why apply locally before the server confirms? What breaks if you waited?"},
        {who:"cand",text:"If I waited for a round-trip per character, every keystroke would show ~100-200ms late — unusable. So local-first is non-negotiable. The cost is that my local replica is momentarily <em>ahead</em> of the server and may need adjusting when other people's ops arrive interleaved with mine. That reconciliation is exactly the job of the conflict-resolution engine we'll get to: the client optimistically applies, then transforms/merges when the authoritative stream comes back so everyone converges."},
      ],resources:[
        {title:"Figma: how multiplayer works",url:"https://www.figma.com/blog/how-figmas-multiplayer-technology-works/"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"medium",tag:"failover",q:"A user edits offline for an hour, then reconnects.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a user opens a doc, loses wifi on a train, and keeps typing for <b>60 minutes</b> — accumulating ~4,000 local ops. Meanwhile 3 other editors made ~10,000 ops to the same regions of the doc. The train arrives, the client reconnects. What happens?</span>"},
        {who:"cand",text:"The whole design has to make this a non-event, because offline is a first-class requirement. While offline the client just kept applying ops to its local replica and queuing all 4,000 <strong>unacknowledged ops</strong> tagged with the <em>base version</em> they were made against. On reconnect it does a <strong>catch-up</strong>: it fetches everything the server saw since that base version, then <strong>replays its queued ops through the conflict engine</strong> — each local op is transformed against the concurrent remote ops (or merged, if CRDT) so it lands in the right place rather than at a now-stale position."},
        {who:"intv",text:"An hour of divergence is a lot. Isn't transforming 4,000 ops against 10,000 remote ops expensive and error-prone?"},
        {who:"cand",text:"It's the heaviest case, yes, so I bound it. First, the client sends its queue in order and the server transforms incrementally, not all-pairs. Second, if the divergence is huge I can fall back to <strong>rebasing onto a recent snapshot</strong> plus the op delta rather than replaying from a very old base. The correctness guarantee comes from the engine's transform/merge being <em>associative and convergent</em> — that's what guarantees the offline user and the online users all end at the same document. If a region genuinely can't be auto-reconciled the user sees their content preserved as a suggestion rather than silently dropped — losing an hour of writing is the cardinal sin here."},
      ],resources:[
        {title:"Automerge (offline-first CRDT)",url:"https://automerge.org/"},
        {title:"CRDT resources",url:"https://crdt.tech/"},
      ]},
      {l:"medium",tag:"concept",q:"Undo/redo when others are editing too.",turns:[
        {who:"intv",text:"I type a sentence, my colleague types elsewhere, then I hit <strong>Ctrl-Z</strong>. What should undo do — and give me a concrete case where the naive answer is wrong."},
        {who:"cand",text:"Undo must be <strong>local/selective</strong>: it should revert <em>my</em> last change, not my colleague's.<span class='eg'>Doc is 'HELLO'. I insert ' WORLD' (now 'HELLO WORLD'); my colleague changes 'HELLO' to 'HELLO!' concurrently. If Ctrl-Z is a global 'go back one state' it would also wipe their '!' — clearly wrong.</span>So undo can't be a naive stack pop of the shared document state."},
        {who:"intv",text:"So how do you implement selective undo correctly?"},
        {who:"cand",text:"I keep a <strong>per-user undo stack of that user's own ops</strong>, and undo generates the <strong>inverse of my op transformed against everything that happened after it</strong>. So 'undo my insert of WORLD' becomes 'delete WORLD wherever it now sits,' computed by transforming the inverse through the concurrent ops — reusing the exact same transform machinery as normal editing. Redo is symmetric. This is one of OT's real advantages: undo is just another op that goes through transform, so it composes cleanly with concurrent editing."},
      ],resources:[
        {title:"Operational transformation",url:"https://en.wikipedia.org/wiki/Operational_transformation"},
      ]},
      {l:"medium",tag:"scaling",q:"Opening a giant 500-page document.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a user opens a 500-page document with a <b>2-million-op</b> history. If the client tries to fetch and replay the full op log to reconstruct the current text, load takes 30+ seconds and the tab freezes. Fix the open path.</span>"},
        {who:"cand",text:"The client should never replay the whole log. It fetches the <strong>latest snapshot</strong> — the materialized document at some recent version — and then only the <strong>tail of ops since that snapshot</strong>, usually a handful. So open cost is O(snapshot size + recent ops), not O(full history). This is the payoff of the op-log + periodic-snapshot model on the store side. Rendering-wise the editor <strong>virtualizes</strong>: it only lays out the visible viewport and a small buffer, not all 500 pages, so DOM work stays bounded regardless of doc length."},
        {who:"intv",text:"Snapshots help open, but a live 500-editor session still streams a lot at the client. Does the client drown?"},
        {who:"cand",text:"Two levers. First, the server sends me <strong>only ops for the doc I have open</strong>, already ordered, so it's the doc's op rate (~1-2.5K/s worst case of tiny ops) — manageable. Second, <strong>cursor/presence churn is far heavier than edits</strong>, so those get throttled and coalesced (I'll cover that under presence) rather than sent per-mouse-move. The client applies edit ops incrementally to its in-memory model; it's not re-rendering the whole doc per op, just the changed range. So the client scales fine; the pressure is really on the collab service and presence tiers."},
      ],resources:[
        {title:"Figma: how multiplayer works",url:"https://www.figma.com/blog/how-figmas-multiplayer-technology-works/"},
      ]},
    ],
    gw:[
      {l:"easy",tag:"concept",q:"Why persistent connections, and what does the gateway own?",turns:[
        {who:"intv",text:"You drew a 'WS gateway.' Why WebSockets and not just HTTPS request/response like a URL shortener? What exactly lives in this box?"},
        {who:"cand",text:"Editing is <strong>bidirectional and push-heavy</strong> — the server must push other people's ops to me the instant they happen, with no polling delay. So each client holds a <strong>persistent WebSocket</strong> to the gateway. The gateway owns the socket lifecycle: TLS, auth on connect, heartbeat/keepalive, backpressure, and mapping <code>connection -> user -> doc session</code>. It's deliberately <em>thin on logic</em> — it doesn't resolve conflicts; it routes ops up to the collab service that owns that doc's session and fans broadcasts back down to the right sockets."},
        {who:"intv",text:"Why separate the gateway from the collab service at all — why not terminate the socket on the collab process?"},
        {who:"cand",text:"Because they scale on different axes. The gateway scales with <strong>number of connections</strong> (which can be huge and mostly idle), while the collab service scales with <strong>active doc sessions and op throughput</strong>. Splitting them lets me hold a million cheap sockets on a gateway fleet while a smaller collab fleet does the CPU-real work, and it lets a client's socket survive even if the specific collab process for its doc restarts — the gateway just re-routes to the new owner."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"Figma: how multiplayer works",url:"https://www.figma.com/blog/how-figmas-multiplayer-technology-works/"},
      ]},
      {l:"medium",tag:"concept",q:"Show everyone's live cursors (adds presence).",reveal:["presence"],turns:[
        {who:"intv",text:"Product wants to see each collaborator's <strong>cursor and name flag</strong> moving live, plus text selections. Where does that data flow, and is it the same path as edits?"},
        {who:"cand",text:"It's a <em>different</em> class of data, so I'd give it its own path — let me add a <strong>presence</strong> component. Cursor position, selection range, and a color/name are <strong>ephemeral live state</strong>: extremely high-churn (every mouse move / arrow key), tiny, and — crucially — <strong>not durable</strong>. If I lose a cursor update, the next one fixes it a few ms later. So presence rides the same WebSocket through the gateway but branches to a presence service rather than through the op log and conflict engine."},
        {who:"intv",text:"Why not just push cursors through the same op stream as edits — one less component?"},
        {who:"cand",text:"Because it would pollute the durable, ordered edit log with millions of throwaway updates that must never be persisted, replayed, or conflict-resolved. Cursors don't need total ordering or durability; they need <em>freshness</em>. Mixing them would bloat the op log, slow snapshots and replay, and waste the conflict engine on data that has no conflicts. Keeping presence separate lets me throttle and drop it aggressively without ever touching the correctness path for edits — different guarantees, different pipe."},
      ],resources:[
        {title:"Figma: how multiplayer works",url:"https://www.figma.com/blog/how-figmas-multiplayer-technology-works/"},
      ]},
      {l:"hard",tag:"scaling",q:"Holding millions of live WebSocket connections.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> Monday 9am, <b>2 million</b> users are in live docs at once, each on a persistent WebSocket. A single gateway node handles ~50K connections before memory/file-descriptor limits bite. How does this tier hold, and what's the broadcast cost when a 500-editor doc is busy?</span>"},
        {who:"cand",text:"Connections scale horizontally: 2M / 50K is 40+ gateway nodes behind an L4 load balancer that does <strong>connection-aware</strong> distribution. Each node is mostly holding idle sockets — cheap. The interesting cost is <strong>fan-out</strong>: an op on a 500-editor doc must reach 499 other sockets, and those sockets are spread across many gateway nodes. So the collab service publishes each accepted op once to a <strong>pub/sub layer keyed by doc</strong>, and every gateway node subscribed to that doc pushes to its local subset of that doc's sockets. That turns fan-out into 'publish once, gateways deliver locally' instead of the collab process holding 500 sockets itself."},
        {who:"intv",text:"That pub/sub sounds like it could become the bottleneck. What's flowing through it?"},
        {who:"cand",text:"Only <strong>accepted edit ops</strong>, which are tiny and rate-limited by human typing — even a 500-editor doc is ~1-2.5K small messages/s, and most docs are far quieter. The heavy stuff (cursors) is on the presence path, which I can shard and even drop under load. I'd shard pub/sub <strong>by doc id</strong> so a hot doc's traffic lands on one partition and doesn't disturb others, and co-locate a doc's collab session with its partition to cut hops. If a single doc ever exceeds one partition's comfort, that's the 'hot doc' problem I'd address at the collab tier, not here."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"ByteByteGo",url:"https://bytebytego.com/"},
      ]},
      {l:"medium",tag:"failover",q:"A gateway node dies with 50K sockets on it.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a gateway node crashes hard, instantly dropping <b>50,000</b> live WebSocket connections mid-edit. What do those users experience, and do any in-flight edits get lost?</span>"},
        {who:"cand",text:"Each client detects the dead socket (failed heartbeat) within a second or two and <strong>auto-reconnects</strong> through the load balancer to a healthy gateway node. No edits are lost because the client holds its queue of <strong>unacknowledged ops</strong> and the last acked server version — on reconnect it re-sends anything not yet acknowledged, and the collab service (which is the durable owner of the session, not the gateway) either recognizes already-applied ops as duplicates or applies the missing ones. The gateway is stateless-ish routing; losing it costs a reconnect, not data."},
        {who:"intv",text:"How do you make sure a re-sent op isn't applied twice — double-inserting the character?"},
        {who:"cand",text:"Every op carries a <strong>(clientId, client sequence number)</strong>. The collab service tracks the highest sequence it has accepted per client, so a re-sent op with a seq it already applied is <strong>idempotently ignored</strong> and just re-acked. That makes reconnection safe by construction: the client can blindly re-send its unacked tail without fear of duplicates. Combined with local-first apply, a gateway failure is a brief blip — the cursor freezes for a moment and then everything resyncs."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
    ],
    collab:[
      {l:"medium",tag:"concept",q:"What does the collab service do per op, and why central?",turns:[
        {who:"intv",text:"An op arrives from a client for doc D. Walk me through what the collab service does with it, and tell me why having a single central server for a doc actually helps."},
        {who:"cand",text:"For each doc there's <strong>one authoritative collab session</strong> that owns it. When an op arrives it: <strong>(1)</strong> transforms/orders it against any concurrent ops via the engine, <strong>(2)</strong> assigns it the next position in the doc's <strong>total order</strong>, <strong>(3)</strong> appends it to the durable op log in the document store, <strong>(4)</strong> acks the sender, and <strong>(5)</strong> broadcasts it to all other editors. The single authoritative session is the trick: it imposes <em>one global sequence</em> of ops so every client applies ops in the same order and provably converges."},
        {who:"intv",text:"Why does a central total order make conflict resolution so much easier than a peer-to-peer approach?"},
        {who:"cand",text:"Because with a single sequencer, each op only has to be transformed against the <em>known, finite</em> set of ops that were ordered before it — the server is the arbiter, so there's no ambiguity about 'what happened first.' This is precisely why <strong>Google Docs uses OT with a central server</strong>: OT transforms are far simpler to keep correct when there's an authoritative order. Pure P2P (no central server) forces you into CRDTs to converge without coordination, which costs extra metadata. Since I already need a durable server for storage and auth, leaning on it as the sequencer is nearly free and removes a whole class of ordering bugs."},
      ],resources:[
        {title:"Operational transformation",url:"https://en.wikipedia.org/wiki/Operational_transformation"},
        {title:"Figma: how multiplayer works",url:"https://www.figma.com/blog/how-figmas-multiplayer-technology-works/"},
      ]},
      {l:"medium",tag:"concept",q:"Two users edit the exact same spot (adds engine).",reveal:["engine"],turns:[
        {who:"intv",text:"Concrete case. The document is <code>HELLO</code>. Based on that same version, user A inserts <code>X</code> at position 3 and user B inserts <code>Y</code> at position 3, at the same instant. If the collab service just applies both ops as-written, what does each user end up with?"},
        {who:"cand",text:"Divergence — the classic corruption.<span class='eg'>Start 'HELLO'. A: insert 'X' at 3 gives 'HELXLO'. B: insert 'Y' at 3 gives 'HEYLLO'. Now the server applies A then B: B's 'at position 3' still points at the old position 3, so one client shows 'HEYXLLO' and another 'HEXYLLO'. Positions shifted underneath B's op and nobody agrees on the result.</span>The bug is that B's op was written against a version that A's op already invalidated — raw positions are stale."},
        {who:"intv",text:"So how do you make both users converge to the same string?"},
        {who:"cand",text:"This is what a dedicated <strong>conflict-resolution engine</strong> is for — let me add it. With <strong>OT</strong>, before applying B's op the engine <em>transforms</em> it against A's already-applied op: since A inserted one char at position 3, B's 'insert at 3' is shifted to 'insert at 4,' giving a single agreed result like 'HEXYLLO' on every client. With a <strong>CRDT</strong> instead, each character gets a globally-unique, densely-ordered id at insert time, so A's and B's chars have deterministic relative positions and merge the same way everywhere with no transform step. Either way the engine's job is to guarantee <strong>convergence</strong> — this is the correctness heart of the system, which is why it deserves its own box."},
      ],resources:[
        {title:"Operational transformation",url:"https://en.wikipedia.org/wiki/Operational_transformation"},
        {title:"CRDT resources",url:"https://crdt.tech/"},
      ]},
      {l:"hard",tag:"failover",q:"The authoritative process for a hot doc crashes.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a single collab process owns a hot doc with <b>500 live editors</b>. It gets OOM-killed. In the last 2 seconds it had accepted and broadcast ~3,000 ops. Do those edits get lost? What do 500 users see?</span>"},
        {who:"cand",text:"Whether edits are lost hinges on <strong>one rule: an op is only acked and broadcast <em>after</em> it's durably appended to the op log.</strong> If I enforce that ordering, then everything those 500 users saw as applied was already persisted — the crash loses nothing committed. Ops that were mid-flight (received but not yet logged) were never acked, so their clients still hold them as unacknowledged and will re-send. On crash, the 500 sockets drop, clients reconnect through the gateway, and a <strong>new collab process is elected as owner</strong> of that doc, rehydrates state from the latest snapshot + op-log tail, and resumes. Users see a ~1-3s stall, then resync."},
        {who:"intv",text:"You said 'broadcast after durable append.' Doesn't waiting for a durable write on every op add latency to the live path for all 500 people?"},
        {who:"cand",text:"It adds a few ms per op, and I accept that — durability is the whole point of a document. But I keep it cheap: the store is an <strong>append-only log</strong> (sequential writes, very fast), I <strong>batch/pipeline</strong> appends across the many concurrent ops on a hot doc so one fsync covers many ops, and clients already applied their own op locally so the ack latency doesn't affect <em>their</em> typing feel — only how fast <em>others</em> see it, which stays well under 200ms. The alternative — broadcast-then-persist — would let a crash show users edits that then vanish on recovery, which is unacceptable. Durable-first is the correct ordering."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"ByteByteGo",url:"https://bytebytego.com/"},
      ]},
      {l:"hard",tag:"scaling",q:"One process per doc — how does that scale?",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> you have <b>50M</b> active docs and you've claimed each doc has a single authoritative owner process. Obviously that can't be one machine. At ~10K live sessions per collab node, how do you place and scale owners without a central bottleneck?</span>"},
        {who:"cand",text:"I <strong>shard docs across the collab fleet</strong>: <code>owner(docId)</code> maps a doc to exactly one live process, typically via <strong>consistent hashing</strong> on doc id (or a coordinator/placement service). 50M docs across nodes at ~10K sessions each is a few thousand nodes, and each doc still has a single owner — I get the simple-ordering benefit <em>per doc</em> while scaling horizontally across docs. There's no global bottleneck because the sequencer is per-doc, not global. Idle docs hold no live session at all; a process only owns a doc while it has editors, so I'm sized by <em>concurrent</em> sessions, not total docs."},
        {who:"intv",text:"Consistent hashing spreads docs evenly, but a single doc with 500 editors is still one owner. What if one doc is too hot for one process?"},
        {who:"cand",text:"For text editing, one process comfortably handles a 500-editor doc — it's ~1-2.5K tiny ops/s and the fan-out is offloaded to gateways/pub-sub, so the owner's real work is just transform + append + publish. That fits one core easily. If a doc were ever pathologically hot I could <strong>split the doc into independently-owned sub-sections</strong> (per page/section), each with its own sequencer, since edits rarely span sections — but I'd only pay that complexity when measurements demand it. The bigger scaling win is that ordering stays per-doc, so hot docs never contend with each other."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"ByteByteGo",url:"https://bytebytego.com/"},
      ]},
      {l:"hard",tag:"durability",q:"Guaranteeing an accepted edit is never lost.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> the collab service acks ~1,500 ops/s to editors on a busy doc. Between the moment you ack and the moment the op is safely on disk in 3 places, there's a window. Quantify the risk and tell me how you close it without killing latency.</span>"},
        {who:"cand",text:"The rule I stated — <strong>append durably before ack</strong> — is what closes the window, but 'durable' needs teeth: an op is durable when the op log's <strong>replicated write quorum</strong> has accepted it (say 2 of 3 replicas across failure domains), not merely when one node buffered it in memory. So I only ack after quorum. The risk I'm eliminating is 'user saw it saved, single node then died, edit gone.' With quorum append, losing any one node loses nothing acked."},
        {who:"intv",text:"Quorum on every op at 1,500 ops/s — that's a lot of round-trips. Latency?"},
        {who:"cand",text:"I <strong>batch</strong>: the owner groups the many concurrent ops arriving within a few ms into one replicated append, so one quorum round-trip commits dozens of ops. That amortizes the cost — effective per-op overhead is small — while preserving 'ack only after quorum.' Clients feel nothing because their own edit was applied locally already; the batch only affects how fast the durable ack and others' view arrive, and that stays under my 200ms budget. So I get strong durability and real-time feel together — the append-log's sequential, batchable nature is exactly what makes this affordable."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"hard",tag:"failover",q:"A network partition splits the editors in two.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a network partition splits your 500 editors into two groups that can't see each other's collab traffic — say 300 on one side, 200 on the other — for 90 seconds. Both groups keep typing. What's the right behavior, and what must you never do?</span>"},
        {who:"cand",text:"The thing I must never do is let <strong>two processes both act as the authoritative owner</strong> of the same doc — that's split-brain, and it would create two divergent op logs that can't be cleanly merged. So ownership must be granted through a <strong>lease/consensus with a fencing epoch</strong>: only the side that can reach the placement authority (majority quorum) keeps a valid lease and stays writable; the minority side's owner loses its lease and goes <strong>read-only / buffered</strong>. The 200 users on the minority side keep typing into their <em>local replicas</em> (offline-style), queuing unacked ops, but their edits aren't globally committed yet."},
        {who:"intv",text:"So when the partition heals, the 200 minority users have 90 seconds of local edits. How do they rejoin without losing work?"},
        {who:"cand",text:"Exactly the <strong>offline reconnect path</strong> reused: on heal, the minority clients reconnect to the surviving authoritative owner and <strong>replay their queued ops through the engine</strong>, transformed/merged against everything the majority committed during the partition. Nothing is lost — their work was preserved locally and is now reconciled into the single total order. This is why I keep one authoritative sequencer per doc plus convergent transforms: a partition degrades the minority to 'offline for 90s' rather than corrupting the document. I chose <strong>consistency over write-availability</strong> for the minority during the partition, which for a shared document is the right trade — a brief local-only period beats an unmergeable fork."},
      ],resources:[
        {title:"CRDT resources",url:"https://crdt.tech/"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
    ],
    doc:[
      {l:"medium",tag:"concept",q:"What's stored — op log, snapshots, schema?",turns:[
        {who:"intv",text:"You keep saying 'op log + snapshots.' Give me the actual data model. What's the source of truth, and is this SQL or NoSQL?"},
        {who:"cand",text:"The <strong>source of truth is an append-only op log per document</strong>: an ordered sequence of <code>(seq, docId, op, authorId, timestamp)</code>. That's it — the document at any version is the fold of ops up to that seq. On top I periodically materialize <strong>snapshots</strong>: the full document text at some seq, so I don't replay from zero. Access is <em>always by docId</em>, appends are sequential, reads are 'give me snapshot + ops since seq' — no joins, no ad-hoc queries. That's a <strong>log-structured / append-optimized store</strong> — a wide-column or log store (Bigtable/Cassandra-style, or a purpose-built log), not a relational schema. Metadata (title, owner, ACL) can live in a small relational/KV table separately."},
        {who:"intv",text:"Why keep the whole op log at all — why not just store the current document and overwrite it?"},
        {who:"cand",text:"Because the op log is what makes everything else work: <strong>real-time convergence</strong> (clients sync by seq range), <strong>offline replay</strong>, <strong>undo/redo</strong>, <strong>version history / 'see edits by X'</strong>, and <strong>auditing</strong>. Overwriting current-state-only throws all that away and reintroduces last-writer-wins clobbering — the exact corruption we're avoiding. The op log is cheap (tiny ops, sequential writes); the cost is unbounded growth and replay time, which is exactly what snapshots and compaction are for."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"ByteByteGo",url:"https://bytebytego.com/"},
      ]},
      {l:"hard",tag:"durability",q:"Surviving crashes with snapshots (adds persistence).",reveal:["persist"],turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a document store node holding a doc's op log restarts unexpectedly. The doc has 2M ops. If recovery means replaying all 2M ops from the beginning, the doc is unavailable for tens of seconds. And if the disk is truly gone, is the doc lost? Walk me through your durability story.</span>"},
        {who:"cand",text:"Two separate problems: recovery speed and true durability. For speed, recovery reads the <strong>latest snapshot + the op tail after it</strong>, so it's O(recent ops), not 2M — sub-second. For true durability I need to add a dedicated <strong>persistence</strong> layer: the op log is <strong>replicated across 3-plus nodes in different failure domains</strong> with quorum writes, and snapshots plus older log segments are <strong>flushed to durable object storage</strong> (S3-class, 11-nines). Let me add that persistence box. A single dead disk loses nothing — quorum replicas have the log — and even losing a whole node/AZ is covered by the offsite snapshots + segments."},
        {who:"intv",text:"How often do you snapshot? There's a tension between recovery speed and write overhead."},
        {who:"cand",text:"Snapshot on a rolling policy — e.g. <strong>every N ops or T seconds, whichever first</strong> (say every 1,000 ops or 60s on an active doc), plus a snapshot when a doc goes idle so cold-open is cheap. Snapshotting is off the hot path: a background job folds the log up to a seq and writes the snapshot to persistence, then old log segments before a safe snapshot can be <strong>compacted/archived</strong>. Frequent enough that replay-tail is small; infrequent enough that it's a background cost, not per-op. The op log stays the source of truth; snapshots are just a cache of folded state to bound recovery and open time."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"ByteByteGo",url:"https://bytebytego.com/"},
      ]},
      {l:"hard",tag:"durability",q:"The store loses the last N ops before a snapshot.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a node fails and, due to a replication gap, the op log is missing the <b>last 40 ops</b> that came in after the most recent snapshot — but those 40 ops were already acked and shown to editors. On recovery the doc reverts 40 ops. Users watch their text disappear. How do you prevent this?</span>"},
        {who:"cand",text:"This is the nightmare case and it must be <em>impossible by construction</em>, not merely rare. It only happens if I <strong>acked before durable quorum</strong> — the bug we discussed at the collab tier. If an op is only acked after it's committed to a <strong>write quorum</strong> of the log's replicas, then those 40 acked ops exist on at least a majority; a single node's gap is repaired by reading from a replica that has them. Recovery reconciles to the <em>highest committed seq across the quorum</em>, so it can never roll back below what was acked. The invariant is: <strong>acked implies on a majority of replicas implies recoverable</strong>."},
        {who:"intv",text:"And if the ops truly were only on the one node that died — no quorum? Can you at least detect and recover rather than silently lose?"},
        {who:"cand",text:"If they were never quorum-committed then by my own rule they should never have been acked, so a correct system wouldn't show them as saved in the first place — the client would still hold them as <strong>unacknowledged</strong> and re-send on reconnect, healing the gap. As defense in depth: clients keep their unacked tail until they see a durable ack for that seq, and on reconnect the server reconciles client seq vs committed seq and pulls any missing ops back from clients. So even a pathological loss is recoverable from the clients that authored the ops. Silent data loss requires <em>both</em> a quorum failure <em>and</em> every author disconnecting — vanishingly unlikely, and still not silent because seq gaps are detectable."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"hard",tag:"scaling",q:"The op log grows unbounded; replay takes minutes.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a long-lived doc has accumulated <b>50M ops</b> over two years. Version history, recovery, and analytics all touch the log, and full replays now take minutes. Storage per hot doc is ballooning. Fix the growth and the replay cost.</span>"},
        {who:"cand",text:"Replay cost is already bounded by <strong>snapshots</strong> — nothing reads from op 0; recovery and open read snapshot + tail. For the log itself I <strong>compact</strong>: once a snapshot at seq S is durable in persistence, log segments before S are no longer needed for <em>current</em> operation, so I archive them to cold object storage and truncate the hot log. The live store then holds only a recent window of ops, keeping it small regardless of doc age. So growth is capped in the hot tier while full history still lives cheaply in cold storage."},
        {who:"intv",text:"But you promised version history — 'restore to last Tuesday.' If you compacted those ops away, is history gone?"},
        {who:"cand",text:"No — compaction <strong>archives</strong>, it doesn't delete. Old segments and periodic snapshots sit in cold object storage, so 'restore to last Tuesday' loads the nearest older snapshot plus the archived op delta — slower (it's a cold path) but fully available. I can also keep <strong>named/version snapshots</strong> at coarser granularity (e.g. hourly, then daily) for old history so I don't retain every keystroke forever — most users want 'the doc as of a day,' not op-level scrubbing two years back. So the hot path stays fast and small, and history degrades gracefully to a cold, cheaper store instead of bloating the live log."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"ByteByteGo",url:"https://bytebytego.com/"},
      ]},
      {l:"medium",tag:"failover",q:"Who can even open this doc — access control.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> you revoke a collaborator's access, but their browser still holds a live WebSocket to the collab process. They keep receiving ops — and can still send edits — after being removed.</span>Where and when do you enforce access control, and what happens on revoke?"},
        {who:"cand",text:"Authorization is checked at <strong>two points</strong>: on <em>connect/open</em> (the gateway + collab session verify the user's role against the doc's ACL before joining them to the session) and on <strong>every op</strong> at the collab service (a viewer can't submit edits; an editor can). The ACL lives with doc metadata, not in the op log. So opening the doc, receiving broadcasts, and submitting ops are all gated by the current role, not a one-time check at page load."},
        {who:"intv",text:"They're already connected when access is revoked. Do they keep editing until they refresh?"},
        {who:"cand",text:"No — revoke must be <strong>live</strong>. On an ACL change the collab session is notified (the metadata service publishes a revocation event for that doc/user), and the session immediately <strong>drops or downgrades that connection</strong>: their next op is rejected and their socket is closed with a 'permission changed' signal, so the client stops accepting broadcasts too. Because every op is authorized server-side, even a stale client can't sneak an edit through after revoke — the worst case is they see already-delivered content for a moment before the socket closes. For sensitive docs I'd also keep edit ops attributed to <code>authorId</code> in the log, so access decisions are auditable."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
    ],
    engine:[
      {l:"medium",tag:"concept",q:"How OT actually transforms operations.",turns:[
        {who:"intv",text:"Let's nail down OT. Give me the mechanics: what does 'transform' compute, and why does the central total order make it tractable?"},
        {who:"cand",text:"OT models edits as operations — <code>insert(pos, char)</code>, <code>delete(pos)</code> — and defines a <strong>transform function</strong> <code>T(opB, opA)</code> that rewrites opB so it has the intended effect <em>after</em> opA has been applied.<span class='eg'>opA = insert('X', 3), opB = insert('Y', 3). T(opB, opA) shifts opB to insert('Y', 4) because A added a char at/before 3, so B's target moved right by one.</span>The property that makes it converge is <strong>TP1</strong>: applying opA then T(opB,opA) yields the same document as opB then T(opA,opB)."},
        {who:"intv",text:"Where does the central server fit — why is OT easier with one?"},
        {who:"cand",text:"The server assigns a <strong>single total order</strong> to ops. So a client op only ever has to be transformed against the <em>specific, ordered</em> ops the server accepted since that client's base version — a bounded, unambiguous list. The server transforms an incoming op forward over that list, applies it, and ships each client the transformed ops it's missing. Without a central order you'd face the far nastier general case (TP2, arbitrary concurrent histories) which is notoriously hard to get right — which is exactly why Google Docs pairs OT with an authoritative server rather than going peer-to-peer."},
      ],resources:[
        {title:"Operational transformation",url:"https://en.wikipedia.org/wiki/Operational_transformation"},
        {title:"Figma: how multiplayer works",url:"https://www.figma.com/blog/how-figmas-multiplayer-technology-works/"},
      ]},
      {l:"medium",tag:"concept",q:"CRDT vs OT — when would you switch?",turns:[
        {who:"intv",text:"You keep offering 'OT or CRDT.' Explain CRDTs concretely, mention where they shine, and be honest about the trade-offs versus OT."},
        {who:"cand",text:"A <strong>CRDT</strong> makes merges <em>conflict-free by construction</em>: instead of transforming ops against an order, every element carries identity/metadata so any two replicas that have seen the same set of ops converge with no coordination. For text, each character gets a <strong>globally-unique, densely-ordered id</strong>, so 'A's char' and 'B's char' have a deterministic relative position everywhere. For simple fields like a cursor color or a title, a <strong>LWW-register</strong> (last-writer-wins by timestamp) is the trivial CRDT — that's the flavor Figma leans on for object properties, where a whole-value overwrite is fine. CRDTs shine in <strong>P2P / offline-heavy / no-central-server</strong> settings because they don't need a sequencer."},
        {who:"intv",text:"So why doesn't everyone just use CRDTs and delete the OT complexity?"},
        {who:"cand",text:"Trade-offs. CRDTs pay in <strong>metadata</strong>: every character (or element) carries a unique id and, for deletions, a <strong>tombstone</strong> that lingers so concurrent ops can still position against it — that bloats memory and the on-wire/at-rest size, and needs periodic garbage collection. OT keeps ops tiny (just a position) but pushes the complexity into <strong>correct transform functions + a central order</strong>. With a central server — which I already have for storage and auth — OT is very efficient and Google-Docs-proven. I'd reach for CRDTs when I genuinely need <strong>decentralized or long-offline P2P merges</strong> (like Automerge/Yjs); with an authoritative server, OT's smaller footprint usually wins. It's a footprint-vs-coordination trade, not a right/wrong."},
      ],resources:[
        {title:"CRDT resources",url:"https://crdt.tech/"},
        {title:"Yjs (CRDT implementation)",url:"https://github.com/yjs/yjs"},
      ]},
      {l:"hard",tag:"scaling",q:"Transform cost as concurrency and history grow.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> on a hot doc the engine must transform each incoming op against the ops accepted since that client's base version. A lagging client is <b>2,000 ops behind</b>, and 500 clients are firing ops. Naively that's O(ops-behind) per op, per client. Does the engine become the bottleneck?</span>"},
        {who:"cand",text:"It can, so I bound the transform distance. First, the server pushes ordered ops to clients continuously, so a healthy client is only a few ops behind and each transform is cheap — the 2,000-behind case only happens after a stall/reconnect. For that laggard I don't transform op-by-op against 2,000 individually in the hot path; I <strong>catch it up in a batch</strong> (compose the missed ops, or hand it a fresh snapshot + short tail) rather than let it dribble 2,000 transforms through the live engine. Steady state is O(small). CRDT would avoid transform entirely but at the metadata cost we discussed — for a central-server design keeping clients caught-up keeps OT cheap."},
        {who:"intv",text:"The engine holds live per-doc state to do this. Is that memory a scaling concern across millions of docs?"},
        {who:"cand",text:"The engine is <strong>co-located with the doc's collab owner</strong> and only holds state for docs that are <em>actively</em> being edited — the current materialized doc plus a recent op window, not full history. Idle docs hold nothing. So memory scales with <strong>concurrent sessions</strong>, sharded across the collab fleet by doc id, same as the owners. Cold docs live only as snapshot + log in the store until someone opens them. That keeps the engine's footprint proportional to live editing, not to the 50M-doc corpus."},
      ],resources:[
        {title:"Yjs (CRDT implementation)",url:"https://github.com/yjs/yjs"},
        {title:"Operational transformation",url:"https://en.wikipedia.org/wiki/Operational_transformation"},
      ]},
      {l:"hard",tag:"failover",q:"Rebuilding engine state after the owner restarts.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> the engine's in-memory state (materialized doc + pending-transform context) lives in the collab owner process, which just restarted. 500 clients each hold unacked ops. How does the new engine rebuild correct state so those pending ops transform correctly — and not double-apply?</span>"},
        {who:"cand",text:"The engine state is a <strong>derived cache, not source of truth</strong> — so rebuild is deterministic: load the latest <strong>snapshot</strong> plus the <strong>op-log tail</strong> from the store, fold them, and the engine is back at the exact committed version with its per-client accepted-seq high-water marks (also derivable from the log's author/seq metadata). Now clients reconnect and re-send their unacked ops; the engine transforms each against whatever committed after that op's base version and appends it. Because acceptance is keyed on <strong>(clientId, seq)</strong>, any op that was actually committed before the crash is recognized as a duplicate and <strong>idempotently skipped</strong> — no double-insert."},
        {who:"intv",text:"What if a client's base version refers to ops that were compacted away already?"},
        {who:"cand",text:"Then I don't transform against long-gone individual ops — I <strong>rebase the client onto the current snapshot</strong>. The client is told 'your base is too old; here's snapshot at seq S and the tail,' it resets its replica to that, and re-applies its still-unacked local ops on top through the engine against the post-S ops. That's the same offline/large-divergence path reused. So even across compaction the invariant holds: the log (plus snapshots) fully determines engine state, and unacked client ops always reconcile against the current committed order — the engine never needs to persist its own state to be correct after a crash."},
      ],resources:[
        {title:"CRDT resources",url:"https://crdt.tech/"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
    ],
    presence:[
      {l:"easy",tag:"concept",q:"Why cursor presence is a different kind of data.",turns:[
        {who:"intv",text:"You split presence out from edits. Justify it: what data is presence, and why can it play by looser rules than the op log?"},
        {who:"cand",text:"Presence is <strong>ephemeral live state</strong>: each editor's cursor position, selection range, name/color, and typing/idle status. Its defining properties are the opposite of edits: it's <strong>extremely high-churn</strong> (a cursor moves many times a second), <strong>tiny</strong>, <strong>self-correcting</strong> (the next update overwrites the last), and <strong>not durable</strong> — nobody wants to persist or replay where a cursor was five minutes ago. So it needs no total order, no conflict resolution, and no snapshotting. It just needs to be <em>fresh</em> and cheap."},
        {who:"intv",text:"So how is a cursor update represented and delivered differently from an edit op?"},
        {who:"cand",text:"A presence update is a <strong>LWW value keyed by (docId, userId)</strong> — last write wins, no merge. It rides the same WebSocket to the gateway but branches to the presence service, which keeps only the <em>current</em> value per user per doc (in memory, with a short TTL so a dead client's cursor auto-expires) and fans it out to the doc's other editors. It never enters the op log, never touches the engine, and can be <strong>dropped freely</strong> under load. That separation is what lets me be lavish with cursor updates without ever risking the correctness or durability of actual edits."},
      ],resources:[
        {title:"Figma: how multiplayer works",url:"https://www.figma.com/blog/how-figmas-multiplayer-technology-works/"},
        {title:"CRDT resources",url:"https://crdt.tech/"},
      ]},
      {l:"hard",tag:"scaling",q:"High-churn cursor storm on a 500-editor doc.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> 500 editors are actively moving cursors on one doc. Each emits ~10 cursor updates/s. Naive fan-out is 500 senders x 10 x 499 receivers, about <b>2.5M messages/s</b> for a single doc — dwarfing the edit traffic. Tame it.</span>"},
        {who:"cand",text:"The N-squared fan-out is the killer, so I attack both the rate and the fan-out. <strong>Rate:</strong> the client <strong>throttles</strong> cursor emission to ~5-10/s and only sends on meaningful movement; the presence service further <strong>coalesces</strong> — it holds the latest position per user and flushes on a fixed tick (say every 100-200ms), so bursts collapse to at most ~5-10 updates/s/user regardless of raw mouse events. <strong>Fan-out:</strong> instead of per-user messages, the service sends each client a <strong>single batched snapshot</strong> of all cursors on the doc per tick. That turns 2.5M/s into ~500 users x 5-10 ticks/s = a few thousand batched messages/s — orders of magnitude less."},
        {who:"intv",text:"500 name flags on screen is also a UX and bandwidth mess. Anything beyond batching?"},
        {who:"cand",text:"Yes — <strong>degrade gracefully</strong>. Past a threshold of concurrent editors I stop sending every individual cursor and switch to <strong>aggregate presence</strong>: show exact cursors for a bounded set (people near your viewport / recently active) and collapse the rest into '+N others editing.' Presence is best-effort, so shedding detail under load is acceptable — it's cosmetic, not correctness. I'd also <strong>viewport-scope</strong> updates so you mostly receive cursors for the region you're looking at. Because none of this is durable, aggressive dropping/coalescing is free of consistency risk — the exact opposite of the edit path."},
      ],resources:[
        {title:"Figma: how multiplayer works",url:"https://www.figma.com/blog/how-figmas-multiplayer-technology-works/"},
        {title:"ByteByteGo",url:"https://bytebytego.com/"},
      ]},
      {l:"medium",tag:"failover",q:"The presence service dies — do cursors matter?",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> your presence service tier crashes and is down for <b>2 minutes</b>. During that time no cursor or selection updates flow. Is this a P1 incident? What should editors experience?</span>"},
        {who:"cand",text:"It's <strong>not a correctness incident</strong> — it's a cosmetic degradation, which is exactly why I isolated presence from edits. During the outage, <strong>edits keep flowing</strong> (they go client to gateway to collab to store, untouched by presence), so nobody loses work or sees the document diverge. What they lose is seeing each other's live cursors and names. The client should <strong>fail soft</strong>: freeze or fade the last-known cursors, maybe show a subtle 'presence reconnecting' hint, and never block typing. On recovery, presence rebuilds trivially because it's ephemeral — every client just re-sends its current cursor and the fresh state repopulates within a tick."},
        {who:"intv",text:"Rebuild 'trivially' — you're sure there's no state to recover?"},
        {who:"cand",text:"Right, because presence holds <strong>no durable state by design</strong> — it's the current value per (doc, user) in memory with a TTL. There is nothing to recover: the source of truth for 'where is my cursor' is the client, which re-announces on reconnect. So I can run presence as a stateless, horizontally-scaled, even best-effort tier (replicated for availability but not for durability), and its failure mode is a self-healing blip rather than data loss. That's the whole payoff of keeping ephemeral live state out of the durable edit path."},
      ],resources:[
        {title:"Figma: how multiplayer works",url:"https://www.figma.com/blog/how-figmas-multiplayer-technology-works/"},
      ]},
      {l:"medium",tag:"concept",q:"Typing indicators and stale-cursor cleanup.",turns:[
        {who:"intv",text:"Small but real: a user closes their laptop lid without disconnecting cleanly. Their cursor flag sits frozen on everyone's screen forever. How do you avoid ghost cursors?"},
        {who:"cand",text:"Presence entries carry a <strong>TTL that's refreshed by heartbeats</strong>. The client sends a lightweight keepalive (or its throttled cursor updates double as one) every few seconds; the presence service refreshes the entry's expiry on each. If no heartbeat arrives within the TTL — say 10-15s — the entry <strong>expires automatically</strong> and the service broadcasts a 'user left' so the ghost flag disappears. A clean disconnect (socket close at the gateway) triggers immediate removal; the TTL is the backstop for the unclean lid-close case."},
        {who:"intv",text:"Typing indicators — 'Alice is typing' — same mechanism?"},
        {who:"cand",text:"Yes, it's just another ephemeral presence field. When I emit edit ops the client also sets a transient <code>typing=true</code> in its presence, which the service fans out and which <strong>auto-clears on a short timeout</strong> if no further edits arrive (or on idle). It's LWW, TTL-backed, and best-effort like cursors — if a 'stopped typing' update is dropped, the timeout cleans it up anyway. Keeping all of this in the presence tier means these fun-but-nonessential signals never add load or risk to the durable edit path."},
      ],resources:[
        {title:"Figma: how multiplayer works",url:"https://www.figma.com/blog/how-figmas-multiplayer-technology-works/"},
      ]},
    ],
    persist:[
      {l:"hard",tag:"durability",q:"Snapshots and durable storage of the op log.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> you're accepting ~1,500 ops/s across active docs and generating snapshots continuously. You must guarantee an acked edit survives the loss of any single node <b>and</b> a whole-AZ outage. Lay out the persistence design.</span>"},
        {who:"cand",text:"Two durability tiers. <strong>Hot log:</strong> the recent op log is <strong>replicated across 3 nodes in 3 AZs</strong> with <strong>quorum writes</strong> — an op is acked only after a majority persists it, so any single node (or one whole AZ) can die with zero loss of acked edits. <strong>Cold/archival:</strong> snapshots and sealed older log segments are written to <strong>object storage (S3-class, ~11 nines, cross-AZ by default)</strong>. So the durable chain is: quorum-committed hot log for the live tail, offsite snapshots+segments for everything older. Recovery reads snapshot + tail; long-term survival rides on object storage's redundancy."},
        {who:"intv",text:"Object storage is durable but slow and eventually consistent. Does that hurt you on the write or recovery path?"},
        {who:"cand",text:"I keep it <em>off</em> the hot path. Snapshotting and segment archival are <strong>background jobs</strong>, so object storage latency never affects op acks — those are served by the quorum-replicated hot log. On recovery I read the latest snapshot (immutable object, so eventual consistency is a non-issue — I fetch a specific versioned key) plus the hot-log tail. I only truncate a hot-log segment <em>after</em> confirming its covering snapshot is durable in object storage, so there's never a window where data exists only in a not-yet-consistent place. Fast, strongly-consistent tier for live edits; cheap, massively-durable tier for history."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"ByteByteGo",url:"https://bytebytego.com/"},
      ]},
      {l:"hard",tag:"scaling",q:"Snapshot and archive storage growth / compaction.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> with 50M docs, naive snapshotting writes a full document copy every 1,000 ops. A frequently-edited 200KB doc could generate <b>gigabytes of snapshots per day</b>. Storage and cost explode. Control it.</span>"},
        {who:"cand",text:"Full-copy-per-interval is the waste. Fixes: <strong>(1) retain few snapshots</strong> — keep only the latest one or two needed for recovery/open; older snapshots are redundant once a newer one is durable, so garbage-collect them. <strong>(2) incremental/delta snapshots</strong> — store a base plus periodic deltas rather than full copies each time. <strong>(3) compaction</strong> — once snapshot at seq S is durable, archive+truncate log segments before S so the hot log stays small. <strong>(4) tiering</strong> — recent data on fast storage, old snapshots/segments aged into cheaper cold/glacier tiers by lifecycle policy. So steady-state storage is O(current doc size + recent history), not O(all edits ever) times full copies."},
        {who:"intv",text:"You still owe users full version history. How do you keep that affordable after compaction?"},
        {who:"cand",text:"History lives in the <strong>cold tier</strong> as archived log segments + periodic snapshots — cheap object storage, not the hot path. To bound it I use <strong>coarsening retention</strong>: keep fine-grained ops for recent edits (op-level undo/scrub), then thin older history to periodic snapshots (hourly, then daily) so I'm not storing every keystroke from two years ago forever. 'Restore to last Tuesday' loads the nearest cold snapshot + delta — slower, but rarely used and cheap to store. So the hot tier stays lean for real-time editing while history degrades gracefully into inexpensive cold storage."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"ByteByteGo",url:"https://bytebytego.com/"},
      ]},
      {l:"medium",tag:"failover",q:"The archival backend is unavailable for a while.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> your object-storage backend for snapshots/archives has a <b>30-minute</b> regional hiccup — writes to it fail. Meanwhile editing continues at full tilt. Does editing stall? Do you lose durability?</span>"},
        {who:"cand",text:"Editing must <strong>not stall</strong>, and durability holds, because live durability is provided by the <strong>quorum-replicated hot log</strong>, not by object storage. During the hiccup: acks keep flowing (hot log quorum is unaffected), and the <strong>background snapshot/archive jobs simply queue and retry with backoff</strong>. The only consequence is that snapshots and log-compaction fall behind — the hot log grows longer than usual and recovery-replay tail would be bigger for that window. No acked edit is at risk because it's already on a majority of hot-log replicas."},
        {who:"intv",text:"So what's the actual risk you're carrying during those 30 minutes?"},
        {who:"cand",text:"Two bounded risks. First, <strong>deferred compaction</strong> means the hot log uses more space and, if a doc's owner crashed <em>right then</em>, replay would fold a longer tail (seconds, not a real outage). Second, I must <strong>not truncate any hot-log segment until its snapshot is confirmed durable</strong> in object storage — so during the outage I hold segments longer rather than risk deleting the only fast copy before the archive lands. That's a deliberate space-for-safety trade. When object storage recovers, the queued snapshots/archives flush, compaction catches up, and the hot log shrinks back to normal. Editing never noticed."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"medium",tag:"concept",q:"Point-in-time restore and version history.",turns:[
        {who:"intv",text:"A user wants 'restore this doc to how it looked at 3pm yesterday,' and to browse named versions. Given op log + snapshots, how do you serve that precisely?"},
        {who:"cand",text:"Because the <strong>op log is the source of truth and every op has a timestamp + seq</strong>, any point in time maps to a seq. To render 'the doc at 3pm yesterday' I take the <strong>nearest snapshot at or before that seq</strong> and fold the op delta up to the target seq — reconstructing the exact state.<span class='eg'>Snapshot at seq 40,000 (2:55pm) + ops 40,001..40,120 (up to 3:00pm) = the document precisely as of 3pm.</span>Named versions are just <strong>labeled snapshots</strong> a user or the system pins at meaningful seqs."},
        {who:"intv",text:"And 'restore' — do you rewrite history or delete the newer ops?"},
        {who:"cand",text:"Neither — restore is <strong>append, not rewrite</strong>. To restore to seq S, I compute the diff between the current state and the state at S and apply it as <strong>new ops on the head of the log</strong>. So 'restore' is itself an edit that everyone converges on through the normal path, and the intervening history is preserved (you can undo the restore, or restore forward again). This keeps the log immutable and auditable, avoids the correctness hazard of deleting committed ops, and works cleanly even while other people are live in the doc — the restore ops just flow through the engine like any concurrent edit."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
    ],
  }
};
