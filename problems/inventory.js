window.DATA = window.DATA || {};
window.DATA['inventory'] = {
  cat:"commerce · concurrency · consistency",
  title:"Design an inventory management system (e-commerce, no oversell)",
  blurb:"Track stock per SKU across many fulfillment centers, reserve units at checkout under heavy concurrency, and never oversell — while serving a firehose of availability reads and surviving flash sales on a single hot SKU.",
  prompt:"Let's design the inventory system behind a large e-commerce platform — think Amazon or Flipkart. It tracks how many units of each SKU are on hand across many fulfillment centers, reserves stock when a customer checks out, and must never confirm more units than physically exist, even when a million people hammer the same product in a flash sale. The interesting parts are the distributed bits: an atomic no-oversell decrement, hot-row contention on a single popular SKU, time-limited reservations that must not leak, and a read path (product-page availability) that is ~100x the write path and can tolerate a little staleness. The catalog/search side is not the point. Start with the high-level architecture and rough numbers, then we'll drill into components and I'll throw concurrency and failure at you.",
  opening:"Let me frame it before drawing boxes.<br><br><strong>Functional:</strong> track on-hand stock per SKU per fulfillment center; <strong>reserve</strong> units at checkout with a time-limited hold, <strong>commit</strong> on order placement and <strong>release</strong> on cancel/timeout; never <strong>oversell</strong>; ingest <strong>replenishment</strong> (inbound receipts) and adjustments (returns, damage, cycle counts); and answer <strong>availability</strong> reads for the storefront. <strong>Non-functional:</strong> the hard invariant is <strong>correctness on the decrement path</strong> — strong consistency so two concurrent buyers can't both claim the last unit — paired with <strong>idempotency</strong> so a retried reserve doesn't double-decrement. Availability <strong>reads</strong> are the opposite: ~100x the writes, must be fast and highly available, and can be <strong>slightly stale</strong>. Everything is <strong>auditable</strong> — every unit movement is a durable ledger event we can reconcile against.<br><br><strong>Back-of-envelope:</strong> ~<strong>100M</strong> active SKUs across ~<strong>1,000</strong> fulfillment centers, so a few hundred million <code>(sku, fc)</code> rows — small bytes. Availability reads peak ~<strong>1M/s</strong>; reserves ~<strong>10K/s</strong> steady but a flash sale can drive ~<strong>100K/s</strong> onto a <em>single</em> hot SKU. The pressure is concurrency and read amplification, not raw storage.<br><br>I'll start deliberately minimal: <strong>client → inventory API → inventory store</strong>, where the store holds an atomically-decrementable count per <code>(sku, fc)</code>. That skeleton already prevents oversell for one row. Under pressure I'll grow it: a <strong>reservation service</strong> for holds, a <strong>reaper</strong> to expire them, an <strong>availability cache</strong> for the read firehose, a <strong>movement ledger</strong> for audit and cache refresh, and a <strong>replenishment</strong> path for inbound stock. Pick a box and let's push.",
  nodes:[
    {id:"client",name:"Client",sub:"browse / checkout",x:40,y:150},
    {id:"api",name:"Inventory API",sub:"reserve / query",x:210,y:150},
    {id:"invdb",name:"Inventory store",sub:"count per (sku,fc)",x:380,y:150},
    {id:"ledger",name:"Movement ledger",sub:"append-only events",x:550,y:150},
    {id:"cache",name:"Availability cache",sub:"hot reads",x:210,y:40},
    {id:"holds",name:"Reservation svc",sub:"time-limited holds",x:380,y:40},
    {id:"reaper",name:"Hold reaper",sub:"expire / release",x:550,y:40},
    {id:"replenish",name:"Replenishment",sub:"inbound + adjust",x:380,y:260},
  ],
  edges:[
    ["client","api","browse / buy"],
    ["api","cache","availability"],
    ["api","holds","reserve"],
    ["api","invdb","read / commit"],
    ["holds","invdb","atomic decrement"],
    ["invdb","ledger","movement event"],
    ["ledger","cache","CDC refresh"],
    ["reaper","holds","expire"],
    ["replenish","invdb","restock / adjust"],
  ],
  core:["client","api","invdb"],
  basic:["client","api","invdb"],
  deepDive:{
    client:{
      role:"The storefront + checkout surface. It renders <strong>availability</strong> on product pages and fires a <strong>reserve</strong> when a customer starts checkout. Its one correctness lever is the <strong>idempotency key</strong> it attaches to a reserve, so a flaky-network retry never places two holds for the same cart line.",
      capacity:[
        ["Availability reads","~1M/s peak","product-page + search views dominate"],
        ["Reserve writes","~10K/s steady","checkout starts; ~100K/s on a flash-sale SKU"],
        ["Read:write skew","~100:1","browsing dwarfs buying"],
      ],
      data:"Stateless view of server truth. It caches nothing authoritative — it holds a <code>reservation_id</code> after a successful reserve and the cart's idempotency key, and always treats the server's availability answer as advisory (stock can change between page-load and checkout).",
      scaling:[
        "Show <strong>\"In stock\" / \"Only a few left\"</strong> rather than an exact live count for hot SKUs, so the read can be served stale from cache without lying.",
        "Debounce and cache availability client-side; don't re-query on every keystroke or scroll.",
        "On a <code>409 out-of-stock</code> at reserve, fail gracefully — offer alternates or backorder — rather than retry-storming the last unit.",
      ],
      failures:[
        {t:"Reserve times out with no response",b:"Customer retries and could place two holds, locking stock they'll buy once.",m:"Client-generated idempotency key reused on retry; the reservation service returns the <em>same</em> hold instead of creating a second."},
        {t:"Page shows 'in stock' but reserve fails",b:"Cached availability was stale; the unit sold out in the gap.",m:"Treat availability as advisory; the reserve's atomic decrement is the source of truth. Show a clear out-of-stock message and refresh the count."},
      ],
      tradeoffs:[
        {a:"Show exact live count",b:"Show coarse 'in stock'",pick:"Exact counts force fresh reads and leak into a hot-row read on popular SKUs; a coarse badge is served from cache and is almost always what the shopper needs. Reserve exact counts for low-stock nudges (\"3 left\")."},
      ],
      probes:[
        "A reserve request times out and the customer clicks buy again — how do you avoid double-holding the stock?",
        "The product page said 'in stock' but checkout failed — is that a bug? How do you present it?",
        "Reads are ~100x writes — what does that imply for how you render availability?",
      ],
    },
    api:{
      role:"The stateless front door. It authenticates, validates the request, <strong>routes by <code>sku_id</code></strong> to the right store shard, serves availability from cache, and orchestrates the reserve/commit/release calls. Its non-negotiable: the <strong>decrement is never acked until it is strongly-consistent and durable</strong>.",
      capacity:[
        ["Per-instance throughput","~10K req/s","stateless: auth + validate + one store/cache op"],
        ["Peak read load","~1M/s","availability reads, mostly cache hits"],
        ["Fleet","low-hundreds of instances","sized for cache-miss + write traffic, not raw page views"],
      ],
      data:"Stateless — scales horizontally behind an LB. All durable state lives in the inventory store, reservations table, and ledger. The API owns request routing (which shard/FC) and the contract that a <code>200</code> reserve means a unit is genuinely held.",
      scaling:[
        "Split paths: availability reads hit <strong>cache + read replicas</strong>; reserves/commits hit the <strong>write primary</strong> for the SKU's shard.",
        "Push per-SKU <strong>rate limiting / admission</strong> at the edge so a flash sale can't convert 1M browsers into 1M write attempts on one row.",
        "Co-locate the API's shard routing with the store's partitioning so a reserve is a single-shard, single-row transaction.",
      ],
      failures:[
        {t:"Store primary for a shard is unreachable",b:"Reserves for those SKUs fail even though stock exists.",m:"Fail the write (never guess); fall back to a followers-only read for availability, and let the shard's leader election promote a replica within seconds."},
        {t:"Cache is down",b:"1M/s of availability reads stampede the store.",m:"Request coalescing / single-flight per SKU, serve last-known values with a stale flag, and shed load to protect the write path that actually prevents oversell."},
      ],
      tradeoffs:[
        {a:"Read from primary (fresh)",b:"Read from replica/cache (stale)",pick:"Availability is served stale from cache/replica to survive 1M/s; the reserve path reads-and-decrements on the primary because that's the only place correctness is enforced."},
      ],
      probes:[
        "How does the API decide which shard and which fulfillment center a reserve hits?",
        "Cache just died — how do you keep the store from melting under 1M/s of reads?",
        "Why can availability be stale but the reserve cannot?",
      ],
    },
    cache:{
      role:"The read-amplification shock absorber. A <strong>Redis</strong> tier that answers the ~1M/s availability firehose so the store only sees writes and cache-miss fills. It holds a coarse, slightly-stale view (\"in stock\", or a rolled-up available count), refreshed by CDC off the ledger.",
      capacity:[
        ["Read throughput","~1M/s","product-page + search availability lookups"],
        ["Entry size","tiny","sku -> {available_rollup, in_stock_bool, ts}"],
        ["Refresh lag","sub-second to a few s","CDC from movement events; tolerable for a badge"],
      ],
      data:"Derived, not authoritative. Keyed by <code>sku_id</code> (optionally <code>(sku_id, region)</code>) holding a rolled-up available quantity across that SKU's fulfillment centers and an <code>in_stock</code> boolean. Rebuildable at any time by folding the ledger or reading the store.",
      scaling:[
        "Update via <strong>CDC / ledger tail</strong> (push) rather than write-through on every reserve, so a hot SKU's thousands of decrements collapse into periodic rollup refreshes.",
        "Serve <strong>coarse buckets</strong> (in-stock / low / out) for hot SKUs so tiny count jitter doesn't invalidate the entry constantly.",
        "Use <strong>request coalescing / single-flight</strong> on miss so a cold hot-key doesn't send a thundering herd to the store.",
      ],
      failures:[
        {t:"Stale cache shows in-stock after sellout",b:"Shoppers start checkouts that fail at the atomic decrement.",m:"Accept it — the decrement is the guard. Keep refresh lag small, and flip to out-of-stock immediately when a reserve returns insufficient."},
        {t:"Hot-key expiry causes a stampede",b:"Every miss for a viral SKU hits the store at once.",m:"Single-flight per key, jittered TTLs, and a short negative cache for out-of-stock so misses don't repeatedly probe the store."},
      ],
      tradeoffs:[
        {a:"Write-through on every change",b:"CDC/async refresh",pick:"Write-through keeps the cache freshest but adds latency to the hot decrement and amplifies hot-row writes; async CDC refresh keeps the write path lean and the badge is allowed to lag a beat."},
      ],
      probes:[
        "How does the cache stay roughly in sync without slowing the reserve path?",
        "A SKU goes viral and its cache entry expires — what stops the store from being stampeded?",
        "What exactly do you cache — an exact count or something coarser? Why?",
      ],
    },
    holds:{
      role:"The reservation manager. On checkout it creates a <strong>time-limited hold</strong> that moves units from <code>available</code> to <code>reserved</code>, so a customer's cart stock can't be sold to someone else while they pay. It commits the hold on order placement and relies on the reaper to release abandoned ones. Idempotency keeps retries safe.",
      capacity:[
        ["Reserve rate","~10K/s steady","~100K/s on a hot SKU during a drop"],
        ["Hold TTL","~10-15 min","covers a normal checkout + payment"],
        ["Live holds","~millions","concurrent in-flight checkouts"],
      ],
      data:"Owns the <code>reservations</code> table keyed by <code>reservation_id</code> (sku, fc, order, qty, status held/committed/released/expired, <code>expires_at</code>, idempotency_key). The actual count lives in the inventory store; a hold is the paired ledger entry + reserved-quantity bump, done in one atomic step with the decrement.",
      scaling:[
        "Make reserve <strong>idempotent</strong> on the cart line key so a retry returns the existing hold, never a second one.",
        "Bound hold TTL tightly and let the reaper reclaim — long holds turn abandoned carts into phantom stock-outs.",
        "For hot SKUs, pair with a <strong>virtual waiting room / admission</strong> so holds are created at a rate the stock can actually satisfy.",
      ],
      failures:[
        {t:"Reserve succeeds but the ack is lost",b:"Client retries; a naive service creates a second hold and double-locks stock.",m:"Unique constraint on <code>(idempotency_key)</code>; the racing retry reads back the same reservation_id instead of inserting."},
        {t:"Customer abandons checkout",b:"Reserved units are stuck, and the SKU looks sold out though nobody bought it.",m:"Every hold carries <code>expires_at</code>; the reaper releases expired holds back to available. Holds are leases, not permanent state."},
      ],
      tradeoffs:[
        {a:"Reserve-on-add-to-cart",b:"Reserve-at-checkout",pick:"Reserving early gives the best UX guarantee but locks stock for browsers who never buy; reserving at checkout (with a tight TTL) keeps stock liquid. Most systems reserve at checkout and treat the cart as advisory."},
        {a:"Hold in the same DB",b:"Hold in Redis",pick:"A Redis lease is fast but risks divergence from the authoritative count; keeping the reserved quantity and the hold row in the same transactional store keeps reserved+available consistent by construction."},
      ],
      probes:[
        "A reserve is retried after a timeout — how do you guarantee exactly one hold?",
        "Carts get abandoned constantly — how do you stop reserved-but-never-bought stock from looking sold out?",
        "Would you reserve on add-to-cart or at checkout? Defend it.",
      ],
    },
    invdb:{
      role:"The <strong>source of truth</strong> — the atomically-decrementable count per <code>(sku_id, fc_id)</code>. Every no-oversell guarantee lives here as a <strong>single-row conditional decrement</strong>: subtract only if enough is available. It's strongly consistent on the write path; everything else derives from it.",
      capacity:[
        ["Steady writes","~30-50K/s","reserves + commits + releases + restocks, multi-step"],
        ["Hot-row writes","~100K/s on one SKU","flash sale — the contention problem"],
        ["Rows","~few hundred M","100M SKUs x avg few stocked FCs; small bytes"],
      ],
      data:"Relational/NewSQL, <strong>sharded by <code>sku_id</code></strong> (or <code>(sku_id, fc_id)</code>). Per-row: <code>on_hand</code>, <code>reserved</code>, derived <code>available = on_hand - reserved</code>, plus a <code>version</code> for optimistic concurrency. Correctness = the conditional <code>UPDATE ... WHERE available >= qty</code>.",
      scaling:[
        "<strong>Split a hot SKU into K sub-counters</strong> (<code>(sku, fc, bucket)</code>): reserves hash to a random bucket so 100K/s spreads across K rows instead of contending on one; availability sums the buckets.",
        "Keep stock naturally spread by <strong>per-FC rows</strong> — a SKU's demand is split across its fulfillment centers, so no single row takes the full flash-sale load.",
        "Shard by <code>sku_id</code> so a reserve is single-shard; use a NewSQL engine (CockroachDB/Spanner) to add write-nodes without hand-resharding.",
      ],
      failures:[
        {t:"Two buyers race for the last unit",b:"A read-then-write would let both read '1 available' and both decrement — oversell.",m:"Never read-then-write; do one atomic conditional <code>UPDATE inventory SET reserved=reserved+1 WHERE available>=1</code> — the DB serializes it, exactly one wins."},
        {t:"Primary crashes mid-transaction",b:"A half-applied decrement could lose or double-count stock.",m:"Quorum-replicated commit (leader waits for a follower ack) so a promoted replica has every committed decrement; the transaction is atomic so partials never persist."},
      ],
      tradeoffs:[
        {a:"Single row per (sku,fc)",b:"Sharded sub-counters",pick:"One row is simplest and gives an exact count, but a viral SKU serializes all traffic onto it; sub-counters trade exactness/complexity for throughput. Apply sub-counters only to the few SKUs that are actually hot."},
        {a:"Strong consistency",b:"Eventual",pick:"The decrement must be strongly consistent — eventual consistency here means overselling. Only the derived availability read is allowed to be eventual."},
      ],
      probes:[
        "Two people click buy on the last unit at the same millisecond — walk me through why exactly one wins.",
        "One SKU is taking 100K reserves/s — how do you stop that single row from being a bottleneck?",
        "Why is eventual consistency acceptable for availability but not for the decrement?",
      ],
    },
    ledger:{
      role:"The append-only <strong>book of record</strong> for every unit movement — receipt, reserve, release, commit, adjustment. It gives an <strong>audit trail</strong>, lets on-hand be <strong>reconciled/reconstructed</strong>, and is the <strong>CDC source</strong> that refreshes the availability cache and feeds analytics.",
      capacity:[
        ["Event rate","~50-100K/s","one event per movement, spikes with sales"],
        ["Retention","long / tiered","hot in Kafka days; cold in a warehouse/object store for years"],
        ["Consumers","cache, analytics, recon","fan-out via a log (Kafka) partitioned by sku"],
      ],
      data:"Immutable events: <code>movement_id, sku_id, fc_id, type, qty_delta, reason, ref_id (order/reservation/receipt), ts</code>. Written in the <em>same transaction</em> as the count change (outbox pattern) so the log and the store never disagree. Folding the log reproduces <code>on_hand</code>.",
      scaling:[
        "Use the <strong>transactional outbox</strong>: write the movement row + emit the event atomically, then relay to Kafka — no dual-write gap.",
        "Partition the log by <code>sku_id</code> so a SKU's events stay ordered and consumers parallelize across SKUs.",
        "Tier retention: recent events hot for CDC/recon, historical events rolled to cheap columnar storage for audits.",
      ],
      failures:[
        {t:"Count updated but event not emitted (dual write)",b:"Ledger and store diverge; audits and cache drift.",m:"Outbox pattern — the event is part of the same DB transaction as the decrement; a relay publishes committed outbox rows at-least-once with dedup on movement_id."},
        {t:"Cache/consumer falls behind",b:"Availability badge lags reality.",m:"Consumers are idempotent and replayable from the log offset; a lagging consumer catches up without data loss, and the store remains the correctness authority regardless."},
      ],
      tradeoffs:[
        {a:"Event-sourced (log is truth)",b:"State + audit log",pick:"Pure event sourcing makes recon trivial but every read folds events; keeping a materialized count as truth with the ledger as the audit/CDC feed is simpler to operate and still fully reconcilable."},
      ],
      probes:[
        "How do you guarantee the ledger and the live count never disagree?",
        "How would you detect and fix a SKU whose count has drifted from reality?",
        "Why partition the event log by sku_id specifically?",
      ],
    },
    reaper:{
      role:"The background reclaimer. It finds <strong>expired holds</strong> (checkouts that were abandoned or timed out) and <strong>releases</strong> their units back to available, so reserved-but-never-bought stock doesn't masquerade as a stock-out. It's what makes a hold a lease rather than a leak.",
      capacity:[
        ["Scan cadence","every ~1-5s","tight enough to reclaim promptly"],
        ["Expiries handled","~1000s/s","proportional to abandoned checkouts"],
        ["Reclaim window","hold TTL + a few s","stock returns shortly after abandonment"],
      ],
      data:"Owns no truth — it reads the <code>reservations</code> table's index on <code>(status, expires_at)</code>, and for each expired hold performs the release as an atomic, idempotent transaction against the inventory store + ledger.",
      scaling:[
        "Index reservations on <code>(status='held', expires_at)</code> so the due-scan is a bounded range read, not a table scan.",
        "Release with an <strong>atomic conditional flip</strong> (<code>held -> released</code> only if still held) so it can never race a real commit into a double-release.",
        "Partition the scan by shard and run it under a coordinator lease so multiple reaper instances don't fight over the same holds.",
      ],
      failures:[
        {t:"Reaper is down for an hour",b:"Expired holds pile up; popular SKUs look sold out though carts were abandoned.",m:"Reaper is stateless and idempotent — on restart it sweeps all overdue holds. Alert on oldest-unreaped-hold age so an outage is visible fast."},
        {t:"Reaper releases a hold that just committed",b:"Stock double-counted — released and shipped.",m:"The release is conditional on <code>status='held'</code>; a hold that flipped to <code>committed</code> is skipped. Commit and release can't both win."},
      ],
      tradeoffs:[
        {a:"Lazy release (on next read)",b:"Active reaper sweep",pick:"Lazy release avoids a background job but leaves stock locked until someone happens to touch the row; an active reaper reclaims promptly and predictably, which matters for hot SKUs where locked units are lost sales."},
      ],
      probes:[
        "An abandoned checkout holds the last unit — how and when does that unit come back?",
        "The reaper and a real order commit race on the same hold — how do you avoid double-releasing?",
        "How do you find expired holds without scanning the whole reservations table?",
      ],
    },
    replenish:{
      role:"The inbound + adjustment path. It applies <strong>receipts</strong> (a shipment arrives at an FC, on_hand goes up), <strong>returns</strong> (units come back), and <strong>corrections</strong> from cycle counts (physical audit vs system) — each as an atomic increment plus a ledger event, so the count reflects the real warehouse.",
      capacity:[
        ["Receipts","bursty","truckloads land at FCs on a schedule"],
        ["Adjustments","steady trickle","returns, damage, found/lost during counts"],
        ["Idempotency","per receipt_id","re-processing a receipt must not double-add"],
      ],
      data:"Owns <code>inbound_receipts</code> (receipt_id, sku, fc, qty, supplier, status, received_at). Applying a receipt is an atomic <code>on_hand += qty</code> on the <code>(sku, fc)</code> row plus a <code>receipt</code> movement event — idempotent on receipt_id.",
      scaling:[
        "Idempotent on <code>receipt_id</code> so a redelivered inbound message doesn't inflate stock.",
        "Batch receipts per <code>(sku, fc)</code> so a large truckload is a few big increments, not thousands of tiny ones.",
        "Route corrections through the same ledger so a cycle-count fix is auditable, not a silent overwrite.",
      ],
      failures:[
        {t:"A receipt event is delivered twice",b:"Stock is inflated — the platform thinks it has units it doesn't.",m:"Apply receipts idempotently keyed on receipt_id; a duplicate is a no-op verified against the ledger."},
        {t:"Physical count disagrees with the system",b:"Silent oversell or dead stock.",m:"Cycle-count adjustments write a signed <code>adjust</code> movement (with reason) rather than blind-setting the count, so the discrepancy is recorded and reconciled, not hidden."},
      ],
      tradeoffs:[
        {a:"Set absolute count",b:"Apply signed delta",pick:"Setting an absolute value is easy but races concurrent reserves and erases history; applying an auditable signed delta (with reason) composes with in-flight decrements and keeps the ledger truthful."},
      ],
      probes:[
        "A truckload arrives — how does that stock enter the system without racing live reserves?",
        "An inbound message is redelivered — how do you avoid double-counting the shipment?",
        "A physical cycle count disagrees with the system — how do you correct it safely?",
      ],
    },
  },
  dbDoc:{
    component:"Inventory store",
    load:"The workload is <strong>write-correctness under contention</strong>, not bytes. ~100M SKUs across ~1,000 FCs is a few hundred million small <code>(sku,fc)</code> rows (~hundreds of GB). Steady writes ~30-50K/s (each reserve/commit/release is a multi-step transition), but a flash sale drives ~<strong>100K/s onto a single SKU</strong>. Every reserve must be an <strong>atomic single-row conditional decrement</strong> (subtract only if <code>available &ge; qty</code>) or two buyers oversell the last unit. Reads split: exact-count reads on the write path, and a ~1M/s availability firehose that is offloaded to cache/replicas.",
    candidates:[
      {name:"PostgreSQL / NewSQL (CockroachDB, Spanner)",ceiling:"~5-10K writes/s per primary; NewSQL adds nodes for more",nodes:"data fits easily; shard by sku_id so reserves are single-shard and spread ~50K writes/s across a handful of nodes",pick:true,note:"chosen &mdash; a single-row conditional <code>UPDATE ... WHERE available &ge; qty</code> gives the no-oversell guarantee natively with strong consistency and row-level locking, and multi-row commit/release fits ACID transactions. NewSQL variants scale writes horizontally without hand-sharding. Hot SKUs handled by sub-counter rows."},
      {name:"Cassandra / ScyllaDB (wide-column)",ceiling:"~10-50K raw writes/s per node, but LWT collapses it",nodes:"throughput-fine on paper, but every safe decrement needs a lightweight transaction",pick:false,note:"the atomic no-oversell decrement requires a <strong>LWT (Paxos)</strong> &mdash; ~4 round trips per reserve, cutting effective throughput to ~1-2K claims/s per partition, and a hot SKU is one partition. Last-write-wins is actively dangerous here: a lost update <em>is</em> an oversell. Wrong fit for a contended compare-and-set workload."},
      {name:"Redis (in-memory counters)",ceiling:"~100K+ ops/s per node; atomic DECR is trivial",nodes:"blazing for the counter, but it's a cache, not a book of record",pick:false,note:"a great <strong>front-line decrement</strong> for hot SKUs (atomic <code>DECRBY</code> with a floor via Lua), but on its own it isn't durable/auditable &mdash; a node loss can drop committed decrements (oversell or lost sales). Use it as a write-through hot-SKU accelerator backed by the durable store, not as the source of truth."},
    ],
    indexing:"Primary key is <code>(sku_id, fc_id)</code> so a reserve is a direct single-row point write &mdash; no scan. Availability rollups (sum across a SKU's FCs) are maintained in cache via CDC rather than a live cross-shard aggregate. The <code>reservations</code> table carries an index on <code>(status, expires_at)</code> so the reaper's due-scan for expired holds is a bounded range read, and a unique index on <code>idempotency_key</code> so retried reserves can't double-hold. Hot SKUs get <code>(sku_id, fc_id, bucket)</code> sub-counter rows so contention spreads across K keys.",
    decision:"Pick a <strong>strongly-consistent relational / NewSQL store</strong> (Postgres sharded by sku_id, or CockroachDB/Spanner for horizontal write-scale), optionally fronted by <strong>Redis for the hottest SKUs</strong>. The deciding factor is the <strong>atomic conditional decrement</strong> that prevents oversell &mdash; relational engines do it natively with row locks and ACID; Cassandra's per-decrement LWT tax throttles the contended path and LWW risks silent oversell. Storage is trivial; the access pattern (compare-and-set on a hot row + a 100:1 read offload) picks the database.",
  },
  schema:{tables:[
    {name:"inventory",pk:"(sku_id, fc_id)",columns:[
      ["sku_id","bigint","product SKU (shard key)"],
      ["fc_id","int","fulfillment center"],
      ["on_hand","int","physical units in the FC"],
      ["reserved","int","units held for in-flight checkouts"],
      ["available","int","generated: on_hand - reserved (the decrementable count)"],
      ["version","bigint","optimistic-concurrency token"],
      ["updated_at","timestamptz","last movement"],
    ],rows:[
      ["88021","7","120","4","116","1902","2026-07-26 12:00:03"],
      ["88021","12","40","40","0","880","2026-07-26 12:00:09"],
      ["73310","7","5","2","3","233","2026-07-26 11:58:40"],
    ]},
    {name:"reservations",pk:"reservation_id",columns:[
      ["reservation_id","uuid","primary key"],
      ["sku_id","bigint","reserved SKU (indexed)"],
      ["fc_id","int","fulfillment center the units are held in"],
      ["order_id","bigint NULL","set when the hold is committed"],
      ["qty","int","units held"],
      ["status","varchar(12)","held / committed / released / expired"],
      ["expires_at","timestamptz","hold deadline (indexed with status)"],
      ["idempotency_key","varchar(80)","unique — dedups retried reserves"],
      ["created_at","timestamptz","hold start"],
    ],rows:[
      ["a91f...","88021","7","(null)","1","held","2026-07-26 12:14:00","cart-42-line-1","2026-07-26 12:00:03"],
      ["b3c2...","88021","7","500431","2","committed","2026-07-26 12:05:11","cart-19-line-2","2026-07-26 11:52:11"],
      ["c7d8...","73310","7","(null)","1","expired","2026-07-26 11:40:00","cart-08-line-1","2026-07-26 11:25:00"],
    ]},
    {name:"stock_movements",pk:"movement_id",columns:[
      ["movement_id","bigint","primary key (monotonic)"],
      ["sku_id","bigint","which SKU (log partition key)"],
      ["fc_id","int","fulfillment center"],
      ["type","varchar(10)","receipt / reserve / release / commit / adjust"],
      ["qty_delta","int","signed change to on_hand or reserved"],
      ["reason","varchar(40)","e.g. checkout, abandon, return, cycle_count"],
      ["ref_id","varchar(64)","order / reservation / receipt id"],
      ["created_at","timestamptz","event time"],
    ],rows:[
      ["9000123","88021","7","reserve","+1 reserved","checkout","a91f...","2026-07-26 12:00:03"],
      ["9000124","73310","7","release","-1 reserved","abandon","c7d8...","2026-07-26 11:40:00"],
      ["9000125","88021","7","receipt","+50 on_hand","inbound","rcpt-7781","2026-07-26 09:10:00"],
    ]},
    {name:"inbound_receipts",pk:"receipt_id",columns:[
      ["receipt_id","varchar(64)","primary key (idempotency)"],
      ["sku_id","bigint","received SKU"],
      ["fc_id","int","destination fulfillment center"],
      ["qty","int","units received"],
      ["supplier","varchar(40)","source"],
      ["status","varchar(12)","pending / applied"],
      ["received_at","timestamptz","dock scan time"],
    ],rows:[
      ["rcpt-7781","88021","7","50","acme-dist","applied","2026-07-26 09:10:00"],
      ["rcpt-7782","73310","7","200","acme-dist","pending","2026-07-26 12:20:00"],
    ]},
  ]},
  flows:[
    {id:"reserve",name:"Reserve at checkout",steps:[
      {node:"client",text:"Customer starts checkout; client sends <code>POST /reserve</code> with the SKU, qty, and an <strong>idempotency key</strong> (the cart line)."},
      {node:"api",text:"Inventory API authenticates, resolves the fulfillment center, and routes to the shard that owns this <code>sku_id</code>."},
      {node:"holds",text:"Reservation service dedups on the idempotency key, then attempts the hold."},
      {node:"invdb",text:"One atomic conditional decrement moves a unit <code>available &rarr; reserved</code> — only if <code>available &ge; qty</code>, so the last unit can't be double-sold."},
      {node:"ledger",text:"A <code>reserve</code> movement event is appended in the same transaction; CDC later refreshes the availability cache."},
      {node:"client",text:"Returns a <code>reservation_id</code> with a TTL; the customer proceeds to payment."},
    ]},
    {id:"availability",name:"Check availability",steps:[
      {node:"client",text:"Product page requests availability for a SKU."},
      {node:"api",text:"API serves a coarse in-stock/available value."},
      {node:"cache",text:"Availability cache answers the ~1M/s read from a rolled-up, slightly-stale entry — the store never sees the firehose."},
      {node:"invdb",requires:["invdb"],text:"On a cache miss, a single read (via replica) fills the entry; single-flight stops a hot-key stampede."},
    ]},
    {id:"restock",name:"Replenish stock",steps:[
      {node:"replenish",requires:["replenish"],text:"A shipment is received at an FC; apply the receipt idempotently on <code>receipt_id</code>."},
      {node:"invdb",text:"Atomic <code>on_hand += qty</code> on the <code>(sku, fc)</code> row."},
      {node:"ledger",text:"A <code>receipt</code> movement event is appended for audit and to refresh availability."},
    ]},
  ],
  deepFlows:[
    {id:"reserve-e2e",name:"Reserve a unit at checkout (no oversell, end-to-end)",summary:"Follow one checkout from the client through shard routing, the idempotent hold, the atomic conditional decrement that actually prevents oversell, and the ledger event that refreshes the cache. This is the correctness-critical path.",steps:[
      {node:"client",title:"Checkout fires a reserve",snap:{cap:"Intent only: the client asks to reserve <strong>SKU 88021</strong> qty 1 for cart line <code>cart-42-line-1</code>. No table has changed yet; the idempotency key is the future dedup handle.",tables:[{name:"inventory (shard hash(88021), before reserve)",note:"actual row that will be guarded by the DB predicate",cols:["sku_id","fc_id","on_hand","reserved","available","version"],rows:[{c:["88021","7","120","4","116","1902"],hi:1,tag:"target row"},{c:["88021","12","40","40","0","880"]}]},{name:"reservations",cols:["reservation_id","sku_id","fc_id","qty","status","idempotency_key"],rows:[{c:["<em>not allocated yet</em>","88021","7","1","—","cart-42-line-1"],hi:1,tag:"request"}]}]},narrate:"The customer clicks Buy on SKU 88021, qty 1. The client sends a reserve carrying an idempotency key derived from the cart line, so any retry is safe.",details:[
        {k:"wire",label:"Request",lang:"http",code:"POST /v1/reserve\n{\n  \"sku_id\": 88021,\n  \"qty\": 1,\n  \"region\": \"us-east\",\n  \"idempotency_key\": \"cart-42-line-1\"\n}"},
        {k:"note",label:"Why the key matters",text:"The idempotency key is **client-generated once per cart line**. If the response is lost and the client retries, the server must return the *same* hold — not create a second one. This single field is what makes the whole path retry-safe."},
      ]},
      {node:"api",from:"client",title:"API routes by sku_id to a shard + FC",snap:{cap:"The API chooses <strong>FC 7</strong> for us-east and routes to the shard owning <code>sku_id=88021</code>. This is still a read/routing step — the no-oversell mutation has not happened.",tables:[{name:"routing decision",cols:["sku_id","region","chosen_fc_id","store_shard"],rows:[{c:["88021","us-east","7","hash(88021) shard"],hi:1,tag:"routed"}]},{name:"inventory (chosen shard)",cols:["sku_id","fc_id","on_hand","reserved","available"],rows:[{c:["88021","7","120","4","116"],hi:1,tag:"will update"},{c:["88021","12","40","40","0"]}]}]},narrate:"The stateless API authenticates, picks the fulfillment center that should serve this region's demand, and hashes sku_id to find the store shard. The reserve becomes a single-shard operation.",details:[
        {k:"route",label:"Shard selection",text:"`shard = hash(sku_id) % N_shards`. Sharding by **sku_id** (not fc_id) means every operation for one SKU — reserve, commit, availability — lands on the same shard, so a reserve is a single-shard, single-row transaction. No cross-shard coordination."},
        {k:"route",label:"FC selection",text:"The API chooses `fc_id = 7` (nearest FC with stock for us-east). Per-FC rows naturally split a SKU's demand across warehouses, so no single row absorbs the entire flash-sale load."},
        {k:"gotcha",label:"Don't read-then-decide here",text:"A tempting bug: read `available`, check `>= qty` in the app, then write. Under concurrency two requests both read `1` and both proceed — **oversell**. The API must delegate the check to an atomic DB conditional, never decide in application code."},
      ]},
      {node:"holds",from:"api",title:"Reservation service dedups, then opens a hold",snap:{cap:"The idempotency key is claimed and one <strong>held</strong> reservation row is opened with a 15-minute lease. Inventory is intentionally unchanged until the guarded decrement wins.",tables:[{name:"reservations",note:"unique(idempotency_key) makes retries return this same row",cols:["reservation_id","sku_id","fc_id","qty","status","expires_at","idempotency_key"],rows:[{c:["a91f...","88021","7","1","held","2026-07-26 12:14:00","cart-42-line-1"],hi:1,tag:"inserted"},{c:["b3c2...","88021","7","2","committed","2026-07-26 12:05:11","cart-19-line-2"]}]},{name:"inventory (unchanged before CAS)",cols:["sku_id","fc_id","on_hand","reserved","available"],rows:[{c:["88021","7","120","4","116"],hi:1,tag:"not yet decremented"}]}]},narrate:"The reservation service first tries to claim the idempotency key. If this exact cart line already has a hold, it returns it verbatim; otherwise it proceeds to the atomic decrement.",details:[
        {k:"query",label:"Idempotent insert (dedup)",lang:"sql",code:"INSERT INTO reservations\n  (reservation_id, sku_id, fc_id, qty, status, expires_at, idempotency_key, created_at)\nVALUES\n  (gen_random_uuid(), 88021, 7, 1, 'held', now() + interval '15 min', 'cart-42-line-1', now())\nON CONFLICT (idempotency_key) DO NOTHING\nRETURNING reservation_id;"},
        {k:"note",label:"Retry returns the same hold",text:"If `ON CONFLICT ... DO NOTHING` returns no row, the key already exists: the service `SELECT`s the existing `reservation_id` and returns it. A double-clicked or network-retried reserve therefore yields **exactly one** hold. The unique index on `idempotency_key` is the enforcement point."},
      ]},
      {node:"invdb",from:"holds",title:"The atomic conditional decrement — the no-oversell guarantee",snap:{cap:"This is the money step: <code>UPDATE inventory ... WHERE available &ge; 1</code> serializes buyers on one row. FC 7 moves <strong>reserved 4&rarr;5</strong> and <strong>available 116&rarr;115</strong>; if available were 0, rows affected would be 0.",tables:[{name:"inventory (shard hash(88021), FC 7)",note:"highlighted row changed by the atomic conditional decrement",cols:["sku_id","fc_id","on_hand","reserved","available","version"],rows:[{c:["88021","7","120","5","115","1903"],hi:1,tag:"available&rarr;reserved"},{c:["88021","12","40","40","0","880"]}]},{name:"reservations",cols:["reservation_id","sku_id","fc_id","qty","status"],rows:[{c:["a91f...","88021","7","1","held"],hi:1,tag:"backed by stock"}]}]},narrate:"This is the heart of the system. One statement moves a unit from available to reserved, but only if enough is available. The database serializes concurrent attempts on the row; exactly one wins the last unit.",details:[
        {k:"query",label:"Conditional decrement",lang:"sql",code:"UPDATE inventory\n   SET reserved = reserved + 1,\n       version  = version + 1,\n       updated_at = now()\n WHERE sku_id = 88021\n   AND fc_id  = 7\n   AND available >= 1;      -- available = on_hand - reserved\n-- rows affected: 1 = success, 0 = insufficient stock"},
        {k:"repl",label:"Durability of the commit",text:"The commit is **quorum-replicated**: the leader waits for at least one follower to ack the WAL before returning success. If the leader dies immediately after, a promoted replica still has this decrement — a reserved unit never silently reappears. Replication here is **synchronous (quorum)** precisely because losing a committed decrement means overselling."},
        {k:"gotcha",label:"0 rows updated = out of stock",text:"If `available >= 1` fails, the `UPDATE` touches **0 rows**. The service reads rows-affected, marks the reservation `released` (or never inserts it), and returns `409`. No exception, no oversell — the `WHERE` clause *is* the concurrency guard."},
      ]},
      {node:"ledger",from:"invdb",title:"Append the movement event (same transaction)",snap:{cap:"The audit row is appended in the <strong>same transaction</strong> as the inventory update. The ledger now explains why reserved rose to 5; cache refresh can lag without risking oversell.",tables:[{name:"inventory",cols:["sku_id","fc_id","on_hand","reserved","available","version"],rows:[{c:["88021","7","120","5","115","1903"],hi:1}]},{name:"stock_movements",note:"append-only movement ledger",cols:["movement_id","sku_id","fc_id","type","qty_delta","reason","ref_id"],rows:[{c:["9000126","88021","7","reserve","+1 reserved","checkout","a91f..."],hi:1,tag:"appended"},{c:["9000125","88021","7","receipt","+50 on_hand","inbound","rcpt-7781"]}]}]},narrate:"In the same transaction as the decrement, a reserve movement is written to the ledger via the outbox, so the book of record and the live count can never disagree.",details:[
        {k:"query",label:"Outbox movement row",lang:"sql",code:"INSERT INTO stock_movements\n  (sku_id, fc_id, type, qty_delta, reason, ref_id, created_at)\nVALUES\n  (88021, 7, 'reserve', 1, 'checkout', 'a91f-...', now());\n-- committed atomically with the UPDATE above"},
        {k:"repl",label:"CDC refreshes the cache",text:"A relay tails committed movement rows and publishes to a Kafka topic partitioned by `sku_id`. The availability-cache consumer folds the event and updates SKU 88021's rolled-up count — **asynchronously**, so the hot decrement path never waits on the cache. The badge lags by sub-second, which is fine."},
      ]},
      {node:"client",from:"api",title:"Hold confirmed — customer pays against a lease",snap:{cap:"The client receives a lease, not a sale. The stock remains <strong>reserved</strong> until payment commits; if the TTL passes first, the reaper can safely release it.",tables:[{name:"reservations",cols:["reservation_id","sku_id","fc_id","order_id","qty","status","expires_at"],rows:[{c:["a91f...","88021","7","(null)","1","held","2026-07-26 12:14:00"],hi:1,tag:"lease returned"}]},{name:"inventory",cols:["sku_id","fc_id","on_hand","reserved","available"],rows:[{c:["88021","7","120","5","115"],hi:1}]}]},narrate:"The API returns the reservation id and its expiry. The unit is now safely held; if the customer doesn't pay within the TTL, the reaper reclaims it.",details:[
        {k:"wire",label:"Response",lang:"json",code:"200 OK\n{\n  \"reservation_id\": \"a91f-...\",\n  \"status\": \"held\",\n  \"expires_at\": \"2026-07-26T12:14:00Z\"\n}"},
        {k:"note",label:"A hold is a lease, not forever",text:"The `expires_at` makes the hold a **time-limited lease**. This is what lets the system reserve aggressively (protecting the buyer) without permanently locking stock for abandoned carts — the reaper flow reclaims anything that expires."},
      ]},
    ]},
    {id:"availability-e2e",name:"Read availability under 1M/s (cache, staleness, rollup)",summary:"Trace a product-page availability read. See why it's served coarse and slightly stale from cache, how a miss is filled without stampeding the store, and why a rollup across fulfillment centers is the right unit of truth for the badge.",steps:[
      {node:"client",title:"Product page asks: is 88021 in stock?",snap:{cap:"A read-only request starts. The badge is advisory, so no mutation happens and the authoritative row can remain protected for checkout writes.",tables:[{name:"availability request",cols:["sku_id","region","need","mutation?"],rows:[{c:["88021","us-east","coarse in-stock badge","no"],hi:1,tag:"read"}]},{name:"inventory (truth, not read yet)",cols:["sku_id","fc_id","on_hand","reserved","available"],rows:[{c:["88021","7","120","5","115"]},{c:["88021","12","40","40","0"]}]}]},narrate:"Millions of shoppers view popular products. The client asks for availability, but it only needs a badge — 'In stock' / 'Only a few left' / 'Out of stock' — not a live exact count.",details:[
        {k:"wire",label:"Request",lang:"http",code:"GET /v1/availability?sku_id=88021&region=us-east"},
        {k:"note",label:"Coarse by design",text:"Rendering an **exact live count** on a hot SKU would force a fresh authoritative read on every page view — millions of reads onto one row. A coarse badge can be served stale from cache and is what the shopper actually needs. Exact counts are reserved for the low-stock nudge (\"3 left\")."},
      ]},
      {node:"api",from:"client",title:"API sends the read to the cache tier, not the store",snap:{cap:"The API deliberately sends availability to Redis first. This is a read-only path: stale is acceptable here, while reserves still go to the write primary.",tables:[{name:"read routing",cols:["sku_id","path","serves","mutation?"],rows:[{c:["88021","cache first","product badge","no"],hi:1,tag:"cache route"},{c:["88021","write primary","reserve/commit","yes"]}]},{name:"availability cache key",cols:["key","state"],rows:[{c:["avail:88021:us-east","lookup pending"],hi:1}]}]},narrate:"The API routes availability reads to Redis. The correctness-critical store is deliberately kept off the read firehose.",details:[
        {k:"route",label:"Read/write path split",text:"Reserves and commits go to the **write primary**; availability goes to **cache first, replica on miss**. This split is what lets availability be highly-available and fast (stale-tolerant) while the decrement stays strongly consistent. The two paths have opposite consistency needs."},
      ]},
      {node:"cache",from:"api",title:"Cache hit: answer from a rolled-up entry",snap:{cap:"Cache hit: Redis returns a rolled-up regional count, so the store sees zero traffic. This is a read of derived state, not a mutation; the highlighted cache row is the answer.",tables:[{name:"availability_cache (Redis)",note:"derived from movement CDC",cols:["sku_id","region","available","in_stock","bucket","updated_at"],rows:[{c:["88021","us-east","115","true","in_stock","12:00:04"],hi:1,tag:"hit"},{c:["73310","us-east","3","true","low","11:58:41"]}]},{name:"inventory (not touched)",cols:["sku_id","fc_id","available"],rows:[{c:["88021","7","115"]},{c:["88021","12","0"]}]}]},narrate:"Redis holds a per-SKU rollup — the sum of available across that SKU's fulfillment centers — plus an in-stock boolean. The ~1M/s firehose is absorbed here.",details:[
        {k:"query",label:"Cache lookup",lang:"redis",code:"GET avail:88021:us-east\n-> { \"available\": 214, \"in_stock\": true, \"bucket\": \"in_stock\", \"ts\": 1750000000 }"},
        {k:"note",label:"Rollup across FCs",text:"The badge answers \"can this region get one?\", which is the **sum across FCs that serve us-east**, not a single row. The rollup is maintained by the CDC consumer folding movement events, so reading it is O(1) and never touches the store."},
        {k:"gotcha",label:"Stale is acceptable here",text:"The entry may lag reality by a beat — a unit could sell out between refreshes. That's fine: the badge is **advisory**. The reserve's atomic decrement is the real guard, and it flips the SKU to out-of-stock the instant a reserve returns insufficient."},
      ]},
      {node:"invdb",from:"api",title:"Cache miss: single-flight fill from a replica",snap:{cap:"Cache miss branch: one single-flight filler reads a replica and writes the cache; other shoppers wait on that fill. Still no mutation to inventory.",tables:[{name:"inventory replica (read-only fill)",cols:["sku_id","fc_id","available","replica_lag"],rows:[{c:["88021","7","115","<1s"],hi:1,tag:"read"},{c:["88021","12","0","<1s"]}]},{name:"availability_cache (after fill)",cols:["sku_id","region","available","in_stock","updated_at"],rows:[{c:["88021","us-east","115","true","12:00:05"],hi:1,tag:"filled"}]}]},narrate:"If the entry is cold (evicted, or a newly-viral SKU), exactly one filler reads the count — from a read replica, not the primary — and repopulates the cache. Everyone else waits on that single fill.",details:[
        {k:"query",label:"Rollup read (replica)",lang:"sql",code:"SELECT SUM(available) AS available\n  FROM inventory\n WHERE sku_id = 88021\n   AND fc_id IN (7, 12, 15);   -- FCs serving us-east\n-- served by a read replica; eventual consistency is OK for the badge"},
        {k:"gotcha",label:"Single-flight stops the stampede",text:"A viral SKU whose cache key just expired could send a **thundering herd** of misses to the store. Guard with per-key single-flight (one fill in progress, others coalesce onto it) + jittered TTL + a short negative cache for out-of-stock. The store sees one read, not a million."},
        {k:"repl",label:"Why replica, not primary",text:"The primary is reserved for the write path. Serving fills from **read replicas** keeps the availability path from stealing capacity the decrement needs. The slight replica lag is invisible against a badge that's already allowed to be stale."},
      ]},
    ]},
    {id:"commit-release-e2e",name:"Commit on payment vs release on expiry (the lease resolves)",summary:"A held unit ends one of two ways: the order is paid (commit — reserved becomes a real deduction) or the checkout is abandoned (the reaper releases it back to available). Both are atomic and conditional so they can never both win.",steps:[
      {node:"client",title:"Payment succeeds — commit the hold",snap:{cap:"The lease resolution starts: order <code>500431</code> asks to commit reservation <code>a91f...</code>. At this moment the hold is still live and backed by reserved stock.",tables:[{name:"reservations",cols:["reservation_id","sku_id","fc_id","order_id","qty","status"],rows:[{c:["a91f...","88021","7","(null)","1","held"],hi:1,tag:"commit requested"}]},{name:"inventory (before commit)",cols:["sku_id","fc_id","on_hand","reserved","available"],rows:[{c:["88021","7","120","5","115"],hi:1}]}]},narrate:"The customer pays. The order service tells inventory to commit reservation a91f: the held unit becomes a permanent deduction tied to the order.",details:[
        {k:"wire",label:"Request",lang:"http",code:"POST /v1/commit\n{ \"reservation_id\": \"a91f-...\", \"order_id\": 500431 }"},
      ]},
      {node:"invdb",from:"client",title:"Commit: reserved becomes on_hand deduction (atomic + conditional)",snap:{cap:"Commit wins the <code>status='held'</code> guard. The unit leaves physical stock: <strong>on_hand 120&rarr;119</strong> and <strong>reserved 5&rarr;4</strong>; <code>available</code> stays 115 because the unit was already unavailable while held.",tables:[{name:"reservations",cols:["reservation_id","order_id","qty","status"],rows:[{c:["a91f...","500431","1","committed"],hi:1,tag:"held&rarr;committed"}]},{name:"inventory",cols:["sku_id","fc_id","on_hand","reserved","available","version"],rows:[{c:["88021","7","119","4","115","1904"],hi:1,tag:"commit applied"}]},{name:"stock_movements",cols:["movement_id","sku_id","fc_id","type","qty_delta","ref_id"],rows:[{c:["9000127","88021","7","commit","-1 on_hand, -1 reserved","500431"],hi:1,tag:"appended"}]}]},narrate:"Committing consumes the reservation: on_hand drops by the held qty and reserved drops too, so available is unchanged (the unit was already subtracted from available when held). It only applies if the hold is still 'held'.",details:[
        {k:"query",label:"Conditional commit",lang:"sql",code:"WITH r AS (\n  UPDATE reservations\n     SET status = 'committed', order_id = 500431\n   WHERE reservation_id = 'a91f-...'\n     AND status = 'held'            -- only a live hold can commit\n  RETURNING sku_id, fc_id, qty\n)\nUPDATE inventory i\n   SET on_hand  = i.on_hand  - r.qty,\n       reserved = i.reserved - r.qty,\n       version  = i.version + 1\n  FROM r\n WHERE i.sku_id = r.sku_id AND i.fc_id = r.fc_id;"},
        {k:"note",label:"Available doesn't move on commit",text:"When the unit was **held**, `reserved` went up so `available` already dropped. Commit converts a reservation into a real removal: `on_hand` and `reserved` both fall by qty, leaving `available = on_hand - reserved` unchanged. The customer's unit was protected the whole time."},
        {k:"repl",label:"Ledger commit event",text:"A `commit` movement (`ref_id = order 500431`) is appended in the same transaction. Folding the ledger for this SKU now reconstructs exactly the on_hand the row shows — recon passes."},
      ]},
      {node:"reaper",from:"invdb",title:"Alternate ending: checkout abandoned, hold expires",snap:{cap:"Alternate branch for a different hold: <code>c7d8...</code> is still <strong>held</strong> after its deadline, so the reaper selects it by the <code>(status, expires_at)</code> index. No inventory mutation yet.",tables:[{name:"reservations (expiry scan)",note:"bounded range read on status + expires_at",cols:["reservation_id","sku_id","fc_id","qty","status","expires_at"],rows:[{c:["c7d8...","73310","7","1","held","2026-07-26 11:40:00"],hi:1,tag:"expired candidate"},{c:["a91f...","88021","7","1","committed","2026-07-26 12:14:00"]}]},{name:"inventory (before release)",cols:["sku_id","fc_id","on_hand","reserved","available"],rows:[{c:["73310","7","5","2","3"],hi:1}]}]},narrate:"If the customer never pays, the hold's expires_at passes. The reaper sweeps due holds and releases them — this is the branch that stops abandoned carts from looking like stock-outs.",details:[
        {k:"query",label:"Find expired holds (bounded scan)",lang:"sql",code:"SELECT reservation_id, sku_id, fc_id, qty\n  FROM reservations\n WHERE status = 'held'\n   AND expires_at < now()\n ORDER BY expires_at\n LIMIT 500;                   -- uses index on (status, expires_at)"},
        {k:"note",label:"Runs every 1-5s",text:"The reaper scans on a tight cadence using the `(status, expires_at)` index, so reclaim is a **bounded range read**, never a full-table scan. Locked-but-abandoned units come back within seconds of expiry — critical for hot SKUs where a stuck hold is a lost sale."},
      ]},
      {node:"invdb",from:"reaper",title:"Release: reserved returns to available (conditional, race-safe)",snap:{cap:"Release wins only if the reservation is still <code>held</code>. For SKU 73310, <strong>reserved 2&rarr;1</strong> and <strong>available 3&rarr;4</strong>; a concurrent commit would make this update affect 0 rows.",tables:[{name:"reservations",cols:["reservation_id","sku_id","fc_id","qty","status"],rows:[{c:["c7d8...","73310","7","1","expired"],hi:1,tag:"held&rarr;expired"}]},{name:"inventory",cols:["sku_id","fc_id","on_hand","reserved","available","version"],rows:[{c:["73310","7","5","1","4","234"],hi:1,tag:"released"}]},{name:"stock_movements",cols:["movement_id","sku_id","fc_id","type","qty_delta","reason","ref_id"],rows:[{c:["9000128","73310","7","release","-1 reserved","abandon","c7d8..."],hi:1,tag:"appended"}]}]},narrate:"For each expired hold, the reaper flips it to released and gives the units back — but only if it's still 'held', so it can never fight a commit that just landed.",details:[
        {k:"query",label:"Conditional release",lang:"sql",code:"WITH r AS (\n  UPDATE reservations\n     SET status = 'expired'\n   WHERE reservation_id = 'c7d8-...'\n     AND status = 'held'            -- lose the race to a commit safely\n  RETURNING sku_id, fc_id, qty\n)\nUPDATE inventory i\n   SET reserved = i.reserved - r.qty,   -- available rises back\n       version  = i.version + 1\n  FROM r\n WHERE i.sku_id = r.sku_id AND i.fc_id = r.fc_id;"},
        {k:"gotcha",label:"Commit and release can't both win",text:"Both the commit and the reaper's release guard on `status = 'held'` and flip it in the same statement. Whichever runs first flips the status; the other's `WHERE` matches **0 rows** and no-ops. The unit is therefore either committed *or* released — never double-counted."},
        {k:"repl",label:"Release movement + cache refresh",text:"A `release` movement (`reason = abandon`) is appended; CDC refreshes availability so the reclaimed unit reappears in the badge within a beat. The lease is fully resolved and auditable."},
      ]},
    ]},
  ],
  requirements:{
    functional:[
      "Track on-hand stock per SKU per fulfillment center; expose availability to the storefront.",
      "Reserve units at checkout with a time-limited hold; commit on order placement; release on cancel or timeout.",
      "Never oversell — never confirm more units than physically exist, even under extreme concurrency.",
      "Ingest replenishment (inbound receipts) and adjustments (returns, damage, cycle counts).",
      "Provide a durable, auditable trail of every unit movement for reconciliation.",
    ],
    nonFunctional:[
      "Strong consistency + idempotency on the decrement path (the no-oversell invariant); a retried reserve must not double-decrement.",
      "Availability reads (~1M/s, ~100:1 over writes) must be fast and highly available; slight staleness is acceptable.",
      "Survive a flash sale of ~100K/s reserves onto a single hot SKU without collapsing.",
      "Reserved stock must not leak — abandoned holds are reclaimed promptly (hold TTL ~15 min).",
      "Durability: a committed decrement survives a node loss (quorum replication).",
    ],
  },
  reqBuild:[
    {req:"Track stock and answer availability (the skeleton)",reveal:["client","api","invdb"],turns:[
      {who:"intv",text:"Start simple. I want to know how many units of a SKU we have and let a shopper see it. What's the minimum?"},
      {who:"cand",text:"Client &rarr; stateless Inventory API &rarr; an inventory store with one row per <code>(sku_id, fc_id)</code> holding <code>on_hand</code>, <code>reserved</code>, and a derived <code>available</code>. Availability is a read of that row; the API routes by <code>sku_id</code> so it's a single-shard point lookup."},
      {who:"intv",text:"Why per <code>(sku, fc)</code> and not just per SKU?"},
      {who:"cand",text:"Stock physically lives in fulfillment centers, and shipping/routing is per-FC. Per-FC rows also spread a SKU's demand across warehouses, so even before optimizing we've split load off any single row. The storefront badge is a rollup (sum across FCs)."},
    ],resources:[
      {title:"Inventory modeling patterns",url:"https://martinfowler.com/eaaCatalog/"},
    ]},
    {req:"Reserve without overselling",reveal:["holds"],turns:[
      {who:"intv",text:"Two customers click buy on the last unit at the same instant. Neither can lose a unit they paid for, and we can't sell two. How?"},
      {who:"cand",text:"Never read-then-write. A reserve is a single atomic conditional decrement: <code>UPDATE inventory SET reserved=reserved+1 WHERE available&ge;1</code>. The DB serializes the two attempts on the row — one updates 1 row, the other updates 0 and gets a 409. I front it with a reservation service that makes the reserve <strong>idempotent</strong> on the cart-line key, so a retry after a timeout returns the same hold instead of a second one."},
      {who:"intv",text:"Where does the reserved unit go if they don't finish paying?"},
      {who:"cand",text:"The hold has an <code>expires_at</code> — it's a lease. That sets up the reaper we'll add for reclaiming abandoned holds. Reserving moves <code>available &rarr; reserved</code>; committing on payment turns it into a real <code>on_hand</code> deduction."},
    ],resources:[
      {title:"Idempotency keys (Stripe)",url:"https://stripe.com/docs/api/idempotent_requests"},
    ]},
    {req:"Scale availability reads (100:1 read skew)",reveal:["cache"],turns:[
      {who:"intv",text:"Product-page views are ~1M/s — a hundred times the writes. You can't send that to the store."},
      {who:"cand",text:"Add a Redis availability tier keyed by <code>sku_id</code> holding a coarse rolled-up count + an in-stock boolean. It absorbs the firehose; the store only sees writes and cache-miss fills. I refresh it via CDC off the movement events rather than write-through, so the hot decrement path never waits on the cache."},
      {who:"intv",text:"Isn't it lying if the cache is stale?"},
      {who:"cand",text:"It's advisory. The badge can lag a beat; the atomic decrement is the real guard and flips the SKU out-of-stock the moment a reserve fails. I show coarse states (in-stock/low/out) so tiny count jitter doesn't churn the entry, and single-flight fills stop hot-key stampedes."},
    ],resources:[
      {title:"Caching strategies",url:"https://aws.amazon.com/caching/best-practices/"},
    ]},
    {req:"Audit, restock, and reclaim (make it operable)",reveal:["ledger","replenish","reaper"],turns:[
      {who:"intv",text:"Finance wants to reconcile stock, warehouses receive trucks, and abandoned carts are piling up. Round it out."},
      {who:"cand",text:"Three additions. A <strong>movement ledger</strong> — every change writes an append-only event in the same transaction (outbox), giving audit + recon + the CDC feed for the cache. A <strong>replenishment</strong> path applying receipts idempotently on <code>receipt_id</code> (<code>on_hand += qty</code> + a receipt event). And a <strong>reaper</strong> that sweeps holds where <code>status='held' AND expires_at&lt;now()</code> and releases them back to available."},
      {who:"intv",text:"How do you keep the reaper from releasing a hold that just committed?"},
      {who:"cand",text:"Both commit and release flip the reservation conditionally on <code>status='held'</code>. Whichever runs first wins; the other matches 0 rows and no-ops. So a unit is either committed or released, never double-counted — and both write a ledger event, so recon always reconstructs the true on_hand."},
    ],resources:[
      {title:"Transactional outbox pattern",url:"https://microservices.io/patterns/data/transactional-outbox.html"},
    ]},
  ],
  systemDives:[
    {title:"Overselling under concurrency",tag:"concept",turns:[
      {who:"intv",text:"Convince me you can't oversell the last unit when 50 requests hit it in the same millisecond."},
      {who:"cand",text:"<span class='scenario'><b>Scenario:</b> 50 concurrent reserves, <code>available=1</code>.</span> The guarantee is a single atomic statement: <code>UPDATE inventory SET reserved=reserved+1 WHERE sku_id=? AND fc_id=? AND available&ge;1</code>. The database takes a row lock, so the 50 updates are <strong>serialized</strong> on that row. The first sees <code>available&ge;1</code>, applies, and <code>available</code> becomes 0. The other 49 re-evaluate the predicate against the now-updated row, match 0 rows, and return insufficient. Exactly one unit sold."},
      {who:"intv",text:"Why not read the count, check in code, then write?"},
      {who:"cand",text:"That's a classic race: all 50 read <code>1</code> before anyone writes, all 50 think they can proceed, all 50 decrement &mdash; oversell by 49. The check and the write <strong>must be the same atomic operation</strong>. Application-level checks are only safe if backed by the DB predicate. If I needed a cross-row invariant I'd use a transaction with the same conditional, or optimistic concurrency on <code>version</code> and retry on conflict."},
    ],resources:[
      {title:"Isolation levels & lost updates",url:"https://www.postgresql.org/docs/current/transaction-iso.html"},
    ]},
    {title:"Hot SKU flash sale (single-row contention)",tag:"scaling",reveal:["cache"],turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a limited drop sends 100K reserves/s at one SKU in one FC. One row can't take 100K writes/s. Now what?</span>"},
      {who:"cand",text:"Two levers. First, <strong>shed and shape</strong> at the edge: a virtual waiting room / per-SKU admission so we only admit reserves at a rate the stock can satisfy — if there are 5,000 units, letting 100K/s through is pointless. Second, <strong>write-shard the hot row</strong>: split it into K sub-counter rows <code>(sku, fc, bucket)</code>, each holding a slice of the stock. A reserve hashes to a random bucket, so 100K/s spreads across K rows instead of contending on one. Availability sums the buckets."},
      {who:"intv",text:"What breaks with sub-counters?"},
      {who:"cand",text:"Skew: one bucket can hit zero while others have stock, so a reserve might get a false 'insufficient'. I mitigate by retrying against another bucket before failing, and by rebalancing when a bucket empties. Exact count now needs a fan-in sum, which is why the availability badge stays coarse and cached. I only apply sub-counters to the handful of SKUs that are actually hot — detected by write-rate — so the common case stays a simple single row."},
      {who:"intv",text:"Could you just use Redis <code>DECR</code> for the hot SKU?"},
      {who:"cand",text:"Yes, as a front-line accelerator: an atomic Redis counter with a Lua floor absorbs the burst, and I reconcile durably to the store asynchronously. The risk is durability — a Redis node loss can drop committed decrements — so I only use it in front of the authoritative store, with the ledger as the reconciliation backstop, never as the sole source of truth."},
    ],resources:[
      {title:"Sharded counters",url:"https://cloud.google.com/datastore/docs/concepts/sharded-counters"},
      {title:"Facebook memcache lease/stampede",url:"https://www.usenix.org/system/files/conference/nsdi13/nsdi13-final170_update.pdf"},
    ]},
    {title:"Reservation leak / reaper failure",tag:"failover",reveal:["reaper"],turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> the reaper is down for an hour during peak. What does the user see, and how bad is it?</span>"},
      {who:"cand",text:"Abandoned checkouts stop being reclaimed, so <code>reserved</code> climbs and <code>available</code> falls: popular SKUs start showing <strong>phantom stock-outs</strong> — units exist physically but are all 'held' by dead carts. It's not a correctness bug (we never oversell), it's a <strong>lost-sales</strong> bug. The reaper is stateless and idempotent, so on restart it sweeps every overdue hold and stock snaps back. Key is detection: I alert on <em>oldest-unreaped-hold age</em> and on reserved:on_hand ratio, so an hour-long outage pages long before it hurts."},
      {who:"intv",text:"How do you make the release itself safe if the reaper double-runs or overlaps a commit?"},
      {who:"cand",text:"The release is an atomic conditional flip: <code>UPDATE reservations SET status='expired' WHERE reservation_id=? AND status='held'</code>, and only if that touched a row do I return the units. Idempotent — a second reaper pass finds <code>status='expired'</code> and no-ops. And it can't fight a commit: whichever flips <code>held</code> first wins, the loser matches 0 rows. I also run reapers under a per-shard coordinator lease so instances don't all scan the same holds."},
    ],resources:[
      {title:"Leases & fencing tokens",url:"https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html"},
    ]},
    {title:"Ledger/store divergence & reconciliation",tag:"durability",reveal:["ledger"],turns:[
      {who:"intv",text:"How do you guarantee the audit ledger and the live count never disagree, and how do you fix it if they do?"},
      {who:"cand",text:"Never dual-write. The movement event is inserted in the <strong>same transaction</strong> as the count change (transactional outbox); a relay then publishes committed outbox rows to Kafka at-least-once, deduped on <code>movement_id</code>. So the store and the log commit atomically together — there's no window where one exists without the other."},
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a cycle count finds the shelf has 3 units but the system says 5. Reconcile it.</span>"},
      {who:"cand",text:"I don't blind-overwrite the count — that races live reserves and destroys history. I write a signed <code>adjust</code> movement of <code>-2</code> with <code>reason='cycle_count'</code> and a ref to the count session; applying it does an atomic <code>on_hand -= 2</code>. Now the discrepancy is auditable: folding the ledger reproduces the corrected on_hand, and finance can see exactly when and why stock changed. For continuous assurance I run a periodic recon job that folds the ledger per SKU and diffs against the materialized count, alerting on any drift."},
    ],resources:[
      {title:"Event sourcing / reconciliation",url:"https://martinfowler.com/eaaDev/EventSourcing.html"},
    ]},
    {title:"Capacity & storage sizing",tag:"capacity",turns:[
      {who:"intv",text:"Size it. Is this a storage problem or a throughput problem?"},
      {who:"cand",text:"<span class='scenario'><b>Scenario:</b> 100M SKUs, ~1,000 FCs, but each SKU is stocked in only a few FCs.</span> Say avg 5 FCs/SKU &rarr; ~500M inventory rows, each ~60 bytes &rarr; ~<strong>30 GB</strong>, tens of GB with indexes. That fits comfortably on a modest cluster — storage is a non-issue. The pressure is <strong>throughput and contention</strong>: ~1M/s availability reads (offloaded to cache) and ~30-50K/s multi-step writes, spiking to 100K/s on one row. So I size for write IOPS and hot-row handling, not disk."},
      {who:"intv",text:"How many store shards and cache nodes roughly?"},
      {who:"cand",text:"Writes: if a shard primary sustains ~5-10K write-txn/s, ~50K/s steady needs ~8-12 write shards, sharded by <code>sku_id</code> with headroom for the hot-SKU sub-counter fan-out. Cache: 1M/s of tiny reads is ~a handful of Redis nodes (100K+ ops/s each) — I'd run ~10-16 for headroom + replicas, sharded by <code>sku_id</code>. The ledger is ~50-100K events/s into Kafka partitioned by <code>sku_id</code>, retained hot for days and tiered to object storage for years of audit."},
    ],resources:[
      {title:"Back-of-envelope numbers",url:"https://github.com/donnemartin/system-design-primer#appendix"},
    ]},
  ],
  q:{
    client:[
      {l:"easy",tag:"concept",q:"What does the client actually send to reserve a unit, and why include an idempotency key?",turns:[
        {who:"cand",text:"A reserve with <code>sku_id</code>, <code>qty</code>, region, and a client-generated <strong>idempotency key</strong> (the cart line). The key lets the server dedup retries: if the response is lost and the client resends, the reservation service returns the existing hold instead of creating a second one."},
        {who:"intv",text:"Who generates the key and when?"},
        {who:"cand",text:"The client, once per cart line, before the first attempt — and it reuses the same value on every retry of that line. If the server generated it, a retry would get a new key and defeat the purpose."},
      ],resources:[{title:"Idempotency keys",url:"https://stripe.com/docs/api/idempotent_requests"}]},
      {l:"medium",tag:"concept",q:"The product page said 'in stock' but the reserve failed. Bug or expected?",turns:[
        {who:"cand",text:"Expected. Availability is served from a slightly-stale cache and is advisory; the unit can sell out between page-load and checkout. The atomic decrement is the source of truth, so a failed reserve just means someone got there first. I show a clean out-of-stock message and refresh the badge — I don't retry-storm the last unit."},
      ],resources:[]},
      {l:"hard",tag:"scaling",q:"With 100:1 read:write, how should the client render availability to avoid hammering the backend?",turns:[
        {who:"cand",text:"Coarse states — in-stock / only-a-few-left / out — served from cache, not exact live counts. Debounce and client-cache the badge so scrolling and keystrokes don't re-query, and only fetch a precise count for the low-stock nudge. This keeps the vast read majority on cache and off the authoritative row."},
        {who:"intv",text:"When would you show an exact number?"},
        {who:"cand",text:"Only for scarcity signals (\"3 left\") on low-stock items, where the count is small and the freshness genuinely drives conversion. Even then it's a bounded read, not per-view on a hot SKU."},
      ],resources:[]},
    ],
    api:[
      {l:"easy",tag:"concept",q:"Is the Inventory API stateful? How does it scale?",turns:[
        {who:"cand",text:"Stateless — auth, validate, route, and call the store/cache/reservation service. All durable state is in those backends, so I scale it horizontally behind a load balancer and size the fleet for cache-miss + write traffic rather than raw page views."},
      ],resources:[]},
      {l:"medium",tag:"concept",q:"How does the API decide which shard and which fulfillment center a reserve hits?",turns:[
        {who:"cand",text:"Shard by <code>sku_id</code>: <code>shard = hash(sku_id) % N</code>, so every op for a SKU — reserve, commit, availability — lands on one shard and a reserve is a single-shard, single-row transaction. FC selection is a routing decision: nearest FC with stock for the customer's region, which also spreads a SKU's demand across per-FC rows."},
        {who:"intv",text:"Why shard by sku_id rather than fc_id?"},
        {who:"cand",text:"Because contention and locality are per-SKU: a flash sale is one SKU across FCs. Sharding by SKU keeps all of that SKU's rows co-located for single-shard transactions and lets me apply hot-SKU sub-counters within the shard. Sharding by FC would scatter a single reserve's related rows and complicate the atomic decrement."},
      ],resources:[]},
      {l:"hard",tag:"failover",q:"The write primary for a shard is unreachable. What does the API do for reserves and for reads?",turns:[
        {who:"cand",text:"Reserves for that shard <strong>fail fast</strong> — I never guess a decrement, because a wrong guess is an oversell or a lost unit. The shard's consensus layer promotes a replica (seconds), and because commits were quorum-replicated the new leader has every committed decrement. Meanwhile availability reads degrade gracefully: serve from cache / a followers-only read with a stale flag."},
        {who:"intv",text:"Isn't failing reserves a bad customer experience?"},
        {who:"cand",text:"Briefly, yes — but a short 'try again' beats overselling or losing a paid unit. I keep the failover window tiny (fast leader election), scope the outage to one shard's SKUs, and keep the read path up so browsing is unaffected. Correctness on the money path wins over a few seconds of reserve availability."},
      ],resources:[{title:"Raft leader election",url:"https://raft.github.io/"}]},
      {l:"staff",tag:"scaling",q:"How do you keep a flash sale from converting 1M browsers into 1M writes on one row?",turns:[
        {who:"cand",text:"Admission control at the edge before the write ever forms. Per-SKU rate limiting and a virtual waiting room admit reserves at roughly the rate stock can satisfy — 5,000 units doesn't need 1M/s of attempts. Browsing stays on cache. Behind that, the hot row is write-sharded into sub-counters so the admitted writes still spread across K keys."},
        {who:"intv",text:"How do you set the admission rate?"},
        {who:"cand",text:"Derive it from remaining stock and expected conversion: if there are N units and ~X% of holds convert, admit at a rate that fills N over the sale window with a safety margin, then throttle hard once holds outstanding approach N. It turns a stampede into an orderly queue and protects both the DB and the customer from a pointless retry storm on sold-out stock."},
      ],resources:[]},
    ],
    invdb:[
      {l:"easy",tag:"concept",q:"What is the single most important operation this store must support, and why?",turns:[
        {who:"cand",text:"The <strong>atomic conditional decrement</strong>: <code>UPDATE inventory SET reserved=reserved+1 WHERE available&ge;qty</code>. It's the entire no-oversell guarantee in one statement — the DB serializes concurrent attempts on the row, so exactly one can claim the last unit. Everything else (audit, cache, holds) is built around protecting this operation's correctness."},
      ],resources:[]},
      {l:"medium",tag:"durability",q:"Why must the decrement be strongly consistent when availability can be eventually consistent?",turns:[
        {who:"cand",text:"Eventual consistency on the decrement <em>is</em> overselling: two replicas could each accept a claim on the last unit and reconcile to -1. So the decrement needs a single serialization point with quorum-durable commits. Availability is derived and advisory — a stale badge just shows a slightly-off count, self-correcting on the next refresh, with the decrement as the real guard. Different data, opposite consistency needs."},
      ],resources:[{title:"Consistency models",url:"https://jepsen.io/consistency"}]},
      {l:"hard",tag:"scaling",q:"Walk through the hot-row problem and your sub-counter fix, including what it costs.",turns:[
        {who:"cand",text:"One <code>(sku,fc)</code> row can only take a few thousand serialized writes/s; a 100K/s drop overwhelms it. Fix: split the row into K sub-counters <code>(sku, fc, bucket)</code>, each owning a slice of stock. A reserve hashes to a random bucket, spreading writes K-way. Cost: availability now needs a fan-in sum (so keep the badge cached/coarse), and buckets can skew — one hits zero while others have stock, causing a false 'insufficient'."},
        {who:"intv",text:"How do you handle that skew and the false negatives?"},
        {who:"cand",text:"On a bucket miss, retry against another non-empty bucket before returning insufficient, and rebalance stock across buckets when one drains. I also only shard SKUs that are measurably hot (by write rate), so 99.99% of SKUs stay a single exact row and I pay the complexity only where it buys throughput."},
      ],resources:[{title:"Sharded counters",url:"https://cloud.google.com/datastore/docs/concepts/sharded-counters"}]},
      {l:"staff",tag:"durability",q:"The primary crashes mid-transaction during a reserve. Can a committed decrement be lost or double-applied?",turns:[
        {who:"cand",text:"No, on both counts. The transaction is atomic — a crash mid-flight rolls back, so a half-applied decrement never persists. And commits are <strong>quorum-replicated</strong>: the leader waits for a follower to durably ack the WAL before returning success, so a promoted replica already has every acked decrement. A client that got a 200 keeps its unit; a client whose commit hadn't quorum-acked sees a failure and retries idempotently."},
        {who:"intv",text:"What if the ack was lost but the commit actually happened?"},
        {who:"cand",text:"That's the ambiguous-commit case, handled by idempotency: the retry carries the same idempotency key, so the reservation service finds the existing hold (or the unique constraint rejects a duplicate) and returns the original result instead of decrementing again. Exactly-once effect even though delivery was at-least-once."},
      ],resources:[{title:"Two-phase commit / consensus",url:"https://raft.github.io/"}]},
    ],
    holds:[
      {l:"easy",tag:"concept",q:"What is a reservation and what states does it move through?",turns:[
        {who:"cand",text:"A time-limited claim on stock created at checkout. It moves <code>available &rarr; reserved</code> and starts as <strong>held</strong> with an <code>expires_at</code>. From there it becomes <strong>committed</strong> (order paid — turns into a real on_hand deduction), <strong>released</strong> (explicit cancel), or <strong>expired</strong> (reaper reclaims an abandoned hold)."},
      ],resources:[]},
      {l:"medium",tag:"concept",q:"Would you reserve on add-to-cart or at checkout? Defend it.",turns:[
        {who:"cand",text:"At checkout, with a tight TTL. Reserving on add-to-cart gives the strongest buyer guarantee but locks stock for the many people who browse and never buy, manufacturing stock-outs. Reserving at checkout keeps stock liquid and only holds it for people actively paying. The cart stays advisory; the hold is the real commitment."},
        {who:"intv",text:"When might reserve-on-add be justified?"},
        {who:"cand",text:"Extreme scarcity events — a hyped limited drop — where fairness ('you added it, it's yours for N minutes') matters more than liquidity. Even then I'd pair it with a short TTL and a waiting room so held stock keeps circulating."},
      ],resources:[]},
      {l:"hard",tag:"failover",q:"A reserve succeeds but the client never gets the ack and retries. Guarantee exactly one hold.",turns:[
        {who:"cand",text:"Idempotency on the cart-line key enforced by a unique index. The insert is <code>INSERT ... ON CONFLICT (idempotency_key) DO NOTHING RETURNING reservation_id</code>. The first call creates the hold; the retry conflicts, returns no row, so the service reads back the existing <code>reservation_id</code> and returns it. The unit is decremented once; the customer gets one hold no matter how many times they retry."},
        {who:"intv",text:"What if two retries hit two different API instances simultaneously?"},
        {who:"cand",text:"The unique constraint is enforced by the database, not the app, so it's still safe: exactly one insert wins the key, the other gets the conflict and reads the winner's row. The serialization point is the DB index, which both instances share — no distributed lock needed."},
      ],resources:[{title:"Idempotent requests",url:"https://stripe.com/docs/api/idempotent_requests"}]},
      {l:"staff",tag:"durability",q:"Would you store holds in Redis for speed, or in the transactional store? Trade-offs.",turns:[
        {who:"cand",text:"In the transactional store, alongside the count. The reserved-quantity bump and the hold row must be consistent by construction — if they diverge I either oversell or leak stock. Keeping them in one ACID transaction guarantees <code>available = on_hand - reserved</code> always holds. A Redis lease is faster but reintroduces a dual-write / divergence risk between the lease and the authoritative count."},
        {who:"intv",text:"Is there any role for Redis on the hold path?"},
        {who:"cand",text:"Yes, as an accelerator for the hottest SKUs: a Redis atomic counter absorbs the burst and I reconcile to the durable store asynchronously with the ledger as backstop. But the <em>authoritative</em> hold state stays transactional. Redis is a performance cache in front of truth, never the truth for something that gates money."},
      ],resources:[]},
    ],
    cache:[
      {l:"easy",tag:"concept",q:"What exactly do you store in the availability cache?",turns:[
        {who:"cand",text:"A tiny per-SKU (optionally per-region) entry: a rolled-up <code>available</code> across the SKU's FCs, an <code>in_stock</code> boolean / coarse bucket, and a timestamp. It's derived and rebuildable from the store or by folding the ledger — never authoritative."},
      ],resources:[]},
      {l:"medium",tag:"scaling",q:"Write-through on every reserve, or async refresh? Why?",turns:[
        {who:"cand",text:"Async refresh via CDC off the movement events. Write-through would add cache latency to the hot decrement and amplify a hot SKU's thousands of tiny updates into thousands of cache writes. Async lets the decrement path stay lean; the badge lags sub-second, which is fine for an advisory value. Coarse buckets mean most decrements don't even change the displayed state."},
      ],resources:[]},
      {l:"hard",tag:"scaling",q:"A viral SKU's cache entry expires and 500K reads miss simultaneously. Prevent the stampede.",turns:[
        {who:"cand",text:"Single-flight / request coalescing per key: the first miss acquires a lease and fills from a read replica; concurrent misses wait on that one fill rather than each hitting the store. Add jittered TTLs so hot keys don't expire in lockstep, and a short negative cache for out-of-stock so misses on sold-out SKUs don't repeatedly probe the store. The store sees one read, not 500K."},
        {who:"intv",text:"What if the fill itself is slow?"},
        {who:"cand",text:"Serve the last-known value with a stale flag while the fill runs (stale-while-revalidate), so readers get an answer immediately and the store still sees a single background fill. For a badge, a slightly stale value is strictly better than blocking half a million readers."},
      ],resources:[{title:"Stale-while-revalidate",url:"https://web.dev/articles/stale-while-revalidate"}]},
    ],
    ledger:[
      {l:"medium",tag:"durability",q:"How do you guarantee the ledger and the live count never disagree?",turns:[
        {who:"cand",text:"Transactional outbox: the movement event is written in the <strong>same DB transaction</strong> as the count change, so they commit or roll back together — no dual-write gap. A relay then publishes committed outbox rows to Kafka at-least-once, and consumers dedup on <code>movement_id</code>. The store and the log are consistent by construction."},
        {who:"intv",text:"Why not just publish to Kafka from the app after committing the DB write?"},
        {who:"cand",text:"Because the app could crash between the DB commit and the Kafka publish, leaving a movement with no event — silent divergence. The outbox moves the publish decision into the same transaction as the state change; the relay reads what actually committed, so a crash just delays publication, never loses it."},
      ],resources:[{title:"Transactional outbox",url:"https://microservices.io/patterns/data/transactional-outbox.html"}]},
      {l:"hard",tag:"durability",q:"How would you detect and correct a SKU whose count has drifted from reality?",turns:[
        {who:"cand",text:"A recon job periodically folds the ledger per SKU (sum of signed <code>qty_delta</code> from a known baseline) and diffs it against the materialized <code>on_hand</code>. Any mismatch alerts. Correction is a signed <code>adjust</code> movement with a reason and reference — never a blind overwrite — so the fix is itself auditable and composes with concurrent reserves. Physical drift (breakage, theft) is caught by cycle counts feeding the same <code>adjust</code> path."},
      ],resources:[{title:"Event sourcing",url:"https://martinfowler.com/eaaDev/EventSourcing.html"}]},
      {l:"staff",tag:"scaling",q:"Would you make the ledger the source of truth (pure event sourcing) or keep a materialized count?",turns:[
        {who:"cand",text:"Keep a materialized count as truth with the ledger as the audit/CDC feed. Pure event sourcing makes recon trivial but forces every reserve to fold events to know current <code>available</code>, which is brutal on a hot SKU and complicates the atomic conditional decrement. A materialized row gives O(1) compare-and-set for the correctness path; the append-only ledger still provides full auditability and rebuild-on-demand. I get event sourcing's benefits without paying its read cost on the money path."},
        {who:"intv",text:"How do you rebuild the materialized count if it's corrupted?"},
        {who:"cand",text:"Replay the ledger from the last trusted snapshot: take a baseline on_hand at a known offset, fold all subsequent movements for the SKU, and write the result back under a version guard. Because movements are idempotent and ordered per SKU (partitioned by sku_id), the rebuild is deterministic and can run per-SKU without a global stop."},
      ],resources:[]},
    ],
    reaper:[
      {l:"medium",tag:"failover",q:"How does the reaper find expired holds efficiently, and how often does it run?",turns:[
        {who:"cand",text:"It range-scans the <code>reservations</code> index on <code>(status, expires_at)</code> for <code>status='held' AND expires_at&lt;now()</code>, batched with a LIMIT — a bounded read, never a full-table scan. It runs on a tight cadence (~1-5s) so abandoned units return within seconds, which matters for hot SKUs where a stuck hold is a lost sale."},
      ],resources:[]},
      {l:"hard",tag:"failover",q:"The reaper and an order commit race on the same hold. Prevent a double-release.",turns:[
        {who:"cand",text:"Both operations flip the reservation conditionally on <code>status='held'</code> in a single statement. Whichever executes first flips it (to committed or expired); the other's <code>WHERE status='held'</code> now matches 0 rows and no-ops. Only the winner adjusts the inventory row. So a unit is either committed or released — never both, never double-counted."},
        {who:"intv",text:"Does the reaper need a distributed lock across its instances?"},
        {who:"cand",text:"Not for correctness — the conditional flip already makes releases idempotent and mutually exclusive, so two reapers processing the same hold is harmless (one wins, one no-ops). I still give each reaper a per-shard coordinator lease to avoid wasted duplicate scans, but that's an efficiency optimization, not a safety requirement."},
      ],resources:[{title:"Distributed locking pitfalls",url:"https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html"}]},
    ],
    replenish:[
      {l:"easy",tag:"concept",q:"How does inbound stock enter the system?",turns:[
        {who:"cand",text:"A receipt: when a shipment is scanned in at an FC, we apply an atomic <code>on_hand += qty</code> on the <code>(sku, fc)</code> row plus a <code>receipt</code> movement event. The receipt is keyed by <code>receipt_id</code> so applying it is idempotent."},
      ],resources:[]},
      {l:"medium",tag:"durability",q:"An inbound message is redelivered. How do you avoid double-counting the shipment?",turns:[
        {who:"cand",text:"Idempotency on <code>receipt_id</code>. Applying a receipt checks/marks its status atomically — <code>UPDATE inbound_receipts SET status='applied' WHERE receipt_id=? AND status='pending'</code> — and only if that flips a row do I increment on_hand and write the movement. A redelivery finds <code>status='applied'</code> and no-ops, so the truckload is counted exactly once even under at-least-once delivery."},
      ],resources:[]},
      {l:"hard",tag:"durability",q:"A cycle count says the shelf has fewer units than the system. Correct it safely.",turns:[
        {who:"cand",text:"Write a signed <code>adjust</code> movement for the difference (e.g. <code>-2</code>, <code>reason='cycle_count'</code>) rather than setting an absolute value. Applying a delta composes with concurrent reserves — no lost updates — and records why stock changed. A blind <code>SET on_hand=3</code> would clobber an in-flight decrement and erase the audit trail. The ledger now explains the discrepancy, and recon reproduces the corrected count."},
        {who:"intv",text:"What if the correction would push available negative because units are already reserved?"},
        {who:"cand",text:"I apply the adjust to <code>on_hand</code> and let <code>available = on_hand - reserved</code> reflect reality even if that's temporarily very low; existing valid holds are honored. If on_hand would go below reserved, that's a genuine shortfall — I flag it for ops to resolve (cancel/rebook affected orders) rather than silently dropping someone's paid reservation. The system surfaces the conflict instead of hiding it."},
      ],resources:[]},
    ],
  },
  mockTest:[
    {q:"What is the single mechanism that prevents overselling, and why is it correct under concurrency?",a:"A single atomic conditional decrement — <code>UPDATE inventory SET reserved=reserved+1 WHERE available&ge;qty</code>. The DB row-locks and serializes concurrent attempts, so exactly one wins the last unit; the losers match 0 rows and get a 409. The check and the write are the same atomic operation, which is why a read-then-write approach (which races) is wrong."},
    {q:"Why can availability reads be eventually consistent but the decrement cannot?",a:"Availability is derived and advisory — a stale badge just shows a slightly-off count and self-corrects; the decrement is the real guard. Eventual consistency on the decrement itself would let two replicas both accept the last unit — that's overselling. So the write path is strongly consistent + quorum-durable, and the ~1M/s read path is offloaded to a stale-tolerant cache."},
    {q:"How do you make reserve idempotent, and why does it matter?",a:"A client-generated idempotency key per cart line, enforced by a unique index (<code>INSERT ... ON CONFLICT DO NOTHING RETURNING</code>). A retried reserve after a lost ack returns the existing hold instead of creating a second one. Without it, network retries double-decrement stock and lock units no one bought."},
    {q:"A limited drop drives 100K reserves/s onto one SKU row. How do you keep the store alive?",a:"Two levers: (1) admission control / a virtual waiting room at the edge so we only admit reserves at the rate stock can satisfy; (2) write-shard the hot row into K sub-counter rows <code>(sku,fc,bucket)</code> so writes spread K-way. Cost is possible bucket skew (retry another bucket before failing) and coarser availability (keep it cached). Apply only to measurably-hot SKUs."},
    {q:"What happens to a reserved unit if the customer never pays?",a:"The hold is a lease with <code>expires_at</code>. A reaper scans <code>status='held' AND expires_at&lt;now()</code> every few seconds and releases expired holds — an atomic conditional flip that returns <code>reserved</code> to <code>available</code> and writes a release event. It only flips holds still in <code>held</code>, so it can't fight a commit."},
    {q:"How do the commit and release paths avoid double-counting the same hold?",a:"Both flip the reservation conditionally on <code>status='held'</code> in one statement. Whichever runs first flips it (committed or expired); the other matches 0 rows and no-ops, so only one adjusts inventory. The unit is either committed or released, never both."},
    {q:"How do you keep the audit ledger and the live count from diverging?",a:"Transactional outbox: the movement event is written in the same transaction as the count change, so they commit together — no dual-write gap. A relay publishes committed rows to Kafka at-least-once, deduped on <code>movement_id</code>. A recon job folds the ledger per SKU and diffs against the materialized count to catch and adjust any drift."},
    {q:"Which database would you pick for the inventory store and why not Cassandra?",a:"A strongly-consistent relational / NewSQL store (Postgres sharded by sku_id, or CockroachDB/Spanner), optionally with Redis fronting the hottest SKUs. The atomic conditional decrement wants native row locks + ACID. Cassandra needs a per-decrement lightweight transaction (Paxos, ~4 round trips) that throttles the contended path, and its last-write-wins default would silently oversell — the wrong fit for a compare-and-set-heavy workload."},
  ],
};

