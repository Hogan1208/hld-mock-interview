window.DATA = window.DATA || {};
window.DATA['proximity'] = {
  cat:"geo · high write · spatial",
  title:"Design a proximity service (nearby drivers / places)",
  blurb:"Find drivers or places within a radius in real time, while a firehose of moving drivers stream location every few seconds.",
  prompt:"Let's design a proximity service — the thing that answers 'which drivers are near me?' for Uber, or 'restaurants within 2km' for Yelp. For Uber it's harder: the objects move, so drivers stream their location every few seconds and the answer must stay fresh. Start with the high-level architecture and rough numbers, then we'll drill into components — and I'll throw failure scenarios at you.",
  opening:"Let me frame it before drawing boxes.<br><br><strong>Functional:</strong> a rider sends a lat/lng and gets nearby drivers within a radius, ranked by distance / ETA; drivers continuously report their position; the result is near-real-time. <strong>Non-functional:</strong> query p99 < 200ms, freshness within a few seconds (a driver we show must actually still be there), high availability (a stale or missing result is a slightly worse match, not a broken system), and it must absorb a firehose of location writes.<br><br><strong>Back-of-envelope:</strong> ~1M active drivers, each streaming location every ~4s → ~250K location writes/s, sustained. Rider 'nearby' queries ~20K/s, peak 3-5x during surge. Each position is tiny (~100 bytes), so the working set of current positions is a few hundred MB — it fits in memory, and that fact shapes the whole design.<br><br>I'll start deliberately minimal: <strong>client → API gateway → query / match service → location store</strong>. Drivers push updates through the same edge; riders query through it. That skeleton answers 'who's nearby' correctly. As we hit write volume, hotspots, and failures I'll grow it — a spatial index, a dedicated ingest path, dispatch. Pick a box and let's push on it.",
  nodes:[
    {id:"client",name:"Client",sub:"rider / driver",x:40,y:150},
    {id:"gw",name:"API gateway",sub:"edge",x:210,y:150},
    {id:"match",name:"Query / match svc",sub:"nearby search",x:380,y:150},
    {id:"db",name:"Location store",sub:"current positions",x:550,y:150},
    {id:"location",name:"Location ingest",sub:"high write",x:210,y:40},
    {id:"index",name:"Geo index",sub:"spatial buckets",x:380,y:40},
    {id:"notify",name:"Dispatch / notify",sub:"push updates",x:550,y:40},
  ],
  edges:[["client","gw","request"],["gw","match","nearby?"],["match","db","lookup"],["gw","location","update loc"],["location","index","index"],["match","index","query"],["match","notify","dispatch"]],
  core:["client","gw","match","db"],
  basic:["client","gw","match","db"],
  dbDoc:{
    component:"Location store",
    load:"~250K location writes/s (blind latest-wins overwrites, one tiny record each) + ~20K nearby geo-queries/s (peak ~80K reads/s) + ~1M current driver positions held in memory (working set only ~150MB). Access = point write by driverId and point-radius search — no joins, no history, no range scans.",
    candidates:[
      {name:"In-memory KV with native geo (Redis GEO)",ceiling:"~100K GEOADD/GEOSEARCH ops/s per node before latency climbs",nodes:"250K writes/s &divide; ~100K/node &asymp; 3 write shards, &times;2 for primary + AZ replica &asymp; <strong>6 nodes</strong>; peak ~80K reads/s ride the same shards as headroom",pick:true,note:"chosen — the only option with a native point-radius primitive, fewest nodes, and it spends zero effort on a durability guarantee the ~4s self-healing position stream already provides."},
      {name:"PostGIS (Postgres + GiST spatial index)",ceiling:"~5-10K fsync-backed writes/s per node",nodes:"250K &divide; ~8K/node &asymp; <strong>30+ write nodes</strong>, and constant lat/lng updates bloat the GiST index and pile on vacuum",pick:false,note:"durable, but every write is an fsync-backed row update that churns the spatial index — you fight vacuum to stand still, serving data that does not need to survive."},
      {name:"Cassandra (LSM wide-column)",ceiling:"~30-50K writes/s per node",nodes:"250K &divide; ~40K/node &asymp; <strong>6-7 nodes</strong> for writes alone",pick:false,note:"absorbs writes well, but has no native radius query and latest-wins overwrites become a stream of LSM inserts that generate tombstones and heavy compaction for data that lives ~15s."},
    ],
    indexing:"Bucket every position by its cell: map lat/lng to a <strong>geohash prefix / H3 cell</strong> and keep a <code>cell &rarr; set of driverIds</code> mapping (Redis GEO does this under the hood as a geohash-scored sorted set). A radius query becomes a handful of <strong>cell lookups</strong>, not a scan — compute the rider's cell plus its neighbor ring, union the driverIds in those few cells, then run exact haversine only on that small candidate set.<span class='eg'>2km radius over ~1km cells &rarr; ~9 cell lookups returning a few dozen candidates, versus haversine over all 1M rows.</span>A <code>TTL</code> ~15s auto-evicts stale drivers so a dropped-off position ages out without a sweep. In-memory over durable because a lost position is overwritten by the driver's next report ~4s later — it self-heals, so an fsync/WAL guarantee buys nothing on this hot path.",
    decision:"Pick an <strong>in-memory KV with native geo (Redis GEO), geo-sharded by density, replica per AZ</strong>. Not PostGIS — its durability and GiST maintenance cap it at ~5-10K writes/s/node, so ~30+ nodes fighting vacuum to serve data that need not survive. Not Cassandra — great write absorption but no native radius query and wasteful compaction on ~15s-lived overwrites. Redis wins on the three axes that matter here: native point-radius, ~100K ops/s/node so the fleet is ~6 nodes, and no wasted effort on a durability guarantee the self-healing stream already provides.",
  },
  schema:{tables:[
    {name:"drivers",pk:"driver_id",columns:[
      ["driver_id","bigint","driver, primary key"],
      ["status","varchar(12)","available / busy / offline"],
      ["last_lat","double","last reported latitude"],
      ["last_lng","double","last reported longitude"],
      ["updated_at","timestamptz","last report time (durable row)"],
    ],rows:[
      ["8821","available","37.7749","-122.4194","2026-07-22 10:05:03"],
      ["8822","busy","37.7811","-122.4102","2026-07-22 10:05:01"],
      ["8823","offline","37.3382","-121.8863","2026-07-22 09:58:40"],
    ]},
    {name:"driver_locations",pk:"driver_id",columns:[
      ["driver_id","bigint","driver, primary key"],
      ["h3_cell","varchar(16)","current H3 cell (geohash-scored)"],
      ["lat","double","current latitude"],
      ["lng","double","current longitude"],
      ["ts","timestamptz","position time — in-memory Redis GEO, TTL ~15s, latest-wins"],
    ],rows:[
      ["8821","8a2830828047fff","37.7749","-122.4194","2026-07-22 10:05:03"],
      ["8822","8a283082807ffff","37.7811","-122.4102","2026-07-22 10:05:01"],
      ["8830","8a2830828047fff","37.7752","-122.4188","2026-07-22 10:05:02"],
    ]},
    {name:"geo_index",pk:"cell_id",columns:[
      ["cell_id","varchar(16)","H3 cell id, primary key"],
      ["driver_ids","set of bigint","drivers currently bucketed in this cell (Redis set, rebuildable)"],
      ["driver_count","int","cached size for density-based subdivision"],
      ["updated_at","timestamptz","last bucket change"],
    ],rows:[
      ["8a2830828047fff","{8821, 8830, 8845}","3","2026-07-22 10:05:03"],
      ["8a283082807ffff","{8822}","1","2026-07-22 10:05:01"],
    ]},
    {name:"rides",pk:"ride_id",columns:[
      ["ride_id","uuid","dispatch record, primary key"],
      ["rider_id","bigint","requesting rider"],
      ["driver_id","bigint NULL","assigned driver (null until claimed)"],
      ["state","varchar(12)","offered / accepted / declined / completed"],
      ["created_at","timestamptz","request time (durable)"],
    ],rows:[
      ["7f3a…","55012","8821","accepted","2026-07-22 10:05:04"],
      ["b12c…","55019","(null)","offered","2026-07-22 10:05:06"],
    ]},
  ]},
  flows:[
    {id:"update",name:"Driver sends a location update",steps:[
      {node:"client",text:"Driver app fires a tiny lat/lng frame over its persistent stream (fire-and-forget)."},
      {node:"location",requires:["location"],text:"Ingest terminates the stream, batches over ~50-100ms, and keeps only the latest sample per driver."},
      {node:"db",text:"Overwrites the driver's row in <code>driver_locations</code> (latest-wins, no history)."},
      {node:"index",requires:["index"],text:"Computes the driver's H3 cell and moves them between buckets <strong>only if the cell changed</strong>."},
    ]},
    {id:"nearby",name:"Rider finds nearby drivers",steps:[
      {node:"client",text:"Rider sends <code>GET /nearby {lat, lng, radius}</code>."},
      {node:"gw",text:"Gateway authenticates and routes the read to the match service."},
      {node:"match",text:"Computes the rider's cell plus the surrounding neighbor ring."},
      {node:"index",requires:["index"],text:"Returns the driver ids bucketed in those cells — a small candidate set, not the whole fleet."},
      {node:"db",text:"Reads the candidates' current positions from <code>driver_locations</code> for exact filtering."},
      {node:"match",text:"Runs haversine on the candidates, drops those outside the radius, and ranks by distance / ETA."},
    ]},
    {id:"dispatch",name:"Dispatch a ride to a nearby driver",steps:[
      {node:"match",text:"Picks the best-ranked available driver from the nearby set."},
      {node:"notify",requires:["notify"],text:"Pushes a ride offer to that driver's phone and waits for accept / decline within a timeout."},
      {node:"db",text:"On accept, atomically claims the trip on the <code>rides</code> row (compare-and-set on driver_id)."},
    ]},
  ],
  requirements:{
    functional:[
      "Find all drivers (or places) within a radius of a rider's location, ranked by distance / ETA",
      "Ingest continuous live location updates from a firehose of moving drivers",
      "Dispatch a ride offer to nearby drivers and track accept / decline",
      "Keep results near-real-time — a driver we show must still be roughly where we say",
    ],
    nonFunctional:[
      "Query p99 &lt; 200ms; freshness within a few seconds of a driver's true position",
      "Absorb a sustained write firehose — ~250K location updates/s at ~1M active drivers",
      "High availability for queries — a stale or smaller result set is degraded, not broken",
      "Scale to hotspots where drivers and queries concentrate in a few dense city cells",
    ],
  },
  reqBuild:[
    {req:"Find objects within a radius of a point (adds a geo index)",reveal:["index"],turns:[
      {who:"intv",text:"Start with requirement one: a rider drops a pin and wants every driver within 2km. What's the minimal path that returns a correct answer?"},
      {who:"cand",text:"The <strong>client</strong> calls the <strong>API gateway</strong>, which routes to the <strong>query / match service</strong>, which needs the current position of nearby drivers from the <strong>location store</strong>. But I can't scan all 1M drivers per query and compute distance — that's dead on arrival. So the match service leans on a <strong>spatial index</strong> that buckets the earth's surface into cells: look up the rider's cell plus its neighbors, gather the handful of drivers bucketed there, then run exact haversine distance on that small candidate set. Let me add a <strong>geo index</strong> — it turns search 1M drivers into search a few dozen in a handful of cells."},
      {who:"intv",text:"Why stand up a whole index instead of a distance filter in the store query?"},
      {who:"cand",text:"Because a radius filter still has to look at every row to decide who's inside — it's a full scan, O(n) per query, and n is a million. The index makes proximity a lookup, not a scan: it maps a point to the cells around it in constant time, so query cost tracks the number of nearby drivers, not the fleet size. I'll defer how the cells are shaped and sized — geohash vs H3, fixed vs adaptive resolution — to the deep dives; right now the point is just that requirement one needs a spatial index behind the match service."},
    ],resources:[
      {title:"Geohash — cells and prefixes",url:"https://en.wikipedia.org/wiki/Geohash"},
      {title:"System Design Primer — use good indices",url:"https://github.com/donnemartin/system-design-primer#use-good-indices"},
    ]},
    {req:"Ingest drivers' live location updates (adds an ingest path)",reveal:["location"],turns:[
      {who:"intv",text:"Requirement two: those drivers are moving, so each one streams its position every few seconds. Does that write traffic just go back through the same gateway and match service?"},
      {who:"cand",text:"I'd keep it off that path. A driver update and a rider query are opposite workloads: an update is a tiny, extremely frequent, loss-tolerant write — latest-wins, I'm here now — while a query is a less frequent read that must return fast and fresh. So let me add a dedicated <strong>location ingest</strong> service on its own path. Drivers hold a persistent connection and fire updates as small binary frames; ingest normalizes them and writes the latest position into the store and the index. The gateway still fronts both sides, but writes and reads flow down separate paths behind it."},
      {who:"intv",text:"Why bother splitting it out rather than reusing the query path you already have?"},
      {who:"cand",text:"Two reasons. First, isolation: the write firehose is huge and constant, and if it shares the query stack it can starve the reads riders actually wait on. Second, the write barely needs the machinery a query does — durability hardly matters, since if I drop one update the next one is a few seconds away and overwrites it anyway. So it wants a cheap, fire-and-forget channel, not the full request lifecycle. How ingest batches, sheds load, and avoids write amplification is a deep dive; for now requirement two just needs its own ingest tier."},
    ],resources:[
      {title:"System Design Primer — asynchronism",url:"https://github.com/donnemartin/system-design-primer#asynchronism"},
      {title:"Redis geospatial (write path)",url:"https://redis.io/docs/latest/develop/data-types/geospatial/"},
    ]},
    {req:"Dispatch / notify nearby drivers (adds dispatch)",reveal:["notify"],turns:[
      {who:"intv",text:"Requirement three: your query returns 12 nearby drivers for a ride request. Finding them is only half the job — how does one of them actually get the trip?"},
      {who:"cand",text:"Right, now I <strong>match and dispatch</strong>. The match service ranks the 12 by ETA, rating, and acceptance likelihood, picks the best, and pushes a <strong>ride offer</strong> to that driver's phone, then waits for an accept within a short timeout. That push to a specific driver, over a live channel, with an offer lifecycle and timeouts, is its own concern — so let me add a <strong>dispatch / notify</strong> component that owns it. The match service decides who to offer; dispatch delivers the offer and tracks accept / decline."},
      {who:"intv",text:"Why not just broadcast the offer to all 12 and let the fastest one accept?"},
      {who:"cand",text:"Broadcast causes a thundering accept race — 12 drivers tap accept, 11 lose, everyone's annoyed, and you burn driver trust. Instead dispatch offers sequentially or in small parallel batches with a per-offer timeout: offer the best driver, and on decline or timeout advance to the next. That keeps at most one live claim on the ride at a time. The exact timeout tuning, surge fan-out, and how I guarantee exactly one driver gets the trip are deep dives; functionally requirement three just needs a dispatch component driving the offer loop."},
    ],resources:[
      {title:"System Design Primer — application layer",url:"https://github.com/donnemartin/system-design-primer#application-layer"},
      {title:"bytebytego — system design patterns",url:"https://bytebytego.com/"},
    ]},
  ],
  systemDives:[
    {title:"New Year's Eve — 100K drivers packed into one cell",tag:"scaling",turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> you picked one fixed cell size, ~1km. A rural cell holds 3 drivers, but Times Square on New Year's Eve packs <b>100,000</b> drivers into a single cell. A nearby query on that cell drags back 100K candidates to haversine-filter — slow — and that one cell's shard is pinned at 100% while the prairie shards idle. Fix it.</span>"},
      {who:"cand",text:"Fixed resolution is the mistake — one cell size cannot serve both a dense metro and an empty prairie. The answer is <strong>adaptive resolution</strong>: fine cells where it's dense, coarse cells where it's sparse. Both H3 and quadtrees support this directly — H3 has multiple resolution levels, and a quadtree subdivides a hot square into four repeatedly until each leaf holds a manageable count.<span class='eg'>Times Square at H3 res ~10 (~65m cells) so a cell holds tens of drivers, not 100K; rural at res ~7 (~1km) so I don't scan thousands of empty cells.</span>"},
      {who:"intv",text:"How do you decide a cell's resolution, and what about the true pathological case — 100K bodies in one physical spot no matter how fine you cut?"},
      {who:"cand",text:"I track <strong>per-cell density</strong> and subdivide any cell that crosses a count threshold, promoting hot areas to finer resolution automatically. For the spot where even fine cells overflow, two guards: <strong>cap candidates per query</strong> — a rider needs the nearest N, not all 100K, so I stop as soon as I have enough — and <strong>spread the hot cell across shards</strong> so no single node owns the whole crowd. I also let dispatch, not the query, do the heavy discrimination: the query just needs enough good candidates nearby."},
      {who:"intv",text:"Capping candidates — could that ever return a worse match than scanning them all?"},
      {who:"cand",text:"Not materially. Within a dense cell the nearest N drivers are all within a few hundred meters of the rider, so ranking the closest 50 gives essentially the same top pick as ranking 100K — the marginal candidate is always farther than the ones I already have. I gather candidates nearest-first (expanding rings out from the rider's sub-cell) so the cap keeps the closest drivers, not a random slice. It trades a theoretical global optimum for a bounded, fast query, which under a 100K-in-one-cell surge is exactly the right trade.<span class='eg'>Cap at 50 candidates: the 51st is already farther than #1-#50, so dispatch's best offer is unchanged while query cost stays flat.</span>"},
    ],resources:[
      {title:"Uber H3 — variable resolution",url:"https://www.uber.com/blog/h3/"},
      {title:"Quadtree — adaptive subdivision",url:"https://en.wikipedia.org/wiki/Quadtree"},
    ]},
    {title:"250K location updates/sec overwhelm ingest",tag:"scaling",turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> 1M drivers each report GPS every 4 seconds — <b>250K writes/s</b>, sustained, 24/7. If every update writes the store <em>and</em> updates the index — remove from the old cell, add to the new — that's 500K+ ops/s of write amplification and it kills you. Design the ingest write path.</span>"},
      {who:"cand",text:"I cut the work per update to the minimum. Ingest terminates the driver streams, <strong>batches</strong> updates over short windows (say 50-100ms), and for each driver in the batch writes only the <em>latest</em> position — intermediate samples are dropped, latest-wins. The store write is then a single overwrite. The index write is <strong>conditional</strong>: I compute the driver's current cell and only touch the index when the cell actually changed, which is the minority of updates.<span class='eg'>250K updates/s, but only ~1 in 15 crosses a cell boundary within 4s → ~17K index moves/s, not 250K.</span>"},
      {who:"intv",text:"Batching adds latency, and holding a million persistent connections is a lot of sockets. Is that all worth it?"},
      {who:"cand",text:"Yes on both. The batch window is 50-100ms against a freshness budget of a few seconds — the dominant staleness is the 4s report interval, not my batching, so it's free. And a million idle-ish long-lived connections spread across an ingest fleet is cheap (a few hundred K per event-loop node); the alternative is 250K TLS handshakes/s, which is far more expensive in CPU. Persistent streams also let me push <strong>adaptive reporting</strong> back to clients — a parked driver reports every 20-30s — which cuts the firehose at the source rather than absorbing it all.<span class='eg'>250K updates/s x ~100 bytes ≈ 25 MB/s — trivial bandwidth; the cost is op count and connections, not volume.</span>"},
    ],resources:[
      {title:"System Design Primer — asynchronism",url:"https://github.com/donnemartin/system-design-primer#asynchronism"},
      {title:"Redis geospatial write path",url:"https://redis.io/docs/latest/develop/data-types/geospatial/"},
    ]},
    {title:"The in-memory location store crashes and loses every position",tag:"durability",turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> 3am, the in-memory node holding the SF region OOMs and restarts <b>empty</b>. Every current driver position for SF — tens of thousands of them — just vanished. No backup, no WAL. Are you in trouble?</span>"},
      {who:"cand",text:"Surprisingly little, and this is the nicest property of the whole design: <strong>location data regenerates itself</strong>. Every SF driver re-reports within ~4s, so the store refills to full accuracy within seconds of coming back — the source of truth is the drivers themselves, streaming continuously, not any disk. So I deliberately don't pay for durable persistence on this hot path; a WAL would only slow the 250K/s write path to protect data that rebuilds for free.<span class='eg'>SF working set ≈ tens of thousands of drivers x ~100 bytes ≈ a few tens of MB, fully repopulated within one ~4s report cycle.</span>"},
      {who:"intv",text:"But for those few seconds SF has no drivers in the store at all. Riders querying right then?"},
      {who:"cand",text:"That's why I don't rely on the self-heal alone — I run each shard as a <strong>replica group</strong>, primary plus a replica in another AZ. A single node restart <em>fails over to the replica</em>, which already holds the positions, so in the common case there's no empty window at all. The self-heal is the backstop for the rare double-failure. So replicas kill the window for ordinary failures; self-heal makes even a total wipe a seconds-long, zero-data-loss event rather than an outage."},
      {who:"intv",text:"So nothing about a driver's position is ever made durable?"},
      {who:"cand",text:"Only the fork that leaves the hot path. Alongside the ephemeral position write, ingest publishes updates to <strong>Kafka</strong> for the analytics and history pipeline — that stream <em>is</em> persisted and replayable, because trip trails, surge analytics, and billing genuinely need it. So the same update is treated two ways: disposable for live matching (no durability, maximum speed) and durable for the async pipeline (persisted, off the critical path). Durability lives where it's actually required, never on the 250K/s live-positions write."},
    ],resources:[
      {title:"Redis geospatial + replication",url:"https://redis.io/docs/latest/develop/data-types/geospatial/"},
      {title:"System Design Primer — replication",url:"https://github.com/donnemartin/system-design-primer#replication"},
    ]},
    {title:"A query at a shard border misses drivers just across the line",tag:"failover",turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> you shard the location store by region. A rider stands one block from the boundary between the <b>SF-north</b> and <b>SF-south</b> shards. The three closest drivers are just across the line, in the other shard. Your query hits only the rider's shard and returns them nothing useful — while three cars sit 200m away. Bug?</span>"},
      {who:"cand",text:"Yes — a real correctness bug, the <strong>edge-of-shard problem</strong>. Sharding by region draws arbitrary lines through continuous space, and proximity doesn't respect them. The fix is that a border query must <strong>fan out to neighboring shards</strong> whenever the search radius crosses a boundary: detect that the rider's cell-ring spills into an adjacent shard, query both, and union the candidates before haversine filtering. It's the same neighbor-cell logic the index already uses, applied across shard lines instead of cell lines.<span class='eg'>Rider 200m from the SF-north/south line, 2km radius → the ring clearly spans both shards, so query both and merge.</span>"},
      {who:"intv",text:"Fanning out to neighbors on every query near a border adds latency and load. Acceptable at scale?"},
      {who:"cand",text:"It's bounded and worth it. Only queries whose radius actually crosses a boundary fan out, and even then it's to 2-3 shards, done in parallel — a scatter-gather, not a sum, so latency is one shard's read, not three. To cut it further I can <strong>replicate a thin overlap band</strong> along each border into both neighboring shards: drivers within, say, 2km of the line exist in both, so most border queries stay single-shard. I trade a little write duplication in the overlap for single-shard border reads. Either way, silently missing the three nearest cars is never an option — under-coverage at a boundary is a correctness failure, not a performance one."},
    ],resources:[
      {title:"System Design Primer — sharding trade-offs",url:"https://github.com/donnemartin/system-design-primer#sharding"},
      {title:"Uber H3 — hierarchical hex grid",url:"https://www.uber.com/blog/h3/"},
    ]},
  ],
  q:{
    gw:[
      {l:"medium",tag:"capacity",q:"How many edge nodes to terminate the driver fleet?",turns:[
        {who:"intv",text:"Concrete numbers. This edge terminates ~1M persistent driver streams, absorbs ~250K updates/s, and fronts the rider queries. How many gateway nodes do you run? Show the math."},
        {who:"cand",text:"The edge here is <strong>connection-bound</strong>, not CPU-bound — the expensive thing is holding a million long-lived sockets, not the tiny frames on them. So I size on connection count first, then check request rate.<span class='eg'>1M driver streams ÷ ~250K connections/node ≈ 4 nodes for connections. Query side: ~20K queries/s x ~4 peak ≈ 80K req/s ÷ ~10K req/s/node ≈ 8 nodes. Take the max and add headroom ≈ ~12 nodes across 3 AZs.</span>Connections dominate, so that is the number I provision against."},
        {who:"intv",text:"Why size on connections rather than the 250K/s update rate, and what does undersizing cost you?"},
        {who:"cand",text:"Because a persistent stream costs memory and a file descriptor whether or not a frame is in flight, and the frames themselves are cheap fire-and-forget writes — 250K x ~100 bytes ≈ 25 MB/s is trivial bandwidth. The real trade-off is <strong>memory and socket headroom vs node cost</strong>: undersize and a node runs out of descriptors and starts dropping reconnects, which under a mass reconnect becomes a thundering herd. So I keep spare connection capacity per node and spread across 3 AZs, so losing an AZ sheds ~1/3 of streams, not the service — I pay for headroom to make reconnect storms a non-event."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope calculations",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"System Design Primer — communication",url:"https://github.com/donnemartin/system-design-primer#communication"},
      ]},
      {l:"medium",tag:"concept",q:"Rider queries vs driver updates — what splits at the edge?",turns:[
        {who:"intv",text:"Both a rider's nearby query and a driver's location update hit this gateway. Walk me through what each one needs here, and be precise."},
        {who:"cand",text:"They're opposite workloads. A <strong>driver update</strong> is a tiny, extremely frequent, loss-tolerant write — 'I'm at this lat/lng now', latest-wins. A <strong>rider query</strong> is a less frequent read that must return a fresh, ranked set fast. The gateway owns the shared edge concerns — TLS, auth (both sides are authenticated), rate limiting, routing — then sends updates down a write path and queries to the match service. I want them on separate paths so the write firehose can never starve the query path."},
        {who:"intv",text:"Why treat a location update so differently from a normal API write?"},
        {who:"cand",text:"Because durability barely matters for it. If I lose one driver's update, the next one is ~4s away and overwrites it anyway — it's a stream of disposable, latest-wins samples, not a ledger. So I don't want the heavyweight request lifecycle (per-request TLS handshake, ack, retry-until-durable) I'd give a payment. I want a cheap, persistent, fire-and-forget channel. That realization is why I'll pull updates onto their own lightweight ingest path rather than run 250K/s through the query stack."},
      ],resources:[{title:"System Design Primer — application layer",url:"https://github.com/donnemartin/system-design-primer#application-layer"}]},
      {l:"hard",tag:"scaling",q:"Drivers stream every few seconds — absorb the firehose (adds ingest).",reveal:["location"],turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> 1M drivers each report GPS every 4 seconds — 250K writes/s, sustained, 24/7. If every update opens a fresh TLS connection and flows through your full auth-and-query stack to the match service, the edge melts. What do you do?</span>"},
        {who:"cand",text:"I separate the write firehose from the query path entirely by adding a dedicated <strong>location-ingest service</strong>. Drivers hold a <strong>persistent connection</strong> (gRPC stream or WebSocket) so there's no per-update handshake; updates are tiny binary frames sent fire-and-forget, and ingest batches them before touching the store and index. Let me add the ingest component — it's a specialized write tier that does nothing but swallow and normalize position updates at 250K/s.<span class='eg'>250K updates/s x ~100 bytes ≈ 25 MB/s of raw ingest — trivial bandwidth; the cost is connection and op count, not volume.</span>"},
        {who:"intv",text:"Persistent connections for a million drivers — that's a lot of open sockets. Worth it?"},
        {who:"cand",text:"Yes. A million idle-ish long-lived connections spread across an ingest fleet is cheap (a few hundred K per node with an event-loop server); the alternative — 250K TLS handshakes/s — is far more expensive in CPU. Persistent connections also let me push adaptive reporting back to the client (slow down when stationary) and cut the firehose at the source. The ingest tier scales horizontally by driver count and pins each driver to one node via the LB, so a node only manages its own slice of connections."},
      ],resources:[
        {title:"System Design Primer — asynchronism",url:"https://github.com/donnemartin/system-design-primer#asynchronism"},
        {title:"Redis geospatial (GEOADD write path)",url:"https://redis.io/docs/latest/develop/data-types/geospatial/"},
      ]},
      {l:"medium",tag:"concept",q:"A misbehaving driver app spams updates — protect the edge.",turns:[
        {who:"intv",text:"A buggy driver build starts sending location 50x/s instead of every 4s. Multiply that across a bad rollout. What at the gateway saves you?"},
        {who:"cand",text:"<strong>Per-driver rate limiting</strong> at the edge — a token bucket keyed on driver id that caps updates to, say, 1/s regardless of what the client does. Excess frames are dropped silently (latest-wins, so dropping intermediate samples is harmless). This protects ingest, the store, and the index from a client bug becoming a self-inflicted DDoS."},
        {who:"intv",text:"Dropping updates — could that hide a driver who's actually moving fast?"},
        {who:"cand",text:"No, because I keep the <em>latest</em> frame, not the oldest — the cap throttles frequency, not recency. A driver on a highway still reports position at the capped rate, which at 1/s is plenty for a 2km-radius match. The rate limit only discards the redundant intra-second duplicates a bug would generate. Freshness is bounded by the cap interval, which I set well under my freshness SLO."},
      ],resources:[{title:"System Design Primer — rate limiting",url:"https://github.com/donnemartin/system-design-primer#rate-limiting"}]},
      {l:"hard",tag:"failover",q:"An edge zone holding 300K live driver streams crashes.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a gateway/ingest zone terminating 300K live driver streaming connections crashes. All 300K connections drop at the same instant. What do drivers and riders experience, and how bad is it?</span>"},
        {who:"cand",text:"For a few seconds those 300K drivers' positions stop refreshing — nearby queries in that area see slightly stale drivers, and any expiring entries drop out. It's <em>degraded coverage, not an outage</em>, because location is self-healing: as soon as clients reconnect and send their next frame, positions are current again. Clients reconnect with <strong>exponential backoff plus jitter</strong>, and the LB / anycast steers them to a healthy zone. The whole event is bounded by reconnect time, a handful of seconds."},
        {who:"intv",text:"300K clients reconnecting at once — isn't that a thundering herd that knocks over the healthy zone?"},
        {who:"cand",text:"That's exactly why the backoff is <strong>jittered</strong> — reconnects spread over a window instead of arriving as one spike. The healthy zones also carry connection headroom and autoscale on connection count, and because a fresh connection is cheap (the expensive state is per-offer, not per-stream), absorbing the reconnects is mostly a capacity question. Worst case I shed the oldest or least-important connections first. The key property is that no data needs recovery — reconnect and the next 4s frame restores truth."},
      ],resources:[
        {title:"System Design Primer — availability patterns",url:"https://github.com/donnemartin/system-design-primer#availability-patterns"},
      ]},
    ],
    match:[
      {l:"medium",tag:"capacity",q:"How many match-service instances for the query load?",turns:[
        {who:"intv",text:"Numbers now. You quoted ~20K nearby-queries/s, peak 3-5x. How many match-service instances do you run? Show the math, do not just say autoscale."},
        {who:"cand",text:"The match service is <strong>stateless and CPU-light</strong> per query — compute the rider cell-ring, one index lookup, then haversine on a small candidate set. So I size from a per-instance throughput budget.<span class='eg'>A modern 4-core node handles ~5K queries/s at low latency. Peak ≈ 20K/s x 4 ≈ 80K/s ÷ 5K/s ≈ 16 instances; add ~30% headroom ≈ ~20, spread across 3 AZs.</span>Writes never touch this tier — they go down the ingest path — so it is sized purely by read/query rate."},
        {who:"intv",text:"That budget assumes candidate sets stay small. In a dense downtown cell they do not — does your number still hold?"},
        {who:"cand",text:"That is the real trade-off: per-instance throughput tracks candidates-per-query, and a hot cell can drag back thousands to filter, so effective capacity drops right where load spikes. I lean on <strong>capping candidates</strong> (nearest N, so per-query work stays bounded) and <strong>caching hot cells</strong> candidate sets for a sub-second TTL, trading a beat of freshness for flat query cost. Decision: size the warm floor for normal spread load (~20 instances), autoscale on request rate above it, and rely on the cap to keep a surge from blowing the per-query budget."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope calculations",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"System Design Primer — application layer",url:"https://github.com/donnemartin/system-design-primer#application-layer"},
      ]},
      {l:"easy",tag:"concept",q:"How does 'find drivers near me' actually work? (adds geo index)",reveal:["index"],turns:[
        {who:"intv",text:"A rider at a lat/lng wants drivers within 2km. The naive version scans every driver and computes distance. At 1M drivers per query that's dead on arrival. How do you actually do it?"},
        {who:"cand",text:"I can't scan all drivers, so I need a <strong>spatial index</strong> that buckets the earth's surface into cells and lets me jump straight to the cells near the query point. Look up the rider's cell, gather the drivers bucketed there, and only then compute exact distances on that small candidate set. Let me add a <strong>geo index</strong> — it turns 'search 1M drivers' into 'search a few dozen in a handful of cells'.<span class='eg'>2km radius, ~1km cells → ~9 cells to check; each holds tens of drivers, not a million.</span>"},
        {who:"intv",text:"Why check neighbor cells — why not just the rider's own cell?"},
        {who:"cand",text:"Because the rider can stand near a cell boundary, and the closest driver can be just across it in an adjacent cell. So I query the rider's cell <strong>plus its neighbors</strong> (the surrounding ring), union the candidates, then run <strong>haversine</strong> distance on each to filter to the true radius and sort by distance/ETA.<span class='eg'>Rider 50m from the east edge of their cell → a driver 60m away sits in the neighbor cell; skip neighbors and you miss the nearest car.</span>The index gets me the candidate set cheaply; haversine gives the exact answer."},
      ],resources:[
        {title:"Geohash — cells and prefixes",url:"https://en.wikipedia.org/wiki/Geohash"},
        {title:"System Design Primer — use good indices",url:"https://github.com/donnemartin/system-design-primer#use-good-indices"},
      ]},
      {l:"medium",tag:"concept",q:"You found nearby drivers — how does one get the ride? (adds dispatch)",reveal:["notify"],turns:[
        {who:"intv",text:"Your query returns 12 nearby drivers for a ride request. What happens next — how does one of them actually get the trip?"},
        {who:"cand",text:"Finding candidates is only half the job; now I <strong>match and dispatch</strong>. The match service ranks the 12 (ETA, rating, acceptance likelihood), picks the best, and pushes a <strong>ride offer</strong> to that driver's phone, then waits for accept within a short timeout. That push to a specific driver is its own concern — I'll add a <strong>dispatch / notify</strong> component that owns the offer lifecycle and the live channel to driver apps."},
        {who:"intv",text:"Why not just broadcast the offer to all 12 and let the fastest accept win?"},
        {who:"cand",text:"Broadcast causes a thundering accept race — 12 drivers tap 'accept', 11 lose, everyone's annoyed, and you burn driver trust. Instead dispatch offers <strong>sequentially or in small parallel batches</strong> with a per-offer timeout: offer to the best driver, and on decline or timeout move to the next.<span class='eg'>Offer to driver #1 with a 10s timeout; no answer → auto-advance to #2 — riders wait seconds, not minutes, and no driver gets a phantom trip.</span>"},
      ],resources:[{title:"System Design Primer — application layer",url:"https://github.com/donnemartin/system-design-primer#application-layer"}]},
      {l:"hard",tag:"scaling",q:"Surge concentrates queries into a few downtown cells.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a concert lets out and nearby-query rate downtown jumps from 20K/s to 100K/s, almost all of it in three adjacent city cells. Your match fleet was sized for spread-out normal load. What falls over and what do you do?</span>"},
        {who:"cand",text:"The match service itself is <strong>stateless</strong>, so it autoscales horizontally on request rate — that part is easy. The real pressure lands on the <em>index cells</em> those queries hit: three cells now serve most of 100K/s, so the index shards holding them get hot (we should dig into that on the index box). At the match layer my levers are: <strong>cache the hot cells' candidate sets</strong> for a sub-second TTL — dozens of near-identical queries per second on the same cell can share one index read — and coalesce concurrent identical queries into one."},
        {who:"intv",text:"A cached candidate set goes stale as drivers move. Is a sub-second-old nearby list acceptable?"},
        {who:"cand",text:"Yes, and that's the crucial trade: a driver moves maybe 10-15m in a second, well inside a 2km radius, so a ~1s-old candidate set is materially identical to a live one. I'm choosing <strong>freshness-for-throughput</strong> deliberately — a slightly stale but instant answer beats a perfectly fresh one that times out under load. I still run exact haversine on the (cached) candidates against the live query point, so ranking is precise even if membership is a beat behind."},
      ],resources:[
        {title:"System Design Primer — caching",url:"https://github.com/donnemartin/system-design-primer#cache"},
        {title:"bytebytego — system design patterns",url:"https://bytebytego.com/"},
      ]},
      {l:"medium",tag:"durability",q:"A match instance dies holding 500 in-flight ride offers.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a match/dispatch instance is orchestrating 500 in-flight ride offers — each one 'offered to driver X, waiting for accept'. The pod gets SIGKILLed. What happens to those 500 riders and drivers?</span>"},
        {who:"cand",text:"It hurts only if that offer state lived in the pod's memory — so it must not. I keep <strong>in-flight offer state in a short-TTL external store</strong> (Redis) keyed by request id: which driver was offered, the timeout, the candidate list. When the pod dies, another instance either resumes from that state or the offer simply <strong>times out</strong> and the request re-enters matching. Because re-matching is idempotent on the request id, a pod death becomes a few-second delay for those riders, not a lost ride."},
        {who:"intv",text:"On resume you might re-offer to a driver who already accepted on the dead node. Double-booking?"},
        {who:"cand",text:"Guarded by an <strong>atomic claim</strong> on the ride: acceptance does a compare-and-set on the trip record (assigned == null → driverX) that's strongly consistent for that one key. So even if two paths race — a resumed offer and a late accept from the dead node — exactly one wins the CAS and the other gets 'already taken'. The location reads are eventual and cheap; only this single assignment write needs strong consistency, and it's one tiny conditional op per trip."},
      ],resources:[
        {title:"Redis geospatial + atomic ops",url:"https://redis.io/docs/latest/develop/data-types/geospatial/"},
      ]},
      {l:"hard",tag:"failover",q:"The index is briefly unreachable — fail the query or fake it?",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> the geo index for a region is briefly unreachable — a failover in progress, ~5s of unavailability. Nearby queries there can't get a candidate set. Do you return an error, or something else?</span>"},
        {who:"cand",text:"I return something, not an error — this is a system where <strong>availability beats consistency</strong>. A rider seeing a slightly stale or slightly smaller set of nearby drivers is a good experience; a rider seeing 'no drivers available, try again' when the streets are full of cars is a terrible one. So I degrade: serve from the <strong>last-known cached candidate sets</strong> for those cells, or read approximate positions directly from a location-store replica, and mark the result best-effort."},
        {who:"intv",text:"Serving stale data could match a rider to a driver who's already gone. Where's the floor?"},
        {who:"cand",text:"The floor is freshness bounded by TTL — I never serve positions older than, say, 15s, because expired entries drop out of both index and store. Within that window the worst case is a driver who moved a couple hundred meters, which dispatch corrects anyway: the offer goes out, and if that driver is now too far or unresponsive it times out and dispatch advances to the next candidate. So staleness self-corrects at the dispatch step. I'd rather degrade-and-correct than hard-fail the query."},
      ],resources:[
        {title:"System Design Primer — availability patterns",url:"https://github.com/donnemartin/system-design-primer#availability-patterns"},
        {title:"bytebytego — availability vs consistency",url:"https://bytebytego.com/"},
      ]},
      {l:"medium",tag:"concept",q:"No drivers in the radius — now what?",turns:[
        {who:"intv",text:"The rider's 2km radius comes back empty — zero drivers in those cells. What does the query do?"},
        {who:"cand",text:"<strong>Expand the search ring outward</strong> and retry against the next band of cells, up to a max radius. Proximity search is naturally hierarchical: start tight, grow only if needed.<span class='eg'>2km empty → try 5km → try 10km, stopping as soon as I have enough candidates or hit the cap.</span>This keeps the common dense-city case cheap (one small ring) while still serving a rider in a sparse suburb who genuinely has the nearest car 8km away."},
        {who:"intv",text:"Expanding rings on every sparse query — does that hammer the index?"},
        {who:"cand",text:"Only in sparse regions, which are by definition low-query-volume, so it's fine. And it composes with adaptive resolution: sparse areas use <em>coarse</em> cells, so 'expand the ring' there means a couple of large cells, not hundreds of tiny ones. Dense areas never expand because the first tight ring already overflows with candidates. The cost scales with sparsity, which is inversely correlated with load — the expensive queries are the rare ones."},
      ],resources:[{title:"Quadtree — hierarchical spatial search",url:"https://en.wikipedia.org/wiki/Quadtree"}]},
    ],
    db:[
      {l:"medium",tag:"capacity",q:"How much memory and how many nodes for the location store?",turns:[
        {who:"intv",text:"Size the location store. ~1M drivers at ~100 bytes each, 250K writes/s, ~20K reads/s peak. How much RAM, and how many nodes?"},
        {who:"cand",text:"Storage is almost a non-issue here; throughput is what forces the node count.<span class='eg'>Working set: 1M drivers x ~150 bytes (position + status + ts) ≈ 150 MB — trivially in RAM on one box. Throughput: 250K writes/s ÷ ~100K ops/s/node ≈ 3 shards; x replica factor 2 (primary + AZ replica) ≈ 6 nodes; peak reads ~80K/s spread over the same shards add headroom, not new shards.</span>So I provision ~6 nodes driven by write ops, not by bytes."},
        {who:"intv",text:"If the whole working set fits in a few hundred MB on one node, why shard at all?"},
        {who:"cand",text:"Exactly the trade-off — I am sharding for <strong>write throughput and blast radius</strong>, not capacity. One node cannot take 250K writes/s, and a single node is one failure domain. The cost is that geo-sharding follows population, so a Manhattan shard bakes while a rural shard idles. Decision: shard by <strong>density not land area</strong> — split hot metros into more shards, merge sparse regions — and run each shard as a replica group across AZs. I spend nodes on ops/s and availability, and treat the tiny memory footprint as free."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope calculations",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"Redis geospatial data type",url:"https://redis.io/docs/latest/develop/data-types/geospatial/"},
      ]},
      {l:"hard",tag:"concept",q:"Which store holds current positions — in-memory, PostGIS, or Cassandra?",turns:[
        {who:"intv",text:"This is the store decision, so let's do it properly. First pin the load this thing has to take, then pick a datastore and defend it against the obvious alternatives."},
        {who:"cand",text:"Load first, because it drives everything. ~1M active drivers each report every ~4s → <strong>~250K position writes/s sustained</strong>, and every write is a blind overwrite of one driver's current position (latest-wins, no history). Reads are ~20K nearby-queries/s, peak 3-5x to ~80K/s. Each record is tiny — driverId, lat, lng, ts, status, well under 100 bytes.<span class='eg'>Full working set ≈ 1M x ~150 bytes ≈ 150 MB — the entire live-positions set fits in RAM on a single box.</span>So the shape is: a firehose of tiny overwrites plus a smaller stream of point-radius reads, over a working set that is trivially small. That shape, not storage size, decides the store."},
        {who:"intv",text:"Fine — so name the candidates and give me the per-node throughput ceiling for each, with the node math."},
        {who:"cand",text:"Three realistic options, and the ceilings are what separate them. <strong>In-memory KV with geo (Redis GEO)</strong>: a single node does on the order of ~100K ops/s of GEOADD/GEOSEARCH before latency climbs.<span class='eg'>250K writes/s ÷ ~100K ops/s/node ≈ 3 write shards; x2 for primary + AZ replica ≈ 6 nodes; peak ~80K reads/s ride the same shards as headroom.</span><strong>PostGIS (Postgres + GiST spatial index)</strong>: durable, but every write is an fsync-backed row update that churns the spatial index, so a node sustains only ~5-10K such writes/s.<span class='eg'>250K ÷ ~8K/node ≈ 30+ write nodes, and constant lat/lng updates bloat the GiST index and pile on vacuum — you fight the DB to stand still.</span><strong>Cassandra (LSM)</strong>: absorbs writes well, ~30-50K/s/node.<span class='eg'>250K ÷ ~40K ≈ 6-7 nodes for writes alone — but it has no native radius query, and latest-wins overwrites become a stream of LSM inserts that generate tombstones and heavy compaction for data that lives ~15s.</span>Redis needs the fewest nodes and is the only one with a native point-radius primitive."},
        {who:"intv",text:"So why does in-memory actually beat a durable DB on this hot path — isn't losing positions dangerous?"},
        {who:"cand",text:"It beats them precisely because durability is worthless here. A position is a <strong>latest-wins, self-healing sample</strong>: if I lose one, the driver's next report ~4s later overwrites it anyway, so a WAL or fsync only slows the 250K/s write path to protect data that regenerates for free. A durable DB spends its whole budget — commit logs, index maintenance, compaction — defending exactly the property I don't need. So I keep the hot store <strong>purely in memory, ephemeral, TTL ~15s per entry</strong> (a driver who goes dark simply ages out). What is persisted is only the fork that leaves the hot path: ingest also publishes each update to <strong>Kafka</strong>, and that stream feeds the durable history / analytics / billing pipeline off the critical path. Ephemeral-and-fast for live matching; durable-and-slow over there."},
        {who:"intv",text:"You keep saying 'point-radius' — how does the store actually turn 'drivers within 2km' into something cheap rather than scanning a million rows?"},
        {who:"cand",text:"Through the <strong>spatial index</strong>, which is the whole reason this isn't a full scan. Every position is bucketed by its cell: I map lat/lng to a <strong>geohash prefix / H3 cell</strong> and keep a <code>cell → set of driverIds</code> mapping (Redis GEO does this under the hood as a geohash-scored sorted set). A radius query then becomes a handful of <strong>cell lookups</strong>, not a scan: compute the rider's cell plus its neighbor ring, union the driverIds bucketed in those few cells, and only then run exact haversine on that small candidate set.<span class='eg'>2km radius over ~1km cells → ~9 cell lookups returning a few dozen candidates, versus haversine over all 1M rows — query cost tracks nearby density, not fleet size.</span>"},
        {who:"intv",text:"Give me the schema, and then the one-line decision — what you picked and why not the other two."},
        {who:"cand",text:"Schema is deliberately thin: <code>driverId → {lat, lng, ts, status}</code> as the value, geohash/H3 cell as the sort/index key, latest-wins overwrite, TTL ~15s. No joins, no history rows, no wide columns. <strong>Decision: in-memory KV with native geo (Redis GEO), geo-sharded by density, replica per AZ.</strong> Not PostGIS — its durability and GiST maintenance make it ~5-10K writes/s/node, so ~30+ nodes fighting vacuum to serve data that doesn't need to survive. Not Cassandra — great write absorption but no native radius query and wasteful compaction on ~15s-lived overwrites. Redis wins on all three axes that matter here: native point-radius, ~100K ops/s/node so the fleet is ~6 nodes, and zero wasted effort on a durability guarantee the self-healing stream already provides for free."},
      ],resources:[
        {title:"Redis geospatial data type",url:"https://redis.io/docs/latest/develop/data-types/geospatial/"},
        {title:"PostGIS spatial indexing (GiST)",url:"https://postgis.net/workshops/postgis-intro/indexing.html"},
        {title:"System Design Primer — SQL or NoSQL",url:"https://github.com/donnemartin/system-design-primer#sql-or-nosql"},
      ]},
      {l:"hard",tag:"scaling",q:"250K writes/s to one store node — how do you shard?",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> 250K position writes/s plus 20K geo-queries/s all hit one store node. A single Redis node tops out well before that. How do you shard it?</span>"},
        {who:"cand",text:"<strong>Shard by geography</strong> — partition the world into regions and route each driver's writes and each rider's queries to the shard owning that area.<span class='eg'>SF-bay on shard A, NYC on shard B, London on shard C — a driver in SF only ever writes to shard A; a rider in SF only queries shard A.</span>This is the ideal partitioning because the workload is inherently local: proximity is a local question, so a geo-region shard makes almost every query single-shard, and writes spread by where drivers physically are."},
        {who:"intv",text:"Drivers aren't spread evenly. What happens to your NYC shard versus your Montana shard?"},
        {who:"cand",text:"That's the core weakness of geo-sharding — <strong>load follows population, not area</strong>, so a Manhattan shard bakes while a Montana shard idles. Fix: size shards by <em>density</em>, not land area — subdivide hot metros into many fine shards (Manhattan alone might be several) and merge sparse rural regions into one. It's the same adaptive-resolution idea as the index. I monitor per-shard write/query load and split hot shards. And a truly extreme single-cell spike is its own problem worth covering — the New Year's Eve case."},
      ],resources:[
        {title:"Geohash prefixes for region sharding",url:"https://en.wikipedia.org/wiki/Geohash"},
        {title:"System Design Primer — sharding",url:"https://github.com/donnemartin/system-design-primer#sharding"},
      ]},
      {l:"hard",tag:"durability",q:"The in-memory store crashes and loses every current position.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> 3am, the in-memory node holding the SF region OOMs and restarts <b>empty</b>. Every current driver position for SF just vanished. Are you in trouble?</span>"},
        {who:"cand",text:"Surprisingly little, and this is the nicest property of the whole design: <strong>location data regenerates itself</strong>. Every SF driver re-reports within ~4s, so the store <em>refills to full accuracy within seconds</em> of coming back. There's no backup to restore, no WAL to replay — the source of truth is the drivers themselves, streaming continuously. Durability requirements here are unusually low <em>because</em> the data is disposable and self-healing. I deliberately don't pay for disk persistence on this hot path; it would only slow the 250K/s writes."},
        {who:"intv",text:"But for those few seconds SF has no drivers in the index at all. Riders querying then?"},
        {who:"cand",text:"They'd see under-coverage for that brief window, which is why I don't rely on the self-heal alone — I run each shard as a <strong>replica group</strong> (primary + replica in another AZ). A single node restart <em>fails over to the replica</em>, which already has the positions, so there's no empty window at all in the common case. The self-heal is the backstop for the rare double-failure. So: replicas kill the window for single failures; self-heal makes even a total wipe a seconds-long, zero-data-loss event."},
      ],resources:[
        {title:"Redis geospatial + replication",url:"https://redis.io/docs/latest/develop/data-types/geospatial/"},
        {title:"System Design Primer — replication",url:"https://github.com/donnemartin/system-design-primer#replication"},
      ]},
      {l:"hard",tag:"failover",q:"A query at a shard border misses drivers just across the line.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> you shard by region. A rider stands one block from the boundary between the 'SF-north' and 'SF-south' shards. The three closest drivers are just across the line, in the other shard. Your query hits only the rider's shard and returns them nothing useful. Bug?</span>"},
        {who:"cand",text:"Yes — a real correctness bug, the <strong>edge-of-shard problem</strong>. Sharding by region draws arbitrary lines through continuous space, and proximity doesn't respect them. The fix is that a border query must <strong>fan out to the neighboring shards</strong> whenever the search radius crosses a boundary: detect that the rider's cell-ring spills into an adjacent shard, query both, and union the candidates before haversine filtering. It's the same neighbor-cell logic as the index, just applied across shard lines instead of cell lines."},
        {who:"intv",text:"Fanning out to neighbors on every query near a border adds latency and load. Acceptable?"},
        {who:"cand",text:"It's bounded and worth it. Only queries whose radius actually crosses a boundary fan out, and even then it's to 2-3 shards, done in parallel, so latency is a scatter-gather, not a sum. To cut it further I can <strong>replicate a thin overlap band</strong> along each border into both neighboring shards — drivers within, say, 2km of the line exist in both — so most border queries stay single-shard. Trade a little write duplication in the overlap for single-shard border reads. Either way, silently missing the three nearest cars is not an option."},
      ],resources:[
        {title:"System Design Primer — sharding trade-offs",url:"https://github.com/donnemartin/system-design-primer#sharding"},
        {title:"Uber H3 — hierarchical hex grid",url:"https://www.uber.com/blog/h3/"},
      ]},
    ],
    index:[
      {l:"medium",tag:"capacity",q:"How much memory and how many nodes for the geo index?",turns:[
        {who:"intv",text:"Size the geo index. It buckets ~1M drivers into cells and takes the same update stream. How much memory does it hold, and how many nodes?"},
        {who:"cand",text:"The index is <strong>derived, compact state</strong> — a mapping of cell to the driver ids bucketed there, plus per-cell counts — so its footprint is small.<span class='eg'>1M drivers x (id + cell reference + overhead) ~ a few tens of bytes ≈ ~50-100 MB, plus cell metadata. Op load: 250K updates/s arrive, but only ~1 in 15 crosses a cell boundary ≈ ~17K index moves/s, on top of the query lookups (~80K/s peak).</span>So index writes are far below the raw firehose; I size nodes from lookups + hot cells, not from 250K/s."},
        {who:"intv",text:"It is small and rebuildable — so why not just run one node?"},
        {who:"cand",text:"Because availability, not memory, sets the count. The trade-off: one node is cheapest but a crash blanks the busiest region mid-surge. Since the index is <strong>derived from the location store</strong> it rebuilds in seconds, so I do not pay for durability — but I do run <strong>replica groups</strong> so a failover needs no rebuild, and I <strong>shard hot metros</strong> so no single node owns a scorching cell. Decision: a handful of nodes sized by lookup rate and per-cell density, replicated per AZ, with the cheap rebuild as the backstop rather than the primary defense."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope calculations",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"Uber H3 — hexagonal hierarchical index",url:"https://www.uber.com/blog/h3/"},
      ]},
      {l:"medium",tag:"concept",q:"Geohash vs quadtree vs H3 — how do you bucket the earth?",turns:[
        {who:"intv",text:"You added a geo index. How do you actually partition the earth's surface into buckets? Walk me through the options and what you'd pick."},
        {who:"cand",text:"Three main schemes. <strong>Geohash</strong>: interleave lat/lng bits into a base32 string; nearby points share a prefix, so it's dead simple and range-scannable.<span class='eg'>'9q8yy' is a ~150m cell in SF; drop a char → a coarser ~1km cell.</span><strong>Quadtree</strong>: recursively split each square into four, subdividing deeper only where it's dense — naturally adaptive. <strong>Uber H3</strong>: tile the globe with <em>hexagons</em> at fixed resolutions. My default is H3, because for moving objects and distance the hexagon geometry matters."},
        {who:"intv",text:"Why do hexagons matter? What's wrong with geohash's grid?"},
        {who:"cand",text:"Two problems with geohash. First, the <strong>neighbor-edge problem</strong>: two points a few meters apart across a cell boundary can have very different prefixes, so 'nearby in space' isn't 'nearby in the index' — you must compute the 8 neighbor cells explicitly, and rectangular cells have <em>diagonal</em> neighbors at a different distance than edge neighbors. <strong>H3 hexagons</strong> fix this: every cell has exactly <strong>6 neighbors, all equidistant from the center</strong>, so 'expand by one ring' is uniform in every direction — much cleaner for radius queries, movement, and ETA than a grid with awkward corners."},
      ],resources:[
        {title:"Uber H3: hexagonal hierarchical index",url:"https://www.uber.com/blog/h3/"},
        {title:"Geohash",url:"https://en.wikipedia.org/wiki/Geohash"},
      ]},
      {l:"hard",tag:"scaling",q:"Downtown SF puts 100K drivers in one cell — imbalance.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> you pick one fixed cell size, ~1km. Rural cells hold 3 drivers; downtown SF at rush hour packs 100K drivers into a single cell. A query on that cell drags back 100K candidates to haversine-filter — slow — and that cell's shard is on fire. Fix it.</span>"},
        {who:"cand",text:"Fixed resolution is the mistake — one cell size can't serve both a dense metro and an empty prairie. The answer is <strong>adaptive resolution</strong>: use fine cells where it's dense and coarse cells where it's sparse. H3 and quadtree both support this directly — H3 has multiple resolution levels, a quadtree subdivides a hot square into four (and again, and again) until each leaf holds a manageable count.<span class='eg'>Downtown → H3 res ~10 (~65m cells) so a cell holds tens of drivers; rural → res ~7 (~1km) so you don't query thousands of empty cells.</span>"},
        {who:"intv",text:"How do you decide a cell's resolution dynamically, and what about the New Year's Eve extreme — 100K in one spot no matter how fine you cut?"},
        {who:"cand",text:"I track <strong>per-cell density</strong> and subdivide any cell that crosses a count threshold, promoting hot areas to finer resolution automatically. For the pathological Times Square case where even fine cells overflow, I add two guards: <strong>cap candidates per query</strong> (a rider doesn't need 100K drivers — return the nearest N and stop), and <strong>spread the hot cell across shards</strong> so no single node owns all 100K. And I let dispatch, not the query, do the heavy discrimination — the query just needs enough nearby candidates, not all of them."},
      ],resources:[
        {title:"Uber H3 — variable resolution",url:"https://www.uber.com/blog/h3/"},
        {title:"Quadtree — adaptive subdivision",url:"https://en.wikipedia.org/wiki/Quadtree"},
      ]},
      {l:"hard",tag:"failover",q:"The downtown-SF index node fails during a surge.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> Friday 6pm surge, and the index shard serving downtown SF — your densest, busiest region — crashes hard. Every nearby query downtown now fails. What do riders see and how do you stop it?</span>"},
        {who:"cand",text:"Without protection: downtown queries error out at the worst possible moment. But the index has a saving grace — it's <strong>derived, rebuildable state</strong>, not a source of truth. It's just a bucketed view of the location store, which is itself refilled by drivers every 4s. So I run index shards as <strong>replica groups</strong>: a downtown shard has a hot standby in another AZ that takes over on failure with no rebuild needed. Availability-first — a slightly stale standby serving queries beats a correct-but-dead primary."},
        {who:"intv",text:"And if both replicas of that hot shard are gone — full loss. How long to rebuild, under surge?"},
        {who:"cand",text:"Rebuild is bounded by the working-set size, which is small — downtown's positions are a few tens of MB — so a cold rebuild from the location store (or from the next round of driver updates) is seconds, not minutes. During that window I <strong>degrade gracefully</strong>: serve last-known candidate sets from the match-layer cache and expand rider radius to pull from neighboring healthy shards. Because the index is disposable and cheap to reconstruct, even total loss of a shard is a short, self-correcting brownout rather than an outage."},
      ],resources:[
        {title:"System Design Primer — availability patterns",url:"https://github.com/donnemartin/system-design-primer#availability-patterns"},
        {title:"Uber H3 on GitHub",url:"https://github.com/uber/h3"},
      ]},
      {l:"medium",tag:"concept",q:"Drivers move — how does the index stay fresh?",turns:[
        {who:"intv",text:"Your indexed objects are moving constantly. When a driver drives from one cell into the next, how does the index track that without you re-indexing a million drivers every few seconds?"},
        {who:"cand",text:"On each update I compute the driver's <strong>current cell</strong> and compare it to their last cell. If it's unchanged — which it usually is, since a driver rarely crosses a cell boundary within 4s — I do <em>nothing</em> to the index, just refresh the position and TTL. Only on a <strong>cell change</strong> do I move them: remove from the old cell's bucket, add to the new one.<span class='eg'>At 65m cells and city speeds, maybe 1 in 10-20 updates crosses a boundary → index writes drop ~10-20x versus re-indexing every update.</span>"},
        {who:"intv",text:"How do you keep a driver who went offline from lingering in a cell forever?"},
        {who:"cand",text:"<strong>TTL on every entry</strong> — a position expires if it isn't refreshed within, say, 2-3x the report interval (~10-15s). A driver who loses signal or shuts off simply ages out and stops appearing in queries, no explicit delete needed. This is how the index self-cleans: presence is a lease that must be renewed by the next update. It also means freshness is bounded by construction — nothing in the index is ever older than the TTL."},
      ],resources:[
        {title:"Redis geospatial + TTL",url:"https://redis.io/docs/latest/develop/data-types/geospatial/"},
        {title:"Uber H3 — cell indexing",url:"https://github.com/uber/h3"},
      ]},
    ],
    location:[
      {l:"medium",tag:"capacity",q:"How many ingest instances and partitions for the firehose?",turns:[
        {who:"intv",text:"Size the ingest tier. ~1M persistent driver streams landing ~250K updates/s. How many ingest nodes and how do you partition them?"},
        {who:"cand",text:"Like the edge, ingest is <strong>connection-bound plus write-op-bound</strong>, so I size against both and take the max.<span class='eg'>Connections: 1M streams ÷ ~250K/node ≈ 4 nodes. Writes: 250K updates/s, batched 50-100ms and collapsed to latest-per-driver, so effective downstream writes are well under 250K/s; at ~50K normalized ops/s/node ≈ 5 nodes. Max ≈ 5, add headroom ≈ ~8 nodes.</span>I partition by driver id so each node owns a fixed slice of streams and batches within it."},
        {who:"intv",text:"Batching to hit those numbers adds latency, and pinning drivers to nodes adds routing rigidity. Worth it?"},
        {who:"cand",text:"Yes on both, and it is a deliberate trade. The batch window is 50-100ms against a freshness budget of a few seconds — the dominant staleness is the 4s report interval, so batching is effectively free while it slashes downstream op count. Sticky per-driver routing lets a node keep latest-wins state locally and dedupe before writing. Decision: partition by driver id, autoscale on <strong>queue lag and connection count</strong> rather than CPU, and load-shed stale updates under pressure so ingest stays near real-time instead of buffering work nobody wants."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope calculations",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"System Design Primer — asynchronism",url:"https://github.com/donnemartin/system-design-primer#asynchronism"},
      ]},
      {l:"hard",tag:"scaling",q:"Index 250K moving-object writes/s without write amplification.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> 250K updates/s arrive. If each one writes the store AND updates the index — remove from old cell, add to new — that's 500K+ ops/s of write amplification, and it kills you. Design the ingest write path.</span>"},
        {who:"cand",text:"I cut the work per update to the minimum. Ingest terminates the driver streams, <strong>batches</strong> updates (say 50-100ms windows), and for each driver writes only the <em>latest</em> position — intermediate samples in the batch are dropped, latest-wins. The store write is a single overwrite. The index write is <strong>conditional</strong>: only touch the index when the driver's cell changed, which is the minority of updates. That turns '500K index ops/s' into a fraction of that.<span class='eg'>250K updates/s, ~1 in 15 crosses a cell → ~17K index moves/s, not 250K.</span>"},
        {who:"intv",text:"Batching adds latency. How stale can a position get before it's a problem?"},
        {who:"cand",text:"The freshness budget is a few seconds, and a 50-100ms batch window is negligible against that — the dominant staleness is the 4s report interval, not my batching. I attach a <strong>TTL</strong> (~10-15s) to every position so a driver who stops reporting ages out automatically, and I monitor <strong>end-to-end freshness</strong> (report time → queryable) as the real SLO. As long as that stays a couple of seconds, batching for throughput is free."},
      ],resources:[
        {title:"System Design Primer — asynchronism",url:"https://github.com/donnemartin/system-design-primer#asynchronism"},
        {title:"Redis geospatial write path",url:"https://redis.io/docs/latest/develop/data-types/geospatial/"},
      ]},
      {l:"hard",tag:"failover",q:"Ingest falls behind and positions go stale.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a code push doubles the per-update work and the ingest tier can't keep up. The internal queue backs up and positions are now 30s stale — riders get matched to drivers who already left the area. What do you do?</span>"},
        {who:"cand",text:"The instinct to buffer-and-catch-up is wrong here: for latest-wins location data, a 30s-old update is <em>worthless</em> — I never want to process it. So the ingest tier <strong>load-sheds by dropping stale/old updates and keeping only the newest per driver</strong>, and applies <strong>backpressure</strong> so the queue can't grow unbounded. Combined with autoscaling on queue lag, ingest stays near real-time by design: when overwhelmed, it sheds redundant work rather than falling further behind processing data nobody wants."},
        {who:"intv",text:"You alert on this how — what tells you positions are going stale before riders complain?"},
        {who:"cand",text:"The primary SLO metric is <strong>end-to-end freshness</strong>: the p99 lag between a driver's report timestamp and when it's queryable. I alert the moment that crosses, say, 5s — well before it reaches the point where matches degrade. I'd also watch ingest queue depth and drop rate as leading indicators. And I'd gate the risky deploy behind a canary that watches freshness, so a change that doubles per-update work trips the alarm on 1% of traffic instead of taking the whole fleet stale."},
      ],resources:[
        {title:"System Design Primer — availability patterns",url:"https://github.com/donnemartin/system-design-primer#availability-patterns"},
        {title:"bytebytego — backpressure & load shedding",url:"https://bytebytego.com/"},
      ]},
      {l:"medium",tag:"concept",q:"How do drivers physically send updates efficiently?",turns:[
        {who:"intv",text:"Concretely, how does a driver's phone push 250K/s worth of updates across the fleet without wrecking batteries or networks?"},
        {who:"cand",text:"A <strong>persistent connection</strong> per driver — gRPC stream or WebSocket over the existing TLS session — so there's no handshake per update. Each update is a <strong>tiny binary frame</strong>: driver id, lat, lng, timestamp, status — well under 100 bytes.<span class='eg'>vs a fresh HTTPS POST per update — headers + TLS setup dwarf the ~30-byte payload; the persistent stream is an order of magnitude cheaper on CPU and battery.</span>Fire-and-forget, no per-message ack, because loss is tolerable."},
        {who:"intv",text:"Can you shrink the firehose itself, not just make each message cheap?"},
        {who:"cand",text:"Yes — <strong>adaptive reporting</strong> driven from the server over that same connection. A parked or stationary driver reports rarely (every 15-30s); a driver moving fast on a highway reports more often; a driver actively being matched reports at full rate. Report frequency should track how much the position actually changes and how likely this driver is to be queried. That can cut the aggregate write rate substantially while keeping the drivers who matter fresh."},
      ],resources:[
        {title:"System Design Primer — communication",url:"https://github.com/donnemartin/system-design-primer#communication"},
      ]},
      {l:"medium",tag:"durability",q:"Ingest crashes with a batch buffered — are updates lost?",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> an ingest node crashes holding a 100ms batch of ~25K buffered updates that hadn't been flushed to the store yet. Those updates are gone. Do you need a durable queue to prevent that?</span>"},
        {who:"cand",text:"No — and adding one would be the wrong call. Those 25K lost updates are each superseded within ~4s by the driver's next report, so the loss is invisible: at worst those drivers' positions are one report-cycle stale for a couple of seconds. This is <strong>at-most-once and that's fine</strong> — the self-healing stream makes a durable write-ahead log pure overhead that would only slow the 250K/s hot path. I spend my durability budget on trip assignments and history, never on disposable position samples."},
        {who:"intv",text:"So is there anything about the ingest path you <em>do</em> make durable?"},
        {who:"cand",text:"Only the fork that leaves the hot path. Alongside the ephemeral position write, ingest publishes updates to <strong>Kafka</strong> for the durable analytics/history pipeline — that stream <em>is</em> persisted and replayable, because trip trails, surge analytics, and billing genuinely need it. So the same update is treated two ways: <em>disposable</em> for live matching (no durability, maximum speed) and <em>durable</em> for the async pipeline (persisted, off the critical path). The hot path stays lean; durability lives where it's actually required."},
      ],resources:[
        {title:"System Design Primer — asynchronism & queues",url:"https://github.com/donnemartin/system-design-primer#asynchronism"},
        {title:"bytebytego — data pipeline patterns",url:"https://bytebytego.com/"},
      ]},
    ],
    notify:[
      {l:"medium",tag:"capacity",q:"How many dispatch nodes for surge offer load?",turns:[
        {who:"intv",text:"Size dispatch. During surge you have tens of thousands of ride requests a second, each fanning offers to nearby drivers. How many dispatch nodes, and how much offer state?"},
        {who:"cand",text:"Dispatch is driven by <strong>ride requests, not the 250K location firehose</strong>, which keeps it far smaller than ingest.<span class='eg'>Surge ~50K ride requests/s; offering sequentially or in 2-3 small parallel batches means ~100-150K live offers at any instant, not 500K. Offer state is tiny — request id, candidate list, timeout — say ~1 KB each ≈ ~150 MB in a short-TTL store. Nodes: 50K req/s ÷ ~5K/s/node ≈ 10, add headroom ≈ ~12.</span>The heavy state is per-offer and short-lived, so the tier is compute-light."},
        {who:"intv",text:"Where does that offer state live, and how do you keep surge in one city from swamping the whole tier?"},
        {who:"cand",text:"The trade-off is holding offer state in-process (fast, but lost on crash) versus externalizing it (survives failover, small latency cost). Decision: keep it in a <strong>short-TTL external store</strong> keyed by request id so a node crash becomes a timeout-and-rematch, not a lost ride. And I <strong>partition dispatch by region</strong> like everything else, so a surging city loads only its own dispatch shards and autoscales them locally — the rest of the world is untouched. I spend a little latency on external state to buy crash-safety and regional isolation."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope calculations",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"bytebytego — real-time system patterns",url:"https://bytebytego.com/"},
      ]},
      {l:"medium",tag:"concept",q:"How does a ride offer reach the driver's phone?",turns:[
        {who:"intv",text:"Dispatch picks a driver and sends a ride offer. How does that actually reach their phone, and how do you know they got it?"},
        {who:"cand",text:"Over a <strong>persistent connection</strong> to the driver app — the same streaming channel the app already holds for reporting location works in reverse to receive offers, giving low-latency two-way messaging. Dispatch pushes the offer, starts a timeout, and waits for an accept/decline frame back. If the socket is dead, I fall back to a <strong>push notification</strong> (APNs/FCM) to wake the app, which then reconnects and pulls the pending offer."},
        {who:"intv",text:"Networks flap — an offer might be delivered twice, or an accept lost. How do you keep that clean?"},
        {who:"cand",text:"Every offer carries an <strong>offer id</strong>, and the driver app is idempotent on it — receiving the same offer twice shows one card, not two. Accept is idempotent too: a retried accept for an offer already resolved just returns the current state. The authoritative decision isn't 'did the accept message arrive' but the <strong>atomic claim</strong> on the trip, so duplicate or lost messages can't create a double assignment — they resolve against a single source of truth."},
      ],resources:[
        {title:"System Design Primer — communication",url:"https://github.com/donnemartin/system-design-primer#communication"},
      ]},
      {l:"hard",tag:"scaling",q:"Surge fans out half a million offers a second.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> during surge, 50K ride requests/s each fan out offers to ~10 nearby drivers — up to 500K offer messages/s — and every one needs a response within ~10s. Design dispatch to carry that.</span>"},
        {who:"cand",text:"First, I don't actually blast 10 offers per request — dispatch offers <strong>sequentially or in small parallel batches</strong> (2-3 at a time) with timeouts, so the real message rate is far below 500K/s and drivers never get phantom offers. Second, dispatch is <strong>partitioned by region</strong> like everything else and scales horizontally, so surge load stays local to the surging city's dispatch shards. Per-offer state is small and short-lived, kept in a fast in-memory store keyed by request id, with timeouts driving progression to the next candidate."},
        {who:"intv",text:"Sequential offers add latency — the rider waits through several 10s timeouts. How do you keep it snappy?"},
        {who:"cand",text:"Tune it two ways. Shrink the per-offer timeout to what a driver realistically needs (a few seconds, not ten), and use <strong>limited parallelism</strong> — offer to the top 2-3 candidates at once and take the first accept, cancelling the rest. That caps rider wait at roughly one timeout while still avoiding a 10-way broadcast race. I also rank candidates by <strong>acceptance likelihood</strong>, not just distance, so the first offer is the one most likely to stick — the best latency win is not needing a second round at all."},
      ],resources:[
        {title:"System Design Primer — application layer",url:"https://github.com/donnemartin/system-design-primer#application-layer"},
        {title:"bytebytego — real-time system patterns",url:"https://bytebytego.com/"},
      ]},
      {l:"hard",tag:"failover",q:"A dispatch node crashes with 5K live offers pending.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a dispatch node handling 5K live ride offers crashes. Each of those riders is staring at a spinner; each of those drivers has a pending offer card. What happens to them?</span>"},
        {who:"cand",text:"Because per-offer state lives in an <strong>external short-TTL store</strong> and not in the node's memory, the state survives the crash. Two recovery routes: another dispatch instance picks up the in-flight offers from that store, or — simpler and usually enough — each offer just <strong>times out</strong> and the request re-enters matching on a healthy node. Riders see the spinner a few seconds longer, then get matched. Because re-matching is idempotent on request id, the crash is a delay, not a lost or double ride."},
        {who:"intv",text:"During recovery, a driver from the dead node might tap accept just as you re-offer to someone else. Two drivers, one ride?"},
        {who:"cand",text:"Prevented by the <strong>atomic claim</strong> on the trip — assignment is a compare-and-set (assigned == null → driverX) that's strongly consistent for that single trip record. Exactly one accept wins the CAS; the other gets 'ride no longer available'. So even with a late accept racing a fresh offer across the crash boundary, the trip can be assigned once and only once. That one small strongly-consistent write is where I spend consistency; everything around it stays fast and eventual."},
      ],resources:[
        {title:"System Design Primer — availability patterns",url:"https://github.com/donnemartin/system-design-primer#availability-patterns"},
        {title:"bytebytego — failover patterns",url:"https://bytebytego.com/"},
      ]},
      {l:"medium",tag:"durability",q:"Two drivers accept the same ride in the same instant.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> one ride is offered to several nearby drivers at once. Two of them tap accept within the same <b>100ms</b>. If both 'win', you've double-dispatched one car.</span>Who gets it, and how do you guarantee exactly one does?"},
        {who:"cand",text:"A <strong>single atomic claim</strong> decides it. The trip record has an <code>assignedDriver</code> field that starts null; accept executes a conditional write — set assignedDriver to me <em>only if</em> it's still null — which the store applies as one linearizable compare-and-set. The first tap wins; the second's condition fails and that driver is told the ride's already taken. There's no window where both succeed, because the store serializes the two writes on that one key.<span class='eg'>SET trip:123 driver=A IF assignedDriver==null → A wins; B's identical write sees non-null and fails.</span>"},
        {who:"intv",text:"Your location data is all eventual consistency. Why is this write suddenly strongly consistent, and doesn't that cost you?"},
        {who:"cand",text:"Because assignment is the one place a wrong answer is <em>unacceptable</em> — double-booking a driver is a real-world failure, unlike a position that's 2s stale. So I scope strong consistency tightly: a single conditional write on a single trip key, which even eventually-consistent stores support per-item. The cost is negligible — one CAS per trip, thousands per second, not millions — versus the 250K/s location writes that stay cheap and eventual. It's the same discipline as the whole design: eventual everywhere it's safe, strong only on the one write that must be."},
      ],resources:[
        {title:"System Design Primer — consistency patterns",url:"https://github.com/donnemartin/system-design-primer#consistency-patterns"},
        {title:"Redis atomic operations",url:"https://redis.io/docs/latest/develop/data-types/geospatial/"},
      ]},
    ],
    client:[
      {l:"medium",tag:"capacity",q:"How big is the firehose the driver fleet generates?",turns:[
        {who:"intv",text:"Before we size servers, size the source. Where does 250K writes/s actually come from, and what does it cost per device and in aggregate?"},
        {who:"cand",text:"It falls straight out of the fleet and the report interval.<span class='eg'>1M active drivers x 1 report / 4s ≈ 250K updates/s. Each frame ~100 bytes → 250K x 100 ≈ 25 MB/s aggregate ingress — trivial bandwidth. Per device it is ~100 bytes every 4s ≈ ~25 B/s, negligible for battery or a data plan.</span>So the cost is never volume — it is the <strong>1M persistent connections</strong> and the <strong>250K ops/s</strong> those reports drive downstream."},
        {who:"intv",text:"So the aggregate is small — is there any reason to touch the client side at all?"},
        {who:"cand",text:"Yes, because the op count and connection load scale with report frequency, and that is a client-side lever. The trade-off is <strong>report interval vs freshness and downstream op cost</strong>: report faster and matches are fresher but the firehose grows; slower and you cut load but risk showing stale cars. Decision: drive the interval <strong>adaptively</strong> — full rate for moving or actively-matched drivers, slow (every 20-30s) for parked ones — which cuts the aggregate substantially without hurting the drivers who might actually be matched. Sizing the fleet this way is what keeps the ingest and edge numbers modest."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope calculations",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"System Design Primer — communication",url:"https://github.com/donnemartin/system-design-primer#communication"},
      ]},
      {l:"easy",tag:"concept",q:"What do the rider and driver apps each do?",turns:[
        {who:"intv",text:"There are two very different clients behind this one box — the rider app and the driver app. What does each do, and why lump them together?"},
        {who:"cand",text:"They share the edge but do opposite things. The <strong>driver app</strong> is a <em>producer</em>: it streams position continuously over a persistent connection and receives ride offers. The <strong>rider app</strong> is a <em>consumer</em>: it issues nearby queries and shows cars on a map. I draw them as one 'client' box for the skeleton because they hit the same gateway, but their traffic profiles — constant small writes vs occasional reads — are what justify the separate ingest and query paths behind it."},
        {who:"intv",text:"The rider's map shows cars gliding around. Is the app querying constantly to animate that?"},
        {who:"cand",text:"No — that would multiply query load pointlessly. The app fetches nearby drivers at a modest interval (every few seconds) and <strong>interpolates</strong> their movement client-side between updates for smooth animation.<span class='eg'>Poll positions every 4s, tween each car along the road in between → looks live at a fraction of the query rate.</span>The map feels real-time while the backend sees far fewer queries than frames rendered."},
      ],resources:[{title:"System Design Primer — communication",url:"https://github.com/donnemartin/system-design-primer#communication"}]},
      {l:"medium",tag:"scaling",q:"Cut the firehose from the client side.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> your 250K writes/s is dominated by drivers who are parked, at red lights, or waiting in an airport queue — barely moving, yet reporting every 4s like everyone else. That's a lot of wasted writes. Reduce it from the client.</span>"},
        {who:"cand",text:"<strong>Adaptive reporting</strong> on the client, driven by motion and context. A stationary driver reports rarely (every 20-30s, or only on a meaningful move); a moving driver reports more often; a driver being actively matched reports at full rate. The phone already has accelerometer / GPS speed, so it can decide locally when a new report is even worth sending.<span class='eg'>If half the active drivers are near-stationary and drop to 1 report/30s, the aggregate write rate falls sharply — roughly 40-50% — with no loss of matching quality.</span>"},
        {who:"intv",text:"A parked driver who suddenly pulls away — do you lose them for 30s?"},
        {who:"cand",text:"No — adaptive reporting is <strong>event-driven, not just timer-driven</strong>: the moment the phone detects motion (speed crosses a threshold), it immediately resumes frequent reporting. So 'parked' reporting is only in effect while genuinely still, and the driver snaps back to full rate on first movement. The server can also <strong>command</strong> a driver back to high frequency when it's about to consider them for a match. Slow reporting applies only to drivers who are both idle and not being matched."},
      ],resources:[
        {title:"System Design Primer — performance antipatterns",url:"https://github.com/donnemartin/system-design-primer#performance-antipatterns"},
        {title:"bytebytego — mobile client patterns",url:"https://bytebytego.com/"},
      ]},
      {l:"medium",tag:"failover",q:"The driver's phone loses connectivity mid-trip.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a driver enters a tunnel — no signal for 90 seconds. Their position stops updating. What does the system do, and what does a nearby rider searching right then see?</span>"},
        {who:"cand",text:"The driver's position <strong>TTL expires</strong> after ~10-15s of no updates, so they drop out of the geo index and won't be offered to new riders while dark — correct, since I can't vouch for where they are. A rider searching then simply doesn't see that car, which is the right call. The driver app <strong>buffers nothing stale</strong>: on reconnect it sends its <em>current</em> position (not a replay of the tunnel), and it's re-indexed within one report cycle. No manual recovery, no ghost car sitting in a tunnel."},
        {who:"intv",text:"What if that driver was mid-offer when the signal dropped?"},
        {who:"cand",text:"The offer <strong>times out</strong> on the dispatch side and the rider is re-matched to another driver — I never let a rider hang on an unreachable driver. When the driver reconnects, dispatch sees the offer already expired (idempotent on offer id) and simply shows nothing, or a 'missed request' — it never assigns a trip to someone who was offline. The atomic claim guarantees the ride went to whoever was actually reachable and accepted, so the tunnel driver reappearing can't retroactively grab a trip that's already been given away."},
      ],resources:[
        {title:"System Design Primer — availability patterns",url:"https://github.com/donnemartin/system-design-primer#availability-patterns"},
      ]},
    ],
  },
  mockTest:[
    {q:"Geohash vs quadtree vs H3 — compare the three and say when each fits.",a:"Geohash interleaves lat/lng bits into a base32 string so nearby points share a prefix — simple and range-scannable, but cells are rectangular with awkward diagonal-vs-edge neighbor distances and prefix jumps at boundaries. Quadtree recursively splits a square into four, subdividing only where it's dense — naturally adaptive to load, good for skewed distributions. H3 tiles the globe with hexagons at fixed resolution levels: every cell has exactly 6 equidistant neighbors, so 'expand one ring' is uniform in all directions — cleanest for radius queries, movement, and ETA. Default to H3 for moving objects; quadtree when you want density-driven adaptive subdivision; geohash when simplicity and prefix range-scans matter most."},
    {q:"You need to absorb ~250K location writes/s that are latest-wins overwrites. What store property matters most, and roughly how many nodes?",a:"What matters is raw overwrite throughput, not durability — each write is a blind latest-wins overwrite of one tiny record. An in-memory KV with geo (Redis GEO) does ~100K ops/s/node, so 250K/s ÷ ~100K ≈ 3 write shards, x2 for primary + AZ replica ≈ ~6 nodes. Storage is a non-issue (working set ~150 MB). Sizing is driven by write ops/s and blast radius, never by bytes."},
    {q:"Why an in-memory ephemeral store for current positions instead of PostGIS or Cassandra?",a:"Durability is worthless on this hot path: a lost position is overwritten by the driver's next report ~4s later, so it self-heals. PostGIS pays fsync + GiST index maintenance and sustains only ~5-10K such writes/s/node (~30+ nodes, fighting vacuum); Cassandra absorbs writes but has no native radius query and generates tombstones/compaction for ~15s-lived overwrites. Redis GEO gives a native point-radius primitive, ~100K ops/s/node, and spends zero effort on a durability guarantee the streaming source already provides. Pick in-memory KV with native geo."},
    {q:"Walk through how a 'drivers within 2km' query executes without scanning the fleet.",a:"Map the rider's lat/lng to its cell (geohash prefix / H3 cell), then compute the surrounding neighbor ring so a driver just across a boundary isn't missed. Look up the cell→driverIds sets for those few cells (~9 cells for a 2km radius over ~1km cells), union them into a small candidate set, then run exact haversine distance on the candidates to filter to the true radius and rank by distance/ETA. Cost tracks nearby density, not the 1M-driver fleet size — it's a few cell lookups plus haversine on a few dozen candidates."},
    {q:"A single cell holds 100K drivers (Times Square, NYE). What breaks and how do you fix it?",a:"A fixed cell size drags back 100K candidates to haversine-filter and pins that one cell's shard at 100% while sparse shards idle. Fix with adaptive resolution: subdivide any cell crossing a density threshold to finer resolution (e.g. H3 res ~10, ~65m cells) so a cell holds tens not thousands. Two guards for the true pathological spot: cap candidates per query (return nearest N and stop — the N+1th is farther than the ones you have, so dispatch's best offer is unchanged), and spread the hot cell across shards so no single node owns the whole crowd. Gather candidates nearest-first so the cap keeps the closest drivers."},
    {q:"Why is it acceptable that the position store is ephemeral with no WAL — what, if anything, is made durable?",a:"Positions are disposable, self-healing samples: every driver re-reports within ~4s, so a wiped node refills to full accuracy in one report cycle, and a WAL would only slow the 250K/s write path to protect data that regenerates for free. Replica groups (primary + AZ replica) kill the empty window for ordinary single-node failures; the self-heal is the backstop for a rare double failure. The only durable fork is off the hot path: ingest also publishes each update to Kafka, feeding the persisted history / analytics / billing pipeline. Durability lives where it's actually required, never on live positions."},
    {q:"A rider one block from a shard boundary — the three nearest drivers are in the neighboring shard. Bug?",a:"Yes — the edge-of-shard problem. Region sharding draws arbitrary lines through continuous space and proximity doesn't respect them, so a query hitting only the rider's shard silently misses the nearest cars — a correctness failure, not a performance one. Fix: when the search radius crosses a boundary, fan out to the 2-3 neighboring shards in parallel (a scatter-gather, so latency is one shard's read), union candidates, then haversine-filter. To cut it further, replicate a thin overlap band (e.g. drivers within 2km of the line) into both neighbors so most border queries stay single-shard — trading a little write duplication for single-shard reads."},
    {q:"How do you keep an offline or disconnected driver from lingering forever in a cell, and keep the index fresh as drivers move?",a:"Every entry carries a TTL of ~10-15s (about 2-3x the report interval): presence is a lease that must be renewed by the next update, so a driver who loses signal or shuts off simply ages out of both index and store — no explicit delete. For movement, on each update compute the driver's current cell and compare to the last one: if unchanged (the common case, since a driver rarely crosses a boundary within 4s) just refresh position and TTL; only on a cell change remove from the old bucket and add to the new. That makes index writes conditional — ~1 in 15 updates — and bounds freshness by construction to the TTL."},
  ]
};
