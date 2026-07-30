window.DATA = window.DATA || {};
window.DATA['crawler'] = {
  cat:"frontier · politeness · dedup",
  title:"Design a distributed web crawler (for a search index)",
  blurb:"Crawl billions of pages for a search index — polite to hosts, dedup-aware, trap-resistant, and fresh.",
  prompt:"Let's design a distributed web crawler that feeds a search index. It starts from seed URLs, downloads pages, extracts their links to discover more pages, and must scale to billions of pages while staying polite to the sites it visits, avoiding duplicates and traps, and keeping content fresh. Start with the high-level architecture and rough numbers, then we'll drill into components — and I'll throw failure scenarios at you.",
  opening:"Let me pin down scope before drawing boxes.<br><br><strong>Functional:</strong> crawl the web from seed URLs, download pages, extract links to keep crawling, and hand clean content to a search index. <strong>Non-functional:</strong> scale to billions of pages, be <em>polite</em> (never hammer a host), avoid re-crawling duplicates and getting stuck in traps, and keep the index reasonably <em>fresh</em>.<br><br><strong>Back-of-envelope:</strong> target ~30B pages, refreshed ~monthly → ~1B pages/day ≈ <strong>~12K pages/s</strong> sustained (higher at peak). Storage: 30B × ~100KB ≈ <strong>3PB</strong> raw, well under 1PB compressed. The seen-set alone is ~30B URLs — tens of GB even as a Bloom filter.<br><br>I'll start deliberately minimal: <strong>seed/scheduler → URL frontier → fetcher pool → parser</strong>, with the parser feeding new links back into the frontier. That loop is the whole crawler in miniature. As we hit scale and failure pressure I'll grow it — DNS caching, politeness, dedup, content storage. Pick a box and let's push.",
  nodes:[
    {id:"seed",name:"Seed / scheduler",sub:"start URLs",x:40,y:150},
    {id:"frontier",name:"URL frontier",sub:"queue of URLs",x:210,y:150},
    {id:"fetcher",name:"Fetcher pool",sub:"download pages",x:380,y:150},
    {id:"parser",name:"Parser / extractor",sub:"links + content",x:550,y:150},
    {id:"store",name:"Content store",sub:"pages / index",x:550,y:40},
    {id:"dedup",name:"Dedup / seen",sub:"URL + content",x:380,y:40},
    {id:"dns",name:"DNS resolver",sub:"cached",x:210,y:40},
    {id:"politeness",name:"Politeness / rate",sub:"per-domain",x:380,y:260},
  ],
  edges:[["seed","frontier","seed URLs"],["frontier","fetcher","next URL"],["fetcher","parser","raw HTML"],["parser","frontier","new links"],["parser","store","save page"],["fetcher","dns","resolve"],["fetcher","politeness","rate check"],["parser","dedup","seen?"]],
  core:["seed","frontier","fetcher","parser"],
  basic:["seed","frontier","fetcher","parser"],
  deepDive:{
    seed:{
      role:"The scheduler/bootstrap: it injects the initial ~10K seed URLs and, more consequentially, owns <strong>recrawl scheduling</strong> — deciding <em>when</em> each of 30B known pages is due again so the fixed ~12K pages/s budget goes to the pages most likely to have changed.",
      capacity:[
        ["Seeds","~10K URLs","one-time bootstrap"],
        ["Recrawl decisions","~12K/s","one per page-slot spent"],
        ["Per-page state","~40 B","last-crawled, change-rate, priority"],
        ["State total","~1.2 TB","40B × 30B pages"],
      ],
      data:"A schedule/priority store over 30B pages: last-fetch time, observed change frequency, and next-due. Tiered into hourly/daily/monthly buckets so news re-enters fast and static archives rarely — you scan a small live bucket, not 30B rows each cycle.",
      scaling:[
        "Bucket pages by cadence (hourly/daily/monthly) and only sweep due buckets.",
        "Adapt cadence to observed change rate — pages that never change decay to monthly.",
        "The budget is fixed at ~12K/s; scheduling is a prioritization problem, not a throughput one.",
        "Partition state by domain hash to match the frontier's sharding.",
      ],
      failures:[
        {t:"Change-rate signal is wrong",b:"Waste slots re-fetching static pages while news goes stale.",m:"Feed the parser's content-hash (did it actually change?) back into the cadence estimate; back off on no-change."},
        {t:"A bad seed list floods one TLD",b:"Frontier + politeness skew to one domain.",m:"Cap per-domain injection and let politeness throttle regardless of seed weighting."},
        {t:"Schedule store lost",b:"Lose knowledge of what's due.",m:"Rebuildable from the crawl-metadata index (last-fetch per URL); worst case, re-derive cadence over time."},
      ],
      tradeoffs:[
        {a:"Adaptive per-page cadence",b:"Uniform monthly sweep",pick:"Adaptive spends the fixed budget where change happens (freshness on news); uniform is simpler but wastes slots re-fetching archives and lags breaking pages."},
      ],
      probes:[
        "30B pages, ~12K/s budget — full recrawl takes ~a month. How do you pick what to fetch next?",
        "How do you learn a page's change rate without wasting fetches to measure it?",
        "A news homepage and a 2009 blog post are both 'due' — who wins and why?",
      ],
    },
    frontier:{
      role:"The prioritized URL queue and the crawler's brain. It owns the two levers that decide crawl quality: <strong>priority</strong> (crawl good pages first) and <strong>politeness sequencing</strong> (never hammer one host). A Mercator-style two-stage queue where <code>worker = hash(domain) % N</code> co-locates a domain's ordering on one shard.",
      capacity:[
        ["In-flight URLs","~3B","× ~200B ≈ ~600GB fleet"],
        ["Per worker","~3 GB","600GB / 200 workers"],
        ["Enqueue","~120K/s","~10 new links/page × 12K pages/s"],
        ["Dequeue","~12K/s","= fetch budget; enqueue ≫ dequeue"],
      ],
      data:"Two-stage queues: <strong>front</strong> queues by priority, <strong>back</strong> queues one-per-domain enforce politeness order. Each URL is dedup-checked (seen-set) before it ever enters — enqueue vastly exceeds dequeue, so the seen filter is what keeps 3B from becoming ∞.",
      scaling:[
        "Shard by <code>hash(domain)%N</code> so one domain's queue + rate state live on one worker.",
        "Front/back split decouples 'what's important' from 'what's polite to fetch now'.",
        "Enforce per-domain caps + max crawl depth to starve traps and link farms.",
        "Spill cold low-priority URLs to disk/object store; keep hot ready-set in memory.",
      ],
      failures:[
        {t:"A spider trap emits infinite URLs",b:"One domain's back-queue explodes; budget wasted on junk.",m:"Per-domain URL caps + max depth + trap detection (deep repetitive path patterns) drop them before enqueue."},
        {t:"A frontier shard dies",b:"~3GB of queued URLs for those domains lost.",m:"Durable/replicated queue state; on loss, those URLs are re-discovered from future page links (frontier is regenerable, not source-of-truth)."},
        {t:"Enqueue (120K/s) outruns dequeue (12K/s) unbounded",b:"Frontier grows without limit.",m:"Seen-set rejects already-known URLs at ingress; priority + caps bound what's admitted."},
      ],
      tradeoffs:[
        {a:"Two-stage priority+politeness frontier",b:"Single FIFO queue",pick:"Two-stage crawls high-value pages first while respecting per-host limits; a FIFO ignores importance and would need external throttling to stay polite."},
        {a:"In-memory ready set",b:"All-disk queue",pick:"Memory keeps dequeue hot at 12K/s; spill only cold URLs to disk — balances 600GB footprint against latency."},
      ],
      probes:[
        "Enqueue is ~120K/s but you can only fetch ~12K/s — what stops the frontier from exploding?",
        "Why put a whole domain on one shard instead of load-balancing its URLs?",
        "A site links a calendar 'next month' forever — how does the frontier not chase it to infinity?",
      ],
    },
    fetcher:{
      role:"The async HTTP downloader — the throughput engine. Its lever is <strong>concurrency via non-blocking I/O</strong>: pages spend most of their life waiting on the network, so one box juggles thousands of open sockets instead of blocking a thread each. It obeys politeness/DNS before every fetch.",
      capacity:[
        ["Target","~12K pages/s fleet","1B/day"],
        ["Per box","~12.5K/s ceiling","~5K sockets × ~400ms avg"],
        ["Size cap","~10 MB/response","stop-reading guard"],
        ["Workers","~200","also shard the frontier"],
      ],
      data:"Stateless per request; correctness comes from checking politeness (per-domain rate) and DNS (resolved IP) first. It streams the body with a hard size cap and timeouts, then hands raw bytes to the parser — it holds no durable state.",
      scaling:[
        "Event-driven epoll/async so a handful of boxes cover thousands of concurrent slow fetches.",
        "Hard per-request timeouts + a ~10MB read cap so one slow/huge response can't pin a slot.",
        "Scale horizontally; each box is independent and shard-aligned to the frontier.",
        "Respect <code>Retry-After</code>/backoff to avoid getting a crawler IP blocked.",
      ],
      failures:[
        {t:"A host black-holes connections (no response)",b:"Sockets pile up, effective concurrency collapses.",m:"Aggressive connect/read timeouts free the slot; circuit-break a repeatedly-failing host."},
        {t:"A server streams a multi-GB 'file'",b:"One response eats memory/bandwidth.",m:"Hard ~10MB cap: stop reading and truncate/discard."},
        {t:"A worker box dies",b:"Its in-flight fetches drop.",m:"Stateless — those URLs remain in the frontier and get re-leased; no data loss, just a retry."},
      ],
      tradeoffs:[
        {a:"Async non-blocking I/O",b:"Thread-per-request",pick:"Async fits the I/O-bound profile — ~5K sockets/box vs a thread (≈1MB stack) each; threads would cap a box at hundreds of fetches and burn RAM on idle waits."},
      ],
      probes:[
        "Each fetch waits ~400ms on the network — how does one box still do thousands per second?",
        "A domain stops responding mid-download — how do you keep from leaking sockets?",
        "What stops a malicious server from making you download a 5GB response?",
      ],
    },
    parser:{
      role:"Extracts links + content from raw HTML and feeds both frontier (new URLs) and store (page body). Its lever is the <strong>render-or-not decision</strong>: cheap static HTML parse (~20ms CPU) versus expensive headless-browser JS rendering (100ms–1s) that costs 10–50× the compute.",
      capacity:[
        ["Static parse","~20 ms CPU/page","→ ~240 cores for 12K/s"],
        ["JS render","100ms–1s/page","→ thousands of cores"],
        ["Fan-out","~10 links/page","drives frontier enqueue"],
        ["Extracted text","~16 KB/page","after boilerplate strip"],
      ],
      data:"Stateless CPU worker. It normalizes/canonicalizes extracted URLs (so <code>/a</code> and <code>/a/</code> don't both enqueue), strips boilerplate, and computes a content hash used by dedup + recrawl cadence. Holds nothing durable.",
      scaling:[
        "Keep the default path a plain HTML parse; reserve rendering for domains that demonstrably need JS.",
        "Canonicalize URLs before enqueue to cut duplicate discovery at the source.",
        "It's CPU-bound (unlike the I/O-bound fetcher), so scale it as a separate, differently-sized pool.",
        "Batch/pipeline parse → content-hash → dedup to avoid re-walking the DOM.",
      ],
      failures:[
        {t:"Everything routed through the JS renderer",b:"Compute blows from ~240 cores to thousands; throughput craters.",m:"Render only when a static parse yields no content/links; maintain a per-domain 'needs render' flag."},
        {t:"Malformed/adversarial HTML",b:"Parser crashes or hangs on one page.",m:"Sandbox + per-page CPU/time budget; skip and log, never block the pipeline."},
        {t:"Poor URL canonicalization",b:"Same page enters the frontier many ways, wasting budget.",m:"Strict normalization (scheme/host case, trailing slash, param ordering, fragment strip) before enqueue."},
      ],
      tradeoffs:[
        {a:"Headless-browser render",b:"Static HTML parse",pick:"Render captures JS-built content but costs 10–50× CPU (thousands of cores); make it opt-in per domain so the common static case stays at ~240 cores."},
      ],
      probes:[
        "Rendering every page needs thousands of cores; parsing needs ~240 — how do you decide per page?",
        "The parser feeds the frontier — how do you keep it from enqueuing the same page five ways?",
        "Why size the parser pool separately from the fetcher pool?",
      ],
    },
    store:{
      role:"Durable, write-once archive of raw pages plus a queryable crawl-metadata index. Its lever is the <strong>bytes-vs-index split</strong>: giant immutable blobs go to object storage (S3/WARC), while small per-URL metadata lives in a separate wide-column index — using each store for what it's good at.",
      capacity:[
        ["Blob volume","~500 TB","3PB raw, ~16KB/page compressed"],
        ["Write rate","~190 MB/s","~12K pages/s, ~1.6TB/day"],
        ["Metadata","~3 TB","30B URLs × ~100B"],
        ["Blob nodes","~50–60","object-storage capacity, +3× replication"],
      ],
      data:"Content-addressed or URL-keyed blobs packed into <strong>WARC</strong> files (many pages per object) to dodge small-file overhead; a wide-column metadata index (URL → offset, fetch time, status, content-hash). Write-once, read by key or batch-scan; no updates/joins/transactions.",
      scaling:[
        "Pack many pages per WARC object so 30B tiny files don't crush the store.",
        "Keep bytes (object storage) and metadata (index) in separate systems tuned differently.",
        "3× replication (or erasure coding) for ~11 nines durability on data you can't cheaply recrawl.",
        "Batch-scan for indexing jobs; point-get by key for reprocessing.",
      ],
      failures:[
        {t:"A storage node/disk fails",b:"A slice of archived pages at risk.",m:"3× replication / erasure coding across nodes — a single loss is invisible; ~11 nines durability."},
        {t:"Writing 30B individual objects",b:"Metadata/NameNode-style overhead explodes.",m:"WARC packing amortizes per-object cost; the metadata index (~3TB) stays separate and small."},
        {t:"Metadata index corrupts",b:"Can't locate blobs by URL.",m:"Rebuild the index by scanning WARC headers — bytes remain the source of truth."},
      ],
      tradeoffs:[
        {a:"Object storage + WARC + separate index",b:"HDFS",pick:"Object storage wins: 30B objects would need a ~4.5TB NameNode heap on HDFS; WARC packing + object store sidesteps small-file death and is cheaper/more durable."},
        {a:"Object storage for bytes",b:"Cassandra for bytes",pick:"Store bytes in object storage, not Cassandra — 500TB of blobs would drown Cassandra in compaction and cost; keep Cassandra-style stores for the small metadata index only."},
      ],
      probes:[
        "Why not just dump 30B pages into HDFS as files?",
        "Where do the raw bytes live vs the 'have I stored this URL' lookup, and why split them?",
        "How do you store 30B ~16KB blobs without dying from small-file overhead?",
      ],
    },
    dedup:{
      role:"Two dedups in one: <strong>URL-seen</strong> (has this link been queued?) at billions-of-URLs scale, and <strong>content-seen</strong> (is this page a near-duplicate?). The lever it owns: a probabilistic seen-set that keeps the frontier finite at 30B without a 3TB exact index in RAM.",
      capacity:[
        ["Seen URLs","~30B","the exact set is huge"],
        ["Bloom fleet","~37 GB","~10 bits/URL, <1% FP"],
        ["Per worker","~190 MB","37GB / 200 workers"],
        ["Exact hashset","3 TB+","the alternative you avoid"],
      ],
      data:"A per-worker Bloom filter over URL hashes (partitioned by the same <code>hash(domain)%N</code> as the frontier). Bloom is <em>mergeable</em>: on worker migration/rebalance, OR the bit-arrays. Content dedup uses <strong>SimHash + LSH banding</strong> to catch near-duplicates, not just byte-identical pages.",
      scaling:[
        "Bloom instead of a hashset: ~37GB fleet vs 3TB+ exact — the enabling trade.",
        "Partition by domain hash so a worker only holds its shard's set (~190MB).",
        "Merge shards by bitwise-OR when rebalancing — no rehash of 30B URLs.",
        "SimHash+LSH buckets similar content so near-dup detection is sub-linear.",
      ],
      failures:[
        {t:"Bloom false positive (<1%)",b:"A never-seen URL is wrongly skipped — that page never crawled.",m:"Accept the tiny miss rate (tune bits/URL); it only drops coverage slightly, never corrupts data. Use exact check only for high-value URLs."},
        {t:"Worker migrates its domain shard",b:"Seen-set must move without a full rebuild.",m:"Bloom's OR-merge property: combine bit-arrays on the target — cheap, no rehash."},
        {t:"Content changes trivially each fetch (timestamps/ads)",b:"Byte-hash sees everything as new.",m:"SimHash on extracted content ignores boilerplate churn so near-dups collapse."},
      ],
      tradeoffs:[
        {a:"Bloom filter (probabilistic)",b:"Exact hashset",pick:"Bloom fits 30B URLs in ~37GB with <1% false positives (a few missed pages); an exact set needs 3TB+ RAM — you trade perfect recall for feasibility."},
        {a:"SimHash near-dup",b:"Exact content hash",pick:"SimHash catches templated/near-identical pages exact hashing misses, at the cost of a tunable similarity threshold and LSH bucketing complexity."},
      ],
      probes:[
        "30B seen URLs — why not just a hashset, and what does Bloom cost you?",
        "A Bloom false positive means you never crawl a real page — why is that acceptable?",
        "Two pages differ only by a timestamp and rotating ad — how do you call them duplicates?",
      ],
    },
    dns:{
      role:"Resolves hostnames to IPs before every fetch. Left unmanaged it's a hidden bottleneck — a blocking lookup per page would throttle the crawler. The lever it owns: an <strong>aggressive resolver cache</strong> that turns ~12K lookups/s into ~100 real DNS queries/s.",
      capacity:[
        ["Lookups implied","~12K/s","one per fetch"],
        ["New hosts","~50/s","→ >99% cache hit"],
        ["Real misses","~100/s","cold/expired entries only"],
        ["Cache size","~10 GB full","~100M hosts × ~100B (partitioned to tens of MB/worker)"],
      ],
      data:"A shared/tiered resolver cache: host → IP with TTL. Most fetches hit an already-resolved domain (the crawl revisits hosts constantly), so the working set is small and hit-rate is >99%. Partitioned by domain hash alongside frontier/politeness state.",
      scaling:[
        "Cache resolutions with TTLs — the crawl's domain locality gives >99% hits.",
        "Async/prefetch resolution so a lookup never blocks a fetch slot.",
        "Partition the host→IP table by domain hash to keep per-worker footprint at tens of MB.",
        "Run/back with a dedicated recursive resolver to avoid hammering public DNS.",
      ],
      failures:[
        {t:"DNS provider slow/rate-limits the crawler",b:"Resolution latency stalls fetches fleet-wide.",m:"High cache hit-rate shrinks real queries to ~100/s; own recursive resolver + backoff insulate from a flaky upstream."},
        {t:"Stale cache entry (IP changed)",b:"Fetching a dead/old IP for a host.",m:"Honor record TTLs; on connect failure, force a re-resolve and evict."},
        {t:"Thundering herd on a popular expired entry",b:"Many workers resolve the same host at once.",m:"Single-flight per host: one lookup fills the cache, others wait on it."},
      ],
      tradeoffs:[
        {a:"Aggressive resolver cache",b:"Resolve per fetch",pick:"Caching turns 12K lookups/s into ~100 real queries/s (>99% hit) — essential, at the cost of occasional staleness bounded by TTL and connect-failure re-resolve."},
      ],
      probes:[
        "A DNS lookup per page at 12K/s — why is that a problem and how do you make it ~100/s?",
        "A cached IP goes stale and the host moved — how do you notice and recover?",
        "A hot domain's DNS entry expires and 50 workers need it at once — avoid the stampede.",
      ],
    },
    politeness:{
      role:"The rate-limit + robots.txt authority per domain — the crawler's social contract. Its lever: enforce a <strong>per-host request interval</strong> (and <code>Crawl-delay</code>/robots rules) so one target site is never overwhelmed, keeping the crawler's IPs from being blocked.",
      capacity:[
        ["Timing state","~50 B/host","last-hit, min-interval"],
        ["Timing fleet","~5 GB","for ~100M hosts"],
        ["robots cache","~1 KB/host","→ ~100GB fleet, ~500MB/worker"],
        ["robots TTL","~24 h","re-fetch daily"],
      ],
      data:"Per-domain: last-request timestamp + min interval, and a cached parsed <code>robots.txt</code> (allow/deny paths, crawl-delay). Co-located with the frontier's back-queue for that domain (same <code>hash(domain)%N</code> shard) so the rate decision and the queue live together.",
      scaling:[
        "Shard by domain so all rate state for a host is on one worker — no cross-node coordination to be polite.",
        "Cache robots.txt with a ~24h TTL; ~1KB × domains ≈ ~100GB fleet.",
        "Pair with the frontier back-queues: a domain becomes fetch-eligible only when its interval elapses.",
        "Default-deny unknown/unfetched robots until fetched, to stay conservative.",
      ],
      failures:[
        {t:"robots.txt fetch fails",b:"Unknown crawl rules for a domain.",m:"Fail conservative — apply a safe default interval and defer, retry robots later rather than crawl blind."},
        {t:"A domain's shard is overloaded",b:"Politeness decisions lag; risk hammering or starving that host.",m:"Since state is domain-local, rebalance whole domains to another shard — decision stays single-owner."},
        {t:"Site tightens crawl-delay after you cached the old one",b:"You crawl too fast for up to a day.",m:"24h robots TTL bounds staleness; honor <code>429</code>/<code>Retry-After</code> immediately regardless of cache."},
      ],
      tradeoffs:[
        {a:"Per-domain rate state co-located with frontier",b:"Central rate-limit service",pick:"Co-location means being polite needs zero cross-node coordination and no hot central service; the cost is domain-affinity in sharding (which the frontier already requires)."},
      ],
      probes:[
        "How do you guarantee you never send two requests to one host within its crawl-delay across 200 workers?",
        "You cached robots.txt 12 hours ago and the site just disallowed you — what happens?",
        "Why does politeness state live on the same shard as that domain's frontier queue?",
      ],
    },
  },
  dbDoc:{
    component:"Content store",
    load:"~12K pages/s of write-once blobs; each raw page ~100KB, ~16KB after ~6x gzip &rarr; <strong>~190MB/s sustained write</strong>, ~1.6TB/day ingested. Total ~30B pages &times; ~16KB &approx; <strong>~500TB compressed (3PB raw)</strong>, growing ~100TB/month. Access = write once, read by key for reprocessing or batch-scan for indexing; no updates, no joins, no transactions.",
    candidates:[
      {name:"Managed object storage (S3-style)",ceiling:"~3,500 PUT/s per key-prefix; effectively unbounded capacity; ~11 nines durability",nodes:"no cluster I own; shard writes across ~50-100 key-prefixes to clear 12K/s; ~500TB is a line item, not a node count",pick:true,note:"chosen &mdash; native home for immutable, key-addressed, large-ish blobs: cheap per-TB, built-in hot/cold tiering, infinite scale, and 190MB/s spreads trivially across sharded prefixes."},
      {name:"HDFS",ceiling:"DataNodes scale capacity fine, but the NameNode holds ~150 bytes RAM metadata per object",nodes:"~500TB &divide; ~10TB usable/node &approx; 50 DataNodes for space, but 30B objects &approx; <strong>4.5TB of NameNode heap</strong> &mdash; caps in practice around 300-500M files",pick:false,note:"breaks on object count, not capacity: 30B tiny objects blow past the NameNode metadata ceiling long before space is an issue."},
      {name:"Cassandra / Bigtable (wide-column)",ceiling:"~10-50K small writes/s per node, but values meant to be under ~10KB",nodes:"16-100KB blobs bloat compaction and heap; ~1-2TB usable/node &rarr; <strong>~250-500 nodes</strong> for 500TB, all fighting compaction on data that never changes",pick:false,note:"wrong home for the bytes &mdash; write-once blobs waste its mutability/compaction/secondary-index machinery and cost multiples per TB; but it is exactly right for the small metadata index."},
    ],
    indexing:"Split storage from lookup: keep the bytes in dumb blob storage and put a <strong>separate small metadata index</strong> beside them &mdash; one narrow row per page, <code>url_hash &rarr; storage_url (object key), content_hash, http_status, fetched_at</code>. That index <em>is</em> the sweet spot for a wide-column / KV store (Cassandra, Bigtable, DynamoDB): tiny uniform rows, point lookups, high write rate.<span class='eg'>30B rows &times; ~100 bytes &approx; ~3TB &mdash; trivially sharded, versus the 500TB of blobs it points at.</span>Dedup probes <code>content_hash</code> in the ~3TB index at memory speed (O(1)) and drops duplicates without ever touching object storage; lookups resolve <code>url_hash</code> to its object key. Large immutable blobs favour object storage over a row DB because a row engine would pay for compaction, mutability, and per-node capacity limits this workload never uses &mdash; bytes belong in blob storage, the DB holds pointers to bytes.",
    decision:"Pick <strong>managed object storage for the raw/compressed blobs (packed into WARC containers for batch reads), fronted by a small wide-column/KV metadata index for lookups and dedup.</strong> The workload is write-once ~16KB blobs, read by key or batch-scanned &mdash; exactly object storage's native shape. <strong>Not HDFS:</strong> 30B small objects exceed the NameNode's in-memory metadata ceiling (~4.5TB of heap), so it breaks on object count regardless of the ~50 DataNodes capacity would need. <strong>Not Cassandra/Bigtable for the bytes:</strong> write-once 16-100KB blobs waste its mutability/compaction machinery, cost multiples per TB, and need ~250-500 nodes fighting compaction &mdash; though it is exactly right for the ~3TB metadata index. Bytes in the blob store, pointers in the DB &mdash; each system does the one thing it is good at.",
  },
  schema:{tables:[
    {name:"frontier_queue",pk:"url_hash",columns:[
      ["url_hash","char(16)","canonical URL hash, primary key"],
      ["url","text","canonical URL to fetch"],
      ["host","varchar(255)","registered domain, drives partitioning"],
      ["priority","smallint","0 = highest (homepages) .. 4 = deep archive"],
      ["depth","int","hops from a seed URL"],
      ["scheduled_at","timestamptz","earliest time this URL may be fetched"],
    ],rows:[
      ["9f3a1c…","https://example.com/","example.com","0","0","2026-07-22 10:00:00"],
      ["b21e77…","https://example.com/products/42","example.com","2","1","2026-07-22 10:00:10"],
      ["4cd902…","https://news.example.org/live","news.example.org","0","0","2026-07-22 10:00:00"],
    ]},
    {name:"seen_urls",pk:"url_hash",columns:[
      ["url_hash","char(16)","canonical URL hash — membership key"],
      ["bloom_segment","int","which Bloom-filter shard holds this key"],
      ["first_seen_at","timestamptz","when the URL first entered the seen-set"],
    ],rows:[
      ["9f3a1c…","7","2026-07-22 09:59:50"],
      ["b21e77…","3","2026-07-22 10:00:11"],
    ]},
    {name:"pages",pk:"url_hash",columns:[
      ["url_hash","char(16)","canonical URL hash, primary key"],
      ["url","text","page URL"],
      ["content_hash","char(32)","SimHash / checksum for content dedup"],
      ["http_status","smallint","last fetch status code"],
      ["storage_url","text","object-store key for compressed raw HTML"],
      ["fetched_at","timestamptz","last successful fetch time"],
    ],rows:[
      ["9f3a1c…","https://example.com/","3b9d…c1","200","s3://raw/9f3a1c.gz","2026-07-22 10:00:05"],
      ["4cd902…","https://news.example.org/live","7ea0…9f","200","s3://raw/4cd902.gz","2026-07-22 10:00:04"],
    ]},
    {name:"host_politeness",pk:"host",columns:[
      ["host","varchar(255)","registered domain, primary key"],
      ["last_crawled_at","timestamptz","time of the most recent fetch to this host"],
      ["crawl_delay_ms","int","min gap between fetches (from robots.txt or default)"],
      ["robots_rules","text","parsed robots.txt disallow rules"],
      ["robots_fetched_at","timestamptz","when robots.txt was last cached"],
    ],rows:[
      ["example.com","2026-07-22 10:00:05","1000","disallow: /cart","2026-07-22 09:30:00"],
      ["news.example.org","2026-07-22 10:00:04","10000","disallow: /admin","2026-07-22 09:45:00"],
    ]},
    {name:"dns_cache",pk:"host",columns:[
      ["host","varchar(255)","hostname, primary key"],
      ["ip","varchar(45)","resolved A / AAAA address"],
      ["ttl_expires_at","timestamptz","when this entry must be re-resolved"],
    ],rows:[
      ["example.com","93.184.216.34","2026-07-22 10:05:00"],
      ["news.example.org","203.0.113.7","2026-07-22 10:03:30"],
    ]},
  ]},
  flows:[
    {id:"crawl",name:"Crawl one URL end-to-end",steps:[
      {node:"frontier",text:"Frontier pops the next due URL, chosen by priority and by the host whose politeness delay has elapsed."},
      {node:"dns",requires:["dns"],text:"Resolves the host to an IP via the DNS cache, falling through to the resolver only on a miss."},
      {node:"politeness",requires:["politeness"],text:"Checks robots.txt rules and the per-host crawl-delay; holds the URL if the host was fetched too recently."},
      {node:"fetcher",text:"Fetcher downloads the page over async IO with connect/read timeouts and a response-size cap."},
      {node:"parser",text:"Parser extracts visible text and metadata from the raw HTML."},
      {node:"store",requires:["store"],text:"Persists the compressed raw HTML plus extracted text and content_hash to the content store."},
    ]},
    {id:"discover",name:"Discover + enqueue new links",steps:[
      {node:"parser",text:"Parser pulls out outbound links and normalises each to a single canonical URL."},
      {node:"dedup",requires:["dedup"],text:"Checks each canonical URL against the Bloom-filter seen-set and drops any already crawled."},
      {node:"frontier",text:"Pushes the genuinely new URLs back into the frontier, scored and scheduled for a later fetch."},
    ]},
  ],
  deepFlows:[
    {id:"crawl-loop-e2e",name:"Crawl loop",summary:"**frontier_queue** leases the next host-eligible URL → DNS cache hit/miss → **host_politeness** gates robots + crawl-delay → async fetch → raw HTML reaches the parser → object storage + **pages** metadata commit.",steps:[
      {node:"frontier",title:"Lease the next polite URL",snap:{cap:"Lease query runs on <strong>host shard 47</strong> for <code>example.com</code>: priority order plus <code>scheduled_at &le; now</code>, then a SKIP-LOCKED-style lease flips this row from pending to leased in frontier bookkeeping. Polling is the host-partitioned table scan, not Kafka/SQS.",tables:[{name:"frontier_queue (host shard 47 · example.com)",note:"partition = hash(host)%200; lease uses row lock + visibility timeout",cols:["url_hash","url","host","priority","depth","scheduled_at"],rows:[{c:["9f3a1c…","https://example.com/","example.com","0","0","2026-07-22 10:00:00"],hi:1,tag:"pending→leased"},{c:["b21e77…","https://example.com/products/42","example.com","2","1","2026-07-22 10:00:10"]}]},{name:"host_politeness (same shard)",cols:["host","last_crawled_at","crawl_delay_ms","robots_rules"],rows:[{c:["example.com","2026-07-22 09:59:58","1000","disallow: /cart"],hi:1,tag:"eligible"}]}]},narrate:"The frontier is not FIFO: it picks a high-priority URL whose host is eligible to crawl now. Because each host maps to exactly one shard with <code>worker = hash(host) % 200</code>, the host's queue, in-flight lease, and rate state are local.",details:[
        {k:"query",label:"Pop from frontier_queue",lang:"sql",code:"-- On the worker that owns hash('example.com') % 200\nSELECT url_hash, url, host, priority, depth, scheduled_at\nFROM frontier_queue\nWHERE host = 'example.com'\n  AND scheduled_at <= now()\nORDER BY priority ASC, scheduled_at ASC\nLIMIT 1;\n-- then mark url_hash=9f3a1c… leased/in-flight with a visibility timeout"},
        {k:"route",label:"Why partition by host",lang:"text",code:"owner_worker = hash(registered_domain) % 200\nexample.com -> worker 47\nnews.example.org -> worker 12",text:"Host affinity makes politeness cheap: no distributed lock is needed to prove only one worker is sending requests to <code>example.com</code>. The trade-off is domain skew; known mega-sites can be split by host+path-prefix buckets."},
        {k:"repl",label:"Frontier durability",text:"The frontier is disk-backed (RocksDB/distributed queue). Dequeue is a **lease, not delete**: if a fetcher dies, the lease expires and the URL becomes visible again. At-least-once may double-fetch rarely; losing a discovered URL is the failure we avoid."},
        {k:"queue",label:"How the DB-backed frontier is polled",lang:"sql",code:"-- host shard 47 owns example.com\nBEGIN;\nSELECT url_hash, url, host, priority, depth, scheduled_at\nFROM frontier_queue\nWHERE host = 'example.com' AND scheduled_at <= now()\nORDER BY priority ASC, scheduled_at ASC\nLIMIT 1 FOR UPDATE SKIP LOCKED;\n-- mark lease pending -> leased; commit; fetcher acks after store commit"},
        {k:"queue",label:"Partitioning trade-off",text:"The frontier is a table-backed priority queue partitioned by <code>host</code>, not a broker topic. Host affinity makes politeness local and lets each worker lease the highest-priority due URL for that host; throughput comes from many host shards in parallel, while one hot host is intentionally serialized."},
      ]},
      {node:"dns",title:"Resolve the host",snap:{cap:"DNS lookup is a read-only cache hit for <code>example.com</code>; the fetcher gets the IP without blocking on a recursive resolver. <strong>Membership check, no mutation.</strong>",tables:[{name:"dns_cache (host shard 47)",cols:["host","ip","ttl_expires_at"],rows:[{c:["example.com","93.184.216.34","2026-07-22 10:05:00"],hi:1,tag:"cache hit"},{c:["news.example.org","203.0.113.7","2026-07-22 10:03:30"]}]},{name:"frontier_queue (leased context)",cols:["url_hash","url","host","priority","depth","scheduled_at"],rows:[{c:["9f3a1c…","https://example.com/","example.com","0","0","2026-07-22 10:00:00"],hi:1,tag:"leased"}]}]},narrate:"Before opening a socket, the fetcher asks the resolver cache for the host's IP. At ~12K pages/s, resolving every page would be fatal; the crawler expects >99% hits because the same hosts are revisited constantly.",details:[
        {k:"query",label:"DNS cache lookup",lang:"sql",code:"SELECT ip, ttl_expires_at\nFROM dns_cache\nWHERE host = 'example.com'\n  AND ttl_expires_at > now();\n-- miss: async query own recursive resolver, then upsert host/ip/ttl_expires_at"},
        {k:"note",label:"Capacity math",text:"The file's target is **~12K fetches/s**, but only ~50 new hosts/s in steady state. Caching turns 12K implied DNS lookups/s into roughly **50-100 real misses/s**, and each worker only holds its domain-shard's tens-of-MB working set."},
      ]},
      {node:"politeness",title:"Gate on robots and crawl-delay",snap:{cap:"Robots allows <code>/</code> and the last crawl was more than 1000ms ago, so the host slot is reserved. <code>host_politeness.last_crawled_at</code> advances to the fetch time before the socket opens.",tables:[{name:"host_politeness (host shard 47)",cols:["host","last_crawled_at","crawl_delay_ms","robots_rules","robots_fetched_at"],rows:[{c:["example.com","2026-07-22 10:00:05","1000","disallow: /cart","2026-07-22 09:30:00"],hi:1,tag:"slot reserved"},{c:["news.example.org","2026-07-22 10:00:04","10000","disallow: /admin","2026-07-22 09:45:00"]}]},{name:"frontier_queue (leased URL)",cols:["url_hash","url","host","priority","depth","scheduled_at"],rows:[{c:["9f3a1c…","https://example.com/","example.com","0","0","2026-07-22 10:00:00"],hi:1,tag:"allowed"}]}]},narrate:"The fetcher must prove the URL is allowed and the host's minimum interval has elapsed. If <code>robots.txt</code> is stale or unknown, the safe behavior is to defer or fetch robots first, not crawl blind.",details:[
        {k:"query",label:"Host politeness row",lang:"sql",code:"SELECT last_crawled_at, crawl_delay_ms, robots_rules, robots_fetched_at\nFROM host_politeness\nWHERE host = 'example.com';\n\n-- eligible only if path allowed by robots_rules AND\n-- now() >= last_crawled_at + crawl_delay_ms * interval '1 millisecond'"},
        {k:"query",label:"Reserve this host slot",lang:"sql",code:"UPDATE host_politeness\nSET last_crawled_at = now()\nWHERE host = 'example.com'\n  AND now() >= last_crawled_at + crawl_delay_ms * interval '1 millisecond'\nRETURNING host;\n-- 0 rows => re-schedule frontier_queue.scheduled_at to the next eligible time"},
        {k:"gotcha",label:"Politeness vs throughput",text:"The crawler may have 200K URLs for a host, but <code>Crawl-delay: 10</code> means **one request every 10s** to that host. Throughput comes from many hosts in parallel, not from hammering one host harder."},
      ]},
      {node:"fetcher",title:"Fetch with bounded resources",snap:{cap:"The fetcher downloads <code>https://example.com/</code> at the resolved IP under timeouts and the 10MB cap. Frontier state remains leased until parse/store completes; no new DB row is written by the HTTP read itself.",tables:[{name:"frontier_queue (in-flight lease)",cols:["url_hash","url","host","priority","depth","scheduled_at"],rows:[{c:["9f3a1c…","https://example.com/","example.com","0","0","2026-07-22 10:00:00"],hi:1,tag:"in-flight"}]},{name:"dns_cache (used)",cols:["host","ip","ttl_expires_at"],rows:[{c:["example.com","93.184.216.34","2026-07-22 10:05:00"],hi:1,tag:"connect"}]}]},narrate:"The fetcher uses async I/O, timeouts, redirect limits, and a ~10MB body cap. It sends a clear crawler User-Agent and backs off immediately on <code>429</code> or <code>Retry-After</code>.",details:[
        {k:"wire",label:"HTTP request",lang:"http",code:"GET / HTTP/1.1\nHost: example.com\nUser-Agent: SearchCrawler/1.0 (+https://crawler.example/contact)\nAccept: text/html,*/*;q=0.8\nIf-None-Match: \"prev-etag-if-recrawl\"\n\n-- connect/read timeout; stop reading after ~10MB"},
        {k:"note",label:"Fetcher sizing",text:"Little's law: **12K pages/s × ~400ms ≈ 4.8K sockets** fleet-wide. The repo still uses ~200 workers for host partitioning, locality, and blast radius, not because raw I/O throughput needs 200 boxes."},
      ]},
      {node:"parser",title:"Parse raw HTML and extract signals",snap:{cap:"Parser emits canonical outlinks and a content fingerprint for the leased page. This step is CPU-only; durable mutations happen when outlinks hit <code>seen_urls/frontier_queue</code> and bytes hit <code>pages</code>.",tables:[{name:"pages (candidate metadata)",cols:["url_hash","url","content_hash","http_status","storage_url","fetched_at"],rows:[{c:["9f3a1c…","https://example.com/","3b9d…c1","200","<em>pending object PUT</em>","2026-07-22 10:00:05"],hi:1,tag:"parsed"}]},{name:"frontier_queue (lease context)",cols:["url_hash","url","host","priority","depth","scheduled_at"],rows:[{c:["9f3a1c…","https://example.com/","example.com","0","0","2026-07-22 10:00:00"],hi:1,tag:"ready to ack"}]}]},narrate:"The parser receives raw bytes, extracts visible text and outlinks, canonicalizes URLs, and computes content fingerprints. Static HTML parsing is the default path; JS rendering is reserved for domains that prove they need it.",details:[
        {k:"wire",label:"Fetcher → parser message",lang:"json",code:"{\n  \"url_hash\": \"9f3a1c…\",\n  \"url\": \"https://example.com/\",\n  \"host\": \"example.com\",\n  \"http_status\": 200,\n  \"fetched_at\": \"2026-07-22T10:00:05Z\",\n  \"raw_html_gzip\": \"<bytes>\"\n}"},
        {k:"note",label:"CPU budget",text:"At ~20ms CPU/page, **12K pages/s needs ~240 parser cores**. Rendering every page at 100ms-1s would require thousands of cores, so the render path must be opt-in."},
      ]},
      {node:"store",title:"Persist bytes and crawl metadata",snap:{cap:"Raw bytes land in object storage and the compact <code>pages</code> row is upserted with the exact schema fields. After this durable boundary, the frontier lease can be acknowledged/removed.",tables:[{name:"pages",cols:["url_hash","url","content_hash","http_status","storage_url","fetched_at"],rows:[{c:["9f3a1c…","https://example.com/","3b9d…c1","200","s3://raw/2026/07/22/9f/3a/1c.warc.gz","2026-07-22 10:00:05"],hi:1,tag:"upserted"},{c:["4cd902…","https://news.example.org/live","7ea0…9f","200","s3://raw/4cd902.gz","2026-07-22 10:00:04"]}]},{name:"frontier_queue (host shard 47)",cols:["url_hash","url","host","priority","depth","scheduled_at"],rows:[{c:["9f3a1c…","https://example.com/","example.com","0","0","2026-07-22 10:00:00"],gone:1,tag:"lease acked"},{c:["b21e77…","https://example.com/products/42","example.com","2","1","2026-07-22 10:00:10"]}]}]},narrate:"The raw compressed page is packed into WARC/object storage; the small lookup row lands in the <code>pages</code> metadata index. The object key is derived from the URL hash and crawl time so writes are idempotent and versions do not overwrite each other.",details:[
        {k:"query",label:"Object-store PUT",lang:"http",code:"PUT /raw/2026/07/22/9f/3a/1c.warc.gz HTTP/1.1\nContent-MD5: <body checksum>\n\n-- contains compressed raw HTML + WARC headers for url_hash=9f3a1c…"},
        {k:"query",label:"pages metadata row",lang:"sql",code:"INSERT INTO pages\n  (url_hash, url, content_hash, http_status, storage_url, fetched_at)\nVALUES\n  ('9f3a1c…', 'https://example.com/', '3b9d…c1', 200,\n   's3://raw/2026/07/22/9f/3a/1c.warc.gz', '2026-07-22 10:00:05')\nON CONFLICT (url_hash) DO UPDATE\nSET content_hash = excluded.content_hash,\n    http_status = excluded.http_status,\n    storage_url = excluded.storage_url,\n    fetched_at = excluded.fetched_at;"},
        {k:"repl",label:"Durability",text:"Raw pages are expensive to re-collect politely, so object storage uses **3× replication or erasure coding** across failure domains (~11 nines). The metadata index is much smaller (~30B × ~100B ≈ 3TB) and replicated separately."},
      ]},
    ]},
    {id:"discover-enqueue-e2e",name:"Discover links",summary:"Parser emits ~10 links/page → canonicalize → **Bloom + seen_urls** prevents URL re-crawl → trap rules cap infinite spaces → new URLs are inserted into **frontier_queue** on the host shard with priority and earliest polite time.",steps:[
      {node:"parser",title:"Canonicalize extracted outlinks",snap:{cap:"Two raw links collapse into canonical URLs before any seen-set probe. No durable mutation yet; this prevents variants like tracking params/fragments from occupying separate frontier rows.",tables:[{name:"frontier_queue (candidate rows)",cols:["url_hash","url","host","priority","depth","scheduled_at"],rows:[{c:["b21e77…","https://example.com/products/42","example.com","2","1","<em>not inserted yet</em>"],hi:1,tag:"canonical"},{c:["4cd902…","https://news.example.org/live","news.example.org","0","1","<em>candidate</em>"]}]}]},narrate:"A fetched page can produce dozens of spellings for the same target URL. Canonicalization happens before dedup so the frontier only ever sees one key for one page.",details:[
        {k:"wire",label:"Parser outlink batch",lang:"json",code:"{\n  \"source_url_hash\": \"9f3a1c…\",\n  \"outlinks\": [\n    { \"raw\": \"/products/42?utm=ad#reviews\", \"canonical\": \"https://example.com/products/42\", \"depth\": 1 },\n    { \"raw\": \"https://news.example.org/live\", \"canonical\": \"https://news.example.org/live\", \"depth\": 1 }\n  ]\n}"},
        {k:"note",label:"Why upstream canonicalization",text:"Lowercase scheme/host, strip fragments/tracking params, resolve relative paths, and honor <code>rel=canonical</code>. Doing this before enqueue prevents <code>/b?utm=x#top</code> and <code>/b</code> from consuming two frontier slots."},
      ]},
      {node:"dedup",title:"Probe the Bloom filter",snap:{cap:"Bloom segment 3 is probed for <code>b21e77…</code>. It says not present, so the in-memory segment is marked and the flow may continue; this is a membership check with no durable backing-store write yet.",tables:[{name:"seen_urls (segment 3 backing rows)",note:"membership check, no mutation",cols:["url_hash","bloom_segment","first_seen_at"],rows:[{c:["b21e77…","3","<em>absent before probe</em>"],hi:1,tag:"not present"},{c:["9f3a1c…","7","2026-07-22 09:59:50"]}]},{name:"frontier_queue (not touched)",cols:["url_hash","url","host","priority","depth","scheduled_at"],rows:[{c:["b21e77…","https://example.com/products/42","example.com","2","1","<em>pending admission</em>"],hi:1}]}]},narrate:"The hot URL-seen check is probabilistic and local to the host shard. With ~30B URLs, the Bloom filter is the difference between a ~37GB fleet-wide structure and a multi-TB exact set.",details:[
        {k:"query",label:"Bloom membership test",lang:"python",code:"url = 'https://example.com/products/42'\nurl_hash = hash64(canonicalize(url))       # b21e77…\nworker = hash('example.com') % 200         # same shard as frontier\nsegment = bloom_segment(url_hash)          # e.g. 3\n\nif bloom[segment].probably_contains(url_hash):\n    drop('probably already seen')\nelse:\n    bloom[segment].add(url_hash)\n    continue_to_exact_record_and_enqueue()"},
        {k:"gotcha",label:"False positives",text:"A Bloom false positive skips a genuinely new URL. The file's target is **~10 bits/URL, <1% FP**: a tiny coverage loss is acceptable because it keeps the seen-set feasible and avoids wasting the 12K pages/s fetch budget on repeats."},
      ]},
      {node:"dedup",title:"Record first-seen in the backing store",snap:{cap:"The durable seen record is inserted exactly once. If another parser races this URL, the <code>url_hash</code> conflict makes it skip the frontier enqueue.",tables:[{name:"seen_urls",cols:["url_hash","bloom_segment","first_seen_at"],rows:[{c:["9f3a1c…","7","2026-07-22 09:59:50"]},{c:["b21e77…","3","2026-07-22 10:00:06"],hi:1,tag:"first-seen"}]},{name:"frontier_queue (candidate)",cols:["url_hash","url","host","priority","depth","scheduled_at"],rows:[{c:["b21e77…","https://example.com/products/42","example.com","2","1","<em>not inserted yet</em>"],hi:1}]}]},narrate:"The Bloom filter is the fast admission gate; <code>seen_urls</code> is the durable backing record used for migration, audits, and high-value exact checks. The row uses the exact schema's <code>url_hash</code>, <code>bloom_segment</code>, and <code>first_seen_at</code>.",details:[
        {k:"query",label:"seen_urls insert",lang:"sql",code:"INSERT INTO seen_urls (url_hash, bloom_segment, first_seen_at)\nVALUES ('b21e77…', 3, now())\nON CONFLICT (url_hash) DO NOTHING;\n-- inserted => this worker won first admission\n-- conflict => another parser already discovered it; skip frontier enqueue"},
        {k:"repl",label:"Migration-safe seen state",text:"Seen state is partitioned by the same <code>hash(host)%200</code> as the frontier. On worker migration, the Bloom segment can be loaded or OR-merged on the target; no global 200K URL-checks/s network round-trip is needed."},
      ]},
      {node:"frontier",title:"Apply trap and admission policy",snap:{cap:"Admission keeps the new product URL because depth=1 and the host budget is healthy. This is a policy read/check; no row is appended until the next step.",tables:[{name:"frontier_queue (host shard 47 · example.com)",note:"policy check, no mutation",cols:["url_hash","url","host","priority","depth","scheduled_at"],rows:[{c:["b21e77…","https://example.com/products/42","example.com","2","1","<em>admitted candidate</em>"],hi:1,tag:"allowed"},{c:["9f3a1c…","https://example.com/","example.com","0","0","2026-07-22 10:00:00"]}]},{name:"seen_urls",cols:["url_hash","bloom_segment","first_seen_at"],rows:[{c:["b21e77…","3","2026-07-22 10:00:06"],hi:1,tag:"seen ok"}]}]},narrate:"Dedup only catches repeats; spider traps create truly unique URLs. Before insert, the frontier enforces depth, per-domain budget, and pattern rules so one calendar/faceted site cannot fill the 3B-URL frontier alone.",details:[
        {k:"gotcha",label:"Infinite URL spaces",text:"A URL like <code>?date=2099-12</code> may be unique forever, so Bloom cannot save you. Cap each domain's admitted URLs, set a max crawl depth, and throttle hosts whose fetched pages have a high SimHash near-duplicate rate."},
        {k:"note",label:"Growth math",text:"Fetch is **~12K pages/s**, while discovery can be **~120K candidate links/s** (~10 links/page). Admission control is what prevents the 600GB planned frontier from becoming unbounded trap junk."},
      ]},
      {node:"frontier",title:"Insert new URL on the host shard",snap:{cap:"The admitted URL is appended to <strong>host shard 47</strong> with priority 2, depth 1, and earliest polite fetch time 10:00:10. Pollers later lease it with the same host-partitioned, priority-ordered SKIP-LOCKED query.",tables:[{name:"frontier_queue (host shard 47 · example.com)",note:"partition = hash(example.com)%200; priority ordered within the host shard",cols:["url_hash","url","host","priority","depth","scheduled_at"],rows:[{c:["9f3a1c…","https://example.com/","example.com","0","0","2026-07-22 10:00:00"],gone:1,tag:"fetched"},{c:["b21e77…","https://example.com/products/42","example.com","2","1","2026-07-22 10:00:10"],hi:1,tag:"appended"}]},{name:"host_politeness",cols:["host","last_crawled_at","crawl_delay_ms","robots_rules"],rows:[{c:["example.com","2026-07-22 10:00:05","1000","disallow: /cart"],hi:1,tag:"sets earliest time"}]}]},narrate:"A genuinely new, admitted URL is inserted into <code>frontier_queue</code> with its canonical URL, host, priority, depth, and earliest fetch time. The scheduled time is at least the host's next polite slot.",details:[
        {k:"query",label:"frontier_queue insert",lang:"sql",code:"INSERT INTO frontier_queue\n  (url_hash, url, host, priority, depth, scheduled_at)\nVALUES\n  ('b21e77…', 'https://example.com/products/42', 'example.com',\n   2, 1, greatest(now(), '2026-07-22 10:00:10'::timestamptz))\nON CONFLICT (url_hash) DO NOTHING;"},
        {k:"route",label:"Priority + politeness split",text:"Priority (0 homepage … 4 deep archive) decides **what is worth crawling**; <code>scheduled_at</code> and the per-host back queue decide **when it is polite**. A single FIFO would lose both signals."},
        {k:"queue",label:"How a URL is added to the frontier",lang:"sql",code:"-- routed by host: hash('example.com') % 200 -> shard 47\nINSERT INTO frontier_queue (url_hash, url, host, priority, depth, scheduled_at)\nVALUES ('b21e77…', 'https://example.com/products/42', 'example.com', 2, 1, '2026-07-22 10:00:10Z')\nON CONFLICT (url_hash) DO NOTHING;\n-- later pollers lease ordered by priority, scheduled_at with SKIP LOCKED"},
        {k:"queue",label:"What else is on the host shard",text:"The appended row sits behind any higher-priority due rows for <code>example.com</code>. It never goes to a Kafka/SQS partition; the host shard's table rows plus <code>host_politeness</code> are the queue state and the polling mechanism."},
      ]},
    ]},
    {id:"index-dedup-e2e",name:"Index dedup",summary:"Parsed content gets a **content_hash / SimHash** → exact and near-duplicate probes avoid re-indexing boilerplate clones → unique pages write WARC bytes plus the **pages** row, while duplicates point at the canonical copy.",steps:[
      {node:"parser",title:"Fingerprint normalized content",snap:{cap:"Normalized text for <code>news.example.org/live</code> yields content hash <code>7ea0…9f</code> and SimHash. No durable write yet; these fingerprints drive the exact and near-dup probes.",tables:[{name:"pages (candidate metadata)",cols:["url_hash","url","content_hash","http_status","storage_url","fetched_at"],rows:[{c:["4cd902…","https://news.example.org/live","7ea0…9f","200","<em>pending dedup</em>","2026-07-22 10:00:04"],hi:1,tag:"fingerprinted"}]}]},narrate:"After boilerplate stripping, the parser computes fingerprints over the extracted text: an exact checksum for byte-equivalent content and a SimHash for near-duplicates like print views, mirrors, and pages differing only by ads.",details:[
        {k:"wire",label:"Parsed document",lang:"json",code:"{\n  \"url_hash\": \"4cd902…\",\n  \"url\": \"https://news.example.org/live\",\n  \"http_status\": 200,\n  \"text_bytes\": 16384,\n  \"content_hash\": \"7ea0…9f\",\n  \"simhash\": \"7ea09f12cafe8890\"\n}"},
        {k:"note",label:"Why not exact hash only",text:"Exact hashes miss near-duplicates that differ by timestamps, nav, or rotating ads. SimHash preserves similarity, so pages with mostly the same extracted text land close in Hamming space."},
      ]},
      {node:"dedup",title:"Probe exact content duplicates",snap:{cap:"The <code>pages</code> metadata index is probed by <code>content_hash</code>. Here the existing row is the same URL/version context, so the unique path continues; this is a read-only duplicate check.",tables:[{name:"pages (content_hash index)",note:"membership check, no mutation",cols:["url_hash","url","content_hash","storage_url","fetched_at"],rows:[{c:["4cd902…","https://news.example.org/live","7ea0…9f","s3://raw/4cd902.gz","2026-07-22 10:00:04"],hi:1,tag:"probe"},{c:["9f3a1c…","https://example.com/","3b9d…c1","s3://raw/9f3a1c.gz","2026-07-22 10:00:05"]}]}]},narrate:"The metadata index is small enough for fast point lookups. A content hash hit means the bytes/content are already represented in the corpus, so the indexer can attach this URL as a duplicate instead of re-indexing another copy.",details:[
        {k:"query",label:"Exact content_hash lookup",lang:"sql",code:"SELECT url_hash, storage_url, fetched_at\nFROM pages\nWHERE content_hash = '7ea0…9f'\nLIMIT 1;\n-- hit  => record duplicate/canonical relationship, skip raw-byte write if policy allows\n-- miss => continue to near-duplicate probe"},
        {k:"route",label:"Why this is in metadata, not blobs",text:"The <code>pages</code> index is ~3TB (30B × ~100B) and point-queryable; object storage is ~500TB of compressed blobs and should not be listed/scanned for dedup. Bytes in blobs, pointers/fingerprints in the DB."},
      ]},
      {node:"dedup",title:"Probe near-duplicates with LSH buckets",snap:{cap:"LSH bucket probes compare only candidates sharing a SimHash band instead of scanning billions of pages. No <code>pages</code> mutation occurs unless a canonical duplicate decision is recorded downstream.",tables:[{name:"pages (near-dup candidates)",note:"LSH membership check, no mutation",cols:["url_hash","url","content_hash","fetched_at"],rows:[{c:["4cd902…","https://news.example.org/live","7ea0…9f","2026-07-22 10:00:04"],hi:1,tag:"candidate"},{c:["9f3a1c…","https://example.com/","3b9d…c1","2026-07-22 10:00:05"]}]}]},narrate:"For SimHash, brute-forcing against billions of pages is impossible. Split the fingerprint into bands and only compare candidates sharing a band; it is approximate but catches the duplicate patterns that waste index space and reveal crawler traps.",details:[
        {k:"query",label:"LSH bucket lookup",lang:"python",code:"sim = '7ea09f12cafe8890'\nbands = split_into_bands(sim, bands=4)\ncandidates = []\nfor band_no, band_value in enumerate(bands):\n    candidates += lsh_index.get((band_no, band_value))\n\nnear_dups = [c for c in candidates if hamming(c.simhash, sim) <= 3]"},
        {k:"gotcha",label:"Trap feedback",text:"If a host's freshly fetched pages are mostly near-duplicates, it looks like a trap or low-value template space. Feed that duplicate rate back to frontier admission and lower that host's URL budget."},
      ]},
      {node:"store",title:"Write the unique raw page",snap:{cap:"The page is unique enough, so compressed bytes are written to the WARC/object key. The <code>pages</code> row is still pending until the metadata upsert in the next step.",tables:[{name:"pages (pending metadata)",cols:["url_hash","url","content_hash","http_status","storage_url","fetched_at"],rows:[{c:["4cd902…","https://news.example.org/live","7ea0…9f","200","s3://raw/2026/07/22/4c/d9/02.warc.gz","<em>pending upsert</em>"],hi:1,tag:"bytes written"}]}]},narrate:"If the page is unique enough, store the compressed raw HTML in WARC/object storage. Packing many pages per object avoids the HDFS-style small-file metadata wall for 30B pages.",details:[
        {k:"query",label:"WARC/object key",lang:"text",code:"storage_url = s3://raw/2026/07/22/4c/d9/02.warc.gz\nkey prefix = hash(url_hash)[0:2]/hash(url_hash)[2:4]/...\nobject contains many WARC records, including url_hash=4cd902…"},
        {k:"repl",label:"Replication and versioning",text:"Object storage gives **3× replication or erasure coding**. Writes are immutable/versioned, so a bad crawl writes a new version instead of overwriting good bytes; checksums catch corruption on write/read."},
      ]},
      {node:"store",title:"Upsert the pages index row",snap:{cap:"The metadata index now points <code>url_hash=4cd902…</code> at the object key with content hash and fetch timestamp. Future recrawls and dedup checks use this compact row instead of scanning blobs.",tables:[{name:"pages",cols:["url_hash","url","content_hash","http_status","storage_url","fetched_at"],rows:[{c:["9f3a1c…","https://example.com/","3b9d…c1","200","s3://raw/9f3a1c.gz","2026-07-22 10:00:05"]},{c:["4cd902…","https://news.example.org/live","7ea0…9f","200","s3://raw/2026/07/22/4c/d9/02.warc.gz","2026-07-22 10:00:04"],hi:1,tag:"upserted"}]}]},narrate:"The search-index pipeline and future recrawls read the <code>pages</code> metadata row by <code>url_hash</code>. It records the latest <code>content_hash</code>, status, object key, and fetch timestamp using the exact schema fields.",details:[
        {k:"query",label:"pages upsert",lang:"sql",code:"INSERT INTO pages\n  (url_hash, url, content_hash, http_status, storage_url, fetched_at)\nVALUES\n  ('4cd902…', 'https://news.example.org/live', '7ea0…9f', 200,\n   's3://raw/2026/07/22/4c/d9/02.warc.gz', now())\nON CONFLICT (url_hash) DO UPDATE\nSET content_hash = excluded.content_hash,\n    http_status = excluded.http_status,\n    storage_url = excluded.storage_url,\n    fetched_at = excluded.fetched_at;"},
        {k:"note",label:"Freshness signal",text:"If the new <code>content_hash</code> matches the previous one, the scheduler learns the page did not change and can back off its recrawl cadence; news pages that change often stay high priority."},
      ]},
      {node:"store",title:"Hand off to indexing without blocking crawl",snap:{cap:"After the store commit, the indexer can read/replay from object storage using the <code>pages</code> row. The crawler is free to continue; if indexing lags, this durable boundary prevents an impolite re-crawl.",tables:[{name:"pages (indexer reads)",cols:["url_hash","url","content_hash","http_status","storage_url","fetched_at"],rows:[{c:["4cd902…","https://news.example.org/live","7ea0…9f","200","s3://raw/2026/07/22/4c/d9/02.warc.gz","2026-07-22 10:00:04"],hi:1,tag:"ready"},{c:["9f3a1c…","https://example.com/","3b9d…c1","200","s3://raw/9f3a1c.gz","2026-07-22 10:00:05"]}]}]},narrate:"The crawler should not stall if the downstream indexer is slow. Store commit is the durable boundary; indexing can consume pages or WARC batches asynchronously and replay from the object store if its extraction logic changes.",details:[
        {k:"wire",label:"Indexing event",lang:"json",code:"{\n  \"type\": \"page_stored\",\n  \"url_hash\": \"4cd902…\",\n  \"content_hash\": \"7ea0…9f\",\n  \"storage_url\": \"s3://raw/2026/07/22/4c/d9/02.warc.gz\",\n  \"fetched_at\": \"2026-07-22T10:00:04Z\"\n}"},
        {k:"gotcha",label:"Store outage policy",text:"If object storage stalls, buffer parsed pages in a durable log and apply backpressure before the log fills. Dropping parsed pages would force an impolite re-crawl; slowing new fetches is cheaper and safer."},
      ]},
    ]},
  ],
  requirements:{
    functional:[
      "Crawl outward from a set of seed URLs, downloading every page reached",
      "Extract outbound links from each page to discover and queue more pages",
      "Store raw and extracted page content for the search-index pipeline",
      "Skip URLs and content already crawled so no page is fetched twice",
    ],
    nonFunctional:[
      "Scale to billions of pages — ~30B pages at ~12K pages/s sustained, ~3PB raw",
      "Stay polite — never overload a host, and honour robots.txt and Crawl-delay",
      "Survive traps, duplicates, and malformed pages without wasting fetch budget",
      "Keep content reasonably fresh — recrawl pages roughly as often as they change",
    ],
  },
  reqBuild:[
    {req:"Fetch pages starting from seed URLs",turns:[
      {who:"intv",text:"Requirement one, the skeleton: crawl outward from a handful of seed URLs. What is the smallest set of moving parts that gets a page downloaded and its links followed?"},
      {who:"cand",text:"The <strong>seed / scheduler</strong> pushes the start URLs into the <strong>URL frontier</strong>; a <strong>fetcher</strong> from the pool pulls a URL, downloads the page, and passes the bytes to the <strong>parser</strong>, which extracts links and loops them back into the frontier. That cycle — seed, frontier, fetch, parse, back to frontier — is a breadth-first walk of the web, and my four core boxes already express it.<span class='eg'>Seed with wikipedia.org; the parser finds ~300 outlinks, enqueues them, and the frontier feeds the next round of fetches — a classic BFS expansion.</span>"},
      {who:"intv",text:"Why give the waiting URLs their own box? Couldn't each fetcher just keep its own to-do list?"},
      {who:"cand",text:"Because discovery and fetching run at wildly different rhythms. One page can yield hundreds of links in a burst, while fetching is paced and IO-bound, so I want a queue that <strong>decouples discovery rate from fetch rate</strong> rather than letting that backlog pile up inside a fetcher's memory. A shared frontier keeps the fetchers as stateless workers that just ask for the next URL, and it becomes the single place I later bolt on priority ordering and politeness. For requirement one it is just a durable queue the scheduler seeds."},
    ],resources:[
      {title:"Hello Interview — web crawler",url:"https://www.hellointerview.com/learn/system-design/answer-keys/web-crawler"},
      {title:"Wikipedia — Web crawler",url:"https://en.wikipedia.org/wiki/Web_crawler"},
    ]},
    {req:"Extract links and store page content (adds a content store)",reveal:["store"],turns:[
      {who:"intv",text:"Requirement two: a downloaded page is useless until you pull its links out and keep its content somewhere. Walk the parser's outputs and add whatever they need to land in."},
      {who:"cand",text:"The parser emits two streams. <strong>Outlinks</strong> flow back into the frontier to keep the crawl expanding. <strong>Content</strong> — the extracted text plus page metadata, and the raw bytes — has nowhere to live in my core boxes, so let me add a <strong>content store</strong>. The parser writes the compressed raw HTML and the extracted text there, keyed by the page's URL, and the search-index pipeline reads from it downstream.<span class='eg'>One fetched article → title, language, and body text into the store for indexing, plus ~40 outlinks back to the frontier.</span>"},
      {who:"intv",text:"You are storing the raw HTML as well as the extracted text. Why keep the bytes once you have the text you wanted?"},
      {who:"cand",text:"Reprocessing without re-crawling. My extraction improves over time — better boilerplate stripping, new metadata, new models — and re-running it against stored raw HTML is far cheaper and politer than fetching billions of live pages again. The raw store is the crawler's <strong>replay log</strong>: fetch a page once, extract from it many times. Bytes are cheap; re-fetching is expensive and pounds other people's servers, so I only ever re-crawl for <em>freshness</em>, never to reprocess."},
    ],resources:[
      {title:"Hello Interview — web crawler",url:"https://www.hellointerview.com/learn/system-design/answer-keys/web-crawler"},
      {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
    ]},
    {req:"Avoid re-crawling duplicate URLs / near-duplicate content (adds dedup)",reveal:["dedup"],turns:[
      {who:"intv",text:"Requirement three: the same page is reachable through dozens of links, and the parser keeps handing you URLs you have already crawled. How do you stop fetching them a second time?"},
      {who:"cand",text:"Before any outlink enters the frontier I check it against a <strong>dedup / seen-set</strong> — let me add that box. Seen URLs are dropped; only genuinely new ones are enqueued, so a fetcher never burns budget re-downloading a page it already holds. The key is to <strong>normalise</strong> first — lowercase the host, resolve relative links to absolute, strip fragments and tracking params, honour <code>rel=canonical</code> — so the many spellings of one page collapse to a single canonical key the set can match.<span class='eg'>http://Example.com/a/../b?utm=x#top and https://example.com/b both normalise to one entry.</span>"},
      {who:"intv",text:"URL dedup catches the same address. What about two different URLs that serve identical or near-identical content?"},
      {who:"cand",text:"That is <strong>content dedup</strong>, a distinct problem — the URLs are legitimately different. For exact duplicates I fingerprint the normalised content with a checksum and keep one copy. For near-duplicates — a print view versus a web view, mirror sites, thin boilerplate pages — I use a similarity fingerprint like <strong>SimHash</strong> so pages within a small Hamming distance are treated as the same and linked to one canonical copy. How I actually build that seen-set at scale — a Bloom filter, partitioned per host — is a deep dive, but functionally: normalise, check, crawl only the new."},
    ],resources:[
      {title:"Wikipedia — Web crawler",url:"https://en.wikipedia.org/wiki/Web_crawler"},
      {title:"Hello Interview — web crawler",url:"https://www.hellointerview.com/learn/system-design/answer-keys/web-crawler"},
    ]},
  ],
  systemDives:[
    {title:"The crawler hammers one domain and its IP gets banned",tag:"failover",reveal:["politeness"],turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a worker finds <b>200K URLs</b> on one small host and fetches them flat out — <b>800 requests/s</b> at a single site. The origin buckles, its operator notices the flood, and blackholes your entire crawler IP range, cutting you off from that host <em>and</em> from unrelated sites sharing the same infrastructure. Contain it.</span>"},
      {who:"cand",text:"I effectively <strong>DDoSed</strong> the site — an unbounded per-host fetch rate is the root cause, and my core boxes have no throttle anywhere. I need a <strong>politeness / rate-limiting</strong> component in the fetch path; let me add it. The rule is simple: never fetch one host faster than a conservative rate — honour its <code>Crawl-delay</code> if robots.txt sets one, otherwise a safe default — no matter how many of its URLs I have queued. That single constraint makes an 800/s burst impossible by construction.<span class='eg'>Crawl-delay 10 means at most one fetch every 10s to that host, so 200K URLs drain slowly and politely instead of in one destructive spike.</span>"},
      {who:"intv",text:"Politeness stops the <em>next</em> ban. You are already blocked right now, and collateral hosts on that shared IP are gone too. What about the live damage?"},
      {who:"cand",text:"Two fronts. For the active ban: <strong>exponential backoff</strong> on 429/503, stop touching the host entirely for a cooldown, then re-approach gently; and ship a clear <code>User-Agent</code> with contact info so an operator can reach me instead of block-and-forget. For the collateral: I key politeness on <strong>IP as well as host</strong>, so when many hosts sit behind one IP (shared hosting or a CDN) I rate-limit the underlying server too and never overwhelm it through the back door. And I fetch and obey <code>robots.txt</code> up front, which often tells me not to crawl those paths at all."},
      {who:"intv",text:"Fetching robots.txt for every host and tracking per-host timing state costs fetches and memory. How does politeness stay cheap across a 200-worker fleet?"},
      {who:"cand",text:"Two moves. I <strong>cache robots.txt per host</strong> with a TTL and reuse it across all of that host's URLs, so it is one tiny fetch amortised over potentially millions of pages. More fundamentally, I <strong>partition the crawl by hash of the registered domain</strong> so every URL for a host is owned by exactly one worker. That worker holds the host's cached robots rules, last-fetch timestamps, and rate budget <em>locally</em>, so politeness is a per-worker decision with zero cross-worker coordination. Locality is what makes correctness cheap — no distributed lock on a host's rate, just single ownership."},
    ],resources:[
      {title:"The Robots Exclusion Protocol",url:"https://www.robotstxt.org/robotstxt.html"},
      {title:"Hello Interview — web crawler",url:"https://www.hellointerview.com/learn/system-design/answer-keys/web-crawler"},
    ]},
    {title:"DNS resolution latency dominates and throughput collapses",tag:"scaling",reveal:["dns"],turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> you profile a worker built to sustain <b>12K pages/s</b> and it is pinned at <b>3K/s</b>. CPU idle, network idle — yet every fetch blocks ~<b>200ms</b> on a <b>DNS lookup</b>, and your resolver is grinding through 12K queries/s. DNS is the wall. Fix it.</span>"},
      {who:"cand",text:"DNS is a hidden per-fetch cost that surfaces once everything else is async. The fix is a dedicated <strong>caching DNS resolver</strong> in front of the fetchers — let me add it. The vast majority of fetches hit hosts I have already resolved, so a cache with a sane TTL turns 12K lookups/s into a trickle of misses.<span class='eg'>12K pages/s across only ~50 distinct new hosts/s is a hit ratio above 99%, dropping DNS load from 12K/s to ~100/s.</span>I also make resolution <strong>async</strong> so a lookup never blocks the event loop, and pre-resolve hosts while their URLs are still sitting in the frontier."},
      {who:"intv",text:"A cache helps the warm case, but public resolvers will rate-limit you at crawl scale. Then what?"},
      {who:"cand",text:"Run my <strong>own recursive resolver</strong> fleet rather than leaning on a third party — I own the capacity and caching and I am not subject to anyone else's rate limit. I warm it with the hosts I am about to crawl, honour record TTLs but stretch them a little for stability, and shard resolvers behind the workers. Because the crawl is partitioned by domain, each worker's host set is stable and its DNS working-set is small and cache-friendly, so the coordination design and the DNS win reinforce each other."},
      {who:"intv",text:"A burst into many <em>new</em> domains tanks the hit ratio. How do you keep those misses from serialising and collapsing throughput all over again?"},
      {who:"cand",text:"A new-domain burst is a <strong>cache-miss storm</strong> where DNS goes serial and blocking. Three levers: <strong>(1) fully async, pipelined resolution</strong> so many lookups are in flight at once and a 200ms miss blocks only its own fetch, not the loop; <strong>(2) prefetch</strong> — resolve hosts while their URLs still wait in the frontier, so a URL's IP is cached by the time it is due; <strong>(3) scale resolvers horizontally</strong>, sized to the <em>new-host discovery rate</em> rather than total fetch rate, autoscaling on resolver queue depth. Domain partitioning also spreads a new-host burst across workers instead of dumping it on one."},
    ],resources:[
      {title:"Hello Interview — web crawler",url:"https://www.hellointerview.com/learn/system-design/answer-keys/web-crawler"},
      {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
    ]},
    {title:"The URL frontier grows to billions of URLs — won't fit in memory",tag:"scaling",turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> the crawl discovers links faster than it fetches them. The frontier balloons to <b>3 billion URLs</b>; at ~200 bytes each that is <b>600GB</b> — it will not fit in any worker's RAM. What now?</span>"},
      {who:"cand",text:"The frontier becomes <strong>disk-backed with a memory hot-set</strong>. I keep in RAM only what the next fetch decisions need — the host heap of next-allowed-fetch times and the heads of the active back queues — and spill the bulk of enqueued URLs to a <strong>persistent store</strong>, an embedded LSM store like RocksDB per worker or a distributed queue. Pages of the queue are pulled in as hosts become due.<span class='eg'>600GB across 200 workers is ~3GB each; RAM holds the heap and queue heads (a few hundred MB) while disk holds the long tail.</span>"},
      {who:"intv",text:"It is 3 billion and still climbing. Is the unbounded growth itself the actual bug here?"},
      {who:"cand",text:"Usually, yes — runaway growth almost always means I am enqueuing junk: traps and low-value infinite spaces. So I bound it with policy, not just storage: <strong>per-domain URL caps</strong>, a <strong>max depth</strong> from seed, and <strong>priority-based admission</strong> that drops low-value URLs rather than storing them when the frontier is under pressure. Storage absorbs legitimate scale; admission control stops pathological growth. If it keeps climbing after that, it is a signal to add fetch capacity, not frontier capacity."},
      {who:"intv",text:"With billions queued, how do you choose which URL a fetcher gets next — is it just FIFO off disk?"},
      {who:"cand",text:"No — a single FIFO fails both priority and politeness at once. I use the <strong>Mercator-style two-stage design</strong>: <strong>front queues</strong> capture <em>priority</em> (one queue per band, a URL routed by its score — homepages high, deep archive pages low) and <strong>back queues</strong> capture <em>politeness</em> (one queue per host). A min-heap of hosts keyed on each host's earliest next-allowed fetch time decides what a fetcher receives. Priority decides <em>which</em> URLs are eligible; politeness decides <em>when</em> — the two dimensions stay decoupled even at billions of entries."},
    ],resources:[
      {title:"Hello Interview — web crawler",url:"https://www.hellointerview.com/learn/system-design/answer-keys/web-crawler"},
      {title:"Wikipedia — Web crawler",url:"https://en.wikipedia.org/wiki/Web_crawler"},
    ]},
    {title:"A spider trap generates infinite unique URLs",tag:"durability",turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> one site has a calendar with 'next month' links running forever, plus faceted-search URLs for every filter combination. Within an hour it injects <b>40M unique URLs</b> — all real, all distinct, all worthless — into the frontier. URL dedup is useless because they are genuinely new. Contain it.</span>"},
      {who:"cand",text:"This is a <strong>crawler trap / infinite URL space</strong>, and dedup is the wrong tool since the URLs really are unique. Three defenses: <strong>(1) per-domain URL budget</strong> — cap how many URLs I will enqueue from one host, so 40M from a single site is impossible by construction; <strong>(2) max crawl depth</strong> — calendar 'next' chains die at depth K; <strong>(3) pattern detection</strong> — flag hosts producing URLs with runaway query-param cardinality or repeating path segments and de-prioritise or blacklist the pattern.<span class='eg'>Cap example.com at 500K URLs; a <code>?date=2099-12</code> calendar param beyond depth 8 is simply refused enqueue.</span>"},
      {who:"intv",text:"Budgets are blunt — a legitimately huge site with a big catalog also slams into the cap and gets under-crawled. How do you tell a trap from a big real site?"},
      {who:"cand",text:"Signal quality, not raw count. A real catalog's pages carry <strong>distinct content</strong>; a trap emits <strong>near-duplicate</strong> pages that content-dedup and SimHash flag as carrying near-zero new information. So I feed the <em>content-dedup rate</em> back into admission: if more than X% of a host's freshly fetched pages are near-duplicates of what I already hold, I throttle its enqueue budget hard, while a genuinely novel big site keeps its budget. Budgets are the blunt safety net; content similarity is the smart discriminator."},
      {who:"intv",text:"While all this churns, a worker restarts for a kernel patch. Do the tens of millions of discovered-but-unfetched URLs just vanish?"},
      {who:"cand",text:"They must not — rediscovery is expensive and non-deterministic, so frontier <strong>durability</strong> is a first-class requirement. Since the frontier is already disk-backed, an enqueue is a <strong>durable append</strong> and the worker just reopens its store and resumes after the restart. Dequeue is a <strong>lease with a visibility timeout</strong>, not a delete: a URL handed to a fetcher is marked in-flight, and if that worker dies mid-fetch the lease expires and the URL becomes visible again — <strong>at-least-once</strong> processing. A rare double-fetch is harmless (dedup catches it, and it is rate-limited anyway); a <em>lost</em> URL is the outcome I actually design against."},
    ],resources:[
      {title:"Wikipedia — Web crawler",url:"https://en.wikipedia.org/wiki/Web_crawler"},
      {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
    ]},
  ],
  q:{
    seed:[
      {l:"easy",tag:"concept",q:"How does a fresh crawl bootstrap?",turns:[
        {who:"intv",text:"'Seed / scheduler' is your entry point. I give you a brand-new crawl with an empty index. What lives in this box, and how does the crawl start?"},
        {who:"cand",text:"The <strong>seed set</strong> is a curated list of high-value start URLs — major site homepages, directory hubs, sitemaps — that give the crawl broad reach fast. The <strong>scheduler</strong> is the brain: it decides <em>what to crawl next and when</em>, seeding the frontier initially and later feeding recrawl work back in.<span class='eg'>Seed with ~10K hub URLs (wikipedia.org, major news, directory sites); each fans out to thousands of outlinks within one hop, so coverage snowballs.</span>The scheduler doesn't fetch — it enqueues into the <strong>frontier</strong> and enforces global policy like crawl budget per domain."},
        {who:"intv",text:"You said the scheduler decides priority. On what basis — every URL equal?"},
        {who:"cand",text:"No — I prioritise by estimated value: a domain-authority / PageRank-like signal, depth from seed (shallower is usually more important), and freshness need. A homepage outranks a deep paginated archive page. Priority is a <em>score</em> the frontier orders on, so limited fetch capacity spends on the highest-value pages first. Low-value infinite spaces get starved, which also helps against traps."},
      ],resources:[
        {title:"Hello Interview — web crawler",url:"https://www.hellointerview.com/learn/system-design/answer-keys/web-crawler"},
        {title:"Wikipedia — Web crawler",url:"https://en.wikipedia.org/wiki/Web_crawler"},
      ]},
      {l:"hard",tag:"scaling",q:"Split the crawl across a fleet without chaos.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> to hit 12K pages/s you run <b>200 crawler workers</b>. If any worker can grab any URL, two workers hit the same host at once, dedup races appear, and politeness is impossible to enforce globally. How do you divide the work?</span>"},
        {who:"cand",text:"<strong>Partition the URL space by hash of the registered domain</strong> — <code>worker = hash(domain) % N</code> — so every URL for a given host is owned by exactly one worker.<span class='eg'>All of example.com always routes to worker 47; nytimes.com always to worker 12.</span>This gives three wins at once: <strong>politeness</strong> becomes a <em>local</em> per-worker concern (one worker throttles a host, no cross-worker coordination), <strong>DNS and connection reuse</strong> get locality (the same worker keeps warm connections to its hosts), and dedup contention drops because a host's URLs converge on one place."},
        {who:"intv",text:"Hashing on domain — doesn't a giant multi-tenant host overload one worker?"},
        {who:"cand",text:"Yes, domain skew is the weakness — a few mega-domains can hot-spot one worker while others idle. Mitigations: hash on a finer key (domain + path-prefix bucket) for known giant hosts, and use <strong>consistent hashing</strong> so I can add workers and split a hot partition without reshuffling everything. The scheduler tracks per-worker queue depth and can rebalance ownership of specific domains off an overloaded worker."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"Hello Interview — web crawler",url:"https://www.hellointerview.com/learn/system-design/answer-keys/web-crawler"},
      ]},
      {l:"hard",tag:"failover",q:"The scheduler crashes — is the crawl lost?",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> the central scheduler process crashes after the crawl has run for 6 hours with <b>800M URLs in flight</b> across the frontier. Does the crawl lose all that progress and restart from seeds?</span>"},
        {who:"cand",text:"It must not. The scheduler's authoritative state — what's been enqueued, per-domain budgets, checkpoints — lives in <strong>durable storage</strong>, not process memory. The frontier itself is persistent (disk-backed / distributed queue), so a scheduler restart re-attaches to the existing frontier and resumes. I checkpoint crawl progress (frontier offsets, seen-set markers) periodically, so recovery reloads the last checkpoint, not seed-zero."},
        {who:"intv",text:"Checkpointing 800M URLs of state isn't free. How do you avoid a stop-the-world pause?"},
        {who:"cand",text:"I don't snapshot synchronously. The seen-set and frontier are already durable stores that stream writes; the 'checkpoint' is just a consistent marker (an offset/epoch) I advance, cheap to record. On top I run the scheduler as a <strong>replicated, leader-elected service</strong> (a standby takes over via ZooKeeper/Raft), so a crash is a sub-minute failover to a warm standby reading the same durable state — not a cold rebuild."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"Hello Interview — web crawler",url:"https://www.hellointerview.com/learn/system-design/answer-keys/web-crawler"},
      ]},
      {l:"medium",tag:"scaling",q:"When do you recrawl to stay fresh?",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a news homepage changes every few minutes; an archived PDF hasn't changed in 3 years. If you recrawl everything on a fixed 30-day cycle, news is stale and you waste 12K pages/s re-fetching dead pages. Design recrawl.</span>"},
        {who:"cand",text:"Freshness must be <strong>adaptive per-page</strong>, not a global cycle. I estimate each page's <strong>change rate</strong> from history — track content hashes across fetches and measure how often they differ — and set the recrawl interval inversely: a homepage that changes hourly is recrawled roughly hourly; a static PDF drifts out to monthly or slower.<span class='eg'>Change observed every fetch → interval shrinks toward minutes; unchanged for 10 fetches → interval doubles up toward a cap.</span>The scheduler feeds due-for-recrawl URLs back into the frontier at the appropriate priority."},
        {who:"intv",text:"That's reactive — you only learn a page changed after you fetch it. Any signal to avoid wasted fetches?"},
        {who:"cand",text:"Use cheap signals first: <strong>HTTP conditional requests</strong> (<code>If-Modified-Since</code> / <code>ETag</code>) so an unchanged page returns a 304 with no body — near-free freshness check. <strong>Sitemaps</strong> with <code>lastmod</code> and change-frequency hints tell me what moved without polling. And <code>Last-Modified</code> headers refine my estimate. So I combine model-based intervals with server hints to spend fetch budget only where content likely changed."},
      ],resources:[
        {title:"Wikipedia — Web crawler",url:"https://en.wikipedia.org/wiki/Web_crawler"},
        {title:"Hello Interview — web crawler",url:"https://www.hellointerview.com/learn/system-design/answer-keys/web-crawler"},
      ]},
      {l:"medium",tag:"capacity",q:"Size the scheduler — throughput and state.",turns:[
        {who:"intv",text:"Concrete numbers for the scheduler. It seeds the frontier and feeds recrawls back in. How much work does it push per second, and how big is the state it must hold to do that?"},
        {who:"cand",text:"The scheduler is control-plane, so I size it off the recrawl feed, not raw fetch IO. Seeding is a one-off trickle; the sustained job is deciding <em>what is due for recrawl</em> across 30B pages.<span class='eg'>30B pages refreshed ~monthly = ~1B/day ≈ 12K recrawl decisions/s — the same order as the fetch budget. Per-page schedule state (next-due time, change-rate estimate) at ~40 bytes × 30B ≈ 1.2TB — well past one node's RAM, so it is sharded, not in-memory on a single scheduler.</span>Throughput itself is easy; the state size is the real constraint."},
        {who:"intv",text:"1.2TB of timers just to decide when to recrawl feels heavy. What cuts it?"},
        {who:"cand",text:"I do not keep a per-page timer. Instead I bucket pages into a few <strong>change-rate tiers</strong> (hourly, daily, monthly) and drive recrawl off the tier plus a cheap priority score, so the hot state is just the small <em>due-soon</em> window in memory while the long tail lives on disk or is recomputed. The trade-off is precision — tier-based scheduling recrawls a page a little early or late versus an exact per-page model — but for freshness that error is invisible, and it turns 1.2TB of hot timers into a few GB of due-soon entries. So I size the scheduler for the due-soon working set, not the full corpus."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"Hello Interview — web crawler",url:"https://www.hellointerview.com/learn/system-design/answer-keys/web-crawler"},
      ]},
    ],
    frontier:[
      {l:"medium",tag:"concept",q:"Design the URL frontier.",turns:[
        {who:"intv",text:"The frontier is the heart of the crawler, and it's not just a FIFO queue. Design it — I want to hear how you balance <em>priority</em> against <em>politeness</em>."},
        {who:"cand",text:"Right, a single FIFO fails both goals. I use the <strong>Mercator-style two-stage design</strong>. <strong>Front queues</strong> capture <em>priority</em>: N queues, one per priority band; a URL routes to a band by its score. <strong>Back queues</strong> capture <em>politeness</em>: one queue per host, with an invariant that each back queue holds URLs for exactly one host. A back-queue selector picks which host to fetch next using a heap keyed on each host's <em>earliest next-allowed fetch time</em>.<span class='eg'>Front: band 0 (homepages) ... band 4 (deep archive). Back: the queue for example.com holds only example.com URLs, with next-fetch-at = now + crawlDelay.</span>"},
        {who:"intv",text:"Walk me through how a URL flows from enqueue to being handed to a fetcher."},
        {who:"cand",text:"On enqueue: score it → drop into the matching <strong>front</strong> queue. A router moves URLs from front to <strong>back</strong> queues, maintaining the one-host-per-back-queue invariant (creating a back queue for a new host). When a fetcher asks for work, a <strong>min-heap of hosts by next-allowed-time</strong> pops the host whose politeness delay has elapsed, hands its head URL to the fetcher, and re-inserts the host with an updated next-time. So priority decides <em>which URLs exist to pick</em> and politeness decides <em>when</em> — the two dimensions stay decoupled."},
      ],resources:[
        {title:"Hello Interview — web crawler",url:"https://www.hellointerview.com/learn/system-design/answer-keys/web-crawler"},
        {title:"Wikipedia — Web crawler",url:"https://en.wikipedia.org/wiki/Web_crawler"},
      ]},
      {l:"hard",tag:"scaling",q:"The frontier won't fit in memory.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> the crawl discovers links faster than it fetches. The frontier grows to <b>3 billion URLs</b>; at ~200 bytes each that's 600GB — it will not fit in the RAM of any worker. What now?</span>"},
        {who:"cand",text:"The frontier has to be <strong>disk-backed with a memory hot-set</strong>. Keep in RAM only what's needed for the next decisions: the host heap (next-fetch times) and the heads of active back queues. The bulk of enqueued URLs spill to a <strong>persistent store</strong> — an embedded LSM store like RocksDB per worker, or a distributed queue — and pages of the queue are read in as hosts become due.<span class='eg'>600GB across 200 workers = ~3GB each; RAM holds the heap + queue heads (a few hundred MB), disk holds the tail.</span>"},
        {who:"intv",text:"3 billion and climbing — what if it never stops growing? Is unbounded growth itself the bug?"},
        {who:"cand",text:"Often yes — unbounded growth usually means I'm enqueuing junk (traps, low-value infinite spaces). So I bound it with policy, not just storage: <strong>per-domain URL caps</strong>, <strong>max depth</strong> from seed, and priority-based admission so low-value URLs are dropped rather than stored when the frontier is under pressure. Storage handles legitimate scale; admission control stops pathological growth. If it's still growing after that, it's a signal to add fetch capacity, not frontier capacity."},
      ],resources:[
        {title:"Hello Interview — web crawler",url:"https://www.hellointerview.com/learn/system-design/answer-keys/web-crawler"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"hard",tag:"durability",q:"Does the frontier survive a restart?",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a worker owning <b>15M frontier URLs</b> is restarted for a kernel patch. If the frontier were in-memory only, those 15M discovered-but-not-yet-fetched URLs vanish — links you may not rediscover for weeks. How do you make the frontier durable?</span>"},
        {who:"cand",text:"Because it's already disk-backed (RocksDB / distributed queue), the enqueued URLs survive the restart — the worker reopens its store and resumes. Durability of the frontier is a <em>first-class requirement</em>, not an afterthought, precisely because rediscovery is expensive and non-deterministic. Enqueue is a durable append; dequeue is a marker advance. A restart replays from the last committed position."},
        {who:"intv",text:"A URL was dequeued and handed to a fetcher, then the worker died before the fetch completed. Lost or double-fetched?"},
        {who:"cand",text:"I treat dequeue as a <strong>lease, not a delete</strong>: the URL is marked in-flight with a visibility timeout, not removed. If the fetch completes, I acknowledge and delete. If the worker dies, the lease expires and the URL becomes visible again for retry — at-least-once semantics. A rare double-fetch is harmless (dedup catches the duplicate content, and it's rate-limited anyway); a <em>lost</em> URL is the outcome I actually care about avoiding."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"Hello Interview — web crawler",url:"https://www.hellointerview.com/learn/system-design/answer-keys/web-crawler"},
      ]},
      {l:"hard",tag:"failover",q:"A spider trap explodes the frontier.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> one site has a calendar with 'next month' links going infinitely, plus faceted-search URLs for every filter combination. Within an hour it injects <b>40M unique URLs</b> — all real, all distinct, all worthless — into the frontier. Dedup doesn't help because they're genuinely new URLs. Contain it.</span>"},
        {who:"cand",text:"This is a <strong>crawler trap / infinite URL space</strong>, and dedup is the wrong tool — the URLs <em>are</em> unique. Defenses: <strong>(1) per-domain URL budget</strong> — cap how many URLs I'll enqueue from one host, so 40M from one site is impossible by construction. <strong>(2) max crawl depth</strong> — calendar 'next' chains die at depth K. <strong>(3) URL pattern / trap detection</strong> — flag hosts generating URLs with runaway query-param cardinality or repeating path segments (<code>/a/a/a/...</code>) and de-prioritise or blacklist the pattern.<span class='eg'>Cap example.com at 500K URLs; a calendar param like <code>?date=2099-12</code> beyond depth 8 is refused enqueue.</span>"},
        {who:"intv",text:"Budgets are blunt — a legitimately huge site (a big catalog) also hits the cap and you under-crawl it. How do you tell a trap from a big real site?"},
        {who:"cand",text:"Signal quality, not just count. A real catalog's pages have <strong>distinct content</strong> and inbound value; a trap emits <strong>near-duplicate</strong> pages (content-dedup / simhash flags them) with near-zero incremental information. So I feed the <em>content-dedup rate</em> back into admission: if a host's newly fetched pages are more than X% near-duplicates of what I already have, I throttle its enqueue budget hard. Legit big sites keep their budget because their pages are novel. Budgets are the safety net; content similarity is the smart discriminator."},
      ],resources:[
        {title:"Wikipedia — Web crawler",url:"https://en.wikipedia.org/wiki/Web_crawler"},
        {title:"Hello Interview — web crawler",url:"https://www.hellointerview.com/learn/system-design/answer-keys/web-crawler"},
      ]},
      {l:"medium",tag:"capacity",q:"Size the frontier — memory, disk, and throughput.",turns:[
        {who:"intv",text:"Give me the frontier's sizing. How much memory versus disk per worker, and what enqueue and dequeue rates does it have to sustain?"},
        {who:"cand",text:"Two very different rates. <strong>Dequeue</strong> equals the fetch budget — 12K URLs/s fleet-wide. <strong>Enqueue</strong> is far higher during expansion because each fetched page yields many new links.<span class='eg'>12K pages/s × ~10 genuinely-new links/page ≈ 120K enqueues/s; across 200 workers that is ~600 writes/s and ~60 dequeues/s each — trivial for a per-worker LSM store. Capacity: 3B URLs × ~200 bytes ≈ 600GB, ~3GB of disk per worker, while RAM holds only the host heap and back-queue heads — a few hundred MB.</span>So it is disk-bound, not throughput-bound."},
        {who:"intv",text:"Enqueue running 10x dequeue means the frontier only ever grows. Is per-worker write throughput really the thing to size for?"},
        {who:"cand",text:"No — the write rate is comfortable; the danger is unbounded <em>growth</em>. So the sizing lever is not machines but <strong>admission control</strong>: per-domain URL caps, max depth, and priority-based dropping keep the 600GB from becoming 6TB of trap junk. I provision disk for legitimate scale and a memory hot-set for the next decisions, then cap growth with policy. The trade-off is coverage — aggressive caps risk under-crawling a genuinely huge site — so I tune the caps against the content-dedup signal rather than sizing storage for infinite intake."},
      ],resources:[
        {title:"Hello Interview — web crawler",url:"https://www.hellointerview.com/learn/system-design/answer-keys/web-crawler"},
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
      ]},
      {l:"hard",tag:"concept",q:"Which queue technology backs the frontier?",turns:[
        {who:"intv",text:"You keep saying disk-backed queue. Be specific — pick the technology that stores the frontier and defend it against the alternatives."},
        {who:"cand",text:"Three real candidates. <strong>Kafka</strong> — a durable append log, huge throughput, but strictly FIFO per partition. <strong>Redis</strong> — sorted sets give priority and time ordering, but it is in-memory so 600GB is expensive and durability is weaker. <strong>An embedded LSM store (RocksDB) per worker</strong> — disk-backed, cheap, durable appends, sitting locally on the worker that already owns the host by domain-hash. I pick the <strong>per-worker LSM store plus an in-memory heap</strong>: the heap holds the host-next-fetch times, the LSM store holds the URL tail.<span class='eg'>600GB spread as ~3GB of RocksDB per worker; the heap and back-queue heads stay in RAM.</span>"},
        {who:"intv",text:"Kafka is durable and scales effortlessly — why not just make the frontier a set of Kafka topics?"},
        {who:"cand",text:"Because the frontier is not FIFO. It has to pop <em>the URL of the host whose politeness delay has elapsed, at the highest priority band</em> — a selective, time-ordered dequeue. Kafka only hands me the next message in offset order; I cannot skip to a due host or reorder by priority without consuming and re-buffering, which defeats the point. So Kafka is great as the <strong>durable transport</strong> for enqueues between workers, but the decision structure — priority front-queues and per-host back-queues — needs a keyed store plus a heap. I would use RocksDB for state and, at most, Kafka as the append pipe, not as the frontier itself."},
      ],resources:[
        {title:"Hello Interview — web crawler",url:"https://www.hellointerview.com/learn/system-design/answer-keys/web-crawler"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
    ],
    fetcher:[
      {l:"medium",tag:"concept",q:"How does the fetcher pool actually work?",turns:[
        {who:"intv",text:"The fetcher downloads pages. At 12K pages/s, naively that's 12K threads each blocking on network IO. Walk me through how this box is really built."},
        {who:"cand",text:"Fetching is <strong>IO-bound</strong>, so thread-per-fetch is wasteful — most time is spent waiting on the network. I use <strong>async / event-driven IO</strong> (epoll-style) so a handful of threads manage thousands of concurrent in-flight connections.<span class='eg'>One worker holding 5K concurrent sockets at ~400ms avg fetch = 5000 / 0.4 ≈ 12.5K pages/s from a single box's event loop.</span>Each fetch enforces <strong>timeouts</strong> (connect, read), a <strong>response size cap</strong> (don't download a 2GB file), and a bounded number of redirects. Output — raw bytes plus headers — goes to the parser."},
        {who:"intv",text:"Response size cap — why, and what do you set it to?"},
        {who:"cand",text:"Without it, a single malicious or misconfigured URL streaming an infinite response ties up a connection forever and can OOM the worker. I cap at something like <strong>10MB</strong> for HTML (most pages are under 1MB) and stop reading past it. I also check <code>Content-Type</code> and <code>Content-Length</code> up front and skip non-HTML or oversized resources before downloading the body. Same defensive mindset as timeouts — bound every external interaction."},
      ],resources:[
        {title:"Hello Interview — web crawler",url:"https://www.hellointerview.com/learn/system-design/answer-keys/web-crawler"},
        {title:"Wikipedia — Web crawler",url:"https://en.wikipedia.org/wiki/Web_crawler"},
      ]},
      {l:"hard",tag:"scaling",q:"DNS is your bottleneck. (adds DNS resolver)",reveal:["dns"],turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> you profile a worker meant to do 12K pages/s and find it stalled at <b>3K/s</b>. CPU is idle, network is idle — but every fetch blocks ~200ms doing a <b>DNS lookup</b>, and your resolver is doing 12K queries/s. DNS is the bottleneck. Fix it.</span>"},
        {who:"cand",text:"DNS resolution is a hidden per-fetch cost that dominates once everything else is async. The fix is a dedicated <strong>caching DNS resolver</strong> in front of the fetchers — let me add that component. Most fetches go to hosts I've already resolved, so a cache with a reasonable TTL turns 12K DNS queries/s into a trickle of misses.<span class='eg'>Crawling 12K pages/s but only ~50 distinct new hosts per second → cache hit ratio over 99%, DNS load drops from 12K/s to ~100/s.</span>I also make resolution <strong>async</strong> so a lookup never blocks the event loop, and pre-resolve hosts while their URLs still sit in the frontier."},
        {who:"intv",text:"A shared cache helps, but public DNS resolvers will rate-limit you at crawl scale. What then?"},
        {who:"cand",text:"Run my <strong>own recursive resolver</strong> fleet (bind/unbound) rather than leaning on a third party — I control capacity and caching and I'm not subject to someone else's rate limit. I warm it with the hosts I'm about to crawl, honour TTLs but extend slightly for stability, and shard resolvers behind the workers. Because I partition the crawl by domain, each worker's host set is stable, so its DNS working-set is small and cache-friendly — the coordination and DNS wins compound."},
      ],resources:[
        {title:"Hello Interview — web crawler",url:"https://www.hellointerview.com/learn/system-design/answer-keys/web-crawler"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"hard",tag:"failover",q:"You got the whole IP banned. (adds politeness)",reveal:["politeness"],turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a worker discovers 200K URLs on one small host and fetches them as fast as it can — <b>800 requests/s to one site</b>. The site's origin falls over, its operator sees the flood, and blocks your entire crawler IP range — banning you from that host <em>and</em> collateral hosts on shared infra. Contain the damage.</span>"},
        {who:"cand",text:"I effectively <strong>DDoSed</strong> the host — an unbounded fetch rate per domain is the root cause. I need a <strong>politeness / rate-limiting</strong> component that caps requests per host; let me add it. The rule: fetch a given host no faster than a conservative rate (e.g. 1 request per host per N seconds, or honour the site's <code>Crawl-delay</code>), regardless of how many of its URLs I've queued. That single constraint makes the 800/s flood impossible.<span class='eg'>Crawl-delay 10s → at most 1 fetch / 10s to that host; 200K URLs crawl slowly and politely instead of in one destructive burst.</span>"},
        {who:"intv",text:"You've already been banned. Politeness prevents the <em>next</em> one — what about the current ban and shared-IP collateral?"},
        {who:"cand",text:"Two parts. For the ban: <strong>exponential backoff</strong> on 429/503, stop hitting that host entirely for a cooldown, then re-approach at a crawl-crawl rate; and expose a clear <code>User-Agent</code> with contact info so operators can reach me instead of block-and-forget. For collateral: politeness is keyed on <strong>host and also on IP</strong> — if many hosts share one IP (shared hosting/CDN), I rate-limit at the IP level too so I don't overwhelm the underlying server. And I respect <code>robots.txt</code> up front, which often tells me not to crawl those paths at all."},
      ],resources:[
        {title:"The Robots Exclusion Protocol",url:"https://www.robotstxt.org/robotstxt.html"},
        {title:"Hello Interview — web crawler",url:"https://www.hellointerview.com/learn/system-design/answer-keys/web-crawler"},
      ]},
      {l:"hard",tag:"durability",q:"A worker dies with 10K fetches in flight.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a fetcher worker is holding <b>10K in-flight fetches</b> when its host machine hard-crashes. Those URLs were dequeued from the frontier and are mid-download or downloaded-but-not-yet-parsed. What happens to them, and does the crawl skip those pages?</span>"},
        {who:"cand",text:"Because dequeue is a <strong>lease with a visibility timeout</strong>, not a delete, none of the 10K are truly lost. They were marked in-flight; when the worker dies, their leases expire and they return to the frontier for another worker to pick up — <strong>at-least-once</strong> processing. So the pages aren't skipped; they're retried. Downloaded-but-unparsed bytes that weren't durably handed off are simply re-fetched, which is cheap and correct."},
        {who:"intv",text:"Another worker now has to own that host partition. How does it know to take over cleanly?"},
        {who:"cand",text:"Ownership is coordinated: the crash is detected via <strong>heartbeat / lease expiry in the coordinator</strong> (ZooKeeper/etcd), which reassigns that worker's domain partitions to a healthy worker. The new owner reads the same <em>durable</em> frontier store for those hosts and resumes — the frontier being persistent is exactly what makes failover a reassignment rather than a data-loss event. In-flight leases expiring plus partition reassignment together mean a worker crash is degraded throughput for seconds, not lost coverage."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"Hello Interview — web crawler",url:"https://www.hellointerview.com/learn/system-design/answer-keys/web-crawler"},
      ]},
      {l:"medium",tag:"capacity",q:"How many fetcher machines to hit 12K pages/s?",turns:[
        {who:"intv",text:"Give me the math on the fetch fleet. To sustain 12K pages/s, how many concurrent connections and how many worker machines?"},
        {who:"cand",text:"Little's law gives the concurrency directly: in-flight = rate × latency.<span class='eg'>12,000 pages/s × ~0.4s average fetch ≈ 4,800 sockets in flight fleet-wide; at peak 3-5x that is ~24K concurrent connections. One async worker comfortably holds ~5K sockets, so raw throughput is barely a box or two — but I run ~200 workers, so each carries only ~24 sockets and ~60 fetches/s.</span>Because fetching is IO-bound, the constraint is concurrent-connection capacity and file descriptors, not CPU."},
        {who:"intv",text:"If one or two boxes can push 12K/s, why on earth run 200 workers?"},
        {who:"cand",text:"Raw throughput is not why the fleet is big. I need 200 workers for <strong>domain-hash partitioning</strong> — that is what makes politeness a local per-worker decision, keeps DNS and TCP connections warm per host, and localises the seen-set. I also want fault tolerance: losing one of 200 workers drops 0.5% of capacity, not half. So I size the fleet by <em>partitioning and blast-radius</em>, not by the Little's-law minimum — the trade-off is running far more machines than throughput alone demands, which I happily pay for locality and resilience."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"Hello Interview — web crawler",url:"https://www.hellointerview.com/learn/system-design/answer-keys/web-crawler"},
      ]},
    ],
    parser:[
      {l:"easy",tag:"concept",q:"What does the parser extract?",turns:[
        {who:"intv",text:"The fetcher hands you raw HTML bytes. What does the parser produce, and what's the tricky part?"},
        {who:"cand",text:"Two outputs: <strong>outlinks</strong> (fed back to the frontier to continue the crawl) and <strong>content</strong> (text plus metadata for the index/store). Steps: parse the DOM, extract <code>&lt;a href&gt;</code> links, extract visible text and structured metadata (title, headings, language). The tricky part is <strong>URL normalisation</strong> — the same page is reachable by many URL spellings, so I canonicalise before enqueue: lowercase host, resolve relative to absolute, strip default ports and fragments, sort/whitelist query params, honour <code>rel=canonical</code>.<span class='eg'>http://Example.com:80/a/../b?utm=x#top and https://example.com/b normalise to the same canonical URL.</span>"},
        {who:"intv",text:"Why normalise <em>before</em> enqueue rather than at fetch time?"},
        {who:"cand",text:"Because normalisation is what makes dedup effective — if I enqueue un-normalised URLs, the seen-set treats them as distinct and I crawl the same page many times, wasting fetch budget and politeness allowance. Canonicalising at parse time means the frontier and seen-set only ever deal in canonical URLs, so one page = one entry. It pushes the dedup win upstream where it's cheapest."},
      ],resources:[
        {title:"Wikipedia — Web crawler",url:"https://en.wikipedia.org/wiki/Web_crawler"},
        {title:"Hello Interview — web crawler",url:"https://www.hellointerview.com/learn/system-design/answer-keys/web-crawler"},
      ]},
      {l:"hard",tag:"scaling",q:"One page reached via a thousand URLs. (adds dedup)",reveal:["dedup"],turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> even after normalisation, you notice the crawler fetched one popular article <b>1,400 times</b> — reached via tracking params, session IDs, and mirror paths that all resolve to the same content. At 30B pages this duplication burns a big fraction of your fetch budget. Stop it.</span>"},
        {who:"cand",text:"I need an explicit <strong>dedup / seen-set</strong> — let me add it. Before enqueuing any URL, check it against the set of already-seen URLs; if present, drop it. That kills the re-fetch of the same canonical URL. At 30B pages the seen-set is the scaling challenge — I can't hold 30B full URLs in memory, so I use a <strong>Bloom filter</strong>: hash each URL into a compact bit array that answers 'definitely new' or 'probably seen' in O(1) at a few bits per URL.<span class='eg'>30B URLs in a Bloom filter at ~10 bits/URL ≈ 37GB — versus multiple TB to store the raw URLs.</span>"},
        {who:"intv",text:"Bloom filters have false positives. A false positive means you <em>skip</em> a URL you've never actually crawled. Acceptable?"},
        {who:"cand",text:"For a web crawler, yes — a false positive means I occasionally decline to crawl a genuinely new page, which at web scale is a tiny, tolerable coverage loss, and I tune the false-positive rate (more bits/hashes) to keep it under 1%. The property I rely on is <strong>no false negatives</strong> — if it says 'new', it's truly new — so I never <em>re-crawl</em> a seen page, which is the expensive mistake. I trade a hair of coverage for a massive memory saving and O(1) checks. For URLs I really can't miss, the filter fronts an authoritative store I consult only on a 'probably seen' hit."},
      ],resources:[
        {title:"Wikipedia — Bloom filter",url:"https://en.wikipedia.org/wiki/Bloom_filter"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"medium",tag:"concept",q:"Where does crawled content go? (adds content store)",reveal:["store"],turns:[
        {who:"intv",text:"You keep saying content goes 'to the index.' Be concrete — after the parser extracts a page, where does it actually land and in what form?"},
        {who:"cand",text:"It goes to a <strong>content store</strong> — let me add that box. I persist a few representations: the <strong>raw HTML</strong> (compressed, for reprocessing without re-fetching), the <strong>extracted text plus metadata</strong> (for the search index), and a <strong>content fingerprint</strong> (checksum/simhash for dedup). Raw pages are write-once blobs, so they live in <strong>object storage</strong> (S3-style) keyed by URL hash; the parsed/indexable fields feed the search indexing pipeline.<span class='eg'>30B pages × ~100KB raw ≈ 3PB — object storage, not a database; the text extract is a fraction of that and drives the inverted index.</span>"},
        {who:"intv",text:"Why keep the raw HTML at all if you've already extracted the text?"},
        {who:"cand",text:"Reprocessing. My extraction logic evolves — better boilerplate removal, new metadata, new models — and re-running it against 3PB of stored raw HTML is vastly cheaper and politer than re-crawling 30B live pages. Raw storage is the crawler's <em>replay log</em>: crawl once, extract many times. Storage is cheap; re-fetching is expensive and hammers other people's servers, so I keep the bytes."},
      ],resources:[
        {title:"Hello Interview — web crawler",url:"https://www.hellointerview.com/learn/system-design/answer-keys/web-crawler"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"medium",tag:"failover",q:"A page that breaks the parser.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> the parser hits a 40MB page of deeply nested malformed HTML — a <code>&lt;div&gt;</code> nested 50,000 deep. Your DOM parser blows the stack or spikes to 100% CPU for 30 seconds on that one page, and the worker's whole event loop stalls, dropping thousands of other in-flight fetches.</span>"},
        {who:"cand",text:"One bad page must never take down the worker. Defenses: <strong>(1)</strong> the response-size cap from the fetcher already rejects the 40MB body before it reaches me. <strong>(2)</strong> parse in a <strong>bounded, isolated context</strong> — a worker pool / subprocess with a CPU-time and memory budget, so a pathological parse is <em>killed</em> after, say, 2 seconds and the URL marked failed, without touching the event loop. <strong>(3)</strong> use a streaming/iterative parser with a max-depth limit rather than a recursive one that blows the stack."},
        {who:"intv",text:"You killed the parse. Do you retry that URL or drop it?"},
        {who:"cand",text:"I mark it <strong>failed with a reason</strong> and do <em>not</em> blindly retry — a deterministic parse failure will just fail again and waste budget. I record it (a dead-letter list) for offline inspection, and if a whole host produces these I de-prioritise the host. Transient failures (timeouts, 5xx) get bounded retries with backoff; deterministic content failures get quarantined. Same principle as everywhere: bound the blast radius and don't let one poison pill loop forever."},
      ],resources:[
        {title:"Hello Interview — web crawler",url:"https://www.hellointerview.com/learn/system-design/answer-keys/web-crawler"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"medium",tag:"capacity",q:"How much CPU does parsing 12K pages/s need?",turns:[
        {who:"intv",text:"The parser is the CPU-heavy box. At 12K pages/s, how many cores does extraction actually cost you?"},
        {who:"cand",text:"Parsing is CPU-bound, so I size it by CPU-time per page, again via Little's law.<span class='eg'>DOM parse plus link and text extraction is ~20ms of CPU per page. 12,000 pages/s × 0.02s ≈ 240 cores busy — about 15 sixteen-core workers, or ~1.2 cores co-located on each of the 200 fetcher boxes.</span>Unlike the fetcher this scales with cores, not sockets, so I keep each parse under a CPU-time budget so one pathological page cannot monopolise a core."},
        {who:"intv",text:"20ms assumes a static HTML page. Modern sites are JavaScript-heavy — what if you have to render them?"},
        {who:"cand",text:"Rendering changes the budget by one to two orders of magnitude — a headless-browser render is ~100ms-1s of CPU per page, so rendering everything would turn 240 cores into thousands. So I deliberately <strong>do not render by default</strong>: static extraction for the bulk, and a small separate render pool sized only to the render-worthy fraction (say a few percent of pages on an allowlist). The trade-off is coverage of JS-only content versus cost — I would rather cheaply parse 95% of the web than pay 20x to render all of it, and I expand the render pool only where the index actually needs it."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"Hello Interview — web crawler",url:"https://www.hellointerview.com/learn/system-design/answer-keys/web-crawler"},
      ]},
    ],
    dns:[
      {l:"easy",tag:"concept",q:"Why cache DNS, and what exactly?",turns:[
        {who:"intv",text:"You added a DNS resolver as a cache. Concretely — what are you caching and for how long?"},
        {who:"cand",text:"I cache <strong>hostname → IP</strong> resolutions keyed by host, honouring the record's <strong>TTL</strong> as a baseline. At crawl scale the same hosts recur constantly, so the cache converts most fetches' DNS step from a ~200ms network round-trip into a memory lookup.<span class='eg'>Crawling example.com's 500K pages needs <em>one</em> DNS resolution reused 500K times, not 500K lookups.</span>The cache sits between fetchers and upstream resolvers, shared across the worker's fetch loop."},
        {who:"intv",text:"DNS TTLs can be 30 seconds. Do you really re-resolve a host every 30s mid-crawl?"},
        {who:"cand",text:"Not strictly — for crawling I <strong>extend TTLs</strong> beyond the record's value (capped at minutes to hours) because I don't need DNS-perfect freshness the way a browser does; a host's IP rarely changes during a crawl, and a slightly stale IP just means one failed fetch I retry. So I trade a little correctness for far fewer lookups, and I refresh in the background rather than on the hot path, so a fetch never waits on a re-resolution."},
      ],resources:[
        {title:"Hello Interview — web crawler",url:"https://www.hellointerview.com/learn/system-design/answer-keys/web-crawler"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"hard",tag:"scaling",q:"DNS latency collapses throughput.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> during a burst into many <em>new</em> domains (a fresh seed expansion), the DNS cache hit ratio drops to 40%. Suddenly 60% of 12K fetches/s each wait 200ms on resolution, resolver queues back up, and overall throughput <b>collapses to a few hundred pages/s</b>. Diagnose and fix.</span>"},
        {who:"cand",text:"The cache only helps warm hosts; a new-domain burst is a <strong>cache-miss storm</strong> where DNS becomes serial and blocking. Fixes: <strong>(1) fully async, pipelined resolution</strong> — issue many concurrent DNS queries in flight so misses overlap instead of serialising; a 200ms lookup should block only its own fetch. <strong>(2) prefetch</strong> — resolve hosts <em>while their URLs still sit in the frontier</em>, so by the time a URL is due, its IP is already cached. <strong>(3) scale the resolver fleet horizontally</strong> so miss capacity isn't a single choke point."},
        {who:"intv",text:"Prefetch helps steady state. In the actual burst, resolver capacity is the wall. How do you size it?"},
        {who:"cand",text:"I size resolvers to the <strong>new-host discovery rate</strong>, not the total fetch rate — steady-state misses are few, so I provision for peak <em>distinct-new-hosts/s</em> plus headroom, and autoscale on resolver queue depth. Running my own recursive resolvers (not a rate-limited third party) means I can add capacity freely. And because the crawl is partitioned by domain, new-host bursts spread across workers/resolvers rather than hitting one — the coordination design caps the worst-case per-resolver miss rate."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"Hello Interview — web crawler",url:"https://www.hellointerview.com/learn/system-design/answer-keys/web-crawler"},
      ]},
      {l:"hard",tag:"failover",q:"The resolver fleet goes down.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> your DNS resolver fleet has an outage — every <em>new</em> resolution fails for 3 minutes. Fetches to already-cached hosts are fine, but any URL for an un-cached host errors out. Does the crawl grind to a halt?</span>"},
        {who:"cand",text:"No, and the design should degrade gracefully. Cached hosts keep flowing (extended TTLs mean the cache is large and warm), so throughput drops but doesn't zero out. For misses during the outage I <strong>don't fail the URL permanently</strong> — a resolution failure is transient, so the URL goes back to the frontier with backoff to retry once DNS recovers, rather than being marked dead. The scheduler can also <strong>prefer already-resolved hosts</strong> during the outage, deferring new-host work."},
        {who:"intv",text:"Serving stale cache entries during the outage — any risk?"},
        {who:"cand",text:"Minimal for a crawler. A stale IP either still works (IPs rarely move) or the fetch fails and retries — no correctness harm, unlike a user-facing system where a stale IP could route to the wrong service. So I deliberately serve stale on resolver failure (stale-while-revalidate) rather than erroring. The resolver fleet is also run redundantly across AZs so a full outage is unlikely; stale-serve plus retry-with-backoff covers the residual risk."},
      ],resources:[
        {title:"Hello Interview — web crawler",url:"https://www.hellointerview.com/learn/system-design/answer-keys/web-crawler"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"medium",tag:"durability",q:"A resolver restarts with an empty cache.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a resolver node restarts and comes back with an <b>empty cache</b>. Every fetch routed to it is now a miss, re-triggering the exact latency collapse from before, until it re-warms. How do you make the cache survive restarts?</span>"},
        {who:"cand",text:"Persist the cache so a restart doesn't start cold. Options: a <strong>shared cache tier</strong> (a small replicated store the resolver nodes read/write) so an individual node restart re-attaches to a warm shared cache rather than rebuilding its own; or snapshot the local cache to disk periodically and reload on start. Because DNS entries are cheap and change slowly, persisting them is trivial and the payoff — avoiding a cold-start miss storm — is large."},
        {who:"intv",text:"A shared cache adds a network hop to every DNS lookup. Doesn't that reintroduce latency?"},
        {who:"cand",text:"It does, so I use it as an <strong>L2, not L1</strong>: each resolver keeps a fast in-process cache (L1) and falls back to the shared/persisted cache (L2) only on a local miss, then to upstream DNS only on an L2 miss. A restart repopulates L1 lazily from the warm L2 — near-memory speed, no upstream storm. Same multi-tier caching idea as everywhere else: a fast local layer backed by a durable shared layer."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"Hello Interview — web crawler",url:"https://www.hellointerview.com/learn/system-design/answer-keys/web-crawler"},
      ]},
      {l:"medium",tag:"capacity",q:"How big does the DNS cache need to be?",turns:[
        {who:"intv",text:"Size the DNS cache. How many entries, how much memory, and what miss load reaches the resolvers?"},
        {who:"cand",text:"Each entry is tiny — host, IP, TTL — call it ~100 bytes. The number of <em>distinct</em> hosts is what matters, and it is far smaller than the page count.<span class='eg'>~100M distinct hosts fleet-wide × ~100 bytes ≈ 10GB for a complete cache; but the hot working set is much smaller — at 12K pages/s over only ~50 new hosts/s, a few million recently-seen hosts (a few hundred MB) already gives a >99% hit ratio, so resolvers see only ~50-100 misses/s.</span>The cache turns a 200ms round-trip into a memory read for almost every fetch."},
        {who:"intv",text:"10GB of host entries duplicated on every one of 200 workers is wasteful. Does each worker really cache the whole web?"},
        {who:"cand",text:"No — and domain-hash partitioning is what saves me. Each worker only ever fetches its own slice of hosts, so its DNS working set is roughly 1/200th of the total — tens of MB, not 10GB — and it stays warm because the same worker keeps hitting the same hosts. There is no global 10GB replica anywhere; the cache shards for free along the same partitioning that drives politeness. The trade-off is a cold cache after a partition reassignment, which I handle by persisting entries so a moved partition reloads warm rather than re-resolving from scratch."},
      ],resources:[
        {title:"Hello Interview — web crawler",url:"https://www.hellointerview.com/learn/system-design/answer-keys/web-crawler"},
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
      ]},
    ],
    politeness:[
      {l:"medium",tag:"concept",q:"robots.txt and crawl-delay.",turns:[
        {who:"intv",text:"Politeness is a whole component. Start with the basics — how do you decide whether you're even allowed to fetch a URL, and how fast?"},
        {who:"cand",text:"First, <strong>robots.txt</strong>: before crawling a host I fetch <code>/robots.txt</code>, parse its <code>Allow</code>/<code>Disallow</code> rules for my <code>User-Agent</code>, and only crawl permitted paths. Second, <strong>rate</strong>: I honour <code>Crawl-delay</code> if present, else a conservative default per host, and keep concurrency to any one host low.<span class='eg'>robots.txt <code>Disallow: /search</code> → I never enqueue that host's search URLs; <code>Crawl-delay: 5</code> → at least 5s between fetches to it.</span>Politeness is both etiquette and self-preservation — it's how I avoid getting banned."},
        {who:"intv",text:"Do you fetch robots.txt on every request? That's a lot of extra fetches."},
        {who:"cand",text:"No — I <strong>cache robots.txt per host</strong> with a TTL (say 24h) and reuse it across all that host's URLs, so it's one small fetch amortised over potentially millions of pages. Because the crawl is partitioned by domain, the worker that owns a host owns its cached robots rules too — no cross-worker refetching. On expiry I refresh in the background; if robots.txt is unreachable I apply a conservative default rather than assuming free rein."},
      ],resources:[
        {title:"The Robots Exclusion Protocol",url:"https://www.robotstxt.org/robotstxt.html"},
        {title:"Wikipedia — Web crawler",url:"https://en.wikipedia.org/wiki/Web_crawler"},
      ]},
      {l:"hard",tag:"failover",q:"Reassigned worker forgets recent fetch times.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a worker crashes and its domains are reassigned to a new worker that has <b>no memory of recent fetch times</b>. It immediately fires requests to hosts the dead worker just hit, doubling the effective rate and risking the exact ban you're trying to avoid.</span>"},
        {who:"cand",text:"The gap is that politeness state (per-host next-allowed-time) lived only in the dead worker's memory. Fix: persist <strong>last-fetch timestamps per host</strong> alongside the frontier's durable state, so a reassigned worker reads 'host X last fetched at T, delay 5s' and waits appropriately instead of firing immediately. On reassignment I also apply a <strong>conservative cooldown</strong> — assume the host was just hit and wait a full delay before the first fetch — so uncertainty errs toward politeness."},
        {who:"intv",text:"Persisting a timestamp on every single fetch — isn't that a lot of writes?"},
        {who:"cand",text:"It's one small write per fetch, co-located with the frontier's dequeue/lease bookkeeping I'm already doing, so it piggybacks cheaply. And I don't need it perfectly durable — a slightly stale last-fetch-time only makes me <em>more</em> polite (wait longer), never less, which is the safe direction. So even lossy persistence is fine here; the asymmetry of the risk (banned vs. slightly slow) means I always round toward caution."},
      ],resources:[
        {title:"The Robots Exclusion Protocol",url:"https://www.robotstxt.org/robotstxt.html"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"hard",tag:"scaling",q:"Politeness across the whole fleet.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> you're polite per-worker, but a big CDN serves <b>50,000 different hostnames from one IP block</b>. Each of your 200 workers politely crawls different hostnames on that shared infra — and collectively you send <b>2,000 req/s</b> to one physical server. Per-host politeness didn't protect the actual server. Fix.</span>"},
        {who:"cand",text:"Per-<em>host</em> politeness is the wrong granularity when many hosts share infrastructure. I add <strong>per-IP (and per-IP-block) rate limiting</strong> on top of per-host: resolve the host, and throttle against the destination IP too, so the <em>aggregate</em> to one server is bounded regardless of hostname count. To enforce this across 200 workers I need the IP's budget shared — so I <strong>route hosts sharing an IP to the same worker</strong>, or keep a lightweight shared rate-limit counter per IP block.<span class='eg'>Cap the CDN IP block at 10 req/s total → the 50K hostnames share that budget instead of each getting its own.</span>"},
        {who:"intv",text:"Routing all 50K hostnames to one worker recreates the hot-worker problem from coordination. Which do you pick?"},
        {who:"cand",text:"I pick the <strong>shared counter</strong> for shared-IP mega-hosts specifically, and keep domain-hash partitioning as the default. Most domains don't share IPs, so they stay locally enforced (cheap). For the rare high-fan-out IP blocks I detect (many owned domains resolving to one IP), I fall back to a distributed rate limiter — a token bucket per IP in a shared store the relevant workers consult. It's a targeted exception, so I pay the coordination cost only where shared infra actually forces it, not fleet-wide."},
      ],resources:[
        {title:"Hello Interview — web crawler",url:"https://www.hellointerview.com/learn/system-design/answer-keys/web-crawler"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"medium",tag:"durability",q:"The robots.txt cache is wiped.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> your robots.txt cache is wiped in an incident. Workers have no cached rules and, under a bad default, resume crawling — including <code>Disallow</code> paths — for the ~30 minutes it takes to refetch robots for millions of hosts. You're now violating robots at scale. Prevent this.</span>"},
        {who:"cand",text:"Crawling on an empty robots cache under a permissive default is the bug. Rule: <strong>no robots rules for a host → don't crawl it</strong> (fail-closed); fetch robots.txt <em>first</em> and only then release that host's URLs. To avoid the 30-minute cold-start pain, I <strong>persist the robots cache durably</strong> (it's small — one file per host), so an incident reloads rules instead of refetching, and I prioritise robots.txt fetches ahead of content fetches when warming."},
        {who:"intv",text:"Fail-closed means an unreachable robots.txt blocks a whole host. Sites without robots.txt are then never crawled — too aggressive?"},
        {who:"cand",text:"I distinguish the two cases. <strong>robots.txt returns 404</strong> (site has none) → by convention that means <em>crawl allowed</em>, so I proceed. <strong>robots.txt is unreachable</strong> (timeout/5xx) → that's ambiguous, so I fail-closed <em>temporarily</em>: defer the host and retry robots later rather than assuming permission. So 'no file' is permissive per the standard, but 'can't tell' errs safe. That matches the robots convention while protecting me from crawling something I was told not to."},
      ],resources:[
        {title:"The Robots Exclusion Protocol",url:"https://www.robotstxt.org/robotstxt.html"},
        {title:"Wikipedia — Web crawler",url:"https://en.wikipedia.org/wiki/Web_crawler"},
      ]},
      {l:"medium",tag:"capacity",q:"Size the per-host politeness and robots state.",turns:[
        {who:"intv",text:"Politeness keeps per-host timing plus parsed robots rules. Across the whole crawl, how much memory is that?"},
        {who:"cand",text:"Two kinds of state per host. Timing — last-fetch time and crawl-delay — is tiny, ~50 bytes. Parsed robots rules are bigger, call it ~1KB per host.<span class='eg'>Timing: ~100M active hosts × 50 bytes ≈ 5GB fleet-wide. Robots: 100M × ~1KB ≈ 100GB fleet-wide. Domain-partitioned across 200 workers that is ~25MB timing and ~500MB robots per worker.</span>Timing state is small enough to keep hot everywhere; robots is the part that needs care."},
        {who:"intv",text:"500MB of robots per worker, and 100GB across the fleet, just for rules — too much to keep resident?"},
        {who:"cand",text:"I trim it two ways. First, I store only the <strong>parsed disallow prefixes</strong> I actually match against, not the raw robots.txt text, which cuts most hosts to a few dozen bytes. Second, I <strong>LRU the robots cache</strong> to currently-active hosts and persist the rest to disk or a shared store, reloading on demand — the set of hosts I am crawling right now is far smaller than every host I have ever seen. The trade-off is an occasional reload for a host that went cold and came back, which is one cheap fetch or disk read, versus pinning 100GB in RAM. Timing state stays fully in memory because it is small and safety-critical."},
      ],resources:[
        {title:"The Robots Exclusion Protocol",url:"https://www.robotstxt.org/robotstxt.html"},
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
      ]},
    ],
    dedup:[
      {l:"medium",tag:"concept",q:"URL dedup with a Bloom filter.",turns:[
        {who:"intv",text:"You added dedup to catch re-fetches, and the seen-set is a Bloom filter. Explain why a Bloom filter and not just a hash set."},
        {who:"cand",text:"A plain hash set of 30B canonical URLs is multiple <strong>terabytes</strong> in RAM — impractical per worker. A <strong>Bloom filter</strong> stores the same membership information in a compact bit array at a few bits per element, trading exactness for space.<span class='eg'>30B URLs at 10 bits each ≈ 37GB at a sub-1% false-positive rate — a hash set of the raw strings would be 3TB+.</span>It answers membership in O(1) with k hash probes, which is exactly what the enqueue check needs: is this URL new?"},
        {who:"intv",text:"Give me the actual check flow on enqueue."},
        {who:"cand",text:"On a parsed outlink: canonicalise → probe the Bloom filter. If it says <strong>'not present'</strong> (guaranteed truthful — no false negatives), it's genuinely new: add it to the filter and enqueue the URL. If it says <strong>'probably present'</strong>, treat it as seen and drop it. That's the whole hot path — a few hash computations and bit reads per URL, no disk, no network. The one nuance is false positives, which make me skip a small fraction of truly-new URLs, an acceptable coverage trade at this scale."},
      ],resources:[
        {title:"Wikipedia — Bloom filter",url:"https://en.wikipedia.org/wiki/Bloom_filter"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"hard",tag:"scaling",q:"A distributed seen-set.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> the crawl runs on 200 workers. If each keeps its own local Bloom filter, a URL for a host that migrated between workers gets crawled twice and the seen-set is inconsistent. If you keep one global filter, every enqueue does a network round-trip — <b>at 200K URL-checks/s</b> that's a bottleneck. Which, and why?</span>"},
        {who:"cand",text:"I avoid the global-filter round-trip by leaning on the <strong>domain-hash partitioning</strong>: since all of a host's URLs route to one worker, that worker's <em>local</em> Bloom filter is authoritative for its hosts — dedup is naturally partitioned and needs no cross-worker check on the hot path. The consistency gap only appears on <strong>partition migration</strong>, which is rare. So: local filters as the default, and I handle migration explicitly rather than paying global coordination on every URL."},
        {who:"intv",text:"How do you handle the migration case so the new owner doesn't re-crawl everything?"},
        {who:"cand",text:"The seen-set must be <strong>durable per partition</strong>, not just in-memory: I persist each worker's Bloom filter (and/or an authoritative on-disk seen-store) keyed by domain, so when a host's partition moves the new owner <strong>loads that partition's seen-state</strong> and continues where the old owner left off. Because Bloom filters can't be un-set but <em>can</em> be merged (bitwise OR), reassigning and merging partition filters is cheap. So partitioning gives cheap steady-state dedup, and persistent, mergeable filters make migration safe."},
      ],resources:[
        {title:"Wikipedia — Bloom filter",url:"https://en.wikipedia.org/wiki/Bloom_filter"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"hard",tag:"concept",q:"Catching near-duplicate content.",turns:[
        {who:"intv",text:"URL dedup catches the same URL. But two <em>different</em> URLs can serve identical or near-identical content — print vs. web view, mirrors, boilerplate pages. How do you catch that?"},
        {who:"cand",text:"That's <strong>content dedup</strong>, separate from URL dedup. For <em>exact</em> duplicates I compute a <strong>checksum</strong> (SHA-1/MD5) of the normalised content; identical hash → duplicate, index once. For <em>near</em>-duplicates (same article, different ads/nav) I use <strong>SimHash</strong> (or MinHash): a locality-sensitive fingerprint where similar documents produce fingerprints within a small Hamming distance.<span class='eg'>Print and web versions of an article differ only in boilerplate but share over 95% of text → SimHashes within a few bits → flagged as near-duplicate.</span>I keep one canonical copy and link the duplicates to it."},
        {who:"intv",text:"Comparing every new page's SimHash against billions of stored ones is a huge nearest-neighbour problem. Feasible?"},
        {who:"cand",text:"Not by brute force. I <strong>bucket</strong> SimHashes: split the fingerprint into bands and index by band, so I only compare against documents sharing a band (LSH), turning a billion-way scan into a handful of bucket lookups. It's approximate — I might miss a near-dup whose bands all differ — but at crawl scale catching the vast majority is enough to cut duplicate indexing and to feed the trap-detection signal from earlier. Exact-checksum dedup is cheap and catches the common mirror case; SimHash+LSH handles the fuzzy tail."},
      ],resources:[
        {title:"Wikipedia — Web crawler",url:"https://en.wikipedia.org/wiki/Web_crawler"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"hard",tag:"failover",q:"Two workers crawl the same URL — dedup race.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> through a brief partition-ownership overlap during a rebalance, two workers parse pages linking to the <em>same</em> new URL at the same instant. Both probe the seen-set, both see 'not present', both enqueue and fetch it. A <b>dedup race</b>. How bad, and do you fix it?</span>"},
        {who:"cand",text:"First, how bad: the outcome is <strong>one duplicate fetch</strong> of a page — wasted budget and a redundant politeness hit, but <em>not</em> a correctness failure, since content dedup catches the identical result downstream and the store is keyed by canonical URL (idempotent write). At 30B pages, occasional double-fetches during rare rebalances are a rounding error, so my first answer is: don't over-engineer it."},
        {who:"intv",text:"So you'd tolerate it. Is there ever a case you must not double-fetch?"},
        {who:"cand",text:"If double-fetching were expensive or harmful (a costly render, or a host where the extra request risks a ban), I'd make the enqueue check-and-set <strong>atomic</strong>: because a host maps to one owning worker, the authoritative seen-set for that host lives in one place, so probe-plus-insert can be a single atomic op — no two workers legitimately own it simultaneously. The race only exists during the <em>overlap window</em> of a rebalance, so I also make ownership handoff clean (old owner drains/fences before the new owner starts). Net: tolerate the rare harmless case, fence the handoff so the window is tiny, and go atomic only where a duplicate actually costs something."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"Hello Interview — web crawler",url:"https://www.hellointerview.com/learn/system-design/answer-keys/web-crawler"},
      ]},
      {l:"medium",tag:"capacity",q:"Size the seen-set across the fleet.",turns:[
        {who:"intv",text:"Put numbers on the seen-set. For 30B URLs, how much memory does the Bloom filter cost, and how is it split across workers?"},
        {who:"cand",text:"Bloom-filter memory is bits-per-URL times URL count, and I pick bits per URL from the false-positive rate I will tolerate.<span class='eg'>30B URLs × 10 bits ≈ 37GB fleet-wide at a ~1% false-positive rate — versus 3TB+ to store the raw canonical strings in a hash set. Domain-partitioned across 200 workers, each holds ~190MB of filter for its own hosts.</span>So the whole global seen-set fits in the aggregate RAM of the fleet, and each worker only carries its slice."},
        {who:"intv",text:"The crawl keeps discovering URLs — as it grows past 30B the filter fills up. What happens to that 1% then?"},
        {who:"cand",text:"A Bloom filter degrades as it saturates: past its design capacity the false-positive rate climbs, and a false positive means I skip a genuinely-new URL — silent coverage loss. Two options. I can <strong>size for the target N up front</strong> with more bits (15 bits/URL pushes FP toward 0.1% at the cost of ~55GB), or use a <strong>scalable Bloom filter</strong> that adds a segment when the current one fills, keeping the aggregate FP bounded as the corpus grows. The trade-off is memory versus coverage — I would rather spend a few extra GB per worker than quietly stop discovering pages, so I provision bits for the corpus I expect, not the one I have today."},
      ],resources:[
        {title:"Wikipedia — Bloom filter",url:"https://en.wikipedia.org/wiki/Bloom_filter"},
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
      ]},
    ],
    store:[
      {l:"medium",tag:"concept",q:"What and how to store.",turns:[
        {who:"intv",text:"The parser sends content here. Concretely — what does the content store hold, and what kind of system is it?"},
        {who:"cand",text:"It holds three things per page: <strong>raw compressed HTML</strong> (replay/reprocess), <strong>extracted text plus metadata</strong> (feeds the search index), and a <strong>content fingerprint</strong> (checksum/simhash for dedup). Raw pages are immutable write-once blobs → <strong>object storage</strong> (S3-style), keyed by a hash of the canonical URL. The indexable text flows into the indexing pipeline that builds the inverted index the search engine actually queries.<span class='eg'>Key = sha1(canonicalURL); value = gzip(rawHTML) plus a metadata sidecar; 30B objects.</span>"},
        {who:"intv",text:"Why not just put everything in a big database?"},
        {who:"cand",text:"The access pattern doesn't need one. Writes are append-only, reads are batch (reprocessing) or by-key, and there are no joins or transactions — a database's indexing and consistency machinery is wasted overhead at 3PB. Object storage gives cheap, durable, effectively-infinite blob storage with by-key access, exactly the shape of the workload. The <em>search index</em> is a separate specialised system built <em>from</em> this store; the store itself is deliberately dumb and cheap."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"Hello Interview — web crawler",url:"https://www.hellointerview.com/learn/system-design/answer-keys/web-crawler"},
      ]},
      {l:"hard",tag:"scaling",q:"Storing billions of pages.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> you're storing 30B pages at ~100KB each — <b>3PB and growing ~100TB/month</b>. A single filesystem or DB can't hold it, and cost matters. How do you lay this out?</span>"},
        {who:"cand",text:"Partitioned, tiered object storage. <strong>Shard by key hash</strong> across buckets/partitions so no single namespace is a bottleneck and writes spread evenly. <strong>Compress</strong> aggressively (HTML gzips ~5-8x). <strong>Tier by access</strong>: recently-crawled or frequently-reprocessed pages on hot storage, old snapshots to cold/archival tiers that are far cheaper.<span class='eg'>100KB × ~6x compression ≈ 16KB stored/page → 30B pages ≈ 480TB stored, not 3PB.</span>Metadata and the fingerprint index live in a separate, smaller, queryable store."},
        {who:"intv",text:"You recrawl pages, so you have multiple versions of the same URL over time. Store all of them?"},
        {who:"cand",text:"I keep a <strong>bounded version history</strong>, not infinite. The latest version is always hot; a few recent snapshots stay for diffing and freshness modelling; older versions age into cold storage or are pruned by policy. Storing every version of every page forever is unbounded cost for diminishing value — most consumers want current content, and change-detection only needs the previous fingerprint, not the full body. So versioning is deliberate and capped, with cold-tiering doing the heavy lifting on cost."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"Hello Interview — web crawler",url:"https://www.hellointerview.com/learn/system-design/answer-keys/web-crawler"},
      ]},
      {l:"hard",tag:"durability",q:"Don't lose weeks of crawled pages.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a storage node holding one shard suffers a disk failure. That shard held <b>~2B pages</b> that took weeks of polite, rate-limited crawling to collect. Re-crawling means weeks of work and hammering other people's servers again. Are they gone?</span>"},
        {who:"cand",text:"They must not be — re-crawling is uniquely expensive here because politeness <em>caps</em> how fast I can re-collect, so lost pages aren't quickly replaceable. The store must be <strong>replicated</strong>: every object written to at least 3 replicas across failure domains (managed object storage like S3 does this transparently at very high durability). A single disk failure loses nothing; the object is served from another replica and the failed node rebuilds from peers.<span class='eg'>3x replication across AZs → durability around 11 nines; a disk loss is a background rebuild, not data loss.</span>"},
        {who:"intv",text:"Replication protects against disk failure. What about a bad crawl that writes corrupted/garbage pages over good ones?"},
        {who:"cand",text:"Replication faithfully copies corruption, so it isn't the answer there — <strong>immutability plus versioning</strong> is. Pages are write-once keyed by URL-hash-plus-crawl-version, so a bad crawl writes <em>new</em> versions rather than overwriting good ones, and I can roll back to the prior good version. I also <strong>checksum on write and verify on read</strong> to catch bit-rot, and keep the raw HTML precisely so a bad <em>extraction</em> can be re-run from good source bytes. Durable, immutable, and versioned means both hardware faults and logical faults are recoverable."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"Hello Interview — web crawler",url:"https://www.hellointerview.com/learn/system-design/answer-keys/web-crawler"},
      ]},
      {l:"hard",tag:"failover",q:"The store write path stalls under load.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> the content store's write path has a 90-second outage. Meanwhile 200 workers are parsing at <b>12K pages/s</b> — that's ~1M freshly-crawled pages with nowhere to go. Do you drop them and re-crawl later?</span>"},
        {who:"cand",text:"Dropping means re-crawling — expensive and impolite — so I avoid it. I <strong>decouple the parser from the store with a durable queue/log</strong> (Kafka-style): parsed pages are published to the log, and store-writer consumers drain it into object storage. During a 90s store outage the log <strong>buffers</strong> the ~1M pages; when the store recovers, consumers catch up. The crawl never blocks on store availability, and no crawled page is lost.<span class='eg'>1M pages × ~16KB ≈ 16GB buffered in the log for 90s — trivial for a Kafka-style log to hold and replay.</span>"},
        {who:"intv",text:"The buffer isn't infinite. What if the store is down for hours, not 90 seconds?"},
        {who:"cand",text:"Two levers. The log has <strong>bounded retention sized to a realistic outage</strong> (hours of buffer), so short-to-medium outages are fully absorbed and replayed. If it's approaching the buffer limit, I apply <strong>backpressure to the crawl</strong> — throttle the fetch rate — rather than dropping already-crawled pages, because slowing new work is cheaper than discarding completed work. Deliberately, I'd rather crawl slower than lose pages I already politely paid to fetch. A multi-hour store outage becomes reduced throughput, not data loss."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"Hello Interview — web crawler",url:"https://www.hellointerview.com/learn/system-design/answer-keys/web-crawler"},
      ]},
      {l:"medium",tag:"capacity",q:"Size the content store — bytes, writes, nodes.",turns:[
        {who:"intv",text:"Size the content store. How many bytes, what write bandwidth, and how many nodes to hold 30B pages?"},
        {who:"cand",text:"I size storage and throughput separately and take the max, like any datastore.<span class='eg'>Space: 30B × ~100KB ≈ 3PB raw; HTML compresses ~6x → ~500TB stored (under the 1PB the framing quoted). At ~10TB usable/node that is ~50 nodes for space. Throughput: 12K pages/s × ~16KB compressed ≈ 190MB/s sustained write, ~1.6TB/day, plus 30B objects to key and index.</span>Space dominates node count; 190MB/s of writes spreads trivially, so I provision on the order of ~50-60 nodes and the throughput comes for free."},
        {who:"intv",text:"That 500TB is just the raw HTML. You also keep extracted text, fingerprints, and multiple versions per URL — does the budget hold?"},
        {who:"cand",text:"Raw HTML dominates; extracted text is a fraction of it and the fingerprint index is smaller still, so those do not move the 500TB much. Versions are the real multiplier — recrawling means several copies of each URL over time. So I keep a <strong>bounded version history</strong>: latest hot, a few recent snapshots for diffing, older ones cold-tiered or pruned. The trade-off is losing deep history versus unbounded cost — most consumers want current content and change-detection only needs the previous fingerprint, so I cap versions and let cold-tiering absorb the rest rather than sizing hot storage for every version forever."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"Hello Interview — web crawler",url:"https://www.hellointerview.com/learn/system-design/answer-keys/web-crawler"},
      ]},
      {l:"hard",tag:"concept",q:"Choose the content store — object store vs HDFS vs wide-column DB.",turns:[
        {who:"intv",text:"You keep saying object storage for the pages. Treat this as a real selection: pin the numbers, put up two or three candidate systems with their ceilings, and defend the pick against them."},
        {who:"cand",text:"Let me frame the workload first, because it dictates the answer. <strong>Write throughput:</strong> 12K pages/s of write-once blobs; each raw page is ~100KB, ~16KB after ~6x gzip → ~190MB/s sustained, ~1.6TB/day ingested. <strong>Total storage:</strong> 30B pages × ~16KB ≈ <strong>~500TB compressed</strong> (3PB raw), growing ~100TB/month. The access pattern is dead simple: write once, read by key for reprocessing or batch-scan for indexing — no updates, no joins, no transactions. So I am sizing a bulk immutable-blob store, and I will judge each candidate on cost-per-TB, per-node ceiling, and how it handles 30B objects.<span class='eg'>Key = sha1(canonicalURL); value = gzip(rawHTML) ~16KB; ~500TB / 30B objects.</span>"},
        {who:"intv",text:"Give me the actual candidates with node-level ceilings, not just vibes."},
        {who:"cand",text:"Three real options, with ballpark ceilings and the node math each implies for ~500TB.<span class='eg'><strong>Managed object storage (S3-style):</strong> effectively unbounded capacity, ~3,500 PUT/s per key-prefix so I shard across ~50-100 prefixes to clear 12K writes/s, ~11 nines durability. No node math I own — it is a service; ~500TB is a line item, not a cluster. <strong>HDFS:</strong> DataNodes scale capacity fine (~500TB / ~10TB usable per node ≈ 50 nodes), but the NameNode keeps ~150 bytes of RAM metadata per object → 30B objects ≈ 4.5TB of NameNode heap, and it caps in practice around 300-500M files. It falls over on object count long before capacity. <strong>Cassandra/Bigtable (wide-column):</strong> ~10-50K small writes/s per node, but values are meant to be small (Cassandra guidance is under ~10KB); 16-100KB blobs bloat compaction and heap. At ~1-2TB usable/node that is ~250-500 nodes for 500TB, all fighting compaction on data that never changes.</span>"},
        {who:"intv",text:"Why is a row / wide-column DB the wrong home for the bytes specifically? Be precise about the mismatch."},
        {who:"cand",text:"Because a row store pays for machinery this workload never uses. Cassandra/Bigtable buy you fast random point-writes, mutability, secondary indexes, compaction, and tunable consistency — all valuable for hot mutable rows, all <strong>dead weight for write-once 16KB blobs</strong>. Large opaque values sitting in a row engine trigger compaction storms (the LSM keeps rewriting immutable bytes that will never be updated), balloon heap and GC pressure, and cost several times more per TB than object storage while capping you at a few TB per node. Object storage is purpose-built for exactly this shape: immutable, large-ish values, addressed by key, cheap, tiered, and horizontally infinite. The rule of thumb is <em>bytes belong in blob storage; a database should hold pointers to bytes, not the bytes</em>."},
        {who:"intv",text:"If the bytes live in dumb blob storage, how do you do a fast dedup check or look up a page's location without listing an ocean of objects?"},
        {who:"cand",text:"I split storage from lookup: a <strong>separate small metadata index</strong> alongside the blobs. It is one narrow row per page — <code>url_hash → storage_url (the object key/location), content_hash, http_status, fetched_at</code> — and this <em>is</em> the sweet spot for a wide-column / KV store (Cassandra, Bigtable, or DynamoDB): tiny uniform rows, point lookups, high write rate.<span class='eg'>30B rows × ~100 bytes ≈ ~3TB — trivially sharded across a modest cluster, versus 500TB of blobs it points at.</span>Now dedup and lookups hit the 3TB index in memory-speed point reads (does this content_hash already exist? where is this url_hash's object?), while the 500TB of bytes sit in cheap object storage I never scan directly. The DB indexes; the blob store holds.<span class='eg'>Dedup: probe content_hash in the index (O(1)); on hit, drop the duplicate without ever touching object storage.</span>"},
        {who:"intv",text:"Your indexing pipeline runs big batch jobs over all this. Doesn't HDFS colocation win on data locality there?"},
        {who:"cand",text:"It would if the objects were large, but the small-file problem sinks raw HDFS here — 30B tiny objects blow past the NameNode metadata ceiling long before capacity is an issue. The fix keeps me on object storage: <strong>pack pages into large container files</strong> — WARC or sequence files of thousands of pages each — so batch jobs stream a few big objects instead of billions of tiny ones, and modern compute (Spark/MapReduce) reads object storage directly at high throughput anyway. I give up HDFS-style disk locality but avoid its metadata wall and its operational burden, and I still feed batch indexing efficiently."},
        {who:"intv",text:"So state the decision and why each alternative lost."},
        {who:"cand",text:"<strong>Decision: managed object storage for the raw/compressed blobs (packed into WARC containers for batch reads), fronted by a small wide-column/KV metadata index for lookups and dedup.</strong> Why not HDFS — 30B small objects exceed the NameNode's in-memory metadata ceiling (~4.5TB of heap for the file table), so it breaks on object count regardless of the ~50 DataNodes capacity would need. Why not Cassandra/Bigtable for the bytes — write-once 16-100KB blobs waste its mutability/compaction machinery, cost multiples per TB, and need ~250-500 nodes fighting compaction; but it is exactly right for the ~3TB metadata index. Why object storage — ~500TB of immutable, key-addressed blobs is its native workload: ~11 nines durability, built-in hot/cold tiering, effectively infinite scale, and 190MB/s of writes spreads trivially across sharded prefixes. Bytes in the blob store, pointers in the DB — each system does the one thing it is good at."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"Hello Interview — web crawler",url:"https://www.hellointerview.com/learn/system-design/answer-keys/web-crawler"},
      ]},
    ],
  },
  mockTest:[
    {q:"Design the URL frontier. How does it balance priority against politeness, and why is a single FIFO wrong?",a:"A single FIFO satisfies neither goal. Use the Mercator two-stage design: front queues capture priority (N queues, one per priority band; a URL routes to a band by its score — homepages high, deep archive low) and back queues capture politeness (one queue per host, invariant of one host per back queue). A min-heap of hosts keyed on each host's earliest next-allowed-fetch time picks what a fetcher gets next: pop the due host, hand out its head URL, re-insert with an updated next-time. Priority decides which URLs are eligible; politeness decides when — the two dimensions stay decoupled even at billions of entries."},
    {q:"How do you stay polite — honour robots.txt and avoid hammering a host — without a fetch or memory blowup?",a:"Before crawling a host, fetch and parse /robots.txt for your User-Agent and only crawl allowed paths; honour Crawl-delay if set, else a conservative default, and keep per-host concurrency low. Cache robots.txt per host with a TTL (say 24h) so it is one small fetch amortised over millions of pages. Partition the crawl by hash of the registered domain so one worker owns a host and holds its robots rules, last-fetch timestamps, and rate budget locally — politeness becomes a per-worker decision with zero cross-worker coordination. Also key rate limits on IP, not just host, so shared-hosting/CDN servers behind many hostnames are not overwhelmed."},
    {q:"You dedup URLs with a Bloom filter over 30B URLs. Why a Bloom filter, how much memory, and what is the risk?",a:"A hash set of 30B canonical URL strings is 3TB+ in RAM — impractical. A Bloom filter stores membership in a compact bit array at a few bits per element: 30B URLs × ~10 bits ≈ 37GB fleet-wide at a sub-1% false-positive rate, domain-partitioned to ~190MB per worker across 200 workers. On enqueue: canonicalise, probe; not-present is guaranteed truthful (no false negatives) so it is genuinely new — add and enqueue; probably-present is treated as seen and dropped. The risk is false positives, which make you skip a small fraction of truly-new URLs — a tolerable coverage loss at web scale. It degrades as it saturates past design capacity, so size bits for the target corpus or use a scalable Bloom filter that adds segments."},
    {q:"Choose the content store for ~500TB compressed (3PB raw) of write-once pages at 12K writes/s. Object store, HDFS, or a wide-column DB?",a:"Managed object storage for the blobs, fronted by a small wide-column/KV metadata index. The workload is write-once ~16KB blobs, read by key or batch-scanned — no updates, joins, or transactions. HDFS breaks on object count: the NameNode holds ~150 bytes RAM per object, so 30B objects ≈ 4.5TB of heap and it caps around 300-500M files. Cassandra/Bigtable want small mutable values (<~10KB); 16-100KB immutable blobs trigger compaction storms and need ~250-500 nodes for 500TB. Object storage is native to immutable key-addressed blobs: ~11 nines durability, tiering, infinite scale, 190MB/s spread across sharded prefixes. Keep the bytes in the blob store and a ~3TB metadata index (url_hash → storage_url, content_hash) in the DB for fast lookups and dedup. Pack pages into WARC containers for efficient batch indexing."},
    {q:"Size the fetch fleet to sustain 12K pages/s using Little's law. How many concurrent connections and machines?",a:"Little's law: in-flight = rate × latency. 12,000 pages/s × ~0.4s average fetch ≈ 4,800 concurrent sockets fleet-wide, ~24K at 3-5x peak. Fetching is IO-bound, so a single async (epoll-style) worker comfortably holds ~5K sockets — raw throughput needs only a box or two. But you run ~200 workers not for throughput: it is for domain-hash partitioning (local politeness, warm per-host DNS and TCP, localised seen-set) and blast radius (losing 1 of 200 drops 0.5% of capacity). So each worker carries only ~24 sockets and ~60 fetches/s. Size by partitioning and fault-tolerance, not the Little's-law minimum."},
    {q:"A worker built for 12K pages/s is pinned at 3K/s — CPU and network idle, but every fetch blocks ~200ms on DNS. Diagnose and fix.",a:"DNS is a hidden per-fetch cost that dominates once everything else is async. Add a caching DNS resolver in front of the fetchers: the same hosts recur constantly, so a cache with a sane TTL turns most lookups into memory reads — at ~50 distinct new hosts/s against 12K fetches/s the hit ratio is over 99%, dropping DNS load from 12K/s to ~100/s. Make resolution fully async and pipelined so a miss blocks only its own fetch, and prefetch hosts while their URLs still sit in the frontier. Run your own recursive resolver fleet (bind/unbound) to avoid third-party rate limits, sized to the new-host discovery rate, not total fetch rate. Domain partitioning keeps each worker's DNS working set small and cache-friendly."},
    {q:"A site injects 40M unique but worthless URLs (infinite calendar, faceted search) into the frontier in an hour. Dedup does not help — the URLs are genuinely new. Contain it.",a:"This is a crawler trap / infinite URL space. Three defenses: (1) per-domain URL budget — cap how many URLs you enqueue from one host, so 40M from one site is impossible by construction; (2) max crawl depth — 'next month' chains die at depth K; (3) pattern detection — flag hosts with runaway query-param cardinality or repeating path segments and de-prioritise or blacklist the pattern. Budgets are blunt, so distinguish a trap from a genuinely huge catalog by signal quality: a trap emits near-duplicate pages (content-dedup/SimHash flags them as near-zero new information), so feed the content-dedup rate back into admission — if more than X% of a host's fresh pages are near-duplicates, throttle its enqueue budget hard while a novel big site keeps its budget."},
    {q:"News pages change every few minutes; an archived PDF has not changed in 3 years. A fixed 30-day recrawl makes news stale and wastes budget on dead pages. Design recrawl.",a:"Freshness must be adaptive per-page, not a global cycle. Estimate each page's change rate from history — track content hashes across fetches and measure how often they differ — and set the recrawl interval inversely: a page changing hourly is recrawled roughly hourly, a static PDF drifts out to monthly. Use cheap signals to avoid wasted fetches: HTTP conditional requests (If-Modified-Since / ETag) return a bodyless 304 for unchanged pages, and sitemaps with lastmod / changefreq hints tell you what moved without polling. To keep scheduler state small, bucket pages into a few change-rate tiers (hourly/daily/monthly) rather than a per-page timer, and keep only the due-soon window hot. The scheduler feeds due-for-recrawl URLs back into the frontier at the appropriate priority."},
  ]
};


(function(){
var d=window.DATA['crawler'];
var scaling={id:"scaling",name:"From seed loop to web-scale crawl",kind:"scale",
  live:["seed","frontier","fetcher","parser"],
  summary:"Start with the smallest crawler loop, then let the numbers force each box: DNS caching, per-domain politeness, dedup, and durable page storage. Each step adds exactly one component because one concrete ceiling was crossed.",
  steps:[
    {node:"frontier",stage:"Stage 0 · Baseline",title:"One crawl loop — schedule, queue, fetch, parse",
      live:["seed","frontier","fetcher","parser"],
      edges:[["seed","frontier","seed URLs"],["frontier","fetcher","next URL"],["fetcher","parser","raw HTML"],["parser","frontier","new links"]],
      narrate:"Draw the honest MVP first: a scheduler seeds URLs, the frontier hands one to a fetcher, the parser extracts links, and those links go back into the frontier. It can crawl a demo slice correctly, but every external dependency is still hidden inside the fetcher and every new link is trusted.",
      details:[
        {k:"pain",label:"What breaks — a concrete case",text:"At **06:00**, the **Northwind News crawl** starts from 10K news, shopping and government seeds after a product launch. The MVP loop fetches **300 pages/s** on one 32-vCPU box and immediately discovers **~3K URLs/s**. By **06:08**, repeated author pages and calendar links have inflated the in-memory frontier to **1.4M queued URLs**; by **06:20**, the fetcher is 70% idle because the single queue lock and parser enqueue path dominate. The target is **1B pages/day ≈ 12K pages/s**, so this design is already **40× short** before DNS, politeness or storage are visible."},
        {k:"fix",label:"The fix — walk the same case with the honest loop",text:"Keep the same four boxes, but size the baseline as a sharded crawl loop: **200 frontier/fetcher workers**, each owning `hash(domain)%200`, each needing only **~60 pages/s** to reach **12K/s** fleet throughput. Northwind's 10K seeds now spread across workers; the parser emits **~120K discovered URLs/s**, and the visible next question becomes admission control rather than one locked queue. It is still not web-safe, but the baseline now explains the real ceilings the next stages fix."},
        {k:"host",label:"Load & capacity — what runs it",text:"**Frontier MVP**: 200 Redis Streams or RocksDB-backed queue shards, **1 active + 1 standby per shard**. Fleet ready-set is ~**600GB** for ~3B in-flight URLs at ~200B each, so each active shard holds **~3GB** plus spill; a 16GB worker has room for queues, host state and parser buffers. **Fetcher/parser**: 200 async workers at **~60 pages/s each** is below the per-box network ceiling of ~12.5K/s, leaving CPU for ~20ms static parsing. Why 200 not 20: 20 workers would each carry **30GB** queue state and huge domain skew; 200 keeps failover and rebalancing small."},
        {k:"query",label:"The loop",code:"seed due URLs -> frontier.push(url)\nfrontier.pop() -> fetcher.download(url)\nparser.extract_links(html) -> frontier.push(canonical_links)\nparser.extract_text(html) -> index pipeline"}
      ],
      snap:{title:"Load & capacity — Stage 0",cap:"The loop is now sized for the crawl budget, but all hidden external controls still land on the fetcher and frontier.",
        tables:[{name:"signals",cols:["signal","value","verdict"],rows:[
          {c:["Frontier queue","200 RocksDB queue shards · 1 active + 1 standby","N+1 per shard"],hi:1,tag:"sized"},
          {c:["Fetch budget","12K pages/s ÷ 200 ≈ 60 pages/s each","headroom"],hi:1},
          {c:["New-link fan-out","~120K URLs/s","admission pressure"],hi:1},
          {c:["Known pages","30B target","not yet deduped"],tag:"risk"},
          {c:["External controls","DNS, robots, rate limits hidden in fetcher","demo only"],tag:"risk"}
        ]}]}},
    {node:"dns",stage:"Stage 1 · DNS cache",title:"A lookup per fetch blocks slots &rarr; add cached DNS",
      live:["seed","frontier","fetcher","parser","dns"],
      edges:[["frontier","fetcher","next URL"],["fetcher","dns","resolve"],["fetcher","parser","raw HTML"]],
      narrate:"At 12K pages/s, resolving a hostname on the hot path is no longer background noise. A blocking lookup per page burns fetch slots and can turn an upstream resolver hiccup into a crawler-wide stall.",
      details:[
        {k:"pain",label:"What breaks — a concrete case",text:"At **07:15**, Northwind hits a breaking-news cluster: **2.4M URLs** across **48K hosts**. The MVP fetcher does a fresh DNS lookup for every page, so the fleet generates **~12K recursive DNS requests/s**. The corporate resolver starts rate-limiting at **~2K/s**; median lookup jumps from **20ms to 900ms**. Fetchers still show thousands of open slots, but **~80%** are waiting on DNS instead of downloading pages, so crawl throughput falls from **12K/s to ~2.5K/s** and the news index misses the first hour."},
        {k:"fix",label:"The fix — walk the same case with cached DNS",text:"Add a partitioned DNS service with TTL-aware in-memory cache, async refresh, and single-flight per host. In the same Northwind run, the **12K checks/s** still happen, but cache locality over the **~100M host** universe means only **~100–200 real misses/s** leave the fleet. Hot hosts like `www.northwindnews.example` refresh once per TTL, not once per URL. Fetch throughput returns to **~12K/s**, and a resolver hiccup consumes miss traffic, not every socket."},
        {k:"host",label:"Load & capacity — what runs it",text:"**DNS cache**: 16 Unbound/CoreDNS resolver-cache nodes, each **8 vCPU / 16GB**, fronted by consistent hashing; each node has **1 warm standby** for N+1. Cache **100M host records × ~100B ≈ 10GB fleet**, or **~625MB/node** before overhead, so memory is easy. Miss load **200/s ÷ 16 ≈ 13/s/node** is tiny; the point is latency isolation and single-flight, not raw QPS. TTLs are honored, and connect failure forces re-resolve."},
        {k:"gotcha",label:"Stale IPs are recoverable",text:"Honor DNS TTLs, and on connect failure force a re-resolve. A stale address wastes one fetch attempt; it must not poison the host forever."}
      ],
      snap:{title:"Load & capacity — Stage 1",cap:"DNS is now a cached lookup, not a per-page external dependency.",
        tables:[{name:"signals",cols:["signal","before","after"],rows:[
          {c:["DNS tier","none","16 CoreDNS cache nodes + 16 warm standbys · N+1"],hi:1,tag:"fixed"},
          {c:["Lookups implied","~12K /s recursive","~12K cache checks/s"]},
          {c:["Real DNS misses","~12K /s worst case","~100–200 /s fleet"],hi:1},
          {c:["Per-node miss load","resolver rate-limited","~13 /s on 16 nodes"],hi:1},
          {c:["Fetch slot blocked by DNS","common on miss","rare"]}
        ]}]}},
    {node:"politeness",stage:"Stage 2 · Politeness",title:"Parallel fetchers can hammer one host &rarr; enforce per-domain rate",
      live:["seed","frontier","fetcher","parser","dns","politeness"],
      edges:[["frontier","fetcher","next URL"],["fetcher","dns","resolve"],["fetcher","politeness","rate check"],["fetcher","parser","raw HTML"]],
      narrate:"More fetchers raise global throughput, but they also make it easy to send many concurrent requests to one unlucky domain. A crawler that ignores robots.txt and crawl-delay gets blocked and can harm sites.",
      details:[
        {k:"pain",label:"What breaks — a concrete case",text:"At **08:00**, Northwind's parser discovers a product sitemap from **Harbor Books** with **3M URLs**. Without single-owner host state, 200 workers each see a different slice and each thinks it is safe to fetch. For five minutes Harbor Books receives **~600 requests/s** even though `robots.txt` asks for **1 request every 2s**. Their origin returns **429**, then blocks the crawler IP range. The crawler wastes **180K failed fetches**, loses freshness for that store, and risks being treated as abuse."},
        {k:"fix",label:"The fix — walk the same case with host-affine rate state",text:"Co-locate each domain's back-queue, robots cache and last-hit timestamp on one frontier shard. Harbor Books hashes to shard 117, so all **3M URLs** line up behind one token bucket at **0.5 requests/s**; excess URLs stay queued or are down-prioritized while other domains keep the fleet at **12K/s**. The crawler is slower on that one host by design, but the global crawl budget is preserved and Harbor Books is never hammered."},
        {k:"host",label:"Load & capacity — what runs it",text:"**Politeness state** lives in the same 200 RocksDB frontier shards: one owner per domain plus one standby. Store **~100M host records × ~50B timing state ≈ 5GB fleet**, plus robots cache **~100M × ~1KB ≈ 100GB fleet**, about **525MB/shard** before compression. That fits beside the ~3GB ready-set. Why shard by domain: per-host ordering and rate tokens must be local; a central limiter would see **12K checks/s** and become a correctness bottleneck."},
        {k:"key",label:"Why co-locate with frontier",text:"The queue and rate decision need the same ordering. Domain affinity avoids a central rate-limit service and avoids cross-worker races on one host."}
      ],
      snap:{title:"Load & capacity — Stage 2",cap:"Global throughput can rise while every individual domain remains protected.",
        tables:[{name:"signals",cols:["signal","value","verdict"],rows:[
          {c:["Politeness store","200 RocksDB frontier shards · 1 active + 1 standby","domain owner + N+1"],hi:1,tag:"fixed"},
          {c:["Workers","~200","parallel globally"]},
          {c:["Timing state","~5GB fleet ≈ 25MB/shard","small"]},
          {c:["robots cache","~100GB fleet ≈ 500MB/shard","fits RAM"]},
          {c:["Per-domain owner","hash(domain)%200","no race"],hi:1}
        ]}]}},
    {node:"dedup",stage:"Stage 3 · Dedup",title:"120K discovered URLs/s explodes the frontier &rarr; add seen-set",
      live:["seed","frontier","fetcher","parser","dns","politeness","dedup"],
      edges:[["frontier","fetcher","next URL"],["fetcher","parser","raw HTML"],["parser","dedup","seen?"],["parser","frontier","new links"]],
      narrate:"The parser emits about ten links per fetched page. At the target crawl rate that is 120K enqueue attempts every second, most of them duplicates, parameter variants, traps, or already-known URLs.",
      details:[
        {k:"pain",label:"What breaks — a concrete case",text:"At **09:20**, Northwind enters the **Civic Calendar** trap: every page links to `?month=next` forever. The parser still emits **~10 links/page**, so at **12K pages/s** the frontier sees **~120K enqueue attempts/s**. Without a seen-set, the same meeting pages appear under tracking params, calendar offsets and slash variants; by lunch one trap domain has **280M queued URLs** and displaces higher-value news recrawls. Fetch capacity is spent proving the same pages are duplicates after download, which is the most expensive place to learn it."},
        {k:"fix",label:"The fix — walk the same case with URL and content dedup",text:"Canonicalize before admission, then check a partitioned Bloom seen-set keyed by normalized URL. In the same Civic Calendar case, repeated URLs are rejected before they touch the frontier; new calendar variants hit per-domain caps and depth rules. For **30B known URLs** at ~**1%** false positives, the Bloom filter is **~37GB fleet**, so each of 200 workers owns **~190MB**. Content SimHash later collapses near-duplicate pages that different URLs still reach."},
        {k:"host",label:"Load & capacity — what runs it",text:"**Dedup tier**: 200 partitioned Bloom-filter shards in RocksDB or RedisBloom, each **1 active + 1 standby** and aligned with domain/frontier ownership. Sizing: **30B URLs × 9.6 bits ≈ 288B bits ≈ 36GB**, rounded to **~37GB**; per shard **~185–190MB**, plus an exact LRU for high-value URLs. Check rate **120K/s ÷ 200 ≈ 600/s/shard**, far below memory lookup limits. Exact hashset would be **3TB+** at ~100B/url, which is why Bloom is the admission gate."},
        {k:"gotcha",label:"False positives",text:"A Bloom false positive can skip a real URL. Tune it below ~1% and optionally exact-check high-value URLs; it slightly reduces coverage, but it never corrupts stored content."}
      ],
      snap:{title:"Load & capacity — Stage 3",cap:"Dedup turns infinite discovery into bounded admission.",
        tables:[{name:"signals",cols:["signal","before","after"],rows:[
          {c:["Dedup store","none","200 Bloom shards · 1 active + 1 standby · N+1"],hi:1,tag:"fixed"},
          {c:["Enqueue attempts","~120K /s","~600 checks/s/shard before admit"],hi:1},
          {c:["Seen memory","3TB+ exact","~37GB Bloom fleet"],hi:1},
          {c:["Per worker seen-set","unbounded","~190MB + hot exact LRU"]},
          {c:["Trap domains","grow forever","capped + filtered"]}
        ]}]}},
    {node:"store",stage:"Stage 4 · Content store",title:"Bytes outgrow workers &rarr; split blob store from metadata",
      live:["seed","frontier","fetcher","parser","dns","politeness","dedup","store"],
      edges:[["frontier","fetcher","next URL"],["fetcher","parser","raw HTML"],["parser","dedup","seen?"],["parser","frontier","new links"],["parser","store","save page"]],
      narrate:"Once the crawler is polite and bounded, the remaining scale is durable bytes. Parsed content and raw pages cannot live on worker disks; the system needs a write-once archive plus a small lookup index.",
      details:[
        {k:"pain",label:"What breaks — a concrete case",text:"By the end of day one, Northwind has fetched **1B pages**. If workers keep page bytes on local disks, **~16TB compressed/day** is scattered across 200 machines; a single worker loss drops that shard's pages, and the indexer cannot replay cleanly. If every page is written as a tiny file, the metadata layer sees **12K creates/s** and billions of inodes. If raw **100KB** pages are kept without packing, the monthly corpus is **~3PB** before compression and impossible to manage from worker disks."},
        {k:"fix",label:"The fix — walk the same case with WARC blobs and metadata",text:"Pack pages into immutable **WARC** objects and write them to object storage; keep only a narrow metadata index keyed by URL hash with content hash, fetch time and object pointer. Northwind's **12K pages/s × 16KB compressed ≈ 190MB/s** becomes large sequential object writes, not tiny files. A lost worker only replays uncommitted frontier leases; already-written WARC objects survive and the metadata index can be rebuilt by scanning WARC headers."},
        {k:"host",label:"Load & capacity — what runs it",text:"**Blob store**: S3/GCS-style object storage with **3× durability replication** or erasure coding, WARC objects around **128MB** each. At **190MB/s**, writers create about **1.5 objects/s**, not 12K files/s; daily compressed bytes are **~16TB**, monthly **~500TB**. **Metadata index**: Cassandra or Bigtable with **64 tablets/shards, RF3**; **30B rows × ~100B ≈ 3TB logical**, **~9TB RF3**, or **~140GB/shard** before overhead. Why 64: scans and writes stay small, and losing one replica still leaves quorum."},
        {k:"note",label:"Rebuild path",text:"If the metadata index is corrupt, scan WARC headers to rebuild it. The immutable bytes are the durable source; the index is the fast map."}
      ],
      snap:{title:"Load & capacity — Stage 4 (full design)",cap:"The final design has a bounded frontier, polite fetch, cheap DNS, dedup, and durable crawl output.",
        tables:[{name:"signals",cols:["concern","mechanism","result"],rows:[
          {c:["Blob volume","S3 WARC objects · 3× replicated","~500TB compressed/month"],hi:1,tag:"fixed"},
          {c:["Write rate","128MB objects","~190MB/s ≈ 1.5 objects/s"]},
          {c:["Metadata","Cassandra/Bigtable · 64 shards · RF3","~3TB logical, quorum safe"],hi:1},
          {c:["Why 64 shards","30B ÷ 64 ≈ 470M rows/shard","fits compaction windows"]},
          {c:["Durability","object storage replication","pages survive worker loss"],hi:1}
        ]}]}},
  ]}
d.deepFlows=[scaling].concat(d.deepFlows);
})();
