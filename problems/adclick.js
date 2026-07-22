window.DATA = window.DATA || {};
window.DATA['adclick'] = {
  cat:"streaming · aggregation · exactly-once",
  title:"Design an ad click aggregator",
  blurb:"Ingest millions of ad clicks/s, roll them into per-ad/per-minute metrics advertisers query in near-real-time, accurately, and tolerate faults + late data.",
  prompt:"Let's design an ad click aggregator. It ingests a firehose of ad-click events — millions per second — aggregates them into per-ad, per-minute metrics that advertisers query in near-real-time, has to be accurate enough to bill on, and must survive faults and late-arriving data. Start with the high-level architecture and rough numbers, then we'll drill into components — and I'll be throwing failure scenarios at you.",
  opening:"Let me frame it before drawing boxes.<br><br><strong>Functional:</strong> ingest click events, aggregate per-ad/per-minute counts (plus dims like geo/device), let advertisers query recent + historical metrics, and be accurate enough to bill on (dedup / exactly-once-ish). <strong>Non-functional:</strong> ingest millions/s with bursts, dashboard freshness within ~1 minute, query p99 < 1s, no data loss on faults, and correctness even with late/out-of-order events.<br><br><strong>Back-of-envelope:</strong> average ~1M clicks/s, peaks ~10M/s. ~10M active ads, ~1M advertisers, heavily skewed (a few ads/advertisers dominate). Raw volume ~86B events/day; at ~100 bytes each that's ~8.6 TB/day of raw events (retained for replay). Aggregates collapse to bounded per-ad/per-minute rows the query path can scan in ms.<br><br>I'll start deliberately minimal: <strong>ad/browser → ingest gateway → event log (Kafka) → aggregator</strong>. That skeleton captures the click and produces counts. As we hit scale, exactly-once, and failure pressure I'll grow it — where aggregates are stored and queried, dedup, and a batch reconciliation path. Pick a box and let's push on it.",
  nodes:[
    {id:"client",name:"Ad / browser",sub:"click events",x:40,y:150},
    {id:"gw",name:"Ingest gateway",sub:"validate + enrich",x:210,y:150},
    {id:"stream",name:"Event log",sub:"Kafka",x:380,y:150},
    {id:"agg",name:"Aggregator",sub:"windowed rollup",x:550,y:150},
    {id:"olap",name:"OLAP store",sub:"aggregates",x:550,y:40},
    {id:"dedup",name:"Dedup / idemp",sub:"exactly-once",x:380,y:40},
    {id:"batch",name:"Batch recompute",sub:"reconciliation",x:380,y:260},
    {id:"query",name:"Query API",sub:"advertiser reads",x:720,y:150},
  ],
  edges:[["client","gw"],["gw","stream"],["stream","agg"],["agg","olap"],["stream","dedup"],["agg","batch"],["olap","query"]],
  core:["client","gw","stream","agg"],
  basic:["client","gw","stream","agg"],
  dbDoc:{
    component:"OLAP / aggregate store",
    load:"Writes are per-<code>(ad_id, minute)</code> upserts, so they scale with <strong>active ads/minute</strong>, not clicks: ~1M ads active/min &approx; <strong>~17K upserts/s</strong> steady, bursting toward ~2M/s during a spike (buffered through a topic). Reads: ~50K advertiser dashboard QPS at peak, cut to <strong>~5K scan QPS</strong> after a result cache, each a range + group-by over minute-buckets with p99 &lt; 1s. Time-series cardinality ~10M distinct ads &times; dims (geo, device) over ~1.44B minute-rows/day.",
    candidates:[
      {name:"Druid",ceiling:"real-time ingest ~10-50K rows/s/node; brokers fan reads out to historicals for QPS scale",nodes:"buffered writes ~17K/s &rarr; a few ingest nodes; 5K scan QPS &divide; ~1K QPS/node &approx; ~5-8 query nodes; storage ~20TB (90d &times; RF2) &divide; ~2TB/node &approx; <strong>~10 nodes</strong> &mdash; storage dominates",pick:true,note:"chosen &mdash; native time-partitioned segments + ingest rollup + deep-storage durability, and the batch layer corrects a bad window by atomically swapping immutable segments."},
      {name:"ClickHouse",ceiling:"ingest king ~100K-1M+ rows/s/node batched, and the fastest columnar scans",nodes:"ingest never the bound (~1-2 nodes); ~10 nodes on storage &mdash; but upsert-by-key is merge-based (ReplacingMergeTree)",pick:false,note:"fastest scans + ingest, but billing needs idempotent overwrite-by-key and merge-based upserts make that awkward &mdash; revisit for append-mostly analytics."},
      {name:"Cassandra",ceiling:"~10-50K writes/s/node, but wide-column KV with no group-by engine",nodes:"storage ~10 nodes, yet every range + group-by forces app-side summation",pick:false,note:"serves point reads, not the range + group-by aggregation that is the entire query pattern here &mdash; wrong tool."},
    ],
    indexing:"Key = <strong>(time-bucket, ad_id)</strong>. Segments are partitioned by <strong>time</strong> &mdash; minute &rarr; hour &rarr; day &mdash; so a range scan touches only the segments inside the window and old data expires by dropping whole segments; within a segment rows are sorted/indexed by <code>ad_id</code> so an advertiser's rows sit contiguous. Ingest-time <strong>rollup</strong> means a long-range query hits the coarsest rollup that answers it &mdash; ~30 day-rows for a 30-day view, not 43,200 minute-rows. The <strong>columnar layout</strong> is what makes range + group-by cheap: a query reads only the <code>count</code> and grouped-dim columns off disk, scans them sequentially, and vectorizes the aggregation, with dictionary + bitmap indexes on low-cardinality dims like geo &amp; device to skip non-matching blocks.",
    decision:"Pick <strong>Druid</strong> (Pinot a very close second). The query pattern is range + group-by over time-bucketed aggregates, so I need a <strong>column-oriented OLAP</strong> store with time-partitioned segments, ingest rollup, and deep-storage durability &mdash; and the store is sized by <strong>storage (~10 nodes)</strong> and read concurrency, never the buffered ~17K/s write rate. Druid's immutable time-partitioned segments line up with the lambda design: the batch layer corrects a bad window by <strong>atomically swapping segments</strong>. <strong>Not ClickHouse:</strong> it wins on raw ingest and scan speed, but billing needs idempotent overwrite-by-key and its merge-based (ReplacingMergeTree) upsert makes that awkward &mdash; I'd revisit it for append-mostly analytics. <strong>Not Cassandra:</strong> it's a point-read wide-column KV with no group-by engine, so it forces app-side summation of the exact range + group-by that is the whole query pattern. <strong>Pinot</strong> I'd flip to if peak QPS climbed much higher or I leaned on its native primary-key upsert.",
  },
  schema:{tables:[
    {name:"raw_click_events",pk:"click_id",columns:[
      ["click_id","varchar(32)","client-minted id, primary key + dedup key"],
      ["ad_id","bigint","which ad (partition key)"],
      ["user_id","varchar(32)","anonymised user/device id"],
      ["ts","timestamptz","client event-time of the click"],
      ["ip","inet","source IP (geo enrichment)"],
    ],rows:[
      ["c-8f3a","42","u-19d2","2026-07-22 12:00:59","203.0.113.7"],
      ["c-8f3b","42","u-77aa","2026-07-22 12:01:03","198.51.100.4"],
      ["c-91cd","108","u-19d2","2026-07-22 12:01:04","203.0.113.7"],
    ]},
    {name:"aggregates",pk:"(ad_id, minute_bucket)",columns:[
      ["ad_id","bigint","which ad"],
      ["minute_bucket","timestamptz","start of the 1-minute tumbling window"],
      ["count","bigint","clicks in that window"],
      ["batch_version","int","0 = speed layer, higher = finalized by batch"],
    ],rows:[
      ["42","2026-07-22 12:00:00","18432","0"],
      ["42","2026-07-22 12:01:00","17190","0"],
      ["108","2026-07-22 12:01:00","231","2"],
    ]},
    {name:"dedup_keys",pk:"click_id",columns:[
      ["click_id","varchar(32)","seen click id (co-partitioned by ad_id)"],
      ["seen_at","timestamptz","when first observed"],
      ["ttl_expires_at","timestamptz","short TTL, ~24h, then evicted"],
    ],rows:[
      ["c-8f3a","2026-07-22 12:00:59","2026-07-23 12:00:59"],
      ["c-8f3b","2026-07-22 12:01:03","2026-07-23 12:01:03"],
    ]},
    {name:"batch_recompute_runs",pk:"run_id",columns:[
      ["run_id","uuid","reconciliation job id"],
      ["window_start","timestamptz","first minute recomputed"],
      ["window_end","timestamptz","last minute recomputed"],
      ["status","varchar(16)","queued | running | done | failed"],
    ],rows:[
      ["r-4401","2026-07-22 12:00:00","2026-07-22 13:00:00","done"],
      ["r-4402","2026-07-22 13:00:00","2026-07-22 14:00:00","running"],
    ]},
  ]},
  flows:[
    {id:"ingest",name:"Ingest a click event",steps:[
      {node:"client",text:"Ad / browser fires a compact beacon with a client-minted <code>clickId</code>."},
      {node:"gw",text:"Ingest gateway validates the schema, authenticates the source, and enriches with geo + receive-time."},
      {node:"stream",text:"Gateway produces the event to the durable event log (Kafka), keyed by <code>adId</code>."},
      {node:"dedup",requires:["dedup"],text:"Dedup stage drops the event if its <code>clickId</code> was already seen within the window."},
      {node:"agg",text:"Aggregator does a windowed rollup — a running count per <code>(adId, minute)</code>."},
      {node:"olap",requires:["olap"],text:"On window close, the per-minute count is written to the OLAP store."},
    ]},
    {id:"query",name:"Advertiser queries metrics",steps:[
      {node:"query",requires:["query"],text:"Advertiser calls the query API for an ad's last-24h metrics."},
      {node:"olap",requires:["olap"],text:"The API scans pre-aggregated minute-buckets in the OLAP store and sums them in ms."},
      {node:"query",requires:["query"],text:"Query API returns the rollup — recent buckets flagged provisional, older ones final."},
    ]},
    {id:"reconcile",name:"Batch reconciliation of a bad window",steps:[
      {node:"stream",text:"Retained raw events in the log are the ground truth for a window."},
      {node:"batch",requires:["batch"],text:"Batch recompute reads the raw events and recomputes authoritative per-minute counts."},
      {node:"olap",requires:["olap"],text:"It idempotently overwrites the affected <code>(adId, minute)</code> aggregates with a higher batch version."},
    ]},
  ],
  requirements:{
    functional:[
      "Ingest a firehose of ad-click events at very high throughput without dropping clicks",
      "Aggregate clicks into per-ad, per-minute metrics (with dims like geo and device)",
      "Let advertisers query recent and historical metrics in near-real-time",
      "Be accurate enough to bill on — dedup retries so a click is counted once",
    ],
    nonFunctional:[
      "Ingest millions of clicks/s with bursty peaks; ingest must never be the bottleneck",
      "Dashboard freshness within ~1 minute; query p99 &lt; 1s",
      "No data loss on faults — events are durable and replayable",
      "Correctness under late and out-of-order events, and exactly-once-ish counting",
    ],
  },
  reqBuild:[
    {req:"Ingest ad-click events at high throughput",turns:[
      {who:"intv",text:"Start with the simplest thing that satisfies requirement one: a browser fires a click event and it needs to land somewhere durably. What's the minimal path?"},
      {who:"cand",text:"The <strong>ad / browser</strong> fires a compact event to the <strong>ingest gateway</strong>, which validates and enriches it and produces it to a durable <strong>event log</strong> (Kafka). An <strong>aggregator</strong> consumes from the log. That's my four core boxes and it already satisfies ingest: the gateway is thin and stateless, and the log is what makes the click durable and replayable. I deliberately put a log between ingest and processing so a bursty firehose is decoupled from whatever rate the aggregator sustains."},
      {who:"intv",text:"Why land clicks in a log at all — why not have the gateway write counts straight to a database?"},
      {who:"cand",text:"Writing counts inline couples ingest throughput to the store's write rate and throws away the raw events, so I could never recompute if the logic was wrong. The log gives me three things ingest needs: it <strong>absorbs bursts</strong> so a 10x spike buffers instead of dropping, it's <strong>replayable</strong> for recovery and backfill, and it gives <strong>ordered per-key streams</strong> so aggregation can be local. The gateway's only job is to get the event durably into the log fast; all the counting happens downstream where I can scale it independently."},
    ],resources:[
      {title:"Hello Interview — Ad Click Aggregator",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ad-click-aggregator"},
      {title:"Apache Kafka documentation",url:"https://kafka.apache.org/documentation/"},
    ]},
    {req:"Aggregate into per-ad metrics advertisers can query (adds OLAP + query API)",reveal:["olap","query"],turns:[
      {who:"intv",text:"Requirement two: advertisers want per-ad, per-minute counts they can look at in near-real-time. The aggregator produces counts — where do they go and how does an advertiser read them?"},
      {who:"cand",text:"The aggregator does <strong>windowed aggregation</strong> — tumbling 1-minute windows keyed by <code>(adId, minute)</code> — and emits per-ad counts. Those land in a read-optimized <strong>OLAP store</strong>, and advertisers read <em>pre-aggregated rollups</em> through a <strong>query API</strong>, never raw events. Let me add the OLAP store and the query API. Pre-aggregating at write time is the core bet: writes do the heavy lifting once, so a query for an ad's last 24h reads ~1,440 minute-buckets summed in milliseconds instead of scanning the firehose."},
      {who:"intv",text:"Why a separate OLAP store and query API instead of letting advertisers query the aggregator's state directly?"},
      {who:"cand",text:"The aggregator's job is fast, stateful stream processing — its local window state is tuned for ingest, not for thousands of advertisers running range and group-by scans. A dedicated <strong>column-oriented OLAP store</strong> serves time-series rollups and group-by queries cheaply, and a <strong>query API</strong> in front lets me scale, cache, and rate-limit reads independently from the write path. It's the same split-the-read-from-the-write discipline: the aggregator owns producing counts, the OLAP store and API own serving them, so a read spike never competes with ingest."},
    ],resources:[
      {title:"Hello Interview — Ad Click Aggregator",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ad-click-aggregator"},
      {title:"System Design Primer — study guide",url:"https://github.com/donnemartin/system-design-primer"},
    ]},
  ],
  systemDives:[
    {title:"A viral ad turns one Kafka partition into a hotspot",tag:"scaling",turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> one ad goes viral — <b>3M of your 10M clicks/s</b> are for <code>adId=42</code>. Because you partition by <code>adId</code>, they all hit <b>one partition</b>, whose single consumer now lags <b>hours</b> behind while the other partitions sit idle. Fix it.</span>"},
      {who:"cand",text:"Classic <strong>hot-partition</strong> problem: partition-by-<code>adId</code> means one ad maps to one partition maps to one consumer — that's the ceiling, and adding consumers can't raise it. The fix is <strong>salting</strong>: for a hot ad, spread the key across K sub-partitions — <code>adId#0 .. adId#K-1</code> chosen round-robin — so 3M/s fans out K ways, ~300K/s each. Cold ads keep a single key and pay nothing; only the hot ad splits."},
      {who:"intv",text:"Salting scatters the ad's events, so no single consumer has the full count. Where do the pieces come back together?"},
      {who:"cand",text:"<strong>Two-stage aggregation.</strong> Stage one: each salted partition's consumer computes a <em>partial</em> per-minute count for its slice. Stage two: a downstream combine, keyed by the real <code>adId</code>, sums the K partials per window into the final count. Only compact partials cross the network — one per salt per minute, not raw events — so it's cheap, and cold ads skip stage two entirely."},
      {who:"intv",text:"How do you know an ad is hot in time to start salting it, rather than after the consumer is already hours behind?"},
      {who:"cand",text:"A lightweight <strong>heavy-hitters / count-min sketch</strong> at the gateway or a monitor consumer tracks per-<code>adId</code> rates and flags any ad crossing a threshold within seconds. When one trips, the gateway starts salting that <code>adId</code> and the combine step activates for it. It's dynamic — an ad is single-partition until it gets hot, splits while it's hot, and can collapse back when it cools — so I never over-provision partitions for ads that never go viral."},
    ],resources:[
      {title:"Count–min sketch",url:"https://en.wikipedia.org/wiki/Count%E2%80%93min_sketch"},
      {title:"Hello Interview — Ad Click Aggregator",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ad-click-aggregator"},
    ]},
    {title:"A network retry double-counts a click — exactly-once (adds dedup)",tag:"durability",reveal:["dedup"],turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a flaky-network retry — from the client or a gateway re-produce — writes the <b>same click, same <code>clickId</code></b>, into the log <b>twice</b>. Your aggregator adds both to a billable count, over-charging the advertiser by 1 click each time. Across millions of retries that's real money. How do you get exactly-once-ish?</span>"},
      {who:"cand",text:"Kafka is at-least-once by default, so duplicates are expected and I design for them rather than pretend they won't happen. The answer is <strong>dedup on <code>clickId</code></strong>: before a click contributes to a count, check whether that <code>clickId</code> was already seen and drop it if so — idempotent processing. Let me add a <strong>dedup / idempotency</strong> stage between the log and the counting. Combined with Kafka's idempotent producer, that removes the double-count. The <code>clickId</code> is minted once per user action and reused on every retry, so all copies collapse to one."},
      {who:"intv",text:"Remembering every <code>clickId</code> you have ever seen is enormous. Is that even feasible at 86B clicks/day?"},
      {who:"cand",text:"I don't need forever — a duplicate arrives <em>close in time</em> to the original, a retry seconds to at most minutes later, within the lateness window. So the dedup stage keeps <code>clickId</code>s for a bounded window (say 24h) with TTL in fast local state co-partitioned by key, and anything older is caught authoritatively by the batch layer from the raw log. To shrink memory further I can use a probabilistic filter for the older tail plus an exact set for the recent hot window."},
      {who:"intv",text:"If dedup's local state is lost on a crash, does it start re-admitting duplicates it would have dropped?"},
      {who:"cand",text:"Guarded by backing the local seen-set with a <strong>compacted changelog topic</strong> (or engine checkpoints): on restart the task restores its seen-set from the changelog rather than rebuilding from nothing, so it doesn't re-admit dupes it already dropped. And if some do slip through, the <strong>speed layer over-counts slightly</strong>, which is acceptable by design — the batch layer reconciles the authoritative billable number from raw events that themselves carry <code>clickId</code>. Speed = fast + near-exact, batch = eventually exact, money = batch."},
    ],resources:[
      {title:"Apache Kafka documentation",url:"https://kafka.apache.org/documentation/"},
      {title:"Hello Interview — Ad Click Aggregator",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ad-click-aggregator"},
    ]},
    {title:"A deploy bug wrote wrong aggregates for an hour — reconcile (adds batch)",tag:"failover",reveal:["batch"],turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a deploy shipped a bug in the aggregation logic. For a full <b>hour (12:00–13:00)</b> it wrote <b>wrong counts</b>, and advertisers were <b>mis-billed</b> off them. The streaming layer already emitted those numbers and moved on. How do you recover the correct figures?</span>"},
      {who:"cand",text:"This is exactly why I keep raw events in the log and add a <strong>batch reconciliation layer</strong> — the <strong>lambda architecture</strong>. The speed layer gives timely, approximate counts; a batch job recomputes the <em>authoritative</em> counts for that hour from the retained raw events, which are the ground truth, and overwrites the corrupted aggregates. Let me add a <strong>batch recompute</strong> component. Speed layer = fast + approximate; batch = correct + final; billing reads the finalized batch numbers, so the correction flows straight into corrected invoices."},
      {who:"intv",text:"When batch recomputes and writes, won't it add on top of the already-wrong numbers and make it worse?"},
      {who:"cand",text:"No — batch writes are <strong>idempotent overwrites</strong> keyed by <code>(adId, minute)</code>: it <em>sets</em> the recomputed value, it doesn't increment. So the bad hour is replaced, not compounded, and a partially-completed rerun is safe to rerun again. I stamp each write with a batch version and have the serving layer prefer the higher finalized version, so the corrected numbers deterministically supersede the bad ones."},
      {who:"intv",text:"Reconciling a whole day is 86B events and a naive nightly job can't finish in time. How do you keep this affordable?"},
      {who:"cand",text:"Two levers. <strong>Parallelize</strong>: partition the recompute by hour and <code>adId</code> range over columnar raw data in object storage and run it distributed, so throughput scales with cluster size. <strong>Incrementalize</strong>: don't recompute all history — only the windows actually affected, tracked by correction markers, since the vast majority of finalized windows never change. So steady-state batch is tiny — just the late tail — and a full recompute is reserved for a known-bad range like this buggy hour."},
    ],resources:[
      {title:"Lambda architecture",url:"https://en.wikipedia.org/wiki/Lambda_architecture"},
      {title:"Hello Interview — Ad Click Aggregator",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ad-click-aggregator"},
    ]},
    {title:"Clicks arrive 20 minutes late, after the window closed",tag:"durability",turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a click's event-time is <b>12:00:59</b>, but it arrives at <b>12:20</b> — the 12:00 window already closed and emitted its count. At 5M/s a network blip can strand millions of such late events. What do you do with them so they neither corrupt the count nor silently vanish?</span>"},
      {who:"cand",text:"This is the <strong>event-time vs processing-time</strong> problem. I aggregate on <em>event-time</em> and use a <strong>watermark</strong> to track progress, keeping a window open for an <strong>allowed lateness / grace period</strong> after its nominal close — say 15 minutes. A click within grace still updates its window and re-emits a corrected count. A click 20 minutes late is beyond grace, so it doesn't update the live window; instead it's routed to the reconciliation / batch path to be folded into the final number. Nothing is dropped."},
      {who:"intv",text:"Holding every window open for 15 minutes is a lot of live state. What's the cost, and where's the cutoff?"},
      {who:"cand",text:"Open state ≈ (active ads) × (windows within grace), so it's <strong>bounded by the grace length</strong>, not unbounded — I size memory for that and checkpoint it durably. The cutoff is a deliberate trade: a longer grace catches more stragglers live but costs state and delays finalization; a shorter grace finalizes fast but pushes more corrections to batch. I pick grace from the observed lateness distribution — cover p99 of delays — and let batch mop up the long tail."},
      {who:"intv",text:"So a number an advertiser saw at 12:01 can change after late data folds in. How is that not just a bug?"},
      {who:"cand",text:"It's the deliberate provisional-then-final model, and I make it honest by <strong>labelling</strong> it. Recent buckets are marked <em>provisional</em> and visibly settle to <em>final</em> once the grace and reconciliation window closes; the <strong>invoice reads the finalized batch</strong> number, not the live speed-layer value. This is standard in ad analytics — advertisers expect live counts to firm up. What matters is that the final billable number is stable and correct; the provisional value is a clearly-flagged real-time estimate, not a promise."},
    ],resources:[
      {title:"Lambda architecture",url:"https://en.wikipedia.org/wiki/Lambda_architecture"},
      {title:"Hello Interview — Ad Click Aggregator",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ad-click-aggregator"},
    ]},
  ],
  q:{
    client:[
      {l:"easy",tag:"concept",q:"What's in a click event, and who mints the id?",turns:[
        {who:"intv",text:"When a user clicks an ad in the browser, what exactly gets sent to your ingest gateway? Be precise about the payload."},
        {who:"cand",text:"A compact event: <code>clickId</code> (generated on the client at click time), <code>adId</code>, an anonymised user/device id, an <strong>event-time timestamp</strong>, and context — <code>campaignId</code>, geo hints, device, referrer.<span class='eg'>event = {clickId:'c-8f3a', adId:42, ts:1690000059, campaignId:9, geo:'US', device:'ios'}</span>The client fires it as a non-blocking beacon (<code>navigator.sendBeacon</code>) and immediately proceeds to the advertiser's landing page — the redirect never waits on us."},
        {who:"intv",text:"Why have the client generate <code>clickId</code> rather than the server assign one?"},
        {who:"cand",text:"Because retries and duplicates happen <em>below</em> the server — flaky networks resend, edges retry. A stable client-minted <code>clickId</code> that survives every retry is what lets the whole pipeline dedup <strong>idempotently</strong>. If the server assigned the id, a re-sent HTTP request would get a fresh id and be counted as a second click. The id must be tied to the user action, once."},
      ],resources:[
        {title:"Hello Interview — Ad Click Aggregator",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ad-click-aggregator"},
        {title:"System Design Primer — application layer",url:"https://github.com/donnemartin/system-design-primer#application-layer"},
      ]},
      {l:"hard",tag:"scaling",q:"10M clicks/s of tiny beacons — keep the client cheap.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a product launch drives clicks from 1M/s to <b>10M/s</b> globally in under a minute, extremely bursty. Each is a tiny separate HTTP request straight from a browser. What falls over, and how do you keep the client side from amplifying the load?</span>"},
        {who:"cand",text:"The client side is naturally distributed — each browser sends its own event — so the pressure lands on <strong>connection setup + edge termination</strong>, not any one client. Keeping the client cheap: <strong>(1)</strong> fire-and-forget beacons, no blocking, tiny payload. <strong>(2)</strong> batch multiple events per flush where an SDK sees several. <strong>(3)</strong> terminate at the nearest <strong>edge PoP</strong> via anycast so 10M tiny requests don't all cross oceans. <strong>(4)</strong> on send failure, retry with jitter — but always reusing the same <code>clickId</code>."},
        {who:"intv",text:"10M mostly-new TLS handshakes/s is itself brutal. What reduces that?"},
        {who:"cand",text:"Connection reuse — HTTP/2 or HTTP/3 keep-alive so a session carries many beacons, TLS session resumption to skip full handshakes, and gzip on batched payloads. The edge fleet absorbs the fan-in and forwards to gateways over pooled long-lived connections, so the origin never sees 10M handshakes."},
      ],resources:[
        {title:"System Design Primer — CDN",url:"https://github.com/donnemartin/system-design-primer#content-delivery-network"},
        {title:"Hello Interview — Ad Click Aggregator",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ad-click-aggregator"},
      ]},
      {l:"medium",tag:"failover",q:"A retry sends the same click 4 times — over-count?",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a user on flaky mobile clicks one ad. The beacon times out and the SDK auto-retries 3 times — 4 identical requests eventually reach ingest. Billing is about to charge the advertiser for 4 clicks. Is that a bug?</span>"},
        {who:"cand",text:"Not if the contract holds: all 4 requests carry the <strong>same <code>clickId</code></strong> because it's minted once per user action and reused across retries. Downstream dedup collapses them to one. Crucially the SDK <em>should</em> retry — I don't want to lose a real click to a timeout — and correctness comes from <strong>idempotency downstream</strong>, not from suppressing retries. At-least-once delivery + dedup by <code>clickId</code> gives me effectively-once."},
        {who:"intv",text:"What if a bug makes the SDK mint a new <code>clickId</code> per retry?"},
        {who:"cand",text:"Then it's a real over-count — dedup can't tell the 4 apart, and the advertiser is billed 4x. That's why the <code>clickId</code> lifecycle is a hard contract in the SDK: generate once at the click handler, cache it, reuse for every retry of <em>that</em> action. It's the single most important invariant on the client, so I'd cover it with tests and treat a duplicated-id regression as a billing incident."},
      ],resources:[
        {title:"Hello Interview — Ad Click Aggregator",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ad-click-aggregator"},
        {title:"System Design Primer — asynchronism",url:"https://github.com/donnemartin/system-design-primer#asynchronism"},
      ]},
      {l:"medium",tag:"concept",q:"Bots and accidental double-taps — filter where?",turns:[
        {who:"intv",text:"Not every click is real — bots, click fraud, accidental double-taps. Where do you filter, and how much can the client do?"},
        {who:"cand",text:"The client can only do the cheap, honest part: <strong>debounce a UI double-tap</strong> within a few hundred ms into one <code>clickId</code>.<span class='eg'>two taps within 300ms → one event; a genuine second click seconds later → new clickId</span>Authoritative fraud detection cannot live on an untrusted client — the gateway does structural validation and coarse rate-limits, and heavier fraud scoring runs <strong>asynchronously offline</strong>, feeding an adjustment signal. I never block ingest on fraud analysis."},
        {who:"intv",text:"So a bot's clicks still enter the counts?"},
        {who:"cand",text:"Initially yes — the speed layer counts them, then fraud scoring flags them and the batch/reconciliation path subtracts invalid clicks from the billable totals. Dashboards may briefly show inflated numbers; the <em>billable</em> number settles after fraud reconciliation. Trying to filter fraud inline would add latency to a 10M/s hot path for a decision better made with more context later."},
      ],resources:[
        {title:"Hello Interview — Ad Click Aggregator",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ad-click-aggregator"},
        {title:"System Design Primer — asynchronism",url:"https://github.com/donnemartin/system-design-primer#asynchronism"},
      ]},
    ],
    gw:[
      {l:"easy",tag:"concept",q:"Walk me through validate + enrich, step by step.",turns:[
        {who:"intv",text:"Take me through exactly what the ingest gateway does to one incoming click event. Every step."},
        {who:"cand",text:"<ul><li><strong>Validate</strong> — schema, required fields, sane timestamp; reject malformed.</li><li><strong>Authenticate</strong> the source (campaign/placement token) and coarse rate-limit.</li><li><strong>Enrich</strong> — add a server receive-time, resolve geo from IP, map <code>campaignId → advertiserId</code>.</li><li><strong>Key + produce</strong> — set the partition key to <code>adId</code> and write to the event log.</li></ul>It's thin and <strong>stateless</strong> — all durable state lives in Kafka downstream, so any gateway instance handles any event."},
        {who:"intv",text:"Enrichment needs a <code>campaignId → advertiserId</code> lookup. Doesn't that couple the gateway to a DB on the hot path?"},
        {who:"cand",text:"I keep that metadata in an <strong>in-process cache</strong> — it's small (millions of campaigns) and slow-changing — refreshed asynchronously. On a cache miss I attach the raw <code>campaignId</code> and let the stream layer enrich later rather than block ingest on a DB call. The gateway's job is to get the event durably into the log fast; expensive joins happen downstream."},
      ],resources:[
        {title:"Hello Interview — Ad Click Aggregator",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ad-click-aggregator"},
        {title:"System Design Primer — application layer",url:"https://github.com/donnemartin/system-design-primer#application-layer"},
      ]},
      {l:"hard",tag:"scaling",q:"Size the gateway fleet for 10M events/s.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> sustained <b>5M events/s</b>, peaking at <b>10M/s</b>. The gateway must never be the bottleneck that drops clicks. How do you size and scale it?</span>"},
        {who:"cand",text:"It's stateless, so it scales horizontally behind an L4 load balancer and autoscales on produce-rate/CPU.<span class='eg'>if one instance handles ~50K events/s → 10M/s needs ~200 instances, plus headroom</span>Each instance just validates, enriches from cache, and produces to Kafka with <strong>batched, compressed, async</strong> produce (linger.ms + batch.size) so throughput isn't one-round-trip-per-event. Regional gateways behind anycast keep the fan-in local."},
        {who:"intv",text:"Async batched produce means events sit in the producer buffer before Kafka acks them. What's the risk?"},
        {who:"cand",text:"That buffer is unacked, in-memory data — if the instance dies it's lost. So I bound the buffer, use <code>acks=all</code> with retries, and treat the client beacon as the real durability backstop: the client can re-send (same <code>clickId</code>) if it never got confirmation. I trade a few ms of batching latency for throughput, and lean on at-least-once + dedup to keep it correct."},
      ],resources:[
        {title:"Apache Kafka documentation",url:"https://kafka.apache.org/documentation/"},
        {title:"Hello Interview — Ad Click Aggregator",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ad-click-aggregator"},
      ]},
      {l:"medium",tag:"failover",q:"Gateway pod is SIGKILLed with buffered events.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a deploy rolls and a gateway pod is SIGKILLed while holding a few thousand events in its producer buffer that Kafka hasn't acked yet. Are those clicks gone, and does it matter?</span>"},
        {who:"cand",text:"Those unacked buffered events are lost on that pod. Whether it matters depends on the guarantee I promised. For <strong>billing-grade</strong> ingest I don't ack the client until Kafka has durably accepted the event (<code>acks=all</code>), so a client that got no confirmation <strong>retries with the same <code>clickId</code></strong> — the event re-enters and dedup absorbs the duplicate if the original actually made it. Net: no permanent loss, at worst a harmless duplicate."},
        {who:"intv",text:"Ack-after-Kafka adds a round trip to a fire-and-forget beacon. Reconcile that."},
        {who:"cand",text:"For pure analytics I'd keep it fire-and-forget and accept a sliver of loss on crashes — timely approximate counts are the goal. For the <strong>billable</strong> stream I switch to a lightweight ack + client retry: the beacon still doesn't block the user's navigation, but the SDK confirms delivery in the background and re-sends on failure. Duplicates from that retry are free because everything downstream dedups on <code>clickId</code>. It's a per-stream lever, not one global choice."},
      ],resources:[
        {title:"Apache Kafka documentation",url:"https://kafka.apache.org/documentation/"},
        {title:"Hello Interview — Ad Click Aggregator",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ad-click-aggregator"},
      ]},
      {l:"medium",tag:"durability",q:"Kafka is briefly unavailable — where do clicks go?",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> Kafka is unreachable for <b>15 seconds</b> during a leader election. Gateways can't produce, but clicks keep arriving at 5M/s. What happens to those ~75M events?</span>"},
        {who:"cand",text:"I don't want to hard-drop 15s of clicks. The gateway keeps a <strong>bounded local spool</strong> (memory + short disk) to smooth sub-minute blips and replays it when Kafka's new leader is ready. If the spool fills, I apply <strong>backpressure</strong> — shed with a retryable error so the client re-sends later — rather than silently dropping. The client-retry backstop covers what the spool can't."},
        {who:"intv",text:"A local spool on an ephemeral pod is itself fragile — the pod could die with the spool full."},
        {who:"cand",text:"Right, so I keep the spool deliberately small and short-lived — it only bridges the seconds-long blip, not an outage. Real durability is <strong>Kafka's replication</strong> (RF=3, min ISR) once the event lands, plus <strong>client retry</strong> for anything that never landed. The spool is a smoothing buffer, not a system of record; I never let it become one."},
      ],resources:[
        {title:"Apache Kafka documentation",url:"https://kafka.apache.org/documentation/"},
        {title:"System Design Primer — asynchronism",url:"https://github.com/donnemartin/system-design-primer#asynchronism"},
      ]},
    ],
    stream:[
      {l:"medium",tag:"concept",q:"Why a log, and how do you partition the topic?",turns:[
        {who:"intv",text:"You put Kafka between gateway and aggregator. Why a durable log at all, and how do you partition the clicks topic?"},
        {who:"cand",text:"The log does three jobs: it <strong>decouples</strong> bursty 10M/s ingest from whatever rate the aggregator can sustain, it's <strong>replayable</strong> for recovery and backfill, and it gives <strong>ordered per-key streams</strong>. I partition by <code>adId</code> so every event for an ad lands in the same partition — ordered per ad, and one consumer owns an ad's whole stream and can aggregate it locally without cross-consumer coordination.<span class='eg'>partition = hash(adId) % N; all clicks for adId=42 → partition 12</span>"},
        {who:"intv",text:"Why key by <code>adId</code> instead of, say, random partitioning for perfect balance?"},
        {who:"cand",text:"Because aggregation is <em>per ad</em>. Co-locating an ad's events lets a single aggregator task maintain that ad's window counts in local state — no shuffle, no distributed sum per event. Random partitioning would scatter one ad across every consumer and force a merge step for every ad. Keying by <code>adId</code> trades some balance (which I'll fix for hot ads) for cheap, local, ordered aggregation."},
      ],resources:[
        {title:"Apache Kafka documentation",url:"https://kafka.apache.org/documentation/"},
        {title:"System Design Primer — asynchronism",url:"https://github.com/donnemartin/system-design-primer#asynchronism"},
      ]},
      {l:"hard",tag:"scaling",q:"A viral ad makes one partition a hotspot.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> one ad goes viral — <b>3M of your 10M clicks/s</b> are for <code>adId=42</code>. Keyed by <code>adId</code>, they all hit one partition, whose single consumer now lags <b>hours</b> behind while the other partitions sit idle. Fix it.</span>"},
        {who:"cand",text:"Classic <strong>hot-partition</strong> problem: partition-by-<code>adId</code> means one ad maps to one partition maps to one consumer — that's the ceiling, and it can't be raised by adding consumers. The fix is <strong>salting</strong>: for hot ads, spread the key across K sub-partitions — <code>adId#0 .. adId#K-1</code> chosen round-robin — so the 3M/s fans out K ways.<span class='eg'>adId=42 → keys 42#0..42#9 across 10 partitions; 3M/s → ~300K/s each</span>The cost is a merge step, which only hot ads pay."},
        {who:"intv",text:"Salting scatters the ad's events, so no single consumer has the full count. Where do the pieces come back together?"},
        {who:"cand",text:"<strong>Two-stage aggregation.</strong> Stage one: each salted partition's consumer computes a <em>partial</em> per-minute count for its slice. Stage two: a downstream combine, keyed by the real <code>adId</code>, sums the K partials per window into the final count. Only compact partials cross the network (one per salt per minute), not raw events — cheap. Cold ads skip stage two entirely."},
        {who:"intv",text:"How do you know an ad is hot in time to start salting it?"},
        {who:"cand",text:"A lightweight <strong>heavy-hitters / count-min sketch</strong> at the gateway or a monitor consumer tracks per-<code>adId</code> rates and flags any ad crossing a threshold within seconds. When one trips, the gateway starts salting that <code>adId</code>'s key and the combine step activates for it. It's dynamic — an ad is single-partition until it gets hot, then splits, and can collapse back when it cools."},
      ],resources:[
        {title:"Count–min sketch",url:"https://en.wikipedia.org/wiki/Count%E2%80%93min_sketch"},
        {title:"Hello Interview — Ad Click Aggregator",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ad-click-aggregator"},
      ]},
      {l:"hard",tag:"durability",q:"The same click lands in the log twice (adds dedup).",reveal:["dedup"],turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a network retry — from the client or a gateway re-produce — writes the <b>same click, same <code>clickId</code></b>, into the log twice. Your aggregator will add both to a billable count. That's real money over-charged. How do you get exactly-once-ish?</span>"},
        {who:"cand",text:"Kafka is at-least-once by default, so duplicates are expected and I design for them rather than pretend they won't happen. The answer is <strong>dedup on <code>clickId</code></strong>: before a click contributes to a count, check whether that <code>clickId</code> was already seen, and drop it if so — idempotent processing. Let me add a <strong>dedup / idempotency</strong> stage between the log and the counting. Combined with Kafka's idempotent producer, that removes the double-count."},
        {who:"intv",text:"Remembering every <code>clickId</code> you've ever seen is enormous. Is that even feasible?"},
        {who:"cand",text:"I don't need forever — a duplicate arrives <em>close in time</em> to the original (a retry seconds to minutes later, at most within the lateness window). So the dedup stage keeps <code>clickId</code>s for a bounded window (say 24h) with TTL in fast local state, and anything older is caught authoritatively by the batch layer from the raw log. We should drill into how that dedup state is built and sized — it's its own box."},
      ],resources:[
        {title:"Apache Kafka documentation",url:"https://kafka.apache.org/documentation/"},
        {title:"Hello Interview — Ad Click Aggregator",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ad-click-aggregator"},
      ]},
      {l:"hard",tag:"failover",q:"A broker dies — lost events, or can you replay?",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a Kafka broker holding leaders for several partitions dies hard mid-spike. Are acked events lost, and can the aggregator recover its exact position without double-counting?</span>"},
        {who:"cand",text:"Acked events survive if the topic is replicated — <strong>RF=3, <code>acks=all</code>, <code>min.insync.replicas=2</code></strong>. When the leader dies, an in-sync replica is promoted and no acked data is lost. Aggregator recovery leans on the log itself: it <strong>commits offsets/checkpoints</strong>, and on restart resumes from the last committed offset and <strong>replays</strong> forward. The log is the recovery mechanism — that's the whole point of a durable event log."},
        {who:"intv",text:"Replay re-delivers events the aggregator already counted but hadn't checkpointed. Doesn't that double-count?"},
        {who:"cand",text:"Only if state and offset commit aren't atomic. I checkpoint the <strong>window state and the consumed offset together</strong> (or via Kafka transactions), so on restart I restore state as of offset X and replay from exactly X — every event applied once. That ties into the exactly-once story: idempotent <code>clickId</code> dedup handles producer duplicates, atomic checkpoint+offset handles consumer replay. Together they make recovery lossless and count-safe."},
      ],resources:[
        {title:"Apache Kafka documentation",url:"https://kafka.apache.org/documentation/"},
        {title:"Hello Interview — Ad Click Aggregator",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ad-click-aggregator"},
      ]},
      {l:"medium",tag:"capacity",q:"How many Kafka partitions, and what does retention cost?",turns:[
        {who:"intv",text:"Concrete numbers for the event log. At peak <b>10M clicks/s</b>, how many partitions do you provision on the clicks topic, and how much storage does retention cost? Show the math."},
        {who:"cand",text:"Partitions come from throughput ÷ what one partition sustains, storage from volume × retention. A single partition comfortably takes a few MB/s, so at ~100 bytes/event I budget ~250K events/s per partition.<span class='eg'>10M/s ÷ ~250K events/s ≈ 40 partitions floor; round to ~120 for headroom and hot-ad salting. Retention: 86B/day × 100B ≈ 8.6 TB/day; a 7-day hot window × RF3 ≈ 180 TB.</span>Consumer parallelism is capped by partition count, so I over-provision partitions a bit rather than repartition a live topic."},
        {who:"intv",text:"Then why not massively over-partition up front so you never have to touch it?"},
        {who:"cand",text:"Because partitions are not free: each adds open file handles, replication and metadata overhead, longer rebalances, and more consumer tasks to schedule — thousands of idle partitions hurt latency and recovery. Too few and I hit a throughput ceiling and worse hot-spotting. The trade-off is elasticity vs overhead, so I size to <strong>~2-3x peak</strong> with salting room, keep Kafka retention short (the hot replay window) and <strong>tier older raw events to object storage</strong>, which is far cheaper for the long tail the batch layer needs."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"Apache Kafka documentation",url:"https://kafka.apache.org/documentation/"},
      ]},
      {l:"medium",tag:"concept",q:"Which log — Kafka, Kinesis, or Pulsar?",turns:[
        {who:"intv",text:"You keep saying Kafka. At this scale, which event log do you actually pick — Kafka, Kinesis, or Pulsar — and why?"},
        {who:"cand",text:"<strong>Kafka</strong> is my default: very high per-partition throughput, durable replay, and the ecosystem I lean on downstream (Streams, Connect, transactions for exactly-once). <strong>Kinesis</strong> is attractive operationally — fully managed, no brokers to run — but its capacity is shard-bound and gets expensive at a firehose.<span class='eg'>Kinesis shard ≈ 1 MB/s ingest; 10M/s × 100B ≈ 1 GB/s → ~1,000+ shards to manage and pay for.</span><strong>Pulsar</strong> separates compute from storage with native tiered storage, which fits my long-retention need nicely."},
        {who:"intv",text:"You are likely on AWS already — why not just take Kinesis and skip running brokers?"},
        {who:"cand",text:"For a smaller stream I would — the ops savings are real. Here the trade-offs cut the other way: at ~1 GB/s the shard math is punishing on cost and rebalancing, and I depend on Kafka transactions and RocksDB-backed stream state for exactly-once, which Kinesis doesn't give me as cleanly. Pulsar's tiered storage genuinely tempts me for the retention story, but its operational maturity and ecosystem are thinner. <strong>Decision: Kafka</strong> for throughput, replay, and the exactly-once ecosystem — revisiting Pulsar specifically if tiered-storage retention dominates cost."},
      ],resources:[
        {title:"Apache Kafka documentation",url:"https://kafka.apache.org/documentation/"},
        {title:"Hello Interview — Ad Click Aggregator",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ad-click-aggregator"},
      ]},
    ],
    agg:[
      {l:"medium",tag:"concept",q:"What does it emit, and where do reads go? (adds OLAP + query)",reveal:["olap","query"],turns:[
        {who:"intv",text:"The aggregator consumes clicks and produces... what, exactly? Describe the aggregation and where the results go."},
        {who:"cand",text:"It does <strong>windowed aggregation</strong> — tumbling 1-minute windows keyed by <code>(adId, minute)</code>. It maintains a running count (plus dim breakdowns) and, when a window closes, emits <code>{adId, minute, count, dims}</code>.<span class='eg'>window 12:00–12:01, adId=42 → count 18,432</span>Those aggregates land in a read-optimized <strong>OLAP store</strong>, and advertisers query <em>pre-aggregated rollups</em> through a <strong>query API</strong> — never raw events. Let me add the OLAP store and the query API."},
        {who:"intv",text:"Why pre-aggregate at write time instead of scanning raw events at query time?"},
        {who:"cand",text:"Raw is ~86B events/day — scanning that per dashboard refresh can't hit sub-second, and every advertiser refreshing would re-scan the firehose. Pre-aggregating per <code>(adId, minute)</code> collapses it to bounded rows: a query for an ad's last 24h reads ~1,440 minute-buckets, summed in milliseconds. Writes do the heavy lifting once; reads become cheap. That's the core streaming-aggregation bet."},
      ],resources:[
        {title:"Hello Interview — Ad Click Aggregator",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ad-click-aggregator"},
        {title:"System Design Primer — study guide",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"medium",tag:"concept",q:"A click arrives 20 minutes after its window closed.",turns:[
        {who:"intv",text:"Here's a concrete case: a click's event-time is 12:00:59, but it arrives at 12:20 — the 12:00 window already closed and emitted its count. What do you do with that click?"},
        {who:"cand",text:"This is the <strong>event-time vs processing-time</strong> problem. I aggregate on <em>event-time</em> and use a <strong>watermark</strong> to track progress, keeping a window open for an <strong>allowed lateness / grace period</strong> after its nominal close.<span class='eg'>watermark = max seen event-time − 15min; a click up to 15min late still updates its window and re-emits a corrected count</span>A click 20 minutes late is beyond grace, so it doesn't silently vanish — it's routed to the reconciliation/batch path to be folded into the final number."},
        {who:"intv",text:"Holding every window open for 15 minutes is a lot of live state. What's the cost, and where's the cutoff?"},
        {who:"cand",text:"Open state ≈ (active ads) × (windows within the grace period), so it's <strong>bounded by the grace length</strong>, not unbounded — I size memory for that and checkpoint it durably. The cutoff is a deliberate trade: a longer grace catches more stragglers but costs state and delays finalization; a shorter grace finalizes fast but pushes more corrections to batch. I pick grace from the observed lateness distribution (e.g. covers p99 of delays) and let batch mop up the long tail."},
      ],resources:[
        {title:"Lambda architecture",url:"https://en.wikipedia.org/wiki/Lambda_architecture"},
        {title:"Hello Interview — Ad Click Aggregator",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ad-click-aggregator"},
      ]},
      {l:"hard",tag:"scaling",q:"80% of clicks are the top 0.1% of advertisers.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> traffic is brutally skewed — <b>80% of clicks</b> belong to the top <b>0.1% of advertisers</b>. A few aggregator tasks peg at 100% CPU while the rest idle, and total load is 10M/s. Balance it.</span>"},
        {who:"cand",text:"Same shape as the hot-partition problem, now at the aggregator: parallelism equals partitions, and a hot ad/advertiser pins one task. I apply the <strong>two-stage / salted</strong> pattern — pre-aggregate with salted keys so a hot ad's load fans across K tasks, then a combine keyed by real <code>adId</code> sums the partials per minute. Local pre-aggregation also shrinks volume dramatically before any shuffle, so even balanced load moves less data."},
        {who:"intv",text:"The combine step is an extra shuffle. Doesn't that blow the near-real-time budget?"},
        {who:"cand",text:"It's cheap because only <strong>partials</strong> shuffle, not raw clicks — one small record per salt per minute, so a hot ad emits K tiny partials/minute instead of millions of events. The heavy counting stays local and parallel. The combine adds a sub-second hop, well inside a ~1-minute freshness SLO, and only hot keys go through it — cold ads finalize in a single stage."},
      ],resources:[
        {title:"Count–min sketch",url:"https://en.wikipedia.org/wiki/Count%E2%80%93min_sketch"},
        {title:"Hello Interview — Ad Click Aggregator",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ad-click-aggregator"},
      ]},
      {l:"hard",tag:"durability",q:"An aggregator crashes mid-window — lost or double-counted?",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> an aggregator instance crashes at <b>12:00:30</b>, mid-window, holding in-memory counts for thousands of ads for the current minute. Are those in-flight counts lost, double-counted, or recovered exactly?</span>"},
        {who:"cand",text:"Recovered exactly — but only if window state is <strong>checkpointed</strong>. In-memory counts must be periodically flushed to durable state (RocksDB backed by a compacted changelog topic, or engine checkpoints à la Flink) <em>together with</em> the consumed offset. On crash, a standby or new task restores state from the last checkpoint and replays from that checkpointed offset. Skip checkpointing and you'd either lose the minute or, if you replay from zero, double it."},
        {who:"intv",text:"Say the last checkpoint was at 12:00:20 and it crashed at 12:00:30. What happens to those 10 seconds of counts?"},
        {who:"cand",text:"They're recovered by replay: state is restored as of the 12:00:20 checkpoint, and the aggregator resumes consuming from the offset captured <em>at that same checkpoint</em>, re-reading the 12:00:20–12:00:30 events from the log and re-applying them to the restored state. Because the checkpoint bound state and offset atomically, each event is applied exactly once — the 10 seconds aren't lost and aren't doubled. The durable log makes the replay possible; the atomic checkpoint makes it correct."},
      ],resources:[
        {title:"Apache Kafka documentation",url:"https://kafka.apache.org/documentation/"},
        {title:"Hello Interview — Ad Click Aggregator",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ad-click-aggregator"},
      ]},
      {l:"hard",tag:"failover",q:"A deploy bug wrote wrong counts for an hour (adds batch).",reveal:["batch"],turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a deploy shipped a bug in the aggregation logic. For a full hour it wrote <b>wrong counts</b>, and advertisers were <b>mis-billed</b> off them. The streaming layer already emitted and moved on. How do you recover the correct numbers?</span>"},
        {who:"cand",text:"This is exactly why I keep raw events in the log and add a <strong>batch reconciliation layer</strong> — the <strong>lambda architecture</strong>. The streaming/speed layer gives timely, approximate counts; a batch job recomputes the <em>authoritative</em> counts for that hour from the retained raw events (the ground truth) and overwrites the corrupted aggregates. Let me add a <strong>batch recompute</strong> component. Speed layer = fast + approximate; batch = correct + final; the serving layer prefers batch for finalized windows."},
        {who:"intv",text:"When batch recomputes and writes, won't it add on top of the wrong numbers and make it worse?"},
        {who:"cand",text:"No — batch writes are <strong>idempotent overwrites</strong> keyed by <code>(adId, minute)</code>: it <em>sets</em> the recomputed value, it doesn't increment. So the bad hour is replaced, not compounded. And billing runs off the <strong>finalized batch</strong> numbers, not the live speed-layer counts, so the correction flows straight into corrected invoices. The speed layer just needs to be roughly right for dashboards; batch is the source of truth for money."},
      ],resources:[
        {title:"Lambda architecture",url:"https://en.wikipedia.org/wiki/Lambda_architecture"},
        {title:"Hello Interview — Ad Click Aggregator",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ad-click-aggregator"},
      ]},
      {l:"medium",tag:"capacity",q:"How many aggregator tasks do you run?",turns:[
        {who:"intv",text:"Numbers for the aggregator. At <b>10M events/s</b>, how many aggregation tasks/instances do you run, and how much memory does the window state need? Show the math."},
        {who:"cand",text:"Task count is bounded by partitions and by per-task throughput. A stateful task doing a keyed windowed count sustains maybe ~200K events/s, and memory is (active ads) × (windows held open in the grace period) × bytes.<span class='eg'>10M/s ÷ ~200K events/s ≈ 50 tasks; I align to the ~120 partitions so parallelism = partitions. State ≈ up-to-10M active ads × ~15 open windows × ~50B ≈ single-digit GB per task shard.</span>Local pre-aggregation shrinks the volume before any combine hop, so the counting stays cheap."},
        {who:"intv",text:"Why peg task count to partitions instead of scaling the aggregator independently?"},
        {who:"cand",text:"Because in the Kafka consumer model parallelism <em>can't exceed</em> partition count — extra tasks beyond partitions just sit idle, while too few means one task owns several partitions and lags. State size also grows with the grace window, which drives checkpoint cost. The trade-off is elasticity vs wasted tasks and checkpoint overhead. <strong>Decision:</strong> tasks ≈ partitions, size memory for the grace-window state and checkpoint it, and to scale beyond that I raise partition count (with salting for hot ads) rather than adding orphan tasks."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"Apache Kafka documentation",url:"https://kafka.apache.org/documentation/"},
      ]},
    ],
    olap:[
      {l:"hard",tag:"concept",q:"Which OLAP store do you pick, and why?",turns:[
        {who:"intv",text:"This is where the aggregates live and what advertisers query. Before you name a product — what write and read load does this store actually have to serve? Put numbers on it."},
        {who:"cand",text:"Aggregates, not raw events, so the load is far smaller than the firehose. Writes are per-<code>(adId, minute)</code> upserts, so they scale with <strong>active ads per minute</strong>, not clicks: ~1M ads active per minute means ~1M rows/min ≈ <strong>~17K upserts/s</strong> steady, bursting toward ~2M/s during a spike that I buffer through a topic. Reads are the harder side: ~50K dashboard QPS at peak, cut to <strong>~5K scan QPS</strong> after the result cache, each one a range + group-by over minute buckets with p99 &lt; 1s. Cardinality is ~10M distinct ads × dims like geo and device, over ~1.44B minute-rows/day. That profile — modest keyed-upsert writes, high-QPS range/group-by reads, time-series shape — is exactly what a <strong>column-oriented OLAP</strong> store is built for.<span class='eg'>write ≈ 1M rows/min ≈ 17K/s steady, ~2M/s spike (buffered); read ≈ 50K QPS → ~5K scan QPS post-cache</span>"},
        {who:"intv",text:"Good. Now give me the actual candidates and their ballpark per-node ceilings, and do the node math for your load — I want a cluster size, not a vibe."},
        {who:"cand",text:"Four realistic candidates, with ballpark per-node ceilings:<ul><li><strong>Druid</strong> — real-time ingest ~10-50K rows/s/node, native time-partitioned segments + rollup, deep-storage backed; brokers→historicals scale read concurrency well.</li><li><strong>Pinot</strong> — built for high-QPS low-latency, ~thousands of QPS/node with native primary-key upsert; real-time ingest ~tens of K rows/s/node.</li><li><strong>ClickHouse</strong> — ingest king (~100K-1M+ rows/s/node batched) and the fastest scans, but upsert-by-key is merge-based (ReplacingMergeTree) and awkward for idempotent overwrite.</li><li><strong>Cassandra</strong> — ~10-50K writes/s/node, but it's wide-column KV with no group-by engine, so it forces app-side summation.</li></ul>Node math on my load:<span class='eg'>ingest: 2M/s spike ÷ ~50K rows/s/node ≈ 40 nodes if unbuffered — but buffered to ~17K/s steady → a handful. reads: 5K scan QPS ÷ ~1K QPS/node ≈ ~5-8 query nodes. storage: ~20 TB (90d × RF2) ÷ ~2 TB/node ≈ ~10 nodes. Storage dominates → a ~10-node cluster.</span>So write rate is never the constraint here; storage and read concurrency set the size."},
        {who:"intv",text:"Say you land on a columnar store. How do you index and lay out the data so those range + group-by scans stay inside the sub-second budget?"},
        {who:"cand",text:"The layout is dictated by the query: <strong>(time-bucket, adId) is the key</strong>. I partition segments by <strong>time</strong> — minute → hour → day — so a range scan touches only the segments in the window and old data expires by dropping whole segments; within a segment I sort/index by <code>adId</code> so an advertiser's rows are contiguous. I <strong>pre-aggregate / roll up</strong> at ingest so a long-range query hits the coarsest rollup that answers it — ~30 day-rows for a 30-day view, not 43,200 minute-rows. The <strong>columnar layout</strong> is what makes range + group-by cheap: a query reads only the <code>count</code> and grouped-dim columns off disk instead of whole rows, scans them sequentially, and vectorizes the aggregation — with dictionary + bitmap indexes on low-cardinality dims like geo and device to skip non-matching blocks.<span class='eg'>sum last-24h by geo for adId=42 → scan ~1,440 minute rows in one time-partitioned segment, count + geo columns only → ms</span>"},
        {who:"intv",text:"So commit. Which one, and why not the others?"},
        {who:"cand",text:"<strong>Decision: Druid</strong>, with Pinot a very close second. It gives me native time-partitioned segments, built-in rollup, and deep-storage durability that lines up with the lambda design — the <strong>batch layer corrects a bad window by swapping immutable segments</strong>, which is clean and atomic. <strong>Pinot</strong> I'd pick if peak QPS climbed much higher or I leaned on its primary-key upsert. <strong>ClickHouse</strong> wins on raw ingest and scan speed, but I pass because billing needs idempotent overwrite-by-key and merge-based upserts complicate that — I'd revisit it for append-mostly analytics. <strong>Cassandra</strong> is out: it serves point reads, not the range + group-by aggregation that is the entire query pattern here."},
      ],resources:[
        {title:"Hello Interview — Ad Click Aggregator",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ad-click-aggregator"},
        {title:"Apache Druid documentation",url:"https://druid.apache.org/docs/latest/design/"},
        {title:"ByteByteGo",url:"https://bytebytego.com/"},
      ]},
      {l:"hard",tag:"scaling",q:"The OLAP store can't keep up with write volume.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> during a spike the aggregator emits <b>2M aggregate upserts/s</b> and the OLAP store's write path can't keep up — ingestion lag grows, dashboards go stale. Fix it.</span>"},
        {who:"cand",text:"First, cut write volume at the source: emit <strong>per-minute rollups, not per-event</strong> (already the design), and have the combine stage produce one record per <code>(adId, minute)</code> so upserts scale with active ads, not clicks. Then decouple ingestion via a <strong>buffer</strong> — the aggregator writes aggregates to a Kafka topic and the OLAP store <em>pulls</em> from it at its own sustainable rate, so a spike buffers in the log instead of overwhelming the store. Scale ingestion nodes horizontally, partitioned by time + <code>adId</code>."},
        {who:"intv",text:"If the store pulls at its own pace, it lags during the spike. Is that acceptable?"},
        {who:"cand",text:"Yes — near-real-time tolerates seconds-to-a-minute of lag, which is within my freshness SLO, and the log guarantees no aggregate is lost while the store catches up. Dashboards show a slightly older-but-labeled number during the peak. And critically, <strong>billing doesn't read the speed layer</strong> — it reads finalized batch — so ingestion lag is a freshness blip, never a correctness or billing problem."},
      ],resources:[
        {title:"Apache Kafka documentation",url:"https://kafka.apache.org/documentation/"},
        {title:"Hello Interview — Ad Click Aggregator",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ad-click-aggregator"},
      ]},
      {l:"hard",tag:"durability",q:"An OLAP data node dies — are recent aggregates lost?",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> an OLAP data node holding recent segments dies and won't return. Those segments cover the last few hours of aggregates. Gone forever?</span>"},
        {who:"cand",text:"No, on two levels. Handed-off <strong>immutable segments live in deep storage</strong> (S3/HDFS) and are <strong>replicated</strong> across data nodes (RF≥2), so a dead node's segments reload onto a peer from deep storage — nothing durable is lost. Very recent, not-yet-handed-off real-time segments are covered by running <strong>replicated real-time tasks</strong>, and as a last resort can be rebuilt by <strong>replaying the aggregate topic from Kafka</strong>, since the log is the source."},
        {who:"intv",text:"Rebuilding from Kafka takes time — is there a window where recent data is missing from queries?"},
        {who:"cand",text:"Minimised by the replica: a peer real-time task already holds the same recent data, so the query layer fails over to it immediately rather than waiting on a rebuild. The Kafka replay is the belt-and-suspenders path for the rare case both replicas are lost. So in the normal single-node failure, queries see a fast failover with no visible gap; the log guarantees I can always reconstruct if it ever comes to that."},
      ],resources:[
        {title:"Apache Kafka documentation",url:"https://kafka.apache.org/documentation/"},
        {title:"System Design Primer — availability patterns",url:"https://github.com/donnemartin/system-design-primer#availability-patterns"},
      ]},
      {l:"medium",tag:"failover",q:"Half the query nodes are down — partial sums?",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> half your OLAP query-serving nodes are down during an upgrade. Queries risk returning <b>partial sums</b> — under-counting an advertiser's clicks. They make budget decisions on these numbers. What do they see?</span>"},
        {who:"cand",text:"Under-counting silently is the worst outcome — an advertiser could pause a campaign that's actually performing. So I separate <strong>query brokers</strong> from data nodes and have brokers fan out to <strong>replicas</strong> (RF≥2), so with half the fleet down the surviving replicas still cover the full dataset and return complete sums. If coverage genuinely can't be guaranteed, I <strong>fail or flag</strong> the query with a coverage/freshness indicator rather than return a confidently-wrong low number."},
        {who:"intv",text:"So for a moment a dashboard errors instead of showing a number. Is that really better?"},
        {who:"cand",text:"For a raw error, I'd rather serve the <strong>last-good cached rollup labelled as-of a timestamp</strong> — stale-but-honest beats both an error and a wrong number. The rule differs by consumer: dashboards get stale-labelled data, but <strong>billing always reads finalized batch</strong> and never a degraded speed-layer read, so money is never computed off a partial sum. Correctness of the billable number is non-negotiable; dashboard freshness can bend."},
      ],resources:[
        {title:"System Design Primer — availability patterns",url:"https://github.com/donnemartin/system-design-primer#availability-patterns"},
        {title:"ByteByteGo",url:"https://bytebytego.com/"},
      ]},
      {l:"medium",tag:"capacity",q:"How many OLAP nodes, and how much storage for aggregates?",turns:[
        {who:"intv",text:"Size the OLAP store. How much storage do the aggregates need, and how many nodes do you provision? Don't hand-wave — show the math."},
        {who:"cand",text:"Storage is driven by <em>aggregate rows</em>, not raw events — that's the whole point of pre-aggregating. Rows ≈ active (adId, minute) pairs per day.<span class='eg'>~1M ads active per minute × 1,440 min ≈ 1.44B rows/day × ~80B (with dim columns) ≈ 115 GB/day; 90-day retention × RF2 ≈ ~20 TB → ~10 nodes at ~2 TB usable. Hour/day rollups add ~10%.</span>Throughput is modest — upserts scale with active ads, not the 10M/s firehose — so storage, not write rate, sets the node count."},
        {who:"intv",text:"Why not just keep everything at minute granularity forever and skip the rollups?"},
        {who:"cand",text:"Because minute granularity forever explodes the row count and makes long-range scans slow — a 90-day-by-day query would sum ~130K minute rows per ad instead of 90 day rows. Coarser rollups make long queries cheap but lose fine detail. The trade-off is query speed and storage vs resolution. <strong>Decision:</strong> keep minute granularity for the recent window (days) on the hot cluster, roll up to hour/day for older data, and tier cold history off the fast nodes — so the hot cluster stays small and every query hits the coarsest rollup that answers it."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"ByteByteGo",url:"https://bytebytego.com/"},
      ]},
    ],
    dedup:[
      {l:"medium",tag:"concept",q:"How do you dedup a stream at millions/s?",turns:[
        {who:"intv",text:"You added dedup for exactly-once-ish. Concretely, how do you dedup a firehose at millions of events/s?"},
        {who:"cand",text:"Every event carries a <code>clickId</code>. The dedup stage keeps a <strong>seen-set</strong> and does a check-and-set per event: if the <code>clickId</code> is already present, drop it; otherwise record it and forward.<span class='eg'>seen.add(clickId) returns false → duplicate → drop</span>I co-partition so a given <code>clickId</code> always routes to the same task — dedup within the <code>adId</code> partition works since a duplicate shares both <code>adId</code> and <code>clickId</code> — so the lookup is <strong>local</strong>, not a remote call."},
        {who:"intv",text:"A check-and-set per event at 10M/s — isn't the state store the bottleneck?"},
        {who:"cand",text:"It would be if it were remote. So the seen-set is <strong>embedded local state</strong> — RocksDB per partition — giving O(1) on-box lookups with no network hop, and it scales horizontally with partition count. That's the whole reason to co-partition by key: dedup becomes an in-process operation that scales the same way the aggregation does, rather than a shared hot service everyone hammers."},
      ],resources:[
        {title:"Hello Interview — Ad Click Aggregator",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ad-click-aggregator"},
        {title:"Apache Kafka documentation",url:"https://kafka.apache.org/documentation/"},
      ]},
      {l:"hard",tag:"scaling",q:"Storing every clickId is terabytes and grows forever.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> at <b>86B clicks/day</b>, remembering every <code>clickId</code> for dedup is terabytes and grows without bound. Bound it without letting duplicates slip through.</span>"},
        {who:"cand",text:"Dedup only needs a <strong>bounded window</strong>: a duplicate is a retry that arrives close in time to the original — seconds to at most the lateness window later — not days later. So I keep <code>clickId</code>s for a bounded TTL (say 24h) and expire the rest; beyond that, dupes are astronomically unlikely and the batch layer catches them from the raw log anyway. To shrink memory further I use a <strong>probabilistic filter</strong> (cuckoo/bloom) for the bulk plus an exact set for the very recent hot window."},
        {who:"intv",text:"A bloom filter has false positives — it would drop a <em>real</em> click. Acceptable for billing?"},
        {who:"cand",text:"A false positive is an <strong>under-count</strong> (a real click wrongly dropped), which for billing means <em>under</em>-charging — safer than over-charging, but still wrong. So I tune the FPR very low and keep the recent, high-value window in an <strong>exact</strong> structure, using the filter only for the older tail. And the safety net is the <strong>batch layer</strong>: it recomputes final counts from raw events with authoritative exact dedup, correcting any speed-layer false positive. Bloom is a speed optimization, never the source of truth for money."},
      ],resources:[
        {title:"Count–min sketch",url:"https://en.wikipedia.org/wiki/Count%E2%80%93min_sketch"},
        {title:"Lambda architecture",url:"https://en.wikipedia.org/wiki/Lambda_architecture"},
      ]},
      {l:"hard",tag:"durability",q:"Dedup loses its state on a crash — dupes flood back in.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a dedup task's local RocksDB is lost on a crash before its last checkpoint. It forgets which <code>clickId</code>s it saw and starts re-admitting duplicates it would have dropped. Double-count?</span>"},
        {who:"cand",text:"Guarded against by backing the local state with a <strong>changelog</strong> — a compacted Kafka topic (or engine checkpoints) that records seen <code>clickId</code>s. On restart the task <strong>restores the seen-set from the changelog</strong>, so its memory survives the crash, bounded by the same TTL window. It doesn't rebuild from nothing, so it doesn't re-admit dupes it had already dropped."},
        {who:"intv",text:"And if the changelog restore is incomplete or the window rolled — some dupes do slip through?"},
        {who:"cand",text:"Then the <strong>speed layer over-counts slightly</strong>, and that's acceptable by design — it's timely and near-exact, not authoritative. The <strong>batch layer</strong> reconciles final numbers from the raw events, which themselves carry <code>clickId</code>, so batch dedups authoritatively regardless of what the speed layer's transient state did. Billing runs off batch. So the split is deliberate: speed = fast + near-exact, batch = eventually exact, money = batch."},
      ],resources:[
        {title:"Apache Kafka documentation",url:"https://kafka.apache.org/documentation/"},
        {title:"Lambda architecture",url:"https://en.wikipedia.org/wiki/Lambda_architecture"},
      ]},
      {l:"hard",tag:"failover",q:"Crash between OLAP write and offset commit replays events.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> the pipeline consumes, dedups, aggregates, and writes to OLAP. A crash happens <b>after writing OLAP but before committing the Kafka offset</b>. On restart it replays those events. Dedup already forgot nothing — but does the write double-count?</span>"},
        {who:"cand",text:"This is the read-process-write atomicity gap. The clean fix is <strong>Kafka transactions / exactly-once semantics</strong>: bundle the offset commit and the output write into one transaction so either both commit or neither. On replay, the uncommitted output is aborted and the events are reprocessed exactly once. Producer-side duplicates are still caught by <code>clickId</code> dedup; this closes the consumer-side replay hole."},
        {who:"intv",text:"EOS across an <em>external</em> store like OLAP, not just Kafka-to-Kafka — how?"},
        {who:"cand",text:"Two ways. Either make the external write <strong>idempotent</strong> — upsert keyed by <code>(adId, minute)</code> with a monotonic version so a replay overwrites rather than adds — or, cleaner, write aggregates <strong>back to a Kafka topic transactionally</strong> and let the OLAP store ingest from that topic. The latter keeps exactly-once fully inside Kafka's transactional boundary and makes the OLAP ingestion a dumb, replayable consumer. I'd prefer that — it avoids trusting an external store to participate in the transaction."},
      ],resources:[
        {title:"Apache Kafka documentation",url:"https://kafka.apache.org/documentation/"},
        {title:"Hello Interview — Ad Click Aggregator",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ad-click-aggregator"},
      ]},
      {l:"medium",tag:"capacity",q:"Size the dedup seen-set state.",turns:[
        {who:"intv",text:"Numbers for the dedup store. How much state does the seen-set actually need, given <b>86B clicks/day</b>? Show the math."},
        {who:"cand",text:"Only the bounded window matters — a duplicate arrives close in time, so I size for the TTL window, not all history.<span class='eg'>24h window: 86B clickIds × ~40B (id + overhead) ≈ 3.4 TB total ÷ ~120 partitions ≈ ~29 GB/partition on RocksDB. A recent 5-min exact hot set: 5M/s × 300s × ~40B ≈ 60 GB total ≈ ~0.5 GB/partition in memory.</span>Co-partitioning by key keeps every lookup on-box, so this state is local per partition, not one shared store."},
        {who:"intv",text:"A 24h exact set is a lot of disk per partition — shrink it."},
        {who:"cand",text:"The lever is exact-vs-probabilistic over the window. A longer exact window catches more dupes in the speed layer but costs state; a shorter one is cheaper but pushes more to batch. A <strong>bloom/cuckoo filter</strong> cuts memory ~8-10x, at the cost of a false-positive that wrongly drops a real click — an under-count. <strong>Decision:</strong> keep a small <em>exact</em> recent hot window in memory, back the rest with RocksDB + a bloom filter to the TTL horizon, and lean on the <strong>batch layer</strong> as the authoritative backstop that re-dedups from raw events — so speed-layer state stays cheap and money stays correct."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"Hello Interview — Ad Click Aggregator",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ad-click-aggregator"},
      ]},
      {l:"medium",tag:"concept",q:"Which store backs the seen-set — Redis, RocksDB, or Cassandra?",turns:[
        {who:"intv",text:"The dedup stage needs a fast check-and-set per event. Which store backs the seen-set — Redis, embedded RocksDB, or Cassandra — and why?"},
        {who:"cand",text:"<strong>Embedded RocksDB</strong> co-partitioned with the stream is my pick: the seen-set lives on the same task that processes the partition, so check-and-set is an O(1) on-box lookup with no network hop, and it survives crashes via a compacted changelog. <strong>Redis</strong> is a fast external cache but every check is a network round-trip to a shared service. <strong>Cassandra</strong> is durable and scales, but it's a remote write per event with higher latency."},
        {who:"intv",text:"Redis is dead simple and microsecond-fast — why embed RocksDB instead?"},
        {who:"cand",text:"At <b>10M events/s</b> the trade-off is decisive: a remote seen-set means 10M network round-trips/s against a shared hot service that becomes its own bottleneck and failure domain, whereas embedded state scales exactly with partition count — add partitions, add dedup capacity, no shared tier. Redis makes sense if the seen-set must be <em>shared</em> across independent consumers, and Cassandra if I needed cross-datacenter durability of the set itself. <strong>Decision:</strong> embedded RocksDB co-partitioned by key, changelog-backed — dedup scales the same way aggregation does."},
      ],resources:[
        {title:"Apache Kafka documentation",url:"https://kafka.apache.org/documentation/"},
        {title:"Hello Interview — Ad Click Aggregator",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ad-click-aggregator"},
      ]},
    ],
    batch:[
      {l:"medium",tag:"concept",q:"What's the batch layer's job vs the stream?",turns:[
        {who:"intv",text:"You added a batch recompute layer. What's its job, and how does it relate to the streaming path?"},
        {who:"cand",text:"It's the <strong>batch/serving layer of a lambda architecture</strong>. The speed layer (streaming) gives low-latency approximate counts now; the batch layer periodically recomputes <strong>authoritative</strong> counts from the full retained raw log and the serving layer merges the two — <strong>batch overrides speed for finalized windows</strong>.<span class='eg'>dashboard shows speed-layer 12:04 (provisional); invoice reads batch-finalized 12:00 (final)</span>Batch owns exact dedup, late-data folding, and bug corrections."},
        {who:"intv",text:"Kappa architecture says drop the separate batch layer and just replay the stream. Why keep batch?"},
        {who:"cand",text:"Kappa is genuinely attractive — one codebase, reprocess by replaying Kafka through the <em>same</em> streaming logic, no dual implementations to keep in sync (the classic lambda pain). I'd actually lean kappa-<em>style</em>: my reconciliation is a replay of the raw log through corrected logic rather than a separate MapReduce dialect. Conceptually I still keep this box as the <strong>reconciliation path</strong> — whether it's a distinct batch engine or a stream reprocess, its role is the same: recompute truth from raw events. For huge historical recompute a dedicated batch engine (Spark) can be cheaper, so I keep the option."},
      ],resources:[
        {title:"Lambda architecture",url:"https://en.wikipedia.org/wiki/Lambda_architecture"},
        {title:"Hello Interview — Ad Click Aggregator",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ad-click-aggregator"},
      ]},
      {l:"hard",tag:"scaling",q:"Reconciling a day = 86B events. A nightly job can't finish.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> reconciling one day means recomputing <b>86B events</b>. A naive nightly job takes <b>14 hours</b> and starts colliding with the next day's run. Speed it up.</span>"},
        {who:"cand",text:"Two levers. <strong>Parallelize</strong>: partition the recompute by hour and by <code>adId</code> range and run it distributed (Spark) over columnar raw data (Parquet) in object storage, so throughput scales with cluster size instead of one long serial pass. <strong>Incrementalize</strong>: don't recompute all history nightly — only recompute the windows actually affected by late data or a correction, since the vast majority of finalized windows never change."},
        {who:"intv",text:"How do you know which windows are affected, to only recompute those?"},
        {who:"cand",text:"Track <strong>correction markers</strong>: late events beyond grace are tagged with their target <code>(adId, minute)</code>, and any deploy/bug correction names its affected time range. Reconciliation reads only those keys' raw events and rewrites just those aggregates — idempotent overwrites. So steady-state batch is tiny (only the late tail), and a full recompute is reserved for a known-bad range like the buggy hour. That turns a 14-hour full pass into minutes of targeted work most days."},
      ],resources:[
        {title:"Lambda architecture",url:"https://en.wikipedia.org/wiki/Lambda_architecture"},
        {title:"System Design Primer — study guide",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"hard",tag:"durability",q:"Guarantee the corrected hour fully replaces the bad one.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> the deploy bug corrupted <b>12:00–13:00</b>. You rerun batch for that hour. How do you guarantee the corrected numbers are right <em>and</em> fully replace the bad aggregates advertisers were billed on?</span>"},
        {who:"cand",text:"Batch reads the <strong>immutable raw events</strong> for that hour from the log, applies the corrected + versioned logic, dedups authoritatively by <code>clickId</code>, and writes <strong>idempotent overwrites</strong> keyed <code>(adId, minute)</code> stamped with a batch version/watermark. The serving layer prefers the higher finalized-batch version over the speed-layer value, so the corrected numbers deterministically supersede the bad ones. Because the source is immutable raw truth, the recompute is reproducible and verifiable."},
        {who:"intv",text:"Kafka retention is 7 days but the bug was found after 10. The raw events for that hour aged out. Now what?"},
        {who:"cand",text:"That's why raw events are <strong>tiered to object storage</strong> (S3) with long retention well beyond Kafka's hot window — batch reads old ranges from there, not from Kafka. The retention policy is set by the <strong>billing-dispute horizon</strong>: if advertisers can contest an invoice for 90 days, raw truth must live at least that long. Kafka holds the fast-replay recent window; object storage holds the long tail. Reconciliation can reach back as far as the dispute window requires."},
      ],resources:[
        {title:"Apache Kafka documentation",url:"https://kafka.apache.org/documentation/"},
        {title:"Lambda architecture",url:"https://en.wikipedia.org/wiki/Lambda_architecture"},
      ]},
      {l:"medium",tag:"failover",q:"The batch job dies 60% through writing corrections.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> the reconciliation job dies <b>60% through</b> writing corrected aggregates. Some <code>(adId, minute)</code> keys are updated, some still hold the bad values. State is now a mix. Is it safe to just rerun?</span>"},
        {who:"cand",text:"Safe, because the writes are <strong>idempotent overwrites</strong> — each key is <em>set</em> to its recomputed value, keyed by <code>(adId, minute, version)</code>, never incremented. Rerunning reproduces identical results and overwrites both the already-corrected keys and the still-bad ones; there's no additive double-application. A crashed partial run leaves no corruption, just an incomplete set that the rerun completes."},
        {who:"intv",text:"But during that window, readers see a mix of corrected and stale keys. How do you avoid exposing a half-written state?"},
        {who:"cand",text:"<strong>Version isolation / atomic swap</strong>: batch writes the corrected hour as a new immutable version (or new segment set) and only <strong>flips the serving pointer</strong> once the whole recompute is complete. Readers keep seeing the last fully-committed version until the switch, then atomically move to the new one — they never observe a partial mix. It's the same immutable-segment discipline the OLAP store uses; partial progress is never visible to queries."},
      ],resources:[
        {title:"Lambda architecture",url:"https://en.wikipedia.org/wiki/Lambda_architecture"},
        {title:"System Design Primer — availability patterns",url:"https://github.com/donnemartin/system-design-primer#availability-patterns"},
      ]},
    ],
    query:[
      {l:"medium",tag:"concept",q:"What does the query API expose over pre-aggregated data?",turns:[
        {who:"intv",text:"Advertisers want dashboards. What does the query API expose, and how does it hit the pre-aggregated data?"},
        {who:"cand",text:"An API over rollups, e.g. <code>GET /metrics?adId=42&from=..&to=..&granularity=minute&groupBy=geo</code>. It translates to a <strong>range scan + group-by</strong> over the OLAP store — sum counts across minute buckets, grouped by requested dims — and never touches raw events.<span class='eg'>last-24h count for adId=42 → sum ~1,440 minute rows → returned in ms</span>It returns a time series plus totals, targeting query p99 < 1s."},
        {who:"intv",text:"An advertiser asks for the last 30 days by day — that spans an enormous number of minute rows."},
        {who:"cand",text:"That's what <strong>multi-resolution rollups</strong> are for: I pre-aggregate minute → hour → day. A 30-day-by-day query reads ~30 day-buckets, not 43,200 minute rows; a recent 1-hour view reads minute-granularity. The query planner picks the coarsest rollup that satisfies the requested granularity, so every query stays bounded regardless of range. Long ranges hit coarse rollups, short recent ranges hit fine ones."},
      ],resources:[
        {title:"Hello Interview — Ad Click Aggregator",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ad-click-aggregator"},
        {title:"ByteByteGo",url:"https://bytebytego.com/"},
      ]},
      {l:"hard",tag:"scaling",q:"100K advertisers refreshing dashboards hammer the store.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> 100K advertisers keep dashboards open on auto-refresh — <b>50K queries/s</b> hit the query API, many of them identical repeated reads. The OLAP brokers strain. Cut the load.</span>"},
        {who:"cand",text:"Most of that is repeated reads of the same recent rollups, so I put a <strong>result cache</strong> in front of the store keyed by <code>(query, time-bucket)</code> with a short TTL — dashboards poll the cache, not the OLAP brokers. I also <strong>pre-materialize</strong> the common shapes (per-advertiser daily/hourly totals) so the frequent queries are lookups, not scans. That collapses 50K/s of scans into mostly cache hits."},
        {who:"intv",text:"A cache TTL means the dashboard shows slightly stale numbers. Does that clash with near-real-time?"},
        {who:"cand",text:"Advertisers tolerate ~30s of staleness on a dashboard, so a <strong>15–30s TTL</strong> cuts read load by orders of magnitude while staying within the near-real-time expectation — the underlying data only advances a minute at a time anyway. Live-ish counters can take a shorter TTL, and the freshness timestamp is shown so the number is honest. It's the same read-heavy-plus-immutable-recent-data logic that makes caching the highest-leverage move here."},
      ],resources:[
        {title:"System Design Primer — caching",url:"https://github.com/donnemartin/system-design-primer#cache"},
        {title:"Hello Interview — Ad Click Aggregator",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ad-click-aggregator"},
      ]},
      {l:"medium",tag:"failover",q:"The OLAP store is down for 2 minutes — dashboards error.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> the OLAP store is unreachable for <b>2 minutes</b> during an upgrade. Every dashboard query errors and advertisers see a broken page. Improve the experience.</span>"},
        {who:"cand",text:"Degrade gracefully instead of hard-failing. A <strong>circuit breaker</strong> in the query API trips on OLAP errors and serves the <strong>last-good cached rollups</strong>, labelled with an as-of timestamp — a slightly stale-but-honest dashboard beats a broken page for a 2-minute blip. Reads that must be exact (billing) can wait and retry; dashboards ride the cache through the outage."},
        {who:"intv",text:"What about queries whose result isn't in the cache?"},
        {who:"cand",text:"For an uncached query I return a <strong>clear degraded response</strong> with a retry-after, not a partial or fabricated number — never mislead the advertiser. To minimise how often that happens I <strong>pre-warm</strong> the cache with the top advertisers' common views, since traffic is heavily skewed toward a small set of big spenders, so the vast majority of dashboards stay served from cache even while the store is down. Rare uncached queries degrade honestly; common ones don't notice."},
      ],resources:[
        {title:"System Design Primer — availability patterns",url:"https://github.com/donnemartin/system-design-primer#availability-patterns"},
        {title:"System Design Primer — caching",url:"https://github.com/donnemartin/system-design-primer#cache"},
      ]},
      {l:"hard",tag:"concept",q:"Dashboard number differs from the invoice — which wins?",turns:[
        {who:"intv",text:"An advertiser notices the dashboard count for 12:00 doesn't match the invoice for 12:00. Why would they differ, and which do you show where?"},
        {who:"cand",text:"They read different layers. The <strong>dashboard reads the speed layer</strong> — timely but provisional: it may include not-yet-deduped retries or miss clicks still within the grace period. The <strong>invoice reads finalized batch</strong> — exact, authoritatively deduped, computed after the grace/reconciliation window and after fraud filtering.<span class='eg'>12:00 dashboard: 18,432 provisional → 12:00 invoice: 18,390 final after dedup + late-data + fraud</span>Recency comes from speed; money comes from batch."},
        {who:"intv",text:"Won't a number that starts provisional and then settles to a different final value confuse or annoy advertisers?"},
        {who:"cand",text:"Only if it's unexplained, so I <strong>label it</strong>: recent buckets are marked <em>provisional</em> and visibly <em>settle to final</em> after the reconciliation window closes. This is standard in ad analytics — advertisers expect live numbers to firm up. What matters is that the <strong>final number is stable and correct</strong> for billing; the provisional value is a real-time estimate, clearly flagged as such, not a promise. Transparency turns a confusing discrepancy into an expected settling process."},
      ],resources:[
        {title:"Lambda architecture",url:"https://en.wikipedia.org/wiki/Lambda_architecture"},
        {title:"Hello Interview — Ad Click Aggregator",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ad-click-aggregator"},
      ]},
      {l:"medium",tag:"capacity",q:"How many query API instances and brokers for the read load?",turns:[
        {who:"intv",text:"Size the read tier. With ~1M advertisers and dashboards on auto-refresh, peak reads hit <b>~50K queries/s</b>. How many query-API instances and OLAP brokers do you run? Show the math."},
        {who:"cand",text:"The API is stateless and light — parse, cache-check, fan-out — so I size it from a per-instance budget and put a result cache in front to shield the brokers.<span class='eg'>50K queries/s ÷ ~5K qps per stateless instance ≈ 10 instances; +30% headroom ≈ 13, spread across 3 AZs. With a 15-30s result cache at ~90% hit, OLAP brokers see only ~5K scan qps → a handful of brokers.</span>Most dashboard traffic is repeated reads of the same recent rollups, so the cache does the heavy lifting."},
        {who:"intv",text:"Why not just size the OLAP brokers for the full 50K/s so you don't depend on the cache?"},
        {who:"cand",text:"Because OLAP scan nodes are far more expensive than stateless API pods, and sizing them for uncached peak leaves costly capacity idle in steady state — while relying purely on cache risks a cold-cache or cache-outage surge onto the brokers. The trade-off is cost vs cold-cache safety. <strong>Decision:</strong> size the API fleet for peak qps, size brokers for the cache-<em>miss</em> rate plus a warm floor, and <strong>pre-warm the top advertisers'</strong> common views since traffic is heavily skewed — so brokers ride a fraction of peak and a cache blip degrades gracefully rather than toppling them."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"Hello Interview — Ad Click Aggregator",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ad-click-aggregator"},
      ]},
    ],
  },
  mockTest:[
    {q:"At 10M clicks/s, how do you size the ingest path and partition the event log — and why partition by <code>adId</code>?",a:"Land clicks in a durable log (Kafka) fronted by a thin stateless gateway fleet (~50K events/s each → ~200 instances at peak) that validates, enriches, and produces with batched/compressed async writes. Partition count = throughput ÷ per-partition ceiling: ~250K events/s per partition → ~40 floor, rounded to ~120 for headroom + hot-ad salting. Key by <code>adId</code> so every event for an ad is ordered in one partition and a single consumer aggregates it locally with no cross-consumer shuffle. Storage: 86B/day × 100B ≈ 8.6 TB/day; 7-day hot window × RF3 ≈ ~180 TB, older raw tiered to object storage."},
    {q:"One ad goes viral — 3M of 10M clicks/s hit a single <code>adId</code> partition and its consumer lags hours. How do you fix the hotspot?",a:"Partition-by-<code>adId</code> caps one ad at one partition/one consumer, so adding consumers can't help. Salt the hot key across K sub-partitions (<code>adId#0..adId#K-1</code>, round-robin) so 3M/s fans out to ~300K/s each. Recombine with two-stage aggregation: stage one computes partial per-minute counts per salt, stage two sums the K partials keyed by the real <code>adId</code>. Only compact partials shuffle, not raw events. Detect hotness in seconds with a heavy-hitters / count-min sketch and salt dynamically — split while hot, collapse when it cools — so cold ads pay nothing."},
    {q:"How does windowed aggregation work, and what exactly does the aggregator emit?",a:"Tumbling 1-minute windows keyed by <code>(adId, minute)</code>, event-time based. The aggregator keeps a running count plus dim breakdowns in local state and, on window close, emits <code>{adId, minute, count, dims}</code> to the OLAP store. Task count is bounded by partitions (~120) at ~200K events/s/task; window state ≈ active ads × open windows in the grace period × bytes, checkpointed durably. Pre-aggregating at write time is the core bet: a last-24h query reads ~1,440 minute-buckets instead of scanning the firehose."},
    {q:"A retry writes the same <code>clickId</code> twice and the advertiser is over-charged. How do you get exactly-once-ish counting?",a:"Kafka is at-least-once, so design for duplicates. Dedup on the client-minted <code>clickId</code> (stable across retries) in an embedded, co-partitioned seen-set (RocksDB) — an O(1) on-box check-and-set, no shared hot service. Bound it to a TTL window (~24h) since duplicates arrive close in time; back it with a compacted changelog so it survives crashes. Combine with Kafka's idempotent producer and atomic state+offset checkpoints to close the consumer-replay hole. Any residual over-count is corrected by the batch layer, which re-dedups authoritatively from raw events — speed = near-exact, batch = exact, billing reads batch."},
    {q:"Which OLAP store do you choose for the aggregates, and why not the alternatives?",a:"A column-oriented store for time-series range + group-by: Druid (decision), with Pinot close behind. Load is aggregate upserts (~17K/s steady, ~2M/s buffered spike) and ~5K scan QPS post-cache with p99 &lt; 1s; storage ~20 TB → ~10 nodes. Druid gives time-partitioned segments, native rollup, and deep-storage durability so the batch layer corrects a window by swapping immutable segments. ClickHouse is faster on ingest/scan but merge-based upserts are awkward for idempotent overwrite; Cassandra is KV with no group-by engine, forcing app-side summation; DynamoDB point reads can't serve range + group-by cheaply."},
    {q:"A click's event-time is 12:00:59 but it arrives at 12:20, after the window closed. What happens to it?",a:"Aggregate on event-time with a watermark and an allowed-lateness grace period (say 15 min): a click within grace still updates its window and re-emits a corrected count. This one is 20 min late — beyond grace — so it doesn't touch the live window and is routed to the reconciliation/batch path to be folded into the final number; nothing is dropped. Open state ≈ active ads × windows-in-grace, bounded by grace length and checkpointed. Pick grace from the observed lateness distribution (cover p99) and let batch mop up the long tail. Recent buckets are labelled provisional and settle to final."},
    {q:"A deploy bug wrote wrong counts for an hour and advertisers were mis-billed. How do you reconcile, and how is it made affordable?",a:"Lambda: the speed layer is timely-approximate; a batch layer recomputes authoritative counts for that hour from the retained raw log (ground truth) and writes idempotent overwrites keyed <code>(adId, minute)</code> stamped with a higher batch version — it sets, never increments, so a partial rerun is safe and the serving layer prefers the finalized version. Billing reads batch. Affordability: parallelize by hour and <code>adId</code> range over columnar raw data (Spark/Parquet) in object storage, and incrementalize — only recompute windows flagged by correction markers, so steady-state batch is just the late tail and full recompute is reserved for a known-bad range."},
    {q:"How does the read path serve near-real-time dashboards at 50K QPS, and why do the dashboard and invoice numbers differ?",a:"A stateless query API exposes rollup queries (<code>GET /metrics?adId=..&from=..&to=..&granularity=..&groupBy=..</code>) that translate to range + group-by scans over multi-resolution rollups (minute→hour→day); the planner picks the coarsest rollup that answers the range. A result cache keyed by (query, time-bucket) with a 15-30s TTL absorbs ~90% of the repeated reads, so ~50K QPS collapses to ~5K scan QPS on the brokers (~13 API pods, a handful of brokers). The dashboard reads the provisional speed layer (may include un-deduped retries / miss in-grace clicks); the invoice reads finalized batch (exact, deduped, fraud-filtered). Recency from speed, money from batch — provisional buckets are labelled and visibly settle to final."},
  ]
};
