window.DATA = window.DATA || {};
window.DATA['ratelimiter'] = {
  cat:"counters · atomicity · limits",
  title:"Design a distributed rate limiter",
  blurb:"Enforce per-user / per-API-key limits accurately across a fleet of gateway nodes with sub-millisecond overhead.",
  prompt:"Let's design a distributed rate limiter. It sits in front of an API and enforces per-user / per-API-key quotas — say '1000 requests per minute for free tier' — across a whole fleet of gateway nodes. It has to be accurate (a global limit must actually be global), fast (it's on every request), and it must degrade gracefully. Start with requirements and rough numbers, then we'll drill into components — and I'll throw failure scenarios at you.",
  opening:"Let me frame it before drawing boxes.<br><br><strong>Functional:</strong> enforce per-key limits by tier (free / pro / enterprise), return a clean rejection when over limit, and make limits configurable without redeploy. <strong>Non-functional:</strong> decision overhead p99 &lt; 5ms (it's on every call), limits enforced <em>globally</em> across all nodes (not per-node), high availability, and it must fail in a defined direction when its state store is down.<br><br><strong>Back-of-envelope:</strong> ~1M requests/s across ~50 gateway nodes, ~10M active API keys, default 1000 req/min/key. One counter per (key, window) → ~10M hot counters; at ~100 bytes each that's ~1GB — small, until an algorithm choice blows it up. At 1M/s the counter store takes ~1M ops/s, so atomicity and hot keys dominate.<br><br>I'll start deliberately minimal: <strong>client → gateway / proxy → limiter service → counter store</strong>. The gateway asks the limiter 'allow or deny?', the limiter reads/writes a counter, done. As we hit accuracy and failure pressure I'll grow it — the algorithm engine, per-tier rules, cluster sync. Pick a box and let's push.",
  nodes:[
    {id:"client",name:"Client",sub:"callers",x:40,y:150},
    {id:"gw",name:"Gateway / proxy",sub:"enforcement",x:210,y:150},
    {id:"limiter",name:"Limiter service",sub:"decision",x:380,y:150},
    {id:"store",name:"Counter store",sub:"Redis cluster",x:550,y:150},
    {id:"algo",name:"Algorithm engine",sub:"bucket / window",x:380,y:40},
    {id:"config",name:"Rules / config",sub:"limits per tier",x:210,y:40},
    {id:"sync",name:"Cluster sync",sub:"coordination",x:550,y:40},
  ],
  edges:[["client","gw","request"],["gw","limiter","check"],["limiter","store","incr"],["limiter","algo","evaluate"],["limiter","config","load rules"],["store","sync","replicate"]],
  core:["client","gw","limiter","store"],
  basic:["client","gw","limiter","store"],
  deepDive:{
    client:{
      role:"The API caller. It's thin, but its behavior on a <code>429</code> decides whether rate limiting is a cooperative contract or a retry-storm amplifier. The single most consequential lever it owns: whether it <strong>honors <code>Retry-After</code></strong> and paces off <code>X-RateLimit-Remaining</code>, or ignores both and hammers a tight retry loop that turns one rejection into more load.",
      capacity:[
        ["Decision budget it rides on","p99 < 5ms","limiter answers on every call"],
        ["Over-limit response","HTTP 429 + Retry-After","cheap to reject vs allow"],
        ["Good-client behavior","backoff + jitter","self-throttle before hitting 0"],
      ],
      data:"Stateless from the server's view. The only client-side state that matters is the <code>X-RateLimit-*</code> counters it reads back (limit / remaining / reset) and the <code>Retry-After</code> it should be tracking — hints for self-pacing, never authoritative. The server never trusts the client to limit itself.",
      scaling:[
        "Honor <code>Retry-After</code> and add <strong>exponential backoff + jitter</strong> so a fleet of clients doesn't retry in lockstep at the window boundary.",
        "Watch <code>X-RateLimit-Remaining</code> and slow down <em>before</em> hitting zero, cutting the 429s the server has to serve.",
        "Treat a 429 as a signal to pace, not an error to immediately retry.",
      ],
      failures:[
        {t:"Client ignores Retry-After and retry-storms",b:"One 429 becomes a tight retry loop, adding over-limit load exactly when the system is stressed.",m:"Reject the over-limit key cheaply at the gateway from the local cache (no limiter/store hop); persistent offenders get flagged by the heavy-hitter detector and shed at the edge."},
        {t:"10K clients share one reset boundary and fire at 12:01:00",b:"A synchronized 10K-request spike every minute — a thundering herd.",m:"Jitter <code>Retry-After</code> and, structurally, move to continuous-refill (token bucket / sliding window) so there's no shared unlock instant."},
      ],
      tradeoffs:[
        {a:"Trust client self-throttling",b:"Enforce server-side regardless",pick:"Client cooperation is an optimization that reduces load; correctness must never depend on it, so the server rejects over-limit traffic cheaply whether or not the client behaves."},
      ],
      probes:[
        "Your API returns 429 with Retry-After: 30 — what should a good client do, and what do bad ones do?",
        "You can't control third-party clients — how do you protect yourself from retry-storms?",
        "A shared limit resets on the minute and 10K clients all fire at once — fix the stampede.",
      ],
    },
    gw:{
      role:"The enforcement choke point every request passes through: terminate TLS, authenticate, resolve the key's rule, call the limiter for allow/deny, and return <code>429</code> when over. Its single most consequential lever is that a <strong>rejected request must be far cheaper than an allowed one</strong> — over-limit keys are rejected in-process from a local cache without ever touching the limiter or store, which is what lets it survive a flood.",
      capacity:[
        ["Arrival rate","~1M req/s (3-5x peak)","spread across the fleet"],
        ["Per-node budget","~20K req/s","TLS + conn handling dominate, not the limiter hop"],
        ["Nodes","~50, ~65 with headroom","1M ÷ 20K, across 3 AZs"],
        ["Rule resolution","in-memory hash lookup","microseconds, off the store"],
      ],
      data:"Horizontally <strong>stateless</strong> — no durable per-request state, so it scales by adding nodes. It caches two things in memory: the rule set (pushed from config) and a short-lived <strong>over-limit / denylist cache</strong> of hot abusive keys, both derived and rebuildable, never a source of truth.",
      scaling:[
        "Reject known-over-limit keys <strong>in-process</strong> from the local cache so a flood of a few abusive keys costs almost nothing.",
        "Autoscale on connection/CPU; front it with upstream <strong>L3/L4 protection</strong> so volumetric garbage never reaches L7.",
        "Enforce a per-node <strong>concurrency/connection cap</strong> that sheds (429/503 + Retry-After) rather than collapsing while autoscaling warms.",
      ],
      failures:[
        {t:"DDoS-like flood pushes arrivals 1M→8M/s",b:"Gateway CPU/connections saturate; the limiter and store melt if every junk request triggers a decision.",m:"In-process rejection of over-limit keys, autoscaling, and L3/L4 shedding make the flood cheap — most of the 8M/s never reaches a real decision."},
        {t:"Gateway→limiter path flaps, 40% of decision RPCs time out",b:"The gateway blocks on hung calls and latency climbs for <em>all</em> requests.",m:"Tight timeout + circuit breaker: on trip, fall back to the local approximate limiter with a conservative cap; a decision call must be bounded and non-blocking."},
      ],
      tradeoffs:[
        {a:"Enforce at the gateway",b:"In-app library",pick:"The gateway is the single choke point that sees all traffic for a key, so a global limit stays global; an in-app library only sees one process, silently multiplying '1000/min' by fleet size."},
        {a:"Reject cheaply in-process",b:"Call the limiter for every request",pick:"A rejected request must cost a fraction of an allowed one, so a flood of abusive keys is shed locally — the gateway is part of the DDoS defense, not a victim sized to absorb it."},
      ],
      probes:[
        "Enforce at the gateway, a sidecar, or an in-app library — where and why?",
        "What exactly do you return over-limit — status and headers — and why send limit headers on 200s too?",
        "A flood pushes arrivals to 8M/s of mostly-junk — what falls over and how do you keep legit traffic flowing?",
      ],
    },
    limiter:{
      role:"The stateless decision service: resolve the rule, identify the window/bucket, do <strong>one atomic op</strong> against the counter store, compare to the limit, return allow + remaining or deny. Its single most consequential lever is that the decision is a <em>single atomic operation</em>, not a read-then-write — that's the difference between a limit that holds and one that leaks under concurrency.",
      capacity:[
        ["Throughput floor","~1M decisions/s","one per request"],
        ["Per-instance (strict-central)","~25K/s","rule lookup + one store round-trip"],
        ["Instances","~40, ~52 with headroom","1M ÷ 25K, across 3 AZs"],
        ["Per-instance (local counting)","~200K/s → 5-8 instances","microsecond in-process decision"],
      ],
      data:"<strong>Stateless</strong> — every durable count lives in the counter store, so any instance answers for any key. It caches the rule set in memory. Optionally it holds <em>local per-node counters</em> for the highest-volume tiers, a deliberate volatile buffer traded against bounded overshoot between syncs.",
      scaling:[
        "Stateless → scale linearly by adding instances; the count is really set by the store round-trip, not CPU.",
        "For accuracy-critical tiers stay <strong>strict-central</strong> (increment the shared counter every request); batch/pipeline store ops to cut the per-decision cost.",
        "For high-volume tiers use <strong>local counting</strong> with periodic reconcile — microsecond decisions at the cost of a few percent overshoot.",
      ],
      failures:[
        {t:"Counter store fully unreachable at 1M req/s",b:"The limiter can't read/write any count — every decision fails.",m:"Apply the configured <strong>fail direction</strong> (default fail-open) but never to <em>unlimited</em>: fall back to a local in-memory cap (global/N), a conservative static ceiling, and a local denylist; alert loudly."},
        {t:"A limiter pod is SIGKILLed with ~90K un-synced local increments",b:"Those counts are lost — brief under-counting, so a few callers exceed their limit until the window resets.",m:"Bounded + self-healing (one sync-interval of one node); for billing-grade tiers don't buffer at all — run strict-central so every allowed request is counted before admission."},
      ],
      tradeoffs:[
        {a:"Strict-central counting",b:"Local + async sync",pick:"Central is exact but pays a network hop per request and pins throughput to the store; local decides in microseconds but overshoots between syncs — pick per tier by how contractual the limit is."},
        {a:"Atomic single op",b:"Read-then-write",pick:"Read-modify-write lets two nodes both see 999 and both allow (1001 through); a single atomic <code>INCR</code>/<code>EVAL</code> returns the post-increment value so exactly one crosses the line."},
      ],
      probes:[
        "Walk me through one allow/deny decision end to end, and why atomic matters for a single decision.",
        "At 1M req/s every decision is a Redis round-trip and p99 is 8ms — keep hitting central or move state local?",
        "How many limiter instances, and what actually sets that number?",
      ],
    },
    store:{
      role:"The source-of-truth counter store: an in-memory Redis cluster holding one small counter per (key, window), <strong>hash-slotted by api-key</strong> so all of a key's windows converge on one owning shard. Its single most consequential property is <strong>atomicity per key</strong> — <code>INCR</code> returns the post-increment value and <code>Lua EVAL</code> runs token-bucket refill-check-decrement as one indivisible step, so the limit can't leak under concurrent nodes.",
      capacity:[
        ["Throughput floor","~1M ops/s","one op per request, sharded"],
        ["Shards","~10-12 (×100K ops/s/node)","throughput, not RAM, sets the count"],
        ["Nodes","~24","each shard a primary + replica"],
        ["Memory","~1-2GB × RF3 ≈ 3-6GB","~100 bytes × 10M keys — nearly empty"],
      ],
      data:"Ephemeral by design: key <code>rl:user:{id}:{window}</code> → one integer, with native <code>EXPIRE</code> of ~2 windows so stale buckets self-delete — never a scan, never history. One owner per key means atomic, coordination-free increments. Consistency comes from single-owner atomics + replica failover, not disk durability; a lost counter just resets and re-establishes next window.",
      scaling:[
        "<strong>Hash-slot by api-key</strong> so 10M keys spread across shards and each key's counter is a single-node atomic op.",
        "Keep every per-key structure to <strong>O(1) integers</strong> so memory never binds (avoid sliding-window-log's per-request timestamps).",
        "For a genuinely hot key, split it into <code>key#1..#N</code> sub-counters across shards and sum, spreading the write load.",
      ],
      failures:[
        {t:"Two nodes race a key at 999/1000",b:"Both read 999, both allow, 1001 admitted — the limit leaks by one.",m:"Never split read and write: atomic <code>INCR</code> returns 1000 (allow) / 1001 (deny); multi-step token bucket runs as one <code>Lua EVAL</code> on the owning shard."},
        {t:"One abusive key at 400K req/s hotspots its shard to 100%",b:"Every key on that shard goes slow — sharding balances keys, not load per key.",m:"Shed the flagged key at the edge (no store op), cache 'blocked' locally, and fan the hot counter into sub-counters across shards; a count-min heavy-hitter detects it in a second or two."},
      ],
      tradeoffs:[
        {a:"Redis (atomic + Lua + TTL)",b:"Memcached / disk-backed DB",pick:"Redis is the only candidate hitting all five criteria; Memcached lacks server-side scripting so token bucket becomes a racy CAS loop, and a disk DB's ms-scale fsync/quorum commit blows the 5ms budget for durability ephemeral counters don't need."},
        {a:"In-memory, replication for failover",b:"Disk durability",pick:"Counters are TTL'd and self-rebuild each window, so paying disk-write latency 1M times/s buys nothing; failover comes from a promoted replica, not persistence."},
      ],
      probes:[
        "Give me the concrete key shape, value, and TTL for '1000 req/min per key', and what sharding by api-key costs at 10M keys.",
        "Token bucket needs read-check-refill-decrement — INCR alone doesn't cover it. Now what?",
        "A shard node dies and its counters are gone — are those keys now unlimited?",
      ],
    },
    algo:{
      role:"The counting engine co-located in the limiter that turns '1000/min' into an actual allow/deny. It's the heart of correctness: the algorithm choice decides whether a boundary burst lets 2x through, and whether per-key state is <strong>O(1) integers</strong> or an O(requests) log. Its most consequential lever is defaulting to a continuous-refill, O(1) algorithm (token bucket / sliding-window-counter).",
      capacity:[
        ["Cost per decision (O(1) algos)","sub-microsecond","a few arithmetic ops"],
        ["Engine CPU at 1M/s","a small fraction of a core","free by construction"],
        ["Sliding-window-counter state","2 integers/key","current + previous window"],
        ["Sliding-window-log state","~1000 entries/key","O(requests) — the outlier"],
      ],
      data:"Holds <strong>no durable state</strong> — the counters live in the store; the engine is pure computation. Token bucket keeps <code>{tokens, last_refill_ts}</code> per key and <strong>recomputes tokens from elapsed time on read</strong>, so even a reset bucket self-corrects deterministically rather than depending on what was persisted.",
      scaling:[
        "Default to <strong>O(1)</strong> algorithms (token bucket, sliding-window-counter) so engine CPU stays free and the store holds 1-2 integers per key.",
        "Use <strong>sliding-window-counter</strong> to kill the fixed-window boundary burst cheaply — blend current + previous window by overlap, accurate to within a few percent.",
        "Per-tier algorithm selection driven by config — reserve the exact-but-expensive log only for the low-volume tiers that need it.",
      ],
      failures:[
        {t:"Fixed window allows a boundary burst",b:"1000 at 12:00:59 + 1000 at 12:01:00 = 2000 in 2s, both windows 'legal' — 2x the intended rate.",m:"Default to continuous-refill (token bucket) or sliding-window-counter, which weights the trailing window so the burst can't hide across the boundary."},
        {t:"Sliding-window-log memory explodes",b:"10M keys × ~1000 timestamps ≈ 10B entries (~80GB+) — past cluster capacity.",m:"Switch to sliding-window-counter: 2 integers/key (~160MB total), a ~500x cut for a few-percent boundary error; keep the log only for the few tiers needing exactness."},
      ],
      tradeoffs:[
        {a:"Token bucket",b:"Leaky bucket",pick:"Token bucket allows controlled bursts up to a cap while bounding the average — the normal API case; leaky bucket enforces a strictly smooth output (and a real queue adds latency), for protecting a spike-averse downstream."},
        {a:"Sliding-window-counter (O(1))",b:"Sliding-window-log (exact)",pick:"The counter is approximate within a few percent but O(1) integers; the log is exact but O(requests) memory — for a limiter, bounding the order of magnitude beats billing to the exact request, so pay for the log only per-tier."},
      ],
      probes:[
        "Lay out the five algorithms for '1000/min' — what each gets right and wrong.",
        "Give me the sliding-window-counter formula — how does it approximate without storing every request?",
        "Token bucket state resets on a node restart — what's the correctness impact and how do you handle it?",
      ],
    },
    config:{
      role:"The rules/config plane that owns limits per tier plus per-key overrides, and pushes changes fleet-wide without a redeploy. It's off the hot path (nodes cache it in memory), but it's a <strong>live control</strong> — its most consequential property is that a bad push is a <em>global outage</em>, so safe rollout matters more than throughput.",
      capacity:[
        ["Rule-set size","~1MB","handful of tiers + ~10K overrides × ~100 bytes"],
        ["Nodes caching it","~80","full set in memory, refreshed on change"],
        ["Propagation","~1-2s fleet-wide","push (watch/pub-sub) + poll backstop"],
        ["Config store","3-node etcd-class","rare writes + ~80 subscriptions"],
      ],
      data:"A small, <strong>versioned, immutable</strong> rule set — base tier rules plus per-key overrides resolved by precedence (override &gt; tier), each rule naming the limit, window, <em>and</em> algorithm. The etcd-class store is the runtime source of truth for distribution and versioning; a git/control-plane mirror carries the human audit + two-person review. Nodes cache the latest version and hot-swap; each reports the version it enforces.",
      scaling:[
        "<strong>Push-based</strong> distribution (watch/pub-sub) for ~1-2s propagation, with periodic polling as a backstop so a missed notification still converges.",
        "Nodes persist a <strong>last-known-good snapshot</strong> and boot from it if the store is unreachable, reconciling later — config-store downtime degrades freshness, never enforcement availability.",
        "Keep the whole set cached in memory so rule resolution is a microsecond hash lookup, never a per-request store hit.",
      ],
      failures:[
        {t:"Fat-fingered rule sets a tier limit to 0",b:"Propagates to all 80 nodes in 2s — every default-tier request 429s, a global outage.",m:"Validation at write time, canary/staged rollout watching 429 rates, two-person review, plus a limiter sanity guardrail that refuses a tier-wide 0 without an explicit flag; recover by publishing the previous immutable version."},
        {t:"Config store unreachable at node startup",b:"A fresh node has no rules — risk of 'no limits' or a crash-loop.",m:"Boot from the local last-known-good snapshot, or a conservative built-in default floor if none exists; keep retrying and report the enforced version so 'stale forever' is visible and paged."},
      ],
      tradeoffs:[
        {a:"etcd for push + versioning",b:"RDBMS or versioned git file",pick:"etcd gives native watches (sub-second push), revision numbers as versions, and HA in one; an RDBMS has no native watch, and a git file has a great audit trail but slow propagation — so split roles: etcd on the hot path, git for review/audit."},
        {a:"Push distribution",b:"Poll distribution",pick:"Push propagates a limit change in ~1-2s but holds a connection per node; poll is simpler but slower — use push for speed with poll as a convergence backstop."},
      ],
      probes:[
        "Describe the rule shape — tiers, overrides, precedence — and how a request ends up with one number.",
        "An enterprise limit must go from 5M to 20M/min now across 80 caching nodes — how does it reach every node, and how fast?",
        "Someone pushes a tier limit of 0 and it fans out in 2s — walk me through prevention and recovery.",
      ],
    },
    sync:{
      role:"The coordination layer that lets many nodes share one global count when a single-owner counter isn't enough (hot keys, or local per-node counting for latency). It reconciles per-node deltas into a global view and hands back budgets. Its most consequential lever is <strong>proportional budget allocation</strong> — reallocating the remaining global limit toward where traffic actually is, rather than a wasteful static global/N.",
      capacity:[
        ["Fleet","~50 limiter nodes","report deltas every ~500ms"],
        ["Report rate","~100 reports/s","batched, many keys each — bandwidth-bound"],
        ["Aggregator state","~500MB","one budget per active key, ~50 bytes × 10M"],
        ["Deployment","1 HA aggregator + standby","shard by key-hash only if it outgrows a node"],
      ],
      data:"Holds only <strong>derived, ephemeral</strong> state — the authoritative counts live in the replicated counter store, so anything the aggregator computes is reconstructable from node deltas + the store. That's why it runs redundantly for availability but deliberately <em>without</em> its own persistence.",
      scaling:[
        "Track budgets only for <strong>active/high-volume keys</strong> (most of the 10M are idle), keeping the real working set far below 10M.",
        "Allocate budget <strong>proportional to recent traffic</strong> per node, refreshed every ~500ms, so busy nodes get a bigger slice and idle nodes don't hoard.",
        "Shard the aggregator by key-hash only once the active-key set or report bandwidth outgrows one node — don't pay sharding for a 500MB problem.",
      ],
      failures:[
        {t:"Sync channel partitions for 10s under budget-splitting",b:"Nodes spend stale allocations with no reconciliation — over-admission bounded by the sum of stale budgets.",m:"Allocations <strong>expire</strong> (decay toward a conservative floor after ~2s), fall back to strict-central via the still-reachable store, and cap the max any node allows between syncs."},
        {t:"The central aggregator restarts with empty state",b:"In-flight global sums are gone.",m:"The state is soft and reconstructable — nodes re-report local deltas and the authoritative counts sit in the store, so the global view rebuilds within a sync cycle; worst case one interval of slightly-stale allocations."},
      ],
      tradeoffs:[
        {a:"Strict-central (small limits)",b:"Budget-splitting via sync (large limits)",pick:"For a hard 100/min across 20 nodes, central atomic counting is exact and cheap (low volume anyway); budget-splitting shines when the limit is large relative to node count (100K ÷ 20 = 5000 each), and rounds badly when small."},
        {a:"Err strict on coordination loss",b:"Err generous",pick:"On a sync failure decay budgets toward conservative so a few legit requests get 429+retry rather than letting the global limit blow out — the whole point of the component is bounding load."},
      ],
      probes:[
        "What's the actual coordination mechanism — central store, periodic flush, or gossip — and how does budget get divided?",
        "Limit is 100/min, a 500-request burst hits 20 nodes evenly — how does sync stop each node allowing 100?",
        "The sync channel partitions for 10s under budget-splitting — what goes wrong and how do you bound it?",
      ],
    },
  },
  dbDoc:{
    component:"Counter store",
    load:"Sits on <strong>every</strong> request and does one counter op per decision, so its throughput floor is the full request rate: ~1M req/s &rarr; ~1M counter ops/s the store must sustain, sharded. Memory is tiny: one small counter per (key, window) &asymp; ~100 bytes/key &times; ~10M active keys &asymp; ~1GB live; token-bucket / sliding-window-counter is 1-2 integers per key, so still low single-digit GB &times;3 replication &asymp; ~3-6GB. Access = atomic read-modify-write on a single key, native TTL, p99 inside the 5ms decision budget.",
    candidates:[
      {name:"Memcached (multi-threaded KV)",ceiling:"~several hundred K ops/s per node (higher raw incr than Redis)",nodes:"~4-6 nodes on paper for 1M ops/s &mdash; fewer than Redis by raw throughput alone",pick:false,note:"atomic incr exists but there is <strong>no server-side scripting</strong>, so token bucket collapses to a client-side <code>GET</code> + compute + <code>CAS</code> retry loop that races under contention &mdash; the raw node count is misleading once the algorithm needs more than a bare increment."},
      {name:"In-memory + gossip (counters in each limiter's RAM)",ceiling:"millions of ops/s per node (no network hop &mdash; local memory speed)",nodes:"no separate tier &mdash; runs inside the ~50 limiter instances, deltas gossiped between rounds",pick:false,note:"atomic locally but only <strong>eventually consistent globally</strong>, so the limit drifts between gossip rounds; kept only as a local-counting layer on top for the highest-volume tiers that trade a few percent overshoot for latency."},
      {name:"Redis (in-memory, single-owner shards)",ceiling:"~100K+ ops/s per node for simple atomic ops",nodes:"1M ops/s &divide; ~100K/node &asymp; <strong>10-12 shards</strong>; each a primary + replica for failover &rarr; ~24 nodes, memory (~1-2GB) nearly empty &mdash; throughput sets the count, not RAM",pick:true,note:"chosen &mdash; atomic <code>INCR</code> returns the post-increment value (two racing nodes get 1000 allow / 1001 deny, no read-modify-write window), <code>Lua EVAL</code> runs token-bucket refill-check-decrement as one atomic unit, native <code>EXPIRE</code> TTL, and replica failover &mdash; the only candidate hitting all five criteria."},
    ],
    indexing:"One counter per (api-key, window): key = <code>rl:user:{id}:{window}</code> (e.g. <code>rl:user:42:1m</code>, trailing segment is the minute bucket), value a single integer. <strong>Hash-slot by api-key</strong> so all of one key's windows land on <em>one</em> shard &mdash; every one of the 50 limiter instances routes that key's <code>INCR</code> to the same owner, making the count authoritative and atomic there with no cross-shard coordination. Atomicity is the whole game: a bare <code>INCR</code> is one atomic round-trip (no client-side compare-then-write to race on), and anything multi-step like token bucket runs as a <code>Lua EVAL</code> so refill-check-decrement is one indivisible server-side step. Expiry is a native <code>EXPIRE</code> of ~2 windows so stale buckets self-delete &mdash; never a scan, and I never accumulate history. No secondary index &mdash; the per-key point op is the only access path.",
    decision:"Pick <strong>Redis as the source-of-truth counter store</strong>. The workload is ~1M atomic counter ops/s on ~10M ephemeral keys under a 5ms p99 budget &mdash; Redis is the only candidate hitting all five criteria (atomic <code>INCR</code> + <code>Lua</code>, native <code>EXPIRE</code>, replica failover, microsecond latency, ~100K+ ops/s/node &rarr; ~12 shards). <strong>Not Memcached:</strong> no server-side scripting forces token bucket into a racy client-side <code>CAS</code> loop, so its higher raw incr throughput is a false economy. <strong>Not a disk-backed DB</strong> (Postgres/DynamoDB): a fsync/quorum commit is single-to-tens of ms &mdash; one such write blows the whole 5ms budget, and counters are ephemeral (TTL'd, self-rebuild each window) so disk durability is a cost with no matching benefit; failover comes from replication, not disk. <strong>In-memory + gossip</strong> stays only as an optional local-counting layer for the highest-volume tiers, trading bounded overshoot for latency &mdash; not the authoritative store.",
  },
  schema:{tables:[
    {name:"rate_limit_rules",pk:"rule_id",columns:[
      ["rule_id","varchar(40)","primary key (config DB, not Redis)"],
      ["scope","varchar(16)","user / api-key / ip"],
      ["tier","varchar(16)","free / pro / enterprise"],
      ["limit","int","max requests per window"],
      ["window_seconds","int","window length in seconds"],
      ["algorithm","varchar(24)","token_bucket / sliding_window / fixed_window"],
    ],rows:[
      ["free-default","api-key","free","1000","60","sliding_window"],
      ["pro-default","api-key","pro","100000","60","token_bucket"],
      ["ent-k_ent_3","api-key","enterprise","5000000","60","token_bucket"],
    ]},
    {name:"counters",pk:"key",columns:[
      ["key","string","Redis key, e.g. rl:user:42:1m (api-key + minute bucket)"],
      ["count","integer","requests seen in this window (INCR)"],
      ["window_start","epoch","start of the current window"],
      ["ttl","seconds","auto-expire ~2 windows so stale buckets self-delete"],
    ],rows:[
      ["rl:user:42:1m","975","1718000460","118"],
      ["rl:api-key:k_pro_9:1m","30412","1718000460","119"],
      ["rl:ip:203.0.113.7:1m","1000","1718000460","117"],
    ]},
    {name:"token_buckets",pk:"key",columns:[
      ["key","string","Redis key per api-key, e.g. tb:k_pro_9"],
      ["tokens","float","tokens currently available in the bucket"],
      ["last_refill_ts","epoch-ms","last time tokens were added (drives refill math)"],
    ],rows:[
      ["tb:k_pro_9","41287.5","1718000487320"],
      ["tb:k_ent_3","4998200.0","1718000487295"],
    ]},
  ]},
  flows:[
    {id:"allow",name:"Request under the limit (allowed)",steps:[
      {node:"client",text:"Client sends an API request with key <code>k_free_42</code>."},
      {node:"gw",text:"Gateway authenticates and forwards an allow-or-deny check to the limiter."},
      {node:"config",requires:["config"],text:"Limiter resolves key &rarr; free tier &rarr; rule <strong>1000/min, sliding_window</strong> from cached rules."},
      {node:"algo",requires:["algo"],text:"Algorithm engine computes the current window estimate for this key."},
      {node:"store",text:"Atomically <code>INCR</code>s the counter for <code>rl:user:42:1m</code>; new value 976."},
      {node:"algo",requires:["algo"],text:"Engine sees 976 &le; 1000, so the decision is <strong>allow</strong> with 24 remaining."},
      {node:"gw",text:"Gateway forwards the request upstream and returns <code>X-RateLimit-Remaining: 24</code>."},
      {node:"client",text:"Client receives a normal <code>200</code> response."},
    ]},
    {id:"throttle",name:"Request over the limit (429)",steps:[
      {node:"client",text:"Client sends another request for <code>k_free_42</code>, already near its cap."},
      {node:"gw",text:"Gateway forwards the allow-or-deny check to the limiter."},
      {node:"config",requires:["config"],text:"Limiter resolves the same rule: <strong>1000/min, sliding_window</strong>."},
      {node:"store",text:"Atomically <code>INCR</code>s <code>rl:user:42:1m</code>; new value 1001."},
      {node:"algo",requires:["algo"],text:"Algorithm engine sees 1001 &gt; 1000 and returns <strong>deny</strong>."},
      {node:"sync",requires:["sync"],text:"Cluster sync had reconciled per-node deltas into this counter, so the global limit holds across the fleet."},
      {node:"gw",text:"Gateway rejects with <code>429 Too Many Requests</code> and <code>Retry-After: 30</code>."},
      {node:"client",text:"Client honors <code>Retry-After</code> and backs off for 30 seconds."},
    ]},
  ],
  deepFlows:[
    {id:"strict-central-e2e",name:"Strict allow/deny",summary:"**API request** → gateway extracts <code>k_free_42</code> → cached rule <code>free-default</code> (<code>1000/60s sliding_window</code>) → **Redis Cluster slot by api-key** → one atomic Lua decision → <code>200</code> with remaining quota or <code>429</code> with retry guidance.",steps:[
      {node:"client",title:"Client sends an API call",snap:{cap:"No mutation yet. The request carries <code>k_free_42</code>; the authoritative Redis counters still show the current bucket at 539 and previous bucket at 800 before this request is evaluated.",tables:[{name:"counters (redis shard-7 primary redis-7a)",note:"read-only context before the request",cols:["key","count","window_start","ttl"],rows:[{c:["rl:api-key:{k_free_42}:1718000460","539","1718000460","118"],hi:1,tag:"current"},{c:["rl:api-key:{k_free_42}:1718000400","800","1718000400","58"],tag:"previous"}]}]},narrate:"The caller does not call the limiter directly; it sends the normal API request with an API key. The limit is enforced before the request reaches the protected backend, so a rejected request is cheap.",details:[
        {k:"wire",label:"Request on the wire",lang:"http",code:"GET /v1/reports?date=2026-07-25 HTTP/1.1\nHost: api.example.com\nX-API-Key: k_free_42\nX-Request-Id: req_7f3a"},
      ]},
      {node:"gw",title:"Gateway authenticates and gates",snap:{cap:"Gateway work is still local: authenticate the key, miss the deny cache, and make a bounded decision RPC. Redis remains unchanged until Lua runs on the owner shard.",tables:[{name:"gateway deny cache (in-memory)",note:"derived, rebuildable; no Redis mutation",cols:["key","count","window_start","ttl"],rows:[{c:["k_free_42","miss","local-cache","0"],hi:1,tag:"not denied"}]},{name:"counters (redis shard-7 primary redis-7a)",cols:["key","count","window_start","ttl"],rows:[{c:["rl:api-key:{k_free_42}:1718000460","539","1718000460","118"]},{c:["rl:api-key:{k_free_42}:1718000400","800","1718000400","58"]}]}]},narrate:"The gateway terminates TLS, authenticates <code>k_free_42</code>, and checks its in-process deny cache first. If the key is not already known-over-limit, it asks the limiter for a decision with a very tight timeout so the rate limiter cannot stall all traffic.",details:[
        {k:"wire",label:"Decision RPC",lang:"json",code:"{\n  \"key\": \"k_free_42\",\n  \"scope\": \"api-key\",\n  \"cost\": 1,\n  \"request_id\": \"req_7f3a\",\n  \"now_ms\": 1718000487320\n}"},
        {k:"note",label:"Cheap reject path",text:"If <code>k_free_42</code> is in the gateway's short-lived over-limit cache, the gateway returns <code>429</code> locally and skips the limiter/store hop. A denied request must cost far less than an allowed one."},
      ]},
      {node:"config",title:"Resolve the rule from cache",snap:{cap:"Read-only rule resolution: cached config returns <code>free-default</code>, cap <strong>1000</strong> over <strong>60s</strong>, algorithm <code>sliding_window</code>. No counter changes yet.",tables:[{name:"rate_limit_rules (limiter cache v43)",note:"read from memory, sourced from config",cols:["rule_id","scope","tier","limit","window_seconds","algorithm"],rows:[{c:["free-default","api-key","free","1000","60","sliding_window"],hi:1,tag:"read"},{c:["pro-default","api-key","pro","100000","60","token_bucket"]}]}]},narrate:"The limiter keeps the small versioned rule set in memory, so rule lookup is a microsecond hash lookup, not a per-request config-store read. For this key the cached tier maps to <code>free-default</code>.",details:[
        {k:"query",label:"Rule row used",lang:"sql",code:"SELECT rule_id, scope, tier, limit, window_seconds, algorithm\nFROM rate_limit_rules\nWHERE rule_id = 'free-default';\n-- free-default | api-key | free | 1000 | 60 | sliding_window"},
        {k:"note",label:"Why config is off path",text:"The full rule set is only ~1MB and fans out to ~80 nodes in ~1-2s. Keeping it cached preserves the p99 &lt; 5ms decision budget and avoids making config availability part of every request."},
      ]},
      {node:"algo",title:"Compute the sliding-window keys",snap:{cap:"The algorithm maps the request to two Redis rows: current bucket 539 and previous bucket 800. At 27.32s into the minute, previous weight is about 0.545, so pre-increment estimate is <code>539 + 800*0.545 &asymp; 975</code>.",tables:[{name:"counters (redis shard-7 primary redis-7a)",note:"both keys share hash tag {k_free_42} and one owner",cols:["key","count","window_start","ttl"],rows:[{c:["rl:api-key:{k_free_42}:1718000460","539","1718000460","118"],hi:1,tag:"current key"},{c:["rl:api-key:{k_free_42}:1718000400","800","1718000400","58"],hi:1,tag:"weighted prev"}]}]},narrate:"The algorithm engine turns <code>1000/min sliding_window</code> into two Redis counters: current minute and previous minute. It estimates the trailing 60s by weighting the previous bucket by the fraction of the window still overlapping.",details:[
        {k:"route",label:"Window math",lang:"text",code:"window_start = floor(now_ms / 60000) * 60000\nelapsed      = now_ms - window_start\nweight_prev  = (60000 - elapsed) / 60000\nestimated    = current_count + previous_count * weight_prev"},
        {k:"gotcha",label:"Why not fixed window",text:"A fixed minute bucket would allow <code>1000</code> at 12:00:59 and another <code>1000</code> at 12:01:00. The sliding-window counter keeps O(1) state but removes most of that boundary burst."},
      ]},
      {node:"store",title:"Route to one Redis shard and run Lua",snap:{cap:"Lua runs atomically on shard-7: current bucket increments <strong>539&rarr;540</strong>, previous stays 800, weighted estimate becomes <code>540 + 800*0.545 &asymp; 976</code>, so the request is allowed under 1000.",tables:[{name:"counters (redis shard-7 primary redis-7a)",note:"slot 8123 owned by redis-7a; replica follows async",cols:["key","count","window_start","ttl"],rows:[{c:["rl:api-key:{k_free_42}:1718000460","540","1718000460","120"],hi:1,tag:"INCR +1"},{c:["rl:api-key:{k_free_42}:1718000400","800","1718000400","58"]}]}]},narrate:"All counters for <code>k_free_42</code> use the same Redis hash tag, so every limiter instance routes this key to the same cluster slot and the same primary shard. Redis executes the script atomically on that owner: increment, set TTL, read previous bucket, compute estimate, and return the decision.",details:[
        {k:"route",label:"Key and shard scheme",lang:"text",code:"current = rl:api-key:{k_free_42}:1718000460\nprev    = rl:api-key:{k_free_42}:1718000400\nslot    = CRC16('k_free_42') % 16384\nshard   = slot -> one of ~12 Redis primaries"},
        {k:"query",label:"Atomic sliding-window script",lang:"lua",code:"-- KEYS[1]=current, KEYS[2]=previous\n-- ARGV[1]=limit, ARGV[2]=ttl_seconds, ARGV[3]=prev_weight\nlocal current = redis.call('INCR', KEYS[1])\nif current == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end\nlocal previous = tonumber(redis.call('GET', KEYS[2]) or '0')\nlocal estimate = current + previous * tonumber(ARGV[3])\nlocal allowed = estimate <= tonumber(ARGV[1])\nlocal remaining = math.max(0, tonumber(ARGV[1]) - math.floor(estimate))\nreturn { allowed and 1 or 0, remaining, current, previous }"},
        {k:"repl",label:"Replication behavior",text:"The primary returns only after the Lua script completes locally, then streams the mutation to its replica(s) asynchronously for failover. Counters are ephemeral and TTL'd, so the design prioritizes sub-ms atomicity over disk/quorum durability; a promoted replica may miss only the last few increments, not durable business data."},
      ]},
      {node:"limiter",title:"Interpret the result",snap:{cap:"The script result is an allow decision: post-increment current=540, previous=800, weighted estimate &asymp;976, leaving <strong>24</strong> requests before the cap. No extra store write is needed.",tables:[{name:"counters (decision readback)",note:"Lua return values, not a second GET",cols:["key","count","window_start","ttl"],rows:[{c:["rl:api-key:{k_free_42}:1718000460","540","1718000460","120"],hi:1,tag:"allowed"},{c:["rl:api-key:{k_free_42}:1718000400","800","1718000400","58"]}]}]},narrate:"The limiter converts the script output into an allow/deny response. Under the cap it returns remaining tokens; over the cap it computes how long until the weighted estimate can fall under 1000 again.",details:[
        {k:"wire",label:"Allow decision",lang:"json",code:"{\n  \"allowed\": true,\n  \"limit\": 1000,\n  \"remaining\": 24,\n  \"reset_ms\": 1718000520000,\n  \"rule_id\": \"free-default\"\n}"},
        {k:"wire",label:"Deny decision",lang:"json",code:"{\n  \"allowed\": false,\n  \"limit\": 1000,\n  \"remaining\": 0,\n  \"retry_after_seconds\": 30,\n  \"rule_id\": \"free-default\"\n}"},
      ]},
      {node:"gw",title:"Return headers to the caller",snap:{cap:"Gateway forwards the request and returns headers derived from the same atomic decision: limit 1000, remaining 24, reset at the current bucket boundary. The counter remains 540 after the allowed request.",tables:[{name:"counters (redis shard-7 primary redis-7a)",cols:["key","count","window_start","ttl"],rows:[{c:["rl:api-key:{k_free_42}:1718000460","540","1718000460","120"],hi:1,tag:"committed"}]},{name:"gateway response state",note:"derived headers",cols:["key","count","window_start","ttl"],rows:[{c:["k_free_42","remaining=24","reset=1718000520","policy=free-default"],hi:1,tag:"200"}]}]},narrate:"The gateway either forwards the request upstream or rejects it immediately. It always sends limit headers so cooperative clients can slow down before they hit zero.",details:[
        {k:"wire",label:"Allowed response headers",lang:"http",code:"200 OK\nX-RateLimit-Limit: 1000\nX-RateLimit-Remaining: 24\nX-RateLimit-Reset: 1718000520"},
        {k:"wire",label:"Over-limit response",lang:"http",code:"429 Too Many Requests\nRetry-After: 30\nX-RateLimit-Limit: 1000\nX-RateLimit-Remaining: 0\nX-RateLimit-Reset: 1718000520"},
      ]},
    ]},

    {id:"local-budget-e2e",name:"Local budget sync",summary:"For high-volume tiers, **config picks token_bucket + local counting** → sync allocates per-node budgets every ~500ms → limiter spends locally in microseconds → deltas reconcile back to Redis; latency drops while overshoot is bounded and explicit.",steps:[
      {node:"config",title:"Pick the high-volume rule",snap:{cap:"Read-only config choice: enterprise key <code>k_ent_3</code> uses the high-volume <code>token_bucket</code> rule with a 5,000,000/min cap, so it can trade exact-per-request Redis calls for bounded local budgets.",tables:[{name:"rate_limit_rules (limiter cache v43)",cols:["rule_id","scope","tier","limit","window_seconds","algorithm"],rows:[{c:["ent-k_ent_3","api-key","enterprise","5000000","60","token_bucket"],hi:1,tag:"read"},{c:["free-default","api-key","free","1000","60","sliding_window"]}]},{name:"token_buckets (redis shard-3 primary redis-3a)",cols:["key","tokens","last_refill_ts"],rows:[{c:["tb:{k_ent_3}","4100000.0","1718000487000"],hi:1,tag:"authoritative"}]}]},narrate:"Not every tier needs the same accuracy/latency trade. The enterprise key <code>k_ent_3</code> uses <code>5000000/min token_bucket</code>, where a few-percent soft overshoot is acceptable compared with paying a Redis round-trip for every request.",details:[
        {k:"query",label:"Enterprise rule",lang:"sql",code:"SELECT rule_id, limit, window_seconds, algorithm\nFROM rate_limit_rules\nWHERE rule_id = 'ent-k_ent_3';\n-- ent-k_ent_3 | 5000000 | 60 | token_bucket"},
        {k:"gotcha",label:"Per-tier, not universal",text:"Free tier <code>1000/min</code> can stay strict-central because volume is low and accuracy matters. High-volume enterprise traffic can use local budgets because the limit is large enough to divide across nodes without rounding the caller down to nothing."},
      ]},
      {node:"sync",title:"Sync allocates node budgets",snap:{cap:"Sync sees about 4.1M tokens left and leases slices for epoch 44. The sum of granted leases is bounded below the authoritative remaining tokens, and busy limiter-17 gets a larger share.",tables:[{name:"token_buckets (redis shard-3 primary redis-3a)",cols:["key","tokens","last_refill_ts"],rows:[{c:["tb:{k_ent_3}","4100000.0","1718000487000"],hi:1,tag:"source"}]},{name:"budget_allocations (sync memory epoch 44)",note:"derived lease state, expires in ~2s",cols:["node_id","granted","spent","ttl_ms"],rows:[{c:["limiter-17","82000","0","2000"],hi:1,tag:"granted"},{c:["limiter-08","61000","0","2000"]},{c:["limiter-22","34000","0","2000"]}]}]},narrate:"Cluster sync tracks recent deltas from the ~50 limiter nodes and hands each node a slice of the remaining global budget, weighted by recent traffic. Allocations expire quickly so a partition cannot spend stale credit forever.",details:[
        {k:"route",label:"Budget formula",lang:"text",code:"global_limit = 5_000_000 per 60s\nused_global = Redis/token bucket view + reported deltas\nremaining   = global_limit - used_global\nnode_i_share = remaining * recent_rps_i / sum(recent_rps_all)\nlease_ttl_ms = 2000"},
        {k:"wire",label:"Budget pushed to limiter-17",lang:"json",code:"{\n  \"key\": \"k_ent_3\",\n  \"rule_id\": \"ent-k_ent_3\",\n  \"budget\": 82000,\n  \"valid_until_ms\": 1718000489000,\n  \"epoch\": 44\n}"},
        {k:"note",label:"Why proportional",text:"Static <code>global/N</code> wastes quota on idle nodes and starves busy ones. Proportional allocation moves budget toward where traffic is actually landing while keeping the sum of all leases bounded by the global remaining budget."},
      ]},
      {node:"limiter",title:"Spend budget locally",snap:{cap:"Limiter-17 admits this request without a Redis hop: local spent becomes <strong>1</strong> of 82,000, leaving 81,999 in the lease. The authoritative bucket is unchanged until the next delta report.",tables:[{name:"budget_allocations (limiter-17 memory epoch 44)",cols:["node_id","granted","spent","ttl_ms"],rows:[{c:["limiter-17","82000","1","1840"],hi:1,tag:"local -1"}]},{name:"token_buckets (redis shard-3 primary redis-3a)",note:"not touched on this hot-path decision",cols:["key","tokens","last_refill_ts"],rows:[{c:["tb:{k_ent_3}","4100000.0","1718000487000"]}]}]},narrate:"For a request hitting limiter-17, the hot-path decision is now an in-memory decrement guarded by the allocation epoch. That moves per-instance throughput from ~25K/s strict-central toward ~200K/s local decisions.",details:[
        {k:"query",label:"In-process check",lang:"python",code:"b = budgets['k_ent_3']\nif now_ms <= b.valid_until_ms and b.remaining >= 1:\n    b.remaining -= 1\n    local_delta['k_ent_3'] += 1\n    return ALLOW\nreturn strict_central_or_deny()"},
        {k:"note",label:"Latency trade",text:"This avoids the Redis round-trip on most enterprise requests and keeps decision overhead comfortably below 5ms. The price is that the global count is exact only at reconcile boundaries, not every microsecond."},
      ]},
      {node:"sync",title:"Report deltas every ~500ms",snap:{cap:"After ~500ms, limiter-17 reports the batch it spent locally: 7,231 enterprise requests in epoch 44. Sync now has the delta but Redis has not yet been decremented in this step.",tables:[{name:"budget_allocations (sync memory epoch 44)",cols:["node_id","granted","spent","ttl_ms"],rows:[{c:["limiter-17","82000","7231","1500"],hi:1,tag:"reported"},{c:["limiter-08","61000","4120","1500"]}]},{name:"token_buckets (redis shard-3 primary redis-3a)",cols:["key","tokens","last_refill_ts"],rows:[{c:["tb:{k_ent_3}","4100000.0","1718000487000"]}]}]},narrate:"Limiter nodes periodically flush compact per-key deltas to sync. The report rate is small — around 50 nodes times two reports per second — but each report can batch many active keys.",details:[
        {k:"wire",label:"Delta report",lang:"json",code:"{\n  \"node\": \"limiter-17\",\n  \"epoch\": 44,\n  \"interval_ms\": 500,\n  \"deltas\": { \"k_ent_3\": 7231, \"k_pro_9\": 188 }\n}"},
        {k:"note",label:"Bounded loss on crash",text:"If limiter-17 is SIGKILLed 400ms into the interval, only that node's unflushed volatile delta is lost. The error is bounded to one sync interval and self-heals when the next window/refill establishes a new budget."},
      ]},
      {node:"store",title:"Reconcile to the authoritative store",snap:{cap:"Sync folds limiter-17's <strong>7,231</strong> delta into the Redis token bucket. Tokens converge from 4,100,000 to <strong>4,092,769</strong> before any refill math, making Redis authoritative again for the spent lease.",tables:[{name:"token_buckets (redis shard-3 primary redis-3a)",cols:["key","tokens","last_refill_ts"],rows:[{c:["tb:{k_ent_3}","4092769.0","1718000487500"],hi:1,tag:"delta applied"}]},{name:"budget_allocations (sync memory epoch 44)",cols:["node_id","granted","spent","ttl_ms"],rows:[{c:["limiter-17","82000","7231 reconciled","1450"],hi:1,tag:"converged"}]}]},narrate:"Sync folds node deltas into the Redis token-bucket state for the key. The store remains the source of truth; sync's budgets are derived and reconstructable.",details:[
        {k:"query",label:"Token-bucket reconcile",lang:"lua",code:"-- KEYS[1]=tb:k_ent_3, ARGV[1]=delta, ARGV[2]=now_ms\nlocal bucket = redis.call('HMGET', KEYS[1], 'tokens', 'last_refill_ts')\nlocal tokens = tonumber(bucket[1] or '5000000')\nlocal last = tonumber(bucket[2] or ARGV[2])\nlocal refill = math.max(0, (tonumber(ARGV[2]) - last) * (5000000 / 60000))\ntokens = math.min(5000000, tokens + refill) - tonumber(ARGV[1])\nredis.call('HMSET', KEYS[1], 'tokens', tokens, 'last_refill_ts', ARGV[2])\nredis.call('EXPIRE', KEYS[1], 120)\nreturn tokens"},
        {k:"route",label:"Same key locality",text:"The token bucket key <code>tb:k_ent_3</code> is hash-slotted by the API key, just like fixed counters, so one Redis owner serializes the authoritative updates for that key."},
      ]},
      {node:"algo",title:"State the accuracy bound",snap:{cap:"Bound is explicit: at this moment reconciled usage is 7,231, unreported exposure is at most the remaining valid leases plus one 500ms interval. As leases expire, allocations decay toward strict-central rather than drifting forever.",tables:[{name:"budget_allocations (sync memory epoch 44)",note:"valid leases are the maximum temporary drift",cols:["node_id","granted","spent","ttl_ms"],rows:[{c:["limiter-17","82000","7231 reconciled","1400"],hi:1,tag:"known"},{c:["limiter-08","61000","4120 pending","1400"]},{c:["limiter-22","34000","0 pending","1400"]}]},{name:"token_buckets (redis shard-3 primary redis-3a)",cols:["key","tokens","last_refill_ts"],rows:[{c:["tb:{k_ent_3}","4092769.0","1718000487500"],hi:1,tag:"authoritative"}]}]},narrate:"This flow is intentionally approximate. The design is acceptable only because it names the maximum drift and falls back to strict-central for hard tiers.",details:[
        {k:"gotcha",label:"Overshoot bound",text:"Worst case is the sum of unspent valid leases plus one report interval of unflushed deltas. Keep leases small, expire them after ~2s, report every ~500ms, and decay toward a conservative floor on sync loss."},
        {k:"note",label:"When not to use it",text:"Billing-grade or contractual limits should not buffer volatile counts. They pay the strict-central Redis Lua cost so every allowed request is counted before admission."},
      ]},
    ]},

    {id:"redis-failover-e2e",name:"Redis shard failure",summary:"A key's counter is **single-owner on one Redis primary** with async replicas; if that primary fails, a replica promotes while limiters apply the explicit fail direction — usually **fail-open with a local cap**, never unlimited.",steps:[
      {node:"store",title:"One key has one owning primary",snap:{cap:"Key <code>k_free_42</code> maps to slot 8123 on shard-7 primary <strong>redis-7a</strong>. The replica is close behind, so atomic Lua has one owner while failover has a warm copy.",tables:[{name:"counters (shard-7 primary redis-7a · slot 8123)",note:"owner for hash tag {k_free_42}",cols:["key","count","window_start","ttl"],rows:[{c:["rl:api-key:{k_free_42}:1718000460","540","1718000460","72"],hi:1,tag:"owner"},{c:["rl:api-key:{k_free_42}:1718000400","800","1718000400","12"]}]},{name:"counters (shard-7 replica redis-7b)",note:"async replica may lag by a few increments",cols:["key","count","window_start","ttl"],rows:[{c:["rl:api-key:{k_free_42}:1718000460","538","1718000460","72"],tag:"replica"}]}]},narrate:"The cluster has roughly 10-12 Redis primaries for ~1M ops/s, each with a replica for failover. Sharding by API key makes all windows for <code>k_free_42</code> converge on one owner, which is why atomic increments work across ~50 limiter instances.",details:[
        {k:"route",label:"Cluster placement",lang:"text",code:"CRC16('k_free_42') -> slot 8123\nslot 8123 -> shard-7 primary redis-7a\nreplica redis-7b tails redis-7a's replication stream"},
        {k:"repl",label:"Async replica, ephemeral counters",text:"Redis replication is asynchronous here. A primary crash can lose a few very recent counter increments, but counters have ~2-window TTLs and are not billing records, so the system accepts tiny under-counting instead of putting disk/quorum latency on every request."},
      ]},
      {node:"store",title:"Primary shard disappears",snap:{cap:"redis-7a is gone, so the owner row is temporarily unreachable. The replica still has count 538, meaning only the last couple of increments are at risk; the limiter must not treat the missing primary as an empty counter.",tables:[{name:"counters (shard-7 primary redis-7a)",note:"primary down during promotion",cols:["key","count","window_start","ttl"],rows:[{c:["rl:api-key:{k_free_42}:1718000460","540","1718000460","70"],gone:1,hi:1,tag:"primary down"}]},{name:"counters (shard-7 replica redis-7b)",cols:["key","count","window_start","ttl"],rows:[{c:["rl:api-key:{k_free_42}:1718000460","538","1718000460","70"],hi:1,tag:"promotion candidate"}]}]},narrate:"If <code>redis-7a</code> crashes, all keys in its slots see connection errors or Redis Cluster redirections during promotion. Without replication those ~1M active keys would reset to zero; with a replica they keep almost all in-window counts.",details:[
        {k:"wire",label:"Limiter sees shard error",lang:"text",code:"EVALSHA ... rl:api-key:{k_free_42}:1718000460\n-> timeout / CLUSTERDOWN / TRYAGAIN while shard-7 promotes"},
        {k:"gotcha",label:"What would be bad",text:"Treating the missing shard as a fresh empty counter silently gives every affected key a full new quota. Treating it as global fail-closed can turn one Redis node loss into an API outage for a twelfth of users."},
      ]},
      {node:"limiter",title:"Apply the fail-direction policy",snap:{cap:"For free-tier abuse protection the policy is fail-open with a local guard, not unlimited. Each gateway/limiter node gets about <code>1000/50 = 20/min</code> for this key while shard-7 is unavailable.",tables:[{name:"rate_limit_rules (limiter cache v43)",cols:["rule_id","scope","tier","limit","window_seconds","algorithm"],rows:[{c:["free-default","api-key","free","1000","60","sliding_window"],hi:1,tag:"fail-open local cap"}]},{name:"degraded_local_caps (limiter memory)",note:"derived fallback, expires when Redis slot recovers",cols:["node_id","granted","spent","ttl_ms"],rows:[{c:["gw-12","20","3","2000"],hi:1,tag:"local cap"},{c:["gw-27","20","0","2000"]}]}]},narrate:"The limiter handles shard unavailability with the same explicit policy as full-store-down, but scoped to the affected keys. The default for abuse-prevention is fail-open with a weaker local guard; hard/costly tiers can be configured fail-closed.",details:[
        {k:"query",label:"Degraded local cap",lang:"python",code:"if redis_shard_unavailable(key):\n    if rule.fail_direction == 'closed':\n        return DENY(retry_after=2)\n    cap = min(rule.limit / 50, rule.degraded_static_cap)\n    return local_token_bucket(key, cap, window=rule.window_seconds)"},
        {k:"note",label:"Fail open, not unlimited",text:"For free <code>1000/min</code>, a per-node fallback around <code>1000/50 = 20/min</code> plus a conservative static ceiling bounds abuse while keeping legitimate traffic alive during a seconds-long failover."},
        {k:"gotcha",label:"Accuracy cost",text:"A caller sprayed evenly across all ~50 nodes can overshoot the local fallback sum until Redis returns. That is an explicit availability trade-off, not a hidden correctness guarantee."},
      ]},
      {node:"gw",title:"Gateway sheds repeat offenders locally",snap:{cap:"A repeat offender on gw-12 has spent the degraded local cap and is rejected in-process. This protects the recovering shard because retry traffic no longer causes Redis calls.",tables:[{name:"degraded_local_caps (gw-12 memory)",cols:["node_id","granted","spent","ttl_ms"],rows:[{c:["gw-12","20","20","1600"],hi:1,tag:"cap spent"}]},{name:"gateway deny cache (in-memory)",note:"derived from local cap exhaustion",cols:["key","count","window_start","ttl"],rows:[{c:["k_free_42","deny","degraded-local","2s"],hi:1,tag:"429 local"}]}]},narrate:"While the shard is degraded, the gateway's deny cache becomes more important. Keys that clearly exceed the local fallback are rejected in-process, keeping retries from hammering the recovering Redis shard.",details:[
        {k:"wire",label:"Degraded 429",lang:"http",code:"429 Too Many Requests\nRetry-After: 2\nX-RateLimit-Policy: degraded-local\nX-RateLimit-Remaining: 0"},
        {k:"note",label:"Protect the recovery path",text:"The gateway also applies jittered <code>Retry-After</code> and circuit breaking so thousands of clients do not stampede the shard the instant it is promoted."},
      ]},
      {node:"sync",title:"Promotion completes and counters converge",snap:{cap:"redis-7b becomes the new primary for slot 8123. Strict-central resumes from replica count 538; two lost increments plus 4 degraded local admits reconcile to count <strong>542</strong>, and future Lua decisions are serialized on redis-7b.",tables:[{name:"counters (shard-7 new primary redis-7b · slot 8123)",cols:["key","count","window_start","ttl"],rows:[{c:["rl:api-key:{k_free_42}:1718000460","542","1718000460","64"],hi:1,tag:"promoted + converged"}]},{name:"degraded_local_caps (fleet)",note:"fallback discarded after slot map refresh",cols:["node_id","granted","spent","ttl_ms"],rows:[{c:["gw-12","20","4 reconciled","0"],gone:1,tag:"removed"}]}]},narrate:"Redis Cluster promotes the replica and clients refresh their slot map. Strict-central keys resume Lua decisions on the new primary; local-budget keys report their degraded-mode deltas back through sync so budgets are recalculated.",details:[
        {k:"repl",label:"Failover guarantee",text:"The promoted replica has the primary's replication stream except possibly the last milliseconds of writes. The resulting under-count is bounded and disappears as TTL'd counters expire or token buckets refill."},
        {k:"route",label:"Client routing after promotion",lang:"text",code:"old: slot 8123 -> redis-7a primary\nfailover: redis-7b promoted\nnew: slot 8123 -> redis-7b primary\nlimiter refreshes slot map and resumes EVALSHA"},
      ]},
    ]},
  ],
  requirements:{
    functional:[
      "Enforce a request limit per API key / user, by tier (free / pro / enterprise)",
      "Return a clean rejection (HTTP 429) with retry guidance when a caller is over limit",
      "Change a limit per tier or per key without a redeploy",
    ],
    nonFunctional:[
      "Decision overhead p99 &lt; 5ms — the limiter sits on every request",
      "Limits enforced globally across the whole gateway fleet, not per-node",
      "High availability, and fail in a defined direction when the counter store is down",
      "Scale to ~1M req/s across ~50 gateway nodes and ~10M active keys",
    ],
  },
  reqBuild:[
    {req:"Enforce a per-user request limit",reveal:["algo"],turns:[
      {who:"intv",text:"Start with the simplest thing that satisfies requirement one: one API key, one limit, one counter. What's the minimal path, and where does the count live?"},
      {who:"cand",text:"The <strong>client</strong> hits the <strong>gateway</strong>, which asks the <strong>limiter service</strong> allow-or-deny. The limiter <strong>atomically increments a counter</strong> in the <strong>counter store</strong> for that key, compares the new value to the limit, and returns allow or deny. That's the whole path — my four core boxes cover it. The limiter itself is <strong>stateless</strong>; every durable count lives in the store, so any limiter instance can answer for any key behind the whole gateway fleet."},
      {who:"intv",text:"You said '1000 per minute.' How exactly are you counting that — and does the choice actually change behaviour?"},
      {who:"cand",text:"It changes everything, so let me pull the counting logic into its own <strong>algorithm engine</strong> — it's the heart of correctness. A naive fixed window (one counter per clock minute) is cheap but allows a boundary burst of twice the rate. I'd default to a <strong>token bucket</strong> (smooth, bounded bursts) or a <strong>sliding-window counter</strong> (kills the boundary burst for two integers per key). The engine owns which algorithm and window a rule uses; the store just holds the counters. We can compare the algorithms in depth later."},
    ],resources:[
      {title:"Stripe: scaling your API with rate limiters",url:"https://stripe.com/blog/rate-limiters"},
      {title:"Token bucket",url:"https://en.wikipedia.org/wiki/Token_bucket"},
    ]},
    {req:"Configurable limits per tier / rule",reveal:["config"],turns:[
      {who:"intv",text:"Free tier is 1000/min, pro is 100K/min, enterprise is custom. How does the gateway know which limit applies to a given key, and how do you change a limit without a redeploy?"},
      {who:"cand",text:"The limit is <strong>data, not code</strong>, so let me add a <strong>rules / config</strong> component that owns limits per tier plus per-key overrides. On each request the gateway resolves key &rarr; tier &rarr; rule, and hands the (limit, window, algorithm) to the engine. Config is loaded into the limiter and pushed on change, so editing a limit is a config update — near-instant, no redeploy. Each rule also names its algorithm, so config drives not just the number but how it's counted."},
      {who:"intv",text:"Resolving key &rarr; tier on every request could be a lookup per call. Doesn't that cost you?"},
      {who:"cand",text:"It would if I hit a config store per request, so I don't. The rule set is small (a handful of tiers plus a modest override list) and effectively static, so each limiter <strong>caches it in memory</strong> and refreshes on a change notification. Key &rarr; tier is either encoded in the API key prefix or cached with a long TTL. So rule resolution is an in-memory hash lookup — microseconds, off the store entirely. The config component's job is distribution and correctness of the rules, not being on the per-request hot path."},
    ],resources:[
      {title:"Stripe: scaling your API with rate limiters",url:"https://stripe.com/blog/rate-limiters"},
      {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
    ]},
  ],
  systemDives:[
    {title:"One counter store, many gateway nodes — counts drift",tag:"scaling",reveal:["sync"],turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> to hit the 5ms budget you moved counting local — each of <b>50</b> limiter nodes keeps an in-memory counter and reconciles only every <b>1s</b>. The limit is 1000/min. In the second before a sync, traffic lands on all 50 nodes and each allows up to its own budget, so the global count sails past 1000. How do you keep the global limit actually global?</span>"},
      {who:"cand",text:"This is the core latency-vs-accuracy trade. <strong>Strict-central</strong> (increment one shared counter per request) is exact but pays a network hop and pins throughput to the store. <strong>Local + async sync</strong> decides in microseconds but a node only knows its own recent traffic between syncs. To make local counting safe I add a <strong>cluster sync</strong> component that reconciles each node's local deltas into a global view and hands back budgets — so no node ever thinks it owns the full limit."},
      {who:"intv",text:"How does sync divide the budget so the sum across nodes can't exceed the limit?"},
      {who:"cand",text:"Budget-splitting. Every interval, sync sums the nodes' reported usage and allocates each node a <strong>fraction of the remaining global budget</strong>, proportional to its recent traffic — a busy node gets a bigger slice, an idle node a smaller one — and a node may only spend its slice. Naive global/N (20 each here) wastes budget on idle nodes and starves busy ones, so proportional allocation matters. The sum of the slices is the global limit, so the fleet can't over-admit even though each decision is local."},
      {who:"intv",text:"Give me the concrete overshoot bound with local counting so we're honest about it."},
      {who:"cand",text:"Worst case, in the interval before a sync each of the 50 nodes admits up to its slice independently, so a sudden fan-out can briefly exceed 1000 until the next reconcile. I bound it three ways: <strong>tighten the sync interval</strong> (smaller drift window), give each node <strong>global/N</strong> rather than the full limit as its ceiling, and <strong>fall back to strict-central</strong> for tiers where accuracy is contractual. It's a deliberate, bounded, self-healing error — the store's authoritative value re-establishes each window — traded for latency, and the right split is per-tier, not one-size."},
    ],resources:[
      {title:"Cloudflare: counting things, a lot of different things",url:"https://blog.cloudflare.com/counting-things-a-lot-of-different-things/"},
      {title:"Stripe: scaling your API with rate limiters",url:"https://stripe.com/blog/rate-limiters"},
    ]},
    {title:"The Redis counter store is DOWN — fail open or closed",tag:"failover",turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> the Redis counter store is fully unreachable — connection timeouts on every decision. The limiter literally cannot read or write a count. <b>1M req/s</b> are arriving right now. Do you allow them or reject them?</span>"},
      {who:"cand",text:"This is the defining decision for a rate limiter, and it depends on what the limiter <em>protects</em>. <strong>Fail open</strong> (allow when the store is down) keeps the product working but removes protection — a good default when the limiter guards against <em>abuse</em> and the backend can survive a burst. <strong>Fail closed</strong> (reject) preserves protection but takes the whole API down over a limiter dependency — right only when unlimited traffic causes real harm. Most public APIs <strong>fail open</strong>: a rate limiter must not be a single point of failure for availability. But I make it explicit and configurable, not accidental."},
      {who:"intv",text:"Fail open means during the outage an abuser gets unlimited requests. Mitigate that without failing fully closed."},
      {who:"cand",text:"Degrade, don't flip. <strong>(1)</strong> Fall back to a <strong>local in-memory limiter</strong> on each node (global/N budget) so an abuser hitting one node is still bounded. <strong>(2)</strong> Apply a conservative <strong>static cap</strong> well below the paid limit during degraded mode so the blast is contained. <strong>(3)</strong> Shed obviously-abusive keys via a cheap local denylist. <strong>(4)</strong> Alert loudly. So the honest posture is 'fail open globally, but never to <em>unlimited</em>' — fall back to a weaker local guard rather than hand an attacker a blank cheque."},
      {who:"intv",text:"When Redis comes back, how do you snap back to exact enforcement safely?"},
      {who:"cand",text:"A <strong>circuit breaker</strong> around the store call. While it's tripped the limiter serves from the local fallback; it periodically <strong>half-opens</strong> and probes the store with a trickle of real decisions. Once the store answers healthily the breaker closes and every node resumes strict-central counting against the authoritative counters. The local fallback is explicitly temporary and its counters are discarded on recovery — I don't try to reconcile approximate local counts back into the store, because the store's live value is already the truth the moment it returns. Availability during the blip, exactness the rest of the time."},
    ],resources:[
      {title:"Stripe: scaling your API with rate limiters",url:"https://stripe.com/blog/rate-limiters"},
      {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
    ]},
    {title:"Two nodes race the same counter — atomicity",tag:"durability",turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a key is at <b>999/1000</b>. Two requests land on two limiter nodes within the same millisecond. Both do 'read count (999), it's under limit, allow, then write 1000.' Now <b>1001</b> requests were admitted. Walk me through preventing this exactly.</span>"},
      {who:"cand",text:"That's a classic <strong>read-modify-write race</strong>, and the fix is to never split read and write. Redis <code>INCR</code> is atomic and returns the post-increment value, so each request does one op: node A's <code>INCR</code> returns 1000 (allow), node B's returns 1001 (deny). There's no window where both see 999. The general rule: the decision must be a single atomic operation on the store, not a client-side compare-then-write."},
      {who:"intv",text:"But token bucket needs read-check-refill-decrement — that's multiple ops. <code>INCR</code> alone doesn't cover it. Now what?"},
      {who:"cand",text:"Anything beyond a bare counter needs multi-step atomicity, and the clean tool is a <strong>Lua script via <code>EVAL</code></strong>. Redis runs the whole script atomically on the owning shard, so 'compute refill, check tokens, decrement, return allow/deny' happens as one indivisible unit — no interleaving between the two racing nodes. Separate <code>GET</code>/<code>SET</code> with <code>EXPIRE</code> also races on the <code>EXPIRE</code>. Lua collapses the whole read-modify-write into one atomic server-side step, which is the only fully correct answer for a distributed limiter."},
      {who:"intv",text:"Say you buffer increments locally for speed and a node crashes with un-flushed counts. Does that break the invariant?"},
      {who:"cand",text:"It doesn't break correctness, it costs a little accuracy. Un-flushed increments are <strong>lost</strong>, which <em>under</em>-counts: a few keys briefly look like they used less quota, so a handful of callers get slightly over their limit until the window resets. It's a <strong>bounded, self-healing</strong> error — worst case one sync interval of one node's traffic — because the <strong>store, not the node, is the source of truth</strong> and its authoritative value re-establishes next window. For billing-grade tiers I don't buffer at all: those run strict-central so every allowed request is durably counted before admission. Durability of the count scales with how much the count is worth."},
    ],resources:[
      {title:"Redis: EVAL and Lua scripting",url:"https://redis.io/docs/latest/develop/interact/programmability/eval-intro/"},
      {title:"Token bucket",url:"https://en.wikipedia.org/wiki/Token_bucket"},
    ]},
    {title:"One abusive user hotspots a single shard",tag:"scaling",turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> one abusive api-key is sending <b>400K req/s</b> trying to brute-force an endpoint. That key hashes to <b>one</b> shard, now at 100% CPU while the other <b>11</b> shards idle. The limiter for every key on that shard is now slow. Fix the hot shard.</span>"},
      {who:"cand",text:"This is the <strong>hot-key / hot-shard</strong> problem — sharding by key balances <em>keys</em>, not load per key, so one scorching key pins its owner. Fixes: <strong>(1) shed at the edge first</strong> — once a key is flagged over-limit, reject it at the gateway <em>without</em> touching Redis, so the abuser's 400K/s never reaches the shard; a denied request shouldn't cost a store op. <strong>(2) local-node block cache</strong> — once the key is clearly over, each limiter caches 'blocked' for a short TTL and answers in-process. <strong>(3) key fan-out</strong> — split the hot counter into <code>key#1..#N</code> sub-counters across shards to spread the write load."},
      {who:"intv",text:"You need to detect the hot key fast enough to shed it. How?"},
      {who:"cand",text:"Track approximate per-key rates with a <strong>count-min sketch / heavy-hitters</strong> structure at the gateway tier — cheap, fixed memory, flags a key crossing a threshold within a second or two. On detection, push that key into a short-lived <strong>local denylist</strong> so the gateway returns 429 in-process before the request ever hits the limiter or store. The elegant part: a rate limiter already <em>is</em> a counter, so 'who is hammering us' falls out of the same machinery."},
      {who:"intv",text:"If you fan a hot counter into N sub-counters, how do you read the true total without re-creating the hotspot?"},
      {who:"cand",text:"On a decision I <strong>sum the N sub-counters</strong> — N small reads spread across shards instead of one scorching read/write on a single row, so write load divides by N and no single shard is pinned. It costs a few extra reads per decision, which is why I reserve fan-out for the rare genuinely-hot key rather than applying it to all 10M keys. And it composes with edge-shedding: once the key is flagged over-limit it's rejected at the gateway anyway, so most of the 400K/s dies at the front door and the sub-counters only carry the thin slice that slips through before detection. Detection + edge-shed turns a hot shard back into idle capacity."},
    ],resources:[
      {title:"Cloudflare: counting things, a lot of different things",url:"https://blog.cloudflare.com/counting-things-a-lot-of-different-things/"},
      {title:"Stripe: scaling your API with rate limiters",url:"https://stripe.com/blog/rate-limiters"},
    ]},
  ],
  q:{
    limiter:[
      {l:"easy",tag:"concept",q:"Walk me through one allow/deny decision end to end.",turns:[
        {who:"intv",text:"A request arrives for API key <code>k_free_42</code>. Take me through exactly what the limiter does to answer 'allow or deny?' — every step."},
        {who:"cand",text:"<ul><li><strong>Resolve the rule</strong> — key <code>k_free_42</code> is free tier → 1000 req/min.</li><li><strong>Identify the window / bucket</strong> for this key from the algorithm.</li><li><strong>Atomically read-and-increment</strong> the counter in the store.</li><li><strong>Compare</strong> the new count against the limit.</li><li><strong>Return</strong> allow (and remaining quota) or deny.</li></ul>The service is <strong>stateless</strong> — every durable count lives in the counter store — so any limiter instance can answer for any key. That's what lets me run it behind the whole gateway fleet."},
        {who:"intv",text:"You said 'atomically read-and-increment.' Why does atomic matter for a single decision?"},
        {who:"cand",text:"Because two requests for the same key can hit two limiter instances at the same instant.<span class='eg'>Count is 999. Two requests both read 999, both compute 1000 &le; 1000, both allow → 1001 through. The limit leaked by one.</span>If instead the increment is atomic and returns the post-increment value, one gets 1000 (allow) and the other 1001 (deny). The store must give me a single round-trip 'increment and tell me the new value' primitive, not read-then-write."},
      ],resources:[
        {title:"Stripe: scaling your API with rate limiters",url:"https://stripe.com/blog/rate-limiters"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"medium",tag:"concept",q:"Which counting algorithm do you pick? (adds algorithm engine)",reveal:["algo"],turns:[
        {who:"intv",text:"'1000 per minute' can mean several things. How exactly are you counting — and does the choice actually change behavior?"},
        {who:"cand",text:"It changes everything, so let me pull the counting logic into its own <strong>algorithm engine</strong> — it's the heart of correctness. There are five classic choices, and the naive one is dangerous.<span class='eg'>Fixed window: 1000 in 12:00:00-12:00:59. A caller sends 1000 at 12:00:59 and 1000 at 12:01:00 → 2000 requests in 2 seconds, both windows 'legal'. That boundary burst is 2x the intended rate.</span>I'd default to <strong>token bucket</strong> (smooth, allows controlled bursts) or a <strong>sliding-window counter</strong> (kills the boundary burst cheaply). We should drill into the five side by side."},
        {who:"intv",text:"Fair — we'll compare them in the engine. Quick: token bucket or leaky bucket for an API?"},
        {who:"cand",text:"<strong>Token bucket</strong> for an API. It lets a client spend accumulated tokens in a short burst (good for bursty-but-legitimate traffic) while capping the long-run average. Leaky bucket enforces a strictly smooth output rate — great for protecting a downstream that hates spikes, but it punishes normal bursty clients. Token bucket is the better default; I'd reach for leaky bucket only when the thing behind me needs a perfectly even feed."},
      ],resources:[
        {title:"Token bucket",url:"https://en.wikipedia.org/wiki/Token_bucket"},
        {title:"Stripe: scaling your API with rate limiters",url:"https://stripe.com/blog/rate-limiters"},
      ]},
      {l:"hard",tag:"scaling",q:"Central store on every request is too slow — local vs strict-central.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> at 1M req/s every limiter instance does a synchronous round-trip to the central Redis cluster on <b>every</b> request. Redis is now the bottleneck and your p99 decision latency is 8ms — above your 5ms budget. Do you keep hitting the central store, or move state local?</span>"},
        {who:"cand",text:"This is the core latency-vs-accuracy trade. <strong>Strict-central</strong> (increment the shared counter every request) is the most accurate — the global count is always exact — but it pays a network hop per request and pins throughput to the store. <strong>Local + async sync</strong> keeps a per-node counter in memory, decides locally in microseconds, and periodically reconciles with peers/the store. It's far faster but a node only knows its own recent traffic between syncs, so the global limit can be exceeded transiently. My move: keep strict-central for the hot path but cut its cost — batch/pipeline increments, and use a single atomic op per decision — and reserve local counting for the highest-volume tiers where a few percent of overshoot is acceptable."},
        {who:"intv",text:"Give me the concrete overshoot with local counting so we're honest about it."},
        {who:"cand",text:"With N nodes each allowing up to their local share before syncing, worst case each node admits its slice independently.<span class='eg'>Limit 1000/min, 50 nodes, sync every 1s: in the second before a sync, if traffic suddenly lands on all 50 nodes each could allow up to its local budget → brief overshoot well above 1000 until the next reconcile.</span>So local counting is a deliberate accuracy sacrifice for latency. I bound it by tightening sync interval, giving each node a <em>fraction</em> of the global budget (global/N) rather than the full limit, and falling back to central for tiers where accuracy is contractual. The right answer is per-tier, not one-size."},
      ],resources:[
        {title:"Stripe: scaling your API with rate limiters",url:"https://stripe.com/blog/rate-limiters"},
        {title:"Cloudflare: counting things, a lot of different things",url:"https://blog.cloudflare.com/counting-things-a-lot-of-different-things/"},
      ]},
      {l:"hard",tag:"failover",q:"The counter store is DOWN — fail open or fail closed?",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> the Redis counter store is fully unreachable — connection timeouts on every decision. The limiter literally cannot read or write a count. 1M req/s are arriving right now. Do you allow them or reject them?</span>"},
        {who:"cand",text:"This is the defining decision for a rate limiter, and there's no universal answer — it depends what the limiter <em>protects</em>. <strong>Fail open</strong> (allow when the store is down) keeps the product working but removes all protection — a good default when the limiter guards against <em>abuse</em> and the backend can survive a burst. <strong>Fail closed</strong> (reject) preserves protection but takes the whole API down over a limiter dependency — right only when unlimited traffic would cause real harm (cost blowout, a fragile downstream). Most public APIs <strong>fail open</strong>: a rate limiter should not be a single point of failure for availability. But I make it explicit and configurable, not accidental."},
        {who:"intv",text:"Fail open means during the outage an abuser gets unlimited requests. Mitigate that without failing fully closed."},
        {who:"cand",text:"Degrade instead of flip. <strong>(1)</strong> Fall back to a <strong>local in-memory limiter</strong> on each node — approximate, but it still caps per-node abuse (global/N budget), so an abuser hitting one node is still bounded. <strong>(2)</strong> Apply a conservative <strong>static cap</strong> during degraded mode (much lower than the paid limit) so the blast is contained. <strong>(3)</strong> Shed obviously-abusive keys via a cheap local denylist. <strong>(4)</strong> Alert and keep the store's failure loud. So the honest posture is 'fail open globally, but never to <em>unlimited</em> — fall back to a weaker local guard.' That keeps availability without handing an attacker a blank cheque."},
      ],resources:[
        {title:"Stripe: scaling your API with rate limiters",url:"https://stripe.com/blog/rate-limiters"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"medium",tag:"durability",q:"A limiter node crashes with un-synced local counts.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> you enabled local counting with async sync every 1s for the top tier. A limiter pod is SIGKILLed 900ms into its interval, holding ~90K increments it hadn't flushed to the store yet. What happens to those counts?</span>"},
        {who:"cand",text:"Those un-flushed increments are <strong>lost</strong> — that's the inherent cost of buffering state in a volatile node. The effect is <em>under-counting</em>: keys served by that node briefly look like they used less quota than they did, so a few callers get slightly more than their limit until the next window resets. Crucially it's a <em>bounded, self-healing</em> error — worst case one sync-interval of one node's traffic, and the counter store's authoritative value re-establishes on the next window. I never lose durable state, because the store — not the node — is the source of truth."},
        {who:"intv",text:"Bounded is fine for a soft limit, but a customer is billed on 'requests allowed.' Can you tighten it?"},
        {who:"cand",text:"For anything billing-grade I don't buffer in volatile memory at all — that tier runs <strong>strict-central</strong> so every allowed request is durably counted before it's admitted, accepting the latency. Middle ground: shorten the sync interval (smaller loss window), or write-ahead the local increments to the store <em>optimistically</em> and reconcile, so a crash loses milliseconds not a full second. The design rule: durability of the count scales with how much the count is worth. Abuse-prevention counters tolerate loss; monetized counters don't and pay for central atomicity."},
      ],resources:[
        {title:"Stripe: scaling your API with rate limiters",url:"https://stripe.com/blog/rate-limiters"},
        {title:"Redis: EVAL and Lua scripting",url:"https://redis.io/docs/latest/develop/interact/programmability/eval-intro/"},
      ]},
      {l:"medium",tag:"capacity",q:"How many limiter instances do you actually need?",turns:[
        {who:"intv",text:"Concrete numbers. ~1M req/s across the fleet, and decision overhead must stay p99 &lt; 5ms. How many <strong>limiter instances</strong> do you run? Show me the math, don't just say autoscale."},
        {who:"cand",text:"Size it from a per-instance budget. A limiter decision is thin — an in-memory rule lookup plus one atomic round-trip to the counter store — so a modern 4-core instance handles maybe <strong>~25K decisions/s</strong> at low latency (I'd confirm with a load test; this is the estimate).<span class='eg'>1M req/s &divide; 25K/s &asymp; 40 instances. Add ~30% headroom &rarr; ~52, spread across 3 AZs so losing one AZ drops ~1/3 of capacity, not the service.</span>The instance is stateless, so it scales linearly — the count is really set by the store round-trip time on the hot path, not by CPU."},
        {who:"intv",text:"40-ish is dominated by that store hop. What changes the number, and what does it cost you?"},
        {who:"cand",text:"Anything that removes the round-trip shrinks the fleet, so this is a latency-vs-accuracy trade. <strong>Local counting</strong> (decide in-process, reconcile deltas every interval) turns a decision into microseconds, so per-instance throughput jumps and I might need a third of the instances — but I pay in bounded overshoot between syncs. <strong>Pipelining/batching</strong> store ops cuts the effective per-decision cost while keeping central accuracy.<span class='eg'>Local counting at ~200K decisions/s/instance &rarr; 1M &divide; 200K &asymp; 5-8 instances, versus ~52 strict-central.</span>So I keep a warm floor sized for strict-central on the accuracy-critical tiers and lean on local counting only for high-volume tiers where a few percent overshoot is fine — the instance count is a function of how much accuracy each tier demands."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"Stripe: scaling your API with rate limiters",url:"https://stripe.com/blog/rate-limiters"},
      ]},
    ],
    store:[
      {l:"medium",tag:"concept",q:"How are counters stored — key shape, TTL, memory?",turns:[
        {who:"intv",text:"Give me the concrete data model in Redis for '1000 req/min per key.' What's the key, what's the value, and how does it expire?"},
        {who:"cand",text:"One counter per (api-key, window).<span class='eg'>Key <code>rl:k_free_42:1718000460</code> (the trailing number is the minute bucket), value is an integer count, with <code>INCR</code> to bump and <code>EXPIRE</code> to auto-clean.</span>On each request: <code>INCR</code> the current-minute key; if the returned value is 1 (fresh key) set <code>EXPIRE</code> to ~2 windows so stale buckets self-delete. Memory is tiny per key (~100 bytes), and TTL means I only ever hold the live and just-past windows — I never accumulate history. Sharding is by the api-key so all of one key's windows land on one node."},
        {who:"intv",text:"You said shard by api-key. What does that buy you, and what does it cost at 10M keys?"},
        {who:"cand",text:"It buys <strong>locality</strong>: a key's counter is always one node, so an increment is a single-node atomic op with no cross-shard coordination. Cost: load follows key popularity, not key <em>count</em> — 10M keys spread fine, but one very hot key can't be split across nodes, which is a hot-shard risk we should dig into. On memory: 10M live counters ≈ ~1GB, trivially shardable across a small cluster; the danger isn't the counter <em>count</em>, it's algorithms like sliding-window-log that store per-request entries instead of one integer."},
      ],resources:[
        {title:"Redis: EVAL and Lua scripting",url:"https://redis.io/docs/latest/develop/interact/programmability/eval-intro/"},
        {title:"Cloudflare: counting things, a lot of different things",url:"https://blog.cloudflare.com/counting-things-a-lot-of-different-things/"},
      ]},
      {l:"hard",tag:"scaling",q:"Keep the global count accurate across many nodes. (adds cluster sync)",reveal:["sync"],turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> you scale the counter store to a 12-node Redis cluster for throughput. A key's limit is global, but its increments are now arriving from 50 limiter instances into a sharded cluster. How do you keep the global count for one key correct across all that?</span>"},
        {who:"cand",text:"The clean answer is: <strong>one key's counter lives on exactly one shard</strong> (hash-slot by api-key), so every one of the 50 limiter instances routes that key's <code>INCR</code> to the <em>same</em> shard, and the count is authoritative and atomic there. Accuracy across many <em>caller</em> nodes is preserved precisely because the <em>counter</em> is not distributed — the fan-in converges on one owner. The moment I <em>do</em> want counts spread (hot key, or local-node buffering), I need a real reconciliation layer, so let me add a <strong>cluster sync</strong> component to coordinate partial counts back into a global truth."},
        {who:"intv",text:"So when is a single-owner counter not enough, and what does cluster sync actually do then?"},
        {who:"cand",text:"When the single owner becomes a hot shard, or when I run local per-node counters for latency. Then no single node has the true global count, so <strong>cluster sync</strong> reconciles: nodes periodically publish their local deltas and sum them into a global view — via a shared store, gossip, or a coordinator.<span class='eg'>50 nodes each hold a local count; every 500ms they push deltas, sync sums them → global count, and hands back each node a refreshed budget (global-remaining / N).</span>It trades exact-at-every-instant for eventually-accurate-with-bounded-overshoot, and its whole job is keeping that bound small."},
      ],resources:[
        {title:"Cloudflare: counting things, a lot of different things",url:"https://blog.cloudflare.com/counting-things-a-lot-of-different-things/"},
        {title:"Stripe: scaling your API with rate limiters",url:"https://stripe.com/blog/rate-limiters"},
      ]},
      {l:"hard",tag:"durability",q:"Two nodes race the same counter and both allow.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a key is at 999/1000. Two requests land on two limiter nodes within the same millisecond. Both do 'read count (999), it's under limit, allow, then write 1000.' Now 1001 requests were admitted. Walk me through preventing this exactly.</span>"},
        {who:"cand",text:"That's a classic <strong>read-modify-write race</strong>, and the fix is to never split read and write. Redis <code>INCR</code> is atomic and returns the post-increment value, so each request does one op: node A's <code>INCR</code> returns 1000 (allow), node B's returns 1001 (deny). No window where both see 999. The general rule: the decision must be a single atomic operation on the store, not a client-side compare."},
        {who:"intv",text:"But token bucket needs read-check-refill-decrement — that's multiple ops. <code>INCR</code> alone doesn't cover it. Now what?"},
        {who:"cand",text:"Right — anything beyond a bare counter needs multi-step atomicity, and the clean tool is a <strong>Lua script via <code>EVAL</code></strong>. Redis runs the whole script atomically on the owning shard, so 'compute refill, check tokens, decrement, return allow/deny' happens as one indivisible unit — no interleaving between the two racing nodes.<span class='eg'>The Lua reads last-refill-time and tokens, adds tokens for elapsed time, and if &ge;1 decrements and returns allow — all under one server-side lock.</span>The naive alternative, separate <code>GET</code>/<code>SET</code> with <code>EXPIRE</code>, also races on the EXPIRE (a lost <code>EXPIRE</code> leaves an immortal or prematurely-reset counter). Lua collapses the whole read-modify-write into one atomic step, which is the only fully correct answer for a distributed limiter."},
      ],resources:[
        {title:"Redis: EVAL and Lua scripting",url:"https://redis.io/docs/latest/develop/interact/programmability/eval-intro/"},
        {title:"Token bucket",url:"https://en.wikipedia.org/wiki/Token_bucket"},
      ]},
      {l:"hard",tag:"scaling",q:"One abusive user hotspots a single Redis shard.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> one abusive api-key is sending 400K req/s trying to brute-force an endpoint. That key hashes to <b>one</b> shard, which is now at 100% CPU while the other 11 shards idle. The limiter for every key on that shard is now slow. Fix the hot shard.</span>"},
        {who:"cand",text:"This is the <strong>hot-key / hot-shard</strong> problem — sharding by key balances <em>keys</em>, not load per key, so one scorching key pins its owner. Fixes: <strong>(1) shed at the edge first</strong> — once a key is flagged as over-limit, reject it at the gateway <em>without</em> touching Redis, so the abuser's 400K/s never reaches the shard. That alone fixes most of it: a denied request shouldn't cost a store op. <strong>(2) local-node counting for that key</strong> — once it's clearly over, each limiter caches 'this key is blocked' for a short TTL and answers locally. <strong>(3) key sharding/fan-out</strong> — split the hot counter into <code>key#1..#N</code> sub-counters across shards and sum, spreading the write load."},
        {who:"intv",text:"You need to detect the hot key fast enough to shed it. How?"},
        {who:"cand",text:"Track approximate per-key request rates with a <strong>count-min sketch / heavy-hitters</strong> at the gateway tier — cheap, fixed memory, flags a key crossing a rate threshold within a second or two. On detection, push that key into a short-lived local denylist so the gateway rejects it in-process (returning 429) before it ever hits the limiter or store. The elegant part: a rate limiter already <em>is</em> a counter, so 'who is hammering us' falls out of the same machinery. Detection + edge-shed turns a hot shard back into idle capacity because the abusive traffic dies at the front door."},
      ],resources:[
        {title:"Cloudflare: counting things, a lot of different things",url:"https://blog.cloudflare.com/counting-things-a-lot-of-different-things/"},
        {title:"Stripe: scaling your API with rate limiters",url:"https://stripe.com/blog/rate-limiters"},
      ]},
      {l:"hard",tag:"failover",q:"A shard node dies — counters gone, and now?",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a single Redis shard node crashes and its in-memory counters are gone. That shard owned ~1M active keys' counters. Are all those keys now un-limited? What do callers on that shard experience?</span>"},
        {who:"cand",text:"If the shard were a single node, its counters vanish and those keys reset to zero — every one of them effectively gets a fresh full quota, so limits leak for one window. Not catastrophic (counters are ephemeral by design and self-rebuild each window) but not acceptable as steady state. The fix is <strong>replication</strong>: each shard is a primary + replica(s); on primary death the replica is promoted and keeps the counters. Counters are short-lived, so even a small replication lag only risks a few very recent increments — a minor under-count, not a wipe."},
        {who:"intv",text:"During the failover window — a couple seconds of election — what does the limiter do for keys on that shard?"},
        {who:"cand",text:"It applies the same fail-direction policy scoped to that shard: for abuse-protection tiers it <strong>fails open with a local fallback cap</strong> so those keys stay bounded but the API stays up; for hard tiers it can briefly fail closed. Because counters are cheap and regenerate every window, I lean fail-open here — a two-second window where a slice of keys is loosely limited is far better than rejecting real traffic. Managed/replicated Redis does the promotion in seconds; I just need the limiter to not treat 'shard unavailable' as 'reject everything.' It reuses the exact fail-open-with-local-guard logic from the full-store-down case, just at shard granularity."},
      ],resources:[
        {title:"Redis: EVAL and Lua scripting",url:"https://redis.io/docs/latest/develop/interact/programmability/eval-intro/"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"medium",tag:"capacity",q:"How much memory and how many Redis nodes for the counters?",turns:[
        {who:"intv",text:"Size the counter store from the framing: ~10M active keys and ~1M ops/s. How much memory, and how many Redis nodes?"},
        {who:"cand",text:"Memory and throughput give different answers, so I compute both and take the max.<span class='eg'>Memory: 10M keys &times; ~100 bytes &asymp; 1GB. Token-bucket or sliding-window-counter is 1-2 keys per api-key, so still ~1-2GB; &times; replication factor 3 &asymp; 3-6GB — trivial for RAM.<br>Throughput: 1M ops/s &divide; ~100K ops/s per Redis shard &asymp; 10-12 shards.</span>So <strong>throughput</strong>, not memory, sets the node count — I'd provision ~12 shards, each a primary + replica for failover, which is ~24 nodes and leaves memory almost empty."},
        {who:"intv",text:"Memory is tiny but you want a dozen shards for ops. What could blow up the memory side, and what's the trade?"},
        {who:"cand",text:"The algorithm is what blows up memory: <strong>sliding-window-log</strong> stores a timestamp per request, so per key goes from ~16 bytes (two integers) to kilobytes.<span class='eg'>10M keys &times; 1000 timestamps &times; 8 bytes &asymp; 80GB+, versus ~160MB for the counter form — a ~500x swing.</span>And richer atomic ops (Lua <code>EVAL</code>) raise per-op CPU, cutting the 100K/s/shard figure. The trade is shard count vs per-key structure: more shards buys ops headroom but adds cross-shard cost for hot-key fan-out. So my decision is to provision on ops (~12 shards + replicas) and keep every per-key structure to O(1) integers, so memory never becomes the binding constraint and the store stays cheap."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"Cloudflare: counting things, a lot of different things",url:"https://blog.cloudflare.com/counting-things-a-lot-of-different-things/"},
      ]},
      {l:"medium",tag:"concept",q:"Which counter store — Redis, Memcached, or in-memory + gossip?",turns:[
        {who:"intv",text:"You keep defaulting to Redis. Treat this as a real store-selection decision, not a reflex. What does the counter store actually have to do, and what are the hard numbers it has to hit before we even name a product?"},
        {who:"cand",text:"Let me write the selection criteria from the framing first, then score candidates against them. The store sits on <strong>every</strong> request and does one counter op per decision, so its throughput floor is the <em>full request rate</em>.<span class='eg'>Throughput: ~1M req/s &rarr; ~1M counter ops/s the store must sustain, sharded.<br>Memory: one small counter per (key, window) &rarr; ~100 bytes/key &times; ~10M active keys &asymp; ~1GB live (token-bucket / sliding-window-counter is 1-2 integers per key, so still low single-digit GB with replication).</span>On top of that: <strong>atomic read-modify-write per key</strong> (or the limit leaks), <strong>native TTL</strong> so stale windows self-delete, <strong>failover</strong>, and a p99 that fits inside the 5ms decision budget. Those five — throughput, memory, atomicity, TTL, latency — are the scorecard."},
        {who:"intv",text:"Good. Now put the candidates against the throughput and node math. Redis, Memcached, in-memory + gossip — how many nodes does each need for 1M ops/s?"},
        {who:"cand",text:"<strong>Redis</strong>: a single node ceilings around <strong>~100K+ ops/s</strong> for these simple atomic ops.<span class='eg'>1M ops/s &divide; ~100K ops/s/node &asymp; 10-12 shards; each a primary + replica for failover &rarr; ~24 nodes, and memory (~1-2GB) is nearly empty on that many shards — throughput sets the count, not RAM.</span><strong>Memcached</strong> is multi-threaded and can push higher raw incr throughput per node (several hundred K/s), so <em>on paper</em> fewer nodes — maybe 4-6 — but that raw number is misleading once the algorithm needs more than a bare increment. <strong>In-memory + gossip</strong> (counters in each limiter's own RAM, deltas gossiped) has no network hop at all, so per-node throughput is effectively local memory speed — millions of ops/s/node — but it pays for that in accuracy, not node count."},
        {who:"intv",text:"Before atomicity — why is this an in-memory store at all? Why not a durable disk-backed DB so we don't lose counts?"},
        {who:"cand",text:"Because the latency budget forbids it and the durability isn't worth buying. A disk-backed DB (Postgres, DynamoDB) commits with an fsync / quorum write measured in <strong>single-to-tens of milliseconds</strong> — one such write blows the whole p99 &lt; 5ms budget on its own, and doing it <em>1M times a second</em> is absurd cost and lock contention. An in-memory store answers an <code>INCR</code> in <strong>tens of microseconds</strong>, ~100x under budget. And I don't <em>need</em> disk durability: counters are ephemeral by design — each carries a TTL of ~2 windows and self-deletes — so a lost counter just resets to zero and re-establishes next window. I get failover from <strong>replication</strong> (primary + replica), not from paying disk-write latency on the hot path. Durability of an ephemeral counter is a cost with no matching benefit."},
        {who:"intv",text:"Now atomicity, then give me the documented decision. All three can increment — why doesn't that settle it for the cheaper option, and what do you pick?"},
        {who:"cand",text:"A bare atomic increment isn't the whole job, and that's what breaks the tie. <strong>Redis</strong> <code>INCR</code> is atomic and returns the post-increment value, so two racing nodes get 1000 (allow) and 1001 (deny) with no read-modify-write window — and token bucket, which needs read-check-refill-decrement as <em>one</em> unit, runs as a <strong>Lua <code>EVAL</code></strong> atomically on the owning shard. <strong>Memcached</strong> has atomic incr but <em>no server-side scripting</em>, so token bucket collapses to a client-side <code>GET</code> + compute + <code>CAS</code> loop that races and retries.<span class='eg'>Memcached token bucket: 2 round-trips + a retry loop under contention; Redis EVAL: 1 atomic round-trip, no retry.</span><strong>In-memory + gossip</strong> is atomic locally but only eventually consistent globally, so the limit drifts between rounds. <strong>Decision: Redis as the source-of-truth counter store</strong> — the only candidate hitting all five criteria (atomic <code>INCR</code> + Lua, native <code>EXPIRE</code>, replica failover, microsecond latency, ~100K+ ops/s/node &rarr; ~12 shards for 1M ops/s). <strong>Not Memcached</strong>: no scripting forces token bucket into a racy CAS loop. <strong>Not a disk DB</strong>: millisecond commits break the 5ms budget for durability TTL'd counters don't need. In-memory + gossip I keep only as a local-counting layer on top for the highest-volume tiers that trade a few percent overshoot for latency."},
      ],resources:[
        {title:"Redis: EVAL and Lua scripting",url:"https://redis.io/docs/latest/develop/interact/programmability/eval-intro/"},
        {title:"Stripe: scaling your API with rate limiters",url:"https://stripe.com/blog/rate-limiters"},
      ]},
    ],
    gw:[
      {l:"medium",tag:"concept",q:"Where do you enforce — gateway, sidecar, or in-app library?",turns:[
        {who:"intv",text:"You put the limiter behind the gateway. But enforcement could live in the gateway/proxy, in a per-service sidecar, or as a library inside each app. Where do you put it and why?"},
        {who:"cand",text:"<strong>At the gateway/proxy</strong> as the default. It's the single choke point every request already passes, it can reject before any backend work is done, and it centralizes policy so limits are consistent regardless of which service is hit. A <strong>sidecar</strong> (mesh) is good when there's no central gateway or you want per-service local enforcement, but it multiplies the number of things holding counters. An <strong>in-app library</strong> is the worst for a <em>global</em> limit — it only sees one process's traffic, so 'global 1000/min' becomes '1000/min per instance', which is the boundary-burst bug at the deployment level.<span class='eg'>Library in 50 pods, limit 1000/min → effective ceiling ~50,000/min. The limit silently multiplied by the fleet size.</span>"},
        {who:"intv",text:"So the library is out for global limits. Is it ever the right choice?"},
        {who:"cand",text:"Yes — for <em>local</em> protection, like a per-instance concurrency cap or protecting a thread pool, where 'per process' is exactly what you mean. And as the fast local fallback we discussed for when the central store is down. But for contractual, per-customer quotas the enforcement point must see all traffic for that key, which means a shared decision (gateway calling the limiter service against a shared counter). The library and sidecar can front it as an L1 cache, but the source of truth stays central."},
      ],resources:[
        {title:"Stripe: scaling your API with rate limiters",url:"https://stripe.com/blog/rate-limiters"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"medium",tag:"concept",q:"What exactly do you return when over limit — headers?",turns:[
        {who:"intv",text:"A request is over limit. What's the exact HTTP response? Be specific about status and headers."},
        {who:"cand",text:"<strong>HTTP 429 Too Many Requests</strong>, with a <code>Retry-After</code> header telling the caller when they can try again (seconds, or an HTTP date). I also send the <code>X-RateLimit-*</code> family on <em>every</em> response, not just rejections: <code>X-RateLimit-Limit</code> (the cap), <code>X-RateLimit-Remaining</code> (quota left), and <code>X-RateLimit-Reset</code> (when the window resets).<span class='eg'>429 + <code>Retry-After: 30</code> + <code>X-RateLimit-Remaining: 0</code> → a well-behaved client backs off exactly 30s instead of hammering.</span>The headers turn rate limiting from a wall into a contract the client can cooperate with."},
        {who:"intv",text:"Why bother sending the limit headers on successful (200) responses too — isn't that overhead?"},
        {who:"cand",text:"It's a few bytes, and it lets good clients <em>self-throttle before</em> they hit the wall — a client watching <code>X-RateLimit-Remaining</code> drop can slow down proactively, which reduces the 429s I have to serve in the first place. It also makes the limit transparent and debuggable for API consumers. The one thing I'm careful about: on a 429 I must still send <code>Retry-After</code>, because without it clients retry immediately and turn a rate-limit into a retry storm — which is its own failure mode."},
      ],resources:[
        {title:"MDN: 429 Too Many Requests",url:"https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/429"},
        {title:"Stripe: scaling your API with rate limiters",url:"https://stripe.com/blog/rate-limiters"},
      ]},
      {l:"medium",tag:"concept",q:"How do per-tier limits get applied? (adds rules / config)",reveal:["config"],turns:[
        {who:"intv",text:"Free tier is 1000/min, pro is 100K/min, enterprise is custom. How does the gateway know which limit applies to key <code>k_pro_9</code>, and how do you change a limit without a redeploy?"},
        {who:"cand",text:"The limit shouldn't be hard-coded — it's data, so let me add a <strong>rules / config</strong> component that owns limits per tier (and per-key overrides). On each request the gateway resolves the key → tier → rule.<span class='eg'>Rule set: free = 1000/min, pro = 100K/min, ent:k_ent_3 = 5M/min. Key <code>k_pro_9</code> → pro → 100K/min, evaluated by the algorithm engine.</span>Config is loaded and cached in the limiter, and pushed on change, so a limit edit is a config update — no redeploy, near-instant."},
        {who:"intv",text:"Resolving key → tier on every request could itself be a lookup per call. Does that cost you?"},
        {who:"cand",text:"It would if I hit a config store per request, so I don't — the rule set is small (a handful of tiers plus a modest override list) and effectively static, so each limiter caches it in memory and refreshes on change notification. Key → tier mapping is either embedded in the API key itself (encoded prefix) or cached with a long TTL. So rule resolution is an in-memory hash lookup, microseconds, off the store entirely. The config component's job is distribution and correctness of the rules, not being on the per-request hot path."},
      ],resources:[
        {title:"Stripe: scaling your API with rate limiters",url:"https://stripe.com/blog/rate-limiters"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"hard",tag:"scaling",q:"The gateway tier itself must survive the full firehose.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a DDoS-like flood pushes arrivals from 1M/s to <b>8M/s</b>, most of it garbage that will be rate-limited anyway. The gateway fleet was sized for 1M/s. What falls over, and how do you keep legitimate traffic flowing?</span>"},
        {who:"cand",text:"First to feel it is the gateway fleet's CPU/connection capacity, then the limiter and store if every junk request triggers a decision. The key insight: a <em>rejected</em> request must be far cheaper than an allowed one. Defenses layered outward: <strong>(1)</strong> the gateway rejects known-over-limit keys in-process (from a short local cache) without calling the limiter or store — so 8M/s of a few abusive keys costs almost nothing. <strong>(2)</strong> the gateway fleet <strong>autoscales</strong> on connection/CPU and is horizontally stateless, so I add nodes. <strong>(3)</strong> upstream <strong>L3/L4 protection</strong> (SYN/volumetric) sheds the truly garbage before it reaches L7 at all. The limiter is part of the DDoS defense, not a victim of it."},
        {who:"intv",text:"Autoscaling takes a minute to spin up. What protects you in that first minute?"},
        {who:"cand",text:"A <strong>global concurrency / connection cap</strong> per gateway node so a node sheds load (returns 429/503 with <code>Retry-After</code>) rather than falling over — bounded degradation beats collapse. Plus the local over-limit cache means the flood's dominant keys are already being rejected cheaply within seconds of detection (that count-min heavy-hitter machinery again). So the first minute is: shed aggressively at each node up to its safe ceiling, reject abusers locally, and let autoscaling and L3/L4 catch up. Legitimate low-volume keys keep getting served because they were never the expensive part."},
      ],resources:[
        {title:"Cloudflare: counting things, a lot of different things",url:"https://blog.cloudflare.com/counting-things-a-lot-of-different-things/"},
        {title:"MDN: 429 Too Many Requests",url:"https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/429"},
      ]},
      {l:"hard",tag:"failover",q:"The gateway can't reach the limiter service.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> the limiter service is healthy but the network path from gateway to limiter is flapping — 40% of decision RPCs time out after your 5ms budget. The gateway is blocking on those calls and latency for <em>all</em> requests is climbing. What do you do?</span>"},
        {who:"cand",text:"I must never let the limiter's health dictate the API's health. First, a tight <strong>timeout + circuit breaker</strong> on the decision call: if the limiter is slow/unreachable, the breaker trips and the gateway stops waiting on it. On a tripped breaker the gateway falls back to its <strong>local approximate limiter</strong> (the L1 we discussed) and applies the configured fail direction — for most tiers fail open with a conservative local cap, so requests flow with bounded protection. The absolute rule: a decision call must be bounded and non-blocking; a hung dependency can't be allowed to add latency to every request."},
        {who:"intv",text:"With the breaker open, you're enforcing per-gateway-node local limits instead of global. How wrong is that?"},
        {who:"cand",text:"Wrong in the over-count direction and bounded by fleet size — the global limit effectively becomes local-cap x number-of-nodes during the outage, the same multiplication we saw with in-app libraries. I make it deliberately conservative: the local fallback cap is set well <em>below</em> global/N so even summed across nodes it stays near the real limit rather than blowing past it. It's a degraded, best-effort mode with a defined bound, and it's temporary — the breaker half-opens and probes, and once the limiter path recovers I snap back to exact global enforcement. Availability during the blip, exactness the rest of the time."},
      ],resources:[
        {title:"Stripe: scaling your API with rate limiters",url:"https://stripe.com/blog/rate-limiters"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"medium",tag:"capacity",q:"How many gateway nodes for the full firehose?",turns:[
        {who:"intv",text:"Numbers for the edge. ~1M req/s hits the gateway fleet. How many <strong>gateway nodes</strong>, and what actually dominates their capacity?"},
        {who:"cand",text:"Size from a per-node throughput budget. A gateway node terminates TLS, authenticates, and makes one limiter decision call — the TLS and connection handling dominate, not the limiter hop.<span class='eg'>1M req/s &divide; ~20K req/s per node &asymp; 50 nodes — which matches the 50 in the framing. Add ~30% headroom &rarr; ~65, spread across 3 AZs.</span>The fleet is horizontally stateless, so it scales by adding nodes; capacity is set by connection/TLS cost per node, and the limiter RPC is a small slice of that."},
        {who:"intv",text:"You said a rejected request must be cheaper than an allowed one. How does that change sizing when a flood pushes arrivals to 8M/s?"},
        {who:"cand",text:"That's the whole trick — I don't size for 8M/s of full-cost requests. Once a key is flagged over-limit the gateway rejects it <strong>in-process</strong> from a short local cache, without a limiter or store call, so junk traffic costs a fraction of a real decision.<span class='eg'>If 7M/s of the 8M is a few abusive keys rejected locally at ~5x cheaper, the effective load is ~1M full-cost + 7M cheap &asymp; the equivalent of ~2.4M/s, not 8M — so ~120 nodes at peak, not 400.</span>The trade is provisioning for the legit peak (cost) vs autoscaling lag (risk in the first minute). My decision: size the warm floor for the legitimate 3-5x peak, shed abusers in-process so the flood is cheap, and autoscale plus lean on L3/L4 upstream for the rest — the gateway is part of the DDoS defense, not a victim sized to absorb it head-on."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"Cloudflare: counting things, a lot of different things",url:"https://blog.cloudflare.com/counting-things-a-lot-of-different-things/"},
      ]},
    ],
    client:[
      {l:"easy",tag:"concept",q:"What should a well-behaved client do with a 429?",turns:[
        {who:"intv",text:"Your API returns <code>429</code> with <code>Retry-After: 30</code>. What should the calling client actually do — and what do bad clients do?"},
        {who:"cand",text:"A good client <strong>honors <code>Retry-After</code></strong>: it stops sending for 30 seconds, then resumes — ideally with <strong>exponential backoff plus jitter</strong> if it keeps getting 429s.<span class='eg'>Retry after 30s; if still limited, back off 60s, then 120s, each with random jitter so a fleet of clients doesn't retry in lockstep.</span>A well-behaved client also watches <code>X-RateLimit-Remaining</code> and paces itself <em>before</em> hitting zero. A bad client ignores the headers and immediately retries the same request — turning one 429 into a tight retry loop that makes the overload worse."},
        {who:"intv",text:"You can't control third-party clients. How do you protect yourself from the ones that retry-storm?"},
        {who:"cand",text:"I assume clients misbehave and defend server-side. A client that ignores <code>Retry-After</code> and keeps hammering is just more over-limit traffic — and I already reject that cheaply at the gateway from the local over-limit cache, without hitting the limiter or store. If a specific key retry-storms persistently, the heavy-hitter detector flags it and it gets shed at the edge, or temporarily hard-blocked with a longer <code>Retry-After</code>. So client cooperation is an optimization that reduces load; my correctness never depends on it."},
      ],resources:[
        {title:"MDN: 429 Too Many Requests",url:"https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/429"},
        {title:"Stripe: scaling your API with rate limiters",url:"https://stripe.com/blog/rate-limiters"},
      ]},
      {l:"medium",tag:"scaling",q:"Thousands of clients all retry at the same instant.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a shared limit resets at the top of each minute. 10,000 clients that were all limited get <code>Retry-After</code> pointing at the same reset time, so at 12:01:00 exactly they all fire simultaneously — an instant 10K-request spike every minute. Fix the synchronized stampede.</span>"},
        {who:"cand",text:"This is a <strong>thundering herd</strong> caused by everyone sharing the same reset boundary — the same reason fixed windows are dangerous. Fixes on my side: <strong>(1)</strong> add <strong>jitter to <code>Retry-After</code></strong> — instead of the exact reset, hand each client reset + a small random offset, spreading the 10K over several seconds. <strong>(2)</strong> move off hard window boundaries to a <strong>sliding window or token bucket</strong>, where quota refills continuously rather than all at once, so there's no single instant when everyone unlocks together."},
        {who:"intv",text:"Between jitter and switching algorithms, which actually solves it — or do you need both?"},
        {who:"cand",text:"Switching to <strong>continuous refill</strong> (token bucket / sliding window) is the real fix — it removes the shared cliff entirely, so there's no synchronized unlock to jitter away. Jitter is a cheap mitigation that helps even with fixed windows and costs nothing, so I'd ship it regardless. But if I only jitter and keep fixed windows, I've just smeared the spike over a few seconds, not eliminated it. So: continuous-refill algorithm as the structural fix, jittered <code>Retry-After</code> as defense-in-depth. Both, but the algorithm is doing the heavy lifting."},
      ],resources:[
        {title:"Token bucket",url:"https://en.wikipedia.org/wiki/Token_bucket"},
        {title:"Cloudflare: counting things, a lot of different things",url:"https://blog.cloudflare.com/counting-things-a-lot-of-different-things/"},
      ]},
      {l:"medium",tag:"failover",q:"Limiter fails open — what does the client see?",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> the counter store is down and you've chosen to fail open. A client that was <em>correctly</em> being throttled a moment ago now suddenly gets all its requests through. From the client's perspective, is anything wrong, and can they exploit it?</span>"},
        {who:"cand",text:"From the client's view it looks like their limit vanished — <code>X-RateLimit-Remaining</code> may stop decrementing or the 429s stop. A sophisticated abuser <em>could</em> notice and try to exploit the open window, which is exactly why 'fail open' must never mean 'fail to <em>unlimited</em>.' During degraded mode the client still hits the <strong>local fallback cap</strong> and the conservative static ceiling, so they get more than their paid quota but nowhere near infinite. The client experience is 'looser limits, briefly,' not 'no limits.'"},
        {who:"intv",text:"Should you signal degraded mode to the client at all, or hide it?"},
        {who:"cand",text:"I lean toward <em>not</em> advertising 'limiter degraded' explicitly — telling callers 'enforcement is weakened right now' is an invitation to abuse. I keep sending best-effort <code>X-RateLimit-*</code> headers from the local fallback so cooperative clients still self-pace, but I don't broadcast the outage. Internally it's loud — alerts, metrics — so operators know. So: transparent to <em>me</em>, quietly-degraded to the client. The one thing I won't do is send misleading headers claiming a hard limit I'm not actually enforcing; I'd rather send approximate-but-honest remaining counts."},
      ],resources:[
        {title:"MDN: 429 Too Many Requests",url:"https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/429"},
        {title:"Stripe: scaling your API with rate limiters",url:"https://stripe.com/blog/rate-limiters"},
      ]},
    ],
    algo:[
      {l:"hard",tag:"concept",q:"Compare the five algorithms with concrete examples.",turns:[
        {who:"intv",text:"You promised five algorithms. Lay them out — fixed window, sliding window log, sliding window counter, token bucket, leaky bucket — with what each gets right and wrong for '1000/min'."},
        {who:"cand",text:"<ul><li><strong>Fixed window</strong> — one counter per clock minute. Cheap (one <code>INCR</code>), but allows the boundary burst.<span class='eg'>1000 at 12:00:59 + 1000 at 12:01:00 = 2000 in 2s.</span></li><li><strong>Sliding window log</strong> — store a timestamp per request, count those in the last 60s. Exact, no burst — but stores every request.<span class='eg'>1000 req/min/key = 1000 entries per key in memory.</span></li><li><strong>Sliding window counter</strong> — weight the previous window's count by how far into the current window you are. Near-exact, one integer per window. Kills the burst cheaply.</li><li><strong>Token bucket</strong> — tokens refill at a steady rate up to a cap; each request spends one. Allows controlled bursts, caps the average.</li><li><strong>Leaky bucket</strong> — requests queue and drain at a fixed rate; enforces a perfectly smooth output.</li></ul>"},
        {who:"intv",text:"Give me the sliding-window-counter formula concretely — how does it approximate without storing every request?"},
        {who:"cand",text:"It blends the current and previous fixed-window counts by overlap.<span class='eg'>Limit 1000/min. Current window (12:01:00-) has 300 so far; previous window (12:00:00-) had 900. You are 25% into the current minute, so 75% of the previous window still overlaps the trailing 60s. Estimate = 300 + 900 x 0.75 = 975 &lt; 1000 → allow. One more heavy second and it crosses 1000 → deny.</span>Two integers per key, no per-request log, and it smooths the fixed-window boundary burst to within a few percent. That approximation is why Cloudflare uses it at scale — it's the sweet spot of accuracy per byte."},
      ],resources:[
        {title:"Cloudflare: counting things, a lot of different things",url:"https://blog.cloudflare.com/counting-things-a-lot-of-different-things/"},
        {title:"Stripe: scaling your API with rate limiters",url:"https://stripe.com/blog/rate-limiters"},
      ]},
      {l:"medium",tag:"concept",q:"Token bucket vs leaky bucket — when each?",turns:[
        {who:"intv",text:"Token bucket and leaky bucket both cap a rate. Concretely, when do you reach for one over the other?"},
        {who:"cand",text:"<strong>Token bucket</strong> when I want to allow <em>bursts up to a cap</em> while bounding the long-run average — the normal API case.<span class='eg'>Bucket size 100, refill 100/min: an idle client can spend 100 instantly, then is paced to 100/min. A bursty-but-legit client isn't punished.</span><strong>Leaky bucket</strong> when the thing behind me needs a <em>strictly smooth</em> feed regardless of arrival pattern.<span class='eg'>Drain 10/s: 100 requests arrive at once → they leave at exactly 10/s, the 101st while full is dropped.</span>Token bucket optimizes for caller flexibility; leaky bucket optimizes for downstream smoothness."},
        {who:"intv",text:"Leaky bucket queues requests. Isn't holding a queue of requests its own problem?"},
        {who:"cand",text:"Yes — that's its main cost. A real queue adds latency (requests wait to drain) and needs a bounded size or it becomes a memory/latency sink; when full it must drop, which is just a 429 with extra steps. In practice for an API I rarely want to <em>hold</em> requests — I'd rather reject fast than queue — so I implement leaky-bucket <em>semantics</em> (smooth admission) as a token computation rather than an actual request queue, or just use token bucket. Leaky bucket as a literal queue belongs where buffering is genuinely desirable, like feeding a rate-sensitive downstream, not on a synchronous request path."},
      ],resources:[
        {title:"Leaky bucket",url:"https://en.wikipedia.org/wiki/Leaky_bucket"},
        {title:"Token bucket",url:"https://en.wikipedia.org/wiki/Token_bucket"},
      ]},
      {l:"hard",tag:"scaling",q:"Sliding window log's memory blows up at scale.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> you shipped sliding-window-log for exactness. With 10M active keys at 1000 req/min each, you're storing ~1000 timestamps per key — ~10 billion entries live in Redis, and memory is exploding past your cluster capacity. Fix it without losing too much accuracy.</span>"},
        {who:"cand",text:"Sliding-window-log's exactness costs O(requests) memory, which doesn't scale — 10B entries is the proof. I switch to the <strong>sliding-window-counter</strong>: two integers per key (current + previous window count) instead of a per-request log.<span class='eg'>Per key: ~1000 timestamps (8KB+) → 2 integers (~16 bytes). 10M keys go from ~80GB+ to ~160MB.</span>That's a ~1000x reduction for a few-percent accuracy error at the window boundary — an easy trade for a limiter, where 'roughly 1000' is fine and 'exactly 1000' isn't worth 500x the memory."},
        {who:"intv",text:"A few percent error — could that ever let an abuser through, and does it matter?"},
        {who:"cand",text:"The approximation error is small and roughly symmetric — it can slightly over- or under-count near the boundary, so an abuser might squeak a few percent over 1000 in a bad window. For rate limiting that's harmless: the point is bounding the <em>order of magnitude</em> of load, not billing to the exact request. If a specific tier genuinely needs exactness (say a metered paid API), I keep sliding-window-log <em>only for those keys</em> — far fewer of them — and use the counter for the 10M free-tier keys where memory dominates. Per-tier algorithm selection, driven by config, so I pay for exactness only where it's worth it."},
      ],resources:[
        {title:"Cloudflare: counting things, a lot of different things",url:"https://blog.cloudflare.com/counting-things-a-lot-of-different-things/"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"medium",tag:"durability",q:"Token-bucket refill state is lost on restart.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> token bucket keeps per-key state: current tokens + last-refill timestamp. The counter store node holding a set of buckets restarts and those buckets come back empty (or reset to full). What's the correctness impact and how do you handle it?</span>"},
        {who:"cand",text:"Two directions depending on how the state comes back. If buckets reset to <strong>full</strong>, every affected key gets a free burst up to bucket size — a brief over-admission. If they come back <strong>empty</strong>, keys are wrongly throttled until they refill. Both are transient (the bucket re-converges within one refill period) and bounded by bucket size, so it's a small blip, not corruption. But I don't want random direction, so I make it deterministic: store <code>{tokens, last_refill_ts}</code> and <em>recompute</em> tokens from elapsed time on read — that way even a reset state self-corrects on the next access rather than depending on what was persisted."},
        {who:"intv",text:"You're storing a timestamp per key. Recompute-on-read is clever — but does it survive the node actually losing the timestamp too?"},
        {who:"cand",text:"If the timestamp itself is gone, I can't reconstruct exact tokens — but I default safely: treat a missing bucket as <strong>full with last_refill = now</strong>, which grants at most one bucket-size burst per key once, then normal pacing resumes. That's a deliberate fail-open-ish choice consistent with the rest of the design (a small burst beats wrongly locking users out). For durability I lean on the store's <strong>replication</strong> so a single node restart promotes a replica that still has the state — the same mechanism as the counter-store failover — and I keep the refill math atomic in a Lua script so a concurrent restart-recovery can't itself race. Buckets are cheap and self-healing, so I spend just enough durability to avoid a visible blip, not more."},
      ],resources:[
        {title:"Token bucket",url:"https://en.wikipedia.org/wiki/Token_bucket"},
        {title:"Redis: EVAL and Lua scripting",url:"https://redis.io/docs/latest/develop/interact/programmability/eval-intro/"},
      ]},
      {l:"medium",tag:"capacity",q:"Does the algorithm engine's compute cost anything at 1M/s?",turns:[
        {who:"intv",text:"The algorithm engine runs on every one of the ~1M decisions/s. Is its compute a real capacity concern, and does the algorithm choice change that?"},
        {who:"cand",text:"For the O(1) algorithms it's essentially free. Token bucket and sliding-window-counter are a handful of arithmetic ops per decision.<span class='eg'>Token bucket: compute elapsed &times; refill rate, compare, decrement — a few ops, sub-microsecond. &times; 1M/s &asymp; a small fraction of one core across the fleet.</span>The engine co-locates inside the limiter, so it adds no separate fleet, and it holds no durable state — the counters live in the store. So engine CPU is a non-issue by construction; the cost that matters is the store's ops and memory, not the arithmetic."},
        {who:"intv",text:"Is there any algorithm whose cost actually shows up at 1M/s?"},
        {who:"cand",text:"Yes — <strong>sliding-window-log</strong> breaks the pattern. It stores a timestamp per request and must trim expired entries on every call, so both CPU and store footprint scale with traffic instead of staying O(1).<span class='eg'>1000 req/min/key &rarr; ~1000 entries to scan/trim per decision, and ~10B live entries across 10M keys — versus 2 integers per key for the counter form.</span>The trade is exactness vs cost: the log is exact but pays O(requests); the counter is approximate-within-a-few-percent but O(1). My decision is to default to O(1) algorithms so the engine stays free and the store stays 1-2 keys per api-key, and reserve the log only for the low-volume tiers that genuinely need exactness — per-tier selection driven by config, so I pay the cost only where it's worth it."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"Token bucket",url:"https://en.wikipedia.org/wiki/Token_bucket"},
      ]},
    ],
    config:[
      {l:"medium",tag:"concept",q:"How is the rule set modeled and resolved?",turns:[
        {who:"intv",text:"Describe the actual shape of the rules — tiers, overrides, precedence. How does a request end up with one number?"},
        {who:"cand",text:"A small, layered rule set. Base <strong>tier</strong> rules, then optional <strong>per-key overrides</strong>, resolved by precedence.<span class='eg'>Rules: tier:free = 1000/min, tier:pro = 100K/min, override:k_ent_3 = 5M/min, override:k_bad_7 = 0 (hard block). Key resolves to most-specific match: override &gt; tier.</span>Each rule also names the <strong>algorithm</strong> and window it uses, so config drives not just the number but <em>how</em> it's counted. Resolution is: identify key → find most-specific rule → hand (limit, window, algorithm) to the engine. It's a tiny in-memory lookup."},
        {who:"intv",text:"Where does this config actually live, and who's allowed to change it?"},
        {who:"cand",text:"It lives in a <strong>versioned config store</strong> — a control-plane database or a versioned KV (etcd/Consul-style), with the full rule set as an auditable, versioned object. Changes go through a review/approval path (it's security-sensitive — a limit is a control), and each change produces a new immutable version with an author and timestamp. Limiter nodes don't read the store per request; they subscribe and cache the latest version in memory, refreshing on a change notification. So the store is the source of truth and audit log; the hot path only ever touches an in-memory copy."},
      ],resources:[
        {title:"Stripe: scaling your API with rate limiters",url:"https://stripe.com/blog/rate-limiters"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"hard",tag:"scaling",q:"Push a limit change to the whole fleet fast.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> an enterprise customer's limit must go from 5M/min to 20M/min <b>now</b> (they're being throttled in production). You have 50 gateway nodes and 30 limiter instances all caching the old rule. How does the new limit reach every node, and how fast?</span>"},
        {who:"cand",text:"I don't want per-request config reads, but I do want fast propagation, so config distribution is <strong>push-based</strong>: on a rule change the config service bumps the version and notifies all subscribers (pub/sub, a watch on etcd/Consul, or a streaming config channel). Each of the 80 nodes pulls the new version and swaps its in-memory rule set atomically — propagation in <strong>seconds</strong>, not a redeploy.<span class='eg'>Publish v43 → 80 nodes get the watch event → each fetches v43 and hot-swaps → within ~1-2s the whole fleet enforces 20M/min.</span>As a backstop, nodes also poll periodically so a missed notification still converges within the poll interval."},
        {who:"intv",text:"During those 1-2 seconds, some nodes are on the old limit and some on the new. Is that inconsistency a problem?"},
        {who:"cand",text:"For a limit <em>raise</em> it's benign — some nodes briefly enforce a stricter cap, so the customer is under-served for a second, no harm. For a <em>lower</em> it's the reverse (briefly too generous), also tolerable for a rate limit. The real rule: config propagation is <strong>eventually consistent</strong> and that's acceptable because a rate limit is inherently approximate at the second scale. What I <em>don't</em> tolerate is a node silently missing the update forever — so every rule carries a version, nodes report the version they're enforcing, and I can watch fleet-wide convergence and alert on any straggler. Observability makes the eventual-consistency safe."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"Stripe: scaling your API with rate limiters",url:"https://stripe.com/blog/rate-limiters"},
      ]},
      {l:"hard",tag:"failover",q:"A bad config push locks everyone out.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> someone pushes a rule with a typo — the default tier limit becomes <code>0</code> instead of <code>1000</code>. It propagates to all 80 nodes in 2 seconds. Now every default-tier request is a 429. The whole API is down for most customers. Walk me through prevention and recovery.</span>"},
        {who:"cand",text:"This is the scariest failure in the system — config is a global control, so a bad push is a global outage, and fast propagation makes it faster. Prevention, in layers: <strong>(1) validation</strong> at write time — reject nonsensical rules (a limit of 0 on a whole tier, a limit below a sane floor, huge drops) before they're ever versioned. <strong>(2) staged rollout</strong> — push a new version to a canary subset of nodes first, watch 429 rates, and only fan out if error rates stay flat. <strong>(3) two-person review</strong> for tier-wide changes. A limit change should roll out like a deploy, not a live edit."},
        {who:"intv",text:"Prevention failed and it's live. Recovery — how fast, and does the limiter defend itself?"},
        {who:"cand",text:"Recovery leans on the same versioning: config is <strong>immutable and versioned</strong>, so rollback is 'publish the previous good version' — one action, propagates in the same 1-2s as any push. That's the fast path. Defense-in-depth so it never gets this far: the limiter treats a rule that would <strong>reject an entire tier</strong> as suspicious and can apply a <strong>sanity guardrail</strong> — e.g. refuse to enforce a tier-wide limit of 0 without an explicit override flag, falling back to the last-known-good rule instead. Combined with canary + validation, a fat-fingered 0 gets caught before it fans out; and if it somehow lands, one-click version rollback bounds the outage to seconds. The principle: make the config plane as robust as the data plane, because a limiter's config <em>is</em> a live weapon."},
      ],resources:[
        {title:"Stripe: scaling your API with rate limiters",url:"https://stripe.com/blog/rate-limiters"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"medium",tag:"durability",q:"The config store is unavailable at node startup.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a limiter node is (re)starting and the config store is unreachable right then — it can't fetch the rule set at boot. Does the node come up with no limits, refuse to start, or something else?</span>"},
        {who:"cand",text:"None of 'no limits' or 'crash-loop.' A node must be able to start into a safe state without the config plane. So each node persists a <strong>last-known-good config snapshot</strong> locally (on disk / cache) and boots from that if the store is unreachable, then reconciles once the store returns. If it has <em>no</em> snapshot at all (a truly fresh node), it starts with a <strong>conservative built-in default</strong> rule set (safe floor limits) rather than either unlimited or fully-closed — the same fail-direction philosophy as the rest of the design. The config store being down should degrade freshness of rules, never availability of enforcement."},
        {who:"intv",text:"If it's serving stale rules from the snapshot, how do you avoid it silently running old limits for hours?"},
        {who:"cand",text:"The same convergence machinery: the node keeps retrying the config store in the background and reports the config <strong>version</strong> it's actually enforcing to a central monitor. A node stuck on an old version past a threshold raises an alert, so 'stale forever' is visible and paged, not silent. The staleness itself is low-risk (rules change rarely and a slightly old limit is tolerable), but I never rely on that — I make the enforced version observable fleet-wide. So durability of config = local snapshot for availability + version reporting for correctness, mirroring how the counter store is source-of-truth but the hot path caches."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"Stripe: scaling your API with rate limiters",url:"https://stripe.com/blog/rate-limiters"},
      ]},
      {l:"medium",tag:"capacity",q:"How big is the rule set, and does config need its own cluster?",turns:[
        {who:"intv",text:"Size the config plane. How big is the rule set, how much does each node hold, and does it need a big cluster of its own?"},
        {who:"cand",text:"It's tiny, which is the whole point of keeping it off the hot path.<span class='eg'>A handful of tier rules plus, say, 10K per-key overrides &times; ~100 bytes &asymp; ~1MB — it fits in memory on every one of the ~80 nodes many times over.</span>There's no per-request store hit — each node caches the full rule set in memory. The config store itself only sees rare writes plus ~80 node subscriptions, not request traffic, so its ops/s is trivial. It doesn't need a big cluster, just a small highly-available one."},
        {who:"intv",text:"If it's 1MB and cached everywhere, what actually sizes it, and where's the risk?"},
        {who:"cand",text:"It's sized by <strong>change propagation, not data volume</strong>: on each edit the store fans the new version out to ~80 nodes and they hot-swap. The trade is push vs poll — push (watch/pub-sub) propagates in ~1-2s but holds a connection per node; poll is simpler but converges slower.<span class='eg'>80 nodes &times; a watch event on each change &asymp; a burst of ~80 fetches per edit — nothing, since edits are rare.</span>So the real constraint isn't capacity at all, it's <em>correctness of a change</em> — a bad push is a global outage. My decision: a small 3-node consensus store (etcd-class), push for speed with a periodic poll as backstop, and treat capacity as a solved non-problem so the engineering goes into safe rollout instead."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"Stripe: scaling your API with rate limiters",url:"https://stripe.com/blog/rate-limiters"},
      ]},
      {l:"medium",tag:"concept",q:"Which store holds the rules — etcd, an RDBMS, or a versioned file?",turns:[
        {who:"intv",text:"Where do the rules actually live? Name the options and pick one."},
        {who:"cand",text:"The rule store needs three things: <strong>versioning/audit</strong> (a limit is a security control), <strong>fast fan-out</strong> to the fleet, and <strong>HA</strong>. Three candidates. <strong>etcd/Consul</strong>: a consensus KV with native watches (push), revision numbers as versions, and built-in HA — hits all three. <strong>An RDBMS</strong>: durable, queryable, easy to audit with a history table, but no native watch, so I'd bolt on polling or a notify channel. <strong>A versioned file in git / object storage</strong>: excellent review-and-audit trail (every change is a reviewed commit), but propagation needs an extra delivery mechanism and it's slow to push."},
        {who:"intv",text:"You need both an audit trail and sub-second push. Which wins?"},
        {who:"cand",text:"They pull in different directions, so I split the roles rather than force one store to do both. <strong>etcd-class KV</strong> is the runtime source of truth for distribution — its watch gives the sub-second push and its revision number is a natural version the nodes report back.<span class='eg'>Publish rev 43 &rarr; ~80 nodes get the watch event &rarr; hot-swap within ~1-2s; each node reports the rev it's enforcing so I can watch fleet convergence.</span>For the human audit/review path I mirror every change through a git PR or a versioned control-plane record — two-person review, immutable history — that then writes to etcd. So my decision is etcd for propagation + versioning on the hot path, git/control-plane for the review and audit trail; reads are all cached, so the store choice is about push and versioning, never read throughput."},
      ],resources:[
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"Stripe: scaling your API with rate limiters",url:"https://stripe.com/blog/rate-limiters"},
      ]},
    ],
    sync:[
      {l:"medium",tag:"concept",q:"How do nodes coordinate a global count — central vs gossip?",turns:[
        {who:"intv",text:"You added cluster sync so many nodes can share one global count. What's the actual coordination mechanism — and what are the options?"},
        {who:"cand",text:"Three shapes, on a spectrum from exact to loose. <strong>(1) Shared central store</strong> — every node increments one atomic counter (our Redis primary); no 'sync' needed, the store <em>is</em> the coordination, most accurate, costs a hop per request. <strong>(2) Local counters + periodic flush to a shared store</strong> — nodes keep local deltas and push them to a central aggregator every interval, which sums them into the global count and hands back budgets. <strong>(3) Gossip</strong> — nodes exchange deltas peer-to-peer, no central point, most scalable but loosest and slowest to converge. Most production limiters use (1) for accuracy or (2) for the latency/accuracy balance; gossip only at extreme scale."},
        {who:"intv",text:"For our 50-node fleet, which do you run, and how does budget get divided?"},
        {who:"cand",text:"Option (2): local counters with periodic flush to the shared store, because it hits the 5ms latency budget while keeping a real global view.<span class='eg'>Global limit 1000/min. Sync gives each of 50 nodes a slice of the remaining budget proportional to its recent traffic — a busy node gets a bigger share, an idle node a smaller one — refreshed every ~500ms as nodes report actual usage.</span>Proportional allocation matters: naive global/N (20 each) wastes budget on idle nodes and starves busy ones. Sync's job is to reallocate the remaining global budget toward where the traffic actually is, every interval."},
      ],resources:[
        {title:"Cloudflare: counting things, a lot of different things",url:"https://blog.cloudflare.com/counting-things-a-lot-of-different-things/"},
        {title:"Stripe: scaling your API with rate limiters",url:"https://stripe.com/blog/rate-limiters"},
      ]},
      {l:"hard",tag:"scaling",q:"A 500-request burst across 20 nodes must not allow 100 each.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a key's limit is 100/min. A client fires 500 requests in one second, and your load balancer spreads them evenly across 20 limiter nodes. If each node naively enforces '100' locally, all 500 get through — 5x the limit. How does sync stop that?</span>"},
        {who:"cand",text:"The bug is each node thinking it owns the <em>full</em> 100. It doesn't — 100 is the <em>global</em> budget, so no node may allow 100 on its own. Two correct answers: <strong>(a) strict-central</strong> — all 20 nodes <code>INCR</code> the one shared counter, so exactly 100 get allowed and requests 101-500 are denied regardless of which node they hit. That's the accurate default for a small limit like 100. <strong>(b) budget-splitting via sync</strong> — sync hands each node a <em>fraction</em> of the 100 (proportional to load), and nodes can only spend their slice, so the sum across 20 nodes can't exceed 100."},
        {who:"intv",text:"For a limit of only 100 across 20 nodes, budget-splitting gives each node ~5 — that rounds badly and wastes budget. Which do you actually pick?"},
        {who:"cand",text:"For a <em>small</em> limit like 100, <strong>strict-central</strong> — the shared atomic counter. Budget-splitting shines when the limit is large relative to node count (split 100K across 20 nodes → 5000 each, granular and low-coordination); it falls apart when the limit is small (5-each rounding, idle nodes hoarding budget, a burst on one node blocked while others sit unused). So the choice is limit-size-dependent: small/strict limits → central atomic counter (accuracy, cheap because low volume); large/high-volume limits → sync-based budget-splitting (latency, tolerable approximation). Sync's real value is the high-volume case; for a hard 100 I just pay the central hop, since 100/min isn't a throughput problem anyway."},
      ],resources:[
        {title:"Cloudflare: counting things, a lot of different things",url:"https://blog.cloudflare.com/counting-things-a-lot-of-different-things/"},
        {title:"Stripe: scaling your API with rate limiters",url:"https://stripe.com/blog/rate-limiters"},
      ]},
      {l:"hard",tag:"failover",q:"Sync lags or partitions — nodes drift apart.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> you're running budget-splitting with 500ms sync. The sync channel partitions — nodes can't exchange deltas for 10 seconds. Each node still holds its last-allocated budget. What goes wrong during those 10 seconds, and how do you bound it?</span>"},
        {who:"cand",text:"During the partition, nodes act on <strong>stale allocations</strong> — each keeps spending its last-known slice with no reconciliation, so they can't react to each other's usage. Effect: over-admission bounded by the sum of stale budgets, plus no rebalancing toward busy nodes. To bound it: <strong>(1)</strong> allocations <strong>expire</strong> — a node that hasn't heard from sync in, say, 2s shrinks its own budget (decays toward a conservative floor) rather than spending a stale full slice indefinitely. <strong>(2)</strong> fall back to <strong>strict-central</strong> for that key if the shared store is still reachable even though peer-sync isn't — the store is the tiebreaker. <strong>(3)</strong> cap the maximum any node can allow between syncs so a partition can't 5x the limit."},
        {who:"intv",text:"Budget-expiry means during a partition you under-serve (nodes shrink budgets). Is that the right direction?"},
        {who:"cand",text:"For a rate limiter, yes — on a coordination failure I'd rather <strong>err slightly strict</strong> (a few legit requests get 429 with <code>Retry-After</code>, and retry) than let the global limit blow out, because the whole point of the component is bounding load. It's the mirror of the store-down decision but inverted: when I <em>have</em> the store I can be exact; when only <em>coordination</em> is lost I decay toward conservative. The bound is explicit — worst case each node spends down to its floor, summing to near (not far above) the limit — and it self-heals the instant sync reconnects and re-allocates. Predictable, bounded, recovering: that's the property I want from any coordination failure."},
      ],resources:[
        {title:"Cloudflare: counting things, a lot of different things",url:"https://blog.cloudflare.com/counting-things-a-lot-of-different-things/"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"medium",tag:"durability",q:"The sync coordinator's aggregated state is lost.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> sync uses a central aggregator that holds the summed global counts and hands out budgets. That aggregator process restarts and comes back with empty aggregated state. What happens to in-flight budgets, and is any of this durable?</span>"},
        {who:"cand",text:"The aggregated view is <strong>soft, reconstructable state</strong> — not a durable source of truth — so losing it is recoverable by design. On restart the aggregator has no sums, but the nodes still hold their local counters and the authoritative per-key counts live in the <strong>counter store</strong>. Recovery: nodes re-report their local deltas on the next interval, and the aggregator rebuilds the global view within a sync cycle or two. The worst case during rebuild is one interval of slightly-stale allocations — the same bounded over/under-admission as a normal sync lag, not data loss, because no <em>unique</em> durable data lived only in the aggregator."},
        {who:"intv",text:"So you're saying sync doesn't need to be durable at all?"},
        {who:"cand",text:"Correct — it deliberately holds only <em>derived, ephemeral</em> state, which is what makes it cheap and safe to run. The durable source of truth is the counter store (replicated); sync just aggregates and redistributes budget on top of it, and anything it computes can be recomputed from node deltas + the store. So I run the aggregator <strong>redundantly for availability</strong> (a standby takes over so budget allocation isn't paused), but I intentionally <em>don't</em> give it its own persistence — persisting a fast-moving aggregate would add cost and staleness for no correctness gain. The design rule that keeps recurring: put durability in the store, keep the coordination layer stateless and reconstructable."},
      ],resources:[
        {title:"Cloudflare: counting things, a lot of different things",url:"https://blog.cloudflare.com/counting-things-a-lot-of-different-things/"},
        {title:"System Design Primer",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"medium",tag:"capacity",q:"How much load and state does the sync aggregator carry?",turns:[
        {who:"intv",text:"Size the sync layer. 50 limiter nodes report deltas every ~500ms for up to 10M keys. What load does the aggregator carry, and does it fit on one node?"},
        {who:"cand",text:"It fits comfortably, because it's bandwidth-bound, not message-bound.<span class='eg'>50 nodes &times; one batched report every 500ms = ~100 reports/s — a trivial message rate; each report batches many keys. Holding one budget per active key: 10M keys &times; ~50 bytes &asymp; ~500MB — one node's RAM.</span>So a single aggregator plus a standby handles it. And it holds only <em>derived</em> state — the authoritative counts live in the store — so it needs no persistence, just enough redundancy that budget allocation isn't paused on a restart."},
        {who:"intv",text:"10M keys of budget state on one aggregator — what if that working set or the report bandwidth outgrows one node?"},
        {who:"cand",text:"Two levers, and the trade is simplicity vs scale. First, most of the 10M keys are idle at any instant, so I only track budgets for <strong>active/high-volume</strong> keys — the real working set is far smaller than 10M. Second, I can <strong>shard the aggregator by key-hash</strong> so both the budget state and the report fan-in spread across N aggregators.<span class='eg'>Shard 4 ways &rarr; ~125MB and ~25 reports/s each — but a single hot key's budget still lands on one shard, so it inherits the same hot-key risk as the counter store.</span>My decision: run a single HA aggregator to start, since the state is small and fully reconstructable from node deltas plus the store, and shard by key only once the active-key budget set or report bandwidth actually outgrows one node — I don't pay sharding complexity for a 500MB problem."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"Cloudflare: counting things, a lot of different things",url:"https://blog.cloudflare.com/counting-things-a-lot-of-different-things/"},
      ]},
    ],
  },
  mockTest:[
    {q:"Name the five classic rate-limiting algorithms and give the one-line trade-off for each.",a:"<strong>Fixed window</strong>: one counter per clock interval, cheapest, but allows a 2x boundary burst across the window edge. <strong>Sliding window log</strong>: a timestamp per request, exact and no burst, but O(requests) memory. <strong>Sliding window counter</strong>: weights the previous window by overlap, near-exact for two integers per key — the sweet spot. <strong>Token bucket</strong>: tokens refill at a steady rate up to a cap, allows controlled bursts while bounding the average — the usual API default. <strong>Leaky bucket</strong>: requests drain at a fixed rate, enforces a perfectly smooth output but queues and adds latency."},
    {q:"At 1M req/s across ~50 nodes, why can't every node just keep its own local counter, and how do you keep a global limit global?",a:"A per-node counter only sees that node's traffic, so if the limit is 1000/min and traffic fans out to all 50 nodes, each can independently admit up to its own budget and the global count sails past 1000. Two fixes: <strong>strict-central</strong> — every node increments one shared atomic counter, exact but pays a network hop per request; or <strong>local + async sync</strong> — a cluster-sync layer sums each node's deltas every interval and hands each node a fraction of the remaining global budget (proportional to its recent traffic), so the slices sum to the global limit. Strict-central for small or contractual limits, budget-splitting for high-volume tiers that tolerate bounded overshoot."},
    {q:"A key is at 999/1000 and two requests hit two nodes in the same millisecond. How do you prevent admitting 1001?",a:"It's a read-modify-write race: both nodes read 999, both see it under the limit, both allow. The fix is to never split read and write — use a single atomic op. Redis <code>INCR</code> is atomic and returns the post-increment value, so one request gets 1000 (allow) and the other 1001 (deny) with no window where both see 999. For multi-step algorithms like token bucket (read-check-refill-decrement), wrap the whole thing in a <strong>Lua <code>EVAL</code></strong> so it runs as one indivisible server-side unit on the owning shard."},
    {q:"The counter store is fully unreachable at 1M req/s. Do you fail open or fail closed?",a:"It depends what the limiter protects, and it must be explicit and configurable, never accidental. <strong>Fail open</strong> (allow) keeps the product up but drops protection — the right default when the limiter guards against abuse and the backend can survive a burst; most public APIs choose this so the limiter is never a single point of failure for availability. <strong>Fail closed</strong> (reject) preserves protection but takes the API down over a limiter dependency — only when unlimited traffic causes real harm. The honest posture is fail open but <em>never to unlimited</em>: fall back to a local in-memory cap (global/N), apply a conservative static ceiling, shed known abusers locally, alert loudly, and use a circuit breaker to snap back to strict enforcement on recovery."},
    {q:"What exactly does a client get back when it's over the limit?",a:"<strong>HTTP 429 Too Many Requests</strong> with a <code>Retry-After</code> header (seconds or an HTTP date) so a well-behaved client backs off instead of retry-storming. Alongside it, the <code>X-RateLimit-*</code> family on <em>every</em> response, not just rejections: <code>X-RateLimit-Limit</code> (the cap), <code>X-RateLimit-Remaining</code> (quota left), and <code>X-RateLimit-Reset</code> (when the window resets). Sending them on 200s too lets good clients self-throttle before they hit the wall. The one non-negotiable: a 429 without <code>Retry-After</code> invites immediate retries and turns one rejection into a retry storm."},
    {q:"Which counter store do you pick, and size it for ~10M keys and ~1M ops/s.",a:"<strong>Redis</strong> — it is the only candidate that hits all five criteria: atomic <code>INCR</code> plus Lua <code>EVAL</code> for multi-step atomicity, native <code>EXPIRE</code> for self-cleaning windows, primary/replica failover, in-memory microsecond latency inside the 5ms budget, and ~100K+ ops/s per node. Sizing: throughput dominates — 1M ops/s &divide; ~100K ops/s/node &asymp; 10-12 shards, each primary + replica &asymp; ~24 nodes; memory is ~100 bytes &times; 10M keys &asymp; ~1GB (low single-digit GB with replication), nearly empty on that many shards. Not Memcached (no server-side scripting, so token bucket races on client-side CAS); not a disk DB (millisecond commits break the 5ms budget for durability that TTL'd counters don't need)."},
    {q:"Why does an in-memory store beat a durable disk-backed database for the counters?",a:"Latency and cost, with no downside for this data. A disk-backed DB commits with an fsync or quorum write in single-to-tens of milliseconds, which blows the p99 &lt; 5ms decision budget on a single write — and doing it 1M times a second is enormous cost and lock contention. An in-memory store answers in tens of microseconds, ~100x under budget. Durability isn't needed because counters are ephemeral: each carries a ~2-window TTL and self-deletes, so a lost counter just resets and re-establishes next window. Failover comes from replication, not from paying disk-write latency on every request."},
    {q:"One abusive api-key sends 400K req/s and hotspots a single shard. How do you fix the hot shard?",a:"Sharding by key balances keys, not load per key, so one scorching key pins its owner. First, <strong>detect</strong> it: a count-min sketch / heavy-hitters structure at the gateway flags a key crossing a rate threshold within a second or two. Then <strong>shed at the edge</strong> — once flagged over-limit, reject the key in-process at the gateway from a short-lived local denylist, without touching Redis, so the 400K/s dies at the front door and a denied request costs no store op. For the thin slice that slips through before detection, <strong>fan the counter out</strong> into key#1..#N sub-counters across shards and sum on read, spreading the write load. Reserve fan-out for genuinely hot keys, not all 10M."},
  ]
};

/* ---- scaling journey ---- */
(function(){
var d=window.DATA['ratelimiter'];
var scaling={id:"scaling",name:"From one Redis counter to fleet-scale",kind:"scale",
  live:["client","gw","limiter","store"],
  summary:"Start from the simplest correct limiter — one atomic Redis counter per key/window — then let latency, fairness, and operability force each extra box. Each stage names the number that breaks the previous design and the one component that earns its place.",
  steps:[
    {node:"store",stage:"Stage 0 · Baseline",title:"One central Redis counter — exact fixed-window limiting",
      live:["client","gw","limiter","store"],
      edges:[["limiter","store","INCR + EXPIRE"]],
      narrate:"Draw the honest MVP first: every request reaches the gateway, the gateway asks the limiter, and the limiter performs one atomic Redis `INCR` on `rl:key:window`. It is globally correct because all nodes route a key to one owner shard, and it is small because counters expire after roughly two windows.",
      details:[
        {k:"win",label:"Why start here",text:"It is **correct and legible**: one owner per key, one atomic operation, no background reconciliation, and no per-node drift. You can explain exactly why request 1000 is allowed and 1001 is denied."},
        {k:"query",label:"Baseline decision",code:"key = 'rl:api-key:{k_free_42}:1718000460'\ncount = INCR key\nif count == 1: EXPIRE key 120\nallowed = count <= 1000\nreturn allowed, 1000 - count"},
        {k:"scale",label:"Working numbers",text:"At ~**1M requests/s** across ~50 gateway nodes, Redis needs ~1M atomic ops/s. With ~10–12 shards at ~100K ops/s each and ~10M hot counters, throughput — not memory — sets the fleet size."},
      ],
      snap:{title:"Load & capacity — Stage 0",cap:"The first version is exact, but it is a blunt fixed window and every decision pays one network hop.",
        tables:[{name:"signals",cols:["signal","value","verdict"],rows:[
          {c:["Request rate","~1M /s","one Redis op each"],hi:1},
          {c:["Counter store","~10–12 shards · ~24 nodes","ok"],hi:1},
          {c:["Memory","~1–2GB live counters","not the limit"]},
          {c:["Decision p99","inside 5 ms while Redis is healthy","ok"]},
        ]}]}},
    {node:"algo",stage:"Stage 1 · Smooth algorithm",title:"Fixed windows leak 2× bursts &rarr; add the algorithm engine",
      live:["client","gw","limiter","store","algo"],
      edges:[["limiter","algo","evaluate"],["limiter","store","Lua atomic op"]],
      narrate:"The first failure is fairness, not fleet size. A fixed window lets a caller spend a full quota at the end of one minute and another full quota at the start of the next, so the backend sees twice the promised rate in seconds.",
      details:[
        {k:"scale",label:"The number that forces it",text:"For a free-tier `1000/min` rule, a fixed bucket admits **1000 at 12:00:59 plus 1000 at 12:01:00** — roughly 2× the intended load in a two-second burst."},
        {k:"pain",label:"What breaks without it",text:"The limiter is technically enforcing each clock bucket, but it is not protecting the downstream from bursts. A synchronized client fleet turns the reset boundary into a thundering herd."},
        {k:"fix",label:"The fix — O(1) smooth limiting",text:"Add an **algorithm engine** that defaults to token bucket or sliding-window-counter. Multi-step math still runs as one Redis Lua script, so refill, check, decrement, and TTL update stay atomic.",pill:"smooth"},
        {k:"gotcha",label:"Avoid the exact log trap",text:"Sliding-window-log is exact but stores one timestamp per request. At 10M active keys and ~1000 entries/key, that is ~10B live entries. The counter form keeps 1–2 integers per key and is accurate enough for load protection."},
      ],
      snap:{title:"Load & capacity — Stage 1",cap:"The decision becomes smooth while per-key state stays O(1).",
        tables:[{name:"signals",cols:["signal","before","after"],rows:[
          {c:["Boundary burst","up to **2×**","controlled burst only"],hi:1,tag:"fixed"},
          {c:["Per-key state","1 fixed counter","2 counters or token bucket"]},
          {c:["Bad exact option","~10B timestamps","avoided"],tag:"waste"},
          {c:["Atomicity","INCR only","Lua single op"],hi:1},
        ]}]}},
    {node:"config",stage:"Stage 2 · Runtime rules",title:"One hard-coded limit cannot serve tiers &rarr; add config",
      live:["client","gw","limiter","store","algo","config"],
      edges:[["limiter","config","cached rules"],["limiter","algo","rule selects algorithm"]],
      narrate:"Now the product grows: free, pro, enterprise, per-route limits, emergency blocks, and live raises for customers in production. A redeploy to change `1000/min` is too slow and too dangerous.",
      details:[
        {k:"scale",label:"The number that forces it",text:"The full rule set is tiny — about **1MB** for tiers plus ~10K overrides — but it must be cached by ~80 gateway and limiter nodes and propagate fleet-wide in ~1–2s."},
        {k:"pain",label:"What breaks without it",text:"Hard-coded limits mean every tier change is a deploy, nodes can disagree for minutes, and a bad default like `0/min` can lock out an entire tier before anyone sees it."},
        {k:"fix",label:"The fix — versioned config service",text:"Add **Rules / config** as a versioned control plane. Nodes subscribe, hot-swap immutable rule sets in memory, boot from last-known-good, and report the version they enforce so convergence is visible.",pill:"control plane"},
        {k:"key",label:"Rule shape",text:"A request resolves by precedence: per-key override &rarr; tier default &rarr; safe built-in default. The rule names limit, window, cost, and algorithm, so config chooses both the number and the counting method."},
      ],
      snap:{title:"Load & capacity — Stage 2",cap:"Config is not sized by QPS; it is sized by safe change propagation.",
        tables:[{name:"signals",cols:["signal","value","verdict"],rows:[
          {c:["Rule-set size","~1MB","cache everywhere"],hi:1},
          {c:["Caching nodes","~80","microsecond lookup"]},
          {c:["Propagation","~1–2s","fast enough"],hi:1,tag:"fixed"},
          {c:["Risk","bad push = global outage","canary + rollback"]},
        ]}]}},
    {node:"sync",stage:"Stage 3 · Local budgets",title:"Redis round-trips cap latency &rarr; add cluster sync",
      live:["client","gw","limiter","store","algo","config","sync"],
      edges:[["store","sync","authoritative totals"],["sync","limiter","budget leases"]],
      narrate:"At the highest-volume tiers, exact central counting spends one network round-trip on every request and pins hot keys to one Redis owner. Keep strict-central for small contractual limits, but let huge limits spend short-lived local budgets and reconcile asynchronously.",
      details:[
        {k:"scale",label:"The number that forces it",text:"Strict-central limiter instances handle roughly **25K decisions/s** each because the store round-trip dominates. Local budget checks move toward ~**200K decisions/s** per instance and keep the p99 safely below 5 ms."},
        {k:"pain",label:"What breaks without it",text:"One Redis hop per request makes the limiter a latency tax on the hot path, and one abusive or massive enterprise key can hotspot its shard before edge denial catches up."},
        {k:"fix",label:"The fix — leased local budgets",text:"Add **Cluster sync**. It reads authoritative counters, allocates short-lived per-node token slices proportional to recent traffic, and folds deltas back every ~500ms. On sync loss, leases expire and the node falls back to strict-central or a conservative floor.",pill:"latency trade"},
        {k:"gotcha",label:"Exactness vs availability",text:"This is deliberately approximate. Overshoot is bounded by lease size and sync interval; for billing-grade or tiny limits, config keeps the key on strict-central so the limit remains exact."},
      ],
      snap:{title:"Load & capacity — Stage 3 (full design)",cap:"The final design chooses strict or local per tier instead of pretending one accuracy mode fits all traffic.",
        tables:[{name:"signals",cols:["concern","strict-central","local + sync"],rows:[
          {c:["Per-instance throughput","~25K/s","~200K/s"],hi:1,tag:"fixed"},
          {c:["Sync report load","none","~50 nodes × 2/s = ~100 reports/s"]},
          {c:["Aggregator state","none","~500MB for 10M active budgets"]},
          {c:["Correctness","exact","bounded overshoot"],hi:1},
        ]}]}},
  ]};
d.deepFlows=[scaling].concat(d.deepFlows);
})();
