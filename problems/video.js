window.DATA = window.DATA || {};
window.DATA['video'] = {
  cat:"upload · transcode · deliver",
  title:"Design a video streaming platform (YouTube / Netflix)",
  blurb:"Upload, transcode, and stream video globally with adaptive quality at billions of views/day.",
  prompt:"Let's design a video platform like YouTube or Netflix. Creators upload video, we transcode it into many qualities, store it durably, and stream it to billions of viewers worldwide with adaptive quality and minimal buffering. Start with the high-level architecture and rough numbers, then we'll drill into components — and I'll be throwing failure scenarios at you.",
  opening:"Let me frame it before drawing boxes.<br><br><strong>Functional:</strong> upload a video, transcode it into multiple qualities, store it, and stream it globally with adaptive quality; plus metadata, thumbnails, and view counts. <strong>Non-functional:</strong> playback starts in under ~2s with minimal rebuffering, a huge read:write skew (a video is uploaded once and watched millions of times), and hard durability — an uploaded master must never be lost.<br><br><strong>Back-of-envelope:</strong> ~500 hours of video uploaded per minute → ~720K hours/day ingested; each source hour fans out to a bitrate ladder of ~6-8 renditions, so storage grows in petabytes/day. On the read side ~5B views/day → ~58K views/s average, peak 3-5x, each pulling multi-Mbps segments — so egress, not compute, dominates and must be served from the edge.<br><br>I'll start deliberately minimal: <strong>client → upload service → object storage → CDN / edge</strong>. Upload lands the bytes, storage holds them durably, the CDN delivers them close to viewers. As we add transcoding, adaptive playback, metadata, and failure pressure I'll grow it. Pick a box and let's push.",
  nodes:[
    {id:"client",name:"Client",sub:"web / mobile / TV",x:40,y:150},
    {id:"upload",name:"Upload service",sub:"resumable",x:210,y:150},
    {id:"storage",name:"Object storage",sub:"renditions",x:380,y:150},
    {id:"cdn",name:"CDN / edge",sub:"delivery",x:550,y:150},
    {id:"transcode",name:"Transcoding",sub:"encode pipeline",x:380,y:40},
    {id:"meta",name:"Metadata DB",sub:"info, views",x:210,y:40},
    {id:"player",name:"Adaptive player",sub:"ABR client",x:720,y:150},
  ],
  edges:[["client","upload","upload"],["upload","storage","store raw"],["storage","cdn","distribute"],["upload","transcode","trigger"],["transcode","storage","renditions"],["upload","meta","metadata"],["cdn","player","stream"]],
  core:["client","upload","storage","cdn"],
  basic:["client","upload","storage","cdn"],
  deepDive:{
    client:{
      role:"The web / mobile / TV app that both <strong>uploads</strong> masters and, overwhelmingly, <strong>plays</strong> them back. It's an <strong>ABR player</strong>, not a dumb GET — and it owns the single most consequential lever: the <strong>client picks the quality per segment</strong>, so the server can stay a dumb, cacheable file host that a CDN absorbs at any scale.",
      capacity:[
        ["Read:write skew","uploaded once, watched millions of times","every design choice favors the read path"],
        ["Startup budget","&lt; ~2s to first frame","start after 1-2 small low-rung segments"],
        ["Steady-state buffer","~20-30s ahead","~7-8 segments at ~4s each, rides out a network dip"],
        ["Device spread","~40 codec/resolution profiles","one manifest, many pre-made renditions"],
      ],
      data:"Mostly stateless per session — the durable client artifacts are the <strong>offline download</strong> (segments + manifest + DRM license on device, flushed to disk so an app-kill survives) and a <strong>local watch position</strong> checkpointed to the watch-history service for cross-device resume. The ABR decision (which rendition next) is pure client-local state: measured buffer level and throughput.",
      scaling:[
        "Keep quality selection <strong>client-side</strong> so the delivery tier is a static-file cache hit — this is what lets a CDN carry ~500 Tbps of egress.",
        "Buffer ahead so an 8s tunnel drop is invisible and a PoP failover is masked; downshift before the buffer drains rather than stalling.",
        "Support <strong>client-side multi-CDN steering</strong> so the player itself routes around a degrading CDN at the next segment boundary.",
      ],
      failures:[
        {t:"Throughput collapses mid-segment (tunnel, congestion)",b:"Risk of a rebuffer / spinner for that viewer.",m:"~20-30s buffer absorbs the dip; player downshifts to a low rung (240p @ 300kbps) and keeps playing; a failed segment fetch is an idempotent retry, possibly against a different edge."},
        {t:"The serving CDN starts 5xx-ing for a metro",b:"Every viewer on that CDN in the region loses segments.",m:"Player retries the same idempotent GET against an alternate CDN/edge; if all degrade, drop to the lowest rendition and rebuffer gracefully rather than hard-fail."},
        {t:"App killed with 2GB downloaded offline",b:"Offline episodes could be lost or un-resumable.",m:"Segments, manifest, and license are written to durable device storage as they download, so reopen reads entirely from local with no network."},
      ],
      tradeoffs:[
        {a:"Buffer-based ABR",b:"Throughput-based ABR",pick:"Buffer occupancy is the honest signal of what's sustainable; throughput estimates oscillate. Modern players blend both — throughput for startup ramp, buffer for steady state."},
        {a:"Deep buffer (minutes)",b:"Shallow buffer (~20-30s)",pick:"A deep buffer wastes RAM (~75MB at 1080p for 2 min) and data on abandoned sessions and delays start; ~20-30s rides out the typical dip while starting sub-2s."},
      ],
      probes:[
        "A viewer drives into a tunnel for 8s mid-segment — walk me through exactly what the player does and why it isn't a spinner.",
        "The CDN the player is on starts 5xx-ing with ~20s of buffer left. Turn that into zero visible disruption.",
        "Resume at 47:00 on a different device after an app crash — where's that position stored and how durable must it be?",
      ],
    },
    upload:{
      role:"A thin <strong>control plane</strong> for ingest: it authenticates, issues scoped <strong>pre-signed URLs</strong>, tracks the resumable session, and on completion writes the master and enqueues transcode. The key lever it owns: bytes go <strong>direct to object storage</strong>, never through this service, so it never becomes a bandwidth bottleneck.",
      capacity:[
        ["Raw ingest bandwidth","~300 Gbps sustained, ~1 Tbps peak","500 hours/min &times; ~10 Mbps — bypasses the service entirely"],
        ["Control-plane rate","~50 initiates/s + completes","low thousands of req/s even at peak"],
        ["Fleet size","a handful of stateless nodes / 3 AZs","sized for redundancy, not throughput"],
        ["Part size","~5-10 MB multipart chunks","a 50GB master &asymp; ~5,000 independent parts"],
      ],
      data:"Holds <strong>upload-session</strong> state — upload-id, parts received, their ETags, expected count — but keeps it in the shared metadata / object store, <em>not</em> in pod memory, so any pod can resume any session. The master bytes are owned by object storage; the video row (<code>status = uploaded</code>) is owned by the metadata DB.",
      scaling:[
        "Separate data plane (bytes &rarr; object storage) from control plane (this service) so ~1 Tbps never touches the app fleet.",
        "Keep pods <strong>stateless</strong> — externalize session state so autoscale and pod death are transparent.",
        "Decouple ingest from processing: write master + enqueue a transcode job, return success in seconds.",
      ],
      failures:[
        {t:"Connection dies at 90% of a 50GB upload",b:"Re-uploading 45GB would be unacceptable.",m:"Chunked resumable multipart — each part acked with an ETag; on resume the client asks which parts landed and re-sends only the missing ~10%."},
        {t:"The coordinating pod is OOM-killed with 300 active sessions",b:"Orphaned sessions would force full restarts of huge uploads.",m:"Session state lives in the shared store, not pod memory; client reconnects to any pod, which reads the parts list and resumes."},
        {t:"Abandoned / incomplete multipart sessions",b:"Leaked partial objects accumulate cost.",m:"Storage lifecycle TTL garbage-collects incomplete sessions after a few days; complete verifies every part (checksums) before assembling."},
      ],
      tradeoffs:[
        {a:"Proxy bytes through the service",b:"Direct-to-storage via pre-signed URLs",pick:"Proxying is simpler to reason about but forces a ~1 Tbps app fleet for zero benefit; direct-to-storage keeps the tier tiny and stateless."},
      ],
      probes:[
        "A 50GB upload dies at 90% — make the resume cost only the missing 10%, and prove part 4,500 isn't corrupt.",
        "Bytes go straight to object storage, not through your service. Why, and what does the service actually do then?",
        "Size the upload fleet for 500 hours/min of arriving video — what number do you provision against, and why not the ingest bandwidth?",
      ],
    },
    storage:{
      role:"Durable home for the large, immutable, write-once blobs — masters and every rendition's segments. The lever it owns: <strong>redundancy per tier</strong> (replication vs erasure coding) and <strong>hot/cold tiering</strong>, which together decide whether exabytes are affordable.",
      capacity:[
        ["Growth rate","~6.5 PB/day, ~2.4 EB/year","720K hours/day &times; ~9 GB per video-hour across the ladder + master"],
        ["Durability target","~11 nines","object store spreads each object across nodes &amp; AZs"],
        ["Redundancy overhead","3&times; (replication) vs ~1.3-1.5&times; (erasure)","replicate the hot head, erasure-code the cold tail"],
        ["Read shape","key-based GETs by CDN","HTTP-native, no DB on the byte path"],
      ],
      data:"Opaque object bytes keyed by a deterministic scheme (<code>renditions/{videoId}/{rendition}/</code>). No relational model — the <em>knowledge</em> about the bytes (which renditions exist, where) lives in the metadata DB. Masters are always retained, which makes any rendition <strong>regenerable</strong> by re-running transcode — the ultimate durability backstop.",
      scaling:[
        "Tier by popularity: hot SSD-backed tier for new/trending, cold/archive for the long tail via access-frequency lifecycle policies.",
        "Erasure-code masters + cold content (~1.3-1.5&times; overhead), replicate only the hot renditions where read latency justifies 3&times;.",
        "<strong>Just-in-time transcoding</strong> for the cold tail: keep only the master, encode on the rare request, cache at the edge.",
        "Multi-region replicate the hot set + all masters so the CDN can origin-failover.",
      ],
      failures:[
        {t:"A storage node holding hot 1080p renditions loses its disk",b:"Those trending renditions could be unavailable.",m:"Every object is stored redundantly across many nodes/AZs; a node loss routes reads to another copy and rebuilds redundancy in the background — transparent to viewers."},
        {t:"The origin storage region goes dark for 20 min",b:"Cache-miss fetches (cold content, cold PoPs) fail.",m:"Multi-region origin + CDN origin-failover to a second region; hot content stays cached at edges, so blast radius is limited to misses."},
        {t:"A dormant title suddenly trends (cold-miss)",b:"First views hit slow archive — latency spikes.",m:"Keep masters always retrievable, promote on first-access signal, feed trend detection into pre-warming."},
      ],
      tradeoffs:[
        {a:"Cloud object store (S3-class)",b:"Self-managed (Ceph/Open Connect)",pick:"Cloud gives 11-nines and zero ops but brutal per-GB egress fees at hundreds of Tbps; owned hardware collapses egress cost at huge capex — hybrid: cloud first, migrate the hot high-egress path to owned edge once volume justifies it."},
        {a:"Replication (3&times;)",b:"Erasure coding (~1.4&times;)",pick:"Replication serves reads at low latency without reconstruction (worth it for the hot set); erasure coding's cost win applies to masters and the vast cold tail."},
      ],
      probes:[
        "Renditions multiply footprint 5-6&times; and add petabytes/day. Cut storage cost without hurting playback.",
        "Erasure coding vs replication for video — which, where, and why?",
        "Would you ever <em>not</em> store all renditions at all? When, and what does that cost the first viewer?",
      ],
    },
    cdn:{
      role:"The delivery tier that serves the two static artifacts — the <strong>manifest</strong> and immutable <strong>segments</strong> — from close to viewers. It owns the lever that makes the whole system possible: a high <strong>edge cache-hit ratio</strong> keeps origin bandwidth a rounding error against ~500 Tbps of egress.",
      capacity:[
        ["Peak egress","~500 Tbps","~100-150M concurrent streams &times; ~5 Mbps"],
        ["Edge hit ratio","~95-99%","segments immutable + popularity skewed → cache once, serve everywhere"],
        ["Origin egress","~5-25 Tbps","only the miss stream reaches origin at 99% hit"],
        ["Segment TTL","long / effectively immutable","content-addressed URLs, no invalidation on the hot path"],
      ],
      data:"Holds no source of truth — it's a <strong>cache</strong>. Origin storage + the manifest are authoritative. Cached objects are immutable segments keyed by content-hash/versioned URLs, so a re-encode produces new URLs rather than needing a purge.",
      scaling:[
        "<strong>Request coalescing (single-flight)</strong> per PoP so concurrent misses for one segment collapse to one origin fetch.",
        "<strong>Tiered cache / origin shield</strong> so hundreds of PoP misses funnel to a few shield nodes that coalesce again — origin sees ~one read per segment.",
        "<strong>Pre-position</strong> predictable hits (premieres) to edges; pull the unpredictable tail on demand.",
        "Owned appliances inside ISP networks (Open Connect-style) for last-mile egress economics.",
      ],
      failures:[
        {t:"Viral title, 2M concurrent, uncached at most PoPs",b:"Every edge misses the same segment and stampedes origin.",m:"Coalescing + origin shield turn the herd into ~one origin read per segment; pre-position and hot-tier promotion on the first spike."},
        {t:"An edge PoP serving a metro fails, 500K mid-stream",b:"Those players lose their edge.",m:"Anycast reroutes in seconds, GeoDNS health-checks stop resolving to it, and client-side multi-CDN switches at the next boundary — buffer masks the gap."},
        {t:"Stale segments cached with 30-day TTL after a re-encode; a DMCA takedown",b:"Viewers get the broken version / removed content lingers.",m:"Versioned/content-hash URLs make updates free (old URLs never referenced); active purge API + origin removal for hard takedowns."},
      ],
      tradeoffs:[
        {a:"Commercial CDN (CloudFront/Akamai)",b:"Owned (Open Connect) + multi-CDN",pick:"Commercial is instant global reach with no capex but brutal per-GB at video scale; owned collapses egress cost at big capex — stage it: commercial for speed and the tail, owned edge for the popular head, multi-CDN for resilience."},
        {a:"Push / pre-position",b:"Pull / cache-on-miss",pick:"Push buys zero first-view misses for predictable, concentrated demand (premieres) at edge-storage cost; pull is right for the unpredictable long tail."},
      ],
      probes:[
        "From ~5B views/day, derive peak egress and explain why the number itself dictates edge delivery.",
        "A viral video triggers a cache-miss storm on origin — contain it in layers.",
        "A segment is re-encoded to fix bad audio but 300 PoPs hold the old one with a 30-day TTL. Fix it — and separately handle a takedown that must vanish in minutes.",
      ],
    },
    transcode:{
      role:"The asynchronous, queue-fed pipeline that fans one master out into the <strong>bitrate ladder</strong> (~6-8 rungs across codecs). It owns the lever between cost and speed: <strong>per-title / per-shot encoding</strong> (tailor the ladder to content complexity) and chunk-level parallelism decide both storage footprint and time-to-watchable.",
      capacity:[
        ["Encode fleet","~300K cores steady, ~1M at peak","30,000 video-min/min &times; ~10 core-min per video-min"],
        ["Ladder","~6-8 rungs, 240p@300kbps → 4K@16Mbps","plus codec variants (h264/hevc/av1)"],
        ["Parallelism per title","chunks &times; rungs","a 2h master in 2-min chunks = 60 &times; 8 = 480 independent jobs"],
        ["Crash rate absorbed","~2% of jobs continuously","idempotent retries make it a non-event"],
      ],
      data:"Stateless workers; the durable state is the <strong>job queue</strong> (at-least-once) and the master in object storage (always available as input). Rendition outputs are written to <strong>deterministic keys</strong> keyed by (titleId, chunkId, rendition), giving an exactly-once <em>effect</em> on an at-least-once queue.",
      scaling:[
        "Split masters into <strong>GOP-aligned chunks</strong> and fan out parallel (chunk &times; rendition) jobs so wall-clock &asymp; one chunk-encode, not serial length.",
        "<strong>Per-title / per-shot encoding</strong> to spend bits only where complexity needs them — the biggest documented storage+bandwidth win.",
        "Elastic <strong>spot/preemptible</strong> fleet buffered by the queue; modest reserved floor + spot for peaks.",
        "<strong>Priority lanes</strong>: a new title's cheapest watchable rung jumps ahead of 4K rungs and re-encodes.",
      ],
      failures:[
        {t:"A bad deploy slows workers 4&times;; queue backs up to a 6-hour lag",b:"New uploads sit un-watchable; creators furious.",m:"Nothing lost (queue decouples ingest); roll back, autoscale hard, add priority lanes, rush one watchable rung per title, order by expected viewership, shed re-encodes."},
        {t:"A worker crashes 80% through a chunk",b:"At ~2% continuously, lost work would compound.",m:"Ack only after full output; visibility timeout redelivers the chunk to a healthy worker; only that ~2-min chunk is redone."},
        {t:"Chunk stitching seams / A/V drift",b:"Visible glitches at segment joins.",m:"Cut only at IDR/keyframe boundaries, pin encoder params per rendition across chunks, validate continuity before publishing."},
      ],
      tradeoffs:[
        {a:"Fixed ladder",b:"Per-title (or per-shot) encoding",pick:"A fixed ladder wastes bits on a cartoon and starves an action film; per-title tailors bitrate/rungs to complexity — a title is encoded once and streamed billions of times, so the analysis cost is trivially repaid."},
        {a:"Reserve for peak",b:"Elastic spot on a reserved floor",pick:"Reserving ~1M cores idle most of the day is safe but ruinous; spot is cheap because jobs are idempotent/retryable — accept a longer backlog under a big burst."},
      ],
      probes:[
        "Encode a 2-hour 4K master into 8 renditions in minutes, not hours — and tell me the risk when you stitch chunks back.",
        "Same bitrate ladder for a cartoon and an action movie? Justify per-title (and per-shot) encoding.",
        "Sizing: how many cores to keep pace with 500 hours/min, and do you reserve them or something cheaper?",
      ],
    },
    meta:{
      role:"The structured facts about videos — title, owner, state, and the <strong>rendition map</strong> the manifest is built from — served as a point read by <code>video_id</code> on the playback hot path. Its defining lever: <strong>keep view counts off the store's hot path</strong>, because a naive per-view UPDATE melts a hot title's partition.",
      capacity:[
        ["Core size","~8B rows &times; ~2 KB &asymp; ~16 TB","tiny — pressure is request rate, not bytes"],
        ["Playback reads","~58K/s avg, few hundred K/s peak","cache absorbs most; point read by video_id"],
        ["Writes","~50/s (~4M new videos/day)","gentle, plus status flips"],
        ["View increments","5B/day &asymp; 58K/s, hot title tens of thousands/s","never a per-view row UPDATE"],
      ],
      data:"Two profiles under one label. <strong>Core metadata</strong> is write-once, read-often, strongly-structured — happy in a wide-column store keyed by <code>video_id</code>, cached hard. <strong>View counts</strong> are a monotonic, tolerant-of-fuzz counter kept as a <strong>sharded, salted counter</strong> (N sub-rows summed on read) fed by Kafka windowed aggregation. List-by-uploader gets its own key/table, never a scan.",
      scaling:[
        "Partition on <code>video_id</code> for O(1) point reads in every region; a second table/GSI keyed on <code>uploader_id</code> + <code>created_at</code> for channel pages.",
        "<strong>Sharded counters</strong> + salted shard keys so a hot title's increments spread across partitions.",
        "<strong>Local pre-aggregation</strong> at the app tier (batch +N per ~1s) collapses 50K/s of raw increments to a handful of writes.",
        "Detect hot keys with an approximate top-K / count-min sketch, then promote them (more shards / Kafka path).",
      ],
      failures:[
        {t:"The metadata primary loses its disk",b:"Videos become unplayable even though bytes are safe.",m:"Replicate across AZs with quorum writes (promote a replica); backups + PITR for logical corruption; core map is reconstructible by scanning deterministic storage keys."},
        {t:"One viral video melts its counter partition",b:"Sharded shards hash to one partition sitting at 100%.",m:"Salt the shard key across partitions + local pre-aggregation flushed every ~1s collapses the write rate before it reaches the partition."},
        {t:"A per-view UPDATE on a hot row",b:"All writers serialize on one lock; partition melts, WAL bloats.",m:"Never store counts as a row you UPDATE per view — sharded/aggregated counter path instead."},
      ],
      tradeoffs:[
        {a:"Cassandra-class (or DynamoDB global tables)",b:"PostgreSQL",pick:"Wide-column wins for global always-on reads with multi-region write availability — ~58K+ reads/s from the nearest region, multi-master, no single primary on the hot path. Postgres' joins are real but reads scale only via replicas off one primary continent."},
        {a:"Approximate counts for display",b:"Exact counts",pick:"Display '1.2M views' is already fuzzy/deduplicated — approximate + eventually-consistent lets you batch freely; reserve exact counting for the offline monetization pipeline over the raw Kafka log."},
      ],
      probes:[
        "5B view increments/day, a hot title taking tens of thousands/s — design counting that scales, and say whether it's exact.",
        "Cassandra vs Postgres vs DynamoDB for the core metadata — pin the load first, then commit.",
        "Do view counts get the same durability bar as the rendition map? Justify tiering durability by value.",
      ],
    },
    player:{
      role:"The adaptive (ABR) client that turns a menu of static rendition files into smooth playback. It owns the <strong>quality decision</strong> — which rendition to fetch per segment — and CDN failover, entirely client-side, because only it sees real device capability, buffer level, and throughput.",
      capacity:[
        ["Segment stream","~5 Mbps, one rendition at a time","fetches short segments one-by-one from a manifest"],
        ["Buffer","~20-30s (~7-8 segments)","memory: ~19 MB at 1080p, ~60 MB at 4K"],
        ["Startup","after 1-2 small low-rung segments","sub-2s to first frame, quality ramps after"],
        ["Device negotiation","~40 profiles → a sub-ladder","never offered a 4K HEVC rung it can't decode"],
      ],
      data:"Client-local: current buffer occupancy, throughput estimate, chosen rendition, and a checkpointed <strong>watch position</strong> (also synced to a replicated watch-history service for cross-device resume). No server-side playback session — playback is a sequence of stateless cacheable GETs.",
      scaling:[
        "Buffer-led ABR with a throughput signal for startup ramp; step up on headroom, down before the buffer drains.",
        "<strong>Client-side multi-CDN steering</strong>: score each CDN on throughput/latency/error rate, switch at a segment boundary.",
        "Device-capability negotiation so the manifest exposes only a decodable sub-ladder.",
        "Throttle watch-position checkpoints to ~10-30s + on meaningful events (pause/seek/exit).",
      ],
      failures:[
        {t:"The player's CDN starts 5xx-ing mid-movie",b:"Segment fetches fail for that viewer.",m:"~20s buffer covers it; retry the idempotent GET against an alternate CDN/edge; downshift to refill the buffer faster."},
        {t:"All CDNs degrade at once",b:"No healthy path.",m:"Drop to the lowest rendition (smallest segments most likely to squeak through); rebuffer gracefully — spinner + retry, resume the instant a segment lands; emit QoE telemetry."},
        {t:"App crashes 47 min into a 90-min film",b:"User expects resume at 47:00 on any device.",m:"Position checkpointed to a replicated watch-history service (~10-30s cadence + on exit) and cached locally; furthest-position/LWW reconciliation across devices."},
      ],
      tradeoffs:[
        {a:"Gate playback on a full buffer",b:"Start on 1-2 low-rung segments",pick:"Gating hurts the two things that matter most — startup latency and wasted bandwidth on abandoned sessions; start fast at low quality, then ramp and build to ~20-30s."},
        {a:"Checkpoint every 1s",b:"Every ~10-30s + on events",pick:"Per-second hammers the backend; ~10-30s plus pause/seek/exit captures the common 'close the app' case while losing at most a few seconds of progress."},
      ],
      probes:[
        "Explain the algorithm that jumps 480p → 1080p and back — and why lean on the buffer over throughput?",
        "40 device classes and 3 CDNs — how does the player scale quality across all that diversity?",
        "How big a buffer, and what does it cost in memory and startup time? Why not buffer minutes ahead?",
      ],
    },
  },
  dbDoc:{
    component:"Metadata DB",
    load:"~58K point reads/s by <code>video_id</code> on the playback hot path (a few hundred K/s at peak, cache absorbs most); writes are gentle — ~4M new videos/day &approx; ~50 writes/s plus status flips. View events add ~5B/day &approx; ~58K increments/s, spiking to tens of thousands/s on one trending title — kept off the store's hot path (Kafka + sharded counters). Size is small: ~8B rows &times; ~2 KB &approx; ~16 TB. The pressure is request rate and global reach, not bytes.",
    candidates:[
      {name:"PostgreSQL (relational)",ceiling:"~10-20K point reads/s per replica; one primary takes all writes",nodes:"~58K reads &divide; ~15K/replica &approx; ~4-5 read replicas per region, all streaming from a single global primary; ~16 TB fits one box",pick:false,note:"joins and ad-hoc power are real, but global reads scale only via replicas off one primary continent — a latency &amp; availability chokepoint; reserve it for a catalog/search surface needing heavy ad-hoc queries."},
      {name:"Cassandra / ScyllaDB (wide-column)",ceiling:"~10-30K ops/s per node; sized by replication factor, not raw load",nodes:"~58K reads &divide; ~20K/node &approx; 3 nodes, &times;RF3 multi-region &approx; <strong>~9-12 nodes</strong>; ~16 TB &divide; 12 &approx; ~1.3 TB/node — trivial",pick:true,note:"chosen — linear read scale and multi-master so every region serves the <code>video_id</code> lookup locally, with no single primary on the playback hot path."},
      {name:"DynamoDB (managed global tables)",ceiling:"~3K reads &amp; ~1K writes/s per partition, auto-split",nodes:"managed / auto-sharded: ~58K reads &divide; ~3K &approx; ~20 partitions it adds for you; global tables replicate per-region",pick:false,note:"the managed equivalent and runner-up — same multi-region multi-master shape with zero node ops; pick it over Cassandra only if we are all-in on one cloud."},
    ],
    indexing:"Partition key = <code>video_id</code>, so the playback-hot rendition-map lookup is an O(1) single-partition point read in every region — no secondary index on the core path. <strong>List-by-uploader</strong> (channel page) gets its own key, never a scan: a second table / materialized view <code>PRIMARY KEY((uploader_id), created_at, video_id)</code> in Cassandra, or a GSI on <code>uploader_id</code> + <code>created_at</code> in Dynamo — one partition read, newest-first. <strong>View counts</strong> never live as a row I UPDATE per view (that serializes a hot title on one lock and melts its partition); they are a <strong>sharded, salted counter</strong> — N sub-rows per video summed on read, fed by Kafka windowed aggregation — so ~32K increments/s on one title spread across ~16 partitions while the display number stays fuzzy-but-fine.",
    decision:"Pick a <strong>wide-column store (Cassandra-class), or DynamoDB global tables as the managed equivalent</strong>, for the core rendition-map metadata. The deciding factor is <strong>global always-on reads with multi-region write availability</strong> — ~58K+ point reads/s served from the nearest region with linear scale and multi-master writes, on a tiny ~16 TB / ~50-writes/s dataset. <strong>Not Postgres:</strong> ~16 TB fits one box, but reads scale only via replicas off a single primary continent — a global latency and availability chokepoint — so it is reserved for heavy ad-hoc catalog/search. <strong>Cassandra vs DynamoDB</strong> is ops preference: self-host control and no lock-in versus zero node management. Note this metadata DB is <em>separate</em> from the large immutable video bytes, which live in object storage — the DB holds only structured knowledge about those bytes, and the sharded view counters stay on their own path.",
  },
  schema:{tables:[
    {name:"videos",pk:"video_id",columns:[
      ["video_id","varchar(16)","short id, primary key"],
      ["uploader_id","bigint","owning channel/user"],
      ["title","text","display title"],
      ["status","varchar(16)","uploaded / transcoding / ready"],
      ["duration","int","length in seconds"],
      ["created_at","timestamptz","upload time"],
    ],rows:[
      ["v_9kQ2aZ","42","Summer road trip 4K","ready","742","2026-07-20 09:12:00"],
      ["v_15ftgG","7","Keynote livestream cut","transcoding","5400","2026-07-22 10:00:00"],
      ["v_bX3mps","91","Cat compilation","uploaded","128","2026-07-22 11:30:00"],
    ]},
    {name:"renditions",pk:"video_id + resolution",columns:[
      ["video_id","varchar(16)","which video (indexed)"],
      ["resolution","varchar(8)","240p / 720p / 1080p / 2160p"],
      ["bitrate","int","target bitrate in kbps"],
      ["codec","varchar(12)","h264 / hevc / av1"],
      ["storage_url","text","object-storage key for segments"],
      ["segment_manifest_url","text","per-rendition playlist"],
    ],rows:[
      ["v_9kQ2aZ","720p","3000","h264","s3://renditions/v_9kQ2aZ/720p/","s3://renditions/v_9kQ2aZ/720p/index.m3u8"],
      ["v_9kQ2aZ","2160p","16000","hevc","s3://renditions/v_9kQ2aZ/2160p/","s3://renditions/v_9kQ2aZ/2160p/index.m3u8"],
      ["v_15ftgG","480p","1200","h264","s3://renditions/v_15ftgG/480p/","s3://renditions/v_15ftgG/480p/index.m3u8"],
    ]},
    {name:"view_counts",pk:"video_id",columns:[
      ["video_id","varchar(16)","which video, primary key"],
      ["count","bigint","approximate total views (sharded rollup)"],
      ["updated_at","timestamptz","last aggregation flush"],
    ],rows:[
      ["v_9kQ2aZ","4820117","2026-07-22 11:59:30"],
      ["v_15ftgG","933","2026-07-22 11:58:12"],
    ]},
    {name:"upload_sessions",pk:"session_id",columns:[
      ["session_id","uuid","multipart upload id"],
      ["video_id","varchar(16)","target video"],
      ["chunks_received","int","parts committed so far"],
      ["total_chunks","int","expected part count"],
      ["created_at","timestamptz","session start"],
    ],rows:[
      ["7f3a-b12c…","v_15ftgG","4500","5000","2026-07-22 09:59:50"],
      ["c3d4-a1b2…","v_bX3mps","32","32","2026-07-22 11:30:00"],
    ]},
  ]},
  flows:[
    {id:"upload",name:"Upload + process a video",steps:[
      {node:"client",text:"Creator calls <code>POST /uploads</code> to start a resumable session for a new master."},
      {node:"upload",text:"Upload service issues an upload-id plus <strong>pre-signed URLs</strong> and tracks the session."},
      {node:"storage",text:"Client PUTs the file as independent chunks <strong>directly to object storage</strong>, re-sending only missing parts."},
      {node:"meta",requires:["meta"],text:"On <code>complete</code>, metadata records the video row with <code>status = uploaded</code>."},
      {node:"transcode",requires:["transcode"],text:"An enqueued job fans the master out into the bitrate-ladder <strong>renditions</strong> in parallel."},
      {node:"storage",text:"Each finished rendition and its segment manifest is written back to object storage."},
      {node:"meta",requires:["meta"],text:"Metadata flips <code>status</code> to <code>ready</code> once the first playable rendition lands."},
    ]},
    {id:"playback",name:"Watch a video (adaptive stream)",steps:[
      {node:"client",text:"Viewer hits play and requests the video page."},
      {node:"meta",requires:["meta"],text:"Metadata returns the rendition map used to build the manifest."},
      {node:"cdn",text:"CDN serves the <strong>manifest</strong> and short immutable <strong>segments</strong> as cacheable GETs."},
      {node:"player",requires:["player"],text:"The ABR <strong>player</strong> picks a rendition per segment from its measured buffer and bandwidth."},
      {node:"meta",requires:["meta"],text:"A view event is counted asynchronously into the approximate <code>view_counts</code> rollup."},
    ]},
  ],
  deepFlows:[
    {id:"upload-transcode-e2e",name:"Upload → ready",summary:"**POST /uploads** issues scoped part URLs → client uploads chunks **directly to object storage** → complete records <code>videos.status='uploaded'</code> → transcode fans one master into **6-8 renditions** → deterministic segment keys + metadata flip make the title playable.",steps:[
      {node:"client",title:"Client starts a resumable upload",snap:{cap:"No durable video row yet; the creator is asking for a target <code>video_id</code> and resumable control-plane state before any bytes move.",tables:[{name:"videos",cols:["video_id","uploader_id","title","status","duration","created_at"],rows:[{c:["v_9kQ2aZ","42","Summer road trip 4K","<em>not created</em>","742","—"],hi:1,tag:"planned"}]},{name:"upload_sessions",cols:["session_id","video_id","chunks_received","total_chunks","created_at"],rows:[{c:["7f3a-b12c…","v_9kQ2aZ","0","5000","pending"],hi:1,tag:"target"}]}]},narrate:"A creator's app does not stream a 50GB master through the application tier. It asks the upload control plane for a video id, a multipart session, and time-limited URLs for ~5-10MB chunks so a failure only retries missing parts.",details:[
        {k:"wire",label:"Initiate request",lang:"http",code:"POST /v1/uploads\nX-Caller: creator-42\nContent-Type: application/json\n\n{\n  \"uploader_id\": 42,\n  \"title\": \"Summer road trip 4K\",\n  \"filename\": \"roadtrip_prores.mov\",\n  \"bytes\": 53687091200,\n  \"duration\": 742,\n  \"chunk_size\": 10485760\n}"},
        {k:"note",label:"Why chunked direct upload",text:"At ~500 hours/min, raw ingest is ~300Gbps sustained and can peak near ~1Tbps. Pre-signed direct-to-storage URLs keep those bytes off the upload-service fleet; the service only handles low-thousands/s control calls."},
      ]},
      {node:"upload",title:"Upload service creates control-plane state",snap:{cap:"The upload control plane is now durable: session <code>7f3a-b12c…</code> tracks 0/5000 chunks for <code>v_9kQ2aZ</code>; any upload pod can resume it.",tables:[{name:"upload_sessions",cols:["session_id","video_id","chunks_received","total_chunks","created_at"],rows:[{c:["7f3a-b12c…","v_9kQ2aZ","0","5000","2026-07-22 12:00:00"],hi:1,tag:"inserted"},{c:["c3d4-a1b2…","v_bX3mps","32","32","2026-07-22 11:30:00"]}]},{name:"videos",cols:["video_id","uploader_id","title","status","duration","created_at"],rows:[{c:["v_9kQ2aZ","42","Summer road trip 4K","uploaded? no","742","—"],hi:1,tag:"not published"}]}]},narrate:"The upload service authenticates, allocates a short <code>video_id</code>, opens the multipart session, and persists the resumable state. Any pod can later resume because the parts map is in shared metadata, not process memory.",details:[
        {k:"query",label:"Create upload session",lang:"sql",code:"INSERT INTO upload_sessions\n  (session_id, video_id, chunks_received, total_chunks, created_at)\nVALUES\n  ('7f3a-b12c...', 'v_9kQ2aZ', 0, 5000, now());"},
        {k:"route",label:"Metadata shard key",text:"Core metadata is partitioned by <code>video_id</code> because playback later needs an O(1) point read for the rendition map. List-by-uploader is a separate table/GSI keyed by <code>uploader_id, created_at</code>; don't make the hot playback path scan by uploader."},
        {k:"wire",label:"Response with scoped URLs",lang:"json",code:"{\n  \"video_id\": \"v_9kQ2aZ\",\n  \"session_id\": \"7f3a-b12c...\",\n  \"chunk_size\": 10485760,\n  \"total_chunks\": 5000,\n  \"parts\": [\n    { \"part\": 1, \"url\": \"https://obj.example/uploads/v_9kQ2aZ/master?partNumber=1&uploadId=7f3a...&sig=...\" },\n    { \"part\": 2, \"url\": \"https://obj.example/uploads/v_9kQ2aZ/master?partNumber=2&uploadId=7f3a...&sig=...\" }\n  ],\n  \"expires_in_seconds\": 900\n}"},
      ]},
      {node:"storage",title:"Client PUTs chunks to object storage",snap:{cap:"Part 4500 is acknowledged by storage and the session advances to 4500/5000. The raw bytes are durable, but the master is not complete yet.",tables:[{name:"upload_sessions",cols:["session_id","video_id","chunks_received","total_chunks","created_at"],rows:[{c:["7f3a-b12c…","v_9kQ2aZ","4500","5000","2026-07-22 12:00:00"],hi:1,tag:"parts acked"}]},{name:"object storage · multipart parts",cols:["video_id","object_key","part","etag"],rows:[{c:["v_9kQ2aZ","masters/v_9kQ2aZ/source.mov","4500","part-4500-a8f1…"],hi:1,tag:"durable"},{c:["v_9kQ2aZ","masters/v_9kQ2aZ/source.mov","4501-5000","missing"]}]}]},narrate:"The client uploads each part independently to the object store. Storage validates the checksum and returns an ETag; on a 90% failure of a 50GB file, the client asks for received parts and resends only the missing ~500 chunks.",details:[
        {k:"wire",label:"Part upload",lang:"http",code:"PUT /uploads/v_9kQ2aZ/master?partNumber=4500&uploadId=7f3a...\nContent-MD5: 1B2M2Y8AsgTpgAmY7PhCfg==\nContent-Length: 10485760\n\n<10MB bytes>\n\nHTTP/1.1 200 OK\nETag: \"part-4500-a8f1...\""},
        {k:"query",label:"Track committed parts",lang:"sql",code:"-- after storage confirms the part checksum + ETag\nUPDATE upload_sessions\nSET chunks_received = chunks_received + 1\nWHERE session_id = '7f3a-b12c...'\n  AND video_id = 'v_9kQ2aZ';"},
        {k:"repl",label:"Durability of raw parts",text:"Uploaded parts are written redundantly across storage nodes/AZs before the PUT is acked. The final master is the one irreplaceable artifact, so it gets the strongest durability tier; renditions can always be regenerated from it."},
      ]},
      {node:"upload",title:"Complete verifies every part",snap:{cap:"All 5000 chunks verify, the master is finalized, and the video row moves through <code>uploaded</code> to <code>transcoding</code>. This is the status transition that makes async processing safe.",tables:[{name:"upload_sessions",cols:["session_id","video_id","chunks_received","total_chunks","created_at"],rows:[{c:["7f3a-b12c…","v_9kQ2aZ","5000","5000","2026-07-22 12:00:00"],hi:1,tag:"verified"}]},{name:"videos",cols:["video_id","uploader_id","title","status","duration","created_at"],rows:[{c:["v_9kQ2aZ","42","Summer road trip 4K","transcoding","742","2026-07-22 12:08:20"],hi:1,tag:"uploaded→transcoding"}]}]},narrate:"When all parts are present, the client calls complete. The upload service verifies the expected <code>total_chunks</code> and ETags, finalizes the multipart object, then makes processing asynchronous instead of blocking the creator on CPU-heavy encoding.",details:[
        {k:"wire",label:"Complete request",lang:"http",code:"POST /v1/uploads/7f3a-b12c.../complete\nContent-Type: application/json\n\n{\n  \"video_id\": \"v_9kQ2aZ\",\n  \"parts\": [\n    { \"part\": 1, \"etag\": \"part-1-...\" },\n    { \"part\": 5000, \"etag\": \"part-5000-...\" }\n  ]\n}"},
        {k:"query",label:"Verify session before publishing",lang:"sql",code:"SELECT video_id, chunks_received, total_chunks\nFROM upload_sessions\nWHERE session_id = '7f3a-b12c...';\n-- require chunks_received = total_chunks = 5000 before completing\n\nINSERT INTO videos\n  (video_id, uploader_id, title, status, duration, created_at)\nVALUES\n  ('v_9kQ2aZ', 42, 'Summer road trip 4K', 'uploaded', 742, now());\n\nUPDATE videos\nSET status = 'transcoding'\nWHERE video_id = 'v_9kQ2aZ'\n  AND status = 'uploaded';"},
        {k:"gotcha",label:"Incomplete uploads are not masters",text:"An incomplete multipart upload never becomes a playable master. Abandoned sessions are garbage-collected by object-storage lifecycle TTL, which avoids petabytes of leaked partial chunks."},
      ]},
      {node:"transcode",title:"Enqueue chunk × rendition jobs",snap:{cap:"Transcode fan-out appends chunk×rendition work to Kafka. For <code>v_9kQ2aZ</code>, 60 chunks × 8 rungs = 480 jobs; shown are the first 720p jobs appended to the video-keyed partition.",tables:[{name:"videos",cols:["video_id","uploader_id","title","status","duration","created_at"],rows:[{c:["v_9kQ2aZ","42","Summer road trip 4K","transcoding","742","2026-07-22 12:08:20"],hi:1,tag:"fan-out"}]}],queues:[{name:"transcode-jobs",kind:"kafka",by:"key = video_id · 96 partitions",parts:[{id:"P22",key:"← hash(v_9kQ2aZ)",msgs:[{v:"v_9kQ2aZ c001 240p",hi:1,tag:"appended @9100"},{v:"v_9kQ2aZ c001 720p",hi:1,tag:"appended @9101"},{v:"v_9kQ2aZ c001 2160p",hi:1,tag:"appended @9102"}],commit:9100,end:9103},{id:"P41",key:"other videos",msgs:[{v:"v_15ftgG c014 480p"}],commit:704,end:705}]}]},narrate:"The transcode pipeline reads the immutable master and fans it out across chunks and the bitrate ladder. A 2-hour master split into 2-minute chunks with 8 rungs becomes ~480 independent jobs, so wall-clock time approaches one chunk encode instead of the whole movie length.",details:[
        {k:"wire",label:"Transcode job message",lang:"json",code:"{\n  \"job_type\": \"transcode_video\",\n  \"video_id\": \"v_9kQ2aZ\",\n  \"master_url\": \"s3://masters/v_9kQ2aZ/source.mov\",\n  \"duration\": 742,\n  \"ladder\": [\n    { \"resolution\": \"240p\", \"bitrate\": 300, \"codec\": \"h264\" },\n    { \"resolution\": \"720p\", \"bitrate\": 3000, \"codec\": \"h264\" },\n    { \"resolution\": \"2160p\", \"bitrate\": 16000, \"codec\": \"hevc\" }\n  ]\n}"},
        {k:"route",label:"Work partitioning",text:"Queue messages are keyed by <code>video_id</code> plus chunk/rendition, e.g. <code>hash(video_id + ':' + chunk_id + ':' + resolution)</code>, to spread the ~6-8 ladder rungs across workers while keeping retries for the same output deterministic."},
        {k:"note",label:"Capacity grounding",text:"At 500 hours/min = 30,000 video-min/min and ~10 core-min per video-minute, the steady encode fleet is ~300K cores and peak can approach ~1M. Queue buffering + spot/preemptible workers are mandatory economics."},
        {k:"queue",label:"How Kafka adds chunk×rendition work",lang:"python",code:"topic = 'transcode-jobs'\nkey = video_id                  # v_9kQ2aZ -> P22\nfor chunk in chunks:             # 60 chunks\n  for rung in ladder:            # 8 renditions\n    producer.send(topic, key=key, value={chunk,rung}, acks='all')\n# broker appends offsets 9100..9579; log-end advances; nothing is removed"},
        {k:"queue",label:"Partitioning trade-off",text:"Keying by <code>video_id</code> keeps one title's job order visible on P22 while still allowing many workers to process batches. Partition count bounds consumer parallelism; chunk×rendition fan-out gives throughput, deterministic output keys give retry safety."},
      ]},
      {node:"storage",title:"Workers write deterministic segments",snap:{cap:"Workers in the transcode consumer group lease jobs from P22 and only commit after each deterministic segment object is written. A retry overwrites the same key, so at-least-once delivery has exactly-once effect.",tables:[{name:"renditions",cols:["video_id","resolution","bitrate","codec","storage_url","segment_manifest_url"],rows:[{c:["v_9kQ2aZ","720p","3000","h264","s3://renditions/v_9kQ2aZ/720p/","pending index.m3u8"],hi:1,tag:"segments writing"}]},{name:"object storage · segments",cols:["video_id","object_key","state"],rows:[{c:["v_9kQ2aZ","renditions/v_9kQ2aZ/720p/seg-000001.ts","written"],hi:1,tag:"idempotent key"}]}],queues:[{name:"transcode-jobs",kind:"kafka",by:"consumer group 'transcoders'",parts:[{id:"P22",key:"owned by enc-17",msgs:[{v:"v_9kQ2aZ c001 720p",hi:1,tag:"reading @9101"}],commit:9101,end:9580},{id:"P41",key:"other videos",msgs:[{v:"v_15ftgG c014 480p"}],commit:704,end:705}]}]},narrate:"Each worker writes immutable HLS/DASH segments and a per-rendition manifest to deterministic keys. At-least-once queue delivery is safe because a duplicate worker overwrites the same output key with the same bytes or no-ops after seeing it exists.",details:[
        {k:"query",label:"Object keys",lang:"text",code:"master:\n  s3://masters/v_9kQ2aZ/source.mov\nsegments:\n  s3://renditions/v_9kQ2aZ/720p/seg-000001.ts\n  s3://renditions/v_9kQ2aZ/720p/seg-000002.ts\nmanifest:\n  s3://renditions/v_9kQ2aZ/720p/index.m3u8"},
        {k:"repl",label:"Replication vs erasure coding",text:"Hot renditions are often replicated for low-latency reads; masters and the cold long tail use erasure coding at ~1.3-1.5x overhead instead of 3x. That is how ~6.5PB/day of logical growth avoids becoming ~19.5PB/day of raw replicated disk."},
        {k:"gotcha",label:"Storage-cost trade-off",text:"Keeping 6-8 renditions for every long-tail title multiplies footprint 5-6x. Per-title/per-shot encoding, tiering, dropping rarely selected rungs, and just-in-time transcode for cold titles are the levers to name."},
        {k:"queue",label:"How workers consume Kafka",lang:"python",code:"recs = consumer.poll()          # transcoders group owns P22\n# encode v_9kQ2aZ/c001/720p, write deterministic segment keys\nwrite('renditions/v_9kQ2aZ/720p/seg-000001.ts')\nconsumer.commit()               # only after output exists: 9101 -> 9102\n# crash before commit => offset re-read; retry overwrites same key"},
        {k:"queue",label:"Why retries are safe",text:"Kafka is at-least-once: a preempted spot worker may re-read the same offset. Because output keys are deterministic by <code>(video_id, chunk, rendition)</code>, duplicate work overwrites the same object instead of creating duplicate segments."},
      ]},
      {node:"meta",title:"Rendition map is written by video_id",snap:{cap:"The rendition map is now queryable by <code>video_id</code>. The first playable rows let metadata flip from <code>transcoding</code> to <code>ready</code>, while higher rungs can continue filling in.",tables:[{name:"renditions",cols:["video_id","resolution","bitrate","codec","storage_url","segment_manifest_url"],rows:[{c:["v_9kQ2aZ","720p","3000","h264","s3://renditions/v_9kQ2aZ/720p/","s3://renditions/v_9kQ2aZ/720p/index.m3u8"],hi:1,tag:"published"},{c:["v_9kQ2aZ","2160p","16000","hevc","s3://renditions/v_9kQ2aZ/2160p/","s3://renditions/v_9kQ2aZ/2160p/index.m3u8"],hi:1,tag:"published"}]},{name:"videos",cols:["video_id","uploader_id","title","status","duration","created_at"],rows:[{c:["v_9kQ2aZ","42","Summer road trip 4K","ready","742","2026-07-22 12:08:20"],hi:1,tag:"transcoding→ready"}]}]},narrate:"As each rendition completes, the pipeline writes one <code>renditions</code> row keyed by <code>video_id + resolution</code>. The first playable rung can flip the video to <code>ready</code>; higher rungs light up progressively as more rows appear.",details:[
        {k:"query",label:"Publish rendition rows",lang:"sql",code:"INSERT INTO renditions\n  (video_id, resolution, bitrate, codec, storage_url, segment_manifest_url)\nVALUES\n  ('v_9kQ2aZ', '720p', 3000, 'h264',\n   's3://renditions/v_9kQ2aZ/720p/',\n   's3://renditions/v_9kQ2aZ/720p/index.m3u8'),\n  ('v_9kQ2aZ', '2160p', 16000, 'hevc',\n   's3://renditions/v_9kQ2aZ/2160p/',\n   's3://renditions/v_9kQ2aZ/2160p/index.m3u8');\n\nUPDATE videos\nSET status = 'ready'\nWHERE video_id = 'v_9kQ2aZ'\n  AND status = 'transcoding';"},
        {k:"repl",label:"Metadata consistency",text:"Core metadata is replicated across AZs/regions with quorum writes because without the rendition map the bytes are effectively unplayable. View counts do not get this bar; the rendition map and ownership do."},
      ]},
      {node:"client",from:"meta",title:"Creator sees the title is playable",snap:{cap:"Read-only status check: the creator sees <code>ready</code> plus the available renditions. The uploaded master and rendition map are now persistent and playback can start.",tables:[{name:"videos",cols:["video_id","uploader_id","title","status","duration","created_at"],rows:[{c:["v_9kQ2aZ","42","Summer road trip 4K","ready","742","2026-07-22 12:08:20"],hi:1,tag:"read"}]},{name:"renditions",cols:["video_id","resolution","bitrate","codec","storage_url","segment_manifest_url"],rows:[{c:["v_9kQ2aZ","720p","3000","h264","s3://renditions/v_9kQ2aZ/720p/","s3://renditions/v_9kQ2aZ/720p/index.m3u8"],hi:1},{c:["v_9kQ2aZ","2160p","16000","hevc","s3://renditions/v_9kQ2aZ/2160p/","s3://renditions/v_9kQ2aZ/2160p/index.m3u8"]}]}]},narrate:"The upload flow returns quickly after durable ingest; readiness is observed later by polling or notification. Once <code>videos.status='ready'</code> and at least one <code>renditions</code> row exists, viewers can request a manifest.",details:[
        {k:"wire",label:"Status response",lang:"json",code:"{\n  \"video_id\": \"v_9kQ2aZ\",\n  \"status\": \"ready\",\n  \"renditions\": [\"720p\", \"2160p\"],\n  \"watch_url\": \"https://watch.example/v_9kQ2aZ\"\n}"},
        {k:"note",label:"Failure model",text:"If transcode backs up or a worker dies, the master remains durable and jobs retry. The incident is time-to-watchable/quality degradation, not lost uploads."},
      ]},
    ]},
    {id:"playback-e2e",name:"Playback path",summary:"Viewer hits play → metadata point-read by <code>video_id</code> builds the manifest → CDN edge serves immutable segments with **95-99% hit ratio** → cache misses coalesce through origin shield → ABR player chooses each segment and view counts update asynchronously.",steps:[
      {node:"client",title:"Viewer requests a video",snap:{cap:"Playback starts as a read: no bytes yet and no mutation. The request targets the existing ready row for <code>v_9kQ2aZ</code> and asks for a device-filtered manifest.",tables:[{name:"videos",cols:["video_id","uploader_id","title","status","duration","created_at"],rows:[{c:["v_9kQ2aZ","42","Summer road trip 4K","ready","742","2026-07-20 09:12:00"],hi:1,tag:"will read"}]},{name:"view_counts",cols:["video_id","count","updated_at"],rows:[{c:["v_9kQ2aZ","4820117","2026-07-22 11:59:30"],tag:"unchanged"}]}]},narrate:"A viewer presses play on <code>v_9kQ2aZ</code>. The first request asks for structured metadata and a playback manifest, not for the video bytes themselves.",details:[
        {k:"wire",label:"Playback start request",lang:"http",code:"GET /v1/videos/v_9kQ2aZ/playback\nX-Viewer: u_77\nX-Device-Codecs: h264,hevc\nX-Max-Resolution: 2160p\nX-Region: bom"},
        {k:"note",label:"Startup budget",text:"The player wants first frame under ~2s, so the server should return metadata/manifest fast and let the client start on 1-2 small low-rung segments while quality ramps."},
      ]},
      {node:"meta",title:"Metadata DB point-reads by video_id",snap:{cap:"No mutation: the hot path is a local point-read by <code>video_id</code>, returning status and the rendition rows needed to build the manifest.",tables:[{name:"videos (local replica · read)",cols:["video_id","uploader_id","title","status","duration","created_at"],rows:[{c:["v_9kQ2aZ","42","Summer road trip 4K","ready","742","2026-07-20 09:12:00"],hi:1,tag:"point read"}]},{name:"renditions (by video_id)",cols:["video_id","resolution","bitrate","codec","storage_url","segment_manifest_url"],rows:[{c:["v_9kQ2aZ","720p","3000","h264","s3://renditions/v_9kQ2aZ/720p/","s3://renditions/v_9kQ2aZ/720p/index.m3u8"],hi:1},{c:["v_9kQ2aZ","2160p","16000","hevc","s3://renditions/v_9kQ2aZ/2160p/","s3://renditions/v_9kQ2aZ/2160p/index.m3u8"],hi:1}]}]},narrate:"The API routes the lookup to the local-region metadata partition for <code>video_id</code>. This is the playback-hot query: status plus the rendition map that says which manifest objects exist.",details:[
        {k:"query",label:"Core playback lookup",lang:"sql",code:"SELECT video_id, uploader_id, title, status, duration\nFROM videos\nWHERE video_id = 'v_9kQ2aZ';\n\nSELECT resolution, bitrate, codec, storage_url, segment_manifest_url\nFROM renditions\nWHERE video_id = 'v_9kQ2aZ'\nORDER BY bitrate;"},
        {k:"route",label:"Why video_id is the partition key",text:"Playback is ~58K reads/s average and a few hundred K/s peak, all as point reads by <code>video_id</code>. Partitioning by <code>video_id</code> gives O(1) local reads in every region; an uploader index would optimize channel pages but hurt the hot path."},
        {k:"repl",label:"Read routing",text:"Use local replicas/caches for ordinary playback because the rendition map is mostly immutable after ready. Freshly uploaded videos can read with stronger consistency/quorum so a creator does not see a ready page before the rendition rows are visible."},
      ]},
      {node:"cdn",title:"Return CDN manifest URLs",snap:{cap:"The response swaps storage-internal rendition manifests for CDN URLs. Metadata is unchanged; the CDN may now cache the manifest as a static object.",tables:[{name:"renditions",cols:["video_id","resolution","bitrate","codec","storage_url","segment_manifest_url"],rows:[{c:["v_9kQ2aZ","720p","3000","h264","s3://renditions/v_9kQ2aZ/720p/","cdn://v/v_9kQ2aZ/720p/index.m3u8"],hi:1,tag:"URL mapped"},{c:["v_9kQ2aZ","2160p","16000","hevc","s3://renditions/v_9kQ2aZ/2160p/","cdn://v/v_9kQ2aZ/2160p/index.m3u8"],hi:1}]},{name:"CDN cache · manifest",cols:["cache_key","state","ttl"],rows:[{c:["/v/v_9kQ2aZ/master.m3u8","miss → fill","300s"],hi:1,tag:"cacheable"}]}]},narrate:"The service builds or selects a device-specific HLS/DASH master manifest that points to CDN URLs, not storage-internal URLs. Device negotiation trims the ladder so an old phone never sees a 4K HEVC rung it cannot decode.",details:[
        {k:"wire",label:"Manifest response",lang:"json",code:"{\n  \"video_id\": \"v_9kQ2aZ\",\n  \"title\": \"Summer road trip 4K\",\n  \"duration\": 742,\n  \"manifest_url\": \"https://cdn.example/v/v_9kQ2aZ/master.m3u8\",\n  \"renditions\": [\n    { \"resolution\": \"720p\", \"bitrate\": 3000, \"codec\": \"h264\" },\n    { \"resolution\": \"2160p\", \"bitrate\": 16000, \"codec\": \"hevc\" }\n  ]\n}"},
        {k:"route",label:"CDN edge selection",text:"GeoDNS/Anycast and client steering route the manifest GET to a nearby healthy PoP. At ~100-150M peak concurrent streams and ~5Mbps each, the edge must carry ~500Tbps; origin only survives if this is cache-first."},
      ]},
      {node:"player",title:"Player chooses the first rung",snap:{cap:"Client-side ABR chooses a conservative first rung. Server state is unchanged; the next GET will target the 720p rendition and build buffer before stepping up.",tables:[{name:"player buffer (client state)",cols:["video_id","chosen_resolution","buffer_seconds"],rows:[{c:["v_9kQ2aZ","720p","0 → 4"],hi:1,tag:"first rung"}]},{name:"renditions (candidate ladder)",cols:["video_id","resolution","bitrate","codec","storage_url","segment_manifest_url"],rows:[{c:["v_9kQ2aZ","720p","3000","h264","s3://renditions/v_9kQ2aZ/720p/","s3://renditions/v_9kQ2aZ/720p/index.m3u8"],hi:1},{c:["v_9kQ2aZ","2160p","16000","hevc","s3://renditions/v_9kQ2aZ/2160p/","s3://renditions/v_9kQ2aZ/2160p/index.m3u8"]}]}]},narrate:"The adaptive player fetches the manifest and starts conservatively: usually 1-2 small low/mid-rung segments to hit the startup SLO, then ramps based on buffer and measured throughput.",details:[
        {k:"wire",label:"HLS master manifest",lang:"text",code:"#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=426x240,CODECS=\"avc1\"\n240p/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,CODECS=\"avc1\"\n720p/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=16000000,RESOLUTION=3840x2160,CODECS=\"hvc1\"\n2160p/index.m3u8"},
        {k:"note",label:"ABR decision",text:"Buffer above ~20s and filling means step up; buffer below ~10s or falling means step down. Keeping the decision client-side makes the server/CDN a static-file delivery path."},
      ]},
      {node:"cdn",title:"Segment cache hit or origin fill",snap:{cap:"The first 720p segment is served from edge cache if hot; otherwise a single coalesced fill reaches origin and then the PoP serves subsequent viewers locally.",tables:[{name:"CDN edge cache (bom · segments)",cols:["cache_key","state","origin_key"],rows:[{c:["/v/v_9kQ2aZ/720p/seg-000001.ts","HIT","renditions/v_9kQ2aZ/720p/seg-000001.ts"],hi:1,tag:"read"},{c:["/v/v_9kQ2aZ/720p/seg-000042.ts","MISS → single-flight fill","renditions/v_9kQ2aZ/720p/seg-000042.ts"]}]},{name:"renditions",cols:["video_id","resolution","bitrate","codec","storage_url","segment_manifest_url"],rows:[{c:["v_9kQ2aZ","720p","3000","h264","s3://renditions/v_9kQ2aZ/720p/","s3://renditions/v_9kQ2aZ/720p/index.m3u8"],hi:1,tag:"source map"}]}]},narrate:"Segments are immutable cacheable objects. A normal hot segment is a local edge hit; a cold segment misses once, is fetched through shield/origin, then serves every other viewer in that PoP from cache.",details:[
        {k:"wire",label:"Segment GET",lang:"http",code:"GET /v/v_9kQ2aZ/720p/seg-000001.ts HTTP/1.1\nHost: cdn.example\nRange: bytes=0-\n\nHTTP/1.1 200 OK\nCache-Control: public, max-age=2592000, immutable\nX-Cache: HIT\nContent-Length: 1572864"},
        {k:"query",label:"Origin object read on miss",lang:"text",code:"GET s3://renditions/v_9kQ2aZ/720p/seg-000001.ts\n# edge miss -> origin shield single-flight -> object storage\n# cache key = /v/v_9kQ2aZ/720p/seg-000001.ts (versioned/content-addressed)"},
        {k:"repl",label:"Miss storm protection",text:"At 95% hit ratio, origin sees ~25Tbps instead of ~500Tbps; at 99%, ~5Tbps. Request coalescing at the PoP plus origin shield turns 2M viewers missing the same segment into roughly one origin read per segment per shield."},
      ]},
      {node:"storage",title:"Origin storage serves misses durably",snap:{cap:"On the miss branch, origin storage returns the immutable segment from its durable key; the edge cache then owns future local reads, while metadata remains unchanged.",tables:[{name:"object storage · origin",cols:["video_id","object_key","durability"],rows:[{c:["v_9kQ2aZ","renditions/v_9kQ2aZ/720p/seg-000042.ts","multi-AZ replicas"],hi:1,tag:"served"}]},{name:"CDN edge cache (bom · segments)",cols:["cache_key","state","origin_key"],rows:[{c:["/v/v_9kQ2aZ/720p/seg-000042.ts","filled","renditions/v_9kQ2aZ/720p/seg-000042.ts"],hi:1,tag:"now cached"}]}]},narrate:"On a miss, CDN pulls the segment from object storage. Object storage is not the source of metadata truth, but it is the source of bytes; it stores masters and renditions under deterministic keys and rebuilds redundancy after node loss.",details:[
        {k:"route",label:"Byte-path keying",text:"The byte path is key-based: <code>renditions/{video_id}/{resolution}/seg-N.ts</code>. The metadata DB tells the player these keys exist; storage itself does not answer relational questions."},
        {k:"repl",label:"Origin durability + failover",text:"Objects are spread across nodes/AZs for ~11-nines durability. Hot content and all masters are multi-region replicated so a region outage only hurts cache misses until the CDN origin-fails over; masters let cold renditions be regenerated."},
        {k:"gotcha",label:"Cold miss latency trade-off",text:"Tiering and JIT transcode save exabytes, but the first viewer of cold content may pay archive restore or encode latency. Popularity detection and pre-warming are how you keep that from becoming visible on sudden trends."},
      ]},
      {node:"player",title:"ABR fetch loop continues",snap:{cap:"The loop remains stateless GETs. The player's buffer rises to 24s and it can switch to 1080p/2160p later without changing server state.",tables:[{name:"player buffer (client state)",cols:["video_id","current_resolution","buffer_seconds"],rows:[{c:["v_9kQ2aZ","720p → 1080p","24"],hi:1,tag:"ABR decision"}]},{name:"CDN edge cache (bom · segments)",cols:["cache_key","state","origin_key"],rows:[{c:["/v/v_9kQ2aZ/720p/seg-000001.ts","HIT","renditions/v_9kQ2aZ/720p/seg-000001.ts"],hi:1},{c:["/v/v_9kQ2aZ/1080p/seg-000042.ts","next GET","renditions/v_9kQ2aZ/1080p/seg-000042.ts"]}]}]},narrate:"Playback is now just repeated idempotent GETs. If throughput drops or the CDN 5xxs, the player retries the same segment on another CDN/edge and downshifts before its ~20-30s buffer drains.",details:[
        {k:"wire",label:"Next segment selection",lang:"json",code:"{\n  \"buffer_seconds\": 24,\n  \"measured_throughput_mbps\": 8.2,\n  \"current_rendition\": \"720p\",\n  \"next_segment\": 42,\n  \"decision\": \"switch_up_to_1080p\"\n}"},
        {k:"gotcha",label:"No server-side session to migrate",text:"A PoP failure does not lose playback state because there is no server-side stream session. The player holds buffer/position locally and can switch hosts at the next segment boundary."},
      ]},
      {node:"meta",title:"Count the view off the hot path",snap:{cap:"The playback path does not synchronously update the counter. A raw view event is queued/aggregated elsewhere, and only a batched rollup later mutates <code>view_counts</code>.",tables:[{name:"view_counts",cols:["video_id","count","updated_at"],rows:[{c:["v_9kQ2aZ","4821959","2026-07-25 07:42:00"],hi:1,tag:"async +1842"},{c:["v_15ftgG","933","2026-07-22 11:58:12"]}]},{name:"videos",cols:["video_id","uploader_id","title","status","duration","created_at"],rows:[{c:["v_9kQ2aZ","42","Summer road trip 4K","ready","742","2026-07-20 09:12:00"],tag:"unchanged"}]}]},narrate:"The view event is not a synchronous <code>UPDATE view_counts SET count=count+1</code>. It is batched/aggregated asynchronously so a viral title at tens of thousands of views/s does not melt one metadata partition.",details:[
        {k:"wire",label:"View event",lang:"json",code:"{\n  \"event\": \"view_started\",\n  \"video_id\": \"v_9kQ2aZ\",\n  \"viewer_id\": \"u_77\",\n  \"position_ms\": 0,\n  \"ts\": \"2026-07-25T07:41:31Z\"\n}"},
        {k:"query",label:"Sharded approximate rollup",lang:"sql",code:"-- after Kafka/windowed aggregation, not per raw view\nUPDATE view_counts\nSET count = count + 1842,\n    updated_at = now()\nWHERE video_id = 'v_9kQ2aZ';"},
        {k:"gotcha",label:"Exactness trade-off",text:"Displayed counts are approximate and eventually consistent; exact monetization counts are computed offline from the raw event log with dedup/fraud rules. Do not put per-view writes on the core playback metadata path."},
      ]},
    ]},
  ],
  requirements:{
    functional:[
      "Upload a video, then transcode it into multiple codec and resolution renditions",
      "Store masters and renditions durably, plus metadata, thumbnails, and view counts",
      "Stream playback globally with adaptive quality and minimal rebuffering",
      "Track and display a view count on every video",
    ],
    nonFunctional:[
      "Playback starts in under ~2s with minimal rebuffering across every device and network",
      "Huge read:write skew — a video is uploaded once and watched millions of times",
      "Hard durability — an uploaded master must never be lost",
      "Petabyte-scale storage and edge-dominated egress at billions of views/day",
    ],
  },
  reqBuild:[
    {req:"Upload a video (adds transcoding)",reveal:["transcode"],turns:[
      {who:"intv",text:"Start with the simplest thing for requirement one: a creator uploads a video. What's the minimal path from their laptop to something we've stored?"},
      {who:"cand",text:"The <strong>client</strong> sends bytes to the <strong>upload service</strong>, which writes them into <strong>object storage</strong> as the master — my core boxes already cover ingest. I'd make the upload resumable and chunked so a dropped connection re-sends only the missing parts, but functionally the master is now safely stored. That satisfies 'upload a video' at its most literal."},
      {who:"intv",text:"That master is a single 4K file. Can every device — an old phone, a smart TV — actually play it straight from storage?"},
      {who:"cand",text:"No, and that's the gap. A raw master is the wrong format and bitrate for most devices and networks, so to be watchable everywhere it has to become a ladder of renditions across codecs and resolutions. That's heavy CPU and can take minutes to hours, so I won't do it inline — let me add a <strong>transcoding</strong> pipeline. On upload completion the service writes the master and enqueues a transcode job, returning success immediately; the pipeline fans the master out into renditions asynchronously. Ingest stays fast, and the expensive work scales on its own."},
    ],resources:[
      {title:"Netflix: video processing with microservices",url:"https://netflixtechblog.com/rebuilding-netflix-video-processing-pipeline-with-microservices-4e5e6310e359"},
      {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
    ]},
    {req:"Store the video and track metadata and views (adds metadata DB)",reveal:["meta"],turns:[
      {who:"intv",text:"Requirement two: alongside the bytes we need the title, description, uploader, and the view count under the video. Does that go in object storage too?"},
      {who:"cand",text:"No — object storage is right for the large immutable bytes, but the title, description, owner, processing state, and the map of which renditions exist and where are structured, queryable facts. Let me add a <strong>metadata DB</strong> for those. The manifest a player streams is built from that rendition map, so metadata is what turns a pile of stored segments into a playable video. Bytes in object storage, knowledge about the bytes in the metadata DB."},
      {who:"intv",text:"You slipped the view count in with title and description. Same storage, same treatment?"},
      {who:"cand",text:"Different beast, and worth separating now. Title and description are write-once, read-often structured data, comfortable in a relational or document store and cached hard. The <strong>view count</strong> is a high-write monotonic counter a hot video hammers thousands of times a second — a naive row UPDATE would serialize on one lock and melt. So I keep core metadata in the metadata DB and count separately with a scalable, approximate mechanism. Same 'metadata' label, opposite access patterns."},
    ],resources:[
      {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      {title:"ByteByteGo: system design",url:"https://bytebytego.com/"},
    ]},
    {req:"Stream playback with adaptive quality (adds adaptive player)",reveal:["player"],turns:[
      {who:"intv",text:"Requirement three: a viewer hits play and expects it to start fast and not buffer, on any network. Walk me through the read path and add what you need."},
      {who:"cand",text:"The renditions are already in object storage and fronted by the <strong>CDN</strong>, which serves two static things: a <strong>manifest</strong> listing each rendition and its short segments, and the <strong>segments</strong> themselves. The consumer is an <strong>adaptive player</strong> — let me add it on the edge. It fetches the manifest, then pulls segments one at a time, picking a rendition per segment from its measured buffer and bandwidth. So playback is just a sequence of cacheable GETs off the CDN."},
      {who:"intv",text:"Who decides which quality to fetch — the server or the client?"},
      {who:"cand",text:"The client, deliberately. Only the player sees its real-time buffer level and throughput, so it owns the ABR decision; the server just publishes the menu of pre-made rendition files. That keeps the delivery tier a dumb, cacheable file server, which is exactly what lets the CDN absorb billions of views. Adaptive quality plus a playback buffer is also what absorbs a network dip without a stall — the player just downshifts. That satisfies all three requirements; now I'd harden it under failure."},
    ],resources:[
      {title:"Apple: HTTP Live Streaming (HLS)",url:"https://developer.apple.com/streaming/"},
      {title:"MPEG-DASH adaptive streaming",url:"https://en.wikipedia.org/wiki/Dynamic_Adaptive_Streaming_over_HTTP"},
    ]},
  ],
  systemDives:[
    {title:"A video goes viral — origin thundering herd",tag:"scaling",reveal:[],turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a video goes viral — <b>2M concurrent</b> viewers hit one title within minutes, but its segments aren't yet cached at most PoPs. Every edge misses the same segments simultaneously and stampedes origin storage. Origin buckles. Contain it.</span>"},
      {who:"cand",text:"This is a <strong>cache-miss storm / thundering herd</strong>, and I fight it in layers. Within a single PoP I use <strong>request coalescing (single-flight)</strong>: thousands of viewers missing the same segment trigger exactly one origin fetch and the rest wait on its result. Segments are immutable, so I cache them with long TTLs and never worry about invalidation. That alone turns per-PoP concurrent misses into one origin read per segment."},
      {who:"intv",text:"You still have hundreds of PoPs all missing the same segment at the same instant."},
      {who:"cand",text:"Right, so I add a <strong>tiered cache / origin shield</strong> between edges and origin: hundreds of PoP misses funnel into a few shield nodes that coalesce again, so origin sees a handful of reads per segment instead of hundreds. When virality is predictable I also <strong>pre-position</strong> the title to edges and promote it into the hot storage tier on the first spike.<span class='eg'>2M viewers of one 1080p segment collapse to about one origin read per PoP, then to a few reads total behind the shield.</span>A hot object should cost origin roughly one read per segment no matter how many people watch."},
    ],resources:[
      {title:"Cloudflare: what is a CDN?",url:"https://www.cloudflare.com/learning/cdn/what-is-a-cdn/"},
      {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
    ]},
    {title:"The transcoding pipeline backs up for hours",tag:"failover",reveal:[],turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a bad deploy slows encode workers 4x and the transcode queue backs up to a <b>6-hour</b> lag. New uploads sit un-watchable and creators are furious. Triage it.</span>"},
      {who:"cand",text:"First, nothing is lost — the queue decouples ingest from processing, so uploads are safely enqueued; this is a latency incident, not data loss. Immediate moves: roll back the bad deploy and <strong>autoscale</strong> the worker pool hard to burn down the backlog. Structurally I stop processing strict FIFO under pressure and add <strong>priority lanes</strong> so a new title's cheapest watchable rung jumps ahead of expensive 4K rungs and background re-encodes."},
      {who:"intv",text:"If you still can't clear it all in time, what do you protect?"},
      {who:"cand",text:"Time-to-<strong>watchable</strong> over completeness. For each new title I rush a single low or mid rendition to 'ready' so the video plays, then fill in the high-res rungs later. Across titles I order by <strong>expected viewership</strong> so a big channel's upload beats an obscure one, and I shed the lowest-value work — re-encodes and optional codec variants — until the backlog clears. Degraded quality now beats un-watchable for hours, and because encode jobs are idempotent and retryable, the drained backlog still finishes correctly."},
    ],resources:[
      {title:"Netflix: video processing with microservices",url:"https://netflixtechblog.com/rebuilding-netflix-video-processing-pipeline-with-microservices-4e5e6310e359"},
      {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
    ]},
    {title:"Storage cost of many renditions plus the long tail",tag:"scaling",reveal:[],turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> every title is stored as ~8 renditions plus the master, multiplying raw footprint <b>5-6x</b> and adding <b>petabytes per day</b>. Finance asks why storage cost is exploding. Cut it without hurting playback.</span>"},
      {who:"cand",text:"Several levers, biggest first. <strong>(1) Per-title encoding</strong> — only generate ladder rungs the content actually needs; a low-motion talking-head doesn't need a 16Mbps rung. <strong>(2)</strong> Tier the long tail aggressively to cold/archive storage, since popularity is extremely skewed and most titles get almost no views after a while. <strong>(3)</strong> Drop rarely-selected renditions and delete intermediate encode artifacts once the final ladder exists. A small hot set justifies premium storage; the vast cold tail goes cheap."},
      {who:"intv",text:"Would you ever not store all renditions at all?"},
      {who:"cand",text:"Yes — for the cold long tail I'd use <strong>just-in-time transcoding</strong>: keep only the master, and on the rare request encode the needed rendition on demand and cache it at the edge.<span class='eg'>A niche 2015 upload at ~5 views/month: store the master only and JIT-encode on the occasional play; a trending title: keep the full ladder hot.</span>That trades a little first-view latency for enormous savings on content nobody watches. It's a hybrid keyed on popularity — pre-encode the head, JIT the tail — and per-title encoding is the single biggest documented win."},
    ],resources:[
      {title:"Netflix: per-title encode optimization",url:"https://netflixtechblog.com/per-title-encode-optimization-7e99442b62a2"},
      {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
    ]},
    {title:"A CDN PoP fails mid-stream",tag:"durability",reveal:[],turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> the edge PoP serving a whole metro fails while <b>500K</b> viewers are mid-stream through it. Is any of their playback or content lost, and what do their players do in the next few seconds?</span>"},
      {who:"cand",text:"Nothing durable is lost, because the PoP holds no source-of-truth state — it's a cache in front of origin storage, and playback itself is a stateless sequence of segment GETs. So a PoP loss is recoverable with no session migration. The player's 20-30s <strong>buffer</strong> keeps playback going through the switchover, and two mechanisms redirect it: <strong>anycast</strong> re-routes the metro's traffic to the next-nearest PoP in seconds, and <strong>GeoDNS health checks</strong> stop resolving viewers to the dead PoP. The player just requests the next segment — an idempotent GET — from the new edge."},
      {who:"intv",text:"And the content that was only cached on that dead PoP — is it gone?"},
      {who:"cand",text:"No — the edge cache is disposable by design; the durable copies live in <strong>multi-AZ, redundant object storage</strong> (replication for hot data, erasure coding for the rest) with the masters always retained, so any rendition is either re-fetched from origin or regenerable from the master. A cold new PoP just re-populates on demand via cache-on-miss, shielded by the origin-shield tier so the failover doesn't stampede origin. Viewers see at most a brief quality dip while the buffer covers the reroute, never a lost stream."},
    ],resources:[
      {title:"Netflix Open Connect",url:"https://openconnect.netflix.com/"},
      {title:"Cloudflare: what is a CDN?",url:"https://www.cloudflare.com/learning/cdn/what-is-a-cdn/"},
    ]},
  ],
  q:{
    client:[
      {l:"easy",tag:"concept",q:"What must a web / mobile / TV client actually do?",turns:[
        {who:"intv",text:"Your client box lumps together 'web / mobile / TV'. Those decode differently and sit on very different networks. What does the client actually do in a streaming session, and why should the backend care?"},
        {who:"cand",text:"The client is an <strong>ABR player</strong>, not a dumb GET. It fetches a <strong>manifest</strong>, measures its own throughput and buffer level, and decides which quality segment to pull next. The backend has to care because device capabilities differ wildly — a TV wants 4K HEVC, an old phone wants 720p H.264.<span class='eg'>One title, one manifest listing renditions from 240p @ 300kbps up to 4K @ 16Mbps; a phone on LTE picks 720p, a TV on fibre picks 4K.</span>So I must pre-produce and store <em>multiple codec/resolution renditions</em>, and let the client choose per-device, per-network."},
        {who:"intv",text:"So the quality-picking logic lives entirely on the client?"},
        {who:"cand",text:"Yes — ABR is deliberately client-driven. The server just publishes the menu (manifest plus segment URLs); the client owns the decision because only it sees the real-time buffer and bandwidth. That keeps the delivery tier a dumb, cacheable file server — which is exactly what lets a CDN absorb the load. I'll lean on that property heavily throughout."},
      ],resources:[
        {title:"Apple: HTTP Live Streaming (HLS)",url:"https://developer.apple.com/streaming/"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"hard",tag:"scaling",q:"10M concurrent viewers on one title across 40 device types.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a premiere pushes <b>10M concurrent viewers</b> onto a single title within minutes, spread across ~40 distinct device/codec profiles. If each device asked your origin for its exact rendition on demand, the origin would melt. How do you serve 10M concurrent without the origin feeling it?</span>"},
        {who:"cand",text:"The trick is that segments are <strong>static, immutable files</strong>, pre-generated per rendition — not built on demand. So 10M viewers of the same title requesting the same 1080p segment collapse to <strong>cache hits</strong> at the CDN edge; the origin serves each segment essentially once per PoP. Device diversity is handled ahead of time: I pre-encode the ladder so the client just picks a rendition from a menu of files that already exist and are already cacheable."},
        {who:"intv",text:"40 profiles means up to 40x the files per title. Doesn't that just move the explosion from delivery to storage and transcode?"},
        {who:"cand",text:"It does shift cost there, and I accept that trade because delivery is the dominant scaling axis. But I bound it: the ladder is fixed and modest (~6-8 rungs, a few codec variants), per-title encoding trims rungs a title doesn't need, and the long tail tiers to cold storage. So I pay a bounded, one-time <em>storage/compute</em> cost per title to make the <em>delivery</em> path — the one that scales to 10M concurrent — a pure static-file cache hit. That's the right place to spend."},
      ],resources:[
        {title:"Cloudflare: what is a CDN?",url:"https://www.cloudflare.com/learning/cdn/what-is-a-cdn/"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"medium",tag:"failover",q:"Viewer drives into a tunnel mid-stream.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a viewer on mobile drives into a tunnel — throughput drops from 12Mbps to 200kbps for 8 seconds, then recovers. Their player is mid-segment. What happens, and how do you keep it from becoming a spinner?</span>"},
        {who:"cand",text:"This is exactly what ABR plus a <strong>playback buffer</strong> is for. The player has, say, 20-30s buffered ahead, so an 8s drop is absorbed with zero visible impact — the user keeps watching from the buffer. Meanwhile the player sees its buffer draining, immediately <strong>downshifts</strong> to a low rendition (240p @ 300kbps fits in 200kbps-ish), and requests the next segment at that quality. Segments are small and independently fetchable, so a failed fetch is just an idempotent retry."},
        {who:"intv",text:"And if the drop lasts longer than the buffer can cover?"},
        {who:"cand",text:"Then a rebuffer is unavoidable — but I make it graceful, not a crash. The player pauses, shows a spinner, keeps retrying the lowest rendition against the nearest edge (stateless GETs, so retries are safe and can even hit a different PoP), and resumes the instant a segment lands — then ramps quality back up as the buffer refills. No server-side session state is lost because playback is just a sequence of cacheable GETs; recovery is entirely client-local."},
      ],resources:[
        {title:"Apple: HTTP Live Streaming (HLS)",url:"https://developer.apple.com/streaming/"},
        {title:"MPEG-DASH adaptive streaming",url:"https://en.wikipedia.org/wiki/Dynamic_Adaptive_Streaming_over_HTTP"},
      ]},
      {l:"medium",tag:"durability",q:"Offline downloads must survive an app kill on a plane.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> the app is killed and reopened on a plane with no network, and the user has <b>2GB</b> of episodes 'downloaded for offline'. Those must play without loss and each must resume at the right second. Where does that state live?</span>"},
        {who:"cand",text:"Offline playback can't depend on the network, so the durable state lives <strong>on the device</strong>: the downloaded segments, the manifest, and the DRM license (with a bounded offline validity window) are stored in the app's local encrypted store, written to durable device storage — not just memory — so an app kill doesn't lose them. On reopen with no network, the player reads entirely from local: it never contacts my origin, and the 2GB is intact because it was flushed to disk as it downloaded."},
        {who:"intv",text:"Watch position for those offline episodes — client or server as source of truth?"},
        {who:"cand",text:"Server is the source of truth for <em>cross-device</em> resume, but the client must be authoritative <em>while offline</em>. So the player checkpoints position locally, and on reconnect reconciles with the watch-history service using a <strong>last-writer / max-position</strong> rule (you rarely un-watch, so taking the furthest position per device is usually right, with recency as tiebreak). Offline, it trusts local; online, it syncs. Worst case is a few seconds of drift, which is well within tolerance for a resume feature."},
      ],resources:[
        {title:"Apple: HTTP Live Streaming (HLS)",url:"https://developer.apple.com/streaming/"},
        {title:"ByteByteGo: system design",url:"https://bytebytego.com/"},
      ]},
    ],
    upload:[
      {l:"medium",tag:"concept",q:"Upload a 4GB video over flaky wifi — how do the bytes get in?",turns:[
        {who:"intv",text:"Walk me through uploading a 4GB video from a laptop on flaky wifi. What does the upload service hand the client, and how do the bytes actually reach storage?"},
        {who:"cand",text:"I use <strong>resumable, chunked, multipart upload</strong> with <strong>pre-signed URLs</strong>. The client calls the upload service to <em>initiate</em>, gets an upload-id plus pre-signed URLs, and then PUTs the file in independent chunks <strong>directly to object storage</strong> — not through my service.<span class='eg'>4GB split into 5MB parts = ~800 parts; each part uploads and acks independently, so a dropped connection re-sends only the in-flight part, not the whole file.</span>When all parts land, the client calls <em>complete</em> and storage assembles them into one object."},
        {who:"intv",text:"Bytes go straight to object storage, not through your service — why?"},
        {who:"cand",text:"Because routing 4GB (and 720K hours/day in aggregate) through my app tier would make it a bandwidth bottleneck and a scaling nightmare for no benefit. The upload service is a thin <strong>control plane</strong>: it authenticates, issues scoped pre-signed URLs (time-limited, single-object), and tracks the session; the heavy data plane is object storage, which is built for exactly this. It also means my service stays stateless and cheap to scale."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"ByteByteGo: system design",url:"https://bytebytego.com/"},
      ]},
      {l:"easy",tag:"concept",q:"Where do title, views, and rendition info live? (adds metadata DB)",reveal:["meta"],turns:[
        {who:"intv",text:"Where do the title, description, uploader, and the view count under the video live? That's clearly not the video bytes."},
        {who:"cand",text:"Those need their own home — let me add a <strong>metadata DB</strong>. It holds the structured, queryable facts about a video: title, description, owner, tags, upload/processing state, and — critically — the <strong>map of which renditions exist and where</strong> in storage, which the manifest is built from.<span class='eg'>A video row: {videoId, ownerId, title, state: ready, renditions: [240p, 480p, 720p, 1080p], thumbnailKey, createdAt}.</span>The bytes live in object storage; the <em>knowledge about</em> the bytes lives here."},
        {who:"intv",text:"You lumped view count in with title and description. Same storage problem?"},
        {who:"cand",text:"No — and that's worth separating now. Title/description are write-once, read-often structured data, comfortable in a relational or document store. The <strong>view count</strong> is a high-write monotonic counter that a hot video hammers thousands of times a second — a totally different beast that a naive row-update would choke on. I'd store the counter separately (sharded/approximate) from the core metadata. We should drill into the metadata DB on its own; it earns it."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"ByteByteGo: system design",url:"https://bytebytego.com/"},
      ]},
      {l:"hard",tag:"scaling",q:"One master must become 8 renditions — don't block upload. (adds transcoding)",reveal:["transcode"],turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> you accept a 1-hour 4K master. To be watchable everywhere it must become ~8 renditions across codecs — heavy CPU, minutes-to-hours of encode per title, and <b>720K hours land every day</b>. If the upload service did this inline, uploads would block for hours. How do you structure it?</span>"},
        {who:"cand",text:"I decouple ingest from processing entirely. The upload service does one thing on completion: write the master to storage and <strong>enqueue a transcode job</strong>, then return success immediately — the creator's upload is 'done' in seconds. A separate <strong>transcoding</strong> pipeline consumes the queue and fans the master out into the rendition ladder asynchronously. Let me add a transcoding component fed by that job queue; it scales independently of the upload path."},
        {who:"intv",text:"So the video isn't watchable the instant upload finishes?"},
        {who:"cand",text:"Correct — it enters a <strong>'processing'</strong> state. But I make the wait short and useful: the pipeline publishes renditions <em>as they complete</em>, low quality first, so a watchable 480p can appear within a minute or two while 4K finishes later. When the first playable rendition lands, metadata flips the video to 'ready' and playback works; higher rungs light up progressively. So upload never blocks, and time-to-watchable is minimized rather than gated on the full ladder."},
      ],resources:[
        {title:"Netflix: video processing with microservices",url:"https://netflixtechblog.com/rebuilding-netflix-video-processing-pipeline-with-microservices-4e5e6310e359"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"hard",tag:"durability",q:"A 50GB upload dies at 90% — resume only the missing 10%.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a creator uploads a <b>50GB</b> ProRes master over 40 minutes and the connection dies at <b>90%</b>. Re-uploading 45GB is unacceptable. How do you make the resume cost only the missing 10%?</span>"},
        {who:"cand",text:"This is precisely why upload is chunked and resumable rather than a single stream. The 50GB is split into thousands of independent parts, each uploaded and <strong>acked with an ETag</strong> as it lands in storage.<span class='eg'>50GB in 10MB parts = ~5,000 parts; at 90% ~4,500 already committed. On resume the client asks which parts landed and re-sends only the ~500 missing.</span>The completed parts are already durable in object storage, so the crash costs the missing tail, not the whole file."},
        {who:"intv",text:"How does the server know part 4,500 landed intact and isn't corrupt?"},
        {who:"cand",text:"Each part carries a <strong>checksum</strong> (MD5/CRC) that storage validates on receipt; a mismatch is rejected so the client re-sends just that part. At <em>complete</em>, the service verifies every expected part is present before assembling and committing the final object — an incomplete set never becomes a playable master. And abandoned uploads don't leak: incomplete multipart sessions are garbage-collected by a storage <strong>lifecycle TTL</strong> after a few days. So partial data is either verifiably completed or cleanly reclaimed."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"ByteByteGo: system design",url:"https://bytebytego.com/"},
      ]},
      {l:"medium",tag:"failover",q:"The pod coordinating an upload session dies mid-upload.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> an upload session is coordinated by one upload-service pod that holds the upload-id → parts mapping. That pod is OOM-killed mid-upload with <b>300 active sessions</b>. Do those uploads die with it?</span>"},
        {who:"cand",text:"They must not, and the design that prevents it is keeping the pod <strong>stateless</strong>. The authoritative session state — upload-id, which parts have landed, their ETags — lives in the <strong>metadata DB / object storage</strong>, not in pod memory. The multipart upload is itself tracked by the storage service. So when the pod dies, the client simply reconnects (through the LB) to <em>any</em> other pod, which reads the session state from the shared store and hands back the list of received parts. The upload resumes exactly where it was."},
        {who:"intv",text:"And if you'd kept that parts-mapping only in the pod's memory?"},
        {who:"cand",text:"Then those 300 sessions would be orphaned — the new pod wouldn't know which parts existed, forcing full restarts, which for 50GB uploads is brutal. That's the whole reason I externalize session state on the first design pass: it turns a pod death from data-loss into a transparent client reconnect. It also lets me deploy and autoscale the upload tier freely, since any pod can serve any session. Stateless coordinators, durable state, is the rule."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"ByteByteGo: system design",url:"https://bytebytego.com/"},
      ]},
      {l:"medium",tag:"capacity",q:"Size the upload path — bandwidth and how many service instances?",turns:[
        {who:"intv",text:"Concrete numbers. With ~500 hours of video landing every minute, how much ingest bandwidth is that, and how big does the upload-service fleet have to be to absorb it?"},
        {who:"cand",text:"The key move is separating the data plane from the control plane. Raw ingest bandwidth is large, but it never touches my service.<span class='eg'>500 video-hours/min = ~8.3 hours/s = 30,000 video-seconds/s; at ~10 Mbps average source bitrate that is ~300 Gbps sustained, peak 3-5x approaching ~1 Tbps.</span>Those bytes go <strong>direct to object storage</strong> via pre-signed URLs, so the fleet never carries that 300 Gbps."},
        {who:"intv",text:"So what does the upload service actually have to be sized for?"},
        {who:"cand",text:"Just the <strong>control plane</strong>: initiate, part-tracking, and complete calls.<span class='eg'>~500 hours/min at ~10-min average videos = ~3,000 uploads started/min = ~50 initiates/s, plus completes and status checks — low thousands of req/s even at peak.</span>That is a handful of stateless instances across 3 AZs for redundancy, not for throughput. The trade-off I am rejecting is proxying bytes through the service: simpler to reason about, but it would force a ~1 Tbps app fleet for zero benefit. So I route bytes direct-to-storage and keep the control tier tiny — capacity here is dominated by storage bandwidth, not compute."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"ByteByteGo: system design",url:"https://bytebytego.com/"},
      ]},
    ],
    storage:[
      {l:"medium",tag:"concept",q:"Object storage for masters and renditions — plus hot vs cold.",turns:[
        {who:"intv",text:"You picked 'object storage' for both masters and renditions. Defend it — and tell me how you avoid paying premium storage for a 10-year-old video nobody watches."},
        {who:"cand",text:"Video files are large, immutable, write-once blobs read by simple key — the exact sweet spot for <strong>object storage</strong> (S3-style): cheap per-GB, extremely durable, HTTP-native so a CDN can pull from it directly. No database needed for the bytes themselves. For cost, I use <strong>tiered storage</strong>: hot tier for new and popular content, cold/archive tiers for the long tail.<span class='eg'>New release: hot SSD-backed tier. A niche 2015 upload with ~5 views/month: archive tier at a fraction of the cost, slower to fetch.</span>"},
        {who:"intv",text:"How do you decide hot vs cold, and what's the risk of getting it wrong?"},
        {who:"cand",text:"Access-frequency-driven <strong>lifecycle policies</strong>: content unwatched for N days demotes to cold, and a spike in access promotes it back. The risk is a <strong>cold-miss</strong> — a dormant title suddenly trends and its renditions sit in slow archive, so the first views are latency spikes or failures. I mitigate by keeping the <em>master</em> always retrievable, promoting on the first access signal, and treating trend detection as an input to pre-warming. The safety net is that renditions are always regenerable from the master."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"ByteByteGo: system design",url:"https://bytebytego.com/"},
      ]},
      {l:"hard",tag:"scaling",q:"Renditions multiply footprint 5-6x — cut storage cost.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> every title is stored as ~8 renditions plus the master, so renditions multiply raw footprint ~5-6x — you're adding <b>petabytes per day</b>. Finance asks why storage cost is exploding. Cut it without hurting playback.</span>"},
        {who:"cand",text:"Several levers, biggest first. <strong>(1) Per-title encoding</strong> — only generate ladder rungs the content actually needs; a low-motion talking-head doesn't need a 16Mbps rung, saving both storage and bitrate. <strong>(2)</strong> Tier the long tail aggressively to cold/archive — most titles get almost no views after a while. <strong>(3)</strong> Drop rarely-selected renditions and delete intermediate encode artifacts once the final ladder is produced. Popularity is extremely skewed, so a small hot set justifies premium storage and the vast cold tail goes cheap."},
        {who:"intv",text:"Would you ever <em>not</em> store all renditions — transcode on the fly instead?"},
        {who:"cand",text:"Yes, for the cold long tail: <strong>just-in-time transcoding</strong> — store only the master, and on the rare request encode the needed rendition on demand and cache the result at the edge. That trades a bit of first-view latency for enormous storage savings on content nobody watches. For hot content I keep everything pre-encoded so playback is a pure cache hit. It's a hybrid keyed on popularity: pre-encode the head, JIT the tail. Per-title optimization is the single biggest win Netflix documents here."},
      ],resources:[
        {title:"Netflix: per-title encode optimization",url:"https://netflixtechblog.com/per-title-encode-optimization-7e99442b62a2"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"hard",tag:"durability",q:"A storage node holding hot renditions loses its disk.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a storage node holding the hot 1080p renditions for thousands of trending titles suffers an unrecoverable disk failure. Are those renditions gone, and do viewers notice?</span>"},
        {who:"cand",text:"Not gone, and viewers shouldn't notice — because I never let a single node be the only copy. Object storage stores each object <strong>redundantly across many nodes and AZs</strong> (replication for hot data, erasure coding for the rest), targeting the ~11-nines durability an S3-class store gives. A single node loss is transparent: reads route to another copy, and the system rebuilds the lost redundancy in the background. As an ultimate backstop, the <strong>masters</strong> are always retained, so any rendition is fully regenerable by re-running transcode."},
        {who:"intv",text:"Erasure coding vs replication — which, and why, for video?"},
        {who:"cand",text:"Both, by tier. <strong>Erasure coding</strong> for masters and cold content: it gives high durability at ~1.3-1.5x overhead instead of 3x, which matters enormously across petabytes. <strong>Replication</strong> for hot renditions: full copies mean any replica serves a read at low latency and reconstruction isn't needed on the read path, which suits high-QPS delivery. So I pay replication's storage premium only where read latency and throughput justify it, and take erasure coding's cost win everywhere else."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"ByteByteGo: system design",url:"https://bytebytego.com/"},
      ]},
      {l:"hard",tag:"failover",q:"The origin storage region goes dark for 20 minutes.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> the entire storage region (us-east-1) that your CDN pulls origin from becomes unavailable for 20 minutes. Cache-miss fetches now fail. What do viewers experience, and how do you avoid a global outage?</span>"},
        {who:"cand",text:"Content already cached at the edges keeps serving fine — that's most of the hot traffic, so the blast is limited to <strong>cache misses</strong> (cold/less-popular content and cold PoPs). To keep even those alive, origin must be <strong>multi-region</strong>: hot content and all masters are replicated to a second region, and the CDN is configured with <strong>origin failover</strong> so a miss that can't reach us-east-1 falls back to us-west-2. Viewers see, at worst, a slightly slower first fetch for cold content; popular titles are unaffected."},
        {who:"intv",text:"Replicating petabytes cross-region is expensive. You replicate everything?"},
        {who:"cand",text:"No — I replicate what failover actually needs: the <strong>hot set plus all masters</strong>. Hot content is what most misses want, and masters let a surviving region <em>regenerate</em> any cold rendition on demand rather than store a full second copy of the long tail. So cross-region cost tracks the small hot set, not the whole catalog. I also add an <strong>origin-shield</strong> tier so cross-region backfills are coalesced, and asynchronously backfill cold content into the secondary only when it's actually requested there."},
      ],resources:[
        {title:"Cloudflare: what is a CDN?",url:"https://www.cloudflare.com/learning/cdn/what-is-a-cdn/"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"medium",tag:"capacity",q:"How many petabytes a day, and what does that cost you to keep?",turns:[
        {who:"intv",text:"You said storage grows in petabytes per day. Show me that number from the ingest rate, and tell me what it forces on your storage design."},
        {who:"cand",text:"It comes straight from ingest times the rendition fan-out.<span class='eg'>500 hours/min = 720K hours/day; a 6-8 rung ladder plus master sums to roughly ~20 Mbps of stored bitrate per video-hour → ~9 GB per video-hour; 720K × 9 GB ≈ 6.5 PB/day, on the order of ~2.4 EB/year.</span>So this is exabyte-scale within a couple of years, and no single cluster or naive 3x replication survives that cost."},
        {who:"intv",text:"So how do you keep exabytes without the bill exploding?"},
        {who:"cand",text:"I tier by popularity and pick redundancy per tier. Full <strong>3x replication</strong> gives the fastest reads but triples the footprint — I only pay that for the hot set. The vast cold tail goes to <strong>erasure coding</strong> at ~1.3-1.5x overhead, and to cold/archive classes.<span class='eg'>Replicating 6.5 PB/day at 3x = ~19.5 PB/day of raw disk; erasure-coding the ~90% cold tail cuts that closer to ~8-9 PB/day.</span>The trade-off is that cold-tier reads are slower and reconstruction costs CPU, which is fine because the cold tail is rarely watched — and masters are always retained so any rendition is regenerable. Decision: replicate the hot head, erasure-code and tier the cold tail."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"ByteByteGo: system design",url:"https://bytebytego.com/"},
      ]},
      {l:"medium",tag:"concept",q:"Which storage system — cloud object store, HDFS, or self-managed?",turns:[
        {who:"intv",text:"You keep saying object storage. Be specific — an S3-class cloud object store, HDFS, or a self-run cluster like Ceph or MinIO? Defend the pick against the other two."},
        {who:"cand",text:"For the bytes I want a <strong>cloud object store (S3-class)</strong>. It is HTTP-native so a CDN pulls segments straight from it, it is ~11-nines durable out of the box, and it scales to exabytes with no capacity planning. <strong>HDFS</strong> is built for high-throughput batch analytics over big blocks, but it is not HTTP-native, the NameNode is a scaling and availability chokepoint, and it is operationally heavy for what is really a serve-blobs-over-HTTP workload. So HDFS solves a problem I do not have."},
        {who:"intv",text:"And a self-managed Ceph or MinIO cluster — why not own it?"},
        {who:"cand",text:"That is the real contender at the top end. Self-managed object storage means no per-GB and per-egress fees, which across exabytes and hundreds of Tbps of egress dominate the bill; the cost is you now own durability, rebalancing, and hardware ops.<span class='eg'>Cloud egress fees alone at ~500 Tbps peak would run into millions per day — exactly why Netflix built Open Connect on owned hardware.</span>Trade-off: opex-and-simplicity versus capex-and-control. Decision: start on a cloud object store for durability and zero ops, then migrate the hot, high-egress path onto self-managed storage and edge appliances once scale makes the egress economics worth the capex — a hybrid keyed on volume."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"Netflix Open Connect",url:"https://openconnect.netflix.com/"},
      ]},
    ],
    cdn:[
      {l:"medium",tag:"concept",q:"How does a player get the right chunk at the right time? (adds player)",reveal:["player"],turns:[
        {who:"intv",text:"The CDN serves the video files. But how does a player get exactly the right quality chunk at the right moment? Walk me through what the CDN actually hands out."},
        {who:"cand",text:"The CDN serves two kinds of static file: a <strong>manifest</strong> and the <strong>segments</strong>. The manifest (HLS m3u8 or DASH MPD) lists each rendition and the URLs of its short segments; the segments are a few seconds of video each. The <strong>adaptive player</strong> — let me add it as the consumer on the edge — fetches the manifest, then pulls segments one at a time, choosing the rendition per segment based on its buffer and bandwidth.<span class='eg'>Manifest lists 240p/480p/720p/1080p; player fetches seg-001 at 720p, sees the buffer filling, requests seg-002 at 1080p.</span>"},
        {who:"intv",text:"Why segments and a manifest, not one big file per rendition?"},
        {who:"cand",text:"Segmentation is what makes adaptive streaming and caching work. Small independent segments let the player <strong>switch quality at every boundary</strong>, seek by jumping to a segment, and start playback after one small fetch instead of a huge file. And each segment is an immutable, individually cacheable object, so the CDN caches at segment granularity — a viewer who joins mid-video reuses the same cached segments as everyone else. One monolithic file would defeat switching, seeking, and fine-grained caching all at once."},
      ],resources:[
        {title:"MPEG-DASH adaptive streaming",url:"https://en.wikipedia.org/wiki/Dynamic_Adaptive_Streaming_over_HTTP"},
        {title:"Apple: HTTP Live Streaming (HLS)",url:"https://developer.apple.com/streaming/"},
      ]},
      {l:"medium",tag:"concept",q:"Push vs pull, and where do edges physically sit?",turns:[
        {who:"intv",text:"Your CDN — do you push content out to edges ahead of time, or let them pull on demand? And where do these edges physically sit?"},
        {who:"cand",text:"Default is <strong>pull (cache-on-miss)</strong>: an edge fetches a segment from origin the first time a viewer in its region asks, then caches it for everyone after. But for content with predictable demand I add <strong>push / pre-positioning</strong>: a new episode drop is pushed to edges overnight so the very first viewers get a cache hit, not a miss stampede. Physically, Netflix takes this furthest with <strong>Open Connect</strong> appliances placed <em>inside ISP networks</em>, so bytes travel the last mile without crossing the public backbone."},
        {who:"intv",text:"When is pre-positioning worth the effort and storage at every edge?"},
        {who:"cand",text:"When demand is <strong>predictable and concentrated</strong> — a marquee release, a scheduled premiere, a title you know will trend in a region. There the push cost buys you zero first-view misses at massive concurrency, which is exactly when a miss storm would hurt most. For the unpredictable long tail, pull is right — you don't waste edge capacity pre-staging content that may never be watched there. So: push the predictable head, pull the tail. Open Connect essentially pre-positions the popular catalog close to viewers for the same reason."},
      ],resources:[
        {title:"Netflix Open Connect",url:"https://openconnect.netflix.com/"},
        {title:"Cloudflare: what is a CDN?",url:"https://www.cloudflare.com/learning/cdn/what-is-a-cdn/"},
      ]},
      {l:"hard",tag:"scaling",q:"A viral video triggers a cache-miss storm on origin.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a video goes viral — <b>2M concurrent</b> viewers hit one title whose segments aren't yet cached at most PoPs. Every edge misses simultaneously and stampedes origin storage with the same segment requests. Origin buckles. Contain it.</span>"},
        {who:"cand",text:"This is a <strong>thundering herd / cache-miss storm</strong>, and it comes in two layers. Within a single PoP I use <strong>request coalescing (single-flight)</strong>: many viewers missing the same segment trigger exactly <em>one</em> origin fetch, and the rest wait on its result. That alone turns thousands of concurrent misses per segment per PoP into one origin read. Segments are immutable, so I cache them with long TTLs and there's never an invalidation concern."},
        {who:"intv",text:"Coalescing helps per-PoP, but you have hundreds of PoPs all missing the same segment at once."},
        {who:"cand",text:"Right, so I add a <strong>tiered cache / origin-shield</strong> layer between the edges and origin. Hundreds of PoP misses funnel into a small number of shield nodes that coalesce <em>again</em>, so origin sees a handful of reads for that segment instead of hundreds. Combined with <strong>pre-positioning</strong> when virality is anticipated, and promoting the title into the hot storage tier on the first spike, origin load for a viral title stays flat regardless of viewer count. The whole point is that a hot object should cost origin roughly one read per segment."},
      ],resources:[
        {title:"Cloudflare: what is a CDN?",url:"https://www.cloudflare.com/learning/cdn/what-is-a-cdn/"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"hard",tag:"failover",q:"An edge PoP fails with 500K viewers mid-stream through it.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> the edge PoP serving a whole metro area fails while <b>500K</b> viewers are mid-stream through it. What do those players do in the next few seconds?</span>"},
        {who:"cand",text:"Because playback is stateless segment GETs, a PoP loss is recoverable without any session migration. Two mechanisms kick in: at the network layer, <strong>anycast</strong> re-routes the metro's traffic to the next-nearest PoP almost immediately; and at the DNS layer, <strong>GeoDNS health checks</strong> stop resolving viewers to the dead PoP within the health-check interval. The player's buffer (20-30s) covers the switchover, and it simply requests the next segment from the new edge — an idempotent GET that either hits the new PoP's cache or misses through to origin."},
        {who:"intv",text:"How fast is that reroute, and who actually triggers it?"},
        {who:"cand",text:"Anycast reroutes at the network layer in seconds as routes withdraw — no client action needed. GeoDNS health-check failover is slower, tens of seconds, gated by the check interval and TTL. The fastest and most robust layer is <strong>client-side multi-CDN</strong>: the player is configured with more than one CDN and, on repeated segment errors, switches CDN at the next segment boundary itself — so it doesn't wait for DNS at all. Between the buffer masking the gap and the player actively failing over, 500K viewers see at most a brief quality dip, not a stop."},
      ],resources:[
        {title:"Netflix Open Connect",url:"https://openconnect.netflix.com/"},
        {title:"Cloudflare: what is a CDN?",url:"https://www.cloudflare.com/learning/cdn/what-is-a-cdn/"},
      ]},
      {l:"hard",tag:"durability",q:"Stale edge-cached content: a re-encode and a takedown.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a title is re-encoded to fix a corrupt audio track, but ~300 PoPs still hold the old segments cached with a 30-day TTL, so viewers keep getting the broken version. Separately, a DMCA takedown must make a title vanish globally in minutes. How do you handle both?</span>"},
        {who:"cand",text:"The rule is that the <strong>CDN is a cache, not the source of truth</strong> — origin storage plus the manifest are. For the re-encode, I use <strong>content-addressed / versioned segment URLs</strong>: the URL includes a content hash or version, so a re-encode produces <em>new</em> URLs and a new manifest that points at them. Players fetch the new manifest and request the new segments; the stale ones are simply never referenced again and age out on their own. No mass purge needed for updates."},
        {who:"intv",text:"Content-hash URLs vs an active purge — when do you use each?"},
        {who:"cand",text:"Hashed/versioned URLs handle <em>updates</em> for free — you never serve the old bytes because nothing links to them anymore, so the 30-day TTL is harmless. But a <strong>takedown</strong> requires the old bytes to actually stop serving, so there I use the CDN's <strong>active purge / invalidation API</strong> to evict that title's objects across all PoPs within minutes, plus removing it from origin and flipping metadata to 'removed' so no new manifest references it. So: versioned URLs for correctness on updates, active purge for hard removal — and I keep TTLs bounded rather than infinite precisely so nothing can get truly stuck."},
      ],resources:[
        {title:"Cloudflare: what is a CDN?",url:"https://www.cloudflare.com/learning/cdn/what-is-a-cdn/"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"medium",tag:"capacity",q:"How much egress bandwidth, and how much must the edge absorb?",turns:[
        {who:"intv",text:"Egress is the number that scares people here. From ~5B views/day, what peak egress does the CDN have to push, and what does that imply?"},
        {who:"cand",text:"Egress scales with concurrent streams times bitrate, not with views per second.<span class='eg'>5B views/day at a ~10-min average session ≈ 5e9 × 600s / 86,400s ≈ ~35M concurrent streams average; peak 3-5x → ~100-150M concurrent; at ~5 Mbps each that is 100M × 5 Mbps ≈ ~500 Tbps peak egress.</span>Half a petabit per second is far beyond any single origin or the public backbone — so the number itself dictates that delivery must be edge-served."},
        {who:"intv",text:"So how much of that 500 Tbps is the edge really carrying versus your origin?"},
        {who:"cand",text:"Nearly all of it. Because segments are immutable and popularity is heavily skewed, a high edge cache-hit ratio means origin only sees misses.<span class='eg'>At a ~95% edge hit ratio, origin egress drops from ~500 Tbps to ~25 Tbps; push it to 99% with pre-positioning and origin sees ~5 Tbps.</span>The trade-off is edge capacity and storage cost versus origin bandwidth: I spend heavily on edge PoPs and ISP appliances precisely so origin bandwidth stays a rounding error. Decision: size the edge for the full ~500 Tbps and size origin only for the miss stream — the whole architecture exists to keep that hit ratio high."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"Cloudflare: what is a CDN?",url:"https://www.cloudflare.com/learning/cdn/what-is-a-cdn/"},
      ]},
      {l:"medium",tag:"concept",q:"Which CDN — buy commercial, build your own, or multi-CDN?",turns:[
        {who:"intv",text:"For delivery, do you buy a commercial CDN like CloudFront or Akamai, build your own like Netflix Open Connect, or run several? Make the call."},
        {who:"cand",text:"A <strong>commercial CDN</strong> is the right start: global PoPs on day one, no capex, and you pay per GB delivered. The catch is that per-GB pricing is brutal at video egress scale — at hundreds of Tbps the delivery bill dwarfs everything else. <strong>Building your own</strong> (Open Connect-style appliances placed inside ISP networks) flips that: huge upfront capex and ops, but egress cost collapses and you get last-mile control and better QoE. So it is a classic buy-for-speed versus build-for-unit-economics decision."},
        {who:"intv",text:"And running more than one CDN at once — worth the complexity?"},
        {who:"cand",text:"Yes, for resilience and reach. <strong>Multi-CDN</strong> lets the player steer to the healthiest, cheapest path per region and survive a whole CDN degrading, at the cost of integration complexity and split cache efficiency.<span class='eg'>A single CDN at ~500 Tbps peak is both a cost and a single-vendor risk; splitting across 2-3 providers plus owned appliances caps exposure to any one.</span>Decision, staged by scale: launch on one or two commercial CDNs for speed, add client-side multi-CDN steering for resilience, and build owned edge appliances for the popular catalog once egress volume makes the capex pay back — pre-position the head on owned edge, buy commercial capacity for the tail and bursts."},
      ],resources:[
        {title:"Netflix Open Connect",url:"https://openconnect.netflix.com/"},
        {title:"Cloudflare: what is a CDN?",url:"https://www.cloudflare.com/learning/cdn/what-is-a-cdn/"},
      ]},
    ],
    transcode:[
      {l:"hard",tag:"scaling",q:"Encode a 2-hour master into 8 renditions in minutes, not hours.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a 2-hour 4K master must become ~8 renditions. Encoding it serially on one machine could take <b>longer than the movie itself</b>, and thousands of titles land per hour. How do you make one title finish in minutes, not hours?</span>"},
        {who:"cand",text:"I parallelize by splitting the master into independent <strong>chunks</strong> at GOP boundaries and fanning out <strong>parallel encode jobs on a queue</strong> — one job per (chunk x rendition). Thousands of workers pull jobs concurrently, so wall-clock time drops from serial-length to roughly the longest single chunk-encode.<span class='eg'>2h master in 2-min chunks = 60 chunks x 8 rungs = 480 independent jobs; with 480 free workers the whole title encodes in about one chunk's time.</span>The bitrate ladder (240p/300kbps up to 4K/16Mbps) is just the set of rungs each chunk is encoded to."},
        {who:"intv",text:"How parallel can one title go, and what's the risk when you stitch it back?"},
        {who:"cand",text:"Parallelism is bounded by chunk-count times ladder-rungs, capped by available workers and by how small a chunk can get before per-job overhead dominates. The real risk is <strong>stitching</strong>: chunks must split on <strong>keyframe/GOP boundaries</strong> with aligned timestamps and consistent encoder settings, or you get visible seams or A/V drift at segment joins. So I cut only at IDR frames, pin encode parameters per rendition across all chunks, and validate continuity before publishing. Done right, the concatenated segments are indistinguishable from a single-pass encode."},
      ],resources:[
        {title:"Netflix: video processing with microservices",url:"https://netflixtechblog.com/rebuilding-netflix-video-processing-pipeline-with-microservices-4e5e6310e359"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"medium",tag:"concept",q:"Same bitrate ladder for a cartoon and an action movie?",turns:[
        {who:"intv",text:"You keep saying 'bitrate ladder'. Is it the same ladder for a simple cartoon and a high-motion action movie?"},
        {who:"cand",text:"No — a fixed ladder wastes bits on easy content and starves hard content, so I use <strong>per-title encoding</strong>. I analyze the title's complexity and tailor its ladder: bitrates, resolutions, and how many rungs.<span class='eg'>A flat-shaded cartoon can look perfect at 1080p using ~2Mbps, where a grainy action film needs ~8Mbps for the same perceived quality — so their ladders differ in both bitrate and rung count.</span>Same visual quality, far fewer bits for simple content — which cuts both storage and delivery bandwidth."},
        {who:"intv",text:"Per-shot encoding goes even finer — how granular, and is it worth it?"},
        {who:"cand",text:"Per-shot analyzes each <strong>scene/shot</strong> and allocates bitrate to its complexity — a static dialogue shot gets few bits, an explosion gets many, within the same title. It's more granular than per-title and squeezes out more savings at equal quality. The cost is the extra <strong>analysis compute</strong> per shot and a more complex pipeline. At YouTube/Netflix scale, where a title is encoded once and streamed billions of times, that one-time analysis cost is trivially repaid by the lifetime bandwidth saved — so yes, it's worth it there."},
      ],resources:[
        {title:"Netflix: per-title encode optimization",url:"https://netflixtechblog.com/per-title-encode-optimization-7e99442b62a2"},
        {title:"Netflix: video processing with microservices",url:"https://netflixtechblog.com/rebuilding-netflix-video-processing-pipeline-with-microservices-4e5e6310e359"},
      ]},
      {l:"hard",tag:"failover",q:"The transcode queue backs up 6 hours — uploads unwatchable.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a code push slows encode workers 4x and the transcode queue backs up to a <b>6-hour</b> lag. New uploads sit un-watchable, and creators are furious. Triage it.</span>"},
        {who:"cand",text:"First, nothing is <em>lost</em> — the queue decouples ingest from processing, so uploads are safely enqueued; this is a latency incident, not a data incident. Immediate actions: <strong>autoscale</strong> the worker pool hard to burn down the backlog, and if the push caused it, roll it back. Structurally, I add <strong>priority lanes</strong> so I don't process jobs FIFO under pressure — a brand-new title's cheapest watchable rung jumps ahead of expensive 4K rungs and background re-encodes."},
        {who:"intv",text:"When you genuinely can't clear it all in time, what do you prioritize?"},
        {who:"cand",text:"Time-to-<strong>watchable</strong> over completeness. For each new title I rush a single low/mid rendition (say 480p) to 'ready' as fast as possible so the creator's video plays, then defer the high-res rungs and long-tail codecs to fill in later. Across titles I order by <strong>expected viewership</strong> — a channel with millions of subscribers gets priority over an obscure upload. And I shed the lowest-value work entirely under load: re-encodes and optional codec variants pause until the backlog clears. Degraded quality now beats un-watchable for hours."},
      ],resources:[
        {title:"Netflix: video processing with microservices",url:"https://netflixtechblog.com/rebuilding-netflix-video-processing-pipeline-with-microservices-4e5e6310e359"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"medium",tag:"durability",q:"A worker crashes 80% through a chunk — make it a non-event.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a worker crashes 80% through encoding a chunk, and at your scale this happens to ~2% of jobs continuously. If crashes lost work you'd never finish anything. How is a job crash a non-event?</span>"},
        {who:"cand",text:"Jobs are <strong>idempotent and retryable</strong>, and the queue guarantees <strong>at-least-once</strong> delivery. A worker only <em>acks</em> a job after it has fully written the rendition output; if it crashes at 80%, it never acks, the queue's visibility timeout expires, and the job is <strong>redelivered</strong> to a healthy worker that re-encodes it from scratch. Because I chunked the title, only that one ~2-minute chunk is redone, not the whole 2-hour master. And the input is always available — the master is immutable in object storage — so a retry is always possible."},
        {who:"intv",text:"At-least-once means a chunk could get encoded twice. Problem?"},
        {who:"cand",text:"Not if the output is idempotent, which I make it: each rendition output is written to a <strong>deterministic key</strong> keyed by (titleId, chunkId, rendition). A duplicate encode just overwrites the identical object — same input plus same encoder settings yields the same bytes — so a second run is a harmless no-op, not a duplicate segment in the ladder. That gives me an exactly-once <em>effect</em> on top of an at-least-once queue, which is the pragmatic way to get correctness without expensive distributed coordination."},
      ],resources:[
        {title:"Netflix: video processing with microservices",url:"https://netflixtechblog.com/rebuilding-netflix-video-processing-pipeline-with-microservices-4e5e6310e359"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"medium",tag:"capacity",q:"How many encode cores to keep up with uploads?",turns:[
        {who:"intv",text:"Sizing the encode fleet. With 500 hours of video arriving every minute and a full ladder per title, roughly how many cores do you need to keep pace, and how do you provision them?"},
        {who:"cand",text:"I size it from encode-work per minute of arriving video.<span class='eg'>500 video-hours/min = 30,000 video-minutes/min; a chunked full-ladder encode costs on the order of ~10 core-minutes per video-minute → ~300,000 cores running continuously just to break even, peak 3-5x → toward ~1M cores.</span>That is tens of thousands of multi-core machines — far too much to sit idle, so how I provision it matters as much as the count."},
        {who:"intv",text:"So do you reserve that fleet, or something cheaper?"},
        {who:"cand",text:"Reserving for peak means paying for ~1M idle cores most of the day — safe latency, terrible economics. The alternative is an <strong>elastic, queue-buffered</strong> fleet on <strong>spot/preemptible</strong> capacity: the transcode queue already decouples ingest from processing, so it absorbs bursts while workers scale up, and spot is cheap because jobs are idempotent and retryable so a preemption just redelivers the chunk. The trade-off is that under a big burst the backlog grows and time-to-watchable rises. Decision: run a modest reserved floor for steady state plus elastic spot on top for peaks, and lean on priority lanes so a title's first watchable rung still lands fast even while the fleet catches up."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"Netflix: video processing with microservices",url:"https://netflixtechblog.com/rebuilding-netflix-video-processing-pipeline-with-microservices-4e5e6310e359"},
      ]},
    ],
    meta:[
      {l:"medium",tag:"concept",q:"What lives in metadata, and why is a view count different?",turns:[
        {who:"intv",text:"What lives in the metadata DB, and how is 'title + description' a different storage problem from 'view count'?"},
        {who:"cand",text:"Metadata splits into two profiles. <strong>Core metadata</strong> — title, description, owner, tags, processing state, and the rendition map the manifest is built from — is mostly-read, strongly-structured data, happy in a relational or document store, cached hard because it rarely changes.<span class='eg'>videoId → {title, ownerId, state: ready, renditions:[...], thumbnailKey}.</span>The <strong>view count</strong> is the opposite: a single number taking a relentless stream of increments, monotonic, and tolerant of small inaccuracy. Same 'metadata' label, completely different access pattern."},
        {who:"intv",text:"Why not just run an UPDATE on a count column per view?"},
        {who:"cand",text:"Because a single hot row can't absorb the write rate. A trending video takes tens of thousands of increments per second, and every one contends on the <em>same row's</em> lock — you serialize all writers on one lock and the row (and its partition) melts, while also bloating the write-ahead log. A per-view row UPDATE couples display of a fuzzy number to a high-contention hot spot. So counts need their own scalable mechanism — sharded or aggregated — which is worth drilling into separately."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"ByteByteGo: system design",url:"https://bytebytego.com/"},
      ]},
      {l:"hard",tag:"scaling",q:"5B view increments/day — design counting that scales.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> across the catalog you take <b>5B view increments/day</b> (~58K/s average, far higher on hot titles). A single counter row per video can't absorb a hot title's writes. Design counting that scales.</span>"},
        {who:"cand",text:"Two complementary techniques. <strong>Sharded counters</strong>: represent one video's count as N sub-counters (count:vid:0..N-1); each increment hits a random shard, and a read sums the shards. That spreads write load N-ways so no single row is hot.<span class='eg'>16 shards for a hot video turns 32K increments/s on one row into ~2K/s spread across 16 rows.</span>Even better at the top end, I push increments through <strong>Kafka</strong> and do <strong>windowed aggregation</strong> — roll up per-video counts in 1-minute windows and write aggregates, collapsing millions of events into a few writes."},
        {who:"intv",text:"Exact or approximate — does YouTube actually need an exact count?"},
        {who:"cand",text:"For the displayed number, <strong>approximate and eventually-consistent</strong> is fine — the '1.2M views' you see is already fuzzy, often delayed and deduplicated for fraud/bot filtering, so nobody notices if it lags a bit or rounds. That's what lets me batch and aggregate freely. I reserve <strong>exact</strong> counting for the <em>monetization</em> pipeline, which runs offline against the raw event log in Kafka with careful dedup and fraud rules. So: fast approximate counts for display, exact reconciled counts computed offline for money."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"ByteByteGo: system design",url:"https://bytebytego.com/"},
      ]},
      {l:"hard",tag:"failover",q:"One viral video melts its counter hot-partition.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> one video explodes to <b>50K increments/s</b> on its own. Even with sharded counters, its shards happen to hash to one partition and that partition sits at 100% while others idle — the hot-partition melts. Fix it.</span>"},
        {who:"cand",text:"The problem is that sharding <em>the key</em> doesn't help if the shards land on one physical partition. Fixes: <strong>(1)</strong> salt the shard key so a hot video's shards deliberately spread across <em>different</em> partitions, not one. <strong>(2)</strong> the biggest lever — <strong>local pre-aggregation</strong> at the app tier: each server batches increments for a video in memory and flushes a single +N every ~1s, so 50K/s of raw increments becomes a handful of aggregated writes per server. That collapses the write rate before it ever reaches the partition."},
        {who:"intv",text:"How do you know <em>this</em> video is the one that needs extra treatment?"},
        {who:"cand",text:"Detect the hot key cheaply with an <strong>approximate top-K / count-min sketch</strong> at the app or ingest tier — it flags a video crossing a rate threshold within seconds without tracking every video exactly. Once flagged, I promote it: increase its shard count dynamically and/or route its increments through the Kafka aggregation path instead of direct writes. Pre-aggregation already blunts most of the heat, and adaptive sharding handles the rest. It's the same heavy-hitter machinery I'd build for 'trending videos' anyway, reused for counter protection."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"ByteByteGo: system design",url:"https://bytebytego.com/"},
      ]},
      {l:"hard",tag:"durability",q:"The metadata DB primary loses its disk.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> the metadata DB primary's disk dies. Metadata maps which renditions exist and where; without it, videos are unplayable even though the bytes are perfectly safe in storage. How do you guarantee it survives?</span>"},
        {who:"cand",text:"Metadata is small relative to the video bytes but far more critical to availability, so I over-protect it cheaply. It's <strong>replicated across AZs with quorum writes</strong>, so a primary disk failure just promotes a healthy replica — no data loss. On top of that, regular <strong>backups plus point-in-time recovery</strong> from the write-ahead log guard against logical corruption, not just disk death. And as a backstop, the core mapping (which renditions exist for a video) is <em>reconstructible</em> by scanning object storage, since the rendition keys follow a deterministic scheme."},
        {who:"intv",text:"Do view counts get the same durability bar as core metadata?"},
        {who:"cand",text:"No — I tier durability by value. <strong>Core metadata</strong> (ownership, rendition map, state) is business-critical and gets the full quorum-plus-backup treatment; losing it makes videos unplayable or unauthorized. <strong>Approximate view counts</strong> can tolerate small loss — they're rebuildable by replaying the Kafka event log, and a few seconds of un-flushed local aggregates lost in a crash is within the fuzz nobody notices. So I don't pay maximum durability for a number that's already approximate, and I spend it where correctness genuinely matters."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"ByteByteGo: system design",url:"https://bytebytego.com/"},
      ]},
      {l:"medium",tag:"capacity",q:"How big is metadata, and how many nodes does it need?",turns:[
        {who:"intv",text:"Size the metadata store. How many rows, how much space, and how many nodes — separate the core metadata from the counters in your answer."},
        {who:"cand",text:"Core metadata is surprisingly small.<span class='eg'>~500 hours/min at ~10-min videos ≈ ~4M new videos/day; over 5 years ≈ ~8B rows; at ~2 KB per row (title, owner, state, rendition map) ≈ ~16 TB total.</span>That is a modest sharded cluster — a handful of nodes for space, sized more by read QPS than by bytes. Playback lookups track views: ~58K/s average, peak a few hundred K/s, though the cache absorbs almost all of it."},
        {who:"intv",text:"And the counters — same sizing?"},
        {who:"cand",text:"No, counters are a write-rate problem, not a storage one.<span class='eg'>5B view increments/day ≈ 58K/s average, and a single hot title can take tens of thousands/s on its own.</span>Storing counts is trivial bytes; absorbing the write rate on a hot row is not. So the trade-off is one shared store sized for the worst-case write hotspot versus splitting them. Decision: keep <strong>core metadata</strong> on a small sharded, replicated cluster tuned for cached point-reads, and push <strong>counters</strong> onto their own sharded/aggregated path — never let counter write volume dictate the core cluster's node count."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"ByteByteGo: system design",url:"https://bytebytego.com/"},
      ]},
      {l:"hard",tag:"concept",q:"Which datastore for metadata — Cassandra vs Postgres vs DynamoDB?",turns:[
        {who:"intv",text:"Pick the metadata datastore and defend it as a document, not a gut call. Put three candidates on the table — Cassandra, Postgres, DynamoDB — and start by pinning the load they each have to survive."},
        {who:"cand",text:"Let me quantify the load first, because it decides everything. Core metadata is <strong>~8B video rows at ~2 KB each ≈ ~16 TB</strong> — small. The pressure is <em>request rate</em>, not size. The core access pattern is a <strong>point read by video_id</strong> returning the rendition map, on the playback hot path in every region: <strong>~58K lookups/s average, a few hundred K/s at peak</strong>, though a cache absorbs most of it. Writes are gentle by comparison — <strong>~4M new videos/day ≈ ~50 writes/s</strong> plus status flips, so this is a <strong>read-heavy, globally-distributed, tiny-write</strong> workload with one dominant key."},
        {who:"intv",text:"Good — now the node math. Give me a ballpark per-node throughput ceiling for each and roughly how many nodes each would need for that load."},
        {who:"cand",text:"Rough ceilings per node, then divide. <strong>Cassandra</strong>: ~10-30K ops/s per node, so raw read load is a handful of nodes and the cluster is really sized by replication factor and headroom.<span class='eg'>~58K reads/s ÷ ~20K per node ≈ 3 nodes, ×RF 3 across regions ≈ ~9-12 nodes; ~16 TB ÷ ~12 ≈ ~1.3 TB/node — trivial.</span><strong>Postgres</strong>: one primary takes all writes (~50/s is nothing) but reads scale only by adding replicas at ~10-20K reads/s each, and every replica streams from that one primary.<span class='eg'>~58K reads/s ÷ ~15K per replica ≈ 4-5 read replicas per region, ×N regions, all fanning off a single primary continent.</span><strong>DynamoDB</strong>: no nodes to size — you provision capacity and it splits into partitions capped near <strong>~3K reads/s and ~1K writes/s each</strong>, auto-added under load.<span class='eg'>~58K reads/s ÷ ~3K per partition ≈ ~20 partitions it manages for you; global tables replicate per-region.</span>"},
        {who:"intv",text:"Indexing. That video_id point read is easy, but I also want <strong>list all videos by an uploader</strong> for a channel page. How does each model serve both without a full scan?"},
        {who:"cand",text:"Two distinct access patterns, so I design a key per pattern rather than one table with a slow filter. <strong>Lookup by video_id</strong> is the partition key everywhere — Cassandra <code>PRIMARY KEY(video_id)</code>, Dynamo partition key video_id, Postgres PK — an O(1) point read. <strong>List-by-uploader</strong> needs its own path: in Cassandra a second table or materialized view <code>PRIMARY KEY((uploader_id), created_at, video_id)</code> so a channel page is one partition scan newest-first; in DynamoDB a <strong>GSI on uploader_id</strong> (partition) + created_at (sort); in Postgres just a <code>btree(uploader_id, created_at)</code> secondary index. The wide-column stores make me denormalize the second view explicitly; Postgres gives it for free but that convenience is exactly what a single primary makes expensive at global read scale."},
        {who:"intv",text:"And the view counters — whichever store you pick, doesn't a trending video still hammer one hot row and melt a single partition?"},
        {who:"cand",text:"It would if counts lived as a row I UPDATE per view — a hot title at tens of thousands/s serializes every writer on one row's lock and cooks its partition, in <em>any</em> of the three. So counters never sit on the metadata store's hot path. I keep them <strong>approximate and off to the side</strong>: increments go through Kafka and <strong>windowed aggregation</strong> (roll up per-video in ~1-min windows, write a few aggregates) and the stored count is a <strong>sharded counter</strong> — N sub-rows per video, increment a random shard, sum on read.<span class='eg'>16 shards turns 32K increments/s on one row into ~2K/s across 16 rows; salt the shard key so they land on different partitions.</span>The display number is allowed to be fuzzy, so this is safe; exact counts for money are reconciled offline from the raw log."},
        {who:"intv",text:"So commit. Which one, and why not the other two?"},
        {who:"cand",text:"<strong>Decision: a wide-column store, Cassandra-class</strong> (or DynamoDB global tables as the managed equivalent), for the core rendition-map metadata. The deciding factor is <strong>global always-on reads with multi-region write availability</strong>: linear read scale, multi-master so every region serves the lookup locally, and no single primary on the playback hot path.<span class='eg'>~16 TB fits one Postgres box, but ~58K+ reads/s served from the nearest region does not fit a single-primary topology cleanly.</span><strong>Why not Postgres:</strong> its relational power and joins are real, but reads scale only via replicas off one primary continent — a latency and availability chokepoint globally; I would reach for it only for a catalog/search surface needing heavy ad-hoc queries. <strong>Cassandra vs DynamoDB</strong> is then ops preference — self-managed control and no cloud lock-in versus zero node management; I take DynamoDB if we are all-in on one cloud, Cassandra otherwise. Counters stay on their own sharded/aggregated path regardless."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"ByteByteGo: system design",url:"https://bytebytego.com/"},
        {title:"Cassandra data modeling",url:"https://cassandra.apache.org/doc/latest/cassandra/data_modeling/"},
      ]},
    ],
    player:[
      {l:"medium",tag:"concept",q:"How does the player decide to jump 480p to 1080p and back?",turns:[
        {who:"intv",text:"Explain how the adaptive player actually decides to jump from 480p to 1080p and back down. What's the algorithm?"},
        {who:"cand",text:"The manifest lists each rendition (HLS/DASH), and the player runs an <strong>ABR</strong> loop: for each upcoming segment it estimates whether a given quality is sustainable and picks accordingly. The dominant modern signal is <strong>buffer-based</strong> switching — it watches the playback buffer.<span class='eg'>Buffer above ~20s and filling → step up to 1080p; buffer draining below ~10s → step down to 480p to avoid a stall.</span>So quality tracks the health of the buffer, stepping up when there's headroom and down before it risks emptying."},
        {who:"intv",text:"Throughput-based vs buffer-based — why lean on the buffer?"},
        {who:"cand",text:"Raw <strong>throughput estimates are noisy and often misleading</strong> — segment download speed swings with CDN behavior, connection reuse, and burstiness, so switching purely on estimated bandwidth causes oscillation and bad guesses. <strong>Buffer occupancy is a direct, integrated measure</strong> of whether the current quality is actually sustainable: if the buffer is growing at 1080p, 1080p is affordable, full stop. Modern players blend both — throughput for the startup/ramp phase, buffer for steady state — but they lean on buffer because it's the honest signal of what playback can sustain."},
      ],resources:[
        {title:"Apple: HTTP Live Streaming (HLS)",url:"https://developer.apple.com/streaming/"},
        {title:"MPEG-DASH adaptive streaming",url:"https://en.wikipedia.org/wiki/Dynamic_Adaptive_Streaming_over_HTTP"},
      ]},
      {l:"hard",tag:"scaling",q:"40 device classes and 3 CDNs — scale quality across them.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> your title plays on ~40 device classes and you run <b>3 CDNs</b>. A single fixed rendition ladder plus one CDN gives bad quality-of-experience for millions of viewers on the worst path. How does the player scale quality across all this diversity?</span>"},
        {who:"cand",text:"Two axes. On <strong>device diversity</strong>, the player negotiates capabilities — supported codecs, DRM, max resolution, HDR — and the manifest exposes a device-appropriate sub-ladder, so an old phone never even sees a 4K HEVC rung it can't decode. On <strong>network/CDN diversity</strong>, the player does <strong>client-side multi-CDN steering</strong>: it measures each CDN's throughput and error rate and picks the best path per session, so viewers aren't stuck on a degraded CDN in their region. Both decisions live client-side because only the client sees its real device and network conditions."},
        {who:"intv",text:"Multi-CDN steering on the client — how does it actually pick a CDN?"},
        {who:"cand",text:"The player continuously scores each candidate CDN on measured <strong>segment throughput, latency, and error rate</strong>, and picks the best; it can switch mid-session at a segment boundary since segments are interchangeable across CDNs. A central <strong>steering service</strong> supplements this with hints — it sees aggregate health and can bias clients away from a CDN that's degrading regionally or is over its committed capacity. So local measurement handles per-session reality and the steering service handles fleet-wide load balancing, and the two together keep QoE high across the whole device/CDN matrix."},
      ],resources:[
        {title:"Cloudflare: what is a CDN?",url:"https://www.cloudflare.com/learning/cdn/what-is-a-cdn/"},
        {title:"Netflix Open Connect",url:"https://openconnect.netflix.com/"},
      ]},
      {l:"hard",tag:"failover",q:"The player's CDN starts 5xx-ing mid-movie.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> mid-movie, the CDN the player is using starts returning 5xx on segment fetches for one metro. The player has ~20s of buffer. Turn this into zero visible disruption.</span>"},
        {who:"cand",text:"The ~20s buffer is the shock absorber: playback continues from it while the player recovers, so the viewer sees nothing at first. On repeated 5xx for a segment, the player <strong>retries the same idempotent GET against an alternate CDN/edge</strong> — segments are interchangeable, so it just re-fetches segment N somewhere healthy. If throughput on the fallback is lower, it also <strong>downshifts quality</strong> to refill the buffer faster and stay ahead of playback. Because there's no server-side playback session, failing over is just changing which host it GETs from."},
        {who:"intv",text:"And if all your CDNs degrade at the same time?"},
        {who:"cand",text:"Then I preserve continuity over quality: the player drops to the <strong>lowest rendition</strong> (smallest segments, most likely to squeak through) to keep playing as long as possible. If even that can't sustain, it rebuffers <em>gracefully</em> — spinner, keep retrying, resume the instant a segment lands — rather than erroring out. Throughout, it emits <strong>QoE telemetry</strong> (rebuffer events, chosen CDN, bitrate) so the steering service and ops see the incident in real time and can shift traffic. The contract is: degrade smoothly, never hard-fail the session."},
      ],resources:[
        {title:"MPEG-DASH adaptive streaming",url:"https://en.wikipedia.org/wiki/Dynamic_Adaptive_Streaming_over_HTTP"},
        {title:"Cloudflare: what is a CDN?",url:"https://www.cloudflare.com/learning/cdn/what-is-a-cdn/"},
      ]},
      {l:"medium",tag:"durability",q:"Resume at 47:00 on any device after an app crash.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a user is <b>47 minutes</b> into a 90-minute film when the app crashes. On reopen they expect to resume at 47:00 on any device, not restart from zero. Where is that position stored and how durable must it be?</span>"},
        {who:"cand",text:"Playback position is small but the durability expectation is high, so it lives in a <strong>replicated watch-history service</strong>, not just on the device. The player <strong>checkpoints</strong> the current position periodically to that service and also caches it locally. On reopen — even on a different device — it reads the latest checkpointed position and seeks to ~47:00. Because the data is tiny (a video-id, a timestamp, a user-id), replicating it durably across AZs costs almost nothing, and cross-device sync is eventually consistent, which is fine for a resume feature."},
        {who:"intv",text:"Checkpointing every second would hammer the backend. What cadence?"},
        {who:"cand",text:"I throttle it: checkpoint every <strong>~10-30s</strong> and always on meaningful events — pause, seek, background, or exit — so the common 'close the app' case captures a fresh position. Between checkpoints the position is buffered locally and flushed on the next tick or on reconnect, so a crash loses at most a few seconds of progress — imperceptible for resume. For conflicts across devices I reconcile with <strong>furthest-position / last-writer-wins</strong>. That keeps write volume low while still landing the user within a few seconds of where they left off."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"ByteByteGo: system design",url:"https://bytebytego.com/"},
      ]},
      {l:"medium",tag:"capacity",q:"How big a buffer, and what does it cost the client?",turns:[
        {who:"intv",text:"The player buffers ahead to survive network dips. How much should it hold, and what does that choice cost in memory and startup time?"},
        {who:"cand",text:"Buffer size is a direct memory and data trade-off.<span class='eg'>30s of 1080p at ~5 Mbps = 30 × 5 Mbit = 150 Mbit ≈ 19 MB held; at 4K ~16 Mbps that is ~60 MB; with ~4s segments a 1080p segment is ~2.5 MB, so 30s is ~7-8 segments prefetched.</span>So a deep buffer is tens of MB of RAM plus data that is wasted if the viewer abandons early — a real cost on mobile and cheap TVs."},
        {who:"intv",text:"So where do you land, and why not just buffer minutes ahead to be safe?"},
        {who:"cand",text:"Because a huge buffer hurts the two things that matter most. It raises <strong>startup latency</strong> if I gate playback on filling it, and it wastes bandwidth and battery on abandoned sessions.<span class='eg'>Buffering 2 minutes at 1080p is ~75 MB and delays start; ~20-30s is enough to ride out the typical dip while still starting fast.</span>Trade-off: dip-resilience versus startup speed and waste. Decision: start playback after just one or two small low-rung segments so start-time is sub-2s, then build to a <strong>~20-30s steady-state buffer</strong> and let ABR downshift before it drains — moderate buffer, small startup fetch, quality ramps after playback begins."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"Apple: HTTP Live Streaming (HLS)",url:"https://developer.apple.com/streaming/"},
      ]},
    ],
  },
  mockTest:[
    {q:"A creator uploads a 4 GB file over flaky wifi. Design the upload path so a dropped connection does not restart from zero.",a:"Use resumable, chunked multipart upload. Client calls POST /uploads to open a session and gets an upload-id plus pre-signed URLs; it splits the file into independent parts and PUTs each directly to object storage, so on a drop it re-sends only the missing parts. The service tracks chunks_received vs total_chunks and finalizes on complete, writing a video row with status=uploaded and enqueuing transcode. Bytes go straight to storage (not through the app tier), keeping ingest fast and cheap."},
    {q:"On upload completion, how do you turn one master into all the playable qualities without blocking the uploader?",a:"Transcoding is heavy CPU (minutes to hours), so never inline. On complete the upload service enqueues a job and returns success immediately. A worker pool fans the master out into a bitrate ladder of ~6-8 renditions across codecs (h264/hevc/av1) and resolutions in parallel, splitting the video into independent GOP-aligned segments so many workers encode one video at once. Each finished rendition plus its per-rendition manifest is written back to object storage, and metadata flips status to ready once the first playable rendition lands."},
    {q:"Why adaptive bitrate, and who decides which quality to fetch — server or client?",a:"The client decides. The server just publishes a menu: a manifest (HLS/DASH) listing each rendition and its short immutable segments. The ABR player picks a rendition per segment, leaning on buffer occupancy (buffer filling above ~20s means step up; draining below ~10s means step down) with throughput as a startup signal. Client-side because only the player sees its real device capabilities, buffer level, and bandwidth. This keeps delivery a dumb cacheable file server and lets a playback buffer ride out network dips by downshifting instead of stalling."},
    {q:"Why is a CDN mandatory here, and what is the Netflix Open Connect twist?",a:"At ~5B views/day pulling multi-Mbps segments, egress dominates and must be served near the viewer — origin bandwidth and latency cannot absorb it. Segments and manifests are immutable cacheable GETs, ideal for a CDN. Open Connect goes further: Netflix places its own appliances inside ISP networks and pre-positions (pushes) popular titles onto them during off-peak hours, so peak-time playback is served from inside the ISP with near-zero backbone transit. Push/pre-fill fits a catalog with predictable popularity; general UGC leans more on pull-through caching."},
    {q:"Estimate storage growth and justify hot vs cold tiering.",a:"~500 hours/min uploaded is ~720K source hours/day; each fans out to ~6-8 renditions, so effective stored hours are several multiples of that. At streaming bitrates a source hour plus its ladder is on the order of a few GB, putting daily growth in the low petabytes/day and the multi-year corpus in exabyte territory. Most views concentrate on a small set of recent/popular videos, so keep hot renditions on fast object storage fronted by CDN, and move cold masters and rarely-watched renditions to cheaper archival tiers. Masters are kept durably regardless since renditions can be regenerated but a lost master cannot."},
    {q:"Which datastore for core metadata at this scale, and why not a single Postgres?",a:"Core metadata is only ~16 TB (~8B rows x ~2 KB) but takes ~58K+ global point-reads/s by video_id on the playback hot path. Pick a wide-column store (Cassandra-class) or DynamoDB global tables: linear read scale, multi-region multi-master so every region serves the lookup locally, video_id as partition key for O(1) reads, and a second table or GSI on uploader_id+created_at for channel pages. Not a single Postgres: ~16 TB fits one box, but reads scale only via replicas off one primary continent, making it a global latency and availability chokepoint. Reserve relational only for heavy ad-hoc catalog/search queries."},
    {q:"A video goes viral and every viewer requests it the instant it publishes. How do you avoid a thundering herd on the origin?",a:"First request populates the CDN; the danger is many edges missing simultaneously and stampeding the origin. Defenses: request coalescing / single-flight at the edge so concurrent misses for the same segment collapse into one origin fetch; long TTLs on immutable segments so they cache once and serve forever; tiered/shield caching so regional edges pull from a mid-tier rather than all hitting origin; and pre-warming or pushing predicted-popular content to edges ahead of demand. On the metadata side the rendition map is cached hard, and the view counter is protected separately by local pre-aggregation so the surge of view events never becomes origin or DB load."},
    {q:"Does the displayed view count need to be exact, and how do you count at 5B increments/day without a hot row?",a:"The displayed number can be approximate and eventually consistent — it is already fuzzy, delayed, and bot-filtered, so nobody notices small lag. That freedom is what lets it scale. Never UPDATE one row per view: a hot title at tens of thousands/s serializes on one lock and melts its partition. Instead push increments through Kafka with windowed aggregation (roll up per-video in ~1-min windows) and store as a sharded counter (N sub-rows, increment a random salted shard, sum on read) plus per-server local pre-aggregation that flushes a single +N every ~1s. Detect hot keys with a count-min sketch and promote them to more shards. Exact counts for monetization are reconciled offline from the raw Kafka event log with dedup and fraud rules."},
  ]
};

/* ---- scaling journey ---- */
(function(){
var d=window.DATA['video'];
var scaling={id:"scaling",name:"From raw file delivery to adaptive streaming",kind:"scale",
  live:["client","upload","storage","cdn"],
  summary:"Start with the smallest video service that can upload bytes and serve them from the edge, then let real playback and ingest numbers force transcoding, metadata, and an adaptive player. Each stage adds one component only when the previous picture has a measurable ceiling.",
  steps:[
    {node:"storage",stage:"Stage 0 · Baseline",title:"Upload raw bytes, serve the original through CDN",
      live:["client","upload","storage","cdn"],
      edges:[["upload","storage","raw master"],["storage","cdn","origin fetch"]],
      narrate:"The launch design is intentionally plain: the client uploads a master, object storage keeps it durably, and CDN edges serve that same file close to viewers. For one codec, one device class, and forgiving networks, this works and keeps application servers out of the byte path.",
      details:[
        {k:"win",label:"Why start here",text:"It separates control plane from data plane immediately. The upload service issues and tracks the session; the ~300Gbps sustained ingest stream goes direct to object storage, not through the app fleet."},
        {k:"wire",label:"Baseline objects",code:"POST /uploads -> upload_id\nPUT s3://masters/v_9kQ2aZ/source.mov\nGET https://cdn.example/masters/v_9kQ2aZ/source.mov"},
        {k:"scale",label:"Working numbers",text:"~**500 hours/min** arrive, but upload control calls are only low-thousands/s. On reads, ~**5B views/day** means the edge must serve static bytes; origin cannot be the playback path."},
      ],
      snap:{title:"Load & capacity — Stage 0",cap:"Bytes are durable and cacheable, but playback quality is one-size-fits-all.",
        tables:[{name:"signals",cols:["signal","value","verdict"],rows:[
          {c:["Raw ingest","~300Gbps sustained · ~1Tbps peak","bypasses app tier"],hi:1},
          {c:["Upload control plane","~50 initiates/s + completes","small fleet"]},
          {c:["Playback artifact","one original file","fragile"],tag:"risk"},
          {c:["CDN role","cache static file","ok for MVP"]},
        ]}]}},
    {node:"transcode",stage:"Stage 1 · Transcode pipeline",title:"One huge file buffers &rarr; add renditions and segments",
      live:["client","upload","storage","cdn","transcode"],
      edges:[["upload","transcode","enqueue"],["transcode","storage","renditions"]],
      narrate:"The first real viewer problem is not storage durability; it is playback. A single 4K source file cannot adapt to weak networks or small devices, and seeking inside one giant object is painful. The file has to become a ladder of short, cacheable segments.",
      details:[
        {k:"scale",label:"The number that forces it",text:"Each source hour fans out to roughly **6–8 renditions**. At 500 hours/min, the encode fleet needs about **300K cores steady** and can approach **1M cores** at peak, so processing must be asynchronous and queue-fed."},
        {k:"pain",label:"What breaks without it",text:"Weak networks stall on the original bitrate, devices receive codecs they cannot decode, and a worker crash during processing would force redoing an entire movie if work is not chunked."},
        {k:"fix",label:"The fix — async ladder generation",text:"Add **Transcoding**: enqueue jobs after upload, split masters into GOP-aligned chunks, encode chunk × rendition in parallel, and write deterministic HLS/DASH segments back to storage.",pill:"watchable"},
        {k:"gotcha",label:"Exactly-once effect",text:"The queue is at-least-once, so output keys must be deterministic by `(video_id, chunk, rendition)`. A duplicate job overwrites the same segment instead of creating a second copy."},
      ],
      snap:{title:"Load & capacity — Stage 1",cap:"Processing moves out of the upload request and becomes elastic queue work.",
        tables:[{name:"signals",cols:["signal","before","after"],rows:[
          {c:["Playback quality","one raw bitrate","6–8-rung ladder"],hi:1,tag:"fixed"},
          {c:["Seek/startup","large file fetch","short segments"]},
          {c:["Encode work","inline impossible","~300K cores steady"],hi:1},
          {c:["Retry scope","whole file","one ~2-min chunk"]},
        ]}]}},
    {node:"meta",stage:"Stage 2 · Metadata service",title:"Bytes alone are not a product &rarr; add catalog metadata",
      live:["client","upload","storage","cdn","transcode","meta"],
      edges:[["upload","meta","video row"],["transcode","meta","rendition map"]],
      narrate:"Once renditions exist, somebody has to know which title is ready, which segment manifest belongs to which video, and how an upload resumes after a crash. Object storage holds bytes; the product needs structured state keyed by `video_id`.",
      details:[
        {k:"scale",label:"The number that forces it",text:"Core metadata is about **8B rows × ~2KB = ~16TB** over years: small by video standards. The pressure is ~**58K playback reads/s** average, a few hundred K/s at peak, plus only ~50 new-video writes/s."},
        {k:"pain",label:"What breaks without it",text:"Without a metadata service, upload sessions are not resumable, the player cannot build a manifest, and a ready/not-ready state is inferred by scanning object storage — exactly the wrong access path."},
        {k:"fix",label:"The fix — video_id metadata",text:"Add **Metadata DB** for upload sessions, `videos.status`, and the rendition map. Playback does an O(1) point read by `video_id`; list-by-uploader gets its own table or index; view counts stay off this hot row path.",pill:"catalog"},
        {k:"query",label:"Rendition lookup",code:"SELECT resolution, bitrate, codec, segment_manifest_url\nFROM renditions\nWHERE video_id = 'v_9kQ2aZ';"},
      ],
      snap:{title:"Load & capacity — Stage 2",cap:"The database stores knowledge about bytes, not the bytes themselves.",
        tables:[{name:"signals",cols:["signal","value","verdict"],rows:[
          {c:["Core metadata","~16TB","modest"]},
          {c:["Playback reads","~58K/s avg · few hundred K/s peak","point-read + cache"],hi:1},
          {c:["Video writes","~4M/day = ~50/s","easy"]},
          {c:["View increments","5B/day = ~58K/s","separate path"],tag:"risk"},
        ]}]}},
    {node:"player",stage:"Stage 3 · Adaptive player",title:"Static files need client decisions &rarr; add ABR player",
      live:["client","upload","storage","cdn","transcode","meta","player"],
      edges:[["cdn","player","segments"],["meta","player","manifest"]],
      narrate:"The final scaling move is at the edge of the system: only the client sees real throughput, buffer level, device codec support, and CDN health. Keep servers dumb and cacheable; let the player choose the next segment and steer around failure.",
      details:[
        {k:"scale",label:"The number that forces it",text:"Peak delivery can be ~**100–150M concurrent streams × ~5Mbps = ~500Tbps**. A server-side per-session stream manager would be the bottleneck; static segment GETs plus client ABR let the CDN carry the load."},
        {k:"pain",label:"What breaks without it",text:"Without ABR, everyone gets the same quality, so weak networks stall, strong networks are under-served, and a single CDN/PoP failure shows up as a spinner instead of a segment-boundary retry."},
        {k:"fix",label:"The fix — ABR and client telemetry",text:"Add the **Adaptive player**. It starts after 1–2 low-rung segments, builds a ~20–30s buffer, chooses each rendition from measured throughput and buffer occupancy, and emits QoE beacons for CDN/rendition steering.",pill:"edge control"},
        {k:"note",label:"Why the server stays simple",text:"Segments are immutable, content-addressed, and cacheable with long TTLs. A quality change is just the next GET choosing a different URL, so CDN edges do not hold playback session state."},
      ],
      snap:{title:"Load & capacity — Stage 3 (full design)",cap:"The complete design turns playback into stateless cache hits plus local client decisions.",
        tables:[{name:"signals",cols:["signal","value","verdict"],rows:[
          {c:["Peak egress","~500Tbps","served from edge"],hi:1},
          {c:["Edge hit ratio","~95–99%","origin protected"],hi:1,tag:"fixed"},
          {c:["Startup","1–2 low-rung segments","sub-2s target"]},
          {c:["Buffer","~20–30s","rides out dips"]},
        ]}]}},
  ]};
d.deepFlows=[scaling].concat(d.deepFlows);
})();
