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
  edges:[["client","gw"],["gw","meta"],["meta","db"],["gw","chunk"],["chunk","block"],["gw","notif"]],
  core:["client","gw","meta","db"],
  basic:["client","gw","meta","db"],
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
    ],
  }
};
