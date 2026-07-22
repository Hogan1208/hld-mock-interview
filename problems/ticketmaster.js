window.DATA = window.DATA || {};
window.DATA['ticketmaster'] = {
  cat:"concurrency · locking · booking",
  title:"Design a ticket-booking system (Ticketmaster)",
  blurb:"Browse events and book seats; hot on-sales create massive contention for limited inventory — never double-sell a seat.",
  prompt:"Let's design a ticket-booking system like Ticketmaster. Users browse events, pick seats, and pay — but a hot on-sale means hundreds of thousands of people fight over the same limited seats in the same second. The whole game is seat-reservation concurrency: never double-sell a seat. Start with the high-level architecture and rough numbers, then we'll drill into components — and I'll throw failure scenarios at you.",
  opening:"Let me frame it before drawing boxes.<br><br><strong>Functional:</strong> browse/search events, view a live seat map, reserve a specific seat, pay, and receive a ticket. Reservations <em>hold</em> a seat for a few minutes while the user pays. <strong>Non-functional:</strong> the hard invariant is <strong>no double-selling</strong> — a seat maps to exactly one order, ever. Inventory must be <strong>strongly consistent / ACID</strong>; browse and search can be eventually consistent. High availability, and the reserve path must survive a stampede.<br><br><strong>Back-of-envelope:</strong> a stadium tour on-sale: ~100K seats, but <strong>~1M users</strong> hit <code>Buy</code> in the same second. Steady-state browse might be ~10K req/s; the on-sale spike is 100x+ on the reserve path against a tiny, contended inventory. Seat-map reads dwarf writes (~100:1). The scarce resource isn't compute — it's ~100K rows everyone wants to write.<br><br>I'll start deliberately minimal: <strong>client → API gateway → booking service → inventory DB</strong>. The DB is the single source of truth for a seat's state, and that's the skeleton that guarantees correctness. Under pressure I'll grow it — a virtual waiting room to shed load, a seat-map cache, a payment service, and search. Pick a box and let's push.",
  nodes:[
    {id:"client",name:"Client",sub:"web / app",x:40,y:150},
    {id:"gw",name:"API gateway",sub:"edge",x:210,y:150},
    {id:"booking",name:"Booking service",sub:"reserve seats",x:380,y:150},
    {id:"db",name:"Inventory DB",sub:"seats, orders",x:550,y:150},
    {id:"queue",name:"Waiting room",sub:"virtual queue",x:210,y:40},
    {id:"cache",name:"Seat-map cache",sub:"availability",x:380,y:40},
    {id:"payment",name:"Payment service",sub:"charge",x:720,y:150},
    {id:"search",name:"Search / browse",sub:"events",x:550,y:40},
  ],
  edges:[["client","gw"],["gw","booking"],["booking","db"],["booking","cache"],["gw","queue"],["booking","payment"],["gw","search"]],
  core:["client","gw","booking","db"],
  basic:["client","gw","booking","db"],
  dbDoc:{
    component:"Inventory DB",
    load:"~5-10K single-row conditional writes/s at peak on-sale, spread across one event's ~100K distinct seat rows; the truly contended rate (two buyers on the same hot seat) is a tiny slice. Data is trivial — ~100K seats × ~1KB ≈ 100MB/event. The scarce resource is <strong>correctness under concurrency</strong> (one-seat-one-order), NOT raw throughput or bytes: every candidate below can physically serve this write rate.",
    candidates:[
      {name:"Postgres/MySQL (relational, single primary)",ceiling:"~5-10K contended single-row writes/s",nodes:"1 primary + read replicas (replicas don't help writes)",pick:true,note:"chosen — ACID transaction spanning seat + order, row-level <code>SELECT FOR UPDATE</code> and atomic conditional <code>UPDATE</code> enforce the invariant natively; throughput is more than enough for 100MB."},
      {name:"Cassandra (wide-column)",ceiling:"~10-50K writes/s per node raw, but <code>LWT</code> (Paxos per partition) collapses to ~1-2K/s",nodes:"multi-node, eventually consistent by default",pick:false,note:"eventually consistent by default risks double-selling a seat; its compare-and-set path is slow and can't span seat+order atomically. Its horizontal scale solves a problem we don't have."},
      {name:"DynamoDB (managed KV)",ceiling:"~1K writes/s per single item/partition key",nodes:"managed / auto-sharded",pick:false,note:"conditional writes on one item are strongly consistent (legit), but multi-item <code>TransactWriteItems</code> is limited &amp; pricey — buying petabyte-scale horizontal throughput for 100MB of data."},
    ],
    indexing:"Primary key <code>(event_id, seat_id)</code>; secondary index on <strong>(event_id, status)</strong> to render the seat map (all AVAILABLE for an event) and let the reaper sweep expired holds. Correctness comes from <strong>row-level locking</strong>: <code>SELECT ... FOR UPDATE</code> for pessimistic read-check-write, or an atomic conditional <code>UPDATE seats SET status='HELD' WHERE seat_id=? AND status='AVAILABLE'</code> so the DB serializes writers on the row — exactly one wins, the loser gets a 409.",
    decision:"Pick a <strong>strongly-consistent relational store (Postgres/MySQL), or a NewSQL store like CockroachDB/Spanner</strong> for managed horizontal scale. Raw throughput can't decide this — every candidate serves ~10K writes/s over 100MB — so the deciding factor is enforcing one-seat-one-order under concurrency, which relational gives natively via ACID transactions spanning seat + order plus row-level locking. I explicitly reject eventually-consistent NoSQL (Cassandra) for the inventory core: a stale replica can hand seat 14A to two buyers; the invariant is a correctness property I won't trade for throughput I don't need.",
  },
  schema:{tables:[
    {name:"events",pk:"event_id",columns:[
      ["event_id","bigint","primary key"],
      ["name","varchar(200)","event / show title"],
      ["venue_id","bigint","FK to venues"],
      ["starts_at","timestamptz","when the show starts"],
      ["on_sale_at","timestamptz","when tickets go on sale"],
    ],rows:[
      ["evt-501","Taylor Swift - Eras Tour","ven-11","2026-09-01 20:00:00","2026-07-22 10:00:00"],
      ["evt-502","Coldplay - Music of the Spheres","ven-12","2026-10-15 19:30:00","2026-08-01 12:00:00"],
    ]},
    {name:"venues",pk:"venue_id",columns:[
      ["venue_id","bigint","primary key"],
      ["name","varchar(200)","venue name"],
      ["seat_map_id","bigint","layout used to render the seat map"],
    ],rows:[
      ["ven-11","Gillette Stadium","map-900"],
      ["ven-12","MetLife Stadium","map-901"],
    ]},
    {name:"seats",pk:"seat_id",columns:[
      ["seat_id","varchar(24)","primary key"],
      ["event_id","bigint","FK to events (sharded on this)"],
      ["section","varchar(24)","section label"],
      ["row","varchar(8)","row label"],
      ["num","int","seat number"],
      ["status","varchar(12)","state machine: available -> held -> sold; held -> available on expiry"],
      ["hold_expires_at","timestamptz NULL","when a held seat frees itself (null unless held)"],
      ["held_by","varchar(32) NULL","user holding the seat (null unless held)"],
    ],rows:[
      ["s-101","evt-501","Floor A","1","14","sold","(null)","(null)"],
      ["s-102","evt-501","Floor A","1","15","held","2026-07-22 10:03:00","user-9001"],
      ["s-103","evt-501","Floor A","1","16","available","(null)","(null)"],
    ]},
    {name:"orders",pk:"order_id",columns:[
      ["order_id","varchar(24)","primary key"],
      ["user_id","varchar(32)","who is buying"],
      ["event_id","bigint","FK to events"],
      ["seat_ids","jsonb","seats in this order"],
      ["status","varchar(12)","pending -> confirmed"],
      ["payment_id","varchar(24) NULL","FK to payments (null until charged)"],
      ["created_at","timestamptz","order creation time"],
    ],rows:[
      ["ord-8001","user-42","evt-501","[s-101]","confirmed","pay-7001","2026-07-22 10:01:30"],
      ["ord-8002","user-9001","evt-501","[s-102]","pending","(null)","2026-07-22 10:02:55"],
    ]},
    {name:"payments",pk:"payment_id",columns:[
      ["payment_id","varchar(24)","primary key"],
      ["order_id","varchar(24)","FK to orders"],
      ["amount","numeric(10,2)","charge amount"],
      ["status","varchar(12)","authorized -> captured -> refunded"],
    ],rows:[
      ["pay-7001","ord-8001","250.00","captured"],
      ["pay-7002","ord-8003","180.00","authorized"],
    ]},
  ]},
  flows:[
    {id:"browse",name:"Browse / search an event",steps:[
      {node:"client",text:"User types <code>Taylor Swift Boston</code> and opens an event."},
      {node:"gw",text:"Gateway terminates TLS and routes the anonymous read."},
      {node:"search",requires:["search"],text:"Search service matches events by name / artist / city / date over its inverted index."},
      {node:"booking",text:"Booking service assembles the event page and its seat map."},
      {node:"cache",requires:["cache"],text:"Seat-map availability is read from the cache (a slightly-stale display hint)."},
      {node:"client",text:"Renders the event and live-ish seat availability."},
    ]},
    {id:"book",name:"Reserve a seat, pay, confirm",steps:[
      {node:"client",text:"User taps seat <code>14A</code> and sends <code>POST /reserve</code> with an idempotency key."},
      {node:"gw",text:"Gateway authenticates and per-user rate-limits the reserve."},
      {node:"booking",text:"Booking service attempts the reservation for the seat."},
      {node:"cache",requires:["cache"],text:"Takes the hold via a Redis lock - <code>SET seat:14A userId NX EX 600</code> (10-min TTL) so no seat is stuck forever."},
      {node:"db",text:"Short transaction flips the seat to <code>held</code> with an expiry and writes a pending order."},
      {node:"payment",requires:["payment"],text:"Payment service authorizes the card outside any DB lock."},
      {node:"db",text:"On charge success a second short transaction commits the held -> sold transition and confirms the order."},
      {node:"client",text:"Returns the confirmed order and ticket."},
    ]},
    {id:"onsale",name:"High-demand on-sale entry",steps:[
      {node:"client",text:"At the on-sale second, a million users hit <code>Buy</code> for one event."},
      {node:"gw",text:"Gateway sends unadmitted users to the waiting room instead of booking."},
      {node:"queue",requires:["queue"],text:"Waiting room buffers arrivals and admits them at a controlled rate the backend can absorb, handing out short-lived admission tokens."},
      {node:"booking",text:"An admitted user reaches booking and attempts an atomic reserve."},
      {node:"db",text:"The inventory DB serializes the single-row conditional write - exactly one buyer wins the seat."},
    ]},
  ],
  requirements:{
    functional:[
      "Browse and view events, venues, and live seat availability",
      "Search for events by name, artist, city, or date",
      "Book one or more seats for an event and pay — never double-selling a seat",
    ],
    nonFunctional:[
      "Strong consistency for inventory (never double-sell); availability for browse and search",
      "Survive on-sale spikes — up to ~1M users hitting one event in the same second",
      "Low-latency search (&lt; 500ms); read-heavy (~100:1 read:write)",
      "A held seat is never lost, and never stuck locked forever if a user walks away",
    ],
  },
  reqBuild:[
    {req:"View events, venues, and seat availability",turns:[
      {who:"intv",text:"Start with the simplest thing that satisfies requirement one: a user opens an event page and sees the seat map. What's the minimal path?"},
      {who:"cand",text:"The <strong>client</strong> calls the <strong>API gateway</strong>, which routes to the <strong>booking service</strong> (it also serves event/venue/seat reads for now), which queries the <strong>inventory DB</strong> for the event, its venue, and the current state of each seat (available / held / sold). That's the whole read path — my four core boxes already cover it. I'll keep event data and seat inventory in the same relational store initially because booking needs transactional access to seat state anyway."},
      {who:"intv",text:"Seat state changes constantly during an on-sale. Is reading it straight from the DB going to hold up?"},
      {who:"cand",text:"For correctness it's fine — the DB is the source of truth for a seat's state. For <em>load</em> it won't hold up under a hot on-sale, but I'll deliberately defer that: right now I'm satisfying the functional requirement with the simplest correct design, and I'll add a read cache and other machinery in the deep-dive phase once we've covered all three requirements. Premature caching here would just be guessing."},
    ],resources:[
      {title:"Hello Interview — Ticketmaster breakdown",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ticketmaster"},
    ]},
    {req:"Search for events (adds a search service)",reveal:["search"],turns:[
      {who:"intv",text:"Requirement two: a user types 'Taylor Swift Boston' and expects matching events. Does the booking service handle that too?"},
      {who:"cand",text:"I'd split search out — let me add a dedicated <strong>search service</strong>. Full-text search over event name / artist / city / date is a different access pattern from a point lookup by event id, and I want to scale and cache it independently from the transactional booking path. For now it can query the same events data (via indexes); in the deep dives I'll move it to a proper inverted index."},
      {who:"intv",text:"Why not just add a SQL <code>LIKE</code> query on the booking service and avoid a new component?"},
      {who:"cand",text:"<code>LIKE '%...%'</code> can't use a normal B-tree index, so it degrades to a full scan as events grow — and it can't do relevance ranking, typo tolerance, or multi-field matching well. Isolating a search service also means a spike in search traffic never competes with booking transactions for the same DB connections. So the split is about both correctness of the feature and blast-radius isolation, not just tidiness."},
    ],resources:[
      {title:"Hello Interview — Ticketmaster breakdown",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ticketmaster"},
      {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
    ]},
    {req:"Book seats and pay (adds a payment service)",reveal:["payment"],turns:[
      {who:"intv",text:"Requirement three, the crux: a user picks seat 14A and checks out. Walk me through the write path, and add whatever you need."},
      {who:"cand",text:"The booking service runs a <strong>transaction</strong> against the inventory DB: verify seat 14A is <code>available</code>, flip it to <code>sold</code>, and create an order row — atomically, so two concurrent checkouts can't both win. Payment is external, so let me add a <strong>payment service</strong> that wraps the processor (Stripe). The flow is reserve → charge → confirm.<span class='eg'>BEGIN; SELECT status FROM seats WHERE id=14A FOR UPDATE; -- available? UPDATE seats SET status='sold'; INSERT order; COMMIT;</span>"},
      {who:"intv",text:"You charge the card <em>inside</em> that transaction? Payment can take seconds."},
      {who:"cand",text:"No — never hold a DB row lock across a slow external call. I split it: first a short transaction moves the seat to a <strong>held</strong> state with the user's id and an expiry; then payment happens outside any lock; then a second short transaction flips held→sold on success (or the hold expires and the seat is released). That keeps locks measured in milliseconds. The exact holding mechanism — DB state vs a Redis lock, and how expiry is enforced — is a deep dive, but functionally: reserve, pay, confirm. That satisfies all three requirements; now I'd move to hardening it."},
    ],resources:[
      {title:"Hello Interview — Ticketmaster breakdown",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ticketmaster"},
      {title:"Optimistic concurrency control",url:"https://en.wikipedia.org/wiki/Optimistic_concurrency_control"},
    ]},
  ],
  systemDives:[
    {title:"The on-sale thundering herd — shed load at the door",tag:"scaling",reveal:["queue"],turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a stadium tour goes on sale at 10:00:00. <b>1,000,000</b> people load the event and start hammering 'find seats' in the same few seconds, for ~40,000 seats. Your booking service and DB were sized for normal load. The whole system browns out. Fix it at the architecture level.</span>"},
      {who:"cand",text:"You can't serve a million concurrent booking sessions against 40K seats — most will fail anyway. The move is to <strong>shed load at the entrance</strong> with a <strong>virtual waiting room</strong>. Let me add it in front of booking. On-sale traffic is admitted into a queue (a Redis sorted set keyed by arrival), and only a controlled number of users per second are released to the actual booking flow — matched to what the DB and seat inventory can safely handle."},
      {who:"intv",text:"How do users experience the queue, and how do you show them progress without polling you to death?"},
      {who:"cand",text:"The client holds a <strong>Server-Sent Events</strong> (or WebSocket) connection and the waiting room pushes position updates — 'you're 42,000th, ~6 min' — so there's no busy-polling. When admitted, the client gets a short-lived token that the booking service checks; without a valid token you can't reach the booking API, which is what actually protects the DB. The queue is the pressure-relief valve: the backend runs at a sustainable rate while a million people wait in an orderly, transparent line instead of stampeding."},
      {who:"intv",text:"The waiting-room store is now critical. What if it dies mid-on-sale?"},
      {who:"cand",text:"I run it as a replicated Redis (with failover), and — key point — it's <em>advisory</em>, not the source of truth for seats. If it blips, I fail toward safety: the booking service still enforces seat-level correctness in the DB, so a queue outage can't double-sell; worst case admission control degrades and I fall back to a coarse rate limit at the gateway until it recovers. The inventory DB remains the one authority for who actually got a seat."},
    ],resources:[
      {title:"Hello Interview — Ticketmaster (virtual waiting queue)",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ticketmaster"},
      {title:"Redis sorted sets",url:"https://redis.io/docs/latest/develop/data-types/"},
    ]},
    {title:"Reserve seats without long-held DB locks",tag:"durability",reveal:["cache"],turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> you hold seats with <code>SELECT ... FOR UPDATE</code> for the 3-5 minutes a user takes to enter payment details. During an on-sale, thousands of these long-lived row locks pile up, connections exhaust, and the DB grinds to a halt. Redesign the hold.</span>"},
      {who:"cand",text:"Long-lived DB locks across human think-time is the anti-pattern. Let me add <strong>Redis</strong> as a <strong>distributed lock / reservation layer</strong>: reserving seat 14A is <code>SET seat:14A userId NX EX 600</code> — an atomic set-if-absent with a <strong>10-minute TTL</strong>. The DB transaction is now only the millisecond-long final flip held→sold at purchase. The seconds-to-minutes 'hold' lives in Redis, not in a DB lock."},
      {who:"intv",text:"The TTL is clever, but what makes it safe — couldn't two users both think they hold the seat?"},
      {who:"cand",text:"No, because <code>SET NX</code> is atomic — exactly one client wins the key; everyone else's <code>NX</code> fails and they see the seat as taken. The TTL is what guarantees <strong>no seat is ever stuck locked forever</strong>: if the user abandons checkout or their client crashes, the key simply expires and the seat frees itself — no reaper job required for the common case. At purchase, the final DB transaction re-validates ownership (the held record matches this user) before committing the sale, so Redis and the DB agree."},
      {who:"intv",text:"Redis is now in the critical booking path. If it's briefly unavailable, do bookings stop?"},
      {who:"cand",text:"Reservations pause, which is acceptable — far better than double-selling. Redis runs replicated with failover so an outage is short. Crucially I fail <strong>closed</strong> here (unlike a rate limiter): if I can't take the lock, I refuse the reservation rather than risk two people holding 14A. The DB's final held→sold transaction is the ultimate backstop — even a Redis bug can't oversell, because the authoritative commit re-checks seat state under the row's own constraint."},
    ],resources:[
      {title:"Redis distributed locks",url:"https://redis.io/docs/latest/develop/use/patterns/distributed-locks/"},
      {title:"Hello Interview — Ticketmaster (reservation)",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ticketmaster"},
    ]},
    {title:"Scale the read/browse path",tag:"scaling",reveal:["cache"],turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> even outside booking, the event page for a hot show gets 100K reads/s — everyone refreshing to watch availability. Those reads hit the inventory DB and compete with the booking transactions that actually matter. What do you do?</span>"},
      {who:"cand",text:"Protect the transactional DB by moving reads off it. Event/venue metadata is nearly static, so I cache it in <strong>Redis</strong> with a long TTL — that's the bulk of the page and it barely changes. The volatile part is seat availability; I cache a slightly-stale availability snapshot with a short TTL (a second or two), which is fine because the <em>authoritative</em> check happens at reserve time anyway. So browse reads hit cache, booking writes hit the DB, and they stop fighting."},
      {who:"intv",text:"Showing stale availability means users click a seat that's actually gone. Acceptable?"},
      {who:"cand",text:"Yes, and it's unavoidable at this scale — availability is a moving target. The contract is: the seat map is a <em>hint</em>, and the reservation attempt is the source of truth. If you click a seat that was taken in the last second, the <code>SET NX</code> fails and the UI immediately greys it out and asks you to pick again. This is exactly how real ticketing sites behave. Trying to show perfectly-live availability to 100K viewers would just move the thundering herd onto the DB I'm protecting."},
    ],resources:[
      {title:"System Design Primer — caching",url:"https://github.com/donnemartin/system-design-primer#cache"},
      {title:"Hello Interview — Ticketmaster (scaling reads)",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ticketmaster"},
    ]},
    {title:"Release seats when a checkout is abandoned",tag:"failover",turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a user reserves 4 seats, then closes their laptop. Those seats are now held. If nothing releases them, 40,000 abandoned holds during an on-sale silently make the event look sold out while seats sit idle. How do you guarantee release?</span>"},
      {who:"cand",text:"The primary mechanism is the reservation's <strong>TTL</strong> — the Redis hold is <code>EX 600</code>, so an abandoned hold self-expires in 10 minutes and the seat frees automatically with zero moving parts. That covers the common case without any background job, which is the whole point of pushing holds into a TTL'd store rather than a DB row I'd have to reap."},
      {who:"intv",text:"TTL frees the Redis key — but your DB may have a corresponding 'held' row. Do those drift apart?"},
      {who:"cand",text:"They can, so I don't treat the DB 'held' state as authoritative for expiry — the seat is bookable again the moment the Redis key is gone. If I do persist holds in the DB (for audit or multi-seat orders), a lightweight <strong>reaper</strong> sweeps rows whose expiry has passed and marks them available — but it's a backstop, not the hot path, so if the reaper is down for a while nothing breaks; the Redis TTL already freed the seat for new reservations. I reconcile lazily: on a reserve attempt, an expired held row is treated as available. That way even overlapping failures (reaper down + stale DB row) can't wedge a seat permanently."},
    ],resources:[
      {title:"Hello Interview — Ticketmaster (reservation expiry)",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ticketmaster"},
      {title:"Redis key expiration",url:"https://redis.io/docs/latest/develop/use/keyspace/"},
    ]},
  ],
  q:{
    client:[
      {l:"easy",tag:"concept",q:"What does the client do while a seat is held?",turns:[
        {who:"intv",text:"A user taps seat <code>14A</code> and gets a 10-minute hold. Walk me through what the client shows and tracks during that window."},
        {who:"cand",text:"On a successful reserve the server returns a <strong>reservation token</strong> and an <strong>expiry timestamp</strong>. The client shows a visible countdown (<span class='eg'>\"Seat 14A held — 9:58 remaining\"</span>) and drives the user straight into checkout. It stores the token, not any authority over the seat — the DB owns the seat's state. If the countdown hits zero before payment, the client greys out the seat and tells the user the hold expired. The client is a <strong>view</strong> of server truth, never the source of it."},
        {who:"intv",text:"The user picks 14A but someone beat them to it a millisecond earlier. What should the client experience be?"},
        {who:"cand",text:"The reserve call returns a clean <code>409 Conflict</code> and the client immediately repaints that seat as taken and nudges them to pick another — ideally suggesting the nearest available seat. The key principle: the client shows availability <em>optimistically</em> from the cached seat map, but treats the <strong>reserve response as the only truth</strong>. Seeing a seat as green is a hint; holding the reservation token is the fact."},
      ],resources:[{title:"HelloInterview — Ticketmaster design",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ticketmaster"}]},
      {l:"medium",tag:"scaling",q:"1M clients refresh the seat map at once — protect the origin.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> at the on-sale second, <b>1M</b> clients open the seat map and many mash refresh, each polling availability every 2s. That's ~500K seat-map req/s hammering you before anyone even reserves. How does the client side avoid melting your origin?</span>"},
        {who:"cand",text:"Push work to the edge and calm the client. <strong>(1)</strong> Serve the seat map from a <strong>CDN/edge cache</strong> with a short TTL (1-2s) so the flood of reads collapses to a trickle of origin fetches — it's the same map for everyone. <strong>(2)</strong> Replace tight polling with server-push (SSE/WebSocket) or at least <strong>jittered backoff</strong> so a million clients don't align on the same tick. <strong>(3)</strong> The seat map is availability data, which tolerates being a second or two stale — I only need exactness at the moment of reserve, which goes to the DB."},
        {who:"intv",text:"If the map is 2s stale, users constantly click seats that are already gone. Is that acceptable?"},
        {who:"cand",text:"Yes, by design — I accept <strong>stale reads, exact writes</strong>. A stale map means some reserve attempts return <code>409</code>, which is cheap and correct: the DB rejects the double-claim, the client repaints, the user picks again. The alternative — a strongly-consistent live map for 1M viewers — would put the read stampede directly on the inventory DB, which is exactly what I must protect for the writes that matter. Better a few wasted clicks than a contended source of truth."},
      ],resources:[
        {title:"System Design Primer — CDN",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"ByteByteGo",url:"https://bytebytego.com/"},
      ]},
      {l:"medium",tag:"failover",q:"Client's reserve request times out — did the seat get held?",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a user taps <code>Reserve 14A</code>, the network stalls, and after 8s the client gives up with a timeout. The user has no idea whether the hold succeeded. They tap again. What does the client do to avoid a mess?</span>"},
        {who:"cand",text:"The client attaches a <strong>client-generated idempotency key</strong> to the reserve request and reuses the <em>same</em> key on retry. So the retry is safe: if the first call actually reached the server and held the seat, the server recognizes the key and returns the <em>same</em> reservation rather than treating it as a second attempt or a conflict. The user ends up with exactly one hold on 14A regardless of how many times the flaky network made them retry."},
        {who:"intv",text:"What if the user gives up and closes the tab, but the hold did succeed server-side?"},
        {who:"cand",text:"That's fine and self-healing — the seat is held with a <strong>10-minute TTL</strong>, so if the user never returns, the reservation auto-expires and the seat flows back into inventory. No client action is required for correctness; the client abandoning is just the common case the timeout mechanism exists for. The client's only job on reconnect is to fetch its active reservations by idempotency key so it can resume checkout if the hold is still alive."},
      ],resources:[{title:"HelloInterview — Ticketmaster",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ticketmaster"}]},
    ],
    gw:[
      {l:"medium",tag:"concept",q:"What lives at the gateway for browse vs reserve?",turns:[
        {who:"intv",text:"You drew one 'API gateway' box. A <code>GET /events/42/seatmap</code> and a <code>POST /events/42/reserve</code> both hit it. Be precise about what the gateway does to each."},
        {who:"cand",text:"The gateway owns cross-cutting edge concerns: TLS, authentication, request validation, and <strong>rate limiting</strong>. <code>GET seatmap</code> is anonymous, cacheable, and cheap — I let the edge/CDN answer most of it and only fall through on cache miss. <code>POST reserve</code> is authenticated, <strong>per-user rate limited</strong> (one person shouldn't hold 500 seats), carries the idempotency key, and routes to the booking service. The gateway is where I separate the fat read path from the scarce write path so I can protect each differently."},
        {who:"intv",text:"Why rate-limit reserve per user specifically? Give me the abuse you're stopping."},
        {who:"cand",text:"Scalpers and bots. <span class='eg'>A bot script firing 1,000 reserve calls/s could lock every seat in a section into holds, then release the ones it doesn't resell — denying real fans.</span>Per-user (and per-IP, per-payment-instrument) limits plus bot detection cap how much inventory any actor can tie up at once. It also protects the booking service from a single client's runaway retries. This is policy that belongs at the edge, before a request ever touches the contended inventory."},
      ],resources:[
        {title:"System Design Primer — gateway & rate limiting",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"HelloInterview — Ticketmaster",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ticketmaster"},
      ]},
      {l:"hard",tag:"scaling",q:"500K users hit refresh at the on-sale second (adds waiting room).",reveal:["queue"],turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> Taylor Swift tickets drop at 10:00:00. At exactly that second <b>500K users</b> hit <code>Buy</code> and the number climbs to over a million within a minute — all aimed at ~100K seats. Your booking service and inventory DB are sized for steady-state. What falls over, and what's your move?</span>"},
        {who:"cand",text:"Everything downstream melts if I let raw demand through: the booking service saturates and the inventory DB drowns in contended writes against a handful of hot rows. The core insight is that I have <strong>10x more buyers than seats</strong> — most of that traffic is doomed to fail anyway, so admitting it all is pure waste. My move is to stop absorbing it and start <strong>shedding load at the front door</strong>. Let me add a <strong>virtual waiting room</strong> in front of the gateway: everyone lands in a queue and is admitted to the actual booking flow at a controlled rate the backend can handle."},
        {who:"intv",text:"Concretely, how does the waiting room let the right number of people through and no more?"},
        {who:"cand",text:"On arrival each user gets a <strong>queue token</strong> and a position; the client shows \"You're number 480,000.\" A dispatcher admits users into an <strong>active pool</strong> at a rate matched to backend capacity — say the system can safely handle 5K concurrent checkouts, so it drips tokens to keep ~5K active. An admitted token is what the gateway accepts for reserve calls; unadmitted users just poll the queue, which is a cheap, cacheable read that never touches inventory. So the DB only ever sees load it can handle, and the stampede is buffered in a queue instead of crashing the booking service."},
        {who:"intv",text:"A million people are now staring at a spinner. How do you keep that from feeling broken?"},
        {who:"cand",text:"Set expectations and be fair. The client shows position and a moving estimated wait so it feels like a line, not a hang. Admission is roughly <strong>FIFO by arrival</strong> (a token timestamp) so early arrivals genuinely go first — jumping the queue on refresh would enrage users, so a refresh must keep your place, not lose it. The queue is a great isolation boundary too: if booking has a wobble I can slow or pause admission without dropping anyone, and resume when it recovers. It converts a crash into a wait."},
      ],resources:[
        {title:"HelloInterview — Ticketmaster (virtual waiting room)",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ticketmaster"},
        {title:"ByteByteGo",url:"https://bytebytego.com/"},
      ]},
      {l:"medium",tag:"concept",q:"Users need to find events before booking (adds search).",reveal:["search"],turns:[
        {who:"intv",text:"Before anyone reserves a seat they have to <em>find</em> the event — search by artist, city, date, browse recommendations. Where does that live, and how is it different from the reserve path?"},
        {who:"cand",text:"That's a separate read-optimized concern, so let me add a <strong>search / browse</strong> service the gateway routes discovery traffic to. It's backed by a search index (Elasticsearch-style) over event metadata — artist, venue, date, city — with full-text and faceted queries. Crucially, its consistency requirements are the opposite of inventory: browse results can be <strong>eventually consistent</strong>. If an event shows up in search a few seconds late, or a sold-out badge lags, nobody double-books a seat over it."},
        {who:"intv",text:"So search says an event has seats, the user clicks in, and it's actually sold out. Bug?"},
        {who:"cand",text:"Not a bug — it's the deliberate split. Search and the seat map are <strong>approximate availability</strong> for discovery; the <strong>inventory DB is exact</strong> and is consulted only at reserve. So a user can be routed to an event that just sold out, land on the seat map, and find nothing green — mildly annoying but never incorrect. I keep the search index fresh by streaming inventory changes into it asynchronously, but I never let discovery block on, or add load to, the strongly-consistent inventory path. Eventual for browse, strong for booking."},
      ],resources:[
        {title:"System Design Primer — search & eventual consistency",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"HelloInterview — Ticketmaster",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ticketmaster"},
      ]},
      {l:"hard",tag:"failover",q:"The waiting room store dies — does the on-sale stop?",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> mid on-sale, the store backing your waiting room (Redis holding 1M queue tokens and positions) fails over and comes back having lost recent state. A million people's queue positions are in question. What happens and how do you contain it?</span>"},
        {who:"cand",text:"First, the blast radius is bounded because the waiting room is a <em>load shedder</em>, not the system of record — no seat or order state lives there, so a queue wipe can't corrupt inventory or lose a paid ticket. The damage is fairness: positions could be lost. Containment: run the queue store as a <strong>replicated cluster with a durable log</strong> of admissions so failover preserves who's already been let in, and rebuild positions from persisted token timestamps rather than volatile in-memory counters."},
        {who:"intv",text:"Suppose you genuinely can't reconstruct exact positions after the failover. Now what?"},
        {who:"cand",text:"I fail <strong>safe on correctness, degraded on fairness</strong>. Admission control is the sacred part — I keep dripping tokens at the safe rate so the booking service is never overwhelmed, even if I've lost the exact ordering. If positions are unrecoverable I re-admit based on the durable admission log plus token timestamps, accepting that some users' displayed position resets — annoying but not a double-sell. The one thing I will not do is open the floodgates to compensate; the queue can be approximate, but the rate limit into inventory stays hard. Worst case I briefly pause admission, restore the store, and resume — a wait, never an oversell."},
      ],resources:[
        {title:"Redis — replication & high availability",url:"https://redis.io/docs/latest/develop/use/patterns/distributed-locks/"},
        {title:"System Design Primer — availability",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"medium",tag:"capacity",q:"How many gateway instances at the on-sale peak?",turns:[
        {who:"intv",text:"Numbers. Steady-state browse is ~10K req/s, but at the on-sale a million users poll their queue position every few seconds. How many gateway nodes do you run — and don't just say autoscale?"},
        {who:"cand",text:"The gateway is thin — TLS, auth, rate-limit, route — so I size it by request rate, and most peak volume is waiting-room polls the edge can absorb.<span class='eg'>1M users polling every ~3s ≈ 330K poll req/s; if the CDN/edge serves ~95%, origin sees ~17K/s. Add steady browse ~10K/s and admitted reserve ~5K/s ≈ 32K/s. At ~10K req/s per node → ~3-4 nodes, +30% headroom → ~5, across 3 AZs.</span>"},
        {who:"intv",text:"That leans hard on the edge holding. What if the edge is cold or bypassed?"},
        {who:"cand",text:"Then the gateway eats the full ~330K/s and would need 35+ nodes — a 7x swing — so the real lever is edge cache-hit ratio, not gateway count. The trade-off is provisioning for the cold-edge worst case (cost) versus autoscale lag (risk during a cache flush). I keep a warm floor sized for the edge-working case (~5-6 nodes) and autoscale on request rate above it, and I rely on the waiting room to cap how much reserve traffic ever reaches origin — so the gateway never actually sees the raw million."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"ByteByteGo",url:"https://bytebytego.com/"},
      ]},
    ],
    booking:[
      {l:"medium",tag:"concept",q:"Two users grab seat 14A at once — who wins?",turns:[
        {who:"intv",text:"This is the heart of it. Two reserve requests for seat <code>14A</code> arrive within a millisecond of each other. Both read the seat as available. Walk me through exactly how you guarantee only one wins — no double-sell."},
        {who:"cand",text:"The naive read-then-write races, so the decision must be atomic <em>in the database</em>, which owns the seat's state. The cleanest is a <strong>conditional write</strong>: <code>UPDATE seats SET status='HELD', held_by=:tok, hold_expiry=:t WHERE seat_id='14A' AND status='AVAILABLE'</code>. Exactly one of the two updates matches <code>status='AVAILABLE'</code> and affects one row; the other affects <strong>zero rows</strong> and gets a <code>409</code>. The DB serializes the two writes on that row, so the invariant is enforced at the single source of truth, not in racy application code."},
        {who:"intv",text:"Compare that to taking a row lock with <code>SELECT ... FOR UPDATE</code>. When would you reach for one over the other?"},
        {who:"cand",text:"Both work; it's pessimistic vs optimistic. <strong>Pessimistic</strong> — <code>SELECT FOR UPDATE</code> locks the seat row, I check status, update, commit; contenders block then see it's taken. Simple and correct, but locks are held for the transaction and can queue up under heavy contention on one hot seat. <strong>Optimistic</strong> — the conditional update (or a <code>version</code> column) takes no lock; the loser just retries against fresh state.<span class='eg'>For one scorching seat, the conditional write is a single atomic statement — no lock held across a round trip — so it degrades more gracefully than a lock queue.</span>I default to the conditional/optimistic write for reserve because contention is concentrated on few seats; I'd use <code>FOR UPDATE</code> when a reservation spans multiple seats that must all succeed atomically."},
      ],resources:[
        {title:"Optimistic concurrency control",url:"https://en.wikipedia.org/wiki/Optimistic_concurrency_control"},
        {title:"HelloInterview — Ticketmaster",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ticketmaster"},
      ]},
      {l:"medium",tag:"scaling",q:"Seat-map reads are hammering the inventory DB (adds cache).",reveal:["cache"],turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> you launch with just booking + inventory DB. During the on-sale, seat-map reads at ~500K/s drive the inventory DB to 95% CPU, and now your <em>reserve writes</em> — the ones that must not fail — are starved and timing out behind the reads. Fix it.</span>"},
        {who:"cand",text:"The mistake is letting cheap reads compete with the sacred writes on the same nodes. I'll <strong>separate the read path from the write path</strong>: add a <strong>seat-map cache</strong> that serves availability, so the inventory DB is reserved almost entirely for reserve/confirm writes and their conditional checks. Let me add the seat-map cache. The map is derived, high-volume, and tolerant of a second of staleness — a perfect cache workload — while the DB stays the exact source of truth consulted only at the moment of the atomic reserve."},
        {who:"intv",text:"Cache added. How do you keep it fresh enough, and what's the read path on a miss?"},
        {who:"cand",text:"Read-through with a short TTL (1-2s), plus <strong>event-driven updates</strong>: every successful reserve/release publishes a seat-state change that updates the cached map, so it converges within a second. On a miss the booking service reads the DB, populates the cache, and returns. The contract is explicit: the cache is for <em>display</em> and can be slightly stale; the reserve write always re-validates against the DB with the conditional update, so a stale cache never causes a double-sell — it only causes a harmless <code>409</code> the client recovers from. We should dig into what happens when this cache itself falls over."},
      ],resources:[
        {title:"System Design Primer — caching",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"ByteByteGo",url:"https://bytebytego.com/"},
      ]},
      {l:"medium",tag:"concept",q:"Reserve now, pay later — how does the flow split? (adds payment)",reveal:["payment"],turns:[
        {who:"intv",text:"Users don't pay instantly — they reserve a seat, then spend a couple minutes entering card details. How do you structure reserve-then-pay so the seat is protected but not sold until money changes hands?"},
        {who:"cand",text:"Two phases. <strong>Reserve</strong> flips the seat to <code>HELD</code> with a 10-minute expiry and a hold token — atomic, in the inventory DB, no money involved. <strong>Pay</strong> is a separate step, so let me add a <strong>payment service</strong> the booking service calls to charge the card. Only on a <em>successful charge</em> does booking flip the seat from <code>HELD</code> to <code>SOLD</code> and create the order. The hold gives the user a private window to pay without the seat being resellable, and the seat isn't truly gone until payment confirms."},
        {who:"intv",text:"Walk the whole reserve → pay → confirm as one flow, and tell me where it can break."},
        {who:"cand",text:"It's a small <strong>saga</strong>: (1) reserve seat → HELD; (2) call payment to charge; (3) on success, mark SOLD + emit ticket; on failure or timeout, <strong>compensate</strong> by releasing the hold back to AVAILABLE. The break points are the seams between steps — booking crashing after HELD but before charging, or payment succeeding but booking never hearing back. Each seam needs the hold TTL as a backstop and idempotency so a retry can't charge twice or sell twice. Let me note payment as its own box; we should drill into the charge-timeout case, it's the nasty one."},
      ],resources:[
        {title:"Saga pattern",url:"https://microservices.io/patterns/data/saga.html"},
        {title:"HelloInterview — Ticketmaster",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ticketmaster"},
      ]},
      {l:"hard",tag:"durability",q:"Booking crashes mid-reservation — stuck-held seats.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> the booking service reserves seat 14A (status flips to HELD), and then the pod is SIGKILLed before it responds to the user or does anything else. The seat is now HELD but nobody is actually buying it. Multiply that by a crash during the on-sale — hundreds of ghost holds. How do you avoid seats stuck locked forever?</span>"},
        {who:"cand",text:"The hold must carry its own expiry so no live process is required to free it. Every <code>HELD</code> row has a <strong><code>hold_expiry</code> timestamp</strong> written at reserve time. A seat is only genuinely reservable if <code>status='AVAILABLE'</code> OR (<code>status='HELD'</code> AND <code>hold_expiry &lt; now</code>). So even if booking dies the instant after flipping the seat, the hold is self-expiring — after 10 minutes the seat is claimable again by anyone, enforced by the conditional write itself. The DB, not the crashed service, guarantees the seat comes back."},
        {who:"intv",text:"So you rely on a sweeper to actually reset those expired holds? What if you don't reclaim them promptly?"},
        {who:"cand",text:"I use both, and I lean on the <em>lazy</em> check as the correctness guarantee. The reserve query itself treats an expired hold as available (the <code>hold_expiry &lt; now</code> clause), so a seat is reclaimed the moment someone tries to take it — no sweeper required for correctness. A background <strong>reaper job</strong> then tidies expired holds back to <code>AVAILABLE</code> so the seat map shows them as free without waiting for a reserve attempt. If the reaper lags, correctness holds; only the displayed map is briefly pessimistic. That's the right failure mode — I'd rather show a seat as taken slightly too long than sell a held seat."},
      ],resources:[
        {title:"HelloInterview — Ticketmaster (hold with TTL)",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ticketmaster"},
        {title:"System Design Primer — application layer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"hard",tag:"failover",q:"The reservation-timeout job dies — seats locked forever.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> you added a reaper job to release expired holds. During the biggest on-sale of the year, that single reaper process crashes and doesn't restart for 20 minutes. Meanwhile thousands of holds expire. Are those seats now stuck out of inventory during peak demand? Walk me through it.</span>"},
        {who:"cand",text:"They are <em>not</em> stuck, and that's deliberate — I never made correctness depend on the reaper. Because the reserve query treats <code>HELD AND hold_expiry &lt; now</code> as claimable, every expired seat is <strong>reclaimed on demand</strong> the instant a buyer tries for it. During a hot on-sale that's exactly when there's a buyer for every seat, so expired holds get re-sold immediately regardless of the reaper. The only visible loss during the outage is that the seat <em>map</em> may show expired holds as taken until someone attempts them — a display lag, not lost inventory."},
        {who:"intv",text:"Still, a dead singleton reaper is a SPOF for the seat map's accuracy. Harden it."},
        {who:"cand",text:"Make it not a singleton and not stateful. Run the reaper as <strong>multiple stateless workers</strong> that each claim batches of expired holds with a conditional update (<code>WHERE status='HELD' AND hold_expiry &lt; now</code>) — the update itself is the lock, so two workers can't both reset the same row and there's no coordination needed. Schedule it via a durable scheduler so a crashed worker's slot is rescheduled, and alert on reaper lag. But the architecture already tolerates the reaper being down: I designed the release to be <strong>lazy and DB-enforced</strong> precisely so no background job is ever load-bearing for correctness — it's an optimization for map freshness, and I can lose it for 20 minutes without an oversell or lost seat."},
      ],resources:[
        {title:"System Design Primer — availability & jobs",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"HelloInterview — Ticketmaster",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ticketmaster"},
      ]},
      {l:"medium",tag:"capacity",q:"How many booking instances — size it off admission, not the stampede.",turns:[
        {who:"intv",text:"The scary number is a million concurrent buyers. Do you size the booking fleet for that? Show me the math."},
        {who:"cand",text:"No — sizing for 1M is the trap, because the waiting room caps admitted concurrency at what the backend can absorb.<span class='eg'>Admit ~5K concurrent checkouts; each does a handful of calls (reserve, confirm) over a ~3-min window → ~2-3K short ops/s. A stateless booking node handles ~1K short ops/s → ~3 nodes, +headroom → ~5, across 3 AZs.</span>The fleet is sized to the admission ceiling — a number I choose — not to raw demand."},
        {who:"intv",text:"So the whole fleet hinges on the admission rate you picked. What sets that?"},
        {who:"cand",text:"The admission rate is set by the weakest downstream link — inventory-DB write throughput and the payment gateway's limit — and I size booking just above it. The trade-off: admit too high and the DB or payment starve; too low and the line crawls while the backend idles. Since booking is cheap and stateless I keep it a touch over the admission ceiling so it's never the bottleneck, and let the DB and payment ceilings be the real governor. Scaling booking past that buys nothing — the stampede is absorbed in the queue, not here."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"HelloInterview — Ticketmaster",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ticketmaster"},
      ]},
    ],
    db:[
      {l:"medium",tag:"concept",q:"Pick the inventory datastore — ACID relational vs Cassandra vs DynamoDB.",turns:[
        {who:"intv",text:"Pick your datastore for inventory and defend it with numbers. What's the write load you're actually designing for, and give me the seat/order model."},
        {who:"cand",text:"First the load, because it reframes the whole choice. From the opening, admission caps concurrent checkouts at ~5K, so the inventory store sees <strong>~5-10K single-row conditional writes/s</strong> at peak for a mega on-sale — and those spread across one event's ~100K distinct seat rows. The <em>truly contended</em> rate, two people writing the <strong>same</strong> hot seat, is a tiny slice: a scorching front-row seat might take a handful of competing writes, not thousands. So it's ~10K writes/s total, near-zero real row conflict, against ~100MB of data.<span class='eg'>~100K seats/event × ~1KB ≈ 100MB — trivial volume. The scarce thing is <strong>correctness under concurrency</strong>, not bytes and not aggregate throughput.</span>Model: a <code>seats</code> table keyed by <code>(event_id, seat_id)</code> with <code>status ∈ {AVAILABLE, HELD, SOLD}</code>, <code>held_by</code>, <code>hold_expiry</code>, <code>version</code>; and an <code>orders</code> table. The seat row is the single source of truth — every reserve/confirm is one atomic transition on it."},
        {who:"intv",text:"Give me the candidates and their write ceilings. Convince me throughput isn't what decides this."},
        {who:"cand",text:"Three candidates, ballpark per-node write ceilings:<span class='eg'><strong>Postgres/MySQL</strong> (single primary): ~5-10K contended single-row writes/s, more read replicas don't help writes. <strong>Cassandra</strong>: ~10-50K writes/s per node raw — but that's for last-write-wins; its compare-and-set path (<code>LWT</code>, Paxos per partition) collapses to ~1-2K/s. <strong>DynamoDB</strong> conditional writes: scales horizontally, but a single item/partition key is capped near ~1K writes/s.</span>Here's the point: my requirement is ~5-10K writes/s spread over 100K rows, which <strong>every one of these can physically serve</strong>. Raw throughput is not the constraint — so it can't be the deciding factor. The deciding factor is which store enforces the one-seat-one-order invariant correctly under concurrency."},
        {who:"intv",text:"So make the correctness argument concrete. How does the relational option enforce it, and how do you index for it?"},
        {who:"cand",text:"Two relational mechanisms, both backed by a real transaction. <strong>Optimistic</strong>: an atomic conditional <code>UPDATE seats SET status='HELD' ... WHERE seat_id=? AND status='AVAILABLE'</code> — the DB serializes writers on that row, exactly one affects a row, the loser affects zero and gets a 409. <strong>Pessimistic</strong>: <code>SELECT ... FOR UPDATE</code> takes a <strong>row-level lock</strong> so I can read-check-write a seat (or lock several seats that must all succeed) inside one ACID transaction that also inserts the order. Indexing: primary key <code>(event_id, seat_id)</code>; plus a secondary index on <strong>(event_id, status)</strong> to render the seat map (all AVAILABLE for an event) and to let the reaper sweep expired holds.<span class='eg'>Index cost is real but small here: every status transition updates the (event_id, status) index, but at ~10K writes/s over ~100MB that's cheap, and the index earns its keep on the far heavier seat-map read path.</span>"},
        {who:"intv",text:"Then why not Cassandra or DynamoDB — they scale writes further and give you multi-region for free?"},
        {who:"cand",text:"Because their strengths solve a problem I don't have and their weakness hits the one I do. <strong>Cassandra</strong> is eventually consistent by default — perfect for high-volume append workloads, catastrophic for inventory, since a stale replica can hand seat 14A to two buyers; its <code>LWT</code> can fix that per partition but it's slow and can't span the seat-plus-order write atomically. <strong>DynamoDB</strong> conditional writes on a single item are genuinely strongly consistent and a legitimate choice, but multi-item atomicity (<code>TransactWriteItems</code>) is limited and pricey, and I'd be buying petabyte-scale horizontal throughput for 100MB of data. <strong>Decision:</strong> a <strong>strongly-consistent relational store (Postgres/MySQL), or a NewSQL store like CockroachDB/Spanner if I need managed horizontal scale</strong>, because it gives ACID transactions spanning seat + order, row-level locking, and mature failover — the correctness guarantees are native, not bolted on. I explicitly reject eventually-consistent NoSQL for the inventory core: the invariant is a correctness property, and I won't trade it for throughput I don't need."},
      ],resources:[
        {title:"HelloInterview — Ticketmaster",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ticketmaster"},
        {title:"System Design Primer — consistency patterns",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"DynamoDB conditional writes",url:"https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/WorkingWithItems.html#WorkingWithItems.ConditionalUpdate"},
      ]},
      {l:"hard",tag:"scaling",q:"One event's seats are a write hotspot — everyone writes the same rows.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a single mega on-sale means ~100K seat rows for <b>one</b> event take essentially all your reserve traffic — tens of thousands of conditional writes per second concentrated on one event's rows, while the rest of your catalog is idle. Sharding by event puts that entire load on one shard. How do you keep the writes moving without double-selling?</span>"},
        {who:"cand",text:"The contention is real but it's spread across 100K <em>distinct</em> rows, not one — two users only truly conflict when they want the <em>same</em> seat, which is rare relative to total volume. So my job is to spread those 100K rows' load, not serialize it. I shard/partition inventory by <strong>(event_id, seat_id)</strong> or by seat block so one event's seats spread across many nodes/partitions, turning one hot event into many warm partitions. Each seat write stays a single-row atomic conditional update — cheap, no cross-row transaction — so throughput scales with partitions."},
        {who:"intv",text:"But the waiting room already caps admitted users at, say, 5K concurrent. Does the DB even see the full firehose?"},
        {who:"cand",text:"Right — the two defenses compound. The <strong>waiting room bounds the write rate</strong> into the DB to what it can handle, so the inventory store never sees the raw 1M; it sees the admitted 5K checking out. <strong>Partitioning</strong> then ensures those admitted writes spread across seat rows rather than piling on one. And I keep the hot read load off entirely via the seat-map cache. So the strongly-consistent core only ever does bounded, single-row, well-distributed writes — that's how I keep ACID guarantees at on-sale scale instead of choosing between correctness and throughput."},
      ],resources:[
        {title:"System Design Primer — sharding",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"HelloInterview — Ticketmaster",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ticketmaster"},
      ]},
      {l:"hard",tag:"durability",q:"A DB node holding seats dies — are orders lost?",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> the node holding the shard for tonight's sold-out show has a disk failure and won't come back. That shard held the seat states and confirmed orders for 60K attendees. Are those purchases gone? Give me your durability story.</span>"},
        {who:"cand",text:"If that shard were a single node, losing confirmed orders would be catastrophic — people paid and now have no ticket. So every shard is a <strong>replica group</strong> (e.g. 3 replicas across AZs) with <strong>synchronous quorum-acknowledged writes</strong>: a reserve or a SOLD/order commit isn't acknowledged to the user until a majority of replicas have it durably. A single disk failure loses nothing — the surviving replicas hold every committed order, and a fresh replica rebuilds from them. Payment confirmation is only returned after the order write is durably quorum-committed, so a paid ticket is always recoverable."},
        {who:"intv",text:"Synchronous quorum on every reserve adds latency to the hottest write path. Justify that during an on-sale."},
        {who:"cand",text:"I'll pay it, because the alternative is selling a ticket I might lose. A quorum write is a few milliseconds — negligible against the 10-minute human checkout window and hidden behind the waiting room's paced admission. This is the opposite trade-off from the URL-shortener read path: here writes are scarce and precious, so I optimize them for <strong>durability and correctness</strong>, not raw latency. I'd rather each reserve cost a few extra ms than have a disk failure erase confirmed orders. Where I <em>do</em> relax is reads — the seat-map cache and replicas absorb those so the quorum cost is confined to the writes that actually matter."},
      ],resources:[
        {title:"System Design Primer — replication",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"Two-phase commit protocol",url:"https://en.wikipedia.org/wiki/Two-phase_commit_protocol"},
      ]},
      {l:"hard",tag:"failover",q:"The inventory primary fails mid-sale — promote without overselling.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> the write-primary for the inventory shard crashes at the peak of the on-sale. You promote a replica. Two minutes later the old primary rejoins, still believing it's primary. Now two nodes could accept seat writes. What's the risk and how do you prevent it?</span>"},
        {who:"cand",text:"This is <strong>split-brain</strong>, and for inventory it's the worst case: two primaries could each mark seat 14A as SOLD to different buyers — a double-sell that survives to two confirmed orders and two people at one seat. Prevention is <strong>consensus-based promotion</strong>: leader election (Raft/Paxos or a fencing coordinator) grants a monotonically increasing <strong>epoch</strong>. The new primary writes under a higher epoch; when the stale old primary rejoins, replicas <strong>reject its writes via the fencing token</strong> and it's demoted and re-syncs. There is never a window where two nodes hold the current epoch, so a seat is never written by two authorities."},
        {who:"intv",text:"During the election window, reserves on that shard are... unavailable? At peak? Defend it."},
        {who:"cand",text:"Yes, and I choose that on purpose — it's the CAP call. To guarantee no double-sell I pick <strong>consistency over availability for writes</strong> during the partition: reserves on that shard pause for the few-second election rather than risk a split-brain oversell. The waiting room makes this graceful — I stop admitting into that shard's flow, users wait a few extra seconds, and resume; nobody is dropped, they just queue. Reads stay up from replicas throughout, so browsing and the seat map keep working. A handful of buyers retrying for 3 seconds is vastly better than selling the same seat twice. Managed stores do this fencing internally, which is a strong reason to use one rather than hand-roll failover."},
      ],resources:[
        {title:"Two-phase commit protocol",url:"https://en.wikipedia.org/wiki/Two-phase_commit_protocol"},
        {title:"System Design Primer — consistency & availability",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"medium",tag:"capacity",q:"Size the inventory DB — tiny data, but write-contended.",turns:[
        {who:"intv",text:"Give me storage and node count for inventory. Careful — this isn't like sizing a 90TB store; the data here is small."},
        {who:"cand",text:"Right — the data is tiny; the constraint is contention and durability, not space.<span class='eg'>~100K seats/event × ~1KB ≈ 100MB per event; even 10K live events ≈ 1TB — trivial. Peak writes are bounded by admission (~5K checkouts) → ~5-10K single-row conditional writes/s. Reads are off-loaded to the seat-map cache.</span>So I don't provision for storage — I provision for HA and write distribution."},
        {who:"intv",text:"So why not one beefy node, if a terabyte fits comfortably?"},
        {who:"cand",text:"Because a single node is a durability and split-brain risk for the one store that must never double-sell. Each shard is a 3-replica group across AZs with quorum writes, and I partition a hot event's 100K seats across several partitions so contention spreads over distinct rows. The trade-off is paying replication and partition overhead for data that would physically fit on one box — but here I'm buying correctness and failover, not capacity. Node count is driven by AZ redundancy and hot-event write spread, never by TB."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"System Design Primer — sharding",url:"https://github.com/donnemartin/system-design-primer#sharding"},
      ]},
    ],
    queue:[
      {l:"medium",tag:"concept",q:"How does a virtual waiting room actually work?",turns:[
        {who:"intv",text:"You added a waiting room to shed load. Mechanically, how does a user go from 'in line' to 'allowed to reserve'? Be concrete about tokens."},
        {who:"cand",text:"On arrival the user gets a signed <strong>queue token</strong> carrying an arrival timestamp and a status. A <strong>dispatcher</strong> maintains a target active-pool size matched to backend capacity and, as active users finish or time out, admits the next tokens in order, flipping them to <code>ADMITTED</code>. The gateway only accepts reserve calls bearing an <code>ADMITTED</code> token.<span class='eg'>Backend can safely handle ~5K concurrent checkouts, so the dispatcher keeps ~5K admitted and everyone else polls their position.</span>Unadmitted users just poll a cheap status endpoint — that read never touches inventory."},
        {who:"intv",text:"How long is an admitted token good for, and what stops someone hoarding an admission?"},
        {who:"cand",text:"An admitted token has a bounded <strong>session TTL</strong> — enough to complete one checkout (a few minutes), tied to the seat-hold window. When it expires or the purchase completes, the slot is returned to the pool and the next person is admitted. That caps how long any one user occupies a scarce slot, and combined with per-user reserve limits it stops one actor from parking in the active pool. The token is the throttle: admission rate in equals the rate the booking service and inventory DB can safely absorb."},
      ],resources:[
        {title:"HelloInterview — Ticketmaster (waiting room)",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ticketmaster"},
        {title:"ByteByteGo",url:"https://bytebytego.com/"},
      ]},
      {l:"hard",tag:"scaling",q:"A million people arrive in the same second — buffer them.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> <b>1M</b> users arrive at the queue within the first 10 seconds of the on-sale — that's ~100K queue-join requests/s, plus all of them polling their position every few seconds afterward. The waiting room itself must not become the new bottleneck. How do you scale it?</span>"},
        {who:"cand",text:"The waiting room is deliberately a <em>lightweight</em> tier so it can absorb what inventory can't. <strong>Joins</strong> are an append: assign a token and a monotonic position (e.g. from an atomic counter or a Redis sorted set) — no contended business logic, so it scales horizontally across stateless join nodes fronting a partitioned counter. <strong>Position polls</strong> are the real volume, and they're identical for large groups, so I serve them from a <strong>cache/CDN</strong> — 'the line has admitted through position N' is one value everyone reads, updated every second. That collapses millions of polls into one cached number."},
        {who:"intv",text:"So the queue's job is to convert an unbounded spike into a bounded stream. What's the number that actually matters?"},
        {who:"cand",text:"The <strong>admission rate</strong> — the only figure the backend feels. Whatever arrives, the dispatcher emits tokens at a rate the booking service and inventory DB can handle, so peak DB load is a constant I set, independent of demand. A 1M or a 5M on-sale look identical downstream; only the wait time differs. That's the whole point: the queue decouples <em>arrival rate</em> (unbounded, spiky) from <em>service rate</em> (bounded, steady), so I scale the cheap buffering tier freely and never scale the expensive strongly-consistent core to match a stampede."},
      ],resources:[
        {title:"System Design Primer — asynchronism & queues",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"HelloInterview — Ticketmaster",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ticketmaster"},
      ]},
      {l:"medium",tag:"failover",q:"The dispatcher stops admitting — everyone's stuck in line.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> the dispatcher component that admits users from the queue silently hangs. Joins still work, positions still show, but nobody is being admitted to actually buy. 500K people are frozen in line and inventory sits unsold. How do you detect and recover?</span>"},
        {who:"cand",text:"Detect via a liveness signal: the dispatcher should emit an <strong>admissions-per-second metric</strong>, and an alert fires if admissions drop to zero while the queue is non-empty and the backend has headroom — that combination is the unambiguous symptom. Recovery: run the dispatcher as a <strong>redundant, leader-elected set</strong> of workers so a standby takes over admission if the leader stalls, driven by durable state (the queue positions and the last-admitted watermark) so the new leader resumes from where the old one stopped rather than re-admitting."},
        {who:"intv",text:"When it recovers, how do you avoid over-admitting to 'catch up' and swamping the DB you were protecting?"},
        {who:"cand",text:"I never catch up by bursting — that would defeat the queue's entire purpose. The dispatcher resumes at the <strong>same safe steady admission rate</strong>; the backlog just means people wait longer, which is exactly the graceful-degradation behavior I want. Admission rate is a hard ceiling tied to backend capacity, never a function of how far behind we are. So a dispatcher stall becomes a longer line, then a normal-paced drain on recovery — never a compensating flood into the strongly-consistent inventory core. The invariant I protect end to end is 'downstream never sees more than it can handle.'"},
      ],resources:[
        {title:"System Design Primer — availability patterns",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"Redis — locks & leader coordination",url:"https://redis.io/docs/latest/develop/use/patterns/distributed-locks/"},
      ]},
      {l:"medium",tag:"capacity",q:"Millions queued in memory — how much, and is memory the limit?",turns:[
        {who:"intv",text:"You buffer a million people in Redis. How much memory is that, and is memory what you scale for?"},
        {who:"cand",text:"Memory is a non-issue; throughput is the real constraint.<span class='eg'>Each entry is small — userId, arrival timestamp, position, status ≈ ~200 bytes. 1M queued ≈ 200MB; even 5M ≈ 1GB, comfortably inside one Redis node's RAM.</span>What stresses the tier is request rate — ~100K joins/s in the first seconds plus millions polling position."},
        {who:"intv",text:"So if memory is easy, where does the scaling effort actually go?"},
        {who:"cand",text:"Into throughput and HA, not capacity. Joins are cheap appends to a sorted set, spread across stateless join nodes; position polls — the real volume — are identical for everyone, so I serve one cached 'admitted through position N' value from the edge instead of hitting Redis millions of times a second. The trade-off: I could shard the queue store for headroom, but with only ~1GB of state that adds coordination for zero memory benefit — so I keep a single replicated store (primary + failover) and spend the effort collapsing polls at the edge."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"Redis sorted sets",url:"https://redis.io/docs/latest/develop/data-types/"},
      ]},
      {l:"medium",tag:"concept",q:"Which store backs the waiting room — Redis, Kafka, or SQS?",turns:[
        {who:"intv",text:"The waiting room needs ordering, live positions, and controlled admission. Redis, Kafka, or a managed queue like SQS — pick and defend."},
        {who:"cand",text:"SQS is a managed work queue but gives no stable position or strict global ordering, so I can't tell a user 'you are number 480,000' — wrong fit. Kafka is a durable, strictly-ordered append log — excellent for a FIFO admission record and for replay. Redis sorted sets give me live positions and atomic admit operations in memory, which is what the real-time 'your place in line' needs."},
        {who:"intv",text:"Redis is volatile; Kafka is durable but not built for random position reads. So which?"},
        {who:"cand",text:"I use each for what it's best at rather than forcing one. A Redis sorted set is the live position and admission-control layer — fast atomic reads and pops — while a durable append log (Kafka-style) records admissions so a Redis failover can rebuild who was already let in. The trade-off: Redis alone risks losing ordering on a crash; Kafka alone can't cheaply answer 'what is my position now.' Pairing a fast in-memory position store with a durable admission log gives real-time UX and crash-safe fairness — and the admission rate stays the hard governor regardless."},
      ],resources:[
        {title:"Redis sorted sets",url:"https://redis.io/docs/latest/develop/data-types/"},
        {title:"System Design Primer — asynchronism & queues",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
    ],
    cache:[
      {l:"medium",tag:"concept",q:"What's safe to cache when inventory must be exact?",turns:[
        {who:"intv",text:"You cache the seat map for availability, but inventory has to be exact. Isn't a cached seat map just a lie waiting to cause a double-sell? Draw the line for me."},
        {who:"cand",text:"The line is between <strong>display</strong> and <strong>decision</strong>. The cache serves the seat map for <em>display</em> — what the user browses — and that tolerates 1-2s of staleness. It is never the authority for the <em>decision</em> to sell: the reserve always executes an atomic conditional write against the inventory DB, which re-checks true state. So a stale cache can show a seat as free when it's just been taken; the worst outcome is the reserve returns <code>409</code> and the client repaints. A stale cache causes wasted clicks, never a double-sell — because the write path doesn't trust it."},
        {who:"intv",text:"Could the cache ever show a seat as <em>taken</em> when it's actually free? What's the cost of that direction?"},
        {who:"cand",text:"Yes — e.g. right after a hold expires but before the update propagates, or if the reaper lags. That direction is <strong>pessimistic</strong>: it just hides an available seat briefly, so a user might not attempt a seat that's actually free. The cost is a little lost liquidity, not a correctness bug, and it self-corrects on the next refresh. I strongly prefer erring pessimistic (hide a free seat) over optimistic-beyond-truth (invite a doomed reserve), so I bias update ordering to publish 'taken' fast and 'freed' as it converges. Either way, exactness only ever comes from the DB at reserve time."},
      ],resources:[
        {title:"System Design Primer — caching",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"HelloInterview — Ticketmaster",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ticketmaster"},
      ]},
      {l:"hard",tag:"scaling",q:"One event's seat map is 90% of read traffic — hot partition.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> during the big on-sale, one event's seat map is <b>90%</b> of all cache reads — ~450K reads/s for a single key. In a sharded cache that key lives on one node, pinned at 100% CPU while the rest idle. Fix the imbalance.</span>"},
        {who:"cand",text:"Classic <strong>hot-key</strong> problem — consistent hashing balances keys, not load per key, so one blazing seat map pins one node. Fixes: <strong>(1) replicate the hot key</strong> across N cache nodes (<code>seatmap:42#1..#N</code>) and have clients read a random replica, spreading the fan-out N-ways. <strong>(2) client/edge caching</strong> — since the map is the same for everyone and only 1-2s fresh, serve it from the <strong>CDN/edge</strong> with a short TTL so the vast majority of reads never reach the cache tier at all. For a display artifact updated once a second, edge caching is by far the biggest lever."},
        {who:"intv",text:"Replicating the hot key means N copies to keep in sync as seats sell. Doesn't that reintroduce staleness?"},
        {who:"cand",text:"It does, and it's fine because staleness is already the contract for this data. The seat map is inherently eventually consistent to the tune of a second; whether that update fans out to 1 copy or N copies changes propagation by milliseconds, not the correctness story. I push seat-state changes to all replicas of the hot key on each reserve/release, accept that different users might see the map a beat apart, and rely on the <strong>reserve-time DB check</strong> to make the final call. So I get the read scaling of replication without any new correctness risk — the exactness guarantee was never in the cache to begin with."},
      ],resources:[
        {title:"System Design Primer — cache & scaling",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"ByteByteGo",url:"https://bytebytego.com/"},
      ]},
      {l:"hard",tag:"failover",q:"The seat-map cache goes cold mid-sale — cold-start herd.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> peak on-sale, the seat-map cache node restarts and comes back <b>empty</b>. Suddenly 100% of ~450K seat-map reads/s that were hitting the cache miss through to the inventory DB — the exact store you were shielding so reserve writes stay fast. Describe the blast and contain it.</span>"},
        {who:"cand",text:"That's a <strong>cold-cache thundering herd</strong> aimed at the sacred store: the inventory DB, normally handling only paced writes, suddenly eats the full read firehose and its reserve writes starve — the failure I built the cache to prevent. Containment: <strong>(1) request coalescing / single-flight</strong> so one miss per seat map hits the DB and concurrent readers share the result. <strong>(2)</strong> serve reads from <strong>DB read replicas</strong>, never the write-primary, so the read surge can't touch the reserve write path. <strong>(3)</strong> run the cache as a <strong>replicated cluster</strong> so a single node restart fails over to a warm replica instead of emptying the whole tier."},
        {who:"intv",text:"Even with coalescing, re-warming takes time and the DB carries elevated load. Anything to blunt recovery — and can you just shed reads?"},
        {who:"cand",text:"Yes to both. To blunt it: <strong>pre-warm</strong> the hot event's seat map on cold start (it's a small, known set), use <strong>jittered TTLs</strong> so entries don't re-expire in lockstep, and let the <strong>edge/CDN cache</strong> keep absorbing reads with its last-good copy while the origin cache rebuilds. And critically — I can <strong>shed seat-map reads</strong> without harming correctness: the map is only display, so under duress I serve a slightly staler edge copy or degrade refresh frequency. The one thing I never shed or slow is the reserve write path. Reads degrade gracefully; the strongly-consistent write core stays protected."},
      ],resources:[
        {title:"System Design Primer — caching & availability",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"Redis — replication",url:"https://redis.io/docs/latest/develop/use/patterns/distributed-locks/"},
      ]},
      {l:"medium",tag:"capacity",q:"How much memory does the seat-map cache need?",turns:[
        {who:"intv",text:"Size the seat-map cache. How much memory, and is memory what you worry about here?"},
        {who:"cand",text:"The footprint is small; memory isn't the pressure point.<span class='eg'>A seat's cached state — status plus section/row/num — is ~50 bytes; a 100K-seat event ≈ ~5MB. Thousands of active events ≈ a few GB, easily one Redis node's RAM.</span>The pressure is read throughput — a hot event's map can be ~450K reads/s."},
        {who:"intv",text:"So what do you actually scale, if not memory?"},
        {who:"cand",text:"Read fan-out. One event's map being ~90% of reads pins a single node no matter how much RAM I have, so I scale by replicating the hot key across nodes and, above all, serving the map from the CDN/edge with a 1-2s TTL so most reads never reach Redis. The trade-off: replication and edge copies add mild staleness, but the map is already a display hint re-checked at reserve, so that costs nothing. I size the tier for throughput and hot-key spread and treat memory as effectively free."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"System Design Primer — cache",url:"https://github.com/donnemartin/system-design-primer#cache"},
      ]},
      {l:"medium",tag:"concept",q:"Which cache — Redis or Memcached, and why?",turns:[
        {who:"intv",text:"You keep saying Redis. Defend it against Memcached for the seat-map cache and the reservation locks — why Redis specifically?"},
        {who:"cand",text:"Memcached is a lean, multi-threaded, pure-LRU key-value cache — perfect if all I needed was to stash blobs. But I need more than GET/SET: atomic <code>SET NX EX</code> for reservation locks, sorted sets for the waiting room, and pub/sub to fan seat-state changes out to the cached map. Redis gives all of that plus replication and failover; Memcached has none of the data structures or pub/sub."},
        {who:"intv",text:"Memcached is simpler and multi-threaded — doesn't it win on raw per-node throughput?"},
        {who:"cand",text:"It can edge Redis on pure key-value throughput per core, yes. But that axis isn't my bottleneck — hot-key fan-out and edge caching already handle read volume — and I'd rather run one technology that also does locks, queue positions, and change pub/sub than bolt Memcached alongside a separate lock and queue system. So I choose Redis: the trade-off is giving up a little raw KV speed to get atomic locks, sorted-set queues, pub/sub, and replication in one store — decisive given how much of this design leans on those."},
      ],resources:[
        {title:"Redis distributed locks",url:"https://redis.io/docs/latest/develop/use/patterns/distributed-locks/"},
        {title:"System Design Primer — caching",url:"https://github.com/donnemartin/system-design-primer#cache"},
      ]},
    ],
    payment:[
      {l:"medium",tag:"concept",q:"Charge on a held seat — how does confirm work?",turns:[
        {who:"intv",text:"A user has seat 14A held and submits their card. Walk me through payment → confirmation, and be precise about when the seat becomes SOLD."},
        {who:"cand",text:"Booking calls the payment service to charge the card while the seat is <code>HELD</code>. The seat becomes <code>SOLD</code> <strong>only after</strong> a confirmed successful charge — booking transitions <code>HELD → SOLD</code>, writes the order, and emits the ticket. If the charge fails (declined, insufficient funds), booking <strong>releases the hold</strong> back to <code>AVAILABLE</code> and tells the user to retry with another card while their hold window lasts. Money-in strictly precedes seat-gone, so I never mark a ticket sold for a payment that didn't clear."},
        {who:"intv",text:"The charge lands but the hold expired one second before it confirmed. Now what — you took their money but the seat's gone?"},
        {who:"cand",text:"That's the ugly edge, and I resolve it in the user's favor without double-selling. Before flipping to SOLD I re-assert the hold with a conditional write; if the seat was reclaimed, I do <strong>not</strong> force-sell a seat that may now belong to someone else. Instead I either (a) auto-<strong>refund/void</strong> the charge via the saga's compensation and apologize, or (b) if the seat is still free, re-acquire and complete. I lean on a small grace buffer between hold expiry and hard release to shrink this window, and idempotent payment so a retry doesn't double-charge. The rule: never keep money for a seat I couldn't deliver, and never deliver a seat twice."},
      ],resources:[
        {title:"Saga pattern (compensation)",url:"https://microservices.io/patterns/data/saga.html"},
        {title:"HelloInterview — Ticketmaster",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ticketmaster"},
      ]},
      {l:"hard",tag:"failover",q:"Payment times out after the seat was reserved — did they pay?",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> seat 14A is HELD, booking calls the payment gateway to charge $250, and the call <b>times out</b> after 30s. Booking has no idea whether the charge went through. The user is staring at a spinner. Did they pay? Do they get the seat? Untangle it.</span>"},
        {who:"cand",text:"Timeout means <em>unknown</em>, not failed, so I must not guess. First, every charge carries an <strong>idempotency key</strong>, so booking can safely <strong>query or retry</strong> the payment gateway with the same key to learn the true outcome without risking a double charge. The seat stays <code>HELD</code> (not SOLD, not released) while I reconcile. If the gateway says the charge succeeded, I complete: <code>HELD → SOLD</code> + order + ticket. If it says no charge exists, I retry the charge or release the hold on expiry. The seat's fate follows the <em>confirmed</em> payment truth, discovered via idempotent reconciliation — never assumed from a timeout."},
        {who:"intv",text:"Booking itself crashes during that reconciliation. How does the outcome still get resolved correctly?"},
        {who:"cand",text:"I make the flow a durable <strong>saga</strong> rather than an in-memory sequence. Each step's intent and state is persisted (e.g. a <code>booking_saga</code> record: <code>RESERVED → CHARGING → CONFIRMED/COMPENSATED</code>), so a recovery worker can pick up any saga stuck in <code>CHARGING</code>, re-query the gateway by idempotency key, and drive it to a terminal state — confirm if paid, compensate (void/refund) if not. The seat's HELD TTL is the backstop: if nothing resolves it, the hold expires and the seat returns to inventory, and any stray successful charge is caught by reconciliation and refunded. So booking crashing just delays resolution; it never leaves a paid-but-no-seat or a sold-but-unpaid state permanently."},
      ],resources:[
        {title:"Saga pattern",url:"https://microservices.io/patterns/data/saga.html"},
        {title:"Two-phase commit protocol",url:"https://en.wikipedia.org/wiki/Two-phase_commit_protocol"},
      ]},
      {l:"medium",tag:"scaling",q:"On-sale drives a payment surge — don't drop charges.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> the waiting room admits ~5K concurrent buyers, and near the end of their hold windows you get a burst of ~5K charge submissions in a few seconds, all hitting a third-party payment gateway that rate-limits you and occasionally 503s. How do you handle the surge without losing sales?</span>"},
        {who:"cand",text:"Decouple submission from the gateway's capacity. I put charge requests through an <strong>async, durable path</strong> — enqueue the charge intent and let a worker pool process against the gateway at a rate that respects its limits, with <strong>retries and exponential backoff</strong> on 503s. Idempotency keys make those retries safe. The user sees 'processing payment' rather than a hard failure, and the hold protects their seat while the charge is in flight. The queue smooths my bursty 5K into a steady stream the gateway accepts, so a rate-limit or transient 503 becomes a short delay, not a lost sale."},
        {who:"intv",text:"The hold is only 10 minutes. If the payment backlog can't clear in time, seats expire while charges are still queued. Trade-off?"},
        {who:"cand",text:"I tune admission and hold windows together so this rarely bites: the waiting room's admission rate is set so the downstream payment throughput can keep up, meaning I don't admit more buyers than I can charge within a hold window. If the gateway degrades badly, I <strong>slow admission</strong> (backpressure from payment up to the waiting room) rather than let holds expire mid-charge. As a safety valve I can grant a small hold <strong>extension</strong> for reservations with a charge confirmed in-flight. The theme is consistent: backpressure the whole pipeline from the scarce resource outward, so I never accept work I can't finish before the hold dies."},
      ],resources:[
        {title:"System Design Primer — asynchronism & backpressure",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"Saga pattern",url:"https://microservices.io/patterns/data/saga.html"},
      ]},
      {l:"medium",tag:"capacity",q:"Size payment for the end-of-hold charge burst.",turns:[
        {who:"intv",text:"Near the end of the hold window, admitted buyers all submit cards at once. How do you size payment, and what bounds it?"},
        {who:"cand",text:"Payment throughput is bounded by the third-party gateway, not my compute.<span class='eg'>~5K admitted buyers → a burst of ~5K charges in a few seconds; each round-trips the gateway in ~1-2s. To clear 5K in ~30s at ~1.5s each I need ~250 charges in flight → a small async worker pool, not a big fleet.</span>The workers are I/O-bound waiters, so a few instances cover it."},
        {who:"intv",text:"So why not just fire all 5K at the gateway at once?"},
        {who:"cand",text:"Because the gateway rate-limits and occasionally 503s, so bursting drops charges. I enqueue charge intents and drain them through the worker pool at a rate the gateway accepts, with idempotent retries and backoff. The trade-off is added latency — the user sees 'processing' — versus lost sales, an easy call since the hold protects the seat meanwhile. I size workers to the gateway's ceiling, then backpressure that ceiling up to the waiting room so I never admit more buyers than I can charge inside a hold window."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"Saga pattern",url:"https://microservices.io/patterns/data/saga.html"},
      ]},
    ],
    search:[
      {l:"easy",tag:"concept",q:"How does browse/search differ from the booking path?",turns:[
        {who:"intv",text:"Users search 'concerts in Chicago next month' and browse results before booking. How is this service built, and why is it OK for it to be eventually consistent?"},
        {who:"cand",text:"It's a read-optimized <strong>search index</strong> (Elasticsearch-style) over event metadata — artist, venue, city, date, price range — supporting full-text and faceted queries, sorting, and pagination. It's fed <strong>asynchronously</strong> from the event catalog and a stream of inventory changes, so it lags true state by seconds. That's fine because search results influence <em>discovery</em>, not the sale: nothing a user sees in search can cause a double-book. The exact check only ever happens later, at reserve, against the inventory DB."},
        {who:"intv",text:"A search result shows 'tickets available' but the show sold out 30 seconds ago. Is that acceptable?"},
        {who:"cand",text:"Yes — it's the intended eventual-consistency trade. A stale 'available' badge just means the user clicks in and finds no green seats, which is mildly annoying and self-corrects on the next index refresh. The opposite choice — making search read exact live inventory — would put discovery's huge, spiky read load directly onto the strongly-consistent core I'm working hard to protect. So I deliberately keep search fast, scalable, and slightly stale, and concentrate exactness where it's load-bearing: the reserve transaction."},
      ],resources:[
        {title:"System Design Primer — search & eventual consistency",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"HelloInterview — Ticketmaster",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ticketmaster"},
      ]},
      {l:"medium",tag:"scaling",q:"Browse traffic dwarfs bookings — scale the read side.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> steady-state you get ~50K search/browse queries/s — far more than bookings — and it spikes when a marquee tour is announced. Meanwhile the inventory DB is busy with the on-sale it must not be disturbed for. Scale search independently.</span>"},
        {who:"cand",text:"Search scales on its own axis precisely because it's decoupled from inventory. The index is <strong>replicated and sharded</strong> across many read replicas, so query throughput scales horizontally by adding nodes. In front I add a <strong>CDN/cache</strong> for popular queries — 'concerts in Chicago' is asked by thousands, so I cache result pages with a short TTL. Since search reads its own index (not the inventory DB), all this read scaling happens <strong>without adding a single query to the strongly-consistent core</strong>. The on-sale and the browse flood live in separate systems by design."},
        {who:"intv",text:"How does the index stay current without you querying inventory to refresh it?"},
        {who:"cand",text:"Change-data-capture / an event stream: every catalog change and inventory state change is published to a log (Kafka-style), and indexing consumers apply those updates to the search index asynchronously. So freshness flows <strong>push, not pull</strong> — the index subscribes to changes rather than polling inventory, which means zero read load on the inventory DB and natural buffering if a burst of updates arrives. Lag is seconds and tunable by consumer parallelism, which is exactly the eventual-consistency budget search is allowed. The strongly-consistent core just emits its changes; it never serves a browse query."},
      ],resources:[
        {title:"System Design Primer — CDC & scaling reads",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"ByteByteGo",url:"https://bytebytego.com/"},
      ]},
      {l:"medium",tag:"failover",q:"Search is down — can users still buy?",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> the entire search service falls over for 15 minutes — the index cluster is unreachable. What can users still do, and how do you keep this from blocking sales during a live on-sale?</span>"},
        {who:"cand",text:"This is where the decoupling pays off: search being down is a <strong>discovery outage, not a sales outage</strong>. Anyone with a direct event link — which is exactly how on-sale traffic arrives (people go straight to the tour page) — can still hit the gateway, load the seat map, reserve, and pay, because none of that path touches search. So the critical revenue flow keeps working. What's degraded is open-ended browsing: 'find me something to do this weekend' returns errors or a fallback. I make search failure isolated so it never cascades into booking."},
        {who:"intv",text:"How do you degrade browse gracefully rather than showing a hard error?"},
        {who:"cand",text:"Serve <strong>fallbacks</strong>: the CDN keeps serving cached popular queries and category pages with its last-good copy, so common browses still render (slightly stale). For uncached queries I fall back to a simpler path — a static 'featured/trending events' list or a basic metadata lookup — rather than a blank error, and show a soft 'search is temporarily limited' banner. Because the index is a rebuildable read model fed from the durable catalog and event log, I can also <strong>rebuild it from the stream</strong> after recovery with no data loss. The user-facing principle: discovery degrades to a reduced experience, buying stays fully available."},
      ],resources:[
        {title:"System Design Primer — availability & graceful degradation",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"HelloInterview — Ticketmaster",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ticketmaster"},
      ]},
      {l:"medium",tag:"capacity",q:"How many search nodes for the browse load?",turns:[
        {who:"intv",text:"Steady-state you get ~50K search/browse queries/s, spiking when a marquee tour is announced. Size the search tier."},
        {who:"cand",text:"Storage is small; query throughput drives the node count.<span class='eg'>Event metadata is maybe a few million events × ~1KB ≈ a few GB — fits in memory across a handful of shards. A node serves ~5-10K queries/s → ~50K/s wants ~6-8 nodes; with replicas for HA call it ~10, plus a CDN caching popular query pages.</span>None of this touches the inventory DB — search reads its own index."},
        {who:"intv",text:"The announcement spike is unpredictable. Provision for peak or autoscale?"},
        {who:"cand",text:"I lean on the CDN first — 'concerts in Chicago' is asked by thousands, so cached result pages collapse the spike before it reaches the index. Behind that I keep replicas sized for steady ~50K/s with headroom and autoscale read replicas for the spike. The trade-off is index-replica cost versus spike risk, and because browse is eventually consistent and never blocks a sale, I under-provision relative to worst case and let the CDN plus autoscale absorb the marquee moments — a slightly slower browse is harmless."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"ByteByteGo",url:"https://bytebytego.com/"},
      ]},
      {l:"medium",tag:"concept",q:"Which search backend — Elasticsearch or Postgres full-text?",turns:[
        {who:"intv",text:"For discovery, why a dedicated Elasticsearch-style index instead of just Postgres full-text search on the events table?"},
        {who:"cand",text:"Postgres full-text (<code>tsvector</code> + GIN) is genuinely good and means one less system to run — fine at a modest catalog size. But discovery needs relevance ranking, faceted filters (city, date, price, genre), typo tolerance, and autocomplete, and it must scale reads independently of any transactional store. Elasticsearch is built for exactly that — inverted index, BM25 relevance, aggregations for facets, and horizontal read scaling."},
        {who:"intv",text:"Running Elasticsearch is real operational cost. When is Postgres full-text the right call?"},
        {who:"cand",text:"If the catalog were small and search a secondary feature, I'd keep it in Postgres full-text to avoid operating a second datastore and a sync pipeline — simplicity wins there. Here browse is a primary, high-QPS, spiky workload with rich ranking and faceting needs, so the trade-off flips: I pay the operational cost and the change-data-capture sync complexity of Elasticsearch to get relevance, facets, typo tolerance, and independent scaling. The clincher is isolation — a browse spike must never compete with booking, and a separate index guarantees it."},
      ],resources:[
        {title:"System Design Primer — search & eventual consistency",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"HelloInterview — Ticketmaster",url:"https://www.hellointerview.com/learn/system-design/answer-keys/ticketmaster"},
      ]},
    ],
  },
  mockTest:[
    {q:"Two users click seat 14A in the same millisecond. How do you guarantee exactly one wins, and where is that decided?",a:"The decision must be atomic in the database that owns the seat's state, not in application code. Use a single conditional write — UPDATE seats SET status='HELD', held_by=:tok WHERE seat_id='14A' AND status='AVAILABLE'. The DB serializes both writers on that row: exactly one update matches and affects one row; the other affects zero rows and returns a 409. Equivalent pessimistic form is SELECT ... FOR UPDATE to lock the row, check, and write. Either way the invariant is enforced at the single source of truth."},
    {q:"Why give a hold a TTL, and what mechanism frees an abandoned seat with no background job?",a:"A hold reserves a scarce seat while a human pays; without expiry an abandoned checkout locks the seat forever. Put the hold in a TTL'd store (Redis EX 600) so it self-expires in ~10 minutes and the seat frees automatically. Release is lazy and DB-enforced: the authoritative held-to-sold transition re-checks seat state, so even if the optional reaper is down the system never oversells or permanently loses a seat. The reaper only improves seat-map freshness; it is never load-bearing for correctness."},
    {q:"A million users hit Buy in the same second. How does a virtual waiting room protect the backend?",a:"On arrival each user gets a signed queue token and a position; a dispatcher admits users into an active pool at a rate matched to backend capacity (say ~5K concurrent checkouts) and only ADMITTED tokens are accepted for reserve calls. Unadmitted users poll a cheap, cacheable status endpoint that never touches inventory. The queue is the pressure-relief valve: the inventory DB only ever sees the bounded admitted load, never the raw 1M stampede, and admitted tokens carry a session TTL so no one hoards a slot."},
    {q:"Which datastore backs inventory, and why is ACID non-negotiable here when the data is tiny?",a:"A strongly-consistent relational store (Postgres/MySQL, or NewSQL like CockroachDB/Spanner for managed horizontal scale). The data is ~100MB per event, so storage and raw throughput are not the constraint — every candidate can serve the ~5-10K writes/s. The constraint is correctness under concurrency: the one-seat-one-order invariant needs ACID transactions spanning seat and order plus row-level locking. Eventually-consistent NoSQL (Cassandra) risks a stale replica double-selling; you don't trade a correctness property for throughput you don't need."},
    {q:"Reserve holds the seat but payment happens later. How do you keep money and inventory consistent?",a:"Split reserve from pay: reserve flips the seat to HELD with a TTL, then payment runs against the held seat. Model it as a saga — on payment success, atomically transition HELD to SOLD and write the order (the commit re-checks the hold is still valid and owned by this token). On payment failure or timeout, the hold expires and the seat returns to AVAILABLE. Charging is only confirmed after the order is durably committed, and every step is idempotent so retries after a crash don't double-charge or double-sell."},
    {q:"How do you size the booking fleet — for the 1M stampede or something else?",a:"Never size for 1M; that's the trap. The waiting room caps admitted concurrency at what the backend can absorb, so size to the admission ceiling. If you admit ~5K concurrent checkouts each doing a few short ops over a ~3-min window, that's ~2-3K ops/s; a stateless booking node handles ~1K ops/s, so ~3 nodes plus headroom across AZs. The admission rate itself is set by the weakest downstream link — inventory-DB write throughput and the payment gateway limit — and booking is kept just above it."},
    {q:"Browse and search traffic dwarf bookings. How do you scale them without disturbing the on-sale?",a:"Decouple discovery from inventory entirely. Search reads its own replicated, sharded index (Elasticsearch-style) fed asynchronously via change-data-capture from the catalog and inventory event stream — push, not pull — so it adds zero queries to the strongly-consistent core. Front it with a CDN caching popular query pages with a short TTL. Browse is eventually consistent, so seconds of lag is acceptable, and a browse spike can never compete with booking because they live in physically separate systems."},
    {q:"The inventory write-primary crashes mid on-sale and you promote a replica. How do you avoid double-selling on failover?",a:"The danger is split-brain: if the old primary rejoins still believing it's leader, two nodes could each sell seat 14A. Prevent it with consensus-based promotion — leader election (Raft/Paxos or a fencing coordinator) grants a monotonically increasing epoch, and replicas reject writes carrying a stale epoch (fencing token), so the old primary is demoted and re-syncs. During the few-second election you choose consistency over availability: reserves on that shard pause (the waiting room holds users gracefully) while reads stay up from replicas. A short pause beats selling one seat twice."},
  ]
};
