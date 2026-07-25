window.DATA = window.DATA || {};
window.DATA['filesync'] = {
  cat:"chunking · sync · dedup",
  title:"Design a file sync / cloud storage service (Dropbox / Google Drive)",
  blurb:"Store files, sync them across a user's devices, share folders, and propagate every change efficiently without re-uploading whole files.",
  prompt:"Let's design a file sync and cloud storage service like Dropbox or Google Drive. Users keep files in a synced folder, every change propagates to their other devices and to shared collaborators, there's version history, and it must work offline. The interesting parts are propagating changes efficiently and staying correct under concurrent edits. Start with the high-level architecture and rough numbers, then we'll drill into components — and I'll be throwing failure scenarios at you.",
  opening:"Let me frame it before drawing boxes.<br><br><strong>Functional:</strong> store files in a synced folder, propagate every change to a user's other devices and to shared collaborators, keep version history, work offline. <strong>Non-functional:</strong> sync feels near-instant (a small edit visible elsewhere in seconds), bandwidth- and storage-efficient (never re-upload a whole file for a one-line edit), durable (a file must never be silently lost), and correct under concurrent offline edits.<br><br><strong>Back-of-envelope:</strong> ~100M DAU, each changing ~100 files/day → ~10B change events/day ≈ 115K/s, peak 3-5x. The data plane dwarfs this: average upload maybe 1MB, but files range to tens of GB, so storage grows into exabytes — dedup and cold tiering aren't optional. Metadata is tiny per file but touched on every sync poll.<br><br>I'll start deliberately minimal: <strong>client (sync agent) → API + sync service → metadata service → metadata DB</strong>. That skeleton tracks the file tree and tells devices what changed. As we push on large files, dedup, and propagation I'll grow the data plane and notification paths. Pick a box and let's push on it.",
  nodes:[
    {id:"client",name:"Client",sub:"sync agent",x:40,y:150},
    {id:"gw",name:"API + sync svc",sub:"edge",x:210,y:150},
    {id:"meta",name:"Metadata service",sub:"file tree, versions",x:380,y:150},
    {id:"db",name:"Metadata DB",sub:"namespace, index",x:550,y:150},
    {id:"chunk",name:"Chunker / dedup",sub:"content-defined",x:380,y:40},
    {id:"block",name:"Block storage",sub:"chunks / S3",x:550,y:40},
    {id:"notif",name:"Notification svc",sub:"change events",x:210,y:40},
  ],
  edges:[["client","gw","sync"],["gw","meta","file ops"],["meta","db","index"],["gw","chunk","upload"],["chunk","block","store chunks"],["gw","notif","notify"]],
  core:["client","gw","meta","db"],
  basic:["client","gw","meta","db"],
  deepDive:{
    client:{
      role:"The sync agent on each device: watches the folder via OS filesystem events, chunks and hashes changes <strong>locally</strong>, and reconciles against the server. Owns the most consequential lever — pushing chunking/hashing to the edge keeps ~460 cores of ingest CPU off your fleet — plus the causality tracking that decides <em>conflict</em> vs <em>fast-forward</em>.",
      capacity:[
        ["Local index","~100 B/file","50K files ≈ ~5MB SQLite; 2M files ≈ ~200MB"],
        ["Initial hash","~500 MB/s","50GB ≈ ~100s one-time; 500GB ≈ ~17 min"],
        ["Steady edit","~2 ms","re-hash a 1MB changed file"],
        ["Watches","per-directory","500K files ≈ a few thousand dir watches, not 500K handles"],
      ],
      data:"Holds a <strong>local index</strong> (path &rarr; size, mtime, content hash) treated as a <em>cache, not source of truth</em> — the server's namespace version is authoritative. Per-file causality is a <strong>version vector</strong> (a counter per device); the index uses a WAL so a power-loss leaves it consistent, and a corrupt index is rebuilt from a rescan + server diff.",
      scaling:[
        "Watch <strong>directories</strong> recursively, not files — thousands of watches instead of hundreds of thousands.",
        "<strong>Debounce and batch</strong> event storms — a 50K-file <code>git checkout</code> coalesces into one batched tree-delta commit.",
        "Throttle initial hashing to a fraction of cores at low IO priority so first-sync never hijacks the machine.",
        "Chunk + hash on-device so ingest CPU spreads free across 100M machines and bytes go direct-to-storage.",
      ],
      failures:[
        {t:"Corrupt local index after a hard power-off",b:"Device can't trust local state; a naive design re-uploads 50GB.",m:"Treat the index as a cache: rescan + hash, diff against the server's file list; dedup means only blocks the server lacks are pushed — a CPU cost, not re-transfer."},
        {t:"OS filesystem-event buffer overflows under churn",b:"Some changes are silently missed.",m:"A periodic full reconcile scan compares (size, mtime) against the index as a backstop; the common path stays event-driven."},
        {t:"Two devices edit the same file offline",b:"Last-write-wins would destroy one person's work.",m:"Version vectors flag concurrent (neither-dominates) edits; the loser is materialized as a conflicted copy — both survive."},
      ],
      tradeoffs:[
        {a:"Client-side chunking/hashing",b:"Central chunking",pick:"Client-side spreads ~460 cores across user machines and enables direct-to-storage; cost is you can't trust client hashes, so the block layer re-verifies on commit."},
        {a:"Event-driven watches",b:"Periodic scan",pick:"Events give near-instant sync but are best-effort; the scan is a rare, cheap safety net so you never permanently miss a change."},
      ],
      probes:[
        "The local SQLite index is corrupt on reboot — do they re-upload 50GB? Walk the recovery.",
        "A <code>git checkout</code> rewrites 50K files in 2s — what stops 50K round-trips?",
        "Two devices edit <code>plan.xlsx</code> offline then both push within 10s — who wins, and how is nothing lost?",
      ],
    },
    gw:{
      role:"The edge / API + sync service. Splits into a <strong>metadata control plane</strong> (tiny commits, changes-since reads) and a <strong>data plane</strong> that never touches bytes — clients upload chunks direct-to-storage via <strong>pre-signed URLs</strong>. The lever it owns: keep the expensive byte path out of the fleet so a small stateless tier serves millions of tiny polls.",
      capacity:[
        ["Commit rate","~460K/s peak","115K/s baseline × 4"],
        ["Per-instance","~5K req/s","stateless 4-core node"],
        ["Metadata fleet","~130 instances","~500K rps ÷ 5K, +30%; warm floor ~40"],
        ["Data-plane instances","0","bytes bypass the fleet via pre-signed URLs"],
      ],
      data:"Stateless — no per-request state, so instances add/remove freely. It authenticates, mints scoped short-lived upload URLs (keyed to the claimed content hash), and forwards tree deltas to the metadata service; correctness lives downstream in the metadata store and block layer.",
      scaling:[
        "Split control and data planes so a few big uploads can't starve millions of tiny metadata polls.",
        "Direct-to-storage via pre-signed URLs → the byte tier needs zero instances.",
        "Notification pokes + per-(namespace,cursor) caching collapse sync reads from constant polling to ~one read per change.",
        "Warm floor + autoscale on request rate above it.",
      ],
      failures:[
        {t:"Slow data path backs up connections",b:"Big uploads tie up memory/connections needed for metadata.",m:"Physically separate planes; bytes never transit the metadata fleet."},
        {t:"Client lies about a chunk hash / uploads garbage",b:"Corrupt or spoofed content could become referenceable.",m:"The pre-signed URL is scoped to the hash-derived key and expires fast; the block layer re-hashes on commit and rejects mismatches."},
        {t:"Instance crashes mid-request",b:"That single request fails.",m:"Stateless → client retries idempotently against another instance; nothing durable was owned here."},
      ],
      tradeoffs:[
        {a:"Direct-to-storage (pre-signed)",b:"Proxy bytes through the service",pick:"Direct-to-storage removes an entire CPU/bandwidth tier; cost is you must verify client-claimed hashes server-side."},
        {a:"Provision for cold-cache worst case",b:"Trust autoscale",pick:"Keep a warm floor (~40) so a cache flush can't stampede before autoscale catches up; cost is idle capacity."},
      ],
      probes:[
        "A 1KB tree-delta and a 2GB upload both arrive here — trace each precisely.",
        "If clients write straight to storage, how do you stop them uploading garbage or spoofing a hash?",
        "Why ~130 instances just to forward tiny commits — what actually cuts it?",
      ],
    },
    meta:{
      role:"The metadata service: file tree, versions, cursors, and sharing. Every change is an <strong>atomic per-namespace commit</strong> that advances one version cursor via <strong>compare-and-set</strong>. The lever it owns: the per-namespace commit boundary is the strong-consistency unit — keep it small and everything else scales.",
      capacity:[
        ["Commits","~460K/s peak","3–5 row writes + a CAS each"],
        ["Sync reads","~1.6M/s cold","100M devices ~once/min"],
        ["Instances","~50–80 post-cache","changes-since cache collapses the herd"],
        ["Shared folder","1 commit / 5,000 members","one cursor advance, not 5,000 writes"],
      ],
      data:"Source of truth for structure. A commit is one transaction: advance the namespace version, write a <code>file_versions</code> row, update the <code>files</code> pointer. The <strong>changes-since-cursor</strong> response is immutable and identical per (namespace, cursor), so it caches almost perfectly. Concurrent commits serialize on the version CAS — the loser rebases.",
      scaling:[
        "Shard by <strong>namespace</strong> so a folder's whole tree + cursor stay co-located and each sync is single-shard.",
        "Cache the changes-since response per (namespace, cursor) to collapse shared-folder herds.",
        "Jittered notification delivery spreads the herd over seconds.",
        "Sub-partition a giant namespace by path range without breaking the commit boundary.",
      ],
      failures:[
        {t:"Instance crashes mid-commit",b:"A 3,200-file batch could land half-applied.",m:"The commit is one atomic transaction — all-or-nothing; the cursor only advances on commit, so devices never see a half-state. Stateless retry."},
        {t:"Two devices commit against the same version",b:"One edit could clobber the other.",m:"Compare-and-set on the version: first wins 41&rarr;42, the second rebases onto 42 and commits 42&rarr;43."},
        {t:"Hot shard (hyper-active shared folder)",b:"One shard pins while others idle.",m:"Read replicas absorb sync reads; consistent-hash rebalancing sheds the hot namespace."},
      ],
      tradeoffs:[
        {a:"Strong per-namespace",b:"Eventual everywhere",pick:"Strong only on the tiny metadata core (tree, CAS); the huge block plane stays eventual — keeps the strong core cheap to keep correct."},
        {a:"Mount/reference a shared folder",b:"Copy across namespaces",pick:"Mount keeps one commit per edit; copying multiplies writes and breaks atomic per-namespace commits."},
      ],
      probes:[
        "A batch moves 3,000 files and the instance dies after half — is the tree corrupt?",
        "5,000 members issue the identical changes-since read at once — how is that not a DB stampede?",
        "Where exactly is the strong-consistency boundary, and why keep it small?",
      ],
    },
    db:{
      role:"The metadata store: NewSQL (Spanner/CockroachDB-class) sharded by namespace, giving <strong>distributed ACID</strong> for the per-namespace commit + version CAS. The lever it owns: holding only <em>metadata</em> (pointers to bytes) keeps the strongly-consistent store tiny relative to the exabytes it indexes.",
      capacity:[
        ["Version rows","~5 trillion","~1T files × ~5 versions"],
        ["Raw / replicated","~1PB / ~3PB","~200 B/row, ×3"],
        ["Nodes","~1,500 storage-bound","~2TB usable/node"],
        ["Commit ceiling","~10K TPS/primary","NewSQL ~5–10K ACID writes/node"],
      ],
      data:"Composite key <code>(namespace_id, path)</code> serves point lookups and folder <strong>prefix range scans</strong>; an index on <code>(namespace_id, version)</code> turns changes-since into a range scan of <code>version &gt; cursor</code>. Strong consistency + linearizable CAS is the non-negotiable property; blocks live elsewhere, eventually consistent.",
      scaling:[
        "Shard by namespace hash; each commit stays single-shard.",
        "Read replicas absorb the sync-read fan-out; the primary sees writes + cold misses.",
        "Tier old version rows to cheap storage; keep live tree + recent versions hot.",
        "Keep the index set minimal — each commit touches ~2 indexes on the 460K/s path.",
      ],
      failures:[
        {t:"A shard's disk dies",b:"Trees + history for ~30M namespaces at risk.",m:"Each shard is a replica group (&ge;3 across AZs) with quorum writes; a lost replica rebuilds, zero data loss."},
        {t:"Write-primary crashes mid-sale",b:"Commits on that shard stall.",m:"Consensus leader election with an epoch/fencing token; the stale old primary's writes are fenced off. Reads stay up on replicas."},
        {t:"A single namespace outgrows a shard",b:"One 10M-file folder can't fit.",m:"Sub-partition its tree by path range while keeping rows small and the commit boundary intact."},
      ],
      tradeoffs:[
        {a:"NewSQL (Spanner/Cockroach)",b:"Sharded Postgres/MySQL",pick:"NewSQL brings built-in quorum replication + failover so you don't hand-roll it for 140+ shards; cost is money, lock-in, cross-region commit latency. Sharded Postgres is the cheaper fallback because commits are single-shard."},
        {a:"Relational / NewSQL",b:"Cassandra / Dynamo",pick:"Rejected: a Paxos-CAS store needs more nodes and still can't do atomic multi-row tree commits — the one property metadata can't surrender."},
      ],
      probes:[
        "Why not Cassandra for 460K writes/s — be specific about where it breaks.",
        "How is changes-since a range scan and not a full-tree walk?",
        "Old version rows are most of the data and rarely read — how do you avoid keeping them all hot?",
      ],
    },
    chunk:{
      role:"Content-defined chunking + global dedup, run <strong>on the client</strong>. A rolling hash (Rabin) sets boundaries by content so an insert disturbs only one chunk. The lever it owns: CDC boundaries are what make dedup and delta-sync work — and pushing byte-crunching to clients removes a whole central CPU tier.",
      capacity:[
        ["Chunk target","~4MB","bounded min/max"],
        ["Rolling hash","O(1)/byte, ~1 GB/s/core","single linear pass"],
        ["Central cost if server-side","~460 cores at peak","~460 GB/s ÷ ~1 GB/s/core"],
        ["Server-side work","~few hundred K lookups/s","hash-existence checks, not bytes"],
      ],
      data:"Stateless compute. Chunks are content-addressed (hash = key) with a <strong>ref count</strong> per chunk in metadata. The client computes hashes; the server must not trust them, so the block layer re-hashes on commit. Dedup is chunk-level, so partially-similar files share common chunks.",
      scaling:[
        "Push chunking/hashing to clients → ~460 cores spread free across 100M machines; bytes go direct-to-storage.",
        "Server does only cheap hash-existence lookups on the 115K changes/s path.",
        "Content-defined boundaries survive inserts, so a 1-byte insert re-uploads 1 chunk, not the whole file.",
        "Bound chunk min/max so pathological inputs can't produce millions of tiny chunks.",
      ],
      failures:[
        {t:"Fixed-size chunking on an insert",b:"Every boundary shifts, every hash changes, whole file re-uploads.",m:"Content-defined chunking with a rolling hash re-aligns boundaries right after the edit."},
        {t:"Ref-count double-decrement drives a live chunk to 0",b:"GC deletes a still-referenced chunk — thousands of files point at missing bytes.",m:"Mark-and-sweep GC recomputes reachability from live metadata; long grace period; re-verify before delete; content is re-uploadable from a holder."},
        {t:"Cross-user dedup existence side-channel",b:"An attacker probes whether specific content exists in anyone's storage.",m:"Dedup silently server-side (always accept the offer) or scope dedup per-namespace, trading storage for privacy."},
      ],
      tradeoffs:[
        {a:"Content-defined chunking",b:"Fixed 4MB blocks",pick:"CDC survives inserts (1 chunk changes vs all of them); cost is a rolling-hash pass, cheap since it's dominated by disk read."},
        {a:"Global dedup",b:"Per-namespace dedup",pick:"Global maximizes storage savings but leaks a cross-user existence oracle; per-namespace is private but stores duplicates."},
      ],
      probes:[
        "Insert one byte at the front of a 100MB file — how many chunks change under fixed vs content-defined?",
        "A ref-count bug drives a live chunk to zero and GC deletes it — prevent and recover.",
        "Global cross-user dedup has a privacy side-channel — what is it, and how do you close it?",
      ],
    },
    block:{
      role:"The content-addressed, immutable block store (Magic-Pocket-style): a giant hash&rarr;bytes map at exabyte scale, protected by <strong>erasure coding</strong>. The lever it owns: immutability — chunks never change, so replication is free, there's no invalidation, and integrity is verifiable by re-hashing.",
      capacity:[
        ["Raw &rarr; unique &rarr; physical","25 EB &rarr; ~12 EB &rarr; ~18 EB","dedup ~2×, EC 6+3 ~1.5×"],
        ["Drives","~900K","~20 TB/node"],
        ["Write rate","~2M chunks/s peak","hash-partitioned, embarrassingly parallel"],
        ["EC 6+3","tolerate 3 fragment losses","vs 3× for replication"],
      ],
      data:"The key <em>is</em> the content hash. A hash&rarr;location index maps chunks to the container/volume holding them (chunks packed into larger objects for locality). Immutable + content-addressed → replicate freely, verify by re-hash, safe background compaction. Tiered by access age.",
      scaling:[
        "Hash-partition writes across many cells — no coordination, no hotspot for distinct chunks.",
        "Dedup collapses a viral identical chunk to one write + cheap refs.",
        "A read cache/CDN absorbs hot-chunk read fan-out.",
        "Tier cold chunks to dense cheap media; EC is the durable cold backbone.",
      ],
      failures:[
        {t:"A storage node holding unique chunks dies",b:"Sole copies of thousands of users' file content at risk.",m:"Erasure coding (RS 6+3) across failure domains: any 6 of 9 fragments reconstruct; rebuild lost fragments from survivors."},
        {t:"A whole zone goes offline",b:"Reads needing that zone's fragments could fail.",m:"Place fragments across zones so a zone loss stays within m=3; a grace period before triggering rebuild avoids storms."},
        {t:"Silent bit-rot",b:"A fragment corrupts undetected.",m:"Continuous scrubbing re-hashes fragments and rebuilds proactively."},
      ],
      tradeoffs:[
        {a:"Erasure coding (~1.5×)",b:"3× replication",pick:"EC gives 11-nines-class durability at half the overhead; cost is reconstruction CPU on a degraded read, mitigated by a hot cache tier."},
        {a:"Start on S3",b:"Self-hosted Magic-Pocket",pick:"S3's managed durability wins early; migrate to self-hosted only at exabyte scale when the bill dwarfs ops cost — immutability makes the migration verifiable."},
      ],
      probes:[
        "A node holding the only copies of some chunks dies — how is that not permanent loss?",
        "10M users upload the identical viral chunk — does that hot-spot one cell?",
        "S3 or self-hosted for the bytes, and at what scale does the answer flip?",
      ],
    },
    notif:{
      role:"Fans out tiny 'namespace X advanced to cursor N' pokes to subscribed devices. It's a <strong>best-effort hint, not the source of truth</strong> — the lever it owns is staying deliberately dumb so correctness lives entirely in cursor-based polling, and a lost or duplicate poke is harmless.",
      capacity:[
        ["Connections","100M concurrent","~10 KB state each ≈ ~1TB aggregate"],
        ["Per node","~250K idle conns","async/epoll → ~400 nodes (or ~100 if only 20–30M live)"],
        ["Poke rate","~350K/s baseline","peak ×4 ≈ ~1.4M/s"],
        ["Payload","namespace + cursor only","never content"],
      ],
      data:"Holds ephemeral per-device subscriptions keyed by namespace; carries only the namespace and its new cursor. No durable state worth recovering — durability lives in the metadata log. Pokes are idempotent: a duplicate just re-pulls from the same cursor and finds nothing new.",
      scaling:[
        "Async/epoll connection fleet holding hundreds of thousands of mostly-idle connections per node.",
        "Keep live push only for foreground/recently-active devices; sleeping devices fall back to slow polling.",
        "Jitter fan-out so a 50K-subscriber edit doesn't spike syncs.",
        "A Redis-Pub/Sub-style lightweight bus keyed by namespace links metadata and connection nodes.",
      ],
      failures:[
        {t:"Notification tier down for 20 min",b:"Devices get no pokes.",m:"Not the source of truth: devices fall back to periodic cursor-based polling and catch up in order on reconnect — graceful degradation, no loss."},
        {t:"A poke is lost in flight",b:"A device sits at a stale cursor thinking it's current.",m:"Its background poll presents the cursor and gets the delta next cycle — correctness never depends on any single poke."},
        {t:"Reconnect storm when the tier recovers",b:"100M devices reconnect at once.",m:"Randomized backoff/jitter on reconnect."},
      ],
      tradeoffs:[
        {a:"Redis Pub/Sub",b:"Kafka",pick:"A poke is a tiny best-effort hint and correctness lives in the cursor log, so you don't need Kafka's durability/ordering — Redis-style is faster and cheaper; keep Kafka for the analytics side."},
        {a:"Hold all 100M connections",b:"Foreground-only",pick:"Foreground-only cuts ~400 nodes to ~100; cost is slightly staler sync for a sleeping device, which the user isn't watching anyway."},
      ],
      probes:[
        "The whole notification tier is down 20 min while edits continue — are devices permanently out of sync?",
        "A poke is lost exactly as a device's connection drops — how does it ever learn about v42?",
        "Why not Kafka for the notification backbone — what does a poke actually need?",
      ],
    },
  },
  dbDoc:{
    component:"Metadata DB",
    load:"~115K commits/s baseline, peak ×4 ≈ ~460K commits/s, and a commit is a small transaction (3-5 row writes + a CAS): advance the namespace version, write a file_versions row, update the files pointer. Sync-since-cursor reads dominate — ~1.6M reads/s cold, though the per-namespace+cursor cache collapses shared-folder herds to near one read per change. Volume: ~1 trillion files × ~5 versions ≈ 5 trillion version rows at ~200B/row ≈ 1PB, ×3 replication ≈ 3PB. So: read-heavy, write-hot, PB-scale, every write a small ACID transaction.",
    candidates:[
      {name:"Sharded Postgres / MySQL (relational)",ceiling:"~10K small commit-TPS per primary",nodes:"460K ÷ 10K ≈ <strong>~46 write shards</strong>, ×3 replicas ≈ ~140 nodes",pick:false,note:"genuinely viable because commits are single-shard, so per-shard ACID is free — but you operate the sharding, rebalancing, and replica failover yourself. The fallback if you must stay cheap and open-source."},
      {name:"Cassandra / ScyllaDB (wide-column)",ceiling:"~50K raw writes/node, but a CAS needs Paxos LWT at ~1-2K/s/node",nodes:"460K ÷ ~1.5K ≈ <strong>300+ nodes</strong> and still no cross-row atomicity",pick:false,note:"ruled out — the Paxos-CAS node math is worse than relational and it still cannot give atomic multi-row tree commits, the one property metadata cannot surrender."},
      {name:"Spanner / CockroachDB (NewSQL)",ceiling:"~5-10K ACID writes/node",nodes:"≈ <strong>~60-90 nodes</strong> with quorum replication built in",pick:true,note:"chosen — genuine distributed ACID for the per-namespace commit + version CAS, ordinary relational indexes, and built-in quorum replication, leader election, and rebalancing, so you do not hand-roll failover for ~140+ shards. Cost is money, some lock-in, and cross-region commit latency."},
    ],
    indexing:"All three access patterns are scoped to a namespace so each stays on one shard. <strong>1. Point lookup by (namespace_id, path)</strong> — open one file: a composite primary key on <code>(namespace_id, path)</code> gives a B-tree point lookup, ~O(log n). <strong>2. List a folder</strong> — that same index serves a <strong>prefix range scan</strong> (all rows under <code>/photos/</code>), so a directory listing is one contiguous scan, not a full-tree walk. <strong>3. Sync-since-cursor</strong> — the hot read: an index on <code>(namespace_id, version)</code> turns changes-since-N into a range scan of <code>version &gt; cursor</code>, returning only the delta in commit order. Cost is paid on write — each commit touches ~2 indexes — so keep the index set minimal on the 460K/s path. The file tree needs <strong>strong consistency</strong> (atomic multi-row commit + linearizable CAS), which is exactly what eventually-consistent stores give up, pushing the choice toward <strong>relational / NewSQL</strong>.",
    decision:"Lean <strong>Spanner / CockroachDB-class NewSQL</strong>: the per-namespace atomic commit and version CAS are the crux, and NewSQL gives distributed ACID, the <code>(namespace_id, path)</code> and <code>(namespace_id, version)</code> indexes as ordinary relational indexes, and built-in quorum replication + failover. <strong>Fallback:</strong> sharded Postgres/MySQL, viable because commits are single-shard, paid for by operating sharding yourself. <strong>Why not just KV/wide-column:</strong> a Paxos-CAS store costs more nodes and still cannot do atomic multi-row tree commits. And note the DB holds only <em>metadata</em> — the file tree, versions, ACLs, and cursors; the actual block bytes live in the content-addressed block store, separate and eventually consistent, so this store stays tiny relative to the petabytes of data it points at.",
  },
  schema:{tables:[
    {name:"files",pk:"file_id",columns:[
      ["file_id","bigint","primary key"],
      ["namespace_id","bigint","owning namespace (indexed)"],
      ["path","text","path within the namespace"],
      ["current_version","int","pointer to the live version"],
      ["is_dir","boolean","true for a directory node"],
    ],rows:[
      ["9001","42","/plan.xlsx","6","false"],
      ["9002","42","/photos","1","true"],
      ["9003","77","/onboarding.pdf","1","false"],
    ]},
    {name:"file_versions",pk:"(file_id, version)",columns:[
      ["file_id","bigint","which file"],
      ["version","int","monotonic version number"],
      ["chunk_hashes","text[]","ordered list of chunk hashes"],
      ["size","bigint","file size in bytes"],
      ["mtime","timestamptz","modification time"],
      ["device_id","bigint","device that committed it"],
    ],rows:[
      ["9001","5","[c1a2, c9f3, cb44]","1048576","2026-07-19 08:12:00","5501"],
      ["9001","6","[c1a2, c9f3, ce77]","1050112","2026-07-22 09:30:00","5502"],
      ["9003","1","[d0aa, d0bb]","15728640","2026-07-20 14:00:00","5503"],
    ]},
    {name:"chunks",pk:"chunk_hash",columns:[
      ["chunk_hash","varchar(64)","content hash, primary key"],
      ["storage_url","text","location in block storage"],
      ["ref_count","bigint","number of versions referencing it"],
      ["size","int","chunk size in bytes"],
    ],rows:[
      ["c1a2","s3://blk/c1/c1a2","2","524288"],
      ["ce77","s3://blk/ce/ce77","1","525824"],
      ["d0aa","s3://blk/d0/d0aa","100000","4194304"],
    ]},
    {name:"namespaces",pk:"namespace_id",columns:[
      ["namespace_id","bigint","primary key"],
      ["owner_id","bigint","account that owns it"],
      ["type","varchar(8)","user or shared"],
    ],rows:[
      ["42","7","user"],
      ["77","7","shared"],
    ]},
    {name:"device_cursors",pk:"(device_id, namespace_id)",columns:[
      ["device_id","bigint","a user device"],
      ["namespace_id","bigint","namespace it subscribes to"],
      ["last_synced_version","int","cursor of last applied change"],
    ],rows:[
      ["5501","42","6"],
      ["5502","42","5"],
      ["5503","77","1"],
    ]},
  ]},
  flows:[
    {id:"upload",name:"Upload a changed file",steps:[
      {node:"client",text:"The sync agent detects <code>plan.xlsx</code> changed and content-defined-chunks it locally into hashed chunks."},
      {node:"chunk",requires:["chunk"],text:"The chunker computes each chunk hash and asks the server which hashes are new, deduping any it already stores."},
      {node:"block",requires:["block"],text:"The client uploads only the missing chunks directly to block storage."},
      {node:"meta",text:"The metadata service commits a new file version referencing the ordered chunk-hash list and advances the namespace cursor."},
      {node:"db",text:"The metadata DB persists the new version row and updates the file current_version."},
    ]},
    {id:"sync",name:"Sync a change to another device",steps:[
      {node:"meta",text:"The commit advanced the namespace cursor, and the metadata service records the change against that namespace."},
      {node:"notif",requires:["notif"],text:"The notification service pushes a tiny you-are-behind poke to the user's other subscribed devices."},
      {node:"client",text:"A notified device requests changes-since its last_synced_version cursor."},
      {node:"meta",text:"The metadata service returns the delta of which files and versions changed."},
      {node:"block",requires:["block"],text:"The device pulls only the changed chunks from block storage and applies the new version locally."},
    ]},
  ],
  deepFlows:[
    {id:"upload-e2e",name:"Upload a change",summary:"Client detects a local edit → **content-defined chunks** it → asks which hashes are missing → uploads only new chunks keyed by **content hash** → commits <code>files.current_version</code> + <code>file_versions.chunk_hashes</code> atomically → sends a best-effort poke.",steps:[
      {node:"client",title:"Sync agent sees plan.xlsx change",narrate:"The desktop agent receives a filesystem event for <code>/plan.xlsx</code>, debounces it with nearby edits, and compares the local index against the last server version it applied. The server remains authoritative; the client is only preparing a candidate delta.",details:[
        {k:"wire",label:"Local change envelope",lang:"json",code:"{\n  \"device_id\": 5502,\n  \"namespace_id\": 42,\n  \"file_id\": 9001,\n  \"path\": \"/plan.xlsx\",\n  \"base_version\": 6,\n  \"size\": 1054208,\n  \"mtime\": \"2026-07-25T07:40:11Z\"\n}"},
        {k:"note",label:"Scale context",text:"At ~100M DAU × ~100 changed files/day the system sees ~10B change events/day (~115K/s baseline, 3-5× peak), so this path must be batched, idempotent, and avoid moving unchanged bytes."},
      ]},
      {node:"chunk",title:"Chunk and hash locally",narrate:"The client runs content-defined chunking with a ~4MB target so an insertion changes only the chunk around the edit, not every offset after it. It computes strong hashes and orders them exactly as the file should be reassembled.",details:[
        {k:"wire",label:"Chunk manifest offered by client",lang:"json",code:"{\n  \"file_id\": 9001,\n  \"base_version\": 6,\n  \"chunks\": [\n    {\"ord\":0,\"chunk_hash\":\"c1a2\",\"size\":524288},\n    {\"ord\":1,\"chunk_hash\":\"c9f3\",\"size\":524288},\n    {\"ord\":2,\"chunk_hash\":\"ce77\",\"size\":525824}\n  ]\n}"},
        {k:"gotcha",label:"Do not trust client hashes",text:"The client computes hashes to save bandwidth, but the server cannot trust them for integrity or quota. The block layer re-hashes uploaded bytes before a chunk becomes referenceable at <code>chunks.chunk_hash</code>."},
      ]},
      {node:"gw",title:"Ask which chunks are missing",narrate:"The API + sync service authenticates the device and forwards a cheap hash-existence check. It returns upload URLs only for chunk hashes absent from the <code>chunks</code> table; already-known hashes are just referenced in the eventual version commit.",details:[
        {k:"wire",label:"Dedup request/response",lang:"http",code:"POST /v1/namespaces/42/files/9001/chunks:offer\nContent-Type: application/json\n\n{\"device_id\":5502,\"hashes\":[\"c1a2\",\"c9f3\",\"ce77\"]}\n\n200 OK\n{\n  \"present\": [\"c1a2\", \"c9f3\"],\n  \"missing\": [\n    {\"chunk_hash\":\"ce77\",\"put_url\":\"https://blocks/upload/ce/ce77?...\"}\n  ]\n}"},
        {k:"query",label:"Chunk existence query",lang:"sql",code:"SELECT chunk_hash, storage_url, size\nFROM chunks\nWHERE chunk_hash IN ('c1a2', 'c9f3', 'ce77');\n-- missing ce77 -> mint a short-lived PUT URL scoped to s3://blk/ce/ce77"},
        {k:"gotcha",label:"Dedup vs privacy",text:"Global dedup saves huge storage (25EB raw → ~12EB unique), but exposing \"already present globally\" creates a cross-user existence oracle. Safer designs dedupe silently server-side or scope dedup per namespace, trading storage for privacy."},
      ]},
      {node:"block",title:"Upload only new chunks",narrate:"The client uploads missing chunk <code>ce77</code> directly to block storage; bytes never traverse the metadata fleet. The object key is derived from the content hash, so retries are idempotent and duplicate uploads converge on the same immutable object.",details:[
        {k:"wire",label:"Direct-to-storage PUT",lang:"http",code:"PUT https://blocks/upload/ce/ce77?sig=...\nContent-Length: 525824\nx-expected-sha256: ce77\n\n<525824 bytes>\n\n201 Created\nETag: \"ce77\""},
        {k:"route",label:"Block placement",lang:"text",code:"object_key = \"s3://blk/\" + chunk_hash[0:2] + \"/\" + chunk_hash\nce77 -> s3://blk/ce/ce77\ncell  = hash(chunk_hash) % NUM_BLOCK_CELLS"},
        {k:"repl",label:"Durability for chunks",text:"Chunks are immutable and content-addressed, so the block store can replicate/erasure-code them independently of metadata. At exabyte scale the target is EC 6+3 (~1.5× overhead, tolerate 3 fragment losses); early on S3-style 11-nines durability is acceptable."},
      ]},
      {node:"meta",title:"Commit the new file version",narrate:"After all referenced chunks are durable, the client sends a small metadata commit. This is the strong-consistency boundary: advance the file's live pointer only if it still points at the base version the client edited.",details:[
        {k:"wire",label:"Commit request",lang:"http",code:"POST /v1/namespaces/42/files/9001/versions\nIdempotency-Key: 5502-9001-v7-ce77\n\n{\n  \"device_id\": 5502,\n  \"base_version\": 6,\n  \"path\": \"/plan.xlsx\",\n  \"chunk_hashes\": [\"c1a2\", \"c9f3\", \"ce77\"],\n  \"size\": 1054208,\n  \"mtime\": \"2026-07-25T07:40:11Z\"\n}"},
        {k:"route",label:"Shard by namespace_id",text:"Route the transaction with <code>hash(namespace_id=42)</code>, not by raw content hash. A namespace's tree, version pointers, and device cursors stay co-located, so each commit and later changes-since read is single-shard; the trade-off is a giant shared namespace can become hot and may need path-range sub-partitioning."},
      ]},
      {node:"db",title:"CAS update files + insert file_versions",narrate:"The metadata DB verifies every chunk hash exists, inserts the immutable <code>file_versions</code> row, and advances <code>files.current_version</code> from 6 to 7 with a compare-and-set. If another device already advanced the file, this update affects zero rows and becomes a conflict path.",details:[
        {k:"query",label:"Atomic version commit",lang:"sql",code:"BEGIN;\n\n-- verify all referenced chunks became durable/referenceable\nSELECT chunk_hash FROM chunks\nWHERE chunk_hash = ANY(ARRAY['c1a2','c9f3','ce77'])\nFOR SHARE;\n\nUPDATE files\nSET current_version = 7\nWHERE file_id = 9001\n  AND namespace_id = 42\n  AND current_version = 6;   -- CAS guard\n\n-- require row_count = 1 before inserting the new version\nINSERT INTO file_versions\n  (file_id, version, chunk_hashes, size, mtime, device_id)\nVALUES\n  (9001, 7, ARRAY['c1a2','c9f3','ce77'], 1054208,\n   '2026-07-25 07:40:11Z', 5502);\n\nINSERT INTO chunks (chunk_hash, storage_url, ref_count, size)\nVALUES ('ce77', 's3://blk/ce/ce77', 1, 525824)\nON CONFLICT (chunk_hash) DO UPDATE\n  SET ref_count = chunks.ref_count + 1;\n\nCOMMIT;"},
        {k:"repl",label:"Metadata replication",text:"Metadata is small but correctness-critical. The namespace shard is a NewSQL/relational replica group across AZs; commits wait for quorum (leader + majority) before success. Cross-region DR can be async, but the in-region commit path cannot ack before quorum or a just-acknowledged version could vanish."},
        {k:"gotcha",label:"Orphan chunks are okay",text:"If the metadata commit fails after <code>ce77</code> was uploaded, the chunk is an orphan: durable but unreferenced. GC later reclaims it after a grace period. The reverse ordering — visible metadata pointing at a missing chunk — is the data-loss bug to avoid."},
      ]},
      {node:"notif",title:"Poke subscribed devices",narrate:"Once the metadata transaction commits, the system publishes a tiny hint to devices subscribed to namespace 42. The notification is intentionally not the source of truth; it only tells devices to pull from their cursor.",details:[
        {k:"wire",label:"Notification message",lang:"json",code:"{\n  \"type\": \"namespace_advanced\",\n  \"namespace_id\": 42,\n  \"file_id\": 9001,\n  \"current_version\": 7,\n  \"hint\": \"pull changes-since your cursor\"\n}"},
        {k:"repl",label:"Best-effort delivery",text:"Lost or duplicated pokes are harmless because <code>device_cursors.last_synced_version</code> drives catch-up. The notification tier can be Redis Pub/Sub-style and best-effort; correctness lives in the durable metadata rows."},
      ]},
    ]},

    {id:"download-e2e",name:"Sync down change",summary:"A device receives a **namespace advanced** poke → asks for metadata since <code>device_cursors.last_synced_version</code> → reads <code>files</code> + <code>file_versions.chunk_hashes</code> on the namespace shard → downloads missing content-hash chunks → atomically advances its device cursor.",steps:[
      {node:"notif",title:"Phone receives a stale hint",narrate:"The phone is subscribed to namespace 42 and currently has <code>last_synced_version=6</code>. A poke says <code>/plan.xlsx</code> is now at version 7, so it schedules a pull; a duplicate poke would schedule the same idempotent pull again.",details:[
        {k:"wire",label:"Poke over WebSocket/long-poll",lang:"json",code:"{\n  \"namespace_id\": 42,\n  \"file_id\": 9001,\n  \"current_version\": 7\n}"},
        {k:"note",label:"Why the poke carries no content",text:"Sending only <code>namespace_id</code> / cursor keeps fan-out cheap: ~350K pokes/s baseline, peak ~1.4M/s. Real metadata and bytes are pulled from authoritative services, so notification ordering and durability are not correctness requirements."},
      ]},
      {node:"client",title:"Client asks changes since its cursor",narrate:"The phone presents its durable cursor for this namespace. If it was offline for minutes, the same request returns all missed versions in order; if the poke was duplicate, the response is empty.",details:[
        {k:"wire",label:"Changes-since request",lang:"http",code:"GET /v1/namespaces/42/changes?device_id=5501&since=6\nAccept: application/json"},
        {k:"query",label:"Cursor row on the device",lang:"sql",code:"-- local / server-side subscription state mirrors this schema\nSELECT last_synced_version\nFROM device_cursors\nWHERE device_id = 5501 AND namespace_id = 42;\n-- returns 6"},
      ]},
      {node:"gw",title:"Route pull to the namespace shard",narrate:"The API + sync service authenticates the device and routes the read by <code>namespace_id=42</code>, the same key used by commits. This keeps changes-since a single-shard read and makes cache keys naturally <code>(namespace_id, cursor)</code>.",details:[
        {k:"route",label:"Read routing",lang:"python",code:"shard = jump_hash(namespace_id=42, NUM_METADATA_SHARDS)\ncache_key = \"changes:42:since:6\"\n# shared-folder herds hit the same immutable cache entry"},
        {k:"repl",label:"Leader vs replica read",text:"For a foreground device expecting read-your-writes, read from the shard leader or a replica with a freshness bound. For large shared-folder fan-out, serve from read replicas/cache because the changes-since response for <code>(namespace_id, cursor)</code> is immutable after commit."},
      ]},
      {node:"meta",title:"Build the delta manifest",narrate:"The metadata service loads the changed file row and its new version manifest. In the simplified schema the file's live pointer is <code>files.current_version</code>, and the ordered content list is <code>file_versions.chunk_hashes</code>.",details:[
        {k:"query",label:"Delta lookup",lang:"sql",code:"SELECT f.file_id, f.namespace_id, f.path, f.current_version,\n       v.chunk_hashes, v.size, v.mtime, v.device_id\nFROM files f\nJOIN file_versions v\n  ON v.file_id = f.file_id\n AND v.version = f.current_version\nWHERE f.namespace_id = 42\n  AND f.current_version > 6\nORDER BY f.current_version\nLIMIT 500;"},
        {k:"note",label:"Cacheability",text:"For a 5,000-member shared folder, all devices at cursor 6 ask for the same delta. Cache <code>namespace_id=42,since=6</code> so the DB does one range/point lookup and the herd is served from memory."},
      ]},
      {node:"db",title:"Return exact chunk locations",narrate:"The DB path resolves the ordered hashes to storage locations and sizes. The client can skip any chunk it already has locally by hash; identical chunks across files and versions need no download.",details:[
        {k:"query",label:"Resolve chunk URLs",lang:"sql",code:"SELECT chunk_hash, storage_url, size\nFROM chunks\nWHERE chunk_hash = ANY(ARRAY['c1a2','c9f3','ce77']);"},
        {k:"wire",label:"Changes-since response",lang:"json",code:"{\n  \"namespace_id\": 42,\n  \"from_version\": 6,\n  \"to_version\": 7,\n  \"changes\": [{\n    \"file_id\": 9001,\n    \"path\": \"/plan.xlsx\",\n    \"version\": 7,\n    \"size\": 1054208,\n    \"chunk_hashes\": [\"c1a2\",\"c9f3\",\"ce77\"]\n  }]\n}"},
      ]},
      {node:"block",title:"Download missing chunks by hash",narrate:"The phone compares the manifest to its local chunk cache. It already has <code>c1a2</code> and <code>c9f3</code>, so it fetches only <code>ce77</code> from block storage and verifies the bytes hash to that key.",details:[
        {k:"wire",label:"Chunk GET",lang:"http",code:"GET https://blocks/ce/ce77\nRange: bytes=0-\n\n200 OK\nContent-Length: 525824\nx-sha256: ce77\n\n<bytes>"},
        {k:"repl",label:"Read durability path",text:"Normal reads hit hot cache or the k data fragments directly. If a fragment or node is missing, EC 6+3 reconstructs from surviving fragments; the client still verifies the final chunk hash before using it."},
      ]},
      {node:"client",title:"Assemble file and advance cursor",narrate:"The client writes the new file to a temp local path, verifies the full manifest, atomically swaps it into <code>/plan.xlsx</code>, and only then advances its cursor. A crash before cursor update simply repeats the pull safely.",details:[
        {k:"query",label:"Cursor update after apply",lang:"sql",code:"UPDATE device_cursors\nSET last_synced_version = 7\nWHERE device_id = 5501\n  AND namespace_id = 42\n  AND last_synced_version = 6;"},
        {k:"gotcha",label:"Apply before cursor",text:"Never advance <code>device_cursors.last_synced_version</code> before bytes are durable locally. If the client crashes after cursor=7 but before writing <code>ce77</code>, it will falsely believe it is caught up and leave a corrupt/missing file."},
      ]},
    ]},

    {id:"conflict-e2e",name:"Offline conflict",summary:"Two devices edit from the same base → both upload chunks safely → the first CAS advances <code>files.current_version</code> → the second CAS fails → it creates a **conflicted copy** as a new file/version instead of last-write-wins data loss.",steps:[
      {node:"client",title:"Two devices edit from base v6",narrate:"Laptop <code>5502</code> and desktop <code>5501</code> both last synced <code>/plan.xlsx</code> at version 6, then go offline and make different edits. Timestamps are not trusted for conflict resolution because device clocks skew.",details:[
        {k:"wire",label:"Two candidate commits",lang:"json",code:"// laptop\n{\"device_id\":5502,\"file_id\":9001,\"base_version\":6,\"chunks\":[\"c1a2\",\"c9f3\",\"ce77\"]}\n\n// desktop\n{\"device_id\":5501,\"file_id\":9001,\"base_version\":6,\"chunks\":[\"c1a2\",\"c9f3\",\"cf88\"]}"},
        {k:"gotcha",label:"No last-write-wins",text:"Last-write-wins would silently destroy one edit. The invariant is stronger: every successfully uploaded user edit either fast-forwards the file or becomes a separate conflicted copy, so no content is silently overwritten."},
      ]},
      {node:"block",title:"Both upload their new chunks",narrate:"Each device uploads only its unique changed chunk (<code>ce77</code> or <code>cf88</code>) through the same content-addressed block path. Duplicate old chunks are reused by hash, so conflict handling does not double-store the whole file.",details:[
        {k:"query",label:"Dedup both changed chunks",lang:"sql",code:"SELECT chunk_hash FROM chunks\nWHERE chunk_hash IN ('ce77','cf88');\n-- both absent -> upload to s3://blk/ce/ce77 and s3://blk/cf/cf88"},
        {k:"note",label:"Why upload before conflict resolution",text:"The metadata winner/loser decision is tiny and transactional, while chunks are immutable. Uploading chunks first lets either outcome reference durable bytes; if a metadata write loses, its blocks remain harmless orphans until reused/GC'd."},
      ]},
      {node:"meta",title:"First commit wins the fast-forward",narrate:"The laptop reconnects first. Its commit says base version 6, and the DB still has <code>files.current_version=6</code>, so the compare-and-set advances the file to version 7.",details:[
        {k:"query",label:"Winning CAS",lang:"sql",code:"BEGIN;\nUPDATE files\nSET current_version = 7\nWHERE file_id = 9001\n  AND namespace_id = 42\n  AND current_version = 6;\n\nINSERT INTO file_versions\n  (file_id, version, chunk_hashes, size, mtime, device_id)\nVALUES\n  (9001, 7, ARRAY['c1a2','c9f3','ce77'], 1054208,\n   '2026-07-25 07:40:11Z', 5502);\nCOMMIT;"},
        {k:"repl",label:"Serialization point",text:"The version CAS is the serialization point for the file inside namespace 42. Quorum replication makes the winner durable before any device is notified."},
      ]},
      {node:"db",title:"Second commit sees stale base",narrate:"The desktop reconnects seconds later with base version 6, but the live row is already version 7. The guarded update affects zero rows, so the metadata service rejects it as a stale fast-forward rather than overwriting the laptop's version.",details:[
        {k:"query",label:"Losing CAS detects conflict",lang:"sql",code:"UPDATE files\nSET current_version = 7\nWHERE file_id = 9001\n  AND namespace_id = 42\n  AND current_version = 6;\n-- row_count = 0 because current_version is already 7\n\nSELECT current_version FROM files WHERE file_id = 9001;\n-- returns 7"},
        {k:"wire",label:"Conflict response",lang:"json",code:"409 Conflict\n{\n  \"file_id\": 9001,\n  \"server_version\": 7,\n  \"client_base_version\": 6,\n  \"resolution\": \"create_conflicted_copy\"\n}"},
      ]},
      {node:"meta",title:"Materialize a conflicted copy",narrate:"The desktop keeps the server's version as <code>/plan.xlsx</code> and writes its own edit as a new file path, for example <code>/plan (desktop conflicted copy).xlsx</code>. This is another normal metadata transaction in the same namespace shard.",details:[
        {k:"query",label:"Create conflicted file version",lang:"sql",code:"BEGIN;\nINSERT INTO files (file_id, namespace_id, path, current_version, is_dir)\nVALUES (9010, 42, '/plan (desktop conflicted copy).xlsx', 1, false);\n\nINSERT INTO file_versions\n  (file_id, version, chunk_hashes, size, mtime, device_id)\nVALUES\n  (9010, 1, ARRAY['c1a2','c9f3','cf88'], 1053184,\n   '2026-07-25 07:40:22Z', 5501);\n\nINSERT INTO chunks (chunk_hash, storage_url, ref_count, size)\nVALUES ('cf88', 's3://blk/cf/cf88', 1, 524912)\nON CONFLICT (chunk_hash) DO UPDATE\n  SET ref_count = chunks.ref_count + 1;\nCOMMIT;"},
        {k:"gotcha",label:"Version vectors vs schema",text:"A production system tracks per-file version vectors to distinguish true concurrency from stale delivery. This simplified schema exposes the essential guard as <code>base_version</code> vs <code>files.current_version</code>; the interview answer should still name version vectors for offline multi-device causality."},
      ]},
      {node:"notif",title:"Notify devices of both durable results",narrate:"Subscribers are poked once the namespace has the winner and the conflicted copy committed. Other devices pull the delta and see both files, preserving both users' work.",details:[
        {k:"wire",label:"Poke after conflict resolution",lang:"json",code:"{\n  \"namespace_id\": 42,\n  \"changes\": [\n    {\"file_id\":9001,\"path\":\"/plan.xlsx\",\"version\":7},\n    {\"file_id\":9010,\"path\":\"/plan (desktop conflicted copy).xlsx\",\"version\":1}\n  ]\n}"},
        {k:"note",label:"User-visible trade-off",text:"Conflicted copies are less elegant than automatic merge, but they are honest and safe for arbitrary binary files like spreadsheets. Apps with semantic merge support can resolve later; the storage layer's job is never to lose either edit."},
      ]},
    ]},
  ],
  requirements:{
    functional:[
      "Store files in a synced folder and back them up durably",
      "Sync every change to a user's other devices and to shared collaborators",
      "Upload and store files efficiently — never re-upload a whole file for a small edit",
      "Keep version history and work offline",
    ],
    nonFunctional:[
      "Near-instant sync — a small edit visible on another device within seconds",
      "Bandwidth- and storage-efficient — dedup identical content, transfer only changed chunks",
      "Durable — a committed file or version is never silently lost",
      "Correct under concurrent offline edits — never silently overwrite one device's work",
    ],
  },
  reqBuild:[
    {req:"Upload and store files efficiently (chunking)",reveal:["chunk","block"],turns:[
      {who:"intv",text:"Start with requirement one: a user saves a file into the synced folder and it must be stored durably. What is the minimal path using just your four core boxes?"},
      {who:"cand",text:"The <strong>client</strong> sends the file to the <strong>API + sync service</strong>, which asks the <strong>metadata service</strong> to record the file in the user's tree — path, size, version — in the <strong>metadata DB</strong>. That already tracks the namespace and tells other devices something exists. The open question is where the actual bytes live: shoving them into the metadata DB alongside the tree would be the naive move, and it collapses under real files."},
      {who:"intv",text:"Right — and a one-line edit to a 100MB file would re-upload all 100MB. Requirement one is really about doing storage and upload efficiently. Fix it at the architecture level."},
      {who:"cand",text:"Stop treating a file as one opaque blob. I split every file into <strong>chunks</strong> and store each chunk once, addressed by its content hash — let me add a <strong>chunker / dedup</strong> component and a <strong>block storage</strong> backend. Metadata holds only an ordered list of chunk hashes per file version; the bytes live in the block store. On an edit the client re-chunks and uploads only the chunks whose hashes the server lacks, so a small edit moves a handful of chunks, not the whole file. Identical chunks across files or users are stored once."},
      {who:"intv",text:"Why split content into a separate block store at all — why not keep the bytes in the metadata DB you already have?"},
      {who:"cand",text:"Because the two have opposite shapes. Metadata is tiny, high-QPS, mutable, and transactional — the file tree and version pointers. Content is huge, low-QPS, immutable, and throughput-bound. Coupling them makes the cheap hot path hostage to the expensive one and prevents scaling each on its own axis. Keeping content-addressed chunks in an immutable block store lets me dedup, replicate freely, verify by re-hashing, and eventually tier cold data — none of which I want tangled into a transactional metadata DB."},
    ],resources:[
      {title:"Dropbox: streaming file synchronization",url:"https://dropbox.tech/infrastructure/streaming-file-synchronization"},
      {title:"Content-defined chunking",url:"https://en.wikipedia.org/wiki/Content-defined_chunking"},
    ]},
    {req:"Propagate changes to a user's other devices",reveal:["notif"],turns:[
      {who:"intv",text:"Requirement two: a user edits a file on their laptop, and their phone should reflect it within seconds. With your current boxes, how does the phone find out a change happened?"},
      {who:"cand",text:"When the laptop commits, the metadata service advances that namespace's version cursor and records the change. The phone learns of it by syncing changes-since-its-cursor against the metadata service and pulling only the changed chunks. The naive way for the phone to know <em>when</em> to sync is to poll every few seconds — correct, but a request storm once you have a lot of devices."},
      {who:"intv",text:"So every device polling every few seconds — is that going to hold up as the fleet grows?"},
      {who:"cand",text:"No, so let me add a <strong>notification service</strong>. Devices hold a lightweight subscription, and when a namespace's cursor advances the notification service pushes a tiny 'you are behind, come sync' poke. The device then does the normal metadata sync and pulls the changed chunks. The push signal is deliberately dumb — it carries just the namespace and its new cursor, never content — so it turns constant polling into an event-driven nudge."},
      {who:"intv",text:"Why push only a poke instead of the actual changed content over that notification channel?"},
      {who:"cand",text:"Separation of concerns. The notification channel only needs to be timely and cheap — a fan-out of tiny idempotent stale signals. Putting real payloads on it would duplicate the metadata sync path and force ordering and durability guarantees onto the push layer. By keeping the poke dumb and letting the device pull authoritative state from the metadata service, a missed or duplicated poke is harmless: worst case the device's periodic poll finds the change one cycle later. The notification service is a latency optimization over polling, never the source of truth."},
    ],resources:[
      {title:"Dropbox: streaming file synchronization",url:"https://dropbox.tech/infrastructure/streaming-file-synchronization"},
      {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
    ]},
  ],
  systemDives:[
    {title:"A 50GB upload fails at 95% — resume + dedup",tag:"scaling",turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a user uploads a <b>50GB</b> video. At <b>95%</b> their Wi-Fi drops for 30 seconds. If the upload restarts from zero they lose ~47GB of transfer and will never finish on a flaky link. How does it resume?</span>"},
      {who:"cand",text:"Because the file is already <strong>chunked and content-addressed</strong>, resume is nearly free. Each chunk upload is an independent, idempotent operation keyed by the chunk's hash. The client tracks which chunk hashes the server has acknowledged; on reconnect it re-offers its hashes, the server replies which it already holds, and the client uploads only the missing ~5%. The 30-second blip costs at most the one in-flight chunk, not 47GB."},
      {who:"intv",text:"The final metadata commit ties those chunks into a file version. What if that commit fails after all blocks are up?"},
      {who:"cand",text:"Blocks and the commit are decoupled, and blocks are stored <strong>first</strong>. Orphan blocks with no referencing metadata are harmless — unreferenced content that garbage collection reclaims later. The commit is a single small transactional operation the client retries idempotently, keyed by the target version, until it lands. So the ordering is durably store all chunks, then commit the version pointing at them; a crash between the two leaves reclaimable orphans, never a half-visible file."},
      {who:"intv",text:"On a flaky link the client re-offers chunk hashes it already sent. Does re-uploading duplicates waste bandwidth and storage?"},
      {who:"cand",text:"No — <strong>dedup</strong> absorbs it. Re-offering a hash the server already stored is a no-op: the server recognizes the content address and just references the existing chunk instead of writing bytes again. So retries are cheap and safe by construction, and the same mechanism means two users uploading the identical 50GB file store it once. Content-addressing makes resume, retry, and cross-user dedup the same idea."},
    ],resources:[
      {title:"Dropbox: streaming file synchronization",url:"https://dropbox.tech/infrastructure/streaming-file-synchronization"},
      {title:"Dropbox: inside the Magic Pocket",url:"https://dropbox.tech/infrastructure/inside-the-magic-pocket"},
    ]},
    {title:"Two devices edit the same file offline then sync",tag:"durability",turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a laptop and a desktop both have <code>plan.xlsx</code>. Both go offline, both edit it, then both reconnect within <b>10 seconds</b> and push. Last-write-wins would silently destroy one person's work. What does the user see, and what guarantees nothing is lost?</span>"},
      {who:"cand",text:"Never silent data loss. Each device syncs against the <strong>base version</strong> it last saw. The server accepts the first push, advancing the file to v2. The second device pushes against the now-stale base; the server sees its expected parent no longer matches and rejects the fast-forward. The client then materializes a <strong>conflicted copy</strong> — it keeps the server's v2 as <code>plan.xlsx</code> and writes the loser's edit as a separate conflicted-copy file. Both edits survive as committed versions; a human reconciles."},
      {who:"intv",text:"How does the server actually detect the conflict — just compare timestamps?"},
      {who:"cand",text:"No — timestamps are unreliable across devices with skewed clocks. I track causality per file with a <strong>version vector</strong> (a counter per device). A push carries the base vector it derived from, and the server accepts it only if that vector dominates or equals the current one — a true descendant. If the two vectors are <strong>concurrent</strong> (neither dominates), that is a genuine conflict and I fork the conflicted copy. This distinguishes a real concurrent edit from mere out-of-order delivery, which timestamps cannot."},
      {who:"intv",text:"Where is the authoritative record that makes this durable — that neither edit can ever be silently dropped?"},
      {who:"cand",text:"The <strong>metadata store</strong> is the source of truth, and namespace version advancement is a <strong>compare-and-set</strong> transaction, so concurrent commits serialize rather than clobber. Every commit creates a new immutable version pointing at a content-addressed chunk list — the old version's chunks are untouched in the block store — so both the winning v2 and the forked conflicted copy exist as durable versions, retained in history for the policy window. Nothing is overwritten in place, so a losing edit is always recoverable, not gone."},
    ],resources:[
      {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      {title:"Dropbox: streaming file synchronization",url:"https://dropbox.tech/infrastructure/streaming-file-synchronization"},
    ]},
    {title:"A block-storage node holding unique chunks fails",tag:"failover",turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a storage node fails permanently, and it held the <b>only</b> copies of some chunks that are the sole content of <b>thousands</b> of users' files. How is this not permanent data loss?</span>"},
      {who:"cand",text:"It must never come down to a single node. At exabyte scale <strong>3x replication is too expensive</strong>, so chunks are protected with <strong>erasure coding</strong>: split each chunk or volume into k data + m parity fragments spread across independent failure domains, tolerating up to m simultaneous losses. With Reed-Solomon 6+3 a volume becomes 9 fragments on 9 nodes; any 6 reconstruct it, so up to 3 nodes can die with zero loss at only ~1.5x overhead. A node failure loses fragments, never whole chunks — I rebuild the lost fragments from survivors onto fresh nodes."},
      {who:"intv",text:"Erasure coding means a read might reconstruct from fragments — slower. Acceptable on the hot path?"},
      {who:"cand",text:"In steady state no reconstruction happens: the k data fragments are directly readable, so a normal read is a straight fetch, and reconstruction only kicks in when a fragment is missing, which is rare. For latency-sensitive hot chunks I also keep them cached and replicated on a fast tier, so erasure coding is the durable cold backbone, not the hot read path. Continuous background <strong>scrubbing</strong> re-hashes fragments to catch bit-rot and rebuilds proactively, so I never discover loss only when a node dies."},
      {who:"intv",text:"Now a whole zone hosting many fragments goes offline for an hour. Do downloads fail?"},
      {who:"cand",text:"They should not, if fragments are placed <strong>across zones</strong>, never concentrated in one. With 6+3 spread over multiple zones, losing a zone loses at most a few fragments per object — still within the m=3 tolerance — so every read reconstructs from surviving zones. The placement rule is that no single failure domain holds enough fragments to make an object unreadable, and cross-region replicas of hot data provide a fallback for the rare at-risk object. I also wait a short grace period before triggering full reconstruction, since a brief zone outage often self-resolves and a rebuild storm is costly."},
    ],resources:[
      {title:"Dropbox: inside the Magic Pocket",url:"https://dropbox.tech/infrastructure/inside-the-magic-pocket"},
      {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
    ]},
    {title:"Metadata DB shard for a busy namespace is overloaded",tag:"scaling",turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> one shard hosts a hyper-active shared folder mounted by <b>5,000</b> employees taking <b>hundreds</b> of edits an hour, and every edit fans out to 5,000 devices that all sync at once. The shard is pinned. How do you keep the metadata tier from melting?</span>"},
      {who:"cand",text:"I shard the metadata by <strong>namespace</strong> — shard key = hash of the namespace ID — so a folder's whole tree, versions, and cursor stay co-located and each device's sync is a single-shard transaction. A shared folder is its own namespace mounted by members, so an edit is <strong>one</strong> metadata commit that advances one cursor, not 5,000 writes. I make each shard individually replicated so read replicas absorb the sync reads, and rebalance namespaces across shards with consistent hashing to shed a hot shard without a full reshard."},
      {who:"intv",text:"The 5,000 members all issue the identical changes-since read at once — that is still a thundering herd on the DB."},
      {who:"cand",text:"Right, so I do not hit the DB 5,000 times. The changes-since response for a shared namespace at a given cursor is <strong>immutable and identical</strong> for every member, so I cache it keyed by namespace + cursor and serve the herd from cache. Jittered notification delivery spreads the reads over a few seconds instead of one spike, and membership is stored so fan-out is a list lookup, not a scan. One edit costs one DB write and one cached read replicated 5,000 times — the DB barely notices."},
      {who:"intv",text:"What if one namespace grows so large it outgrows a single shard on its own?"},
      {who:"cand",text:"A giant namespace — a 10M-file team folder — I sub-partition by path range within the shard while keeping metadata rows small, so the tree spreads without breaking the per-namespace commit boundary. Cross-namespace operations like sharing touch two namespaces, so I model sharing as a <strong>mount / reference</strong> rather than copying data across shards, which would multiply writes and break atomic per-namespace commits. So the strong-consistency unit stays one namespace, and I scale by spreading namespaces — and, when forced, one namespace's tree — across shards."},
    ],resources:[
      {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      {title:"Dropbox: streaming file synchronization",url:"https://dropbox.tech/infrastructure/streaming-file-synchronization"},
    ]},
  ],
  q:{
    client:[
      {l:"easy",tag:"concept",q:"How does the client notice a file changed?",turns:[
        {who:"intv",text:"A user drops a file into the synced folder and edits another. How does your sync agent notice, without rescanning the whole disk every second?"},
        {who:"cand",text:"The agent watches the folder with OS <strong>filesystem notifications</strong> — inotify on Linux, FSEvents on macOS, ReadDirectoryChangesW on Windows — so the OS pushes it changed paths instead of polling. It keeps a <strong>local index</strong> (a small SQLite DB) mapping each path to its size, mtime, and content hash. On an event it re-hashes just that file and compares to the index.<span class='eg'>Edit report.docx: FSEvents fires for that one path; the agent hashes it, sees the hash differ from the index, and queues just that file — the other 499,999 files are never touched.</span>Filesystem events can be missed or coalesced under load, so a periodic full scan reconciles as a backstop."},
        {who:"intv",text:"You mention a backstop scan. Why not trust the OS events alone?"},
        {who:"cand",text:"Because they're best-effort — under heavy churn the OS event buffer can overflow and drop events, and some network or removable filesystems don't emit them at all. The local index makes the scan cheap: I walk the tree comparing (size, mtime) against the index and only re-hash entries whose cheap metadata changed. So the common path is event-driven and instant; the scan is a rare, low-cost safety net that guarantees I never permanently miss a change."},
      ],resources:[
        {title:"Dropbox: streaming file synchronization",url:"https://dropbox.tech/infrastructure/streaming-file-synchronization"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"medium",tag:"scaling",q:"A user with 500K files — does the agent fall over?",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a developer syncs a monorepo — <b>500,000</b> files — and a <code>git checkout</code> rewrites <b>50,000</b> of them in 2 seconds. Naively the agent opens 500K watches and fires 50K sync requests. What breaks, and how do you keep it smooth?</span>"},
        {who:"cand",text:"Two pressures: watch scale and event storms. For watches I watch <em>directories</em> recursively rather than one handle per file — so 500K files is a few thousand directory watches, not 500K handles. For the storm I <strong>debounce and batch</strong>: coalesce the 50K events over a short window, dedupe repeated writes to the same path, and send a <em>batched</em> metadata commit rather than 50K round-trips. Hashing runs on a bounded worker pool.<span class='eg'>50K events in 2s → coalesced to ~50K unique paths → one batched tree-delta commit + block uploads only for files whose content hash actually changed.</span>"},
        {who:"intv",text:"Batching adds latency before a change is visible elsewhere. How big is the window?"},
        {who:"cand",text:"Adaptive. A small debounce (a few hundred ms) for a trickle of edits keeps interactive changes near-instant; it expands automatically under a storm to avoid hammering the server. The window trades a little propagation latency for a huge drop in request count — and during a 50K-file checkout the user isn't watching another device anyway, so the extra second is invisible. Steady-state single edits still sync in well under a second."},
      ],resources:[
        {title:"Dropbox: streaming file synchronization",url:"https://dropbox.tech/infrastructure/streaming-file-synchronization"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"hard",tag:"failover",q:"Two devices edit the same file offline — who wins?",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a laptop and a desktop both have <code>plan.xlsx</code>. Both go offline, both edit it, then both reconnect within <b>10 seconds</b> and push. Last-write-wins would silently destroy one person's work. What does the user see?</span>"},
        {who:"cand",text:"Never silent data loss. Each device syncs against the <strong>base version</strong> it last saw. The server accepts the first push, advancing the file to v2. The second device pushes against the now-stale base — the server sees its expected parent version no longer matches and rejects the fast-forward. The client then materializes a <strong>conflicted copy</strong>: it keeps the server's v2 as <code>plan.xlsx</code> and writes the loser's edit as <code>plan (desktop conflicted copy 2026-07-22).xlsx</code>. Both edits survive; a human reconciles."},
        {who:"intv",text:"How does the server actually detect the conflict — just compare timestamps?"},
        {who:"cand",text:"No — timestamps are unreliable across devices with skewed clocks. I track causality per file with a <strong>version vector / vector clock</strong> (a counter per device). A push carries the base vector it derived from; the server accepts it only if that vector <em>dominates or equals</em> the current one — a true descendant. If the two vectors are <strong>concurrent</strong> (neither dominates), that's a genuine conflict and I fork the conflicted copy. This distinguishes a real concurrent edit from mere out-of-order delivery, which timestamps cannot."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"medium",tag:"durability",q:"Client crashes mid-sync — is local state trustworthy?",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> the agent is halfway through uploading a batch when the machine hard-powers-off. On reboot the local index SQLite file is <b>corrupted</b>. Does the user lose data, or re-upload their entire 50GB folder?</span>"},
        {who:"cand",text:"Neither, if the local index is treated as a <em>cache</em>, not the source of truth. The authoritative state is the <strong>server's version of the namespace</strong>. On a corrupt index I rebuild it: re-scan local files computing hashes, fetch the server's file list, and diff. Files whose content hash already matches a stored block need <em>no</em> re-upload — dedup means I only push blocks the server lacks. So a corrupt index costs a rescan (CPU), not re-transfer of 50GB."},
        {who:"intv",text:"The rescan itself is expensive on 500K files. Anything to avoid full corruption in the first place?"},
        {who:"cand",text:"Yes — write the index with a proper <strong>WAL and atomic commits</strong> so a power loss leaves it consistent rather than corrupt in the normal case; corruption should be rare. I also checkpoint upload progress per file so an interrupted large upload resumes from its last committed block rather than restarting. The full rebuild is the worst-case backstop; the common crash just replays the WAL and continues. Because the server is authoritative and content-addressed, even the backstop is safe — I can always reconstruct correct local state from it."},
      ],resources:[
        {title:"Dropbox: streaming file synchronization",url:"https://dropbox.tech/infrastructure/streaming-file-synchronization"},
        {title:"Dropbox: inside the Magic Pocket",url:"https://dropbox.tech/infrastructure/inside-the-magic-pocket"},
      ]},
      {l:"medium",tag:"capacity",q:"How heavy is the sync agent on a normal machine?",turns:[
        {who:"intv",text:"Concrete numbers on the client itself. For a typical user, how big is the local index, how many watches, and how much work is hashing?"},
        {who:"cand",text:"Size it from a typical user of ~50K files averaging 1MB — ~50GB synced. The <strong>local index</strong> stores path, size, mtime, and hash per file — roughly 100 bytes each. Watches are per-<em>directory</em>, not per-file. Hashing only runs on changed files.<span class='eg'>Index: 50K files × 100B ≈ 5MB SQLite — trivial. Initial full hash of 50GB at ~500MB/s ≈ 100s, one-time. Steady state: a 1MB edit re-hashes in ~2ms.</span>So the resident footprint is tiny; the only heavy moment is the first full index."},
        {who:"intv",text:"Now a power user with 500GB and millions of files — does the agent still stay light?"},
        {who:"cand",text:"The index scales linearly and stays fine — 2M files × 100B ≈ 200MB — but the <strong>initial hash of 500GB at ~500MB/s ≈ 17 minutes</strong> of CPU and disk is very noticeable if I run it flat out. So the trade-off is first-sync speed versus not pinning the user's machine. Decision: I throttle hashing to a fraction of cores, index lazily in the background at low IO priority, and persist the index so it is a strict one-time cost. I trade a slower initial sync for an agent that never hijacks the laptop; steady state stays event-driven and near-free."},
      ],resources:[
        {title:"Dropbox: streaming file synchronization",url:"https://dropbox.tech/infrastructure/streaming-file-synchronization"},
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
      ]},
    ],
    gw:[
      {l:"medium",tag:"concept",q:"What does the sync service actually do?",turns:[
        {who:"intv",text:"You drew 'API + sync svc' as one edge box. A tiny metadata commit and a 2GB file upload both arrive here. Walk me through each — and be precise about the split."},
        {who:"cand",text:"<strong>Two planes.</strong> The <strong>metadata / control plane</strong> handles small, chatty operations: authenticate, accept a tree delta (this path now points at these block hashes), return what changed since a cursor. The <strong>data plane</strong> handles bulk content — the actual bytes. I keep them separate because they scale on different axes: metadata is high-QPS, tiny, latency-sensitive, transactional; data is low-QPS, huge, throughput-bound, immutable.<span class='eg'>A 1KB tree-delta commit hits the metadata service and DB; the 2GB of content is split into blocks stored separately, with metadata holding only the list of block hashes.</span>"},
        {who:"intv",text:"Why not just stream the file bytes through the same service that takes the commit?"},
        {who:"cand",text:"Because coupling them makes the cheap hot path hostage to the expensive one — a few big uploads would tie up connections and memory needed for millions of tiny metadata polls, and I couldn't scale them independently. Splitting lets me put a small, fast fleet on metadata and a throughput-optimized path (ideally direct-to-storage) on data. It also lets the metadata commit stay tiny and transactional while bytes flow out-of-band, referenced only by hash once durably stored."},
      ],resources:[
        {title:"Dropbox: streaming file synchronization",url:"https://dropbox.tech/infrastructure/streaming-file-synchronization"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"hard",tag:"scaling",q:"Upload a 100MB file after a one-line edit (adds chunker + block store).",reveal:["chunk","block"],turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a user edits <b>one paragraph</b> in a <b>100MB</b> presentation and hits save. The naive agent re-uploads all 100MB. Multiply by millions of such edits and your bandwidth bill and sync latency explode. Make this cheap.</span>"},
        {who:"cand",text:"Stop treating a file as one blob. I split every file into <strong>chunks</strong> and store each chunk once in a <strong>block store</strong>, addressed by its content hash — let me add a <strong>chunker / dedup</strong> component and a <strong>block storage</strong> backend. On an edit the agent re-chunks the file and uploads only the chunks whose hashes the server doesn't already have. A one-paragraph edit changes a handful of chunks.<span class='eg'>100MB file ≈ chunks of ~4MB; editing one paragraph rewrites 1-2 chunks → ~4-8MB uploaded, not 100MB. Over 95% bandwidth saved.</span>"},
        {who:"intv",text:"Fixed 4MB chunks — sure that survives the edit? What if the edit <em>inserts</em> bytes?"},
        {who:"cand",text:"Good catch — that's exactly why fixed-size chunking is fragile, and I'll want <strong>content-defined chunking</strong> in the chunker. But even before that subtlety the architecture is now right: metadata stores an ordered list of chunk hashes per file version, the block store holds the unique chunks, and sync is a hash-diff. We should drill into the chunker to get the boundaries right — that's where the real cleverness is."},
      ],resources:[
        {title:"Dropbox: streaming file synchronization",url:"https://dropbox.tech/infrastructure/streaming-file-synchronization"},
        {title:"Content-defined chunking",url:"https://en.wikipedia.org/wiki/Content-defined_chunking"},
      ]},
      {l:"hard",tag:"failover",q:"A 50GB upload dies at 95% — start over?",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a user uploads a <b>50GB</b> video. At <b>95%</b> their Wi-Fi drops for 30 seconds. If the upload restarts from zero they lose ~47GB of transfer and will never finish on a flaky link. How does it resume?</span>"},
        {who:"cand",text:"Because the file is already <strong>chunked and content-addressed</strong>, resume is almost free. Each chunk upload is an independent, idempotent operation keyed by the chunk's hash. The client tracks which chunk hashes the server has acknowledged. On reconnect it asks the server which blocks it already holds (or simply re-offers the hashes) and uploads only the missing ~5%. Re-offering an already-stored chunk is a no-op the server dedupes away. So the 30s blip costs at most the one in-flight chunk, not 47GB."},
        {who:"intv",text:"The final metadata commit ties those chunks into a file version. What if <em>that</em> fails after all blocks are up?"},
        {who:"cand",text:"Blocks and the metadata commit are decoupled, and blocks are committed <strong>first</strong>. Orphan blocks with no referencing metadata are harmless — just unreferenced content that garbage collection reclaims later. The commit itself is a single small transactional operation the client retries idempotently (keyed by the target version) until it succeeds. So the ordering is: durably store all chunks → commit the version pointing at them. A crash between the two leaves reclaimable orphans, never a corrupt or half-visible file."},
      ],resources:[
        {title:"Dropbox: streaming file synchronization",url:"https://dropbox.tech/infrastructure/streaming-file-synchronization"},
      ]},
      {l:"medium",tag:"concept",q:"Does every byte flow through your servers?",turns:[
        {who:"intv",text:"At exabyte scale, proxying every file's bytes through your app fleet is a bandwidth nightmare. How do you get content to the block store without it transiting your service?"},
        {who:"cand",text:"I don't proxy bytes. The client authenticates to the sync service and asks to store a set of chunk hashes; the service checks which are new and returns <strong>pre-signed, short-lived upload URLs</strong> pointing directly at the block store (S3-style). The client uploads chunks straight to storage over those URLs; my service never touches the bytes — it only handles small metadata: which hashes exist, and the tree commit.<span class='eg'>Store a new 4MB chunk: service returns a pre-signed PUT URL scoped to that one object for ~15 min; client PUTs 4MB directly to storage; service records the hash on commit.</span>"},
        {who:"intv",text:"If the client writes straight to storage, how do you stop it uploading garbage or lying about a hash?"},
        {who:"cand",text:"The pre-signed URL is scoped to a single object key derived from the claimed content hash and expires quickly, so it can't be reused or aimed elsewhere. On commit — or lazily — the block store / dedup layer <strong>verifies the stored bytes hash to the claimed key</strong>; a mismatch is rejected and the block never becomes referenceable. Content-addressing makes this self-checking: the address <em>is</em> the hash, so a lie fails verification. Auth and quota are enforced when I mint the URL, so an unauthenticated or over-quota client never gets one."},
      ],resources:[
        {title:"Dropbox: inside the Magic Pocket",url:"https://dropbox.tech/infrastructure/inside-the-magic-pocket"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"medium",tag:"capacity",q:"How many API + sync instances do you run?",turns:[
        {who:"intv",text:"Numbers now. You quoted ~115K change events/s at peak 3-5x, plus every device syncing. How many API + sync-service instances, and show the math."},
        {who:"cand",text:"I size the <strong>metadata / control plane</strong> on request rate; the data plane needs no instances because bytes go direct-to-storage over pre-signed URLs. The service is stateless — accept a tree delta, return changes-since — so a 4-core instance handles maybe ~5K req/s.<span class='eg'>Commits: 115K/s × 4 peak ≈ 460K/s; add sync-pull reads → call it ~500K rps. ÷5K rps/instance ≈ 100 instances; +30% headroom ≈ 130. Byte uploads bypass the fleet entirely → 0 instances for content.</span>So ~130 metadata instances at peak, spread across at least 3 AZs."},
        {who:"intv",text:"130 feels like a lot for forwarding tiny commits. What cuts it?"},
        {who:"cand",text:"The count is dominated by how many sync reads actually reach the fleet, and two levers slash that. Direct-to-storage already removes the expensive byte path, and the <strong>notification service</strong> turns constant polling into event-driven pokes, so sync reads collapse from a naive every-few-seconds poll to roughly one read per real change. Decision: size to survive the poll-heavy worst case but keep a <strong>warm floor</strong> (~40 across AZs) and autoscale above it — steady state is far lower once pokes and per-namespace caching land. The trade-off is provisioning cost versus autoscale lag on a sudden spike."},
      ],resources:[
        {title:"Dropbox: streaming file synchronization",url:"https://dropbox.tech/infrastructure/streaming-file-synchronization"},
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
      ]},
    ],
    meta:[
      {l:"medium",tag:"concept",q:"How do other devices learn of a change (adds notification svc)?",reveal:["notif"],turns:[
        {who:"intv",text:"A user saves a file on their laptop. Their phone should show it seconds later. Walk me through how the phone finds out — without hammering your servers."},
        {who:"cand",text:"When the laptop commits, the metadata service advances that namespace's version and records the change. The phone must learn of it promptly. Polling every few seconds by 100M devices would be a storm, so I add a <strong>notification service</strong>: devices hold a lightweight subscription, and when a namespace's cursor advances the notification service pushes a tiny 'you're behind, come sync' signal. The phone then does a normal metadata sync (changes since its cursor) and pulls only the changed blocks.<span class='eg'>Laptop commit → namespace cursor 41→42 → notif pushes 'namespace X changed' → phone GETs changes-since-41, sees one new file, pulls its chunks.</span>Let me add the notification service — the push signal is deliberately dumb; the metadata sync carries the real content."},
        {who:"intv",text:"Why push only a 'come sync' poke instead of the actual change over the notification channel?"},
        {who:"cand",text:"Separation of concerns and simplicity. The notification channel only needs to be timely and cheap — a fan-out of tiny, idempotent 'stale' signals. Putting real payloads on it would duplicate the metadata sync path, force ordering and durability guarantees onto the push layer, and bloat it. By keeping the poke dumb and letting the device pull authoritative state from the metadata service, a missed or duplicated notification is harmless — worst case the device polls once and finds nothing. The notification service becomes a latency optimization over polling, not a source of truth."},
      ],resources:[
        {title:"Dropbox: streaming file synchronization",url:"https://dropbox.tech/infrastructure/streaming-file-synchronization"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"hard",tag:"scaling",q:"A shared folder with thousands of members.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a company shares one folder with <b>5,000</b> employees. Someone adds a file. Now 5,000 devices must be notified and sync the same change — and this folder gets hundreds of edits an hour. How do you keep this from melting the metadata tier?</span>"},
        {who:"cand",text:"The change is written <em>once</em> to the shared namespace; the cost is the fan-out. I model a shared folder as its own <strong>namespace with a single version cursor</strong>, and each member's account <em>mounts</em> it. On an edit I advance that one cursor and notify the 5,000 subscribers — a fan-out on the notification side, not 5,000 metadata writes. Devices then pull the same changes-since-cursor, and because content is deduped/content-addressed, the block store serves identical chunks (cacheable) to all of them.<span class='eg'>One edit → 1 metadata commit on the shared namespace → 5,000 notify pokes → 5,000 identical changes-since reads → shared chunks from block-store cache.</span>"},
        {who:"intv",text:"5,000 near-simultaneous 'changes-since' reads for the identical response — still a thundering herd on the metadata DB."},
        {who:"cand",text:"Right, so I don't hit the DB 5,000 times. The changes-since-cursor response for a shared namespace at a given version is <strong>immutable and identical</strong> for every member, so I cache it (keyed by namespace + cursor) and serve the herd from cache. Jittered notification delivery spreads the reads over a few seconds instead of one spike. And membership is stored so fan-out is a list lookup, not a scan. So one edit costs one DB write and one cached read replicated 5,000 times — the DB barely notices."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"Dropbox: streaming file synchronization",url:"https://dropbox.tech/infrastructure/streaming-file-synchronization"},
      ]},
      {l:"medium",tag:"durability",q:"Never lose a version — how is history kept?",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a user overwrites a 200-page thesis with an empty file by mistake, syncs it, and the empty version propagates to every device. They panic <b>3 days</b> later. Can you recover the 200 pages, and for how long?</span>"},
        {who:"cand",text:"Yes, because a sync is <strong>never destructive</strong> to history. Each commit creates a <em>new</em> file version pointing at a new list of chunk hashes; the old version's chunk list still exists and its chunks remain in the immutable, content-addressed block store — nothing was overwritten in place. Recovery is 'set the file's current pointer back to version N.' I retain version history for a policy window (say 30 days, longer on paid tiers), so a 3-day-old good version is trivially restorable.<span class='eg'>Overwrite: v5 (200 pages) → v6 (empty). v6 just points at a different chunk list; v5's chunks are untouched. Restore = a new v7 reusing v5's chunk hashes — zero re-upload.</span>"},
        {who:"intv",text:"Keeping every version forever isn't free. How do you bound storage without breaking recovery?"},
        {who:"cand",text:"Retention policy plus dedup. Chunks shared across versions are stored once, so history is far cheaper than N full copies — an edit touching 1 chunk adds 1 chunk, not a whole file. Beyond the retention window I prune old versions: drop their metadata and <strong>decrement ref counts</strong> on their chunks; chunks that reach zero references become eligible for garbage collection. So live data and recent history are fully protected and cheap, while unbounded growth is capped by policy. The guarantee is: within the window, every committed version is recoverable."},
      ],resources:[
        {title:"Dropbox: inside the Magic Pocket",url:"https://dropbox.tech/infrastructure/inside-the-magic-pocket"},
        {title:"Dropbox: streaming file synchronization",url:"https://dropbox.tech/infrastructure/streaming-file-synchronization"},
      ]},
      {l:"hard",tag:"failover",q:"Metadata node dies mid-commit — partial tree?",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a client commits a batch moving 3,000 files and creating 200 new ones — one logical operation. The metadata service instance handling it <b>crashes</b> after writing half the changes. Does the user's tree end up half-moved and corrupt?</span>"},
        {who:"cand",text:"No — a commit must be <strong>atomic</strong>. The metadata service applies a batch as a single transaction against the metadata DB: either the namespace advances to the new version with all 3,200 changes, or it stays at the old version and the client retries. There's no visible half-state because the namespace <strong>cursor only advances on commit</strong> — devices reading changes-since always see a consistent version boundary. A crashed instance is stateless; the client reconnects to another instance and retries the idempotent commit (keyed by the target version), which either finds it already applied or applies it cleanly."},
        {who:"intv",text:"Two devices commit to the same namespace at the same instant. Both target version 42. What happens?"},
        {who:"cand",text:"They serialize on the namespace. The store applies commits with a <strong>compare-and-set on the version</strong>: the first to land takes the namespace 41→42; the second, which also targeted 42, finds its expected parent is now stale and is rejected. That client re-reads changes-since-41, rebases its delta onto 42, and commits again as 42→43. For non-overlapping changes the rebase is automatic; for the same file it degenerates into the conflicted-copy path we discussed. So concurrent commits are linearized per namespace — never lost or interleaved."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"medium",tag:"capacity",q:"Size the metadata-service fleet — commits vs sync reads.",turns:[
        {who:"intv",text:"How many metadata-service instances, and what QPS must they serve — separate commits from sync reads."},
        {who:"cand",text:"It is read-dominated. Commits are ~115K/s × 4 peak ≈ 460K/s. Sync reads are the bigger unknown: 100M devices asking changes-since. An instance does maybe ~6K rps of these light ops.<span class='eg'>If each of 100M devices syncs ~once/min on average → ~1.6M reads/s cold; ÷6K rps ≈ ~270 instances pre-cache. Commits ~460K/s ≈ ~80 instances. Post-cache the shared-folder herd collapses to one cached read per namespace+cursor → ~50-80 instances.</span>"},
        {who:"intv",text:"Those sync reads swing wildly with cache-hit ratio — how do you plan capacity you cannot pin?"},
        {who:"cand",text:"The count is a function of the changes-since cache-hit ratio: that response is <strong>immutable and identical per namespace+cursor</strong>, so it caches almost perfectly, and jittered pokes spread the herd over seconds. Decision: size the fleet to survive a <strong>cold cache</strong> (a few hundred instances), but run a warm floor with read replicas absorbing reads and autoscale down — the honest steady state is low-tens once caching works. The trade-off is paying for worst-case provisioning versus risk during a cache flush, so I keep the floor rather than trust autoscale to catch a stampede."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"Dropbox: streaming file synchronization",url:"https://dropbox.tech/infrastructure/streaming-file-synchronization"},
      ]},
    ],
    db:[
      {l:"medium",tag:"concept",q:"What consistency does the metadata DB need?",turns:[
        {who:"intv",text:"Your block store is eventually consistent and immutable, but you keep saying metadata is 'transactional.' Why the asymmetry — can't the whole system be eventually consistent?"},
        {who:"cand",text:"They have opposite requirements. <strong>Blocks are immutable and content-addressed</strong>: a chunk hash always maps to the same bytes, so a replica being slightly behind only means 'doesn't have this brand-new chunk yet,' resolved by retry — eventual consistency is perfectly safe and lets storage scale cheaply and globally. <strong>Metadata is mutable, ordered state</strong>: the current version of a namespace, version vectors, who has access. Reading a stale namespace version means missing or resurrecting edits, and conflict detection needs one authoritative order.<span class='eg'>Chunk abc123 is the same bytes on every replica forever → eventual is fine. Namespace version 41 vs 42 must be globally agreed → strong.</span>"},
        {who:"intv",text:"So where exactly do you draw the strong-consistency boundary?"},
        {who:"cand",text:"Strong consistency — transactions, compare-and-set — applies to the <strong>metadata namespace</strong>: version advancement, tree structure, sharing/ACLs, and dedup ref counts. Everything on the <strong>data plane</strong> — chunk storage, cross-region block replication, the notification pokes — is eventual. That gives me a small, strongly-consistent core that's cheap to keep correct (metadata is tiny) and a huge, eventually-consistent bulk plane that's cheap to scale. The art is keeping that strong core small; if I made petabytes of blocks strongly consistent I'd never scale."},
      ],resources:[
        {title:"Dropbox: inside the Magic Pocket",url:"https://dropbox.tech/infrastructure/inside-the-magic-pocket"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"hard",tag:"scaling",q:"Shard the metadata for trillions of files.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> you have <b>500M</b> users and <b>trillions</b> of files. A single metadata DB is long past its limit — it must hold the tree, versions, and ACLs for everyone. How do you shard it, and what's your shard key?</span>"},
        {who:"cand",text:"I shard by <strong>namespace</strong> — a user's root folder or a shared folder is a namespace — with shard key = hash of the namespace ID. This keeps <em>all of one namespace's metadata co-located</em>: the tree, versions, and cursor for a folder live on one shard, so a device's sync (always scoped to namespaces it mounts) is a single-shard transaction, and the atomic per-namespace commit and compare-and-set stay local.<span class='eg'>Hash(namespace_id) % N → shard; a user's personal namespace and its whole tree on shard 7; a shared team folder is its own namespace, maybe on shard 12.</span>"},
        {who:"intv",text:"Sharding by namespace hash — what breaks when one namespace is huge or one shard runs hot?"},
        {who:"cand",text:"Two issues. A <strong>single giant namespace</strong> (a 10M-file team folder) can outgrow a shard — I mitigate by keeping metadata rows small and, if needed, sub-partitioning that namespace's tree by path range within the shard. A <strong>hot shard</strong> (a very active namespace) I handle by making shards individually replicated (read replicas absorb sync reads) and rebalancing namespaces across shards with consistent hashing, so I can shift load without a full reshard. Cross-namespace operations like sharing touch two namespaces, so I keep sharing as a mount/reference, never copying data across shards."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"Dropbox: streaming file synchronization",url:"https://dropbox.tech/infrastructure/streaming-file-synchronization"},
      ]},
      {l:"hard",tag:"durability",q:"A shard's disk dies — is metadata lost?",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> the single node holding metadata shard 7 suffers a disk failure and won't return. That shard held file trees and version history for ~30M namespaces. Are those users' file structures gone — even though their file <em>content</em> is safe in the block store?</span>"},
        {who:"cand",text:"That would be catastrophic — the blocks are worthless without the metadata that says which chunks form which file version. So a shard is never one node: each shard is a <strong>replica group</strong> (say 3-5 nodes across AZs) with writes acknowledged by a <strong>quorum</strong> before commit. A single disk failure loses nothing — surviving replicas hold the data and a fresh replica rebuilds from them. This is exactly why metadata lives in a replicated, transactional store rather than a single DB."},
        {who:"intv",text:"Quorum writes on every commit — doesn't that slow the hot sync path?"},
        {who:"cand",text:"The hot path is metadata <em>reads</em> (devices polling changes-since), and those go to replicas cheaply. Writes — commits — are lower-QPS and can afford a few-ms quorum round-trip; durability of the file tree is non-negotiable, so I pay it. To keep the write quorum tight I keep replicas within a region and replicate cross-region asynchronously for DR. So per-commit latency stays low, every commit is durable against a node loss, and I still have an off-region copy if a whole region is lost."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"Dropbox: inside the Magic Pocket",url:"https://dropbox.tech/infrastructure/inside-the-magic-pocket"},
      ]},
      {l:"hard",tag:"failover",q:"The shard for a busy namespace fails — sync availability?",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> the <b>write-primary</b> for shard 7 — which hosts a hyper-active 5,000-person shared folder — crashes at peak. Commits to every namespace on that shard stall. How long is sync degraded, and can it split-brain?</span>"},
        {who:"cand",text:"Reads stay up throughout — replicas keep serving changes-since, so devices still <em>receive</em> updates; only new commits on shard 7 pause. Recovery is a <strong>leader election</strong>: the replica group promotes a new primary via consensus (Raft/Paxos), granting a higher <strong>epoch/term</strong>. Commits resume in the seconds it takes to elect. Split-brain is prevented by the epoch: if the old primary rejoins thinking it's still leader, its writes carry a stale epoch and replicas <strong>fence</strong> them off, then it demotes and re-syncs. There is never a window with two accepted primaries."},
        {who:"intv",text:"During that election window, a user hits save on that folder. What do they experience?"},
        {who:"cand",text:"Their client attempts the commit, gets a retryable error (leader unavailable), and <strong>queues it locally</strong> — the sync agent already buffers changes and retries, so from the user's side the save is instant to local disk and syncs a few seconds later when the new primary is up. No data loss, just brief added propagation latency on that one shard. This is the CAP trade-off: for metadata writes I choose <strong>consistency over availability</strong> during a partition — a few seconds of retry beats a corrupted or forked file tree. Managed stores that do this fencing internally are why I'd lean on one rather than hand-roll failover."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"medium",tag:"capacity",q:"How much metadata storage, and how many shards/nodes?",turns:[
        {who:"intv",text:"Size the metadata store. You have trillions of files, each with versions. How many rows, how much storage, and how many shards/nodes?"},
        {who:"cand",text:"Rows first, then throughput, and I take the max.<span class='eg'>~1 trillion files × ~5 versions ≈ 5 trillion version rows; at ~200 B/row ≈ 1 PB; × 3-way replication ≈ 3 PB; at ~2 TB usable/node ≈ ~1,500 nodes for space alone. Throughput: ~460K commits/s peak plus sync reads — reads lean on replicas and cache, commits drive the write sizing.</span>Storage dominates, so I provision on the order of ~1,500 nodes, sharded by namespace so each commit stays single-shard."},
        {who:"intv",text:"That is sized for all history kept hot forever — wasteful?"},
        {who:"cand",text:"Yes — most namespaces are cold and most of the rows are old versions no one reads. Decision: I <strong>tier</strong> the metadata — live tree plus recent versions on the fast sharded cluster, older version rows aged to cheaper storage, and retention policy prunes past the window (decrementing chunk ref counts). That can cut the hot cluster several-fold. The trade-off is a slower path for rare deep-history lookups versus paying to keep trillions of stale version rows on fast nodes; since deep history is rarely touched, the cliff is acceptable."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"Dropbox: streaming file synchronization",url:"https://dropbox.tech/infrastructure/streaming-file-synchronization"},
      ]},
      {l:"hard",tag:"concept",q:"Which database for the metadata store, and why?",turns:[
        {who:"intv",text:"You keep calling the metadata store transactional and sharded by namespace. Concretely — which database, and what are the real contenders? Start by pinning the load it has to survive."},
        {who:"cand",text:"Let me quantify before I name anything. <strong>Writes:</strong> ~115K commits/s baseline, peak ×4 ≈ <strong>460K commits/s</strong>, and a commit is not one row — it advances the namespace version, writes a file_versions row, and updates the files pointer, so call it 3-5 row writes plus a CAS each. <strong>Reads:</strong> the sync-since-cursor read dominates — 100M devices asking changes-since roughly once a minute is ~1.6M reads/s cold, though the per-namespace+cursor cache collapses the shared-folder herd to near one read per change. <strong>Volume:</strong> ~1 trillion files × ~5 versions ≈ 5 trillion version rows at ~200 B/row ≈ 1 PB before replication. So: read-heavy, write-hot, PB-scale, and every write is a small ACID transaction."},
        {who:"intv",text:"Fine — but does that write really need to be a transaction? Why can't a wide-column store like Cassandra just eat 460K writes/s and be done?"},
        {who:"cand",text:"Because the <strong>file tree needs strong consistency</strong>, and that is exactly what a plain quorum-write store gives up. A commit must atomically advance the namespace version <em>and</em> land its rows as one unit, with a <strong>compare-and-set</strong> so two concurrent commits serialize (41 to 42, the loser rebases) instead of clobbering. If a device could read version 42 but miss a row that belongs to it, its tree is corrupt; if the CAS is not linearizable, I silently lose an edit. That is a multi-row, read-modify-write invariant — the definition of a transaction — so the choice is pushed toward <strong>relational or NewSQL</strong>, not eventually-consistent stores.<span class='eg'>Sharded Postgres/MySQL: ~10K small commit-TPS per primary ceiling → 460K/s ÷ 10K ≈ ~46 write shards, ×3 replicas ≈ ~140 nodes; single-shard ACID is free, I operate sharding. Cassandra: ~50K raw writes/node, but a CAS needs Paxos lightweight-txn at ~1-2K/s/node → 460K ÷ ~1.5K ≈ 300+ nodes and still no cross-row atomicity. Spanner/CockroachDB: ~5-10K ACID writes/node → ~60-90 nodes with quorum replication built in.</span>"},
        {who:"intv",text:"Consistency aside, this store lives or dies on its access patterns. What do you index, and what does each lookup cost?"},
        {who:"cand",text:"Three access patterns drive the indexing, all scoped to a namespace so they stay on one shard. <strong>1. Point lookup by (namespace_id, path)</strong> — open one file: a composite index / primary key on <code>(namespace_id, path)</code> gives a B-tree point lookup, ~O(log n), a few ms. <strong>2. List a folder</strong> — that same <code>(namespace_id, path)</code> index serves a <strong>prefix range scan</strong> (all rows under <code>/photos/</code>), so a directory listing is one contiguous index scan, not a full-tree walk. <strong>3. Sync-since-cursor</strong> — the hot read: an index on <code>(namespace_id, version)</code> turns changes-since-N into a range scan of <code>version &gt; cursor</code>, returning only the delta in commit order.<span class='eg'>List /photos in namespace 42 → range scan on (42, '/photos/%') ≈ rows-returned, not tree size. changes-since-41 → scan (42, v&gt;41) → ~one edit's rows. Cost paid on write: each commit updates ~2 indexes, so keep the index set minimal — extra indexes multiply write amplification on the 460K/s path.</span>"},
        {who:"intv",text:"So make the call, and be honest about what it costs you."},
        {who:"cand",text:"Decision: I lean <strong>Spanner / CockroachDB-class NewSQL</strong>. The per-namespace atomic commit and version CAS are the crux, and this gives me genuine distributed ACID, the <code>(namespace_id, path)</code> and <code>(namespace_id, version)</code> indexes as ordinary relational indexes, and built-in quorum replication, leader election, and rebalancing — so I do not hand-roll failover for ~140+ shards forever. The honest cost is money, some lock-in, and cross-region write latency on commits. <strong>Fallback:</strong> if I must stay cheap and open-source, <strong>sharded Postgres/MySQL</strong> is genuinely viable <em>because commits are single-shard</em> — I pay for it by operating the sharding, rebalancing, and replica failover myself. <strong>Ruled out:</strong> pure Cassandra/Dynamo — the Paxos-CAS node math above is worse than the relational option and it still cannot give me atomic multi-row tree commits, which is the one property metadata cannot surrender."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"Dropbox: streaming file synchronization",url:"https://dropbox.tech/infrastructure/streaming-file-synchronization"},
      ]},
    ],
    chunk:[
      {l:"medium",tag:"concept",q:"Fixed-size vs content-defined chunking.",turns:[
        {who:"intv",text:"Earlier you waved at 'content-defined chunking.' Convince me it beats simple fixed 4MB blocks — with a concrete example."},
        {who:"cand",text:"Fixed-size chunking breaks on <strong>insertions</strong>. Cut a file every 4MB from offset 0, then <strong>insert 1 byte at the front</strong>: every subsequent byte shifts by one, so every boundary moves and <em>every</em> chunk hash changes — the whole file looks new and re-uploads. <strong>Content-defined chunking</strong> sets boundaries by content, not offset: I slide a <strong>rolling hash</strong> (Rabin fingerprint) over the bytes and cut a boundary wherever the hash matches a pattern (e.g. low bits zero). A 1-byte insert only disturbs the chunk containing it; boundaries re-align right after, so all other chunks are byte-identical and dedupe.<span class='eg'>Fixed: insert 1 byte → 25 of 25 chunks change. CDC: insert 1 byte → 1 chunk changes, 24 identical → only that chunk re-uploads.</span>"},
        {who:"intv",text:"The rolling hash runs over every byte of every file. Isn't that expensive?"},
        {who:"cand",text:"It's cheap by design — a <strong>rolling</strong> hash updates in O(1) per byte (add the new byte, subtract the one leaving the window) rather than re-hashing a whole window each step, so chunking a file is a single linear pass, comparable to just reading it. I bound chunk sizes (min/max around a ~4MB target) so pathological inputs can't produce millions of tiny chunks or one giant one. The cost is dominated by disk read, and it buys the insert-resilience that makes dedup and delta sync actually work."},
      ],resources:[
        {title:"Content-defined chunking",url:"https://en.wikipedia.org/wiki/Content-defined_chunking"},
        {title:"Rolling hash",url:"https://en.wikipedia.org/wiki/Rolling_hash"},
      ]},
      {l:"hard",tag:"scaling",q:"Global dedup across all users.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> <b>10M</b> users each save the same 15MB onboarding PDF, and a popular OS update ISO sits in <b>100K</b> folders. Storing every copy wastes petabytes. How much do you store, and how?</span>"},
        {who:"cand",text:"I store each unique chunk <strong>once</strong>, globally. A chunk is addressed by its content hash; before storing I check whether that hash already exists — if it does, I add a <strong>reference</strong> (increment a ref count / add it to the file's chunk list) instead of storing bytes again.<span class='eg'>10M copies of the same 15MB PDF → chunks stored once (~15MB) + 10M cheap metadata references. Petabytes collapse to megabytes of blocks plus small pointers.</span>Dedup is at the <strong>chunk</strong> level, so even partially-similar files share their common chunks. This is the single biggest storage win in the system."},
        {who:"intv",text:"Global cross-user dedup has a nasty side effect — a privacy side-channel. Do you see it?"},
        {who:"cand",text:"Yes. If dedup is cross-user and the client learns 'this chunk already exists, skipping upload,' an attacker can <strong>probe whether a specific file exists</strong> in anyone's storage: craft the file, try to add it, and infer from the fast (deduped) response that someone else already has it. Defenses: do the existence check <strong>server-side without leaking it</strong> — always accept the upload offer and dedupe silently behind the API so the client can't time it — or scope dedup <strong>per-user / per-namespace</strong> so cross-user inference is impossible, trading some storage savings for privacy. At minimum I never expose 'this content already exists globally' to an untrusted client."},
      ],resources:[
        {title:"Dropbox: inside the Magic Pocket",url:"https://dropbox.tech/infrastructure/inside-the-magic-pocket"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"hard",tag:"durability",q:"A ref-count bug risks deleting a live chunk.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> garbage collection deletes chunks whose ref count hits 0. A bug double-decrements on one delete, driving a still-referenced chunk to 0. GC removes it — and now thousands of files silently point at a <b>missing</b> chunk. How do you prevent and detect this?</span>"},
        {who:"cand",text:"This is the scariest bug class here — silent, delayed data loss. Defenses in layers. <strong>Prevent:</strong> don't delete on ref-count-zero immediately; use <strong>mark-and-sweep GC</strong> that recomputes reachability from live metadata (which chunk hashes are actually referenced by some file version) rather than trusting an incrementally-maintained counter that can drift. <strong>Delay:</strong> GC only reclaims chunks unreferenced for a long grace period (days), so a transient miscount self-heals before deletion. <strong>Detect:</strong> before physically deleting, re-verify no metadata references the hash."},
        {who:"intv",text:"Even with grace periods, suppose a chunk <em>was</em> wrongly deleted. Can you recover?"},
        {who:"cand",text:"Two safety nets. First, <strong>content-addressing means the bytes are reproducible</strong> from any client that still has the file — a device whose local copy references the missing chunk can re-upload it, and I actively repair by detecting reference-to-missing-block and requesting it from a holder. Second, the block store keeps <strong>backups / cross-region replicas and soft-deletes</strong> — a 'deleted' chunk is tombstoned and recoverable for a window, not instantly shredded. Combined with mark-and-sweep computing truth from metadata, a ref-count bug becomes a recoverable incident, not permanent loss. I'd also alarm on any 'file references a nonexistent block' as a hard invariant violation."},
      ],resources:[
        {title:"Dropbox: inside the Magic Pocket",url:"https://dropbox.tech/infrastructure/inside-the-magic-pocket"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"medium",tag:"concept",q:"Delta sync — sending only what changed.",turns:[
        {who:"intv",text:"Chunking dedupes identical chunks. But say I edit one page of a 100MB doc the server already has as an older version — how does the client know which bytes to send, rsync-style?"},
        {who:"cand",text:"This is <strong>rsync-style delta transfer</strong>. The party holding the old version computes, per block, a fast rolling checksum plus a strong hash. The client rolls the <strong>weak checksum</strong> over its new file byte-by-byte; where a weak checksum matches a known block it confirms with the strong hash — that block is unchanged and needn't be sent, only referenced by offset. Only the runs between matches (the genuinely new bytes) are transmitted.<span class='eg'>Edit 1 page of a 100MB doc: the rolling-checksum scan finds all but ~1 page of blocks match the old version → the client sends ~one page of literal data + references to the matched blocks.</span>"},
        {who:"intv",text:"In your architecture the client usually keeps the previous version locally. So where does rsync's remote-diff actually help?"},
        {who:"cand",text:"Right — when the client has the old version, it diffs locally and content-defined chunking already gives me most of this: re-chunk, upload only new chunk hashes, done, no server round-trip for the diff. The rsync remote algorithm earns its keep when the client <em>doesn't</em> have the old version but the server does — a fresh device, or syncing against a copy edited elsewhere — so a true diff must happen across the wire. So: CDC / chunk-hash diffing for the common local case, rsync-style rolling-checksum negotiation for the remote-diff case. Both minimize bytes on the wire; they just fit different starting states."},
      ],resources:[
        {title:"rsync algorithm (tech report)",url:"https://rsync.samba.org/tech_report/"},
        {title:"Rolling hash",url:"https://en.wikipedia.org/wiki/Rolling_hash"},
      ]},
      {l:"medium",tag:"capacity",q:"What CPU does chunking cost — could it centralize?",turns:[
        {who:"intv",text:"Content-defined chunking runs a rolling hash over every ingested byte. At full ingest scale, what does that cost, and could you run it as a central fleet?"},
        {who:"cand",text:"The rolling hash is O(1) per byte, but it still has to touch every byte that comes in.<span class='eg'>Ingest: 100M DAU × 100 changes/day × ~1MB ≈ 10 PB/day ≈ ~115 GB/s, peak ×4 ≈ ~460 GB/s. Rolling hash at ~1 GB/s/core → ~460 cores at peak just to chunk, before content hashing or compression.</span>Centralizing that puts a large, byte-in-the-path CPU fleet right on the hot upload path — the opposite of what I want."},
        {who:"intv",text:"So where does the chunking actually run?"},
        {who:"cand",text:"Decision: I push chunking and hashing to the <strong>client</strong> — each device chunks its own writes, so those ~460 cores are spread free across 100M machines and bytes go direct-to-storage, never through my fleet. The server-side chunk/dedup box then only does cheap <strong>hash-existence lookups</strong>: ~115K changes/s × a few chunks ≈ a few hundred K lookups/s, a light metadata op, not byte-crunching. The trade-off is I must not trust client-computed hashes blindly, so the block layer re-hashes on commit to verify — a small cost that buys eliminating an entire central CPU tier."},
      ],resources:[
        {title:"Content-defined chunking",url:"https://en.wikipedia.org/wiki/Content-defined_chunking"},
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
      ]},
    ],
    block:[
      {l:"medium",tag:"concept",q:"How the block store keeps exabytes.",turns:[
        {who:"intv",text:"The block store holds exabytes of immutable chunks. Sketch how it's organized and how you keep the cost sane over years."},
        {who:"cand",text:"It's a <strong>content-addressed store</strong>: the key of a chunk <em>is</em> its content hash, so the store is a giant immutable hash→bytes map (Dropbox's Magic Pocket is exactly this). Immutability is the superpower — chunks never change, so I never need cache invalidation, can replicate freely, and can verify integrity by re-hashing. For cost I <strong>tier by access age</strong>: recently-written and hot chunks live on fast storage; chunks untouched for months migrate to <strong>cold, cheaper storage</strong> (higher-latency, denser media).<span class='eg'>A photo from 5 years ago, never re-opened → its chunks live on cold tier at a fraction of the cost; a file edited today → hot tier for fast reads.</span>"},
        {who:"intv",text:"Content-addressed keys are random hashes. Doesn't that destroy locality — a file's chunks scattered everywhere?"},
        {who:"cand",text:"Somewhat, yes — hashes have no locality, so a file's chunks can land on different backends. I counter it by <strong>packing many chunks into larger container objects/volumes</strong> and recording, in metadata, which volume holds each chunk, so a read is a direct fetch, not a scan. Write locality is recovered by batching a client's incoming chunks into the same container. So the address is the hash (dedup, integrity), but physical placement is optimized underneath via a hash→location index. Immutability makes background compaction and re-packing safe."},
      ],resources:[
        {title:"Dropbox: inside the Magic Pocket",url:"https://dropbox.tech/infrastructure/inside-the-magic-pocket"},
        {title:"Content-defined chunking",url:"https://en.wikipedia.org/wiki/Content-defined_chunking"},
      ]},
      {l:"hard",tag:"scaling",q:"Handle millions of chunk writes per second.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> across all users you ingest <b>2M chunks/s</b> at peak, averaging 1MB each — terabytes per second of writes. A single storage cluster can't take that, and hot files cause bursts. How does the block store absorb it?</span>"},
        {who:"cand",text:"Content-addressing makes writes <strong>embarrassingly parallel</strong>: a chunk's hash determines its placement, so I spread the 2M/s across many storage cells by hashing the chunk key — no coordination between writers, no single hotspot for distinct chunks. Each cell is a self-contained set of storage nodes with its own index. Because clients upload <strong>directly to storage</strong> via pre-signed URLs, my metadata fleet isn't in the byte path at all — it only records tiny hash→location mappings.<span class='eg'>Hash(chunk) → cell 042 → one of its nodes; 2M/s of distinct chunks fan out evenly across hundreds of cells, each seeing a manageable slice.</span>"},
        {who:"intv",text:"Distinct chunks spread fine. But 10M users uploading the <em>same</em> viral chunk all hash to one cell — hot again."},
        {who:"cand",text:"Right, and dedup saves me here: the same chunk is <strong>written once</strong> — the first writer stores it, the rest dedupe to a reference and never write bytes. So a viral identical chunk is one write plus cheap metadata refs, not 10M writes to one cell. The remaining pressure is <em>reads</em> of that hot chunk, which I absorb with a read cache/CDN in front of the block store, replicating the hot object. So write hotspots collapse via dedup and read hotspots via caching — the immutability of chunks makes both trivial."},
      ],resources:[
        {title:"Dropbox: inside the Magic Pocket",url:"https://dropbox.tech/infrastructure/inside-the-magic-pocket"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"hard",tag:"durability",q:"A storage node with unique chunks dies.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a storage node fails permanently, and it held the <b>only</b> copies of some chunks that aren't referenced widely enough to exist elsewhere. Those chunks are the sole content of thousands of users' files. How is this not permanent data loss?</span>"},
        {who:"cand",text:"It must never come down to a single node. Chunks are stored with redundancy, and at exabyte scale <strong>3x replication is too expensive</strong>, so I use <strong>erasure coding</strong>: split each chunk (or volume) into k data + m parity fragments spread across independent failure domains, tolerating up to m simultaneous losses. A node failure loses some fragments, never whole chunks — I reconstruct the lost fragments from survivors onto new nodes.<span class='eg'>Reed-Solomon 6+3: a volume becomes 9 fragments on 9 nodes; any 6 reconstruct it, so up to 3 nodes can die with zero loss, at 1.5x overhead vs 3x for replication.</span>"},
        {who:"intv",text:"Erasure coding means a read might need to reconstruct from fragments — slower. Acceptable on the hot path?"},
        {who:"cand",text:"In steady state no reconstruction is needed — the k data fragments are directly readable, so a normal read is a straight fetch; reconstruction only kicks in when a fragment is missing (a node down), which is rare. For latency-sensitive hot chunks I also keep them cached/replicated on fast tier, so erasure coding is really the <strong>durable cold backbone</strong>, not the hot read path. Continuous background <strong>scrubbing</strong> re-hashes fragments to catch bit-rot and rebuilds proactively, so I don't discover loss only when a node dies. Net: 11-nines-class durability at ~1.5x overhead, with hot reads still fast."},
      ],resources:[
        {title:"Dropbox: inside the Magic Pocket",url:"https://dropbox.tech/infrastructure/inside-the-magic-pocket"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"hard",tag:"failover",q:"A whole storage zone goes offline.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> an entire storage <b>zone</b> hosting many erasure-coding fragments goes offline for an hour (power event). Reads that need fragments from that zone can't complete. Do downloads fail for that hour?</span>"},
        {who:"cand",text:"They shouldn't, if fragments are placed <strong>across zones</strong>, not within one. With Reed-Solomon 6+3 spread over multiple zones, losing one zone loses at most a few fragments per object — still within the m=3 tolerance, so every read reconstructs from surviving zones. The design rule is that no single failure domain (node, rack, zone) holds enough fragments to make an object unreadable. For the rare object that would be at risk, cross-region replicas of hot data provide a fallback."},
        {who:"intv",text:"Reconstruction for every read during that hour is expensive. Does performance tank?"},
        {who:"cand",text:"It degrades gracefully rather than failing. Reads for affected objects pay reconstruction CPU/IO, so I <strong>prioritize</strong>: serve hot chunks from the fast-tier cache/replicas (no reconstruction), and rate-limit background repair so live reads get IO priority over bulk rebuild. I also don't rush to re-encode everything the instant the zone drops — a short outage often self-resolves, so I wait a grace period before triggering full reconstruction to avoid a costly rebuild storm for a transient blip. When the zone returns, its fragments are revalidated by scrubbing and rejoin. So: correctness held by cross-zone coding, performance protected by caching and prioritized repair."},
      ],resources:[
        {title:"Dropbox: inside the Magic Pocket",url:"https://dropbox.tech/infrastructure/inside-the-magic-pocket"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"medium",tag:"capacity",q:"How many bytes and nodes does the block store need?",turns:[
        {who:"intv",text:"Size the block store. 100M-plus users, files ranging to tens of GB. How many bytes end up stored, and how many nodes?"},
        {who:"cand",text:"Raw, then dedup, then coding overhead.<span class='eg'>~500M users × ~50 GB avg ≈ 25 EB raw; global chunk dedup ~2x → ~12 EB unique; erasure coding 6+3 adds ~1.5x → ~18 EB physical; at ~20 TB/node ≈ ~900K drives worth of capacity.</span>This is inherently an exabyte, cell-based fleet — dedup and erasure coding are exactly what keep it from ballooning to ~75 EB under naive 3x replication."},
        {who:"intv",text:"That assumes everything sits on fast storage forever. Right-sized?"},
        {who:"cand",text:"No — most bytes are cold: written once, rarely re-read. Decision: I <strong>tier by access age</strong> — hot and recent chunks on fast media, chunks idle for months migrate to dense cold storage at a fraction of the cost, with erasure coding as the cold durable backbone (1.5x) and hot chunks additionally cached or replicated. The trade-off is a latency cliff on the rare cold read versus a several-fold cost cut. Dedup, tiering, and EC together are what make an exabyte store financially possible at all."},
      ],resources:[
        {title:"Dropbox: inside the Magic Pocket",url:"https://dropbox.tech/infrastructure/inside-the-magic-pocket"},
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
      ]},
      {l:"hard",tag:"concept",q:"S3 or self-hosted (Magic Pocket) for the blocks?",turns:[
        {who:"intv",text:"For those exabytes of immutable chunks — do you build the block store yourself or lean on <strong>S3</strong>? Make the call and give the contenders."},
        {who:"cand",text:"Two real options. <strong>S3 (or an equivalent object store)</strong>: managed, eleven-nines durability, effectively infinite scale, near-zero ops — but at exabyte scale the bill is enormous and I pay per-request and egress on a hot read path. <strong>Self-hosted, Dropbox Magic-Pocket-style</strong>: a content-addressed store on my own hardware with erasure coding — dramatically cheaper per byte at scale and full control over placement and tiering, but a multi-year engineering and operations investment to reach comparable durability."},
        {who:"intv",text:"So which, and when?"},
        {who:"cand",text:"Decision: it is scale-dependent. I <strong>start on S3</strong> — early on, managed durability and zero ops massively outweigh cost and let me ship. I <strong>migrate to self-hosted at exabyte scale</strong>, the exact path Dropbox took, once the storage bill dwarfs the cost of running my own fleet; content-addressing makes the migration safe because chunks are immutable and verifiable by re-hash, so I can copy and check them in the background. The trade-off is capex and engineering risk versus opex savings — which only flips in favor of building once I am genuinely at petabyte-to-exabyte scale, so I would not hand-build on day one."},
      ],resources:[
        {title:"Dropbox: inside the Magic Pocket",url:"https://dropbox.tech/infrastructure/inside-the-magic-pocket"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
    ],
    notif:[
      {l:"easy",tag:"concept",q:"Long-poll vs push for change notifications.",turns:[
        {who:"intv",text:"How does a device actually stay subscribed for 'your namespace changed' — long-poll or a push connection, and why?"},
        {who:"cand",text:"I want low latency without a request storm. <strong>Long-poll</strong>: the device sends a request the server <em>holds open</em> until the namespace advances or a timeout (say 30-60s), then responds and the device immediately re-polls. It's firewall-friendly and simple, delivering changes in near-real-time without per-second polling. A persistent <strong>push</strong> connection (WebSocket) is even lower-latency and lighter per message, but costs a held connection per device and more infra. Each notification carries just the namespace and its new <strong>cursor</strong>, never content.<span class='eg'>Phone long-polls namespace X at cursor 41; server holds the request; laptop commits → cursor 42; server responds 'X now at 42'; phone syncs changes-since-41 and re-polls.</span>"},
        {who:"intv",text:"What's the role of the cursor — why not just say 'something changed, resync everything'?"},
        {who:"cand",text:"The <strong>cursor</strong> is the device's position in the namespace's change log, so sync is <em>incremental</em>: 'give me changes since cursor 41' returns only the delta, not the whole tree. It's also how a device <strong>catches up</strong> after being offline — it reconnects with its last cursor and pulls everything since, in order. 'Resync everything' would be correct but ruinously expensive for large namespaces. The cursor makes both live updates and catch-up O(changes), and makes notifications idempotent — a duplicate poke just re-pulls from the same cursor and finds nothing new."},
      ],resources:[
        {title:"Dropbox: streaming file synchronization",url:"https://dropbox.tech/infrastructure/streaming-file-synchronization"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"hard",tag:"scaling",q:"Hold subscriptions for 100M devices.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> <b>100M</b> devices each hold a long-poll or WebSocket subscription — 100M concurrent connections — and a single shared-folder edit may need to poke <b>50,000</b> of them at once. How do you scale the notification tier?</span>"},
        {who:"cand",text:"Two dimensions: connection count and fan-out. <strong>Connections:</strong> a fleet of lightweight, mostly-idle connection servers, each holding hundreds of thousands of connections (cheap when idle under an epoll/async model, not a thread per connection). Shard devices across the fleet; 100M / ~250K per node ≈ 400 nodes. <strong>Fan-out:</strong> when a namespace advances, the metadata service publishes one event keyed by namespace; the notification tier looks up subscribers and pokes them.<span class='eg'>Edit shared folder → 1 published event → tier fans out to the 50K subscriber connections spread across ~200 connection nodes → each device pulls changes-since.</span>"},
        {who:"intv",text:"That 50K fan-out is instantaneous and triggers 50K syncs at once — you've just moved the herd to the metadata tier."},
        {who:"cand",text:"Right, so I <strong>smooth it</strong>: jitter poke delivery over a few seconds so the 50K syncs spread out rather than spike, and since the changes-since response for that namespace + cursor is <strong>identical for all of them</strong>, cache it and serve the herd from cache (as on the metadata side). The notification tier itself is just doing cheap connection writes. So the expensive part — the sync reads — is de-spiked by jitter and absorbed by a per-namespace-cursor cache, and the connection fan-out scales horizontally with the connection fleet."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"Dropbox: streaming file synchronization",url:"https://dropbox.tech/infrastructure/streaming-file-synchronization"},
      ]},
      {l:"hard",tag:"failover",q:"Notification tier is down — do devices go stale forever?",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> your entire notification tier is down for <b>20 minutes</b>. During the outage files are still being edited and committed. Devices get no pokes. When the tier recovers, are devices permanently out of sync, and did anything get lost?</span>"},
        {who:"cand",text:"Nothing is lost, because the notification tier is <strong>not the source of truth</strong> — it's a latency optimization over polling. Commits during the outage are safely recorded in the metadata store with advancing cursors; devices simply don't hear about them <em>promptly</em>. Two safeguards make recovery clean: devices fall back to <strong>periodic polling</strong> (long-poll re-establishes on a timer, and a slow background poll runs regardless), so worst case they discover changes on their next poll rather than instantly. And on reconnect each device presents its <strong>last cursor</strong> and pulls everything since, in order — full catch-up."},
        {who:"intv",text:"So during those 20 minutes, sync latency degrades from seconds to minutes. Is that the whole cost?"},
        {who:"cand",text:"Essentially yes — <strong>graceful degradation</strong>, not an outage: real-time becomes 'eventually within the poll interval.' The one thing I protect against is a <strong>reconnect storm</strong> when the tier recovers and 100M devices reconnect at once — randomized backoff/jitter on reconnect so they don't all hit simultaneously. Because catch-up is cursor-based and idempotent, a device that missed 5 events and one that missed 500 both just pull-since-cursor correctly. The durability guarantee lives entirely in the metadata store; the notification tier can fail without ever threatening correctness."},
      ],resources:[
        {title:"Dropbox: streaming file synchronization",url:"https://dropbox.tech/infrastructure/streaming-file-synchronization"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"medium",tag:"durability",q:"Can a change notification be lost?",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a namespace advances 41→42, the tier fires the poke, but the target device's connection drops <b>exactly</b> as the poke is sent — it's lost in flight. The device now sits at cursor 41 thinking it's current. How does it ever learn about v42?</span>"},
        {who:"cand",text:"This is why the notification is a <strong>hint, not a delivery guarantee</strong>, and correctness never depends on any single poke landing. Even if that poke is lost, the device's <strong>background poll</strong> (and its next long-poll re-establishment) will present cursor 41, and the metadata service responds with the 41→42 delta — so it self-corrects on the next poll cycle regardless. The system is designed so a lost notification costs only latency, never correctness, precisely because the cursor makes catch-up idempotent and the device always re-anchors on its own cursor."},
        {who:"intv",text:"So do you even bother making notification delivery reliable, or lean entirely on polling?"},
        {who:"cand",text:"I make it <strong>best-effort but good</strong> — at-least-once poke delivery with retries while the connection is healthy, because most of the time it works and gives the seconds-latency experience users expect. But I deliberately do <em>not</em> build exactly-once or durable per-device queued delivery for pokes — that complexity buys nothing when a cheap periodic poll already guarantees eventual delivery. So: fast path = best-effort push keyed on the cursor; correctness backstop = cursor-based polling. Duplicate pokes are harmless (idempotent re-pull), lost pokes are covered by polling. The effort goes into making the <em>metadata log</em> durable, not the notifications."},
      ],resources:[
        {title:"Dropbox: streaming file synchronization",url:"https://dropbox.tech/infrastructure/streaming-file-synchronization"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"medium",tag:"capacity",q:"Size the notification tier — connections and poke rate.",turns:[
        {who:"intv",text:"Numbers. 100M devices hold subscriptions. Size the tier — connection memory and the rate of pokes it must emit."},
        {who:"cand",text:"Connections first, then fan-out.<span class='eg'>100M concurrent long-poll/WebSocket connections; ~10 KB state each ≈ 1 TB RAM in aggregate; a node holding ~250K idle connections under an async/epoll model → 100M ÷ 250K ≈ 400 connection nodes. Poke rate: ~115K commits/s × average fan-out ~3 subscribers ≈ ~350K pokes/s baseline, peak ×4 ≈ ~1.4M/s, with shared folders spiking far above the average.</span>"},
        {who:"intv",text:"400 nodes just to hold mostly-idle connections is a lot of always-on infra. Can you shrink it?"},
        {who:"cand",text:"The key observation is that most of those 100M devices are idle — asleep or backgrounded — and do not need seconds-latency pokes. Decision: I keep live push connections only for <strong>foreground / recently-active</strong> devices; backgrounded devices drop the connection and fall back to a slow periodic poll, reconnecting when they wake. If only ~20-30M are live at once, that is ~100 nodes, not 400. The trade-off is slightly staler sync for a sleeping laptop versus paying to hold 100M permanently-open connections — and the device the user is actually watching still gets the live push."},
      ],resources:[
        {title:"Dropbox: streaming file synchronization",url:"https://dropbox.tech/infrastructure/streaming-file-synchronization"},
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
      ]},
      {l:"hard",tag:"concept",q:"What do you build the notification backbone on?",turns:[
        {who:"intv",text:"The thing that fans one namespace-advanced event out to the right connection nodes — what do you build it on? Name the options."},
        {who:"cand",text:"The backbone takes one namespace-X-advanced event and gets it to the subscribed connection nodes fast, and delivery is best-effort since a lost poke is covered by polling. Options: <strong>Redis Pub/Sub</strong> — dead simple, very low latency, fire-and-forget, no persistence; <strong>Kafka</strong> — durable, ordered, partitioned, great for replay, but heavier per message and built for consumer groups rather than 100M ephemeral fan-out targets; a <strong>managed pub/sub</strong> — a middle ground with less ops."},
        {who:"intv",text:"Pick one, given what a poke actually needs."},
        {who:"cand",text:"Decision: because a poke is a tiny, idempotent, best-effort hint and correctness lives in the cursor-based metadata log — not the notification — I do not need Kafka's durability or ordering here; paying for them adds latency and cost for a guarantee I deliberately never rely on. So I lean a <strong>Redis Pub/Sub-style</strong> lightweight bus between the metadata layer and the connection nodes: publish one event keyed by namespace, and nodes subscribed for that shard fan out to their devices. The trade-off I am making is durability for speed and simplicity — I keep Kafka for the data/analytics side where losing events matters, and rely on cursor-based polling as the correctness backstop for pokes."},
      ],resources:[
        {title:"Dropbox: streaming file synchronization",url:"https://dropbox.tech/infrastructure/streaming-file-synchronization"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
    ],
  },
  mockTest:[
    {q:"What is content-defined chunking and why is it better than fixed-size blocks for a sync service?",a:"Content-defined chunking sets chunk boundaries by content, not by byte offset: a rolling hash (Rabin fingerprint) slides over the file and cuts a boundary wherever the fingerprint matches a pattern. It beats fixed 4MB blocks because an insert or deletion only disturbs the one chunk containing it and boundaries re-align right after, so all other chunks stay byte-identical. With fixed blocks a 1-byte insert at the front shifts every boundary and changes every chunk hash, forcing a full re-upload. CDC is a single O(1)-per-byte linear pass with bounded min/max chunk sizes."},
    {q:"How does chunk-level deduplication work, and what is its main privacy risk?",a:"Each unique chunk is stored once, addressed by its content hash. Before storing, the system checks whether that hash already exists; if so it just adds a reference (increments a ref count) instead of writing bytes again, so 10M copies of the same file collapse to one stored copy plus cheap metadata pointers. The risk is a cross-user existence side-channel: if a client can tell that its upload was skipped because the chunk already existed, an attacker can probe whether specific content exists in anyone's storage. Mitigate by deduping silently server-side (always accept the offer) or scoping dedup per-user/per-namespace."},
    {q:"A client edits one page of a 100MB document. How does delta sync avoid re-sending the whole file?",a:"If the client still has the old version, it re-chunks locally and uploads only chunks whose hashes the server lacks — a one-page edit touches a handful of chunks, so a few MB move, not 100MB. If the client does NOT have the old version but the server does, use rsync-style negotiation: the holder computes a weak rolling checksum plus a strong hash per block, the client rolls the weak checksum over its file to find matching blocks, confirms with the strong hash, and transmits only the literal runs between matches plus references to matched blocks. Both paths minimize bytes on the wire."},
    {q:"Why split the system into a metadata (control) plane and a block (data) plane?",a:"They have opposite shapes and must scale on different axes. Metadata is tiny, high-QPS, mutable, latency-sensitive, and transactional — the file tree, version pointers, cursors. Content is huge, low-QPS, immutable, and throughput-bound. Coupling them makes the cheap hot path hostage to the expensive one: a few large uploads would tie up connections and memory needed for millions of tiny metadata polls. Splitting lets a small fast fleet serve metadata while bytes flow direct-to-storage (pre-signed URLs), referenced only by content hash once durably stored."},
    {q:"Which database class fits the metadata store and why not an eventually-consistent one?",a:"A NewSQL store (Spanner / CockroachDB-class) or sharded Postgres/MySQL, sharded by namespace. Every commit is a small atomic multi-row transaction with a compare-and-set on the namespace version so concurrent commits serialize instead of clobbering — that strong-consistency requirement on the file tree rules out eventually-consistent stores. Pure Cassandra/Dynamo can absorb raw writes but a CAS needs Paxos lightweight transactions (~1-2K/s/node, worse node math) and still offers no atomic multi-row commit. NewSQL adds distributed ACID plus built-in quorum replication and failover; sharded Postgres works because commits stay single-shard."},
    {q:"Estimate block-storage capacity for ~500M users and how you keep it affordable.",a:"Raw: ~500M users × ~50GB avg ≈ 25EB. Global chunk dedup ~2x → ~12EB unique. Erasure coding 6+3 adds ~1.5x → ~18EB physical; at ~20TB/node that is roughly 900K drives. Naive 3x replication would balloon it to ~75EB. Affordability comes from three levers together: dedup (store each chunk once), erasure coding (1.5x overhead instead of 3x for the durable cold backbone), and tiering by access age — hot/recent chunks on fast media, chunks idle for months migrated to dense cold storage, accepting a latency cliff on rare cold reads for a several-fold cost cut."},
    {q:"Two devices edit the same file offline and both push. How is neither edit lost?",a:"Never last-write-wins by timestamp — clocks are skewed across devices. Each device tracks causality with a version vector and pushes against the base version it last saw. The server accepts the first push via compare-and-set (advancing to v2); the second push carries a now-stale base whose vector is concurrent (neither dominates), so the server rejects the fast-forward and the client materializes a conflicted copy — server v2 stays as the file, the loser's edit is written as a separate conflicted-copy file. Both survive as immutable committed versions in history; a human reconciles."},
    {q:"How do a user's other devices learn about a change without hammering the servers?",a:"A notification service turns constant polling into event-driven pokes. Devices hold a lightweight subscription (long-poll or WebSocket); when a namespace's version cursor advances, the service pushes a tiny you-are-behind poke carrying only the namespace and its new cursor, never content. The device then does the normal changes-since-cursor metadata sync and pulls only changed chunks. The poke is a best-effort hint, not the source of truth: a lost or duplicated poke is harmless because a background cursor-based poll is the correctness backstop, so worst case a change is found one poll cycle later."},
  ]
};
