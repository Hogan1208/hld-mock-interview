window.DATA = window.DATA || {};
window.DATA['url'] = {
  cat:"IDs · caching · reads",
  title:"Design a URL shortener (TinyURL / bit.ly)",
  blurb:"Shorten long URLs, redirect in <100ms, scale to billions of reads at ~100:1 read/write.",
  prompt:"Let's design a URL shortener like bit.ly. It takes a long URL and returns a short one, redirects users who hit the short link, and must scale to billions of URLs with a very high read-to-write ratio. Start with the high-level architecture and rough numbers, then we'll drill into components — and I'll be throwing failure scenarios at you.",
  opening:"Let me frame it before drawing boxes.<br><br><strong>Functional:</strong> create a short URL, redirect, optional custom alias + expiry, basic click analytics. <strong>Non-functional:</strong> redirect p99 < 100ms, ~100:1 read:write, high availability (a dead redirect breaks a link on someone else's site), and keys that are unique and not trivially guessable.<br><br><strong>Back-of-envelope:</strong> ~100M new URLs/day → ~1,160 writes/s, ~116K reads/s at 100:1, peak 3-5x. Storage: 100M/day x 365 x 5y ≈ 180B URLs; ~500 bytes each ≈ 90 TB — a sharded KV store, not one box.<br><br>I'll start deliberately minimal: <strong>client → load balancer → stateless shortener service → database</strong>. That's the skeleton that satisfies correctness. As we hit scale and failure pressure I'll grow it — caching, key generation, replicas, analytics. Pick a box and let's push on it.",
  nodes:[
    {id:"client",name:"Client",sub:"browser / app",x:40,y:150},
    {id:"lb",name:"LB + gateway",sub:"edge",x:210,y:150},
    {id:"svc",name:"Shortener svc",sub:"stateless",x:380,y:150},
    {id:"db",name:"Database",sub:"KV store",x:550,y:150},
    {id:"cache",name:"Cache",sub:"Redis",x:380,y:40},
    {id:"key",name:"Key generation",sub:"unique IDs",x:380,y:260},
    {id:"replica",name:"DB replicas",sub:"read + failover",x:550,y:40},
    {id:"analytics",name:"Analytics",sub:"async clicks",x:550,y:260},
  ],
  edges:[["client","lb","HTTP"],["lb","svc","route"],["svc","db","write"],["svc","cache","read"],["cache","db","on miss"],["svc","key","get id"],["db","replica","replicate"],["svc","analytics","async"]],
  core:["client","lb","svc","db"],
  basic:["client","lb","svc","db"],
  dbDoc:{
    component:"Database (mapping store)",
    load:"~1,160 writes/s (peak ~5K); up to ~116K reads/s on a cold cache (but the cache/replicas absorb ~95%+); ~180B rows ≈ 90TB raw, ×3 replication ≈ 270TB. Access = single-key point lookup, no joins, no range scans.",
    candidates:[
      {name:"PostgreSQL (relational)",ceiling:"~5-10K writes/s per primary",nodes:"~1 primary + read replicas; 270TB forces bolt-on sharding across many nodes",pick:false,note:"we need no joins/transactions and it tops out on write throughput + storage on a single primary; sharding is a bolt-on you operate by hand."},
      {name:"Cassandra / ScyllaDB (wide-column)",ceiling:"~10-50K writes/s per node",nodes:"storage-bound: 270TB ÷ ~2TB usable/node ≈ <strong>135 nodes</strong> (throughput needs far fewer)",pick:false,note:"excellent fit — linear scale, hash partitioning, tunable consistency; the runner-up, chosen if you want to self-host."},
      {name:"DynamoDB (managed KV)",ceiling:"~1K WCU &amp; ~3K RCU per partition, auto-splits",nodes:"managed / auto-sharded; provision ~5K WCU + rely on cache for reads",pick:true,note:"chosen — pure point-lookup KV, <code>conditional writes</code> give strong uniqueness for custom aliases, TTL for expiry, and zero sharding ops."},
    ],
    indexing:"Primary key = <code>short_key</code>, <strong>hash-partitioned</strong>, so every read and write resolves to exactly one partition in O(1) — no secondary index needed for the core path. A reverse index on <code>hash(long_url)</code> (for dedupe) would <em>double</em> write cost and risk a hot partition, so skip it unless dedupe is a hard requirement. Expiry is a <code>TTL</code> attribute the store reclaims lazily — never a scan. Because consecutive counter-derived keys hash to different partitions, writes spread evenly (no monotonic-key hotspot).",
    decision:"Pick a <strong>hash-partitioned KV / wide-column store</strong> (DynamoDB managed, or Cassandra self-hosted). The workload is a single-key point lookup with no joins needing horizontal write-scale and ~270TB — exactly what KV stores are built for, and exactly where a relational primary (~5-10K writes/s, manual sharding) struggles. The store is sized by <strong>storage (~135 nodes)</strong>, not read QPS, because the cache + replicas absorb the read fan-out. The one spot needing strong consistency — custom-alias uniqueness — is covered by DynamoDB conditional writes / a Cassandra LWT, not by adopting a relational DB wholesale.",
  },
  schema:{tables:[
    {name:"urls",pk:"short_key",columns:[
      ["short_key","varchar(11)","base62 key, primary key"],
      ["long_url","text","destination URL"],
      ["user_id","bigint NULL","owner (null = anonymous)"],
      ["created_at","timestamptz","creation time"],
      ["expires_at","timestamptz NULL","null = never expires"],
      ["is_custom","boolean","true if user-chosen alias"],
    ],rows:[
      ["15ftgG","https://example.com/very/long/path?ref=x","42","2026-07-22 10:00:00","(null)","false"],
      ["my-sale","https://shop.example.com/summer-sale","7","2026-07-20 09:12:00","2026-08-01 00:00:00","true"],
      ["9kQ2aZ","https://docs.example.com/guide","(null)","2026-07-22 11:30:00","(null)","false"],
    ]},
    {name:"id_ranges",pk:"range_start",columns:[
      ["range_start","bigint","first id in the block"],
      ["range_end","bigint","last id in the block"],
      ["instance_id","varchar(64)","service instance that owns it"],
      ["assigned_at","timestamptz","when the block was leased"],
    ],rows:[
      ["1000000000","1000999999","svc-7f3a","2026-07-22 09:59:50"],
      ["1001000000","1001999999","svc-b12c","2026-07-22 10:01:14"],
    ]},
    {name:"click_events",pk:"event_id",columns:[
      ["event_id","uuid","dedup key"],
      ["short_key","varchar(11)","which link (indexed)"],
      ["ts","timestamptz","click time"],
      ["country","char(2)","geo from IP"],
      ["referrer","text","HTTP referrer"],
    ],rows:[
      ["a1b2…","15ftgG","2026-07-22 10:05:11","US","https://twitter.com/"],
      ["c3d4…","15ftgG","2026-07-22 10:05:12","IN","(direct)"],
    ]},
  ]},
  flows:[
    {id:"create",name:"Create URL (write)",steps:[
      {node:"client",text:"Client sends <code>POST /shorten {url}</code>."},
      {node:"lb",text:"Gateway terminates TLS, authenticates, <strong>rate-limits</strong> the create, routes to a service instance."},
      {node:"svc",text:"Service validates the URL and length."},
      {node:"key",requires:["key"],text:"Requests the next id from its local block (key-gen); base62-encodes it to <code>15ftgG</code>."},
      {node:"db",text:"Writes the row into <code>urls</code> (conditional insert if it's a custom alias)."},
      {node:"cache",requires:["cache"],text:"Warms the cache with <code>15ftgG → long_url</code> (best-effort)."},
      {node:"client",text:"Returns <code>https://sho.rt/15ftgG</code>."},
    ]},
    {id:"read",name:"Redirect (read)",steps:[
      {node:"client",text:"Browser issues <code>GET /15ftgG</code>."},
      {node:"lb",text:"Gateway routes the (anonymous) read — or an edge cache may answer it outright."},
      {node:"cache",requires:["cache"],text:"Checks Redis first — a <strong>hit</strong> (~95% of reads) returns the long URL immediately."},
      {node:"svc",text:"On a miss, the service looks the key up."},
      {node:"replica",requires:["replica"],text:"Reads from a <strong>read-replica</strong>, sparing the write primary; populates the cache."},
      {node:"db",text:"Fetches <code>long_url</code> from the datastore (source of truth)."},
      {node:"analytics",requires:["analytics"],text:"Fires a click event to the queue <strong>async</strong> — never blocks the redirect."},
      {node:"client",text:"Returns <code>302 Location: long_url</code>; browser follows it."},
    ]},
  ],
  requirements:{
    functional:[
      "Create a short URL from a long one, with optional custom alias and expiry",
      "Redirect a short link to its original long URL",
      "Basic per-link click analytics (counts, geo, referrer)",
    ],
    nonFunctional:[
      "Redirect p99 &lt; 100ms; read-heavy at ~100:1 read:write",
      "High availability — a dead redirect breaks a link on someone else's site",
      "Scale to billions of URLs (~180B mappings, ~90TB) with peak 3-5x spikes",
      "Keys are unique and not trivially guessable",
    ],
  },
  reqBuild:[
    {req:"Create a short URL (adds key generation)",reveal:["key"],turns:[
      {who:"intv",text:"Start with requirement one: a user sends <code>POST /shorten {url: https://example.com/very/long/path}</code> and wants a short link back. What's the minimal path?"},
      {who:"cand",text:"The <strong>client</strong> hits the <strong>LB + gateway</strong>, which routes to the stateless <strong>shortener service</strong>. The service validates the URL, obtains a <strong>unique key</strong>, persists <code>key → {longURL, userId, createdAt, expiry}</code> in the <strong>database</strong>, and returns <code>https://sho.rt/aX9bQ</code>. The one piece that isn't trivial is minting that key without collisions across many instances, so let me add a <strong>key-generation</strong> component. Concretely I take a unique 64-bit integer and <strong>base62</strong>-encode it.<span class='eg'>1000000007 base62 ≈ \"15ftgG\" (6 chars); 62^7 ≈ 3.5 trillion keys</span>"},
      {who:"intv",text:"Why break key generation into its own box instead of a simple auto-increment column on the DB?"},
      {who:"cand",text:"A single auto-increment row becomes a lock-contention hotspot and a single point of failure — every create across every instance serializes on it. Isolating key-gen lets me hand each service instance a <em>block</em> of IDs to burn locally, or mint Snowflake-style IDs with no coordination at all. The real design work (avoiding a central bottleneck) deserves its own component, so I'll draw it now and drill into the allocation scheme later."},
      {who:"intv",text:"Why base62 of an integer rather than a UUID or a hash of the long URL?"},
      {who:"cand",text:"A UUID is 36 chars — far too long for a <em>short</em> URL, and its entropy is wasted here. Hashing the long URL invites collisions I'd have to detect and resolve, and it leaks nothing useful. Base62 of a compact integer is the sweet spot: short, URL-safe (no <code>+ / =</code> like base64), and collision-free by construction because the integer is already unique. That satisfies requirement one; next I'd make the redirect fast."},
    ],resources:[
      {title:"System Design Primer — generating unique IDs",url:"https://github.com/donnemartin/system-design-primer#use-good-indices"},
      {title:"Instagram Engineering: sharding & IDs",url:"https://instagram-engineering.com/sharding-ids-at-instagram-1cf5a71e5a5c"},
    ]},
    {req:"Redirect to the long URL fast",turns:[
      {who:"intv",text:"Requirement two: someone clicks <code>sho.rt/aX9bQ</code>. Walk me through the redirect path with what you already have."},
      {who:"cand",text:"A <code>GET /aX9bQ</code> goes through the <strong>LB + gateway</strong> to the <strong>shortener service</strong>, which looks up the key in the <strong>database</strong> and returns an HTTP redirect to the long URL. No new component — my four core boxes cover it. The important property is that the mapping is <strong>immutable</strong>: <code>key → longURL</code> never changes once created, which makes this path trivial to make fast later."},
      {who:"intv",text:"Do you return a 301 or a 302, and does it matter?"},
      {who:"cand",text:"It's a real lever. A <strong>301</strong> is cacheable by browsers and CDNs, so after the first hit most clicks never reach me — great for latency. A <strong>302</strong> forces every click back to my origin — worse for load but necessary if I want to <em>count</em> every click. So the choice is coupled to whether analytics matters for that link; I'd default to 302 when counting is the product and 301 when raw redirect speed wins."},
      {who:"intv",text:"Reading the mapping straight from the DB on every redirect — does that hold up?"},
      {who:"cand",text:"For <em>correctness</em> it's fine — the DB is the source of truth. For <em>load</em> it won't hold up at ~116K reads/s, but I'll deliberately defer that: right now I'm satisfying the functional requirement with the simplest correct design, and I'll add a cache and read replicas in the deep-dive phase. Both requirements are now met with just the core; time to harden it under load and failure."},
    ],resources:[
      {title:"MDN: 301 vs 302 redirects",url:"https://developer.mozilla.org/en-US/docs/Web/HTTP/Redirections"},
      {title:"System Design Primer — application layer",url:"https://github.com/donnemartin/system-design-primer#application-layer"},
    ]},
  ],
  systemDives:[
    {title:"Reads are hammering the DB",tag:"scaling",reveal:["cache"],turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> you launch with just the service + DB. At <b>116K</b> redirects/s the DB's p99 read latency climbs to 300ms and CPU pegs at 95%. Redirects are timing out. The DB can't take it. What's your move?</span>"},
      {who:"cand",text:"Put a <strong>cache</strong> in front — Redis — and serve redirects from it. This is the highest-leverage change because the workload is read-dominated (100:1) and access is <em>heavily skewed</em>: a small set of links gets most clicks. A cache with a high hit ratio absorbs almost all reads, and the DB only sees misses plus writes. Let me add the cache.<span class='eg'>At a 95% hit ratio the DB read load drops from 116K/s to ~5.8K/s — comfortably within one shard</span>"},
      {who:"intv",text:"Cache added. What's the read path now, and what happens on a miss?"},
      {who:"cand",text:"Read-through: check cache; on hit, redirect immediately; on miss, read the DB, populate the cache, then redirect. Because mappings are <strong>immutable</strong>, cached entries never go stale — I use long TTLs and need no invalidation logic. Eviction is <strong>LRU</strong>, which matches the skewed access: hot links stay resident, cold links fall out. Writes warm the cache best-effort, but the DB is always the source of truth."},
      {who:"intv",text:"Suppose that cache node restarts and comes back empty mid-day. Now what?"},
      {who:"cand",text:"That's a <strong>cold-cache thundering herd</strong> — the DB instantly sees 100% of reads instead of ~5%. I contain it with <strong>request coalescing / single-flight</strong> so only one miss per key hits the DB while concurrent requests share the result, <strong>jittered TTLs</strong> so entries don't all expire together, and a <strong>replicated Redis cluster</strong> so a single node restart fails over to a replica that still holds the data rather than emptying the tier. Pre-warming the top-N hottest keys on cold start blunts recovery further."},
    ],resources:[
      {title:"System Design Primer — caching",url:"https://github.com/donnemartin/system-design-primer#cache"},
      {title:"Redis: eviction policies",url:"https://redis.io/docs/latest/operate/oss_and_stack/management/config/"},
    ]},
    {title:"A DB shard dies — is data lost?",tag:"durability",reveal:["replica"],turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> the single node holding shard 7 has a disk failure and won't come back. That shard held ~<b>22B</b> mappings. Are those links gone forever? Walk me through your durability story.</span>"},
      {who:"cand",text:"If shard 7 were a single node, yes — catastrophic, and unacceptable for links that live on other people's sites. The fix is <strong>replication</strong>: every shard is a replica group of, say, 3 nodes across failure domains (AZs), with writes acknowledged by a <strong>quorum</strong> before I return success. Let me add DB replicas. A disk failure on one replica loses nothing — the other two hold the data and a fresh replica rebuilds from them."},
      {who:"intv",text:"Quorum writes add latency to every create. And do you read from replicas too?"},
      {who:"cand",text:"Create latency isn't on the hot path — reads are — so a quorum write of a few ms is fine, and durability here is non-negotiable. For reads, yes: replicas serve them too, which multiplies read capacity. Because mappings are <strong>immutable</strong>, reading a slightly-behind replica is safe — the only staleness is not-yet-knowing a brand-new key, which I handle by falling back to the primary or the cache on a miss. One mechanism buys me both durability and read scaling."},
      {who:"intv",text:"The primary for that shard later crashes and you promote a replica. Two minutes on, the old primary rejoins still thinking it's primary. What happens?"},
      {who:"cand",text:"That's <strong>split-brain</strong>, and for writes it means divergent data on the same key — corruption. Promotion must go through <strong>consensus / leader election</strong> (Raft/Paxos or a fencing coordinator) that grants a monotonically increasing <strong>epoch</strong>. The new primary writes under a higher epoch; when the stale old primary rejoins, replicas <strong>reject its writes via the fencing token</strong> and it demotes and re-syncs. There is never a window where two nodes hold the current epoch, so a mapping is never written by two authorities."},
    ],resources:[
      {title:"System Design Primer — replication",url:"https://github.com/donnemartin/system-design-primer#replication"},
      {title:"Dynamo paper — replication & quorum",url:"https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf"},
    ]},
    {title:"Track clicks without slowing redirects",tag:"scaling",reveal:["analytics"],turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> product wants click counts, geo, and referrer per link, but you promised redirect p99 &lt; 100ms. A marketing blast then drives <b>500K</b> clicks/s for an hour. How do you count without slowing redirects or falling hours behind?</span>"},
      {who:"cand",text:"Analytics goes <strong>off the critical path</strong>. On redirect I fire a click event to a <strong>message queue</strong> (Kafka) and return the redirect immediately — it never waits on an analytics write. Let me add an async analytics path. Kafka happily absorbs 500K/s and buffers the spike; stream consumers do <strong>windowed aggregation</strong> — per-key counts in 1-minute tumbling windows — and write <em>aggregates</em>, not raw rows, to an OLAP store. That's a huge reduction in write volume, and the dashboard reads pre-rolled counts."},
      {who:"intv",text:"Does the 301-vs-302 choice affect your counts?"},
      {who:"cand",text:"Hugely. A <strong>301</strong> is cached by browsers and CDNs, so after the first hit most clicks never reach me — I'd systematically undercount. A <strong>302</strong> forces every click back to me — accurate counts at higher load. If analytics is the product I default to 302 and lean on the cache/edge to absorb the extra origin traffic; where raw redirect speed matters more, 301. It's a per-link lever, not a global switch."},
      {who:"intv",text:"The redirect path emits to Kafka. If Kafka is briefly unavailable, does that stall redirects?"},
      {who:"cand",text:"It must not — analytics is best-effort. The producer is <strong>async, fire-and-forget with a bounded local buffer</strong>: if Kafka is slow or unreachable, events queue in-memory up to a cap and then I <em>drop</em> them (or spill to a local log) rather than block the redirect. Losing a slice of analytics during a blip is acceptable; adding latency to a billion redirects is not. The goal is approximate, timely counts — not exact ones."},
    ],resources:[
      {title:"Apache Kafka documentation",url:"https://kafka.apache.org/documentation/"},
      {title:"System Design Primer — async & message queues",url:"https://github.com/donnemartin/system-design-primer#asynchronism"},
    ]},
    {title:"A viral link and a global audience",tag:"scaling",turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a link in a tweet goes viral. Redirect traffic jumps from 116K/s to <b>1.2M/s</b> in under a minute, heavily skewed to that one key, and your users are global. What falls over first, and how do you keep p99 &lt; 100ms for a user in Sydney when your origin is in Virginia?</span>"},
      {who:"cand",text:"First to feel it is the app fleet if redirects reach it, then the shard holding that key — but this is the <em>easy</em> kind of load: one immutable key read a million times. The defense is layered. The <strong>CDN / edge</strong> absorbs the vast majority since that key is now hot and cached with a long TTL, collapsing 1.2M/s into a handful of origin fetches. For Sydney I go <strong>multi-region with GeoDNS / anycast</strong> so users resolve to the nearest edge, and I replicate mappings to each region. Because mappings are immutable, replication lag is harmless for reads — Sydney serves locally and never round-trips to Virginia."},
      {who:"intv",text:"Now the whole Virginia region goes dark — 40% of traffic was homed there. What do users see?"},
      {who:"cand",text:"Without preparation, 40% of redirects time out — broken links across the web. To make it a non-event I rely on <strong>DNS health checks</strong>: the GeoDNS/anycast layer detects the region failing checks and stops resolving users to it, steering them to the next-nearest healthy region within the health-check interval. Because reads are served from <em>replicated, immutable</em> data everywhere, the surviving regions serve those redirects with no data loss — a capacity event, not a correctness one."},
      {who:"intv",text:"That region was also your write primary. Creates are now failing. Acceptable?"},
      {who:"cand",text:"More acceptable than broken redirects, but I'd avoid it by making writes <strong>region-independent</strong> from the start — each region mints globally-unique keys locally (Snowflake-style or per-region ID ranges), so any surviving region accepts creates with zero coordination. That turns a region loss into a pure capacity event rather than a write outage. The cost is slightly longer keys, which I'll happily trade for multi-region write availability."},
    ],resources:[
      {title:"Cloudflare: how anycast works",url:"https://www.cloudflare.com/learning/cdn/glossary/anycast-network/"},
      {title:"System Design Primer — availability patterns",url:"https://github.com/donnemartin/system-design-primer#availability-patterns"},
    ]},
  ],
  q:{
    lb:[
      {l:"medium",tag:"concept",q:"LB vs gateway — what really lives at the edge?",turns:[
        {who:"intv",text:"You drew 'LB + gateway' as one box. A <code>POST /shorten</code> and a <code>GET /aX9bQ</code> both arrive here — walk me through what happens to each, and be precise about LB vs gateway."},
        {who:"cand",text:"The <strong>load balancer</strong> is L4/L7 distribution across healthy instances with health-check ejection. The <strong>gateway</strong> owns cross-cutting concerns: TLS, auth/API keys, validation, and <strong>rate limiting</strong>.<br><br><code>POST /shorten</code> is authenticated + rate-limited (creation is expensive, abuse-prone) then routed to the create path. <code>GET /aX9bQ</code> is anonymous and cache-friendly — I want it as cheap as possible, ideally answered before it even reaches an app server."},
        {who:"intv",text:"Why so eager to keep redirects off the app fleet?"},
        {who:"cand",text:"At 116K reads/s sustained I'd be paying a full request lifecycle — TLS, auth middleware, a lookup RPC — for what is a lookup of an <em>immutable</em> mapping. Since <code>key → longURL</code> never changes, it's ideal to cache at the <strong>CDN/edge</strong> with a long TTL and only fall through to the service on a miss. That decouples the hottest path from my origin's health."},
      ],resources:[
        {title:"System Design Primer — CDN & load balancing",url:"https://github.com/donnemartin/system-design-primer#content-delivery-network"},
        {title:"Cloudflare: how anycast works",url:"https://www.cloudflare.com/learning/cdn/glossary/anycast-network/"},
      ]},
      {l:"hard",tag:"scaling",q:"Traffic spikes 10x from a viral link — does the edge hold?",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a link in a tweet goes viral. Redirect traffic jumps from 116K/s to <b>1.2M/s</b> in under a minute, heavily skewed to that one key. Your LB tier and app fleet were sized for normal load. What falls over first, and what do you do?</span>"},
        {who:"cand",text:"First to feel it is the <strong>app fleet</strong> if redirects reach it, then the DB shard holding that key. But this traffic is the <em>easy</em> kind — it's one immutable key read a million times. My defense is layered: <strong>(1)</strong> the CDN/edge absorbs the vast majority since that key is now hot and cached with a long TTL — 1.2M/s for one key collapses to a handful of origin fetches. <strong>(2)</strong> the app fleet autoscales on request rate, but honestly shouldn't need to if the edge is doing its job. <strong>(3)</strong> the LB is horizontally redundant and connection-based, so it scales by adding nodes."},
        {who:"intv",text:"The CDN is regional and your users are global. How do you keep p99 < 100ms in Sydney when your origin is in Virginia?"},
        {who:"cand",text:"Multi-region with <strong>GeoDNS/anycast</strong> so users resolve to the nearest edge, and replicate the mapping to each region. Because mappings are immutable, replication lag is harmless for reads — a region only ever lags in learning about a <em>brand-new</em> key, which resolves in seconds. So Sydney serves from a Sydney edge/replica; it never round-trips to Virginia for a redirect. Writes are the only asymmetry and I handle those separately with region-independent key generation."},
      ],resources:[
        {title:"System Design Primer — scaling & CDNs",url:"https://github.com/donnemartin/system-design-primer#content-delivery-network"},
        {title:"Cache stampede — patterns & mitigations",url:"https://en.wikipedia.org/wiki/Cache_stampede"},
      ]},
      {l:"hard",tag:"failover",q:"An entire region goes dark — what do users see?",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> your primary region (us-east-1) has a full network partition — the LB, app fleet, and DB there are all unreachable. 40% of your global redirect traffic was homed there. What do users experience in the first 30 seconds, and how do you make it a non-event?</span>"},
        {who:"cand",text:"Without preparation: 40% of redirects time out — broken links across the web, the worst outcome for us. To make it a non-event I rely on <strong>DNS health checks</strong>: the GeoDNS/anycast layer detects us-east-1 is failing checks and stops resolving users to it, steering them to the next-nearest healthy region within the health-check interval (tunable to ~10-30s). Because reads are served from <em>replicated, immutable</em> data in every region, the other regions can serve those redirects with no data loss."},
        {who:"intv",text:"Reads are covered. But us-east-1 was your write primary. Creates are now failing. Acceptable?"},
        {who:"cand",text:"More acceptable than broken redirects, but I'd still avoid it. Two options: <strong>(a)</strong> promote a secondary region to write-primary (needs a controlled failover of the write path), or better <strong>(b)</strong> design writes to be <em>region-independent</em> from the start — each region mints globally-unique keys locally (Snowflake-style or per-region ID ranges), so any surviving region can accept creates with zero coordination. I'd pick (b): it turns a region loss into a pure capacity event, not a correctness event. The cost is slightly longer keys, which I'll trade for multi-region write availability."},
      ],resources:[
        {title:"System Design Primer — availability patterns",url:"https://github.com/donnemartin/system-design-primer#availability-patterns"},
        {title:"Instagram Engineering: sharding & IDs",url:"https://instagram-engineering.com/sharding-ids-at-instagram-1cf5a71e5a5c"},
      ]},
      {l:"medium",tag:"capacity",q:"How many LB/gateway nodes, and what bounds them?",turns:[
        {who:"intv",text:"Size the edge tier. Reads run ~116K/s, peak 3-5x. How many LB/gateway nodes do you run, and is the limit connections or bandwidth? Show the math."},
        {who:"cand",text:"The redirect response is tiny, so I expect connections to bind before bandwidth — let me check both.<span class='eg'>Peak &approx; 116K &times; 4 &approx; 464K req/s. A 302 response is ~500 bytes &rarr; 464K &times; 500B &approx; 230 MB/s &approx; 1.9 Gbps of egress, trivial for an edge tier. Connections: at ~50K req/s per L7 node &rarr; 464K &divide; 50K &approx; 10 nodes; add headroom and spread across 3 AZs &rarr; ~15 nodes.</span>So it is request/connection handling, not bandwidth, that sets the node count."},
        {who:"intv",text:"So connections bound you. What assumption in that math is fragile?"},
        {who:"cand",text:"The ~50K req/s per node assumes connection reuse. The real cost is the <strong>TLS handshake rate</strong> — if clients open a fresh connection per redirect (common, since a redirect is one-shot), CPU spent on handshakes dominates and per-node throughput collapses well below 50K. The trade-off: terminate TLS at the LB with session resumption and keep-alive to amortise handshakes, versus pushing redirects to the <strong>CDN/edge</strong> so most never reach my LB at all. I'd size the tier on new-connection rate with generous headroom and lean on the edge to shave the bulk of it, rather than trust a steady-state req/s number."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"System Design Primer — CDN & load balancing",url:"https://github.com/donnemartin/system-design-primer#content-delivery-network"},
      ]},
    ],
    svc:[
      {l:"medium",tag:"capacity",q:"How many service instances do you actually need?",turns:[
        {who:"intv",text:"Concrete numbers now. You quoted ~116K reads/s and ~1,160 writes/s, peak 3-5x. How many <strong>shortener-service instances</strong> do you run? Show me the math, don't just say 'autoscale'."},
        {who:"cand",text:"Let me size it from a per-instance throughput budget. The service is stateless and CPU-light — validate, a cache/DB lookup, serialize — so a modern 4-core instance handles maybe <strong>~5,000 req/s</strong> comfortably at low latency (I'd confirm with a load test; this is the estimate).<span class='eg'>Peak reads ≈ 116K × 4 ≈ 464K req/s. 464K ÷ 5K ≈ 93 instances. Add ~30% headroom → ~120. Writes are ~5K/s peak → ~1-2 instances, negligible. So call it ~120 read-serving instances at peak.</span>Round up and spread across ≥3 AZs so losing an AZ drops ~1/3 of capacity, not the service."},
        {who:"intv",text:"120 feels like a lot for what's basically a cache lookup. What would cut it?"},
        {who:"cand",text:"The number is dominated by the assumption that every read hits the service. It shouldn't — with the <strong>CDN/edge</strong> serving hot redirects and a high cache-hit ratio, most reads never reach the fleet, so the origin might need <em>10-20</em> instances, not 120. That's the real lever: the instance count is a function of cache-hit ratio, so I'd quote the range and say 'the honest answer is single-digit-to-low-tens once the edge is doing its job; I size the fleet to survive a cold cache, then let it scale down.' The trade-off is provisioning for the worst case (cost) vs autoscaling lag (risk during a cache flush) — I'd keep a warm floor of ~20 and autoscale above it."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"Latency numbers every programmer should know",url:"https://github.com/donnemartin/system-design-primer#latency-numbers-every-programmer-should-know"},
      ]},
      {l:"easy",tag:"concept",q:"Walk me through a create request end to end.",turns:[
        {who:"intv",text:"Take me through exactly what the service does on <code>POST /shorten {url: https://example.com/very/long/path}</code>. Every step."},
        {who:"cand",text:"<ul><li><strong>Validate</strong> — well-formed, http/https, length bound.</li><li><strong>Get a unique key</strong> from key-gen, say <code>aX9bQ</code>.</li><li><strong>Persist</strong> <code>aX9bQ → {longURL, userId, createdAt, expiry}</code> to the KV store.</li><li><strong>Warm the cache</strong> (best-effort).</li><li><strong>Return</strong> <code>https://sho.rt/aX9bQ</code>.</li></ul>The handler is thin and <strong>stateless</strong> — all durable state is in the DB, so any instance serves any request."},
        {who:"intv",text:"You persist and <em>then</em> warm the cache. Crash in between — problem?"},
        {who:"cand",text:"No, and the ordering is deliberate: <strong>DB first, cache best-effort</strong>. A crash after commit just means the first redirect is a cache miss that reads the DB and populates it (read-through). The dangerous ordering is the reverse — cache-first — where a crash leaves a link that resolves until the entry evicts and then vanishes. DB is always source of truth."},
      ],resources:[{title:"System Design Primer — application layer",url:"https://github.com/donnemartin/system-design-primer#application-layer"}]},
      {l:"easy",tag:"concept",q:"How is the short key generated? (adds key-gen)",reveal:["key"],turns:[
        {who:"intv",text:"The core trick is the key. Given a unique 64-bit integer <code>1000000007</code>, how do you get <code>aX9bQ</code>, and how long is it?"},
        {who:"cand",text:"<strong>Base62-encode</strong> it — <code>0-9 a-z A-Z</code>.<span class='eg'>1000000007 → base62 ≈ \"15ftgG\" (6 chars). 62^7 ≈ 3.5 trillion.</span>~7 base62 chars covers hundreds of billions of URLs, stays short and URL-safe (no <code>+ / =</code> like base64). Let me add a <strong>key-generation</strong> component — the real work is minting the unique integer without a bottleneck, which deserves its own box."},
        {who:"intv",text:"Fair — we'll drill into key-gen separately. Quick: why not a UUID?"},
        {who:"cand",text:"A UUID is 36 chars — far too long for a 'short' URL, and its entropy is wasted here. Base62 of a compact integer is the sweet spot: short, clean, URL-safe."},
      ],resources:[{title:"System Design Primer — generating unique IDs",url:"https://github.com/donnemartin/system-design-primer#use-good-indices"}]},
      {l:"medium",tag:"scaling",q:"Reads are hammering the DB — fix it (adds cache).",reveal:["cache"],turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> you launch with just service + DB. At 116K redirects/s, your DB's p99 read latency climbs to 300ms and CPU pegs at 95%. Redirects are timing out. The DB can't take it. What's your move?</span>"},
        {who:"cand",text:"Put a <strong>cache</strong> in front — Redis — and serve redirects from it. This is the highest-leverage change because the workload is read-dominated (100:1) and access is <em>heavily skewed</em>: a small set of links gets most clicks. So a cache with a high hit ratio absorbs almost all reads, and the DB only sees misses + writes. Let me add the cache to the design.<span class='eg'>If 95% of reads hit cache, the DB read load drops from 116K/s to ~5.8K/s — well within a single shard's comfort zone.</span>"},
        {who:"intv",text:"Cache added. What's the read path now, and what happens on a miss?"},
        {who:"cand",text:"Read-through: check cache; on hit, redirect immediately; on miss, read DB, populate cache, then redirect. Since mappings are <strong>immutable</strong>, cached entries never go stale — long TTLs, no invalidation logic. Eviction is <strong>LRU</strong>, which matches the skewed access: hot links stay resident, cold links fall out. We should dig into what happens when the cache itself fails — that's where it gets interesting."},
      ],resources:[
        {title:"System Design Primer — caching",url:"https://github.com/donnemartin/system-design-primer#cache"},
        {title:"Redis: eviction policies",url:"https://redis.io/docs/latest/operate/oss_and_stack/management/config/"},
      ]},
      {l:"medium",tag:"failover",q:"A service instance dies mid-request — any data loss?",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a deploy is rolling and one service pod gets SIGKILLed while it's handling 200 in-flight create requests. What happens to those 200 users?</span>"},
        {who:"cand",text:"Two buckets. Requests that had <strong>already committed to the DB</strong> before the kill are safe — the mapping is durable even if the pod never returned the response; the client sees a dropped connection and retries, and the link exists. Requests killed <em>before</em> commit simply didn't happen — the client retries and gets a fresh key. Because the service is <strong>stateless</strong> and creates are effectively idempotent-on-retry, a pod death is a client retry, not data loss."},
        {who:"intv",text:"On retry the client might get a <em>different</em> key than a create that actually did commit — so one long URL now has two short keys. Bug?"},
        {who:"cand",text:"Not a correctness bug — both keys resolve to the same URL, which is harmless (I don't dedupe by default anyway). It's mild key-space waste, negligible against 3.5 trillion. If a client needs exactly-once creation, it sends a <strong>client-generated idempotency key</strong>; the service dedupes on it so a retry returns the same short key. I'd offer that on the API but not force it — for a shortener the duplicate-key cost isn't worth making every write do an extra idempotency lookup."},
      ],resources:[{title:"Idempotency keys (Stripe pattern)",url:"https://stripe.com/blog/idempotency"}]},
      {l:"medium",tag:"concept",q:"Track clicks without slowing redirects (adds analytics).",reveal:["analytics"],turns:[
        {who:"intv",text:"Product wants click counts, geo, and referrer per link — but you promised p99 < 100ms on redirects. Reconcile that."},
        {who:"cand",text:"Analytics goes <strong>off the critical path</strong>. On redirect I fire a click event to a <strong>message queue</strong> (Kafka) and return the 301/302 immediately — the redirect never waits on the analytics write. Let me add an async analytics path. Consumers aggregate events into an OLAP store; the dashboard reads pre-rolled counts, never raw events."},
        {who:"intv",text:"301 vs 302 for the redirect — does it matter for analytics?"},
        {who:"cand",text:"Hugely. <strong>301</strong> is cacheable by browsers/CDNs, so after the first hit most clicks never reach me — great for latency, terrible for counting. <strong>302</strong> forces every click back to me — accurate counts, higher load. If analytics is the product I default to <strong>302</strong> (I've built the read path to absorb it); where raw redirect speed matters more I use 301. It's a per-link lever, not a fixed choice."},
      ],resources:[
        {title:"MDN: 301 vs 302 redirects",url:"https://developer.mozilla.org/en-US/docs/Web/HTTP/Redirections"},
        {title:"Apache Kafka documentation",url:"https://kafka.apache.org/documentation/"},
      ]},
    ],
    db:[
      {l:"medium",tag:"capacity",q:"How many DB shards / nodes, and how much storage?",turns:[
        {who:"intv",text:"Size the datastore. You said ~180B mappings at ~500 bytes. How much storage, and how many shards/nodes do you provision?"},
        {who:"cand",text:"Storage first, then throughput — they give different answers and I take the max.<span class='eg'>Storage: 180B × 500B ≈ 90 TB raw. With replication factor 3 → ~270 TB. At ~2 TB usable/node → ~135 nodes for space alone.<br>Throughput: peak writes ~5K/s, peak reads (cold cache) ~464K/s. A wide-column node does ~10-20K ops/s → reads would want ~25-45 nodes, but the cache absorbs almost all reads, so steady-state the DB sees far less.</span>Storage dominates here, so I'd provision on the order of <strong>~135 nodes</strong> (say 150 with headroom), which comfortably covers throughput too."},
        {who:"intv",text:"That's sized for 5 years of data sitting hot forever. Wasteful?"},
        {who:"cand",text:"Yes, and I'd push back on keeping everything hot. Most links are cold within days of creation, so I'd <strong>tier</strong>: recent/active mappings on the fast cluster, and age out old-but-not-expired links to cheaper cold storage, with a slower lookup path for the rare cold hit. That could cut the hot cluster several-fold. The trade-off is added complexity and a latency cliff for cold links — acceptable because cold links are, by definition, rarely clicked. I'd also let TTL/expiry reclaim space automatically so the 90 TB is an over-estimate in practice."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"Amazon Dynamo paper (partitioning)",url:"https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf"},
      ]},
      {l:"hard",tag:"concept",q:"Which datastore? SQL vs NoSQL, defended with the node math.",turns:[
        {who:"intv",text:"Treat this like a datastore-selection doc you have to sign off on. We are at ~1,160 writes/s, up to ~116K reads/s on a cold cache, ~180B rows, ~90TB. Pick the store and defend it with numbers, not vibes."},
        {who:"cand",text:"First I write down exactly what the store must serve, because the numbers pick the database. <strong>Writes:</strong> ~1,160 creates/s steady, ~5K/s at peak. <strong>Reads:</strong> ~116K/s if the cache is cold, up to ~464K/s at peak; steady-state the cache absorbs ~95% so the durable store sees ~5-6K reads/s, but it must survive the cold-cache spike. <strong>Storage:</strong> ~180B rows &times; ~500B &approx; 90TB raw, &times;3 for replication &approx; 270TB. <strong>Access pattern:</strong> single-row point lookup by primary key, no joins, no scans, write-once-read-many. Massive storage, huge read fan-out, trivial writes, key-only access — that shape is what I select against."},
        {who:"intv",text:"Good. Now run your candidates and show me the per-node ceiling and node count for each."},
        {who:"cand",text:"<strong>Postgres (single primary):</strong> a primary does ballpark ~5-10K writes/s and a few thousand point reads/s before vertical limits bite, and one box tops out at a handful of TB.<span class='eg'>90TB &divide; ~5TB/node &approx; 18 manual shards for space alone; 464K reads &divide; ~8K reads/node &approx; ~58 read replicas. Writes fit one primary, but I hand-shard ~18 ways and bolt on replication myself.</span><strong>Cassandra (wide-column):</strong> ballpark ~10-50K writes/s per node, linear scale-out.<span class='eg'>Writes: 5K &divide; ~20K/node &approx; 1 node's worth. Reads: 464K &divide; ~15K/node &approx; ~31 nodes. Storage RF3: 270TB &divide; ~2TB usable/node &approx; ~135 nodes.</span>Storage dominates &rarr; ~135 nodes. <strong>DynamoDB (managed):</strong> throughput is provisioned, ballpark ~1K WCU per partition, and it auto-partitions on both throughput and size.<span class='eg'>Writes: 5K &divide; ~1K WCU &approx; ~5 partitions; 90TB just means more partitions, all managed.</span>No node count I run myself — I provision capacity, AWS shards it."},
        {who:"intv",text:"Talk to me about indexing. What do you index, and what does it cost?"},
        {who:"cand",text:"The only hot access is a point lookup by <code>short_key</code>, so the <strong>primary-key index is the whole game</strong>. I want the PK <strong>hash-partitioned</strong> on <code>short_key</code> so a lookup hashes straight to the owning partition — O(1), one node, no scatter-gather — and writes spread uniformly instead of hotspotting a range.<span class='eg'>Range-partitioning a counter-derived key sends every new write to the last shard: 0-1B on shard1, 1B-2B on shard2 &rarr; all creates hit the newest shard. Hashing scatters them across all shards.</span>I deliberately keep it to that one index. A <strong>secondary index on <code>long_url</code></strong> (reverse lookup, do-I-already-have-this-URL) is the tempting add, but on a 180B-row write-once store it costs <strong>write amplification</strong>: every create writes two structures, and on Cassandra/Dynamo a global secondary index is itself a full replicated table with its own storage and throughput. I do not dedupe by default, so I do not pay for it — no secondary index. Analytics fields (geo, referrer) live in the separate <code>click_events</code> store and are indexed there, not on the hot mapping table."},
        {who:"intv",text:"So sign the decision. Which one, and explicitly why not the others?"},
        {who:"cand",text:"<strong>Decision: a hash-partitioned wide-column / KV store — DynamoDB if we are on AWS, Cassandra if we want to self-host or stay cloud-portable.</strong> Why: the access pattern is pure key point-lookup, write-once-read-many, so I need horizontal storage to ~270TB and read fan-out to ~464K/s — both come from adding nodes, and the hash PK gives single-partition lookups. <strong>Not Postgres:</strong> 1,160 writes/s fits a single primary trivially, but 90TB and 464K cold reads force me to hand-shard ~18 ways and stack ~50+ replicas — rebuilding a distributed KV store on a relational engine whose joins and secondary indexes I never use. <strong>Not Cassandra over Dynamo</strong> when on AWS: both scale linearly and both give conditional writes for alias uniqueness, but Dynamo removes the ~135-node ops burden; I flip that only if portability or cost-at-sustained-scale outweighs ops. The deciding factor is the access pattern plus node math, not a feature checklist."},
      ],resources:[
        {title:"Amazon Dynamo paper",url:"https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf"},
        {title:"Consistent hashing explained",url:"https://www.toptal.com/big-data/consistent-hashing"},
        {title:"Cassandra: data modeling & partitions",url:"https://cassandra.apache.org/doc/latest/cassandra/data_modeling/index.html"},
      ]},
      {l:"hard",tag:"durability",q:"The DB node holding a shard dies — is data lost? (adds replicas)",reveal:["replica"],turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> the single node holding shard 7 has a disk failure and won't come back. That shard held ~22B mappings. Are those links gone forever? Walk me through your durability story.</span>"},
        {who:"cand",text:"If shard 7 were a single node, yes — catastrophic, and unacceptable for links that live on other people's sites. The fix is <strong>replication</strong>: every shard is a replica group of, say, 3 nodes across failure domains (AZs), with writes acknowledged by a quorum before I return success. Let me add DB replicas. A disk failure on one replica loses nothing — the other two have the data, and a new replica rebuilds from them."},
        {who:"intv",text:"Quorum writes add latency to every create. And do you read from replicas too?"},
        {who:"cand",text:"Create latency isn't on the hot path (reads are), so a quorum write of a few ms is fine — and durability is non-negotiable here. For reads, yes: replicas serve reads too, which multiplies read capacity. Because mappings are immutable, reading a slightly-behind replica is safe — the only staleness is 'hasn't seen a brand-new key yet,' handled by falling back to the primary or the cache on a miss. So replicas buy me both <strong>durability</strong> and <strong>read scaling</strong> from one mechanism."},
      ],resources:[
        {title:"System Design Primer — replication",url:"https://github.com/donnemartin/system-design-primer#replication"},
        {title:"Dynamo paper — replication & quorum",url:"https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf"},
      ]},
      {l:"hard",tag:"concept",q:"Is eventual consistency safe here? Where do you need strong?",turns:[
        {who:"intv",text:"You're replicating for reads. That's usually eventual consistency. Safe for a URL shortener? Anywhere you need stronger?"},
        {who:"cand",text:"For <strong>reads</strong>, eventual consistency is ideal — a mapping is immutable, so a replica's only possible staleness is not-yet-knowing a brand-new key, resolved in seconds (or by cache/primary fallback). The place I want <strong>strong consistency</strong> is <em>create</em>, specifically <strong>custom aliases</strong>: two users must not both claim <code>sho.rt/sale</code>."},
        {who:"intv",text:"So how do you get strong uniqueness on writes but cheap eventual reads in one system?"},
        {who:"cand",text:"They act on different operations, so no conflict. DynamoDB gives <strong>conditional writes</strong> (<code>attribute_not_exists(key)</code>) that are strongly consistent for that one item — perfect for alias claims and as a safety net for generated keys. Reads use cheap eventually-consistent replica reads. Writes pay a small strong-consistency cost on a single key; reads — 99% of traffic — stay cheap and local. Standard 'strong-on-write, eventual-on-read' that works precisely because data is write-once."},
      ],resources:[
        {title:"CAP theorem",url:"https://en.wikipedia.org/wiki/CAP_theorem"},
        {title:"DynamoDB: read consistency & conditional writes",url:"https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.ReadConsistency.html"},
      ]},
    ],
    cache:[
      {l:"hard",tag:"failover",q:"Redis OOMs at 3am and flushes everything — what now?",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> 3am, a bad key pattern balloons memory, Redis hits maxmemory and — worse — the node restarts and comes back <b>empty</b>. Suddenly 100% of your 116K reads/s are cache misses hitting the DB simultaneously. Describe the blast and contain it.</span>"},
        {who:"cand",text:"That's a <strong>cold-cache thundering herd</strong>: the DB, which normally sees ~5% of reads, instantly sees 100% — a 20x spike that can topple it, cascading into the redirects the cache was protecting. Containment: <strong>(1) request coalescing / single-flight</strong> so only one miss per key hits the DB and concurrent requests share the result. <strong>(2)</strong> the DB replica group can serve reads, spreading the surge. <strong>(3)</strong> a warmed/replicated cache: run Redis as a replicated cluster so a single node restart doesn't empty the whole tier — failover to a replica that still has the data."},
        {who:"intv",text:"Even with coalescing, re-warming from cold means the DB carries elevated load for a while. Anything to blunt the recovery?"},
        {who:"cand",text:"Yes: <strong>jittered TTLs</strong> so entries don't all expire together and re-stampede; <strong>negative caching</strong> so the bad-key pattern that started it can't repeat; and <strong>proactive pre-warming</strong> of the top-N hottest keys on cold start from an offline list, since those account for most traffic. I'd also cap the blast at the source with the memory policy that caused it — set <code>maxmemory-policy</code> to LRU eviction (not restart-inducing behavior) so it sheds cold keys gracefully instead of falling over."},
      ],resources:[
        {title:"Cache stampede — mitigations",url:"https://en.wikipedia.org/wiki/Cache_stampede"},
        {title:"Redis: high availability & replication",url:"https://redis.io/docs/latest/operate/oss_and_stack/management/replication/"},
      ]},
      {l:"hard",tag:"scaling",q:"One key is 60% of cache traffic — hot-key meltdown.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a single viral link is now 60% of all reads. In a sharded Redis cluster that key lives on <b>one</b> node, which is at 100% CPU while the others idle. The hot node is the bottleneck. Fix the imbalance.</span>"},
        {who:"cand",text:"Classic <strong>hot-key</strong> problem — consistent hashing balances <em>keys</em>, not <em>load per key</em>, so one scorching key pins one node. Fixes: <strong>(1) key replication/fan-out</strong> — store the hot key on multiple nodes (e.g. suffix it <code>key#1..#N</code>) and have clients read a random replica, spreading load N-ways. <strong>(2) client-side / local caching</strong> — app instances cache the hottest keys in-process for a few seconds, so most reads never reach Redis at all. For an immutable mapping, a short local TTL is completely safe."},
        {who:"intv",text:"How do you even know a key is hot in time to act?"},
        {who:"cand",text:"Detection: track per-key request rates with a lightweight <strong>approximate top-K / count-min sketch</strong> at the app or proxy tier — cheap, and it flags a key crossing a threshold within seconds. Then promotion is automatic: flip hot keys into the local-cache tier and/or replicate them. The immutability of the data makes this trivial — no coherence concerns, I just need more copies. This is the same top-K machinery you'd build for 'trending links' anyway."},
      ],resources:[
        {title:"Count-min sketch (heavy hitters)",url:"https://en.wikipedia.org/wiki/Count%E2%80%93min_sketch"},
        {title:"System Design Primer — cache",url:"https://github.com/donnemartin/system-design-primer#cache"},
      ]},
      {l:"medium",tag:"capacity",q:"How much memory and how many Redis nodes?",turns:[
        {who:"intv",text:"Size the cache. You lean on a ~95% hit ratio at 116K reads/s. How much memory does Redis need, and how many nodes? Give me numbers."},
        {who:"cand",text:"Memory is driven by the hot working set, not all 180B mappings.<span class='eg'>Per entry &approx; 11B key + ~200B URL + overhead &approx; ~300 bytes. Caching the hot ~100M links &rarr; 100M &times; 300B &approx; 30 GB. Throughput: peak ~464K reads/s &divide; ~100K ops/s per node &approx; 5 nodes. Take the max of memory and throughput &rarr; ~5-6 nodes, replicated across AZs.</span>So ~30-64 GB of RAM on a handful of replicated nodes covers it."},
        {who:"intv",text:"Why cache only ~100M and not all 180B mappings?"},
        {who:"cand",text:"Caching everything would need <strong>180B &times; 300B &approx; 54 TB of RAM</strong> — absurd against putting it on disk in the DB. Access is heavily skewed, so ~30 GB already captures ~95% of reads. The trade-off is the shape of the hit-ratio curve: more RAM buys a higher hit ratio, but the gains flatten fast into the long tail while cost grows linearly. So I size the cache to the <em>knee</em> of that curve — tens of GB — and let the DB plus read-replicas absorb the cold-tail misses, rather than paying to cache links almost nobody clicks."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"Redis: eviction policies",url:"https://redis.io/docs/latest/operate/oss_and_stack/management/config/"},
      ]},
      {l:"medium",tag:"concept",q:"Redis or Memcached for the cache — which and why?",turns:[
        {who:"intv",text:"You keep saying Redis. Defend it — why Redis over Memcached for this cache?"},
        {who:"cand",text:"Both are in-memory KV stores, and my access pattern — point lookups of an immutable <code>key &rarr; url</code> — is exactly what <strong>Memcached</strong> nails: multithreaded, dead simple, superb raw get/set throughput per core. <strong>Redis</strong> is single-threaded per shard but brings replication, persistence, and cluster-mode failover. For a pure disposable cache Memcached would be tempting on cost and speed."},
        {who:"intv",text:"So if Memcached is faster per core, why not take it?"},
        {who:"cand",text:"Because my expensive component is the <em>DB</em>, not the cache. A cold or emptied cache triggers a thundering herd onto the DB — so cache <strong>high availability</strong> matters more to me than raw per-core speed. Redis replication + persistence lets a restarted node come back <em>warm</em> off a replica instead of empty, and cluster mode lets me shard and fan out hot keys. The trade-off is accepting Redis's single-threaded-per-shard model and heavier ops for that HA story. Given the cold-cache blast radius, I take Redis; I'd only pick Memcached if the backing store were cheap enough that an empty cache didn't hurt."},
      ],resources:[
        {title:"Redis: high availability & replication",url:"https://redis.io/docs/latest/operate/oss_and_stack/management/replication/"},
        {title:"System Design Primer — cache",url:"https://github.com/donnemartin/system-design-primer#cache"},
      ]},
    ],
    key:[
      {l:"hard",tag:"scaling",q:"Generate unique IDs across many servers, no central bottleneck.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a naive design uses one auto-increment counter in a DB row. At 1,160 creates/s across 30 service instances, that row is a lock-contention hotspot and a SPOF — if it's down, nobody can create. Fix it.</span>"},
        {who:"cand",text:"Two good approaches. <strong>(1) Range/block allocation:</strong> a coordinator (ZooKeeper or a DB sequence) hands each instance a block of, say, 1,000,000 IDs; the instance burns through it locally and only coordinates once per million creates.<span class='eg'>Instance A owns [1M-1.999M], B owns [2M-2.999M] — no per-request coordination.</span><strong>(2) Snowflake-style:</strong> a 64-bit ID generated fully locally as <code>[timestamp | machine-id | sequence]</code> — zero coordination, time-sortable. For a shortener I lean range-allocation (denser → shorter keys)."},
        {who:"intv",text:"With range-allocation, what happens if an instance crashes mid-block?"},
        {who:"cand",text:"You lose the unused tail of that block — those IDs are never used. Totally fine: the space is 3.5T+, leaking a few million per crash is a rounding error, and it buys a crash that needs zero recovery logic. Trying to reclaim partial blocks adds coordination and correctness risk for savings that don't matter."},
      ],resources:[
        {title:"Instagram Engineering: sharding & IDs",url:"https://instagram-engineering.com/sharding-ids-at-instagram-1cf5a71e5a5c"},
        {title:"Twitter/X: announcing Snowflake",url:"https://blog.twitter.com/engineering/en_us/a/2010/announcing-snowflake"},
      ]},
      {l:"hard",tag:"failover",q:"The ID coordinator (ZooKeeper) goes down — can you still create?",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> you chose range-allocation backed by ZooKeeper. ZK has an outage for 5 minutes. Does URL creation stop dead?</span>"},
        {who:"cand",text:"It shouldn't, and the design is what makes that true. Each instance holds a <strong>full block of ~1M IDs locally</strong>, so it keeps minting keys from its current block throughout the ZK outage — at 1,160/s a single block lasts ~14 minutes, far longer than a typical blip. The instance only touches ZK to fetch its <em>next</em> block, so I pre-fetch the next block when the current is, say, 20% remaining. ZK being down briefly is invisible to users."},
        {who:"intv",text:"And if ZK is down long enough that an instance exhausts its block <em>and</em> its prefetched one?"},
        {who:"cand",text:"Then that instance stops minting — but I've decoupled the blast radius: other instances with headroom keep serving creates (the LB routes around the stalled one), so it's degraded capacity, not an outage. As a stronger fallback I can switch to <strong>Snowflake-style</strong> generation, which needs no coordinator at all — some designs run Snowflake as the primary exactly to avoid this dependency. ZK itself is also run as a 3-or-5-node ensemble, so a true full outage is rare; the local-block buffer covers the common failure."},
      ],resources:[
        {title:"Apache ZooKeeper overview",url:"https://zookeeper.apache.org/doc/current/zookeeperOver.html"},
        {title:"System Design Primer — unique IDs",url:"https://github.com/donnemartin/system-design-primer#use-good-indices"},
      ]},
      {l:"medium",tag:"capacity",q:"How big should each ID block be?",turns:[
        {who:"intv",text:"Size the block-allocation scheme. At ~1,160 creates/s (peak ~5K/s) across ~30 instances, how big is each ID block, and how often does an instance hit the coordinator?"},
        {who:"cand",text:"Let me work it from a 1M-ID block.<span class='eg'>Peak ~5K creates/s &divide; ~30 instances &approx; 170 creates/s per instance. A 1M block lasts 1M &divide; 170 &approx; 5,900 s &approx; 98 min. So each instance coordinates &lt; once/hour; fleet-wide &approx; 30 blocks/hour &approx; 0.008 allocations/s on the coordinator.</span>The coordinator is almost idle, and the <code>id_ranges</code> table is a few hundred rows — storage is a non-issue."},
        {who:"intv",text:"Why 1M per block and not 1K or 1B?"},
        {who:"cand",text:"It is a direct trade-off between coordinator load and waste. <strong>Smaller blocks</strong> (1K) mean an instance re-coordinates every ~6s — constant pressure on the coordinator and more exposure to its downtime — but almost no wasted IDs on a crash. <strong>Bigger blocks</strong> (1B) mean near-zero coordination but a crash strands up to a billion IDs and the key length grows faster as I burn the space. At 1M I coordinate sub-hourly (cheap, and survives a coordinator blip via prefetch) while crash waste is negligible against the 3.5T key space. So 1M sits at the balance point; I'd only shrink it if coordinator downtime tolerance mattered more than ID density."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"Instagram Engineering: sharding & IDs",url:"https://instagram-engineering.com/sharding-ids-at-instagram-1cf5a71e5a5c"},
      ]},
      {l:"hard",tag:"concept",q:"What backs ID allocation — ZooKeeper, a DB sequence, or Snowflake?",turns:[
        {who:"intv",text:"For minting the unique integers, what technology backs it — a DB sequence, ZooKeeper, Redis INCR, or Snowflake-style local generation? Pick and defend."},
        {who:"cand",text:"Weighing the options against 'short dense keys, no central bottleneck': a <strong>DB auto-increment</strong> is simplest but is the hotspot/SPOF I am trying to kill. <strong>Redis INCR</strong> is a fast atomic counter but adds a critical central dependency. <strong>ZooKeeper</strong> gives strongly-consistent leasing, battle-tested, but is a heavy ensemble to operate. <strong>Snowflake</strong> is fully local with zero coordination and time-sortable, but produces longer keys. Since a shortener wants short, dense keys, I favour block allocation over Snowflake as the primary."},
        {who:"intv",text:"You picked block allocation. ZooKeeper or a DB sequence to hand out the blocks?"},
        {who:"cand",text:"The capacity math is the deciding factor: blocks are leased &lt; once/hour/instance, so the allocator sees well under one request/second — the old auto-increment hotspot simply evaporates at that rate. That means I do not need ZooKeeper's coordination throughput. The trade-off: ZK gives clean ephemeral-lease and leader-election semantics for free but is another system to run; a strongly-consistent conditional-update on my existing DB is one less moving part. So I lease blocks with a conditional write on the DB I already operate, and keep <strong>Snowflake</strong> as the coordination-free fallback if I ever want to drop the allocator entirely. The choice is driven by ops cost, since throughput is a non-issue here."},
      ],resources:[
        {title:"Instagram Engineering: sharding & IDs",url:"https://instagram-engineering.com/sharding-ids-at-instagram-1cf5a71e5a5c"},
        {title:"Twitter/X: announcing Snowflake",url:"https://blog.twitter.com/engineering/en_us/a/2010/announcing-snowflake"},
      ]},
    ],
    replica:[
      {l:"hard",tag:"failover",q:"A user 404s on the link they just created — replication lag.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a user creates a link, gets <code>sho.rt/aX9bQ</code>, and immediately opens it to test — and gets a 404. Your create went to the primary; their redirect read a replica that's 200ms behind. Read-your-writes just broke. Fix it.</span>"},
        {who:"cand",text:"This is the classic <strong>read-your-writes</strong> violation from async replication. Fixes, cheapest first: <strong>(1)</strong> on create, I already <em>warm the cache</em> synchronously — so their immediate read hits the cache, not a lagging replica, and sees the key. <strong>(2)</strong> for a short window after a user's write, pin that user's reads to the primary (or a 'read-your-writes' token / session stickiness). <strong>(3)</strong> on any replica miss for a very recent key, fall back to the primary before returning 404."},
        {who:"intv",text:"The cache-warm covers the creator. But a friend they texted the link to, in another region, also 404s for a moment. Same fix?"},
        {who:"cand",text:"That one's genuinely eventual — the friend has no session with my primary and the write may not have propagated to their region's replica yet. I lean on <strong>replica-miss → primary fallback</strong>: a miss on a fresh key isn't 'doesn't exist,' it's 'might be too new,' so I check the primary (or cross-region) before 404ing, and cache the result. It adds a little latency to the rare fresh-key miss while keeping the 99.99% steady-state reads cheap on local replicas. I'd also make key creation → global cache propagation fast (push to a global cache tier on create) so the window is sub-second."},
      ],resources:[
        {title:"Read-your-writes consistency",url:"https://en.wikipedia.org/wiki/Consistency_model#Read-your-writes_consistency"},
        {title:"System Design Primer — replication lag",url:"https://github.com/donnemartin/system-design-primer#replication"},
      ]},
      {l:"hard",tag:"durability",q:"Primary dies — promote a replica without split-brain.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> the write-primary for a shard crashes. You promote a replica to primary. Two minutes later the old primary rejoins — and it still thinks it's primary. Now you have two primaries taking writes. What happens and how do you prevent it?</span>"},
        {who:"cand",text:"That's <strong>split-brain</strong>, and for writes it means divergent, conflicting data on the same key — corruption. Prevention: promotion must go through a <strong>consensus/leader-election</strong> mechanism (Raft/Paxos, or a fencing coordinator) that grants a monotonically increasing <strong>epoch/term</strong>. The new primary writes under a higher epoch; when the old primary rejoins with a stale epoch, replicas and clients <strong>reject its writes</strong> (fencing token), and it's demoted to replica and re-syncs. There is never a moment two nodes hold the current epoch."},
        {who:"intv",text:"During the election window, are writes just unavailable?"},
        {who:"cand",text:"Briefly, yes — that's the CAP trade-off: to avoid split-brain I choose <strong>consistency over availability for writes</strong> during a partition, so creates on that shard pause for the election (typically a few seconds). Reads stay fully available from replicas throughout, so redirects — the traffic that actually matters for a shortener — are unaffected. I'd rather a handful of creates retry for 3 seconds than corrupt the mapping store. Managed stores (DynamoDB, Spanner) do this fencing internally, which is a strong reason to use them rather than hand-rolling failover."},
      ],resources:[
        {title:"Raft consensus",url:"https://raft.github.io/"},
        {title:"Fencing tokens (Martin Kleppmann)",url:"https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html"},
      ]},
      {l:"medium",tag:"capacity",q:"How many read replicas per shard do you run?",turns:[
        {who:"intv",text:"Size the read-replica tier. Per shard, how many replicas do you run, and what read rate must they sustain — steady-state versus a cold cache?"},
        {who:"cand",text:"The two cases give very different numbers.<span class='eg'>Steady state: the cache absorbs ~95%, so the DB tier sees ~5.8K reads/s + ~1.2K writes/s spread across shards — a couple of replicas per shard is ample. Cold cache: up to ~464K reads/s hits the DB. At ~15K reads/s per replica &rarr; 464K &divide; 15K &approx; 31 replicas fleet-wide; across ~10 shards &rarr; ~3 replicas/shard.</span>Both roads land near ~3 replicas per shard, which also matches what durability wants."},
        {who:"intv",text:"So you are sizing for a cold cache that is rare. Isn't that over-provisioning?"},
        {who:"cand",text:"It would be if I provisioned the full cold-cache fleet to sit idle 99% of the time — that is pure cost. But the floor is set by something I need anyway: a <strong>3-node replica group</strong> per shard for quorum durability and AZ failure tolerance. That floor already covers steady-state reads with room to spare. For the cold-cache surge I lean on <strong>request coalescing</strong> and the edge to cap the spike at the source rather than buying 31 replicas that idle. So durability sets the replica count, and stampede control — not extra hardware — absorbs the peak. The trade-off is a brief elevated-latency window on a cold start, which I accept over permanent over-provisioning."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"System Design Primer — replication",url:"https://github.com/donnemartin/system-design-primer#replication"},
      ]},
    ],
    analytics:[
      {l:"medium",tag:"scaling",q:"Aggregate billions of click events without melting.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a marketing blast drives 500K clicks/s for an hour. Your analytics consumer writes one DB row per click and immediately falls hours behind, and the dashboard shows stale counts. Redesign the pipeline.</span>"},
        {who:"cand",text:"Row-per-click is the mistake — it couples ingest rate to DB write rate. Instead: events land in <strong>Kafka</strong> (which happily absorbs 500K/s and buffers the spike), and stream consumers do <strong>windowed aggregation</strong> — roll up per-key counts in, say, 1-minute tumbling windows and write <em>aggregates</em>, not raw rows, to an OLAP/column store. That's a ~million-fold reduction in write volume. Raw events also archive to object storage for replay."},
        {who:"intv",text:"The redirect path emits to Kafka synchronously. If Kafka is briefly unavailable, does that stall redirects?"},
        {who:"cand",text:"It must not — analytics is best-effort and off the critical path. The producer is <strong>async, fire-and-forget with a bounded local buffer</strong>: if Kafka is slow/unreachable, events queue in-memory up to a cap and then I <em>drop</em> them (or spill to a local log) rather than block or delay the 302. Losing a slice of analytics during a Kafka blip is acceptable; adding latency to a billion redirects is not. Exact counts aren't the goal — approximate, timely counts are."},
      ],resources:[
        {title:"Apache Kafka documentation",url:"https://kafka.apache.org/documentation/"},
        {title:"System Design Primer — async & message queues",url:"https://github.com/donnemartin/system-design-primer#asynchronism"},
      ]},
      {l:"medium",tag:"capacity",q:"How many Kafka partitions and consumers?",turns:[
        {who:"intv",text:"Size the analytics pipeline. Click events peak at ~500K/s during a marketing blast. How many Kafka partitions and consumer instances do you provision? Show the math."},
        {who:"cand",text:"I size partitions from both bandwidth and consumer parallelism, then take the max.<span class='eg'>Event ~200 bytes &rarr; 500K/s &times; 200B &approx; 100 MB/s ingest. At ~10 MB/s per partition &rarr; ~10 partitions on bandwidth. Consumers: windowed aggregation at ~20K events/s each &rarr; 500K &divide; 20K &approx; 25 consumers, and one consumer reads one partition, so I need &ge; 25 partitions. Max &rarr; ~32 partitions, ~25-32 consumers at peak.</span>I round to 32 for clean rebalancing and headroom."},
        {who:"intv",text:"Why size partitions for the occasional blast rather than the steady ~116K/s?"},
        {who:"cand",text:"Because partition count is the one number that is painful to change later — repartitioning reshuffles keys — and it hard-caps my maximum consumer parallelism. So I over-provision partitions up front (they are cheap) and autoscale <em>consumers</em> between ~6 at steady-state and ~32 at peak on consumer lag. Kafka's disk buffering means consumers need not even keep up in real time — they drain the backlog after the spike. The trade-off is a bit of ingest latency during a blast versus a hard scaling ceiling; since analytics is not on the critical path, I take the latency. So: 32 partitions fixed, consumers autoscaled on lag, retention sized to hold a multi-hour backlog."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"Apache Kafka documentation",url:"https://kafka.apache.org/documentation/"},
      ]},
      {l:"medium",tag:"concept",q:"Kafka, Kinesis, or SQS for the click stream?",turns:[
        {who:"intv",text:"You default to Kafka for the click stream. Why Kafka over Kinesis or SQS?"},
        {who:"cand",text:"I match each to the access pattern — high-volume ingest, windowed aggregation, and replay to object storage. <strong>SQS</strong> is a work-queue: consumers delete messages, there is no ordered partitioned log and no replay, so it cannot feed windowed aggregation or re-processing — it is out. <strong>Kinesis</strong> is a managed partitioned log (shards), very Kafka-like with far less ops, but throughput is priced/capped per shard and it is AWS-locked. <strong>Kafka</strong> is a high-throughput partitioned log with retention, replay, and a mature stream-processing ecosystem. The replay requirement alone rules out SQS."},
        {who:"intv",text:"Kafka versus Kinesis, then — both are logs. What decides it?"},
        {who:"cand",text:"It comes down to ops capacity versus scale and cost, not raw capability. <strong>Kinesis</strong> wins on operations — no brokers or coordination to run, shards autoscale, tight AWS integration — so it is the right call for a smaller team already all-in on AWS. <strong>Kafka</strong> wins on raw throughput ceiling, cost at sustained 500K/s, portability, and the Kafka Streams/Flink ecosystem for the aggregation. At this scale the per-shard limits and cost of Kinesis add up. So I would run <strong>Kafka</strong> (or managed MSK) if we operate at this volume and can staff it, and reach for Kinesis if minimizing broker ops matters more than the throughput ceiling. The decision follows team and scale, not a feature gap."},
      ],resources:[
        {title:"Apache Kafka documentation",url:"https://kafka.apache.org/documentation/"},
        {title:"System Design Primer — async & message queues",url:"https://github.com/donnemartin/system-design-primer#asynchronism"},
      ]},
    ],
    client:[
      {l:"medium",tag:"concept",q:"What can you push to the client/edge, and its limits?",turns:[
        {who:"intv",text:"You keep saying 'serve redirects from the edge.' Where's the line — what lives at the edge vs the origin?"},
        {who:"cand",text:"<strong>Redirects</strong> are the ideal edge workload: immutable, small mappings, cacheable with long TTL, answerable close to the user by an edge worker against a replicated edge KV. <strong>Creation</strong> must stay at the origin — it needs key-gen coordination and the authoritative durable write. Rule of thumb: read-only + immutable → edge; write + coordinated + authoritative → origin."},
        {who:"intv",text:"An edge-cached link gets deleted or flagged as malware. The edge keeps redirecting to it. How do you revoke fast?"},
        {who:"cand",text:"Bounded edge TTLs (not infinite) plus <strong>active purge</strong>: on delete/flag, issue a CDN cache-invalidation for that specific key so edges drop it. Expiry I encode in the cached response so the edge enforces <code>now > expiry</code> without a purge. So the edge stays fast for the immutable happy-path, but I keep a fast revocation path for the rare mutation — the same reason I don't set TTLs to forever."},
      ],resources:[
        {title:"Cloudflare Workers — edge compute",url:"https://developers.cloudflare.com/workers/"},
        {title:"System Design Primer — CDNs",url:"https://github.com/donnemartin/system-design-primer#content-delivery-network"},
      ]},
    ],
  },
  mockTest:[
    {q:"State the functional and non-functional requirements for a URL shortener, and give the back-of-envelope load.",a:"Functional: create a short URL (optional custom alias + expiry), redirect to the long URL, basic per-link click analytics. Non-functional: redirect p99 &lt; 100ms, ~100:1 read:write, high availability, unguessable keys. Load: ~100M new URLs/day &rarr; ~1,160 writes/s and ~116K reads/s, peak 3-5x; ~180B rows at ~500B &rarr; ~90TB."},
    {q:"How is the short key generated, and why base62 of an integer over a UUID or a hash of the long URL?",a:"Mint a unique 64-bit integer, then base62-encode it (0-9 a-z A-Z) to ~7 URL-safe chars covering 62^7 &approx; 3.5 trillion keys. A UUID is 36 chars — too long and its entropy is wasted; hashing the long URL invites collisions you must detect and resolve. Base62 of an already-unique integer is short, URL-safe (no + / =), and collision-free by construction."},
    {q:"How do you mint unique IDs across many service instances without a central bottleneck?",a:"Avoid a single auto-increment row (lock-contention hotspot and SPOF). Use block/range allocation: a coordinator leases each instance a block of ~1M IDs that it burns locally, coordinating less than once per hour. Alternatively Snowflake-style local generation (timestamp | machine-id | sequence) needs zero coordination. Block allocation is preferred for a shortener because it yields denser, shorter keys."},
    {q:"Which datastore do you choose and why, backed by node math?",a:"A hash-partitioned wide-column / KV store (DynamoDB on AWS, or Cassandra for self-host/portability). The access pattern is a point lookup by primary key, write-once-read-many, needing ~270TB (RF3) and ~464K peak reads/s — both scale by adding nodes. Postgres is rejected because 90TB and cold-cache reads force ~18 manual shards plus ~50+ replicas, rebuilding a distributed KV store on a relational engine whose joins you never use."},
    {q:"How do you size the datastore — storage and nodes?",a:"Storage: 180B &times; 500B &approx; 90TB raw, &times;3 replication &approx; 270TB; at ~2TB usable/node &approx; ~135 nodes for space. Throughput: peak writes ~5K/s, peak cold reads ~464K/s at ~15K reads/node &approx; ~31 nodes — but the cache absorbs ~95% steady-state. Storage dominates, so provision ~135-150 nodes; tier cold links to cheaper storage and let TTL/expiry reclaim space."},
    {q:"Reads are overwhelming the DB at 116K/s. What is the highest-leverage fix and why does it work?",a:"Put a Redis cache in front and serve redirects from it. The workload is read-dominated (100:1) and heavily skewed, so a high hit ratio absorbs almost all reads. At a 95% hit ratio DB read load drops from 116K/s to ~5.8K/s. Mappings are immutable, so cached entries never go stale — long TTLs, LRU eviction, no invalidation logic."},
    {q:"How do you make the mapping store durable and avoid data loss when a shard node dies?",a:"Replicate every shard as a group of ~3 nodes across AZs, with writes acknowledged by a quorum before returning success. A single disk failure loses nothing — the other replicas hold the data and a fresh replica rebuilds from them. Replicas also serve reads, so one mechanism buys both durability and read scaling; immutability makes slightly-stale replica reads safe."},
    {q:"A primary crashes and you promote a replica; the old primary rejoins thinking it is still primary. What breaks and how do you prevent it?",a:"That is split-brain — two primaries taking writes cause divergent, corrupt data on the same key. Prevent it with consensus/leader-election (Raft/Paxos or a fencing coordinator) that grants a monotonically increasing epoch. The new primary writes under a higher epoch; the stale old primary's writes are rejected via the fencing token and it demotes and re-syncs. Writes pause briefly during election (consistency over availability); reads stay available from replicas."},
  ]
};
