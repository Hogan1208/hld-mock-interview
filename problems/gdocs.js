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
  edges:[["client","gw","WS"],["gw","collab","edits"],["collab","doc","apply"],["collab","engine","transform"],["gw","presence","cursors"],["doc","persist","snapshot"]],
  core:["client","gw","collab","doc"],
  basic:["client","gw","collab","doc"],
  deepDive:{
    client:{
      role:"The in-browser editor that holds a <strong>local replica</strong> and applies keystrokes instantly, then ships them as small ops. The consequential lever it owns: <strong>local-first (optimistic) apply</strong> — typing must feel instant with zero round-trip, which is the whole reason a conflict engine exists downstream.",
      capacity:[
        ["Own typing","~2-5 ops/s","tiny insert/delete + baseVersion"],
        ["Inbound edit stream","~1-2.5K ops/s worst case","a 500-editor doc, &lt; ~100 KB/s — nothing for a socket"],
        ["Local replica","a few hundred KB","the current doc, not full op history"],
        ["Cursor churn","~5-10/s per user, coalesced","taken as one batched snapshot per ~100-200ms tick"],
      ],
      data:"Holds the current document replica, a queue of <strong>unacknowledged local ops</strong> (each tagged with the base version it was made against), and the last server version seen. Offline, all of that is durable-enough locally to replay on reconnect. It does <em>not</em> hold full op history — it fetches snapshot + tail on open and keeps a recent window.",
      scaling:[
        "Apply locally first, reconcile later through the engine — never gate a keystroke on a round-trip.",
        "Apply ops <strong>incrementally to the changed range</strong> and <strong>virtualize</strong> rendering to the viewport so a 500-page doc stays on ~1 core.",
        "Fetch <strong>snapshot + tail</strong> on open (O(recent), not O(full history)).",
        "Throttle/coalesce cursor emission and take presence as a batched per-tick snapshot to stay off the edit budget.",
      ],
      failures:[
        {t:"User edits offline for 60 min (~4,000 ops) while 10,000 remote ops land",b:"Divergent local state on reconnect.",m:"Queued unacked ops replay through the engine, each transformed against concurrent remote ops; fall back to rebasing onto a recent snapshot if divergence is huge; unmergeable regions preserved as suggestions, never dropped."},
        {t:"Opening a 500-page, 2M-op doc",b:"Full replay freezes the tab for 30s+.",m:"Fetch the latest snapshot + only the op tail; virtualize rendering to the visible viewport."},
        {t:"Ctrl-Z while a colleague is editing elsewhere",b:"Naive global undo wipes their change too.",m:"Per-user undo stack; undo generates the inverse of <em>my</em> op transformed against everything after it."},
      ],
      tradeoffs:[
        {a:"Wait for server confirm per keystroke",b:"Local-first optimistic apply",pick:"Waiting shows every character ~100-200ms late — unusable; local-first is non-negotiable, at the cost of a replica momentarily ahead of the server that the engine reconciles."},
        {a:"Hold full op history client-side",b:"Snapshot + recent window",pick:"Full history bloats the tab and slows open; keep only snapshot + tail and fetch more on demand."},
      ],
      probes:[
        "When I press a key, what does the client do before/during/after the server hears about it — and why apply locally first?",
        "A user edits offline for an hour, then reconnects into 10,000 remote ops. What happens, and isn't transforming 4,000 ops fragile?",
        "Implement Ctrl-Z correctly when others are editing — give a case where the naive answer is wrong.",
      ],
    },
    gw:{
      role:"The <strong>WebSocket gateway</strong>: it owns the persistent socket lifecycle and maps <code>connection → user → doc session</code>, but is deliberately thin on logic. Its defining lever: separating <strong>connection-holding</strong> (huge, mostly idle) from the CPU-real work in collab, so a million cheap sockets scale independently of doc sessions.",
      capacity:[
        ["Concurrent sockets","~2M at Monday-9am peak","persistent, bidirectional, push-heavy"],
        ["Per-node connections","~50K before FD/memory bite","idle-socket RAM + descriptors set the ceiling"],
        ["Fleet","~40 nodes → ~60 with headroom / 3 AZs","losing an AZ drops ~1/3, not the tier"],
        ["Broadcast per hot doc","~1-2.5K small ops/s fanned out","via pub/sub, not the gateway holding 500 sockets"],
      ],
      data:"Stateless-ish routing — no durable state; the collab service is the durable session owner. It tracks socket &harr; session mappings and handles TLS, auth-on-connect, heartbeats, and backpressure.",
      scaling:[
        "Scale horizontally on <strong>connection count</strong> behind an L4 connection-aware LB; autoscale on connections with a warm floor.",
        "Fan out via a <strong>pub/sub layer keyed by doc</strong> — publish once, each gateway pushes to its local subset of that doc's sockets.",
        "Shard pub/sub by doc id and co-locate the collab session with its partition to cut hops.",
        "Branch presence to the presence service rather than through the op log/engine.",
      ],
      failures:[
        {t:"A gateway node crashes with 50K live sockets",b:"50K connections drop mid-edit.",m:"Clients detect the dead heartbeat and auto-reconnect through the LB; no edits lost because the client re-sends its unacked tail and the collab service dedupes by (clientId, seq)."},
        {t:"A re-sent op after reconnect",b:"Risk of double-inserting a character.",m:"Every op carries (clientId, client-seq); the collab service ignores an already-applied seq idempotently and re-acks."},
        {t:"2M sockets at Monday-9am ramp",b:"A single node caps at ~50K.",m:"40+ nodes behind an L4 LB; autoscale on connection count with a warm floor so the ramp doesn't outrun provisioning."},
      ],
      tradeoffs:[
        {a:"Terminate the socket on the collab process",b:"Separate gateway + collab tiers",pick:"They scale on different axes — connections (huge, idle) vs active sessions/op throughput; splitting lets a client's socket survive a collab restart (just re-route) and holds cheap sockets separately from CPU work."},
        {a:"Size on op throughput",b:"Size on connection count",pick:"CPU-wise the gateway is thin (~1-2.5K ops/s even on a hot doc), but it can't <em>hold</em> more than ~50K live sockets in memory — connections are the real constraint."},
      ],
      probes:[
        "Why WebSockets and not HTTPS request/response, and what exactly lives in this box?",
        "2M live sockets at peak — how does this tier hold, and what's the broadcast cost on a busy 500-editor doc?",
        "A gateway node dies with 50K sockets — what do users experience, and how do you avoid double-applying a re-sent op?",
      ],
    },
    collab:{
      role:"The <strong>single authoritative session</strong> that owns a doc: it orders each op into the doc's total order, hands it to the engine, appends it durably, acks, then broadcasts. Its defining lever: <strong>one sequencer per doc</strong> imposes a single global order so every client provably converges — and it must be exactly one (fencing) to avoid split-brain.",
      capacity:[
        ["Sessions per node","~10K live sessions","per-doc work is tiny: transform + append + publish"],
        ["Concurrent sessions","~2M at peak → ~200 nodes","sized on concurrency, not the 50M-doc corpus"],
        ["Hot-doc op rate","~1-2.5K tiny ops/s","fits one core; fan-out offloaded to gateways/pub-sub"],
        ["Ack budget","&lt; 200ms for others to see an edit","local apply means the author feels nothing"],
      ],
      data:"Owns the live, in-memory session state for actively-edited docs — the materialized doc + a recent op window + per-client accepted-seq high-water marks — all a <strong>derived cache</strong> rehydratable from snapshot + op-log tail. Ownership is granted via a <strong>lease/consensus with a fencing epoch</strong> (consistent hashing on doc id).",
      scaling:[
        "<strong>Shard docs across the fleet</strong> by consistent hashing on doc id; ordering stays per-doc so hot docs never contend.",
        "Size by <strong>concurrent sessions</strong> — an idle doc owns no process; provision with ~30% headroom.",
        "<strong>Batch/pipeline appends</strong> so one quorum round-trip commits dozens of concurrent ops.",
        "Split a pathologically hot doc into per-section owners only when measurement demands it.",
      ],
      failures:[
        {t:"The owner of a 500-editor doc is OOM-killed after broadcasting ~3,000 ops",b:"Could those edits be lost?",m:"Ack + broadcast only <em>after</em> durable append, so nothing committed is lost; mid-flight (unacked) ops are re-sent by clients; a new owner is elected, rehydrates from snapshot + tail, resumes — ~1-3s stall."},
        {t:"A network partition splits 500 editors 300/200 for 90s",b:"Risk of two divergent op logs (split-brain).",m:"Lease + fencing epoch — only the majority side keeps a valid lease and stays writable; the minority goes read-only/buffered and replays on heal (the offline path). Consistency over write-availability for the minority."},
        {t:"An old owner returns thinking it still owns the doc",b:"Two writers.",m:"New owner writes under a higher epoch; the stale owner's writes are rejected and it steps down."},
      ],
      tradeoffs:[
        {a:"Central per-doc sequencer",b:"Peer-to-peer / no server",pick:"A central order means each op transforms only against a known, finite prefix — far simpler correct OT (Google Docs' choice); P2P forces CRDTs with extra metadata to converge without coordination."},
        {a:"Broadcast then persist",b:"Persist (quorum) then ack/broadcast",pick:"Broadcast-first can show users edits that vanish on recovery; durable-first costs a few ms (batched away) and is the only correct ordering for a document."},
      ],
      probes:[
        "Walk me through what collab does per op, and why a single central owner makes convergence easier.",
        "One process per doc with 50M docs — how do you place and scale owners without a global bottleneck?",
        "A partition splits your editors in two for 90s — what's the right behavior, and what must you never do?",
      ],
    },
    doc:{
      role:"The source-of-truth <strong>append-only op log</strong> per document (the doc at any version is the fold of its ops), plus periodic snapshots. Its defining lever: keying the log <code>(doc_id, seq)</code> so replaying a doc is a single-partition ordered range-scan — the cheap primitive the whole design leans on.",
      capacity:[
        ["Append rate","~120K ops/s avg, ~400-600K/s peak","each op ~50 bytes, sequential"],
        ["Raw log growth","~500 GB/day","~10B ops/day &times; ~50 bytes"],
        ["Fleet","~50 nodes","500K ÷ ~30K writes/node &times;3 replication; auto-shards by doc id"],
        ["Read shape","point read + short ordered range","snapshot pointer + op tail after seq S — no scans"],
      ],
      data:"Op log keyed <code>(doc_id, seq)</code> — doc_id partition key, seq clustering key — so a doc's ops sit contiguous and sorted on one partition. Snapshots in a separate small table <code>(doc_id, version)</code> holding a <strong>pointer</strong> to the folded blob in object storage + the fold-seq. Metadata + ACLs in a small relational/KV table where transactions matter.",
      scaling:[
        "Wide-column LSM store — appends fit the write shape, auto-shards by doc id with no global hotspot.",
        "<strong>Snapshots</strong> (every ~1,000 ops or 60s) bound open + recovery to O(recent), not full history.",
        "<strong>Compaction</strong>: once a snapshot at seq S is durable, archive + truncate log segments before S so the hot tier stays small.",
        "Push fat cold snapshot blobs to object storage; keep only tiny ordered rows hot.",
      ],
      failures:[
        {t:"A store node holding a 2M-op doc restarts",b:"Full replay = tens of seconds unavailable.",m:"Recover from latest snapshot + op tail (sub-second); the log is replicated with quorum, so a dead disk loses nothing."},
        {t:"A replication gap drops the last 40 acked ops",b:"The doc reverts 40 ops — users watch text disappear.",m:"Ack only after a write quorum — acked implies on a majority implies recoverable; recovery reconciles to the highest committed seq, never below what was acked."},
        {t:"A live 50M-op doc; replay takes minutes; storage balloons",b:"Growth + replay cost.",m:"Snapshots bound replay; compaction archives old segments to cold storage (archives, not deletes) so history stays available and the hot log tracks active docs."},
      ],
      tradeoffs:[
        {a:"Wide-column op log",b:"Postgres / Kafka-as-store",pick:"Wide-column matches append + single-partition range-scan at ~500K/s on ~50 nodes and auto-shards; Postgres' ~10-20K/node ceiling forces 30+ hand-managed shards + vacuum pain; Kafka is transport not random-access (partitions multiplex docs), so it earns the pub/sub role instead."},
        {a:"Snapshot blob as a wide-column cell",b:"Blob in object storage + pointer",pick:"Big blobs bloat SSTables and drag the range-scans the log depends on; object storage is purpose-built for write-once immutable blobs (11-nines, lifecycle tiering) — keep only a pointer + fold-seq in the log."},
      ],
      probes:[
        "Give me the data model — source of truth, SQL or NoSQL — and why keep the whole op log instead of overwriting current state?",
        "Pick the datastore for the op log against Postgres and Kafka, pinning the load first; where do snapshots live?",
        "A node loses the last 40 acked ops before a snapshot — users watch text disappear. Prevent it by construction.",
      ],
    },
    engine:{
      role:"The correctness heart: it <strong>transforms (OT)</strong> or <strong>merges (CRDT)</strong> each op against the concurrent ops ordered before it so every client converges to the identical document. Its defining lever: leaning on the central total order to keep OT transforms bounded and cheap.",
      capacity:[
        ["Per-op work","O(ops-behind), kept tiny","healthy clients are a few ops behind → O(handful)"],
        ["Hot-doc load","a few thousand cheap transforms/s","~1-2.5K ops/s, well within one core"],
        ["Live memory","current doc (~hundreds of KB) + recent op window","not full history"],
        ["Laggard case","client 2,000 ops behind","batch catch-up / fresh snapshot, not 2,000 live transforms"],
      ],
      data:"Holds derived, non-authoritative state co-located with the doc's collab owner — the materialized doc + pending-transform context + per-client accepted-seq marks. Fully reconstructible from snapshot + op-log tail, so it never needs to persist its own state to be correct after a crash.",
      scaling:[
        "Keep clients caught-up (continuous ordered push) so each transform is O(small).",
        "Catch a laggard up in a <strong>batch</strong> (compose missed ops) or hand it a fresh snapshot + short tail — never dribble 2,000 transforms through the hot path.",
        "Co-locate with the owner and hold state only for <strong>actively edited</strong> docs; memory scales with concurrent sessions.",
        "Rebase onto the current snapshot when a client's base predates compaction.",
      ],
      failures:[
        {t:"Two users insert at the same position on the same version",b:"Divergence — the classic corruption.",m:"OT transforms B's op against A's already-applied op (shift insert 3 → 4); CRDT gives each char a unique dense id — either way convergence is guaranteed."},
        {t:"The owner (holding engine state) restarts with 500 clients holding unacked ops",b:"Rebuild correct state without double-applying.",m:"Deterministic rebuild from snapshot + tail; clients re-send unacked ops; (clientId, seq) makes already-committed ops idempotent skips."},
        {t:"A client's base version was compacted away",b:"Can't transform against long-gone ops.",m:"Rebase the client onto the current snapshot + tail, then re-apply its unacked ops on top — the same large-divergence path."},
      ],
      tradeoffs:[
        {a:"OT (transform)",b:"CRDT (merge)",pick:"With a central server (already present for storage/auth) OT keeps ops tiny (just a position) and is Google-Docs-proven; CRDTs are conflict-free without coordination but pay in per-element ids + tombstones — reach for them for decentralized/long-offline P2P."},
        {a:"Transform a laggard op-by-op",b:"Batch catch-up / snapshot",pick:"O(ops-behind) per op melts the hot path for a 2,000-behind client; compose-and-catch-up or hand a fresh snapshot keeps steady state O(small)."},
      ],
      probes:[
        "Give me the mechanics of an OT transform and the TP1 property — why does the central order make it tractable?",
        "Explain CRDTs concretely — where they shine, and why not just use them everywhere?",
        "A reconnecting client is 2,000 ops behind while 500 clients fire ops — does the engine become the bottleneck?",
      ],
    },
    presence:{
      role:"The <strong>ephemeral live-state</strong> tier — cursors, selections, name/color, typing status. Its defining lever: playing by looser rules than the op log (no order, no durability, droppable) so cursor churn never touches or slows the correctness path for edits.",
      capacity:[
        ["Per-user emission","~5-10/s (throttled)","only on meaningful movement"],
        ["Naive fan-out","~2.5M msg/s on one 500-editor doc","500 &times; ~10 &times; 499 — dwarfs edits"],
        ["Coalesced fan-out","a few thousand batched msg/s","one snapshot per ~100-200ms tick"],
        ["Storage","a few hundred bytes per (doc,user), in-memory","2M editors &lt; 1 GB across the tier"],
      ],
      data:"A <strong>LWW value keyed (docId, userId)</strong> — last write wins, no merge — held only as the current value in memory with a short TTL. No durable state by design; the source of truth for 'where is my cursor' is the client, which re-announces on reconnect.",
      scaling:[
        "<strong>Throttle</strong> client emission + <strong>coalesce</strong> to the latest per user, flushed one batched snapshot per tick.",
        "Past a threshold, <strong>degrade to aggregate presence</strong> ('+N others editing') and viewport-scope updates — cosmetic, so shedding detail is free.",
        "Run stateless + horizontally scaled; shard freely and drop under load with zero consistency risk.",
        "TTL + heartbeat so a dead client's cursor auto-expires.",
      ],
      failures:[
        {t:"500 editors each move cursors ~10/s",b:"~2.5M msg/s N-squared fan-out.",m:"Throttle + coalesce to per-tick batched snapshots; degrade to aggregate presence + viewport scoping past a threshold."},
        {t:"The presence tier is down for 2 minutes",b:"No cursors/selections flow.",m:"Not a correctness incident — edits keep flowing untouched; client fails soft (freeze/fade cursors, never block typing); rebuilds trivially on recovery as clients re-announce."},
        {t:"A user closes the laptop lid without a clean disconnect",b:"A ghost cursor sits frozen forever.",m:"TTL refreshed by heartbeats (~10-15s); no heartbeat → entry expires and a 'user left' is broadcast; clean disconnect removes immediately."},
      ],
      tradeoffs:[
        {a:"Push cursors through the op stream",b:"Separate presence path",pick:"Mixing pollutes the durable ordered log with throwaway updates, bloats snapshots/replay, and wastes the engine on conflict-free data; a separate pipe lets you throttle/drop aggressively without risking edits."},
        {a:"Per-user cursor messages",b:"Batched per-tick snapshot",pick:"Per-user is N-squared; one batched snapshot per ~100-200ms tick turns 2.5M/s into a few thousand/s at the cost of ~100-200ms cursor latency (imperceptible)."},
      ],
      probes:[
        "Why can presence play by looser rules than the op log, and how is a cursor update represented/delivered differently?",
        "500 editors, ~10 cursor updates/s each — tame the ~2.5M msg/s fan-out.",
        "The presence tier dies for 2 minutes — is it a P1, and what do editors experience?",
      ],
    },
    persist:{
      role:"The durability layer: it makes 'acked implies never lost' true across a node <em>and</em> a whole-AZ loss, and folds the log into snapshots. Its defining lever: <strong>two tiers</strong> — a fast quorum-replicated hot log for live acks and cheap object storage for cold history — so durability never gates typing.",
      capacity:[
        ["Hot-log replication","3 nodes / 3 AZs, quorum writes","ack only after a majority persists"],
        ["Ack overhead","a few ms, batched","one quorum round-trip commits dozens of ops"],
        ["Snapshot cadence","every ~1,000 ops or 60s","+ on idle so cold-open is cheap"],
        ["Archive durability","~11 nines, cross-AZ","object storage, background writes"],
      ],
      data:"Owns the replicated hot log (recent ops) and the offsite tier (snapshots + sealed segments in object storage, referenced by versioned immutable keys). Truncates a hot-log segment only <em>after</em> its covering snapshot is confirmed durable — so data never exists only in a not-yet-consistent place.",
      scaling:[
        "<strong>Batch</strong> quorum appends so per-op durability overhead is small.",
        "Keep snapshotting + archival as <strong>background jobs</strong> off the hot path.",
        "Control growth: retain few snapshots, <strong>incremental/delta</strong> snapshots, compaction, and <strong>coarsening retention</strong> (fine recent ops → hourly → daily).",
        "Lifecycle-tier old segments into cheaper cold/glacier classes.",
      ],
      failures:[
        {t:"A single node — or a whole AZ — is lost",b:"Acked edits at risk.",m:"3-node/3-AZ quorum means any one node/AZ can die with zero loss of acked edits; snapshots + segments offsite in object storage cover the rest."},
        {t:"Object storage has a 30-min regional hiccup",b:"Snapshot/archive writes fail while editing continues.",m:"Editing never stalls — live durability is the quorum hot log; background jobs queue + retry with backoff; don't truncate any segment until its snapshot is confirmed durable (hold space for safety)."},
        {t:"Naive full-copy snapshot per 1,000 ops",b:"A busy 200KB doc generates GBs/day.",m:"Retain few snapshots, incremental/delta snapshots, compaction, coarsening retention, lifecycle tiering → O(current size + recent history)."},
      ],
      tradeoffs:[
        {a:"Object storage for snapshots/archives",b:"Database / block volumes",pick:"Big write-once blobs read rarely fit object storage (11-nines, cross-AZ, cheap per GB, lifecycle tiering); a DB wastes transactional machinery and bloats, block volumes are costly and capacity-capped."},
        {a:"Restore by deleting newer ops",b:"Restore as new appended ops",pick:"Rewriting history is a correctness hazard and breaks concurrent editing; compute the diff to seq S and append it as new ops so restore flows through the engine like any edit and stays auditable."},
      ],
      probes:[
        "Guarantee an acked edit survives any single node <em>and</em> a whole-AZ outage without killing latency — lay out the design.",
        "Object storage is slow and eventually consistent — does that hurt the write or recovery path?",
        "'Restore to 3pm yesterday' with op log + snapshots — how do you serve it precisely, and do you delete the newer ops?",
      ],
    },
  },
  dbDoc:{
    component:"Document / op-log store",
    load:"~120K op-appends/s average, ~400-600K/s at peak, each op tiny (~50 bytes). Reads are not scans: a read is a point lookup of the latest snapshot pointer plus a short ordered range-scan of the op tail after seq S for one doc, driven by opens and reconnect catch-ups. The raw log grows ~500GB/day and snapshots add a folded blob per doc periodically, so ~500K tiny ordered appends/s, cheap per-doc range reads, and unbounded growth are the real pressures.",
    candidates:[
      {name:"PostgreSQL (relational)",ceiling:"~10-20K small write txns/s per primary",nodes:"~30+ write shards for 500K/s, hand-sharded across 50M doc keys; autovacuum fights a hot append table",pick:false,note:"per-doc ordering and transactions come free, but the write ceiling forces 30+ manually-managed shards and vacuum pressure on a write-heavy append table — the ops tax loses."},
      {name:"Kafka (append-only log)",ceiling:"~100K+ msgs/s per partition, hundreds of K per broker",nodes:"~500K/s across a few hundred partitions &approx; a handful of brokers",pick:false,note:"superb append throughput, but it is transport not random-access: partitions multiplex docs, so reading one doc tail from seq S or seeking a historical seq means scanning/offset-mapping. It earns the pub/sub fan-out role instead of being the store."},
      {name:"Cassandra / Bigtable (wide-column)",ceiling:"~20-50K LSM writes/s per node",nodes:"500K &divide; ~30K &approx; ~17 nodes, &times;3 replication &approx; <strong>~50 nodes</strong>; auto-shards on the partition key",pick:true,note:"chosen — LSM appends fit the write shape, it auto-shards by doc id with no global hotspot, and per-partition replication gives the quorum durability the design already requires."},
    ],
    indexing:"The op log is keyed <code>(doc_id, seq)</code> — <strong>doc_id as the partition key, seq as the clustering/sort key</strong> — so every doc's ops sit contiguous and already sorted on one partition. Replaying doc X from seq S is a <strong>single-partition ordered range-scan</strong> over a contiguous slice: sequential IO, no fan-out, no cross-partition merge, no secondary index. Appends write the tail of a partition; reads slice the tail by seq range. Snapshots live in a separate small table keyed <code>(doc_id, version)</code> holding a <strong>pointer</strong> (the object-storage URL of the folded blob) plus the seq it folds up to, so open does one point read for the newest pointer, fetches the blob, then range-scans the ops after that seq.",
    decision:"Pick a <strong>wide-column store keyed <code>(doc_id, seq)</code></strong> (Cassandra / Bigtable) as the source-of-truth op log: it matches the access pattern exactly (append plus ordered single-partition range-scan per doc), hits ~500K appends/s at ~50 nodes, auto-shards by doc id with no global hotspot, and replicates per-partition for the quorum durability I already require. <strong>Not Postgres:</strong> its ~10-20K/node write ceiling forces 30+ hand-managed shards and autovacuum fights a write-heavy append table. <strong>Not Kafka as the store:</strong> unbeatable append throughput but it is transport, not random-access — arbitrary per-doc seq reads and history seeks are clumsy when partitions multiplex docs; Kafka still earns the <strong>pub/sub fan-out</strong> role. The fat, cold <strong>snapshot blobs go to an object / blob store</strong> (S3-class, 11-nines), referenced only by a pointer + fold-seq from the log tier, so the hot append path stays lean and cold history stays cheap. Doc metadata + ACLs live in a small relational/KV table where transactions matter.",
  },
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
  deepFlows:[
    {id:"edit-e2e",name:"Commit and broadcast an edit",summary:"Client applies locally → sends a **WebSocket edit op** with <code>doc_id</code>, <code>baseVersion</code>, and client seq → gateway routes by <code>doc_id</code> → the doc's **single authoritative owner** transforms/merges → assigns the next <code>seq</code> → appends to <code>operations(doc_id, seq)</code> with quorum replication → acks + broadcasts the ordered op so every replica converges.",steps:[
      {node:"client",title:"Client turns a keystroke into an op",snap:{cap:"Local-first state advances only in the browser: user 42 sees the character immediately, while the durable server is still at <code>seq=10432</code>. The unacked client op carries <code>baseVersion=10432</code> and <code>client_seq=187</code> so reconnects can retry safely.",tables:[{name:"documents (server read model)",cols:["doc_id","current_version","title"],rows:[{c:["d-1a2b","10432","Q3 Planning Notes"],hi:1,tag:"base read"}]},{name:"client unacked ops (tab-42-a7f)",cols:["doc_id","client_seq","baseVersion","op_json"],rows:[{c:["d-1a2b","187","10432","{kind:insert,pos:120,text:h}"],hi:1,tag:"queued locally"}]}]},narrate:"Typing must feel instant, so the browser applies the character to its local replica before the network round-trip. It also records the op in its unacknowledged queue, tagged with the server version it was based on and a client sequence number for retry dedupe.",details:[
        {k:"wire",label:"WebSocket message",lang:"json",code:"{\n  \"type\": \"edit.op\",\n  \"doc_id\": \"d-1a2b\",\n  \"client_id\": \"tab-42-a7f\",\n  \"client_seq\": 187,\n  \"baseVersion\": 10432,\n  \"op\": { \"kind\": \"insert\", \"pos\": 120, \"text\": \"h\" }\n}"},
        {k:"note",label:"Why local-first",text:"Waiting for a server ack per key would show each character ~100-200ms late. Local-first keeps typing instant; the cost is that the local op may be rebased when concurrent ops arrive from the authoritative stream."},
      ]},
      {node:"gw",title:"Gateway routes by document id",snap:{cap:"No document mutation yet. The gateway uses <code>doc_id=d-1a2b</code> as the routing key so this edit lands on the one live sequencer for the document, while the op remains uncommitted.",tables:[{name:"gateway socket map",cols:["connection_id","doc_id","user_id","owner"],rows:[{c:["conn-8f2","d-1a2b","42","collab-17 epoch 91"],hi:1,tag:"routed"}]},{name:"documents",cols:["doc_id","current_version"],rows:[{c:["d-1a2b","10432"],tag:"no mutation"}]}]},narrate:"The WebSocket gateway owns the socket and auth state, but not the document order. It uses <code>doc_id</code> to forward the op to exactly the collab owner for this live document session.",details:[
        {k:"route",label:"Owner lookup",lang:"python",code:"# consistent hash / placement service returns one live owner\nowner = placement.owner_for_doc(\"d-1a2b\")   # e.g. collab-17, epoch 91\nsend(owner, ws_message)"},
        {k:"route",label:"Why route by doc_id",text:"Ordering is per document, so every op for <code>d-1a2b</code> must reach the same live sequencer. Routing by user or gateway would split one doc across processes and create competing orders."},
      ]},
      {node:"collab",title:"One authoritative owner sequences the doc",snap:{cap:"The owner accepts the socket only after ACL verification, dedupes <code>(client_id,client_seq)</code>, and keeps the document under one fencing epoch. A concurrent editor has already advanced the committed prefix to <code>10433</code>, so this op will be rebased before sequencing.",tables:[{name:"acl",cols:["doc_id","user_id","role"],rows:[{c:["d-1a2b","42","editor"],hi:1,tag:"authorized"},{c:["d-1a2b","55","viewer"]}]},{name:"operations (recent committed prefix)",cols:["doc_id","seq","author_id","op_json","created_at"],rows:[{c:["d-1a2b","10432","7","{op:delete,pos:88}","10:15:03Z"]},{c:["d-1a2b","10433","7","{kind:insert,pos:80,text:X}","10:15:04Z"],hi:1,tag:"concurrent first"}]}]},narrate:"The collab process holds the valid lease/fencing epoch for <code>d-1a2b</code>. It checks the user can edit, dedupes a retry using the client sequence, and rejects stale-owner writes with the fencing epoch so there is never split-brain for one document.",details:[
        {k:"query",label:"ACL check uses the actual ACL table",lang:"sql",code:"SELECT role\nFROM acl\nWHERE doc_id = 'd-1a2b' AND user_id = 42;\n-- role must be 'editor' before accepting edit.op"},
        {k:"repl",label:"Single writer invariant",text:"Exactly one owner holds the current lease for <code>doc_id='d-1a2b'</code>. If a new owner is elected it writes under a higher epoch; stale owners are fenced off before they can append divergent ops."},
      ]},
      {node:"engine",title:"Transform or merge against concurrent ops",snap:{cap:"The engine rebases the local insert from <code>pos=120</code> to <code>pos=121</code> because seq 10433 inserted before it. No new durable row is written yet; this is a deterministic rewrite before append.",tables:[{name:"operations (transform context)",cols:["doc_id","seq","author_id","op_json","created_at"],rows:[{c:["d-1a2b","10433","7","{kind:insert,pos:80,text:X}","10:15:04Z"],hi:1,tag:"rebases op"}]},{name:"pending transformed op",cols:["doc_id","baseVersion","author_id","op_json"],rows:[{c:["d-1a2b","10432&rarr;10433","42","{kind:insert,pos:121,text:h}"],hi:1,tag:"position shifted"}]}]},narrate:"The incoming op was authored at <code>baseVersion=10432</code>. If the owner has already committed seq 10433, the engine rewrites the position (OT) or merges element ids (CRDT) so the user's intent lands on the current document.",details:[
        {k:"note",label:"OT example",text:"If another editor inserted one character before position 120 at seq 10433, this insert's position shifts from 120 to 121 before commit. Every client later applies the same ordered result, so replicas converge."},
        {k:"gotcha",label:"OT vs CRDT trade-off",text:"With this central server, OT keeps ops tiny (<code>pos + text</code>) and transforms against a bounded ordered prefix. CRDTs tolerate decentralized/offline-heavy merging better, but pay per-character ids, tombstones, and garbage-collection overhead."},
      ]},
      {node:"collab",title:"Assign the next document sequence",snap:{cap:"The per-doc sequencer moves the document from <code>n=10433</code> to <code>n+1=10434</code>. This is like a partition-of-one offset for <code>d-1a2b</code>: there is no global order across docs, only a total order inside this doc.",tables:[{name:"documents",cols:["doc_id","owner_id","title","current_version","created_at"],rows:[{c:["d-1a2b","42","Q3 Planning Notes","10433 &rarr; 10434","2026-07-20 09:00:00"],hi:1,tag:"next_seq"}]},{name:"sequencer state (collab-17)",cols:["doc_id","last_seq","next_seq","epoch"],rows:[{c:["d-1a2b","10433","10434","91"],hi:1,tag:"allocated"}]}]},narrate:"After conflict resolution, the owner stamps the op with the next total-order sequence for this document. For the sample doc, a concurrent op has advanced <code>documents.current_version</code> to 10433, so the next committed op is seq 10434.",details:[
        {k:"query",label:"Current version row",lang:"sql",code:"SELECT current_version\nFROM documents\nWHERE doc_id = 'd-1a2b';\n-- 10433 -> owner assigns next_seq = 10434"},
        {k:"note",label:"Why one seq per doc",text:"The <code>seq</code> is meaningful only inside a document. That is enough: convergence requires all editors of <code>d-1a2b</code> apply ops 1,2,3... in the same order, not a global order across all 50M docs."},
        {k:"queue",label:"Per-doc ordering as a partition-of-one",lang:"python",code:"# not Kafka: this is the DB op log\nlast = documents['d-1a2b'].current_version   # 10433\nnext_seq = last + 1                            # 10434\n# exactly one fenced owner may allocate next_seq for this doc"},
      ]},
      {node:"doc",title:"Append to the op log keyed (doc_id, seq)",snap:{cap:"The heart of the system: append one immutable row at <code>operations(doc_id=d-1a2b, seq=10434)</code> and advance the document pointer to 10434. This is an ordered DB log, not Kafka: reads later range-scan by <code>seq</code>.",tables:[{name:"operations (op log · doc d-1a2b)",cols:["doc_id","seq","author_id","op_json","created_at"],rows:[{c:["d-1a2b","10433","7","{kind:insert,pos:80,text:X}","10:15:04Z"]},{c:["d-1a2b","10434","42","{kind:insert,pos:121,text:h}","10:15:04Z"],hi:1,tag:"appended"}]},{name:"documents",cols:["doc_id","current_version"],rows:[{c:["d-1a2b","10434"],hi:1,tag:"pointer advanced"}]}]},narrate:"The ordered op is persisted as an immutable row in <code>operations</code>. The partition key is <code>doc_id</code> and the clustering key is <code>seq</code>, so all ops for this document are contiguous and replayable by a single ordered range scan.",details:[
        {k:"query",label:"Append row using gdocs schema columns",lang:"sql",code:"INSERT INTO operations\n  (doc_id, seq, author_id, op_json, created_at)\nVALUES\n  ('d-1a2b', 10434, 42,\n   '{\"client_id\":\"tab-42-a7f\",\"client_seq\":187,\n     \"kind\":\"insert\",\"pos\":121,\"text\":\"h\"}',\n   now());\n\nUPDATE documents\nSET current_version = 10434\nWHERE doc_id = 'd-1a2b' AND current_version = 10433;"},
        {k:"route",label:"Storage partition",text:"In the wide-column store, <code>doc_id='d-1a2b'</code> chooses the partition/replica group; <code>seq=10434</code> sorts inside that partition. A single hot doc is intentionally pinned to one partition/owner to preserve ordering."},
        {k:"queue",label:"Append-only DB log mechanics",lang:"python",code:"# operations is the ordered log keyed by (doc_id, seq)\nappend({doc_id: 'd-1a2b', seq: 10434, op: transformed})\n# rows are never consumed or deleted by readers; open/recovery range-scan\n# WHERE doc_id = 'd-1a2b' AND seq > snapshot_version ORDER BY seq"},
      ]},
      {node:"persist",title:"Quorum replication makes acked edits durable",snap:{cap:"The append is acknowledged only after W=2 of N=3 replicas have the row. Losing one node or AZ after this point cannot roll the document below seq 10434.",tables:[{name:"operations replica set (doc partition d-1a2b)",cols:["replica","role","has seq 10434?","ack"],rows:[{c:["az-a/r1","leader","yes fsync","yes"],hi:1,tag:"W1"},{c:["az-b/r2","follower","yes fsync","yes"],hi:1,tag:"W2 quorum"},{c:["az-c/r3","follower","catching up","no"]}]},{name:"operations",cols:["doc_id","seq","author_id","op_json","created_at"],rows:[{c:["d-1a2b","10434","42","{kind:insert,pos:121,text:h}","10:15:04Z"],hi:1,tag:"durable"}]}]},narrate:"The append is acknowledged only after the replicated log commits to a quorum, e.g. W=2 of 3 replicas across AZs. That closes the dangerous window where users see an edit that exists on only one failed node.",details:[
        {k:"repl",label:"Commit rule",lang:"text",code:"append operations(d-1a2b,10434)\n   │\n   ▼\n[replica A / leader] fsync ✔\n   ├────────────► [replica B] fsync ✔  (quorum reached)\n   └────────────► [replica C] async catch-up\n\nACK only after A+B have the row"},
        {k:"repl",label:"Guarantee",text:"Acked implies present on a majority, so losing any one node or one AZ does not roll the document back below a version that editors already saw as saved."},
      ]},
      {node:"collab",title:"Ack author and broadcast to collaborators",snap:{cap:"Now the author can be acked and all gateways can fan out the same ordered op. Durable-first means collaborators never see text that later disappears after an owner crash.",tables:[{name:"operations",cols:["doc_id","seq","author_id","op_json","created_at"],rows:[{c:["d-1a2b","10434","42","{kind:insert,pos:121,text:h}","10:15:04Z"],hi:1,tag:"broadcastable"}]},{name:"gateway fanout map",cols:["doc_id","gateway","local_sockets","last_sent_seq"],rows:[{c:["d-1a2b","gw-04","143","10434"],hi:1,tag:"sent"},{c:["d-1a2b","gw-11","87","10434"]}]}]},narrate:"Only after durable append does the owner ack the author and publish the accepted, transformed op once to the doc's pub/sub channel. Gateways subscribed for this doc fan it out to their local sockets.",details:[
        {k:"wire",label:"Ack + broadcast payload",lang:"json",code:"{\n  \"type\": \"edit.accepted\",\n  \"doc_id\": \"d-1a2b\",\n  \"seq\": 10434,\n  \"author_id\": 42,\n  \"op\": { \"kind\": \"insert\", \"pos\": 121, \"text\": \"h\" },\n  \"current_version\": 10434\n}"},
        {k:"gotcha",label:"Why not broadcast first",text:"Broadcast-first can show 500 editors text that vanishes if the owner crashes before persistence. Durable-first adds a few ms, batched across ~1-2.5K ops/s on a hot doc, and preserves the saved-edit invariant."},
      ]},
      {node:"client",title:"Other clients apply the ordered op",snap:{cap:"Every client applies seq 10434 after seq 10433, so replicas converge even if network delivery order differs. Laggards can later ask for <code>operations WHERE seq &gt; last_seen</code>.",tables:[{name:"client replicas",cols:["client","doc_id","last_seen_seq","state"],rows:[{c:["tab-7-b2","d-1a2b","10434","applied ordered op"],hi:1,tag:"caught up"},{c:["tab-55-c9","d-1a2b","10434","viewer updated"]}]},{name:"operations",cols:["doc_id","seq","author_id","op_json","created_at"],rows:[{c:["d-1a2b","10434","42","{kind:insert,pos:121,text:h}","10:15:04Z"],hi:1,tag:"folded by clients"}]}]},narrate:"Every collaborator receives seq 10434 and applies it after 10433. If they have local unacked ops, they transform those local ops against the remote op; if they reconnect later, they request the missing seq range.",details:[
        {k:"note",label:"Convergence",text:"The central owner plus OT/CRDT means all clients eventually fold the same ordered op set for <code>d-1a2b</code>. Arrival order can differ at the network edge; committed sequence order cannot."},
      ]},
    ]},

    {id:"open-e2e",name:"Open and catch up a document",summary:"Client opens <code>d-1a2b</code> → gateway authenticates → route to the doc's current owner → owner verifies <code>acl</code> → read newest <code>snapshots(doc_id, version)</code> pointer → range-scan <code>operations</code> after that version → fold snapshot + tail → subscribe the socket to live ops from the same sequencer.",steps:[
      {node:"client",title:"Client opens a document",snap:{cap:"Read-only open: the client requests current state for <code>d-1a2b</code>; nothing mutates. The server version in metadata is 10432, but open will start from the newest snapshot and fold only the tail.",tables:[{name:"documents (read)",cols:["doc_id","owner_id","title","current_version","created_at"],rows:[{c:["d-1a2b","42","Q3 Planning Notes","10432","2026-07-20 09:00:00"],hi:1,tag:"read · no mutation"}]}]},narrate:"Opening a large doc must not replay a multi-million-op history. The client asks for the latest materialized state plus whatever tail is needed after that snapshot.",details:[
        {k:"wire",label:"Open request",lang:"http",code:"GET /v1/docs/d-1a2b/open\nX-User-Id: 55\n\n# or the same request as the first WebSocket message:\n# {\"type\":\"doc.open\",\"doc_id\":\"d-1a2b\",\"last_seen_seq\":10420}"},
        {k:"note",label:"Back-of-envelope pressure",text:"A 500-page doc can have 2M historical ops, but the hot open path should read the latest snapshot plus a short tail — O(recent), not O(history)."},
      ]},
      {node:"gw",title:"Authenticate and route to the doc owner",snap:{cap:"The gateway authenticates user 55 and routes the open to the same live owner that will sequence future ops. Still no document mutation.",tables:[{name:"gateway routing",cols:["connection_id","user_id","doc_id","owner"],rows:[{c:["conn-55-d4","55","d-1a2b","collab-17 epoch 91"],hi:1,tag:"routed"}]},{name:"documents",cols:["doc_id","current_version"],rows:[{c:["d-1a2b","10432"],tag:"no mutation"}]}]},narrate:"The gateway validates the user token and establishes the socket, then routes the open to the collab process currently owning <code>d-1a2b</code>.",details:[
        {k:"route",label:"Same routing as edits",lang:"python",code:"doc_id = \"d-1a2b\"\nowner = placement.owner_for_doc(doc_id)\nsubscribe_socket_to_doc(connection_id, doc_id)\nforward(owner, {\"type\":\"doc.open\", \"doc_id\": doc_id})"},
        {k:"route",label:"Why pin open and edit together",text:"The process that serves the snapshot tail also owns subsequent sequencing, so the client never races between an old snapshot source and a different live writer."},
      ]},
      {node:"collab",title:"Check access before joining the live session",snap:{cap:"ACL read grants user 55 viewer access. The user may receive content and live ops but cannot submit edits unless the role is <code>editor</code>.",tables:[{name:"acl",cols:["doc_id","user_id","role"],rows:[{c:["d-1a2b","42","editor"]},{c:["d-1a2b","55","viewer"],hi:1,tag:"allowed to open"}]}]},narrate:"The collab owner verifies the user has at least viewer access before it sends content or subscribes them to broadcasts. Editors are later allowed to submit ops; viewers can only receive.",details:[
        {k:"query",label:"ACL read",lang:"sql",code:"SELECT role\nFROM acl\nWHERE doc_id = 'd-1a2b' AND user_id = 55;\n-- 'viewer' can open and receive ops; only 'editor' can send edit.op"},
        {k:"gotcha",label:"Revocation",text:"ACL is not a one-time page-load check. A revoke event causes the owner to drop/downgrade the socket, and every later edit op is authorized again server-side."},
      ]},
      {node:"doc",title:"Read the latest snapshot pointer",snap:{cap:"Point-read the newest <code>snapshots</code> row for this doc. This is a read only: it returns version 10000 and a blob pointer, with no mutation to metadata or log.",tables:[{name:"snapshots (read latest)",cols:["doc_id","version","content_blob_url","created_at"],rows:[{c:["d-1a2b","10000","s3://docs/d-1a2b/v10000.blob","2026-07-22 10:00:00"],hi:1,tag:"hi · no mutation"},{c:["d-3c4d","250","s3://docs/d-3c4d/v250.blob","2026-07-21 14:00:00"]}]}]},narrate:"Snapshots are indexed by <code>(doc_id, version)</code>. The owner point-reads the highest version for the doc; the sample data has a snapshot at version 10000 for <code>d-1a2b</code>.",details:[
        {k:"query",label:"Snapshot lookup",lang:"sql",code:"SELECT version, content_blob_url\nFROM snapshots\nWHERE doc_id = 'd-1a2b'\nORDER BY version DESC\nLIMIT 1;\n-- version=10000, content_blob_url='s3://docs/d-1a2b/v10000.blob'"},
        {k:"route",label:"Why snapshots are separate",text:"The wide-column log stays lean with tiny ordered rows; the folded document blob lives in object storage and the hot store keeps only <code>content_blob_url</code> plus the fold version."},
      ]},
      {node:"persist",title:"Fetch the folded blob from object storage",snap:{cap:"The hot store is unchanged; the snapshot row points at an immutable object-storage blob. Fetching the blob avoids replaying ops 1..10000.",tables:[{name:"snapshots",cols:["doc_id","version","content_blob_url","created_at"],rows:[{c:["d-1a2b","10000","s3://docs/d-1a2b/v10000.blob","2026-07-22 10:00:00"],hi:1,tag:"blob fetched"}]},{name:"object storage blob",cols:["key","version","state"],rows:[{c:["s3://docs/d-1a2b/v10000.blob","10000","read immutable content"],hi:1,tag:"no mutation"}]}]},narrate:"The folded snapshot is a large immutable blob, read whole and rarely. Object storage is the right tier for it; it is not in the hot op-log rows.",details:[
        {k:"wire",label:"Blob read",lang:"text",code:"GET s3://docs/d-1a2b/v10000.blob\n-> materialized document content at seq 10000"},
        {k:"note",label:"Latency trade-off",text:"A cold blob read may be slower than a DB row, but it replaces replaying 10,000+ historical ops. Active docs keep the materialized state in the collab owner, so most opens are warm."},
      ]},
      {node:"doc",title:"Range-scan the op tail after the snapshot",snap:{cap:"Range scan reads <code>10001..10432</code> from the ordered <code>operations</code> partition for one doc. It has a high-water cap at current_version 10432 and does not append or mutate anything.",tables:[{name:"operations (tail read · doc d-1a2b)",cols:["doc_id","seq","author_id","op_json","created_at"],rows:[{c:["d-1a2b","10001","42","{kind:insert,pos:1,text:Q}","10:00:01Z"],tag:"tail start"},{c:["d-1a2b","10431","42","{op:insert,pos:120,char:h}","10:15:03Z"]},{c:["d-1a2b","10432","7","{op:delete,pos:88}","10:15:03Z"],hi:1,tag:"tail cap 10432"}]},{name:"documents",cols:["doc_id","current_version"],rows:[{c:["d-1a2b","10432"],hi:1,tag:"read cap"}]}]},narrate:"The owner reads only ops with <code>seq &gt; 10000</code>, already sorted because <code>seq</code> is the clustering key under the <code>doc_id</code> partition.",details:[
        {k:"query",label:"Tail read",lang:"sql",code:"SELECT seq, author_id, op_json, created_at\nFROM operations\nWHERE doc_id = 'd-1a2b' AND seq > 10000\nORDER BY seq ASC;\n-- returns 10001..10432 for the sample current_version"},
        {k:"route",label:"Single-partition range scan",text:"This is the critical data-model win: no global scan, no secondary index, no cross-shard merge. One doc's ordered log lives under one <code>doc_id</code> partition."},
      ]},
      {node:"engine",title:"Fold snapshot + tail into current state",snap:{cap:"The engine deterministically applies 432 tail ops to the version-10000 blob and materializes version 10432. This creates a live cache for the session, not a new durable row.",tables:[{name:"documents",cols:["doc_id","owner_id","title","current_version","created_at"],rows:[{c:["d-1a2b","42","Q3 Planning Notes","10432","2026-07-20 09:00:00"],hi:1,tag:"fold target"}]},{name:"materialized session cache",cols:["doc_id","snapshot_version","tail_ops","materialized_version"],rows:[{c:["d-1a2b","10000","432","10432"],hi:1,tag:"rebuilt"}]}]},narrate:"The engine applies ops 10001..10432 to the snapshot blob and reconstructs the exact current document at <code>documents.current_version=10432</code>. This state is cached while the doc remains live.",details:[
        {k:"query",label:"Metadata sanity check",lang:"sql",code:"SELECT title, current_version\nFROM documents\nWHERE doc_id = 'd-1a2b';\n-- title='Q3 Planning Notes', current_version=10432"},
        {k:"note",label:"Recovery symmetry",text:"Owner crash recovery uses the same path: latest snapshot + op tail deterministically rebuilds materialized doc and recent transform context."},
      ]},
      {node:"presence",title:"Join live presence separately",snap:{cap:"Presence joins outside the durable log. User 55 receives current cursor values and starts a TTL-backed presence entry; dropping this state cannot corrupt the document.",tables:[{name:"presence current values",cols:["doc_id","user_id","role","ttl"],rows:[{c:["d-1a2b","42","editor cursor pos 120","12s"]},{c:["d-1a2b","55","viewer joined","15s"],hi:1,tag:"ephemeral"}]},{name:"operations",cols:["doc_id","seq","author_id","op_json","created_at"],rows:[{c:["d-1a2b","10432","7","{op:delete,pos:88}","10:15:03Z"],tag:"unchanged"}]}]},narrate:"Presence is loaded as current ephemeral state, not from the op log. The new client receives a coalesced cursor snapshot and starts publishing its own cursor updates on the presence path.",details:[
        {k:"note",label:"Different guarantees",text:"Cursor state is a LWW value keyed by <code>(docId,userId)</code> with TTL. It can be dropped or coalesced; edit ops cannot."},
      ]},
      {node:"client",title:"Render and subscribe to live ops",snap:{cap:"The client now renders version 10432 and subscribes to future ordered ops from the same owner. The durable state is unchanged; only the live subscription cursor is established.",tables:[{name:"client session",cols:["user_id","doc_id","last_seen_seq","subscription"],rows:[{c:["55","d-1a2b","10432","live ops from collab-17"],hi:1,tag:"subscribed"}]},{name:"documents",cols:["doc_id","current_version"],rows:[{c:["d-1a2b","10432"],hi:1,tag:"rendered"}]}]},narrate:"The client renders the materialized doc, sets its last seen server version to 10432, and then applies subsequent ordered broadcasts from the same doc owner.",details:[
        {k:"wire",label:"Open response",lang:"json",code:"{\n  \"doc_id\": \"d-1a2b\",\n  \"title\": \"Q3 Planning Notes\",\n  \"version\": 10432,\n  \"snapshotVersion\": 10000,\n  \"content\": \"<folded document content>\",\n  \"tailApplied\": 432\n}"},
        {k:"gotcha",label:"Laggard catch-up",text:"If the client reconnects with <code>last_seen_seq=10420</code>, the owner can send only 10421..10432. If that base was compacted away, it sends a fresh snapshot + short tail instead."},
      ]},
    ]},

    {id:"snapshot-e2e",name:"Snapshot and compact history",summary:"Background persistence watches <code>documents.current_version</code> → every ~1,000 ops or 60s folds a stable prefix of <code>operations(doc_id, seq)</code> → writes immutable snapshot blob → inserts <code>snapshots(doc_id, version, content_blob_url)</code> → only after durable snapshot/archive trims hot log segments before that version.",steps:[
      {node:"persist",title:"Pick a safe snapshot boundary",snap:{cap:"Background snapshotting picks a committed boundary, never an in-flight op. For <code>d-1a2b</code>, current_version 10432 becomes the safe fold target.",tables:[{name:"documents",cols:["doc_id","owner_id","title","current_version","created_at"],rows:[{c:["d-1a2b","42","Q3 Planning Notes","10432","2026-07-20 09:00:00"],hi:1,tag:"snapshot boundary"}]},{name:"snapshots",cols:["doc_id","version","content_blob_url","created_at"],rows:[{c:["d-1a2b","10000","s3://docs/d-1a2b/v10000.blob","2026-07-22 10:00:00"],tag:"previous"}]}]},narrate:"Snapshotting is off the hot edit path. A background worker chooses a stable sequence already committed to the quorum log — for an active doc, roughly every 1,000 ops or 60 seconds, plus when the doc goes idle.",details:[
        {k:"query",label:"Find current committed version",lang:"sql",code:"SELECT current_version\nFROM documents\nWHERE doc_id = 'd-1a2b';\n-- current_version = 10432; choose snapshot_version = 10432"},
        {k:"note",label:"Cadence",text:"Every ~1,000 ops or 60s bounds open/recovery replay while keeping snapshot cost background-only. A 500-editor doc at ~1-2.5K ops/s may snapshot often; most docs are far quieter."},
      ]},
      {node:"doc",title:"Read the previous snapshot and committed tail",snap:{cap:"The snapshotter reads the previous pointer plus committed ops <code>10001..10432</code>. This is a bounded single-doc range; no user-visible state changes yet.",tables:[{name:"snapshots (previous)",cols:["doc_id","version","content_blob_url","created_at"],rows:[{c:["d-1a2b","10000","s3://docs/d-1a2b/v10000.blob","2026-07-22 10:00:00"],hi:1,tag:"fold base"}]},{name:"operations (committed fold tail)",cols:["doc_id","seq","author_id","op_json","created_at"],rows:[{c:["d-1a2b","10001","42","{kind:insert,pos:1,text:Q}","10:00:01Z"],tag:"tail start"},{c:["d-1a2b","10432","7","{op:delete,pos:88}","10:15:03Z"],hi:1,tag:"tail end"}]}]},narrate:"The snapshotter folds from the latest existing snapshot (10000 in the sample) through a committed target version (10432). It reads exactly one doc partition and never scans other documents.",details:[
        {k:"query",label:"Rows to fold",lang:"sql",code:"SELECT version, content_blob_url\nFROM snapshots\nWHERE doc_id = 'd-1a2b'\nORDER BY version DESC\nLIMIT 1;\n\nSELECT seq, author_id, op_json, created_at\nFROM operations\nWHERE doc_id = 'd-1a2b'\n  AND seq > 10000 AND seq <= 10432\nORDER BY seq ASC;"},
        {k:"route",label:"Why shard by document_id",text:"Snapshotting needs an ordered prefix for one document. With <code>doc_id</code> as the partition key, fold work is local and sequential; sharding by time would scatter one doc's history and make snapshots expensive."},
      ]},
      {node:"engine",title:"Fold ops deterministically",snap:{cap:"Replay is deterministic, not conflict resolution: the ops are already transformed and sequenced. Any worker folding v10000 plus 10001..10432 must produce the same bytes for v10432.",tables:[{name:"snapshot build workspace",cols:["doc_id","base_version","tail_range","candidate_version"],rows:[{c:["d-1a2b","10000","10001..10432","10432"],hi:1,tag:"folded"}]},{name:"operations",cols:["doc_id","seq","author_id","op_json","created_at"],rows:[{c:["d-1a2b","10432","7","{op:delete,pos:88}","10:15:03Z"],hi:1,tag:"last folded op"}]}]},narrate:"The same deterministic apply logic used for open/recovery folds ops 10001..10432 onto the version-10000 blob. Because those ops are already transformed and committed in seq order, this is not conflict resolution again — just replay.",details:[
        {k:"note",label:"Determinism matters",text:"If any replica folds the same snapshot plus the same ordered op range, it must produce byte-equivalent content. That makes snapshot verification and owner recovery straightforward."},
      ]},
      {node:"persist",title:"Write the immutable snapshot blob",snap:{cap:"The new folded content is written as an immutable object <code>v10432.blob</code>. The hot snapshot pointer is not inserted until this blob is durable.",tables:[{name:"object storage snapshots",cols:["key","doc_id","version","state"],rows:[{c:["s3://docs/d-1a2b/v10432.blob","d-1a2b","10432","durable etag ok"],hi:1,tag:"blob written"}]},{name:"snapshots",cols:["doc_id","version","content_blob_url","created_at"],rows:[{c:["d-1a2b","10000","s3://docs/d-1a2b/v10000.blob","2026-07-22 10:00:00"],tag:"pointer still old"}]}]},narrate:"The folded document is written to object storage under a versioned key. The blob write must complete durably before the snapshot pointer is advertised in the hot store.",details:[
        {k:"wire",label:"Object-store write",lang:"text",code:"PUT s3://docs/d-1a2b/v10432.blob\nBody: <folded document content through seq 10432>\n\n# object store returns durable version/etag"},
        {k:"repl",label:"Durability tiering",text:"The hot log gives low-latency quorum durability for live edits; object storage gives cheap 11-nines-style durability for large cold blobs and archived log segments."},
      ]},
      {node:"doc",title:"Insert the snapshot pointer",snap:{cap:"After the blob is durable, the hot store gets a tiny pointer row for <code>snapshots(d-1a2b,10432)</code>. Future opens can start at 10432 instead of 10000.",tables:[{name:"snapshots",cols:["doc_id","version","content_blob_url","created_at"],rows:[{c:["d-1a2b","10000","s3://docs/d-1a2b/v10000.blob","2026-07-22 10:00:00"]},{c:["d-1a2b","10432","s3://docs/d-1a2b/v10432.blob","2026-07-22 10:16:00"],hi:1,tag:"pointer inserted"}]}]},narrate:"After the blob is durable, the snapshotter records a small pointer row using the real <code>snapshots</code> schema. Future opens can now start at 10432 instead of 10000.",details:[
        {k:"query",label:"Snapshot pointer row",lang:"sql",code:"INSERT INTO snapshots\n  (doc_id, version, content_blob_url, created_at)\nVALUES\n  ('d-1a2b', 10432,\n   's3://docs/d-1a2b/v10432.blob', now());"},
        {k:"gotcha",label:"Pointer after blob, not before",text:"Publishing the pointer first could make an opener fetch a missing or partial blob. Blob first, pointer second keeps snapshot lookup safe."},
      ]},
      {node:"persist",title:"Archive then compact old hot-log segments",snap:{cap:"Only after the covering snapshot and archive are durable can old hot-log rows be removed. The compacted rows are shown as gone from the hot tier; history remains in cold archive.",tables:[{name:"operations (hot tier · doc d-1a2b)",cols:["doc_id","seq","author_id","op_json","created_at"],rows:[{c:["d-1a2b","10001","42","{kind:insert,pos:1,text:Q}","10:00:01Z"],gone:1,tag:"compacted"},{c:["d-1a2b","10432","7","{op:delete,pos:88}","10:15:03Z"],gone:1,tag:"covered by snapshot"}]},{name:"snapshots",cols:["doc_id","version","content_blob_url","created_at"],rows:[{c:["d-1a2b","10432","s3://docs/d-1a2b/v10432.blob","2026-07-22 10:16:00"],hi:1,tag:"covering snapshot"}]}]},narrate:"Only after the covering snapshot and any required archived segments are durable can the system remove pre-10432 rows from the hot tier. Compaction archives; it does not destroy version history.",details:[
        {k:"query",label:"Hot-tier compaction sketch",lang:"sql",code:"-- after snapshot d-1a2b@10432 and archived segments are durable:\n-- hot store may drop rows older than the retained window\nDELETE FROM operations\nWHERE doc_id = 'd-1a2b' AND seq <= 10000;\n-- keep a recent window as policy requires; old history remains in cold archive"},
        {k:"gotcha",label:"Never truncate before durability",text:"If object storage is down, editing continues on the quorum hot log, but compaction pauses. A segment is never deleted while it exists only in an unconfirmed snapshot/archive."},
      ]},
      {node:"client",title:"What users gain",snap:{cap:"Next open/recovery starts at snapshot 10432 and usually has an empty or tiny tail, so users avoid replaying thousands or millions of ops. Version history remains available through archived snapshots and segments.",tables:[{name:"snapshots (new read path)",cols:["doc_id","version","content_blob_url","created_at"],rows:[{c:["d-1a2b","10432","s3://docs/d-1a2b/v10432.blob","2026-07-22 10:16:00"],hi:1,tag:"latest"}]},{name:"operations (tail after snapshot)",cols:["doc_id","seq","author_id","op_json","created_at"],rows:[{c:["d-1a2b","&gt;10432","—","empty until new edits","—"],hi:1,tag:"bounded replay"}]}]},narrate:"The next open or failover loads <code>v10432.blob</code> and maybe a tiny tail instead of replaying thousands or millions of ops. Version history still works by loading older archived snapshots and deltas on the cold path.",details:[
        {k:"note",label:"Trade-off",text:"Snapshots trade background write/storage work for bounded open and recovery time. Retention can coarsen old history (fine recent ops, then hourly/daily snapshots) without affecting live convergence."},
      ]},
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
      {l:"medium",tag:"capacity",q:"How much does the client actually have to hold and process?",turns:[
        {who:"intv",text:"Numbers for the client itself. On a hot doc your client receives the doc's whole op stream plus everyone's cursors and holds a local replica. Roughly how much is it processing and storing, and where does a browser tab fall over?"},
        {who:"cand",text:"Let me size the streams; edits are the cheap one.<span class='eg'>A 500-editor doc peaks at ~1-2.5K tiny ops/s, each ~tens of bytes, so under ~100KB/s of edit traffic — nothing for a socket. My own typing is ~2-5 ops/s, trivial.</span>The local replica is just the current document — a big 200KB doc is a few hundred KB in memory plus the editor's own structures. So edits and state are comfortable; the real pressure is cursor churn, which I keep off this budget by throttling."},
        {who:"intv",text:"So what actually threatens the tab?"},
        {who:"cand",text:"Two things, both about <em>rate</em> not total size. First, applying ops to the DOM — if I re-layout the whole doc per op I choke, so I apply incrementally to just the changed range and <strong>virtualize</strong> rendering to the visible viewport. Second, the presence storm: 500 cursors moving ~10x/s is the heavy stream, so I take it pre-<strong>coalesced</strong> as one batched snapshot per ~100-200ms tick rather than per-move. Net: the client is bound by <strong>render rate</strong>, capped by incremental apply plus viewport virtualization, so one tab holds a hot doc on ~1 core. I deliberately do <em>not</em> hold full op history client-side — I fetch snapshot + tail on open and keep only a recent window."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
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
      {l:"medium",tag:"capacity",q:"How many gateway nodes for the connection load?",turns:[
        {who:"intv",text:"Size the gateway tier. You cited ~2M users in live docs at the Monday-9am peak, each on a persistent WebSocket, and ~50K connections per node before FD and memory limits bite. How many nodes, and what dominates the cost?"},
        {who:"cand",text:"Straight division sets the floor.<span class='eg'>2M concurrent sockets ÷ ~50K per node ≈ 40 nodes. Add ~30% headroom and spread across 3 AZs so losing one AZ drops ~1/3 not the tier → call it ~60 nodes.</span>The cost is dominated by <strong>idle-socket memory and file descriptors</strong>, not CPU — most of those 2M sockets belong to people reading, not typing, so per-connection RAM and FD limits set the ceiling. That is why ~50K/node is the real constraint rather than op throughput."},
        {who:"intv",text:"What if you sized on throughput instead?"},
        {who:"cand",text:"It would badly under-count. CPU-wise the gateway is thin — it routes ops and fans out batches, and even a hot doc is only ~1-2.5K small ops/s, so a node could push far more than 50K connections' worth of <em>traffic</em>. But it cannot <em>hold</em> more than ~50K live sockets in memory. So I size on <strong>connection count, not op rate</strong>, and keep nodes as stateless-ish routers so I add them linearly behind an L4 LB as concurrency grows. The trade-off is paying for mostly-idle capacity at peak; I autoscale on connection count with a warm floor so a Monday-morning ramp does not outrun provisioning."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"Figma: how multiplayer works",url:"https://www.figma.com/blog/how-figmas-multiplayer-technology-works/"},
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
      {l:"medium",tag:"capacity",q:"How many collab processes for 50M docs?",turns:[
        {who:"intv",text:"Size the collab fleet. You have ~50M daily active docs but claim one authoritative owner process per live doc, at ~10K live sessions per node. How many nodes do you actually run, and what is the unit you size on?"},
        {who:"cand",text:"I size on <strong>concurrent live sessions, not total docs</strong> — an idle doc owns no process.<span class='eg'>Say ~2M concurrent editing sessions at peak across all docs; at ~10K sessions per node that is ~200 nodes. Even if a large fraction of the 50M docs were live at once it stays a few thousand nodes — but concurrency, not the 50M corpus, is the driver.</span>One node handles ~10K sessions because per-doc work is tiny: transform + append + publish on ~1-2.5K ops/s for even a hot doc, and most docs are 1-3 editors emitting a handful of ops/s."},
        {who:"intv",text:"Does a single hot doc break that per-node budget?"},
        {who:"cand",text:"No — one 500-editor doc is still ~1-2.5K tiny ops/s, which fits one core because fan-out is offloaded to gateways and pub/sub, so the owner is not holding 500 sockets. The budget only breaks on <em>count</em> of sessions, so I shard docs across the fleet by consistent hashing on doc id and size by peak concurrent sessions. The trade-off is that sessions cluster unevenly — a few hot docs plus a long tail — so I keep ~30% headroom per node and can split a pathologically hot doc into per-section owners if measurement ever demands it. I provision for concurrent sessions with headroom, not for the total doc count."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
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
      {l:"medium",tag:"capacity",q:"Op throughput and storage for the op log plus snapshots.",turns:[
        {who:"intv",text:"Put numbers on the document store. Across ~50M daily active docs at a few ops each, plus hot docs, what write throughput does the op log take, and how much storage do op logs and snapshots need?"},
        {who:"cand",text:"Throughput first, then storage.<span class='eg'>Assume ~50M active docs averaging ~200 ops/day → ~10B ops/day ≈ ~120K ops/s average, peak 3-5x → ~400-600K ops/s of tiny appends across the fleet. Storage: ~10B ops/day × ~50 bytes ≈ ~500GB/day of raw log; snapshots add a folded copy per doc periodically.</span>Appends are sequential and tiny, so throughput is fine on a sharded log; the growth is what bites."},
        {who:"intv",text:"So how do you keep storage from running away?"},
        {who:"cand",text:"Two levers I have already leaned on. <strong>Compaction</strong>: once a snapshot at seq S is durable I archive and truncate log segments before S, so the hot tier holds only a recent op window per doc — its size tracks <em>active</em> docs, not two years of history. <strong>Snapshot cadence</strong>: every ~1,000 ops or 60s, retaining only the latest snapshot or two on the hot tier and aging the rest to cold storage. So the hot store is O(recent ops + current snapshots) ≈ tens of TB, while full history lives cheaply in the cold tier. I shard by doc id so both the ~500K-ops/s append load and the storage spread across nodes with no global hotspot."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"ByteByteGo",url:"https://bytebytego.com/"},
      ]},
      {l:"hard",tag:"concept",q:"Pick the actual datastore for the op log and snapshots.",turns:[
        {who:"intv",text:"Let's make the store concrete and defend it against alternatives. The access pattern is append per doc plus read snapshot + tail by doc id. Would you put the op log in Kafka, a Postgres table, or a wide-column store like Cassandra — and where do the folded snapshots live? Start by pinning the load so the choice is grounded."},
        {who:"cand",text:"Let me size the two loads first, because they point at different tools. <strong>Writes</strong> dominate: ~50M active docs at ~200 ops/day is ~10B ops/day ≈ <strong>~120K ops/s average, ~400-600K ops/s at peak</strong>, each op tiny (~50 bytes). <strong>Reads</strong> are lighter and shaped oddly — nobody scans the whole log; a read is 'give me the latest snapshot pointer + the op tail after seq S for doc X.' So reads are a point lookup plus a short ordered range, driven by opens and reconnect catch-ups — call it a few hundred K/s of small range reads at peak, almost all served from the recent tail. The op-log store must swallow ~500K tiny ordered appends/s and cheap per-doc range reads; the snapshots are big blobs read rarely. Two different storage problems."},
        {who:"intv",text:"Good — now walk the three candidates for the op log with rough per-node ceilings and the node math each implies."},
        {who:"cand",text:"<strong>Postgres.</strong> A single primary sustains maybe ~10-20K small write txns/s before WAL, index bloat, and autovacuum pressure bite on a hot append table.<span class='eg'>500K ops/s ÷ ~15K/node ≈ 30+ write shards — and I am hand-rolling sharding across 50M doc keys and fighting vacuum on every one. Ordering per doc and transactions are easy; the write ceiling and operational tax are the problem.</span><strong>Kafka.</strong> An append-only log by design — a single partition takes ~100K+ msgs/s and a broker into the hundreds of thousands, so throughput is a non-issue.<span class='eg'>~500K ops/s across a few hundred partitions is comfortably a handful of brokers.</span>But it is a <em>transport</em> log, not a random-access store: a partition multiplexes many docs, so 'read the tail for doc X from seq S' or seeking an arbitrary historical seq means scanning/offset-mapping, which is awkward. <strong>Wide-column (Cassandra / Bigtable).</strong> LSM-tree writes are append-friendly at ~20-50K writes/s per node.<span class='eg'>500K ops/s ÷ ~30K/node ≈ ~17 nodes, ×3 replication ≈ ~50 nodes — and it shards on the partition key automatically with no global hotspot.</span>"},
        {who:"intv",text:"The whole point is ordered replay per doc. How does the indexing work, and why are the tail reads actually cheap on your pick?"},
        {who:"cand",text:"I key the op log <code>(doc_id, seq)</code> — <strong>doc_id as the partition key, seq as the clustering/sort key</strong>. That physically stores every doc's ops contiguously and already sorted by seq on one partition, so 'replay doc X from S' is a <strong>single-partition range scan</strong> over a contiguous slice — sequential IO, no fan-out, no cross-partition merge, no secondary index. That is the cheap primitive the whole design leans on: append writes to the tail of a partition, reads slice the tail by seq range. Snapshots are a separate small table keyed <code>(doc_id, version)</code> holding a <strong>pointer</strong> (the object-storage URL of the folded blob) plus the seq it folds up to, so open does one point read for the newest snapshot pointer, fetches the blob, then range-scans ops after that seq. The snapshot table is a tiny index of pointers; the heavy bytes live in the blob store, not in the log rows."},
        {who:"intv",text:"So state the decision and be explicit about why not the other two."},
        {who:"cand",text:"<strong>Decision: a wide-column store keyed <code>(doc_id, seq)</code> is the source-of-truth op log.</strong> It matches the access pattern exactly (append + ordered single-partition range scan per doc), hits ~500K appends/s at ~50 nodes, auto-shards by doc id with no global hotspot, and replicates per-partition for the quorum durability I already require. <strong>Not Postgres</strong>: its ~10-20K/node write ceiling forces 30+ manually-managed shards and autovacuum fights a write-heavy append table — the write path and ops tax lose. <strong>Not Kafka as the store</strong>: superb append throughput but it is transport, not random-access — arbitrary per-doc seq reads and history seeks are clumsy when partitions multiplex docs. Kafka still earns a role, just as the <strong>pub/sub fan-out layer</strong> broadcasting accepted ops to gateways. <strong>Snapshots go to a blob / object store</strong> (S3-class): large immutable folded documents, 11-nines durability, cheap per GB, referenced by pointer from the snapshot table. And a small relational/KV table holds doc metadata + ACLs where transactions matter. Right tool per job: wide-column for the log, blob store for snapshots, a stream for transport, relational for metadata."},
        {who:"intv",text:"One more on the snapshot side — why not just store the folded snapshot blob as a big cell in the same wide-column store and skip the object store?"},
        {who:"cand",text:"Because the two have opposite profiles. The op log is millions of <em>tiny</em> ordered rows read as ranges; a snapshot is a single <em>multi-hundred-KB</em> immutable blob read whole and rarely. Stuffing big blobs into wide-column cells bloats SSTables, hurts compaction, and drags the range-scan performance the log depends on — I would be paying LSM write-amplification and cache pressure for data that is written once and read cold. Object storage is purpose-built for exactly that: cheap, massively durable, versioned immutable keys, native lifecycle tiering to colder classes for old history. So I keep the log lean and fast in wide-column and push the fat, cold snapshot blobs to the object store, with only a <strong>pointer + fold-seq</strong> in the log tier linking them. That separation is what keeps both the hot append path and cold history affordable."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"ByteByteGo",url:"https://bytebytego.com/"},
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
      {l:"medium",tag:"capacity",q:"How much compute and memory does the engine need?",turns:[
        {who:"intv",text:"Quantify the engine's cost. It transforms each op against the ops since a client's base version and holds live per-doc state. On a 500-editor hot doc, how much work per op and how much memory, and does it scale across millions of docs?"},
        {who:"cand",text:"Per-op work is bounded by how far behind a client is, which I keep tiny.<span class='eg'>Healthy clients get ordered ops pushed continuously, so each is only a few ops behind → transform is O(handful) per op. At ~1-2.5K ops/s on a hot doc that is a few thousand cheap transforms/s — well within one core.</span>Memory is the current materialized doc (~hundreds of KB) plus a recent op window, not full history. So a hot doc is ~1 core and sub-MB of live state."},
        {who:"intv",text:"And across the corpus?"},
        {who:"cand",text:"The engine is <strong>co-located with the doc's collab owner</strong> and only holds state for <em>actively edited</em> docs, so its footprint scales with <strong>concurrent sessions, sharded by doc id</strong> — the same envelope as the collab fleet, a few thousand nodes at peak, not the 50M-doc corpus. Idle docs cost nothing; they live as snapshot + log in the store until reopened. The one spike is a reconnecting client 2,000 ops behind: I refuse to dribble 2,000 transforms through the hot path and instead catch it up in a batch or hand it a fresh snapshot + short tail. So steady-state is O(small) per op and memory tracks live editing — the engine is not the bottleneck once I bound transform distance."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"Operational transformation",url:"https://en.wikipedia.org/wiki/Operational_transformation"},
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
      {l:"medium",tag:"capacity",q:"Size the presence tier — update rate and memory.",turns:[
        {who:"intv",text:"Numbers for presence. On a 500-editor doc each client emits ~10 cursor updates/s, and you run this as its own tier. What message rate must it handle, and how much does it store?"},
        {who:"cand",text:"Raw fan-out is the scary number, so I never serve it raw.<span class='eg'>500 senders × ~10 updates/s × 499 receivers ≈ ~2.5M messages/s for one doc if delivered naively — dwarfing the ~1-2.5K/s of edits.</span>I collapse it: clients throttle to ~5-10/s, the tier <strong>coalesces</strong> to the latest position per user and flushes one batched snapshot per ~100-200ms tick → ~500 users × ~5-10 ticks/s = a few thousand batched messages/s. Storage is trivial — only the <em>current</em> value per (docId, userId) in memory with a short TTL, a few hundred bytes each."},
        {who:"intv",text:"So how do you size the tier across all docs?"},
        {who:"cand",text:"It is <strong>stateless and horizontally scaled</strong>, sized on concurrent editors, and because entries are tiny and in-memory, memory is a non-issue — 2M concurrent editors at a few hundred bytes each is well under a GB spread across the tier. The real budget is <strong>fan-out CPU and bandwidth</strong>, which I bound with per-tick batching and, past a threshold, <strong>degrading to aggregate presence</strong> ('+N others') plus viewport-scoping so I never pay N-squared. Since none of it is durable I can shard freely and drop under load with zero consistency risk. I size presence for coalesced fan-out, not raw cursor events — the throttle plus tick is what makes the number sane."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
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
      {l:"medium",tag:"capacity",q:"Size the durable snapshot and archive storage.",turns:[
        {who:"intv",text:"Size the persistence tier — the durable snapshots and archived log segments in object storage. Across ~50M docs with continuous snapshotting, how much do you store and at what write rate, and what governs the growth?"},
        {who:"cand",text:"Archive storage is the big number, so I bound it rather than store everything.<span class='eg'>~50M active docs; at a few hundred KB of retained history per active doc → order of tens of TB of hot-relevant history. But naive full-copy-per-1,000-ops on a busy 200KB doc alone is GBs/day, and raw archived log across the corpus is ~500GB/day if kept whole — that is the runaway I must prevent.</span>The write rate to object storage is background, not per-op — snapshots every ~1,000 ops or 60s per active doc, batched."},
        {who:"intv",text:"So how do you keep the archive from exploding?"},
        {who:"cand",text:"Four controls I have leaned on. <strong>Retain few snapshots</strong> — keep the latest one or two for recovery, GC the rest. <strong>Incremental snapshots</strong> — a base plus deltas instead of a full doc copy each interval. <strong>Coarsening retention</strong> — fine-grained ops for recent edits, then thin old history to hourly, then daily snapshots. <strong>Lifecycle tiering</strong> — age old segments into cheaper cold or glacier classes. So steady-state is O(current doc size + recent history) per doc, not O(all edits ever × full copies). The write path is unaffected because live durability is served by the quorum hot log; object storage only takes background, batched, retriable writes, so its throughput and latency never gate acks."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"ByteByteGo",url:"https://bytebytego.com/"},
      ]},
      {l:"medium",tag:"concept",q:"Which storage for snapshots and archives, and why?",turns:[
        {who:"intv",text:"Pick the technology for snapshots and archived segments and defend it. Options on the table: dump them in a database, keep them on replicated block volumes, or push them to an object store like S3. Trade-offs?"},
        {who:"cand",text:"The data is large, immutable-once-written blobs, read rarely (recovery, cold history), written by background jobs — so I weigh three. <strong>A database</strong> would let me query history richly, but storing multi-hundred-KB blobs as rows is expensive, bloats the DB, and wastes its transactional machinery on write-once objects. <strong>Replicated block volumes</strong> (attached disks) are fast but costly per GB, capacity-capped, and I would hand-roll cross-AZ redundancy and lifecycle myself. <strong>Object storage</strong> (S3-class) is purpose-built for this: ~11-nines durability, cross-AZ by default, cheap per GB, versioned immutable keys, and native lifecycle tiering to colder classes."},
        {who:"intv",text:"Object storage is slower and eventually consistent — doesn't that hurt you?"},
        {who:"cand",text:"It would if it were on the hot path, so I keep it strictly off it: live durability is the <strong>quorum-replicated hot op log</strong>, and object storage only holds snapshots plus sealed segments written by <strong>background jobs</strong>. Its latency never touches op acks, and eventual consistency is a non-issue because I read a <em>specific versioned, immutable key</em> for a snapshot, never a mutable one. So I choose <strong>object storage for snapshots and archives</strong>, keep a small hot fast tier for the live log tail, and only truncate a hot segment after its snapshot is confirmed durable in the object store. The trade-off — slower cold reads for 'restore to last Tuesday' — is fine because that path is rare; I trade cold-read speed for durability and cost, which is the right call for history."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"ByteByteGo",url:"https://bytebytego.com/"},
      ]},
    ],
  },
  mockTest:[
    {q:"OT vs CRDT for a collaborative text editor — what is the core difference, and when would you pick each?",a:"OT resolves concurrency by <strong>transforming</strong> each op against the ops ordered before it, so it needs an authoritative order to stay tractable and keeps ops tiny (just a position). CRDTs make merges <strong>conflict-free by construction</strong>: every element carries a globally-unique, densely-ordered id (and deletions leave tombstones) so any replicas that saw the same ops converge with no coordination. OT trades small footprint for needing a central sequencer; CRDTs trade extra metadata (ids + tombstones + GC) for needing no coordination. With a central server — which I already have for storage and auth — OT is efficient and Google-Docs-proven; I reach for CRDTs when the setting is P2P or long-offline with no authoritative order (Automerge/Yjs)."},
    {q:"Why does a single central total order per doc make conflict resolution so much easier?",a:"With one authoritative sequencer, each incoming op only has to be reconciled against the <strong>known, finite, ordered</strong> set of ops accepted before it — the server is the arbiter of 'what happened first,' so there is no ambiguity. That reduces OT to the tractable case (transform forward over a bounded list) and avoids the notoriously hard general case of arbitrary concurrent histories (TP2). Pure P2P has no such arbiter, which is what forces you into CRDTs. Since I already need a durable server, using it as the per-doc sequencer is nearly free and removes a whole class of ordering bugs."},
    {q:"A user edits offline for an hour (~4,000 ops) while others make ~10,000 ops to the same regions, then reconnects. How is nothing lost?",a:"Offline is first-class, so it degrades to 'catch up on reconnect,' never corruption. Offline the client keeps applying to its <strong>local replica</strong> and queues all ops as <strong>unacknowledged</strong>, each tagged with the base version it was made against. On reconnect it fetches everything the server saw since that base, then <strong>replays its queued ops through the engine</strong>, each transformed/merged against the concurrent remote ops so it lands correctly rather than at a stale position. If divergence is huge it rebases onto a recent snapshot + delta instead of replaying from a very old base. Nothing drops because the work lived in the local replica + unacked queue and is committed to the quorum log before being acked; a region that truly cannot auto-reconcile is preserved as a suggestion, never silently discarded."},
    {q:"Why keep an append-only op log plus periodic snapshots instead of just storing and overwriting the current document?",a:"The op log is the source of truth — the doc at any version is the fold of its ops — and it is what enables real-time convergence (clients sync by seq range), offline replay, undo/redo, version history, and audit. Overwriting current-state-only throws all that away and reintroduces last-writer-wins clobbering, the exact corruption the design forbids. The log is cheap (tiny ops, sequential appends); its only costs are unbounded growth and replay time, which <strong>snapshots</strong> (materialized state at a seq, so recovery/open read snapshot + short tail, not from op 0) and <strong>compaction</strong> (archive + truncate segments before a durable snapshot) directly bound."},
    {q:"Which datastore for the op log, and which for snapshots — defend it against Postgres and Kafka.",a:"Op log: a <strong>wide-column store keyed (doc_id, seq)</strong> — doc_id partitions, seq clusters — so each doc's ops are contiguous and pre-sorted, making append + tail range-scan a single-partition sequential operation. It hits ~500K tiny appends/s at roughly ~50 nodes (×3 replication) and auto-shards with no global hotspot. Not Postgres: its ~10-20K writes/s per node forces 30+ manual shards and autovacuum fights a hot append table. Not Kafka-as-store: great append throughput but it is transport, not random-access — arbitrary per-doc seq reads are clumsy when partitions multiplex docs (Kafka instead serves as the pub/sub fan-out layer). Snapshots are large immutable blobs read rarely, so they go to an <strong>object store</strong> (S3-class, 11-nines, cheap, lifecycle-tiered), referenced by a pointer + fold-seq from a small snapshot table."},
    {q:"The sole authoritative collab process for a 500-editor hot doc is OOM-killed after broadcasting ~3,000 ops in its last 2 seconds. Is anything lost?",a:"Nothing committed is lost, given one invariant: <strong>an op is acked and broadcast only after it is durably appended to a write quorum of the log</strong>. So everything the 500 users saw as applied was already on a majority of replicas. Mid-flight ops that were never acked are still held by their clients as unacknowledged and get re-sent. On crash the sockets drop, clients reconnect through the gateway, a <strong>new owner is elected via a lease/consensus with a fencing epoch</strong> (higher-epoch writes fence out a returning zombie, preventing split-brain), it rehydrates from latest snapshot + op-log tail, and resumes. Users see a ~1-3s stall then resync. Durable writes stay cheap via sequential appends + batched quorum commits, and clients already applied their own op locally so their typing feel is unaffected."},
    {q:"Why is presence (cursors, selections, typing indicators) handled on a separate path from edits?",a:"Presence is <strong>ephemeral live state</strong>: extremely high-churn, tiny, self-correcting (the next update overwrites the last), and not durable — it needs freshness, not total order or durability. So it rides the same WebSocket but branches to a presence service as a <strong>LWW value keyed (doc_id, user_id)</strong> with a short TTL, never entering the op log or the engine, and can be throttled/coalesced/dropped freely. Mixing it into the edit stream would pollute the durable ordered log with millions of throwaway updates, bloat snapshots and replay, and waste the engine on data with no conflicts. Keeping it separate means a presence outage is a cosmetic, self-healing blip while edits keep flowing untouched."},
    {q:"How do you size and place the collab-owner processes across 50M docs, and does a hot doc break the per-node budget?",a:"Size on <strong>concurrent live sessions, not total docs</strong> — an idle doc owns no process. At ~2M concurrent editing sessions and ~10K sessions per node that is ~200 nodes (with headroom, a few hundred). Placement is <strong>consistent hashing on doc id</strong>, so each doc maps to exactly one owner and the sequencer is per-doc, not global — no central bottleneck. A single 500-editor doc does not break the budget: it is only ~1-2.5K tiny ops/s and fan-out is offloaded to gateways + pub/sub, so the owner's real work (transform + append + publish) fits one core. The budget breaks only on session <em>count</em>, so I shard by doc id, keep ~30% headroom, and split a pathologically hot doc into per-section owners only if measurement ever demands it."},
  ],
};

/* ---- scaling journey ---- */
(function(){
var d=window.DATA['gdocs'];
var scaling={id:"scaling",name:"From whole-doc saves to real-time collaboration",kind:"scale",
  live:["client","gw","collab","doc"],
  summary:"Start from the simplest document editor that saves state, then let concurrency, awareness, and replay cost force the real collaborative architecture one component at a time.",
  steps:[
    {node:"doc",stage:"Stage 0 · Baseline",title:"Whole-doc saves — correct for one writer, fragile for many",
      live:["client","gw","collab","doc"],
      narrate:"Draw the honest MVP first: the browser opens a document, edits a local copy, and the service saves the full current document back to the store. For one author it is perfectly legible. The moment two editors type at once, last-writer-wins stops being a collaboration model and starts being data loss.",
      details:[
        {k:"win",label:"Why start here",text:"It proves the basic shape: client, socket or HTTP edge, a document service, and durable storage. No transform engine, no cursors, no snapshot policy. That is fine for solo edits and useful as the baseline to beat."},
        {k:"query",label:"Naive save",code:"-- one current-state row, overwritten on save\nUPDATE documents\n   SET content = :whole_doc, current_version = current_version + 1\n WHERE doc_id = :doc_id\n   AND current_version = :base_version;\n-- without the version guard this becomes pure last-writer-wins"},
        {k:"pain",label:"What breaks — a concrete case",text:"At **Nimbus Launch Plan**, a 42-page launch brief is edited during Monday 09:00 review. Priya adds the pricing table at version 118 while Mateo, on hotel Wi-Fi, saves a paragraph from version 118 **900 ms later**. With whole-document overwrite, Mateo's save writes a complete older blob over Priya's table. The database is healthy and durable, but the product just lost a user's intent. In the same meeting, **500 editors × 2−5 keystrokes/s = 1−2.5K tiny intents/s**; choosing one blob as the winner is not collaboration."},
        {k:"fix",label:"The fix — walk the same case, version-guarded baseline",text:"For the first small deployment, keep one current document row but require `current_version` to match. Priya's save moves 118&rarr;119; Mateo's stale save affects **0 rows** and the client reloads instead of silently clobbering her table. That protects solo and light-team docs, but it still does not merge both edits. At Nimbus-scale traffic, the right next step is to store **operations**, not whole blobs."},
        {k:"host",label:"Load & capacity — what runs it",text:"**1× PostgreSQL primary**, 8 vCPU / 32 GB, stores `documents(doc_id, current_version, content)` plus an index on `doc_id`. A typical 200 KB doc save is a single row update; a pilot with **200 saves/s × 200 KB ≈ 40 MB/s** WAL is fine on SSD. The hot Nimbus case is not bytes: **1−2.5K concurrent intents/s** against one row creates version conflicts and lost merge semantics, so the box is enough for launch but the model is wrong for real-time editing."},
      ],
      snap:{title:"Load & capacity — Stage 0",cap:"The skeleton is easy to reason about, but the collaboration invariant is not met yet.",
        tables:[{name:"signals",cols:["signal","value","verdict"],rows:[
          {c:["Datastore","1× PostgreSQL primary · 8 vCPU / 32 GB · current blob","ok for pilot"]},
          {c:["Pilot save load","~200 whole-doc saves/s · ~40 MB/s WAL","ok"]},
          {c:["Nimbus hot doc","500 editors · ~1−2.5K intents/s","model breaks"],hi:1,tag:"risk"},
          {c:["Conflict policy","version reject or last save wins","does not merge"],hi:1},
          {c:["Why no replicas yet","writes are one-row and correctness is missing first","defer"]},
        ]}] }},
    {node:"engine",stage:"Stage 1 · Conflict engine",title:"Concurrent edits overwrite &rarr; add OT or CRDT",
      live:["client","gw","collab","doc","engine"],
      narrate:"The first forced upgrade is correctness, not QPS. Two users inserting at the same position are not two whole-doc blobs to pick between; they are two intents that must both survive. The collab owner orders ops, and the engine transforms or merges them before durable append.",
      details:[
        {k:"pain",label:"What breaks — a concrete case",text:"Nimbus review moves into the launch timeline section. At 09:03:12.100, Priya inserts **\"EU beta\"** at character 18,240 from base version 881. At 09:03:12.106, Mateo inserts **\"APAC waitlist\"** at the same position from the same base. Whole-doc or naive position edits make one insert shift the other's target; one paragraph lands in the wrong bullet or disappears. With **1−2.5K ops/s**, these same-base collisions happen every second, not once a day."},
        {k:"fix",label:"The fix — walk the same case, ordered ops plus OT or CRDT",text:"The collab owner for `doc:nimbus-launch` assigns sequence 882 to Priya and 883 to Mateo. The OT engine transforms Mateo's position against Priya's accepted insert, so both bullets survive in deterministic order; a CRDT variant would merge by stable element ids. Clients fold the same ordered stream and converge within the **&lt; 200 ms** collaboration budget. The user's intent is now the unit of durability."},
        {k:"host",label:"Load & capacity — what runs it",text:"**Collab service: 1 owner process per active doc**, placed by consistent hash. One hot doc at **2.5K ops/s × ~50 B ≈ 125 KB/s** fits one core after batching. **ScyllaDB/Cassandra op log**, RF=3 across AZs, keyed `(doc_id, seq)`, quorum writes; a 6-node starter ring sustains roughly **6 × 30K = 180K appends/s raw**, enough for about **70 Nimbus-hot docs** before adding nodes. Quorum RF=3 is the minimum that survives one replica loss while still accepting writes."},
        {k:"gotcha",label:"Why the central owner helps",text:"A single per-doc sequencer keeps transforms bounded to the accepted prefix. CRDTs still work, but pay with per-character ids and tombstones; with a server already present, OT stays compact and proven."},
      ],
      snap:{title:"Load & capacity — Stage 1",cap:"The write shape changes from blob overwrite to tiny ordered appends.",
        tables:[{name:"signals",cols:["signal","before","after"],rows:[
          {c:["Conflict behavior","overwrite or reject","preserve both intents"],hi:1,tag:"fixed"},
          {c:["Hot-doc rate","~1−2.5K ops/s","1 owner process · ~1 core"],hi:1},
          {c:["Op log datastore","Postgres blob row","ScyllaDB/Cassandra RF=3 · quorum appends"],hi:1},
          {c:["Why RF=3","2 replicas lose quorum on one failure","3 gives N+1"],hi:1},
          {c:["Per-node write load","180K ring ÷ 6 ≈ 30K writes/node ceiling","headroom"]},
        ]}] }},
    {node:"presence",stage:"Stage 2 · Presence",title:"Cursor churn pollutes edits &rarr; split ephemeral presence",
      live:["client","gw","collab","doc","engine","presence"],
      narrate:"Once editing is correct, the product still feels broken if collaborators cannot see cursors, selections, and typing awareness. But cursor motion is high-frequency and disposable. It should ride the socket, then branch to an ephemeral presence service instead of entering the durable op log.",
      details:[
        {k:"pain",label:"What breaks — a concrete case",text:"At 09:05 in Nimbus, 500 people drag selections while the VP asks everyone to vote on wording. Raw cursor traffic is **500 users × 10 updates/s = 5K presence updates/s** for one doc. If each update is written to the durable op log and fanned to all 500 viewers, the system attempts **5K × 499 ≈ 2.5M cursor messages/s** before real edits. The Scylla log fills with throwaway mouse positions, snapshots bloat, and a cosmetic cursor storm delays actual text acks."},
        {k:"fix",label:"The fix — walk the same case, separate live-state channel",text:"Gateways now send cursor moves to Redis-backed presence, not to the edit log. Each user keeps only the latest `(cursor, selection, typing)` value with a **30 s TTL**. The service coalesces to **5 ticks/s** and broadcasts one compact doc snapshot per tick, so Nimbus drops from **2.5M raw messages/s** to roughly **500 users × 5 ticks = 2.5K batched updates/s** per gateway fan-out set. If a cursor packet is lost, the next tick replaces it."},
        {k:"host",label:"Load & capacity — what runs it",text:"**Redis Cluster for presence**, 3 masters + 3 replicas per region, hash by `doc_id`. A hot Nimbus doc is ~5K writes/s of last-value updates; one Redis master can handle **~100K small ops/s**, so even if the hash lands on one master it is ~5% CPU. Replicas are for failover and local reads; 3 masters spread the broader **2M-socket** fleet's presence keys, not because one doc needs bytes. WebSocket gateways remain ~60 nodes from the file's **50K sockets/node** ceiling."},
        {k:"gotcha",label:"Different guarantees by design",text:"Edits need total order and durability. Presence needs freshness and can be dropped. Mixing them gives the cursor path guarantees it does not need and steals capacity from the text path."},
      ],
      snap:{title:"Load & capacity — Stage 2",cap:"High-churn awareness leaves the durable edit budget alone.",
        tables:[{name:"signals",cols:["signal","value","verdict"],rows:[
          {c:["Presence store","Redis Cluster · 3 masters + 3 replicas/region","N+1 failover"],hi:1,tag:"fixed"},
          {c:["Nimbus cursor input","500 × 10/s = ~5K updates/s","~5% of one master"]},
          {c:["Naive fan-out","~2.5M cursor msg/s","too high"],tag:"risk"},
          {c:["Coalesced fan-out","~2.5K batched updates/s","ok"],hi:1},
          {c:["Durability need","none · 30 s TTL","correct"]},
        ]}] }},
    {node:"persist",stage:"Stage 3 · Snapshots",title:"Full replay grows unbounded &rarr; snapshot and compact",
      live:["client","gw","collab","doc","engine","presence","persist"],
      narrate:"The final forced upgrade is open and recovery time. An append-only op log is the right source of truth, but replaying from op zero for a 500-page document or a 2M-op history freezes clients and slows owner recovery. Periodic snapshots bound the tail that must be folded.",
      details:[
        {k:"pain",label:"What breaks — a concrete case",text:"By Friday, Nimbus Launch Plan has **2M historical ops** after comments, rewrites, and offline replays. At 09:00, the collab owner restarts and tries to fold op 1 through op 2,000,000 before accepting edits. Even at **50K ops/s replay**, recovery is **40 s**; every editor sees reconnect spinners, then resends unacked ops, making the restart worse. Platform-wide, **10B ops/day × ~50 B ≈ 500 GB/day** of raw log means full-history hot storage grows forever."},
        {k:"fix",label:"The fix — walk the same case, snapshots plus compaction",text:"Every **1,000 ops or 60 s**, the owner writes a folded snapshot pointer at sequence S to object storage and records it beside the log. Nimbus now opens from the latest 220 KB snapshot plus at most ~1,000 tail ops, so owner recovery is **&lt; 1 s** instead of 40 s. Log segments older than durable snapshots are archived to cold storage, not erased, preserving history while keeping the hot path recent."},
        {k:"host",label:"Load & capacity — what runs it",text:"**ScyllaDB/Cassandra hot op log**, RF=3, 50 nodes for the file's **400−600K peak ops/s**: at 600K logical appends/s with RF=3, replicas perform **1.8M writes/s**, or **36K writes/node** on 50 nodes, near the stated ~30K/node ceiling but acceptable with batching and autoscale to 60. **S3/GCS object storage** holds immutable snapshots; a 2M-op doc snapshot of a few hundred KB is cheap, and 60 s cadence means ~1,440 snapshots/day before lifecycle compaction."},
        {k:"key",label:"Keep the log as truth",text:"Do not replace the op log with snapshots. The log preserves version history, offline replay, audit, and undo; snapshots are acceleration points that make the log practical at scale."},
      ],
      snap:{title:"Load & capacity — Stage 3 (full design)",cap:"Open, recovery, and storage growth are now bounded without giving up the ordered log.",
        tables:[{name:"signals",cols:["concern","mechanism","result"],rows:[
          {c:["Op log datastore","ScyllaDB/Cassandra RF=3 · 50−60 nodes","N+1 headroom"],hi:1,tag:"fixed"},
          {c:["Peak append math","600K logical/s × RF=3 ÷ 50 ≈ 36K writes/node","near ceiling"]},
          {c:["Snapshot store","S3/GCS immutable blobs · versioned","durable"]},
          {c:["Open a large doc","snapshot + &le;1K-op tail","sub-second target"],hi:1},
          {c:["Raw log growth","~500 GB/day","archive compacted segments"]},
        ]}] }},
  ]};
d.deepFlows=[scaling].concat(d.deepFlows);
})();
