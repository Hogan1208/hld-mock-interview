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
  edges:[["seed","frontier"],["frontier","fetcher"],["fetcher","parser"],["parser","frontier"],["parser","store"],["fetcher","dns"],["fetcher","politeness"],["parser","dedup"]],
  core:["seed","frontier","fetcher","parser"],
  basic:["seed","frontier","fetcher","parser"],
  requirements:{
    functional:[
      "Crawl the web starting from a set of seed URLs, downloading each page",
      "Extract outbound links from every page to discover and crawl more pages",
      "Store page content and hand clean text to the search-index pipeline",
      "Skip URLs and content already seen so no page is re-crawled",
    ],
    nonFunctional:[
      "Scale to billions of pages — roughly 30B pages at ~12K pages/s sustained",
      "Be polite — never overload a host, and honour robots.txt and crawl-delay",
      "Resist traps and duplicates so fetch budget is not wasted on junk pages",
      "Keep content reasonably fresh, recrawling pages roughly as they change",
    ],
  },
  reqBuild:[
    {req:"Fetch pages starting from seed URLs",turns:[
      {who:"intv",text:"Start with the simplest thing that satisfies requirement one: crawl outward from a handful of seed URLs. What is the minimal path?"},
      {who:"cand",text:"The <strong>seed / scheduler</strong> enqueues the start URLs into the <strong>URL frontier</strong>; the <strong>fetcher pool</strong> pulls a URL, downloads the page, and hands the bytes to the <strong>parser</strong>. That loop — seed, frontier, fetcher, parser — is the whole crawler in miniature, and my four core boxes already cover it. The parser will eventually feed newly-found links back into the frontier, but for requirement one I only need pages flowing down from the seeds."},
      {who:"intv",text:"Where do URLs wait between being discovered and being fetched — why a dedicated frontier box rather than a list inside the fetcher?"},
      {who:"cand",text:"The frontier is a queue that <strong>decouples discovery rate from fetch rate</strong>. Discovery is bursty — one page can yield hundreds of links — while fetching is paced and IO-bound, so I don't want that buffer living in a fetcher's memory. Keeping it separate lets the fetchers be stateless workers that just pull the next URL, and it gives me one place to later attach ordering, priority, and politeness. For now it is a simple durable queue seeded by the scheduler."},
    ],resources:[
      {title:"Hello Interview — web crawler",url:"https://www.hellointerview.com/learn/system-design/answer-keys/web-crawler"},
      {title:"Wikipedia — Web crawler",url:"https://en.wikipedia.org/wiki/Web_crawler"},
    ]},
    {req:"Extract links and store page content (adds a content store)",reveal:["store"],turns:[
      {who:"intv",text:"Requirement two: once a page is downloaded you need its links to keep crawling and its content kept somewhere. Walk the parser's outputs and add whatever you need."},
      {who:"cand",text:"The parser produces two things: <strong>outlinks</strong>, fed back into the frontier to continue the crawl, and <strong>content</strong> — extracted text plus metadata — that has to be persisted. Extracted content has nowhere to land in my core boxes, so let me add a <strong>content store</strong>. The parser writes the raw compressed HTML and the extracted text there, and the outlinks loop back into the frontier so the crawl keeps expanding outward from the seeds."},
      {who:"intv",text:"Why persist the raw HTML at all if you have already extracted the text you care about?"},
      {who:"cand",text:"Reprocessing. My extraction logic evolves — better boilerplate removal, new metadata, new models — and re-running it against stored raw HTML is far cheaper and politer than re-crawling the live pages. The raw store is the crawler's <strong>replay log</strong>: crawl a page once, extract from it many times. Storage is cheap; re-fetching is expensive and hammers other people's servers, so I keep the bytes and only re-crawl for freshness, not for reprocessing."},
    ],resources:[
      {title:"Hello Interview — web crawler",url:"https://www.hellointerview.com/learn/system-design/answer-keys/web-crawler"},
      {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
    ]},
    {req:"Avoid re-crawling duplicate URLs and content (adds dedup)",reveal:["dedup"],turns:[
      {who:"intv",text:"Requirement three: the same page is reachable by many links, and the parser keeps re-discovering URLs you have already crawled. How do you stop crawling them again?"},
      {who:"cand",text:"Before enqueuing any outlink I check it against a <strong>dedup / seen-set</strong> — let me add that box. If a URL has been seen, I drop it; only genuinely new URLs enter the frontier, so the fetcher never spends budget re-downloading a page it already has. I also <strong>normalise</strong> the URL before the check — lowercasing the host, resolving relative links, stripping fragments and tracking params — so the many spellings of one page collapse to a single canonical entry the seen-set can recognise."},
      {who:"intv",text:"URL dedup catches the same address. What about two different URLs that serve identical or near-identical content?"},
      {who:"cand",text:"That is <strong>content dedup</strong>, a separate concern from URL dedup. For exact duplicates I fingerprint the normalised content with a checksum and index it once; for near-duplicates — a print view versus a web view, mirrors, boilerplate pages — I use a similarity fingerprint like SimHash so pages within a small distance are flagged as the same. I keep one canonical copy and link the rest to it. How I build and scale that seen-set — a Bloom filter, partitioned per host — is a deep dive, but functionally: normalise, check, and only crawl the new."},
    ],resources:[
      {title:"Wikipedia — Web crawler",url:"https://en.wikipedia.org/wiki/Web_crawler"},
      {title:"Hello Interview — web crawler",url:"https://www.hellointerview.com/learn/system-design/answer-keys/web-crawler"},
    ]},
  ],
  systemDives:[
    {title:"The crawler DDoSes one domain and its IP gets banned",tag:"failover",reveal:["politeness"],turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a worker discovers <b>200K URLs</b> on one small host and fetches them as fast as it can — <b>800 requests/s</b> to a single site. The origin falls over, its operator sees the flood, and blocks your entire crawler IP range, cutting you off from that host <em>and</em> collateral hosts on shared infrastructure. Contain the damage.</span>"},
      {who:"cand",text:"I effectively <strong>DDoSed</strong> the host — an unbounded fetch rate per domain is the root cause. I need a <strong>politeness / rate-limiting</strong> component that caps requests per host; let me add it. The rule: fetch any one host no faster than a conservative rate — honour its <code>Crawl-delay</code> if present, else a safe default — regardless of how many of its URLs I have queued. That single constraint makes the 800/s flood impossible by construction.<span class='eg'>Crawl-delay 10s means at most 1 fetch every 10s to that host, so 200K URLs drain slowly and politely instead of in one destructive burst.</span>"},
      {who:"intv",text:"You are already banned. Politeness prevents the <em>next</em> one — what about the current ban and the shared-IP collateral?"},
      {who:"cand",text:"Two parts. For the ban: <strong>exponential backoff</strong> on 429/503, stop hitting the host entirely for a cooldown, then re-approach at a crawl rate; and expose a clear <code>User-Agent</code> with contact info so an operator can reach me instead of block-and-forget. For collateral: politeness is keyed on <strong>host and also on IP</strong> — if many hosts share one IP (shared hosting or a CDN) I rate-limit at the IP level too, so I never overwhelm the underlying server. And I respect <code>robots.txt</code> up front, which often tells me not to crawl those paths at all."},
      {who:"intv",text:"Fetching robots.txt and tracking per-host state costs fetches and memory. How do you keep politeness cheap at fleet scale?"},
      {who:"cand",text:"I <strong>cache robots.txt per host</strong> with a TTL and reuse it across all of that host's URLs, so it is one small fetch amortised over potentially millions of pages. More importantly, I <strong>partition the crawl by hash of the registered domain</strong>, so every URL for a host is owned by exactly one worker. That worker holds the host's cached robots rules, its last-fetch times, and its rate budget <em>locally</em> — politeness becomes a per-worker decision with no cross-worker coordination. Locality is what makes correctness cheap here."},
    ],resources:[
      {title:"The Robots Exclusion Protocol",url:"https://www.robotstxt.org/robotstxt.html"},
      {title:"Hello Interview — web crawler",url:"https://www.hellointerview.com/learn/system-design/answer-keys/web-crawler"},
    ]},
    {title:"DNS resolution latency dominates and throughput collapses",tag:"scaling",reveal:["dns"],turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> you profile a worker meant to sustain <b>12K pages/s</b> and it is stuck at <b>3K/s</b>. CPU is idle, network is idle — but every fetch blocks ~<b>200ms</b> on a <b>DNS lookup</b>, and your resolver is doing 12K queries/s. DNS is the bottleneck. Fix it.</span>"},
      {who:"cand",text:"DNS resolution is a hidden per-fetch cost that dominates once everything else is async. The fix is a dedicated <strong>caching DNS resolver</strong> in front of the fetchers — let me add that component. Most fetches go to hosts I have already resolved, so a cache with a reasonable TTL turns 12K DNS queries/s into a trickle of misses.<span class='eg'>Crawling 12K pages/s but only ~50 distinct new hosts per second gives a hit ratio over 99%, dropping DNS load from 12K/s to ~100/s.</span>I also make resolution <strong>async</strong> so a lookup never blocks the event loop, and pre-resolve hosts while their URLs still sit in the frontier."},
      {who:"intv",text:"A shared cache helps, but public DNS resolvers will rate-limit you at crawl scale. What then?"},
      {who:"cand",text:"Run my <strong>own recursive resolver</strong> fleet rather than leaning on a third party — I control capacity and caching and I am not subject to someone else's rate limit. I warm it with the hosts I am about to crawl, honour TTLs but extend them slightly for stability, and shard resolvers behind the workers. Because I partition the crawl by domain, each worker's host set is stable, so its DNS working-set is small and cache-friendly — the coordination design and the DNS win compound."},
      {who:"intv",text:"A burst into many <em>new</em> domains tanks the cache hit ratio. How do you keep misses from serialising and collapsing throughput again?"},
      {who:"cand",text:"A new-domain burst is a <strong>cache-miss storm</strong> where DNS goes serial and blocking. Three levers: <strong>(1) fully async, pipelined resolution</strong> — many concurrent lookups in flight so a 200ms miss blocks only its own fetch, not the loop; <strong>(2) prefetch</strong> — resolve hosts while their URLs are still queued, so by the time a URL is due its IP is already cached; <strong>(3) scale resolvers horizontally</strong>, sized to the <em>new-host discovery rate</em> rather than total fetch rate, autoscaling on resolver queue depth. Domain partitioning also spreads new-host bursts across workers instead of hitting one."},
    ],resources:[
      {title:"Hello Interview — web crawler",url:"https://www.hellointerview.com/learn/system-design/answer-keys/web-crawler"},
      {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
    ]},
    {title:"The frontier grows to billions of URLs — won't fit in memory",tag:"scaling",turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> the crawl discovers links faster than it fetches. The frontier swells to <b>3 billion URLs</b>; at ~200 bytes each that is <b>600GB</b> — it will not fit in the RAM of any worker. What now?</span>"},
      {who:"cand",text:"The frontier has to be <strong>disk-backed with a memory hot-set</strong>. Keep in RAM only what the next decisions need — the host heap of next-fetch times and the heads of active back queues — and spill the bulk of enqueued URLs to a <strong>persistent store</strong>, an embedded LSM store like RocksDB per worker or a distributed queue. Pages of the queue are read in as hosts become due to fetch.<span class='eg'>600GB across 200 workers is ~3GB each; RAM holds the heap plus queue heads (a few hundred MB) and disk holds the tail.</span>"},
      {who:"intv",text:"3 billion and climbing — is unbounded growth itself the bug?"},
      {who:"cand",text:"Often yes — unbounded growth usually means I am enqueuing junk (traps, low-value infinite spaces). So I bound it with policy, not just storage: <strong>per-domain URL caps</strong>, <strong>max depth</strong> from seed, and <strong>priority-based admission</strong> so low-value URLs are dropped rather than stored when the frontier is under pressure. Storage handles legitimate scale; admission control stops pathological growth. If it keeps growing after that, it is a signal to add fetch capacity, not frontier capacity."},
      {who:"intv",text:"With billions queued, how do you decide which URL to fetch next — is it just FIFO off disk?"},
      {who:"cand",text:"No — a single FIFO fails both priority and politeness. I use the <strong>Mercator-style two-stage design</strong>: <strong>front queues</strong> capture <em>priority</em> (one queue per priority band, a URL routed to a band by its score — homepages high, deep archive pages low), and <strong>back queues</strong> capture <em>politeness</em> (one queue per host). A min-heap of hosts keyed on each host's <em>earliest next-allowed fetch time</em> picks what a fetcher gets next. So priority decides <em>which</em> URLs are eligible and politeness decides <em>when</em> — the two dimensions stay decoupled even at billions of entries."},
    ],resources:[
      {title:"Hello Interview — web crawler",url:"https://www.hellointerview.com/learn/system-design/answer-keys/web-crawler"},
      {title:"Wikipedia — Web crawler",url:"https://en.wikipedia.org/wiki/Web_crawler"},
    ]},
    {title:"A spider trap generates infinite URLs",tag:"durability",turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> one site has a calendar with 'next month' links going infinitely, plus faceted-search URLs for every filter combination. Within an hour it injects <b>40M unique URLs</b> — all real, all distinct, all worthless — into the frontier. URL dedup does not help because they are genuinely new. Contain it.</span>"},
      {who:"cand",text:"This is a <strong>crawler trap / infinite URL space</strong>, and dedup is the wrong tool — the URLs <em>are</em> unique. Defenses: <strong>(1) per-domain URL budget</strong> — cap how many URLs I will enqueue from one host, so 40M from one site is impossible by construction; <strong>(2) max crawl depth</strong> — calendar 'next' chains die at depth K; <strong>(3) pattern detection</strong> — flag hosts generating URLs with runaway query-param cardinality or repeating path segments and de-prioritise or blacklist the pattern.<span class='eg'>Cap example.com at 500K URLs; a calendar param beyond depth 8 is simply refused enqueue.</span>"},
      {who:"intv",text:"Budgets are blunt — a legitimately huge site, a big catalog, also hits the cap. How do you tell a trap from a big real site?"},
      {who:"cand",text:"Signal quality, not just count. A real catalog's pages have <strong>distinct content</strong>; a trap emits <strong>near-duplicate</strong> pages that content-dedup and SimHash flag with near-zero incremental information. So I feed the <em>content-dedup rate</em> back into admission: if more than X% of a host's newly-fetched pages are near-duplicates of what I already have, I throttle its enqueue budget hard. A legit big site keeps its budget because its pages are novel. Budgets are the safety net; content similarity is the smart discriminator."},
      {who:"intv",text:"While all this is churning, a worker restarts for a kernel patch. Do the tens of millions of discovered-but-unfetched URLs just vanish?"},
      {who:"cand",text:"They must not — rediscovery is expensive and non-deterministic, so frontier <strong>durability</strong> is a first-class requirement. Because the frontier is already disk-backed, enqueue is a <strong>durable append</strong> and the worker reopens its store and resumes after the restart. Dequeue is a <strong>lease with a visibility timeout</strong>, not a delete: a URL handed to a fetcher is marked in-flight, and if the worker dies mid-fetch the lease expires and the URL becomes visible again — <strong>at-least-once</strong> processing. A rare double-fetch is harmless (dedup catches it, and it is rate-limited); a <em>lost</em> URL is the outcome I actually design against."},
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
    ],
  }
};
