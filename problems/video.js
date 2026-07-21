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
  edges:[["client","upload"],["upload","storage"],["storage","cdn"],["upload","transcode"],["transcode","storage"],["upload","meta"],["cdn","player"]],
  core:["client","upload","storage","cdn"],
  basic:["client","upload","storage","cdn"],
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
    ],
  }
};
