window.DATA = window.DATA || {};
window.DATA['scheduler'] = {
  cat:"scheduling · coordination · reliability",
  title:"Design a distributed job scheduler (cron-at-scale)",
  blurb:"Users submit one-time and recurring jobs; the system runs each reliably at the right time, with retries, at massive scale — never lose a job, never silently drop an execution.",
  prompt:"Let's design a distributed job scheduler, think Apache Airflow or cron-at-scale. Users submit one-time jobs (run at time T) and recurring cron jobs (every 5 minutes, every midnight), and the system must execute each one reliably at the right moment, retry on failure, and keep working when nodes die. The interesting parts here are the distributed bits: durability, coordination so two schedulers don't double-fire, at-least-once execution plus idempotency, and clean failure handling. The scheduling math is not the point. Start with the high-level architecture and rough numbers, then we'll drill into components and I'll throw failures at you.",
  opening:"Let me frame it before drawing boxes.<br><br><strong>Functional:</strong> submit a one-time job to run at time T; submit a recurring cron job; execute jobs reliably at their scheduled time with automatic retries; and let users monitor a job's status and run history. <strong>Non-functional:</strong> the hard invariants are <strong>durability</strong> (a submitted job is never lost, even if a node dies the instant after submit) and <strong>at-least-once execution</strong> paired with <strong>idempotency</strong> so a job runs even across failures but a duplicate run is harmless. Execution should be <strong>timely</strong> (fired within a second or two of its due time) and the whole thing must be <strong>fault tolerant</strong> — a scheduler or worker dying can't stall the system.<br><br><strong>Back-of-envelope:</strong> say <strong>100M</strong> jobs registered, executions averaging <strong>10K/s</strong> steady-state, but wildly spiky — cron favors round times, so <strong>1M</strong> jobs can all be due at midnight in the same second. Job defs are small (a few KB), so storage is modest (~hundreds of GB); the pressure is the read pattern of finding due jobs cheaply and the write pattern of state transitions, not raw bytes.<br><br>I'll start deliberately minimal: <strong>client → job API → job store → worker pool</strong>. The job store is the durable source of truth for every job's definition and state, and that skeleton already guarantees we don't lose a job. Under pressure I'll grow it — a scheduler that efficiently finds due jobs, a task queue to decouple dispatch from execution, a coordinator for leader election and locks, and a dead-letter path for exhausted retries. Pick a box and let's push.",
  nodes:[
    {id:"client",name:"Client",sub:"submit / query",x:40,y:150},
    {id:"api",name:"Job API",sub:"CRUD + schedule",x:210,y:150},
    {id:"jobdb",name:"Job store",sub:"defs + state",x:380,y:150},
    {id:"worker",name:"Worker pool",sub:"execute",x:550,y:150},
    {id:"scheduler",name:"Scheduler",sub:"finds due jobs",x:380,y:40},
    {id:"queue",name:"Task queue",sub:"due jobs",x:550,y:40},
    {id:"coordinator",name:"Coordinator",sub:"leader / locks",x:210,y:40},
    {id:"deadletter",name:"Dead-letter",sub:"failed / retries",x:550,y:260},
  ],
  edges:[["client","api","submit"],["api","jobdb","persist"],["jobdb","worker","claim"],["scheduler","jobdb","poll due"],["scheduler","queue","enqueue"],["queue","worker","dispatch"],["coordinator","scheduler","elect"],["worker","deadletter","on fail"]],
  core:["client","api","jobdb","worker"],
  basic:["client","api","jobdb","worker"],
  deepDive:{
    client:{
      role:"The submitter/monitor — it <code>POST</code>s job definitions and reads status. Thin, but it owns the lever that protects the durability promise on a flaky network: the <strong>client-generated idempotency key</strong> reused across retries, so a timed-out submit never creates a duplicate job.",
      capacity:[
        ["Status reads","~200K/s","~1M watched jobs polled every ~5s"],
        ["Read:write skew","~20x","status reads dwarf ~10K exec/s and a trickle of submits"],
        ["Submit burst","~50K in a burst","e.g. backfilling a year of reports"],
      ],
      data:"Stateless view of server truth — it stores only the returned <code>job_id</code> (or a batch id) and never assumes a job ran; the authoritative state is the job store, surfaced via the API. The one durable client contract is the idempotency key it attaches to each submit.",
      scaling:[
        "Use a <strong>batch submit</strong> endpoint so 50K jobs arrive as a handful of bulk requests, not 50K round trips.",
        "Respect <code>429</code> rate-limit responses — back off with jitter rather than hammering.",
        "Prefer <strong>completion webhooks</strong> for programmatic consumers and relaxed, rate-capped polling for human dashboards to collapse the 20x read amplification.",
      ],
      failures:[
        {t:"Submit times out with no response",b:"User doesn't know if the job was created and hits submit again — a duplicate cron could double-charge.",m:"Attach a client-generated idempotency key and reuse it on retry; the server returns the same <code>job_id</code>, enforced by a unique constraint so racing retries can't both insert."},
        {t:"An automated client floods 50K submits",b:"A spike far above steady-state melts the API.",m:"Async batch submit returns a batch id immediately after a durable intake write; the client polls the batch id — request stays fast and bounded regardless of size."},
      ],
      tradeoffs:[
        {a:"Poll for status",b:"Push via webhooks",pick:"Polling is simple but burns read capacity proportional to watcher count; webhooks cost a delivery mechanism but a job changes state only a few times — webhooks for programmatic, relaxed polling for dashboards."},
      ],
      probes:[
        "A submit times out and the user retries — how do you avoid creating the same job twice?",
        "Status traffic is ~20x the write path — what does that imply for how clients learn of completion?",
        "A client submits 50K jobs in a burst — how does the client side avoid melting the API?",
      ],
    },
    api:{
      role:"The synchronous, user-facing write path. It authenticates, <strong>validates</strong> (crucially, parses the cron expression and computes the first <code>next_run_at</code>), dedups on the idempotency key, rate-limits, and durably records intent. Its non-negotiable lever: <strong>never ack until the job is committed to durable, replicated storage</strong>.",
      capacity:[
        ["Per-instance throughput","~5K req/s","stateless: auth + validate + one store op"],
        ["Peak load","~102K req/s","~100K status reads + ~2K submits"],
        ["Fleet","~27 instances (raw)","low-tens once reads move to replicas + cache"],
      ],
      data:"Stateless — scales horizontally behind a load balancer. All durable state lives in the job store; the API's contract is simply that once it acks <code>201</code>, the job survives a node loss.",
      scaling:[
        "Split read/write paths: status reads served from <strong>read replicas + short-TTL cache</strong>, the write-primary reserved for submits and scheduler transitions.",
        "Stateless horizontal scale behind an LB; size the fleet for submits + cache-miss traffic, not dashboard polling.",
        "Validate the cron and reject garbage at submit — a malformed spec must not be discovered by the scheduler at 3am.",
      ],
      failures:[
        {t:"API acks <code>201</code> but the store write wasn't durable",b:"Jobs silently evaporate while users think they're scheduled — a durability violation.",m:"Wait for a <strong>quorum-acknowledged write</strong> (majority of replicas on durable media) before acking; a few ms of latency buys the whole durability promise."},
        {t:"Store briefly unavailable, can't confirm the durable write",b:"Risk of acking a job that doesn't exist.",m:"Fail closed — return <code>503</code>, don't ack, let the client retry safely with its idempotency key; never trade durability for availability on the write path."},
      ],
      tradeoffs:[
        {a:"Serve status from the primary",b:"Serve from replicas + cache",pick:"Status tolerates a second of staleness, so replicas + cache absorb the 100x read load and keep the primary for submits and the scheduler's due-scan/transitions — reads never starve writes."},
        {a:"Sync validate + persist",b:"Async intake for huge batches",pick:"Small submits persist synchronously; very large batches write to a durable intake and return a batch id, keeping request latency bounded while preserving durability."},
      ],
      probes:[
        "Beyond writing rows, what does the API own — especially for a cron submission?",
        "Under load the API acked 5K submits but some writes never flushed before a crash — close the durability hole.",
        "How many API instances at peak, and what cuts the number down?",
      ],
    },
    jobdb:{
      role:"The durable source of truth for every job's definition and state — the box that guarantees a submitted job is never lost. Its correctness-gating lever: the <strong>atomic single-row conditional claim</strong> (flip <code>pending &rarr; queued</code> only if still <code>pending</code>), which is what stops two schedulers double-firing.",
      capacity:[
        ["Write rate","~40-50K writes/s","10K exec/s &times; 3-4 transitions + a run insert; higher at midnight"],
        ["Due-scan","every ~1s","range read on <code>next_run_at &le; now</code>, not a 100M-row scan"],
        ["Storage","~few hundred GB hot","100M jobs &times; a few KB; run history tiered separately"],
        ["Shards","~3-4 replica groups","shard by <code>job_id</code>, aligned to scheduler partitions"],
      ],
      data:"Strongly-consistent relational/NewSQL. Hot <code>jobs</code> table (current state + <code>next_run_at</code>, the part the scheduler scans) with a <strong>range index on <code>next_run_at</code></strong>; append-only <code>job_runs</code> for immutable history kept out of the hot index. Every shard is a replica group with <strong>quorum-acknowledged writes</strong>.",
      scaling:[
        "<strong>Index on <code>next_run_at</code></strong> (partial/time-bucketed over live jobs) turns the due-scan into a bounded range read; a Redis sorted set fronts the tight polling loop.",
        "Shard by <code>job_id</code> aligned with the scheduler's partitions so scanning is embarrassingly parallel.",
        "Tier cold run history to object storage; keep only live jobs in the hot cluster.",
      ],
      failures:[
        {t:"A shard node's disk fails",b:"Millions of jobs (incl. a billing run) could silently stop firing forever.",m:"Every shard is a ≥3-replica group across AZs with synchronous quorum writes — a single loss loses nothing and a fresh replica rebuilds from survivors."},
        {t:"Write-primary crashes mid-claim, old primary rejoins",b:"Split-brain: two primaries each claim job 42 — a double-fire.",m:"Consensus-based promotion grants a monotonic <strong>epoch</strong>; the stale primary's writes are fenced and it demotes + re-syncs. Pause-elect-fence-resume: late-but-correct over fast-but-double-fired."},
        {t:"Naive <code>SELECT WHERE next_run_at &le; now</code> at 100M rows",b:"A full scan every tick pins the DB and starves transition writes.",m:"Range index on <code>next_run_at</code> (touch ~10K rows/tick) plus a Redis sorted set for the hot tier so the DB isn't scanned every second."},
      ],
      tradeoffs:[
        {a:"Relational / NewSQL",b:"Cassandra / DynamoDB",pick:"Relational does the atomic conditional claim and the <code>next_run_at</code> range scan natively; Cassandra's LWT claim is ~4 round trips, and a DynamoDB <code>next_run_at</code> GSI creates a midnight hot partition. Correctness + due-scan beat raw write-scale."},
        {a:"Consistency (pause writes) on partition",b:"Availability",pick:"Choose consistency — a few seconds of paused claiming means jobs fire slightly late (recovered by the overdue scan), whereas double-firing a billing job is unacceptable."},
      ],
      probes:[
        "Model the schema and the state machine — why is run history a separate table?",
        "100M jobs and a hot due-scan — how do you make finding due jobs cheap, and how do you shard?",
        "The primary fails mid-scan and the old one rejoins thinking it's primary — what breaks and how do you prevent it?",
      ],
    },
    worker:{
      role:"The stateless executor. It leases a task under a <strong>visibility timeout</strong>, transitions the job to <code>running</code>, executes the handler with the <strong>execution id</strong>, then acks on success or reschedules on failure. Its defining lever: <strong>lease-then-ack (at-least-once) over delete-on-dequeue (at-most-once)</strong>, so a crash re-runs rather than loses a job.",
      capacity:[
        ["Concurrency (Little's law)","~20K in-flight","10K/s &times; ~2s avg duration"],
        ["Workers","~400 floor, ~600 provisioned","~50 concurrent IO-bound tasks each, ~1.5x for peaks"],
        ["Lease","~60s visibility timeout","heartbeat-extended while healthy"],
      ],
      data:"Stateless queue consumer — no durable state of its own; the job store and queue hold the truth. Per-run it holds a lease and passes the <strong>execution id</strong> (<code>jobId + scheduledFireTime</code>) to side-effecting downstreams for idempotency.",
      scaling:[
        "<strong>Autoscale on queue depth / consumer lag</strong> with the Little's-law number as a warm floor.",
        "Separate pools by <strong>duration class</strong> so multi-minute jobs don't head-of-line-block 10ms tasks.",
        "Partition queues by priority/tenant with per-tenant concurrency limits so one flood can't monopolize the pool.",
      ],
      failures:[
        {t:"Worker OOM-killed 90s into a job, never acked",b:"Execution incomplete; risk of loss or a double-run on re-delivery.",m:"Visibility-timeout lease lapses and the queue re-delivers; idempotency on the execution id (plus per-step checkpoints) makes the re-run apply each effect at most once."},
        {t:"A legit 5-min job outlives its 60s timeout",b:"Premature re-delivery — two workers run it concurrently.",m:"Heartbeat to extend the lease while healthy; a crashed worker stops renewing and the lease lapses promptly — long jobs hold their lease only as long as they're alive."},
        {t:"A wedged worker heartbeats but makes no progress",b:"Holds a slot / lease forever.",m:"Independent hard <strong>execution timeout</strong>: exceed max runtime and the job is killed and failed for retry, regardless of heartbeats."},
      ],
      tradeoffs:[
        {a:"Lease-then-ack (at-least-once)",b:"Delete-on-dequeue (at-most-once)",pick:"Lease-then-ack re-runs on crash (harmless with idempotency); delete-on-dequeue loses the execution — losing a scheduled job is the one thing this system must never do."},
        {a:"Fixed worker pool",b:"Autoscale on depth",pick:"A fixed pool either idles or falls behind given wildly varying durations; autoscale tracks load (with a warm floor) at the cost of some lag on a sudden spike."},
      ],
      probes:[
        "Walk me through lease, run, ack — and why not just delete the task on dequeue?",
        "A worker dies 90s into a job — lost, and how do you avoid the first 90s' side effects happening twice?",
        "Visibility timeout is 60s but the job takes 5 minutes — fix the premature re-delivery without a giant timeout.",
      ],
    },
    scheduler:{
      role:"The asynchronous engine that finds due jobs and hands them off. It scans its owned partition for <code>next_run_at &le; now</code>, atomically claims each, and enqueues it. Its highest-leverage move: keep due-discovery <strong>bounded and parallel</strong> — a range index / sorted set per partition, never a full scan.",
      capacity:[
        ["Poll tick","~1s","work per tick proportional to what's due, not the catalog"],
        ["Steady due rate","~10K/s","one instance sustains ~10K claims/s"],
        ["Midnight burst","~50K/s","1M jobs smeared by jitter over ~20s"],
        ["Partitions","~6","50K/s &divide; ~10K/s + headroom to finish within the tick"],
      ],
      data:"Owns a disjoint <strong>partition</strong> of the job space (by hash of <code>job_id</code>), assigned by the coordinator with a fencing epoch. Hot tier is a per-partition <strong>Redis sorted set scored by fire time</strong>; the durable store holds authoritative state and is written only on transitions.",
      scaling:[
        "Partition by <code>job_id</code> so scanning is parallel and aligned with the store's shards; add a scheduler, coordinator rebalances.",
        "Front the tight loop with a sorted set — <code>ZRANGEBYSCORE</code> pops due jobs in O(log n); future jobs aren't in the hot set.",
        "Flatten temporal spikes with <strong>jitter</strong> on popular cron times and absorb the remainder in the queue.",
      ],
      failures:[
        {t:"Scheduler crashes ~10 min before standby takes over",b:"Thousands of jobs became due during the gap.",m:"Due-ness lives in the durable store — the new owner's <strong>overdue scan</strong> enqueues any <code>next_run_at &lt; now</code> still <code>pending</code>; degrades timeliness, not durability."},
        {t:"Clock skew across hosts",b:"A fast clock fires early, or two skewed hosts both think a job is due.",m:"The atomic conditional claim makes worst-case skew a small timing error, never a double-fire; NTP-discipline hosts and treat the store's committed state/clock as the arbiter."},
        {t:"Single scanner can't keep up at 100M jobs",b:"A tick takes longer than 1s and jobs fire late.",m:"Partition ownership so all schedulers scan in parallel; size N so the worst-case (midnight) tick finishes within its interval."},
      ],
      tradeoffs:[
        {a:"Partition by <code>job_id</code>",b:"Partition by fire time",pick:"Id-partitioning spreads scan work evenly and aligns with shards; time-partitioning concentrates the whole midnight tick into one partition — a self-inflicted hotspot. Flatten time separately with jitter."},
        {a:"Single leader scanner",b:"Partitioned ownership",pick:"A single leader is a scaling ceiling at 100M jobs; partitioned ownership scales linearly, and disjoint partitions mean two schedulers never scan the same job."},
      ],
      probes:[
        "With millions of jobs, how do you find the due ones without scanning everything every tick?",
        "A scheduler is down 10 minutes and a cron should have fired 5 times — run it 5 times or once?",
        "Clocks disagree by a few seconds across the fleet — how do you keep timing correct without double-fires?",
      ],
    },
    queue:{
      role:"The task buffer that <strong>decouples dispatch from execution</strong> and gives durability across the handoff. The scheduler enqueues and moves on; workers consume at their own rate. Its lever: <strong>at-least-once delivery with a visibility timeout</strong>, making it the shock absorber for bursts and the backpressure boundary.",
      capacity:[
        ["Steady throughput","~10K msgs/s in and out","dispatch path"],
        ["Midnight burst","~50K/s","jittered from the 1M herd"],
        ["Partitions","~12-16","peak drain &divide; ~5K/s per partition + headroom"],
        ["Delivery","at-least-once","visibility timeout + per-message ack"],
      ],
      data:"Durable, replicated messages — a task is persisted and quorum-acked before the enqueue is done, so a broker loss keeps the backlog. A dequeued message is leased (invisible) until the worker acks; no ack means re-delivery. The durable job store remains the ultimate source of truth for due-ness.",
      scaling:[
        "Autoscale workers on queue depth to drain a burst; a deep queue is the system working as designed.",
        "Partition the queue for throughput and into <strong>priority classes</strong> so a low-priority flood can't starve time-critical jobs.",
        "Apply <strong>backpressure upstream</strong> past a depth threshold — the scheduler defers low-priority enqueues (jobs stay <code>pending</code> in the store).",
      ],
      failures:[
        {t:"A broker holding 200K enqueued tasks fails",b:"In-memory-only messages would silently vanish — 200K lost executions.",m:"Persist + replicate each message with quorum ack; and because the durable job store is the real source of truth, vanished tasks resurface in the overdue scan — late, not lost."},
        {t:"Arrival outpaces drain, depth grows unbounded",b:"Memory/storage exhaustion.",m:"Backpressure — the scheduler slows low-priority enqueues into the durable store; priority partitions keep urgent jobs flowing; the working set stays bounded."},
      ],
      tradeoffs:[
        {a:"Message queue (SQS/RabbitMQ-style)",b:"Kafka-style log",pick:"Task dispatch needs independent per-task lease/ack/redelivery and easy dead-lettering — message-queue semantics fit; a log's per-partition offset model makes per-message redelivery awkward. Use a log for the ordered monitoring stream."},
      ],
      probes:[
        "Why a queue between scheduler and workers, and what delivery semantics do you configure?",
        "A midnight herd enqueues 1M tasks but workers drain 10K/s — keep the queue healthy without losing tasks.",
        "A broker with 200K in-flight tasks fails — how do you make the queue itself durable?",
      ],
    },
    coordinator:{
      role:"The arbiter of <strong>who is allowed to act</strong>. Using ZooKeeper/etcd it manages membership (which schedulers are alive) and partition assignment (who owns which slice), giving no-SPOF failover and disjoint ownership. Its safety lever: issuing a monotonic <strong>fencing epoch</strong> per assignment so a stale owner's writes are rejected.",
      capacity:[
        ["Hot-path load","~none","off the per-job path; membership + assignment only"],
        ["Op rate","hundreds/s at most","e.g. 40 schedulers renewing a lease every ~5s"],
        ["Ensemble","3 nodes (default)","tolerates 1 failure; 5 for double-fault tolerance"],
      ],
      data:"Small, linearizable metadata — the assignment map and membership (ephemeral nodes / leases). It exposes a monotonic revision (etcd <code>mod_revision</code> / ZK <code>zxid</code>) used directly as the fencing epoch. It is <em>not</em> on the per-job path.",
      scaling:[
        "<strong>Consistent hashing</strong> for partition-to-scheduler assignment so churn moves only a small fraction of partitions.",
        "Keep it off the hot path — consulted on membership changes, not per job.",
        "Delegate consensus to a proven system rather than hand-rolling agreement in app code.",
      ],
      failures:[
        {t:"Network partition isolates a scheduler; coordinator reassigns its partitions",b:"Split-brain — the isolated old owner still thinks it owns them and both scan/enqueue.",m:"Fencing tokens: the new owner gets a higher epoch and the store/queue reject the stale token's writes; the atomic per-job claim + idempotent execution are the second and third layers."},
        {t:"Rapid scheduler churn (4&rarr;40, crashes, adds)",b:"Constant reassignment could overload the coordinator or leave a partition uncovered.",m:"Consistent hashing makes rebalances incremental and the assignment map tiny; a briefly-unowned partition is tolerated (overdue scan recovers), a briefly-double-owned one is fenced."},
      ],
      tradeoffs:[
        {a:"Delegate to ZooKeeper/etcd",b:"Peer-to-peer consensus in app code",pick:"Reinventing distributed agreement is a classic split-brain source; a battle-tested consensus system gives linearizable membership + assignment with fencing built in, keeping schedulers simple."},
        {a:"3-node ensemble",b:"5-node ensemble",pick:"3 tolerates 1 failure with a fast 2-node quorum — the default since the coordinator is rarely written and off the hot path; move to 5 only if losing it is judged catastrophic."},
      ],
      probes:[
        "What does the coordinator manage, and why not have schedulers coordinate peer-to-peer?",
        "A partition isolates a scheduler and its partitions get reassigned — prevent the double-execution.",
        "Where does the fencing token come from, ZooKeeper vs etcd?",
      ],
    },
    deadletter:{
      role:"The safety net and operational surface for jobs that <strong>exhaust their retry budget</strong>. It captures the poison job, payload, execution id, attempts, and last error for triage and replay, keeping permanently-failing work out of the hot retry path. Its lever: turning failures into a <strong>monitorable, replayable</strong> queue rather than silent loss or infinite retries.",
      capacity:[
        ["Steady inflow","~10/s","~0.1% of 10K exec/s finally fail → ~860K/day"],
        ["Volume","~a few GB/day","def + payload + last error, a few KB each"],
        ["Retention","~30 days","covers realistic triage-and-fix-and-replay cycles"],
      ],
      data:"A durable, queryable <code>dead_letter</code> table (indexed by <code>failed_at</code> / <code>last_error</code>) with a <strong>replay-state</strong> column so replay is resumable. Replicated + quorum-acked so an entry never disappears whether or not it's been replayed.",
      scaling:[
        "Append-friendly and partitioned by <code>failed_at</code> so bad-deploy bursts spread and old entries age out.",
        "<strong>Alert on depth</strong> — a sharp spike signals a systemic downstream failure, not 50K independent bad jobs.",
        "Replay as a <strong>rate-limited re-enqueue</strong> through the normal dispatch path so a fixed downstream isn't re-overwhelmed.",
      ],
      failures:[
        {t:"A bad deploy dead-letters 50K jobs in an hour",b:"A flood must be absorbed and later replayed.",m:"Durable append-store absorbs it; the depth spike pages someone; replay is a throttled re-enqueue (filter by error/time, dry-run first), each job keeping its execution id."},
        {t:"Replay worker crashes halfway through 10K entries",b:"Unsure which were re-enqueued — risk of loss or double-replay.",m:"Atomic per-entry replay-state (pending&rarr;replayed) makes it resumable — un-replayed entries stay durable, and a duplicate re-enqueue is neutralized by execution-id idempotency downstream."},
      ],
      tradeoffs:[
        {a:"Database table",b:"Broker DLQ / Kafka topic",pick:"A table is queryable by error/owner/time and supports resumable, selective, rate-limited replay — the dead-letter is an operational surface; a log wins on throughput but is clumsy to triage. Optionally fed by a broker DLQ as transport."},
        {a:"Fail-fast to dead-letter on 4xx",b:"Retry everything",pick:"Retry transient 5xx/timeouts (usually succeed in budget); fail-fast poison 4xx/validation so depth is a meaningful signal, not transient noise."},
      ],
      probes:[
        "What lands in the dead-letter, and how do you distinguish a poison job from a transient failure?",
        "A bad deploy dead-letters 50K jobs — absorb the flood and replay safely after the fix.",
        "A replay worker crashes halfway — make replay neither lose nor double-run entries.",
      ],
    },
  },
  dbDoc:{
    component:"Job store",
    load:"Writes dominate and are multi-step: each execution walks <code>pending &rarr; queued &rarr; running &rarr; succeeded/failed</code> (3-4 state transitions) plus one append to <code>job_runs</code>, so ~10K executions/s steady &rarr; ~40-50K writes/s, spiking far higher at midnight. On top of that the scheduler does a <strong>due-scan read every second</strong> (find rows where <code>next_run_at &le; now</code>). ~100M jobs at a few KB each &approx; only a few hundred GB &mdash; the pressure is transactional write throughput and cheap due-discovery, not raw bytes. Every claim must be an <strong>atomic single-row compare-and-set</strong> (flip only if still <code>pending</code>) or two schedulers double-fire.",
    candidates:[
      {name:"PostgreSQL / NewSQL (CockroachDB, Spanner)",ceiling:"~5-10K writes/s per primary; NewSQL adds nodes for more",nodes:"data fits comfortably (~few hundred GB); shard/partition by job_id to spread ~50K writes/s across a handful of nodes",pick:true,note:"chosen &mdash; native range index on next_run_at makes the due-scan a bounded read, and an atomic conditional UPDATE gives the single-row claim for free with strong consistency. NewSQL variants scale writes horizontally without hand-sharding."},
      {name:"Cassandra / ScyllaDB (wide-column)",ceiling:"~10-50K raw writes/s per node, but LWT collapses it",nodes:"throughput-fine on paper, but every atomic claim needs a lightweight transaction",pick:false,note:"the atomic pending-to-queued claim requires a <strong>LWT (Paxos)</strong> &mdash; ~4 round trips per claim, cutting effective throughput to ~1-2K claims/s per partition. Range-scanning next_run_at across a hash-partitioned table is also awkward. Wrong fit for a claim-heavy transactional workload."},
      {name:"DynamoDB (managed KV)",ceiling:"~1K WCU &amp; ~3K RCU per partition, auto-splits",nodes:"managed / auto-sharded; conditional writes cover the claim",pick:false,note:"conditional writes handle the atomic claim, but a <strong>GSI on next_run_at</strong> buckets every job due at 00:00 into the same time-keyed partition &mdash; a <strong>hot partition at midnight</strong> that throttles exactly when 1M jobs fire. The due-scan access pattern fights Dynamo's partition model."},
    ],
    indexing:"The whole game is the due-scan, so the critical structure is a <strong>range index on <code>next_run_at</code></strong> (composite with <code>status</code>) &mdash; the scheduler reads <code>WHERE next_run_at &le; now+window AND status='pending'</code> as a bounded, ordered range pull each tick. Without it, every tick is a <strong>fatal full scan of 100M rows</strong> that pins the store. To avoid a temporal hotspot the index is effectively <strong>time-bucketed</strong> (and paired with jitter on popular cron times so a million midnight jobs smear across a window instead of one slot). The cost is <strong>write amplification</strong>: <code>next_run_at</code> changes on every run (cron reschedule) and every retry backoff, so the index is rewritten on each transition &mdash; acceptable because it is one narrow index over live jobs only, with historical runs kept in the separate <code>job_runs</code> table so they never bloat the hot index.",
    decision:"Pick a <strong>relational / NewSQL store</strong> (Postgres sharded by job_id, or CockroachDB/Spanner for horizontal write-scale). The workload is transactional &mdash; atomic single-row claims plus a range-scanned <code>next_run_at</code> index &mdash; which relational engines do natively and cheaply. <strong>Not Cassandra:</strong> the per-claim LWT tax (~4 round trips, ~1-2K/s) throttles the claim-heavy path, and range scans over a hash partitioner are unnatural. <strong>Not DynamoDB:</strong> a GSI on next_run_at creates a hot partition precisely at the midnight spike, throttling the moment it matters most. The deciding factors are the atomic conditional claim and the range due-scan, not raw storage &mdash; the data is small; the access pattern picks the database.",
  },
  schema:{tables:[
    {name:"jobs",pk:"job_id",columns:[
      ["job_id","bigint","primary key"],
      ["owner_id","bigint","user who submitted"],
      ["type","varchar(16)","one_time or cron"],
      ["cron_expr","varchar(64) NULL","cron spec (null for one_time)"],
      ["next_run_at","timestamptz","next fire time (indexed)"],
      ["status","varchar(16)","pending/queued/running/succeeded/failed"],
      ["payload_json","jsonb","handler input"],
      ["created_at","timestamptz","submit time"],
    ],rows:[
      ["1001","42","one_time","(null)","2026-07-22 14:00:00","pending","{export: true}","2026-07-22 09:10:00"],
      ["1002","7","cron","0 0 * * *","2026-07-23 00:00:00","pending","{report: daily}","2026-07-20 08:00:00"],
      ["1003","42","cron","*/5 * * * *","2026-07-22 12:05:00","queued","{sync: 1}","2026-07-21 16:30:00"],
    ]},
    {name:"job_runs",pk:"run_id",columns:[
      ["run_id","uuid","primary key"],
      ["job_id","bigint","which job (indexed)"],
      ["attempt","int","retry attempt number"],
      ["started_at","timestamptz","execution start"],
      ["finished_at","timestamptz NULL","null while running"],
      ["status","varchar(16)","running/succeeded/failed"],
      ["worker_id","varchar(64)","worker that ran it"],
      ["error","text NULL","last error (null on success)"],
    ],rows:[
      ["7a1b...","1003","1","2026-07-22 12:00:01","2026-07-22 12:00:03","succeeded","wkr-3f2a","(null)"],
      ["9c4d...","1001","2","2026-07-22 14:00:02","(null)","running","wkr-b71c","(null)"],
      ["2e8f...","1002","3","2026-07-22 00:00:00","2026-07-22 00:00:07","failed","wkr-a90d","timeout calling report svc"],
    ]},
    {name:"leases",pk:"job_id",columns:[
      ["job_id","bigint","leased job (primary key)"],
      ["run_id","uuid","current run holding the lease"],
      ["worker_id","varchar(64)","lease owner"],
      ["lease_expires_at","timestamptz","visibility timeout; renewed by heartbeat"],
    ],rows:[
      ["1001","9c4d...","wkr-b71c","2026-07-22 14:00:32"],
      ["1003","7a1b...","wkr-3f2a","2026-07-22 12:00:31"],
    ]},
    {name:"scheduler_partitions",pk:"partition_id",columns:[
      ["partition_id","int","hash slice of the job space (primary key)"],
      ["owner_scheduler","varchar(64)","scheduler instance that owns this partition"],
      ["epoch","bigint","fencing token, bumped on reassignment"],
    ],rows:[
      ["0","sched-1","17"],
      ["1","sched-2","17"],
      ["2","sched-1","18"],
    ]},
    {name:"dead_letter",pk:"job_id",columns:[
      ["job_id","bigint","exhausted job (primary key)"],
      ["run_id","uuid","final failing run"],
      ["failed_at","timestamptz","when it was dead-lettered"],
      ["attempts","int","total attempts before giving up"],
      ["last_error","text","final error for triage"],
    ],rows:[
      ["1002","2e8f...","2026-07-22 00:04:30","5","timeout calling report svc"],
      ["980","5b2c...","2026-07-21 03:11:09","5","handler threw NullPointer"],
    ]},
  ]},
  flows:[
    {id:"submit",name:"Submit a job",steps:[
      {node:"client",text:"Client sends <code>POST /jobs</code> with a handler, payload, schedule (run-at or cron), and an <strong>idempotency key</strong>."},
      {node:"api",text:"Job API authenticates, validates the schedule (parses the cron expression), and dedups on the idempotency key so a retry returns the same job id."},
      {node:"jobdb",text:"Persists the job row durably with <code>status=pending</code> and <code>next_run_at</code> set to the first fire time, then acks only after a quorum-durable write."},
      {node:"client",text:"Returns the <code>job_id</code>; the client polls status or receives a completion webhook later."},
    ]},
    {id:"execute",name:"Execute a due job",steps:[
      {node:"scheduler",requires:["scheduler"],text:"Scans its owned partition for jobs where <code>next_run_at &le; now</code> and atomically flips each <code>pending &rarr; queued</code>."},
      {node:"coordinator",requires:["coordinator"],text:"Assigns the scheduler that partition with a fencing epoch, guaranteeing exactly one owner scans each job."},
      {node:"queue",requires:["queue"],text:"The due task is enqueued so dispatch is decoupled from execution and bursts buffer as queue depth."},
      {node:"worker",text:"A worker leases the task (visibility timeout), transitions it to <code>running</code>, and executes the handler using the execution id for idempotency."},
      {node:"jobdb",text:"On success writes <code>succeeded</code> and a run record; for a cron job it computes the next fire time and returns the row to <code>pending</code>."},
      {node:"deadletter",requires:["deadletter"],text:"If retries are exhausted the job is routed to the dead-letter store with its last error for operator triage and replay."},
    ]},
  ],
  deepFlows:[
    {id:"submit-e2e",name:"Submit a job",summary:"**POST /jobs** → validate → **route to a shard by <code>job_id</code>** → durable INSERT → **quorum (semi-sync) replication** → ack. Follow exactly where the row lands and when we can safely say \"stored\".",steps:[
      {node:"client",title:"Client fires POST /jobs",snap:{cap:"Nothing durable yet — <strong>job 1001</strong> won't exist until the INSERT commits. Shown: the shard that will own it once written.",tables:[{name:"jobs (shard 5)",cols:["job_id","status","next_run_at","shard"],rows:[{c:["1001","<em>not created</em>","—","s5 (target)"],hi:1,tag:"pending write"}],note:"target shard = hash(job_id) → s5"}]},narrate:"A user (or service) wants *\"run this at 14:00\"*. The client sends one HTTP call carrying **what** to run, its **payload**, the **schedule**, and — critically — an **idempotency key** so a network retry doesn't create two jobs.",details:[
        {k:"wire",label:"Request on the wire",lang:"http",code:"POST /v1/jobs\nIdempotency-Key: 7d2c-owner42-export-0722\nContent-Type: application/json\n\n{\n  \"type\": \"one_time\",\n  \"run_at\": \"2026-07-22T14:00:00Z\",\n  \"handler\": \"reports.export\",\n  \"payload\": { \"export\": true, \"owner\": 42 }\n}"},
        {k:"note",label:"Why an idempotency key",text:"The client may time out and retry even though the first write succeeded. The key makes the create **exactly-once from the caller's view** — a retry returns the *same* <code>job_id</code> instead of scheduling the export twice."},
      ]},
      {node:"api",title:"Job API validates & dedups",snap:{cap:"Idempotency key not seen → proceed. A later retry with the same key matches this row and returns 1001 instead of inserting a second job.",tables:[{name:"idempotency",cols:["owner_id","idempotency_key","job_id"],rows:[{c:["42","7d2c-…-0722","<em>miss — no row</em>"],hi:1,tag:"lookup"}]}]},narrate:"The API authenticates the caller, **parses & validates the schedule** (for cron it compiles the expression and rejects garbage), then checks the idempotency key. If this key was seen before it short-circuits and returns the original <code>job_id</code> — no second row.",details:[
        {k:"query",label:"Idempotency check (unique key)",text:"A small <code>idempotency</code> table (or a unique constraint) keyed by <code>(owner_id, idempotency_key)</code> guarantees one job per key even under concurrent retries.",lang:"sql",code:"-- unique(owner_id, idempotency_key) makes the retry a no-op\nSELECT job_id FROM idempotency\nWHERE owner_id = 42 AND idempotency_key = '7d2c-owner42-export-0722';\n-- hit  -> return existing job_id, skip the INSERT\n-- miss -> continue to allocate + insert"},
        {k:"note",label:"job_id allocation",text:"The API mints a **Snowflake-style 64-bit <code>job_id</code>** (41-bit ms timestamp + node + sequence). It's roughly time-ordered *and* globally unique without a central counter — and it becomes the **routing key** for everything that follows."},
      ]},
      {node:"api",title:"Which shard does this job land on?",snap:{cap:"Routing key fixed for life: <code>jump_hash(1001)=5</code>. Every future read / claim / status-flip recomputes the same hash — no lookup table.",tables:[{name:"shard routing",cols:["job_id","function","shard"],rows:[{c:["1001","jump_hash(job_id, N)","s5"],hi:1,tag:"routed"},{c:["994","jump_hash(…)","s2"]},{c:["1207","jump_hash(…)","s7"]}]}]},narrate:"100M jobs won't fit on one node, so <code>jobs</code> is **sharded**. The decision the interviewer is really testing: *what do you shard on, and why.* We hash the <code>job_id</code> with a **jump / consistent hash** into one of N shards.",details:[
        {k:"route",label:"Shard routing (deterministic)",lang:"python",code:"# jump consistent hash keeps keys stable when N grows\nshard = jump_hash(job_id, NUM_SHARDS)   # e.g. job_id 1001 -> shard 5\n# EVERY later query for this job reuses the SAME function,\n# so status flips, reads and reschedules all hit shard 5."},
        {k:"route",label:"Why hash(job_id), not owner_id or time",text:"**hash(job_id)** spreads writes evenly and keeps due-scans balanced. **Range by job_id/time** would make the newest shard a write hotspot (all fresh jobs pile on one node). **hash(owner_id)** makes *\"list my jobs\"* cheap but lets a heavy tenant hot-spot a single shard and skew the due-scan."},
        {k:"gotcha",label:"The trade-off you must name",text:"Sharding by <code>job_id</code> means *\"list all jobs for owner 42\"* **fans out to every shard**. Mitigate with a secondary <code>jobs_by_owner</code> index table (keyed by owner_id) or a search index — don't pretend the trade-off doesn't exist."},
      ]},
      {node:"jobdb",title:"Durable INSERT on the target shard",snap:{cap:"The row now exists on <strong>shard 5's leader</strong> with <code>status=pending</code>. This row is the source of truth — nothing is scheduled until it commits.",tables:[{name:"jobs (shard 5 leader)",cols:["job_id","status","next_run_at","shard"],rows:[{c:["994","succeeded","—","s5"]},{c:["1001","pending","2026-07-22 14:00:00Z","s5"],hi:1,tag:"inserted"}]},{name:"idempotency",cols:["owner_id","idempotency_key","job_id"],rows:[{c:["42","7d2c-…-0722","1001"],hi:1,tag:"written"}]}]},narrate:"The request now hits the **leader** of shard 5. We write the row with <code>status='pending'</code> and <code>next_run_at</code> = the first fire time. This row *is* the source of truth — nothing is scheduled until this commits.",details:[
        {k:"query",label:"The push query",lang:"sql",code:"INSERT INTO jobs\n  (job_id, owner_id, type, cron_expr,\n   next_run_at, status, payload_json, created_at)\nVALUES\n  (1001, 42, 'one_time', NULL,\n   '2026-07-22 14:00:00Z', 'pending', $payload, now())\nON CONFLICT (job_id) DO NOTHING\nRETURNING job_id;"},
        {k:"query",label:"Indexes that matter",text:"A composite index on <code>(status, next_run_at)</code> makes the later due-scan a range read instead of a full-table scan. <code>job_id</code> is the primary key, so status flips are point writes."},
      ]},
      {node:"jobdb",title:"Replication — sync or async?",snap:{cap:"Commit ACK waits for <strong>leader + 1 follower</strong> (W=2 of N=3). The 3rd replica reconciles asynchronously — a single-node loss stays RPO=0.",tables:[{name:"shard 5 · replica set",cols:["replica","role","has job 1001?"],rows:[{c:["r-a1","leader (AZ-a)","yes — WAL fsync"],hi:1,tag:"durable"},{c:["r-a2","follower (AZ-b)","yes — acked"],hi:1,tag:"durable"},{c:["r-a3","follower (AZ-c)","catching up…"]}]}]},narrate:"This is the durability question. Each shard is a **replica set of N=3** (1 leader + 2 followers, spread across AZs). We commit with **quorum / semi-synchronous replication**: the leader appends to its WAL and waits for **≥1 follower to acknowledge** (W=2 of 3) *before* it tells the API \"committed\".",details:[
        {k:"repl",label:"Commit path (W=2, R=2, N=3)",lang:"text",code:"client write\n   │\n   ▼\n[leader shard5]  append WAL, fsync\n   │  replicate ─────────────► [follower A]  ack ✔\n   │  replicate ─► [follower B] (async, catches up)\n   ▼\ncommit ACK returned only after leader + 1 follower are durable"},
        {k:"repl",label:"Why semi-sync (not pure async / not full sync)",text:"**Pure async** would ack before any follower has the data — a leader crash right after ack **loses an acknowledged job** (RPO&gt;0), which violates *\"a submitted job is never lost.\"* **Fully synchronous to all 3** is safe but pays the slowest replica's latency on every write. **Semi-sync (leader + 1)** gives **RPO=0 for a single-node loss** at a fraction of the tail latency — the 3rd replica reconciles asynchronously."},
        {k:"note",label:"Failover",text:"If the leader dies, a follower that has the committed WAL is promoted (Raft/Patroni-style). Because the ack waited for a quorum, the promoted node already has every acked job — no lost schedules."},
      ]},
      {node:"api",title:"Ack the client",snap:{cap:"Client holds <code>job_id 1001</code> — durable, deduped, locatable. Next flow: how it actually fires.",tables:[{name:"jobs (shard 5)",cols:["job_id","status","next_run_at","shard"],rows:[{c:["1001","pending","2026-07-22 14:00:00Z","s5"],hi:1,tag:"committed"}]}]},narrate:"Only *after* the quorum commit does the API return. The job is now guaranteed to survive crashes. The client gets its <code>job_id</code> and can poll status or wait for a completion webhook.",details:[
        {k:"wire",label:"Response",lang:"http",code:"201 Created\n{\n  \"job_id\": 1001,\n  \"status\": \"pending\",\n  \"next_run_at\": \"2026-07-22T14:00:00Z\"\n}"},
        {k:"note",label:"What we've guaranteed so far",text:"Durable, deduped, and locatable: the row lives on **shard 5**, replicated to a quorum, and every future operation can find it again by re-hashing <code>job_id</code>. Next flow: how it actually *fires*."},
      ]},
    ]},

    {id:"execute-e2e",name:"Execute a due job",summary:"**Coordinator** hands each scheduler a partition with a **fencing epoch** → scheduler **polls its shards** for due rows → **atomic pending→queued** → enqueue on the **partition keyed by job_id** → worker **leases** & runs → status write **routes back to the same shard** → cron reschedules or dead-letters.",steps:[
      {node:"coordinator",title:"Who is allowed to fire which jobs?",snap:{cap:"Job space split into P partitions; each leased to one scheduler with a monotonic <strong>epoch</strong>. Partition 2 was just reassigned → epoch 17→18, fencing the old owner.",tables:[{name:"scheduler_partitions",cols:["partition","owner","epoch"],rows:[{c:["0","sched-1","17"]},{c:["1","sched-2","17"]},{c:["2","sched-1 (was sched-3)","18"],hi:1,tag:"reassigned"}]}]},narrate:"With 1M jobs possibly due in the same second, many scheduler instances run in parallel — but **exactly one** must own any given job or it double-fires. The **coordinator** splits the job space into P logical partitions (say 256) and leases each to one scheduler, stamped with a monotonically increasing **epoch (fencing token)**.",details:[
        {k:"route",label:"Partition ownership table",lang:"sql",code:"-- scheduler_partitions: one owner per slice, epoch = fencing token\npartition_id | owner_scheduler | epoch\n     0       |   sched-1       |  17\n     1       |   sched-2       |  17\n     2       |   sched-1       |  18   -- reassigned, epoch bumped"},
        {k:"repl",label:"Fencing prevents split-brain",text:"If <code>sched-1</code> stalls (GC pause) and its lease expires, the coordinator reassigns its partitions and **bumps the epoch to 18**. When the zombie <code>sched-1</code> wakes and tries to claim a job with epoch 17, the store rejects it (<code>17 &lt; current 18</code>). Result: **no two schedulers ever fire the same job**."},
      ]},
      {node:"scheduler",title:"Poll: find jobs that are due",snap:{cap:"Each scheduler scans only shards for the partitions it owns, via the <code>(status,next_run_at)</code> index. Rows inside the +5s look-ahead are candidates.",tables:[{name:"jobs — due-scan (shard 5)",cols:["job_id","status","next_run_at","shard"],rows:[{c:["1001","pending","14:00:00 (due)","s5"],hi:1,tag:"candidate"},{c:["994","succeeded","—","s5"]},{c:["1207","pending","15:30:00 (future)","s5"]}]}]},narrate:"Each scheduler only scans the **shards mapped to the partitions it owns**. It runs a tight poll loop (~1s) with a small look-ahead window so it enqueues *just* before the due instant and fires on time.",details:[
        {k:"query",label:"Due-scan (the watcher query)",lang:"sql",code:"SELECT job_id, payload_json, next_run_at\nFROM jobs\nWHERE status = 'pending'\n  AND next_run_at <= now() + interval '5 seconds'\nORDER BY next_run_at\nLIMIT 500\nFOR UPDATE SKIP LOCKED;   -- many poller threads, no collisions"},
        {k:"route",label:"Which shard does this run on?",text:"The scan runs **locally on each shard the scheduler owns** — it uses the <code>(status, next_run_at)</code> index so it's a cheap range read, not a scan of 100M rows. <code>SKIP LOCKED</code> lets several poller threads share a shard without blocking each other."},
        {k:"note",label:"Look-ahead window",text:"The <code>+5s</code> horizon plus a 1s poll means a job due at 14:00:00 is picked up by ~13:59:59 and queued with time to spare — that's how we hit the *\"fire within 1–2s\"* SLO."},
      ]},
      {node:"scheduler",title:"Claim it: atomic pending → queued",snap:{cap:"CAS flips <code>pending→queued</code> guarded by <code>WHERE status='pending'</code>. A racing poller gets 0 rows and skips — the job is claimed exactly once.",tables:[{name:"jobs (shard 5)",cols:["job_id","status","next_run_at","shard"],rows:[{c:["1001","<strong>queued</strong>","14:00:00","s5"],hi:1,tag:"pending→queued"}]}]},narrate:"Before enqueuing, the scheduler flips the row to <code>queued</code> with a **compare-and-set guard**. Only the update that still sees <code>pending</code> wins the row, so even if two pollers raced, the job is enqueued once.",details:[
        {k:"query",label:"Compare-and-set claim",lang:"sql",code:"UPDATE jobs\nSET status = 'queued', updated_at = now()\nWHERE job_id = 1001\n  AND status = 'pending'     -- CAS guard\nRETURNING job_id;\n-- 0 rows back => someone else already claimed it, skip"},
        {k:"route",label:"Routed to the leader of shard 5",text:"This write targets the **leader of <code>hash(job_id)=5</code>** — the same shard the row was inserted on. The routing key never changes, so a claim can never land on the wrong node."},
      ]},
      {node:"queue",title:"Enqueue — which partition?",snap:{cap:"Task published to partition <strong>P41</strong> = <code>hash(1001) % 64</code>. Same job_id ⇒ same partition ⇒ per-job order preserved. Other jobs occupy their own partitions and drain in parallel. The SQS alternative (one logical queue, no partitions) is shown below for contrast.",queues:[{name:"due-jobs",kind:"kafka",by:"key = job_id · 64 partitions",parts:[{id:"P07",key:"other jobs",msgs:[{v:"job 812"},{v:"job 940"}],commit:5,end:7},{id:"P41",key:"← hash(1001)",msgs:[{v:"job 1001",hi:1,tag:"appended @6"}],commit:6,end:7},{id:"P58",key:"other jobs",msgs:[{v:"job 733"}],commit:9,end:10}]},{name:"due-jobs (SQS alternative)",kind:"sqs",by:"no partitions · one logical queue",parts:[{id:"queue",msgs:[{v:"job 812",s:"visible"},{v:"job 1001",s:"visible",hi:1,tag:"SendMessage"},{v:"job 733",s:"visible"}]}]}],tables:[{name:"jobs (shard 5)",cols:["job_id","status","shard"],rows:[{c:["1001","queued","s5"],hi:1}]}]},narrate:"The due task is published to the durable queue (Kafka/SQS-style). Decoupling here lets a 1M-in-one-second burst **buffer as queue depth** while workers drain steadily at ~10K/s.",details:[
        {k:"route",label:"Partition selection",lang:"python",code:"# topic 'due-jobs' with 64 partitions\npartition = hash(job_id) % 64      # job 1001 -> partition 41\nproducer.send('due-jobs', key=job_id, value=task, partition=partition)"},
        {k:"route",label:"Why key by job_id",text:"Same <code>job_id</code> → same partition → **per-job ordering is preserved**: a retry of a job can never overtake an earlier attempt of that same job. Across different jobs everything stays parallel."},
        {k:"note",label:"How partitions map to workers",text:"Workers form a **consumer group**; each partition is owned by exactly one worker at a time. So partition count is your **max execution parallelism** (64 here) and rebalancing on worker join/leave is handled by the broker."},
        {k:"queue",label:"How Kafka adds the task",lang:"python",code:"# the producer picks the partition FROM the key\npart = hash(job_id) % 64            # 1001 -> P41\nproducer.send('due-jobs', key=job_id, value=task)\n# broker APPENDS to P41's log at the next offset (6);\n# log-end advances 6 -> 7. Nothing is locked or removed --\n# it's an append-only log, consumers track their own offset."},
        {k:"queue",label:"How SQS adds the task",lang:"python",code:"# no partitions -- one call drops a message in the queue\nsqs.send_message(QueueUrl=Q, MessageBody=task,\n                 MessageGroupId=job_id)   # FIFO: order per group\n# Standard queue: at-least-once, best-effort order, ~unlimited TPS.\n# FIFO queue:    exactly-once + strict order within a group,\n#                capped ~300 msg/s (3000 batched)."},
        {k:"route",label:"Partition count = max parallelism",text:"With Kafka, **partition count (64) caps consumer parallelism** — one partition is consumed by one worker in the group at a time, so you scale by adding partitions. SQS has no partitions: parallelism is just the number of pollers, but you lose per-key ordering unless you use **FIFO + <code>MessageGroupId</code>**, which then serialises each group."},
        {k:"gotcha",label:"Ordering vs throughput — name the trade-off",text:"Keying by <code>job_id</code> (Kafka) or <code>MessageGroupId=job_id</code> (SQS FIFO) keeps a job's attempts ordered, so a retry can't overtake an earlier attempt. The cost: a slow message **head-of-line blocks its own key**. Standard SQS drops ordering for the highest throughput and simplest scaling — pick per requirement."},
      ]},
      {node:"worker",title:"Lease the task (visibility timeout)",snap:{cap:"The worker owns P41 in the consumer group; it reads at <strong>offset 6</strong> (job 1001) but does <strong>not</strong> commit yet — commit happens only after success, so a crash redelivers. A lease row makes the run mutually exclusive.",queues:[{name:"due-jobs",kind:"kafka",by:"consumer group 'workers' · P41 → wkr-b71c",parts:[{id:"P41",key:"reading, uncommitted",msgs:[{v:"job 1001",hi:1,tag:"in-flight @6"}],commit:6,end:7}]}],tables:[{name:"leases",cols:["job_id","worker_id","lease_expires_at"],rows:[{c:["1001","wkr-b71c","now + 30s"],hi:1,tag:"leased"}]},{name:"jobs (shard 5)",cols:["job_id","status","shard"],rows:[{c:["1001","<strong>running</strong>","s5"],hi:1,tag:"queued→running"}]},{name:"job_runs",cols:["run_id","job_id","attempt","status"],rows:[{c:["r-77","1001","1","running"],hi:1,tag:"started"}]}]},narrate:"A worker pulls the task and takes a **lease** so no one else runs it while it's in flight. It records the lease with an expiry, flips the job to <code>running</code>, and **heartbeats** to extend the lease for long jobs.",details:[
        {k:"query",label:"Take the lease + go running",lang:"sql",code:"INSERT INTO leases (job_id, run_id, worker_id, lease_expires_at)\nVALUES (1001, $run_id, 'wkr-b71c', now() + interval '30 s')\nON CONFLICT (job_id) DO UPDATE\n  SET worker_id = excluded.worker_id,\n      lease_expires_at = excluded.lease_expires_at\n  WHERE leases.lease_expires_at < now();   -- only steal if expired\n\nUPDATE jobs SET status='running' WHERE job_id=1001 AND status='queued';\nINSERT INTO job_runs (run_id, job_id, attempt, started_at, status, worker_id)\nVALUES ($run_id, 1001, 1, now(), 'running', 'wkr-b71c');"},
        {k:"repl",label:"At-least-once + idempotency",text:"If the worker dies mid-run, <code>lease_expires_at</code> lapses and the task is **redelivered** — that's the *at-least-once* guarantee. Handlers key their side effects on <code>run_id</code> so a duplicate delivery is a **harmless no-op**."},
        {k:"queue",label:"How Kafka is polled",lang:"python",code:"# long-poll returns a batch from OWNED partitions\nrecs = consumer.poll(timeout_ms=500)   # reads P41 at offset 6\n# ... execute the job ...\nconsumer.commit()   # ONLY after success: offset 6 -> 7\n# crash before commit => same offset re-read => at-least-once\n# (no per-message ack; the committed offset IS the progress)"},
        {k:"queue",label:"How SQS is polled",lang:"python",code:"# receive makes the message INVISIBLE for VisibilityTimeout\nm = sqs.receive_message(WaitTimeSeconds=20,   # long-poll\n                        VisibilityTimeout=30) # in-flight window\n# ... execute the job ...\nsqs.delete_message(m.ReceiptHandle)   # success => truly gone\n# no delete within 30s => becomes visible again => redelivered\n# long jobs call ChangeMessageVisibility to extend the lease"},
        {k:"route",label:"Which partition am I even reading?",text:"A worker only polls the **partitions its consumer group assigned to it** (here P41). It never sees P07 or P58 — those belong to other workers. That assignment *is* the load-balancing: add workers → the broker rebalances partitions across them (up to 64, the partition count)."},
      ]},
      {node:"jobdb",title:"Write the result — back to shard 5",snap:{cap:"Terminal write routes back to <code>hash(1001)=s5</code>. Now the Kafka offset <strong>commits 6→7</strong> (message consumed) and the lease row is deleted.",queues:[{name:"due-jobs",kind:"kafka",by:"consumer group 'workers' · P41",parts:[{id:"P41",key:"caught up",msgs:[{v:"(no unread messages)"}],commit:7,end:7}]}],tables:[{name:"jobs (shard 5)",cols:["job_id","status","shard"],rows:[{c:["1001","<strong>succeeded</strong>","s5"],hi:1,tag:"running→succeeded"}]},{name:"job_runs",cols:["run_id","job_id","attempt","status"],rows:[{c:["r-77","1001","1","succeeded"],hi:1,tag:"finished"}]},{name:"leases",cols:["job_id","worker_id","lease_expires_at"],rows:[{c:["1001","—","—"],gone:1,tag:"removed"}]}]},narrate:"The handler finishes. The worker writes the terminal state and closes the run record. Every one of these writes **routes by <code>job_id</code> to the same shard leader** — the store never has to guess where the job lives.",details:[
        {k:"query",label:"Success write",lang:"sql",code:"UPDATE jobs   SET status='succeeded', updated_at=now()\nWHERE job_id=1001 AND status='running';\n\nUPDATE job_runs SET finished_at=now(), status='succeeded'\nWHERE run_id=$run_id;\n\nDELETE FROM leases WHERE job_id=1001;   -- release the lease"},
        {k:"route",label:"On which shard does the status update go?",text:"**Always <code>hash(job_id)</code> → shard 5's leader.** That's the answer to *\"how do I decide which shard to update\"*: you don't store it separately — you recompute the same hash of the same key, so INSERT, claim, run and completion all converge on one shard."},
      ]},
      {node:"jobdb",title:"Cron? Reschedule the next fire",snap:{cap:"A <strong>cron</strong> job doesn't stop at succeeded — it returns to <code>pending</code> with a fresh <code>next_run_at</code> on the same shard, and the poller (step 2) picks it up again next cycle.",tables:[{name:"jobs (shard 3)",cols:["job_id","type","status","next_run_at"],rows:[{c:["1002","cron","<strong>pending</strong>","2026-07-23 00:00:00Z"],hi:1,tag:"running→pending"}]}]},narrate:"For a recurring job we don't stop — we compute the next fire time from the cron expression and return the row to <code>pending</code>, and the whole cycle repeats on the same shard.",details:[
        {k:"query",label:"Reschedule",lang:"sql",code:"-- next = croniter(cron_expr, now()).get_next()\nUPDATE jobs\nSET status='pending', next_run_at = '2026-07-23 00:00:00Z', updated_at=now()\nWHERE job_id = 1002 AND status='running';"},
        {k:"note",label:"One-time vs cron",text:"A one-time job ends at <code>succeeded</code>. A cron job loops back to <code>pending</code> with a fresh <code>next_run_at</code> — the poller will pick it up again exactly as in step 2."},
      ]},
      {node:"deadletter",title:"Retries exhausted → dead-letter",snap:{cap:"Alternate branch: after the retry cap (5) the job is <strong>dead-lettered</strong> with its last error and set to <code>failed</code> — it never retries forever and never silently vanishes.",tables:[{name:"jobs (shard 3)",cols:["job_id","status","attempts"],rows:[{c:["1002","<strong>failed</strong>","5"],hi:1,tag:"failed"}]},{name:"dead_letter",cols:["job_id","run_id","attempts","last_error"],rows:[{c:["1002","r-91","5","timeout calling report svc"],hi:1,tag:"dead-lettered"}]}]},narrate:"If the handler keeps failing, we retry with backoff up to a cap (say 5). After the last attempt the job is **dead-lettered** with its final error for a human to triage or replay — it never silently disappears and never retries forever.",details:[
        {k:"query",label:"Give up safely",lang:"sql",code:"INSERT INTO dead_letter (job_id, run_id, failed_at, attempts, last_error)\nVALUES (1002, $run_id, now(), 5, 'timeout calling report svc');\n\nUPDATE jobs SET status='failed' WHERE job_id=1002;"},
        {k:"gotcha",label:"Poison-pill protection",text:"Without a dead-letter, one permanently-failing job would be redelivered forever and burn a worker slot. The attempt cap + DLQ **contains the blast radius** and preserves the error for replay."},
      ]},
    ]},

    {id:"monitor-e2e",name:"Check status & history",summary:"**GET /jobs/{id}** → route the read by <code>job_id</code> → read status + run history → the consistency choice: **read-your-writes from the leader vs cheaper (slightly stale) follower reads**.",steps:[
      {node:"client",title:"Client asks: what happened to my job?",snap:{cap:"A read — no mutation. Shown: the row the read will target on shard 5.",tables:[{name:"jobs (shard 5)",cols:["job_id","status","next_run_at","shard"],rows:[{c:["1001","running","—","s5"],hi:1,tag:"will read"}]}]},narrate:"Monitoring is a read: *current status, next run time, and the execution history.* The client calls with the <code>job_id</code> it got at submit time.",details:[
        {k:"wire",label:"Request",lang:"http",code:"GET /v1/jobs/1001         -> status + next_run_at\nGET /v1/jobs/1001/runs    -> execution history"},
      ]},
      {node:"api",title:"Route the read to the right shard",snap:{cap:"Same hash as submit → shard 5. Consistency choice: <strong>read-your-writes → leader</strong>; <strong>dashboards → follower</strong> (tolerates ms of lag, offloads the leader).",tables:[{name:"shard 5 replicas",cols:["replica","role","serves"],rows:[{c:["r-a1","leader","read-your-writes"],hi:1,tag:"RYW"},{c:["r-a2","follower","dashboards (stale-ok)"]}]}]},narrate:"The API recomputes **the same hash it used at submit** to find where the row lives — no lookup table needed. Then it makes the key consistency call: **which replica** answers.",details:[
        {k:"route",label:"Same routing key, again",lang:"python",code:"shard = jump_hash(job_id, NUM_SHARDS)   # 1001 -> shard 5 (identical to submit)"},
        {k:"repl",label:"Leader vs follower read",text:"**Read-your-writes** (a user who just submitted must see the job) → route to the **leader**. **Dashboards / bulk monitoring** tolerate ~ms of replication lag → route to a **follower** to offload the leader and scale reads. State this trade-off explicitly; it's a favourite senior probe."},
      ]},
      {node:"jobdb",title:"Read status + history",snap:{cap:"Two point reads on shard 5, both keyed by <code>job_id</code>: the live row + the append-only history. No state changes.",tables:[{name:"jobs (shard 5)",cols:["job_id","status","next_run_at"],rows:[{c:["1001","running","—"],hi:1,tag:"read"}]},{name:"job_runs (history)",cols:["run_id","attempt","status","started_at"],rows:[{c:["r-77","1","failed","13:59:59Z"]},{c:["r-78","2","running","14:00:02Z"],hi:1,tag:"latest"}]}]},narrate:"Two point reads on shard 5, both keyed by <code>job_id</code>: the live row for current state, and the append-only <code>job_runs</code> for the attempt history.",details:[
        {k:"query",label:"Status + history",lang:"sql",code:"SELECT status, next_run_at FROM jobs WHERE job_id = 1001;\n\nSELECT run_id, attempt, started_at, finished_at, status, error\nFROM job_runs\nWHERE job_id = 1001\nORDER BY started_at DESC\nLIMIT 20;"},
        {k:"note",label:"Why history is a separate table",text:"<code>jobs</code> holds the *current* state (one row, hot, frequently updated); <code>job_runs</code> is an **append-only ledger** of every attempt. Splitting them keeps the hot row small and gives you a clean audit trail for retries and dead-letters."},
      ]},
      {node:"api",title:"Assemble & return",snap:{cap:"Terminal states (<code>succeeded/failed</code>) are cacheable for a few seconds; non-terminal states must not be cached.",tables:[{name:"status cache",cols:["job_id","cached?","ttl"],rows:[{c:["1001","no — running is non-terminal","—"],hi:1,tag:"skip cache"}]}]},narrate:"The API stitches the current state and recent runs into one response. High-traffic status endpoints can cache the terminal states (<code>succeeded/failed</code> never change) for a few seconds to shed read load.",details:[
        {k:"wire",label:"Response",lang:"json",code:"{\n  \"job_id\": 1001,\n  \"status\": \"running\",\n  \"next_run_at\": null,\n  \"runs\": [\n    { \"attempt\": 2, \"status\": \"running\", \"started_at\": \"...T14:00:02Z\" }\n  ]\n}"},
        {k:"gotcha",label:"Don't cache non-terminal state",text:"Only cache <code>succeeded/failed</code>. Caching <code>pending/queued/running</code> would show users a stale lifecycle — those transition constantly."},
      ]},
    ]},
  ],
  requirements:{
    functional:[
      "Submit a one-time job to run at a specific time T, and submit recurring cron jobs (e.g. every 5 min, daily at midnight)",
      "Execute jobs reliably at their scheduled time, with automatic retries on failure",
      "Monitor a job: current status, next run time, and execution history",
    ],
    nonFunctional:[
      "Durability — a submitted job is never lost, even if a node dies immediately after acknowledging it",
      "At-least-once execution plus idempotency — every due job runs even across failures, and a duplicate run is harmless",
      "Timely execution at scale — fire within ~1-2s of due time at 10K+ executions/s, with 100M jobs registered and up to 1M due in the same second",
      "Fault tolerance — a scheduler or worker crash must not stall execution or double-fire jobs",
    ],
  },
  reqBuild:[
    {req:"Submit and store a one-time job, query its status",turns:[
      {who:"intv",text:"Start with the simplest thing that satisfies requirement one for a one-time job: a user submits run this at 14:00, and later asks what happened. What's the minimal path?"},
      {who:"cand",text:"The <strong>client</strong> calls the <strong>job API</strong> with a job definition — what to run (a handler id or a target endpoint), a payload, and a run-at time. The API validates it and writes a row to the <strong>job store</strong>, then acknowledges. Status queries are just a read of that same row. My four core boxes cover it. The key decision here is that the job store is the durable record: the moment the API returns success, the job survives crashes, because it's committed to durable storage before I ack — that's the durability requirement in its simplest form."},
      {who:"intv",text:"What does that job row actually look like, and how do you represent where the job is in its life?"},
      {who:"cand",text:"A row keyed by job id with the definition (handler, payload, run-at) plus a <strong>state machine</strong> field.<span class='eg'>status moves pending &rarr; queued &rarr; running &rarr; success, or &rarr; failed; plus next_run_at, attempt count, and last-updated timestamps.</span>A one-time job starts <code>pending</code> with <code>next_run_at = T</code>. Execution hasn't entered the picture yet — right now the worker could even poll the store directly for due rows. I'm keeping it dumb on purpose; efficient due-job discovery and decoupled dispatch are the next requirement, and I don't want to guess at that machinery before I need it."},
    ],resources:[
      {title:"Hello Interview — Job Scheduler breakdown",url:"https://www.hellointerview.com/learn/system-design/problem-breakdowns/job-scheduler"},
    ]},
    {req:"Execute jobs at their scheduled time (adds scheduler + queue)",reveal:["scheduler","queue"],turns:[
      {who:"intv",text:"Now make jobs actually fire at their time. In the minimal design, how does anything know a job is due, and why isn't that good enough?"},
      {who:"cand",text:"Right now the only option is workers polling the job store for rows where <code>next_run_at &le; now</code>. That works but it couples discovery to execution and hammers the store. Let me split responsibilities: add a <strong>scheduler</strong> whose only job is to scan for due jobs and hand them off, and a <strong>task queue</strong> that holds due jobs so dispatch is decoupled from execution. The scheduler finds due work and enqueues it; <strong>workers</strong> consume from the queue instead of polling the DB. That separation lets me scale finding-work and doing-work independently."},
      {who:"intv",text:"Walk me through the flow once a job comes due, and how the scheduler finds due jobs without a full table scan."},
      {who:"cand",text:"The scheduler queries an <strong>index on <code>next_run_at</code></strong> for a small window — jobs due in the next, say, few seconds — flips each from <code>pending</code> to <code>queued</code>, and pushes a task message onto the queue. A worker pulls the task, transitions it to <code>running</code>, executes the handler, and writes back <code>success</code> or <code>failed</code>.<span class='eg'>the due-scan is a range read like WHERE next_run_at &le; now+5s AND status='pending', ordered by next_run_at — bounded work per tick, not a scan of 100M rows.</span>The queue also absorbs bursts: if a thousand jobs come due at once, they buffer in the queue and workers drain them at their own pace rather than the scheduler blocking."},
      {who:"intv",text:"Why put a queue in the middle at all — why not have the scheduler call workers directly?"},
      {who:"cand",text:"Two reasons: <strong>backpressure</strong> and <strong>decoupling failure domains</strong>. If the scheduler called workers synchronously, a slow or saturated worker pool would back up the scanner and it would start missing due times. With a queue in between, the scheduler just enqueues and moves on; workers consume at whatever rate they can sustain, and a burst simply grows queue depth rather than dropping work. The queue also gives me a natural place to get <strong>at-least-once</strong> delivery later — a message stays until a worker acks it. So the scheduler's tick stays cheap and bounded no matter how the workers are doing."},
    ],resources:[
      {title:"Hello Interview — Job Scheduler breakdown",url:"https://www.hellointerview.com/learn/system-design/problem-breakdowns/job-scheduler"},
      {title:"System Design Primer — asynchronism",url:"https://github.com/donnemartin/system-design-primer"},
    ]},
    {req:"Recurring cron jobs and retries (adds dead-letter)",reveal:["deadletter"],turns:[
      {who:"intv",text:"Requirement extends two ways: cron jobs that recur, and jobs that fail and must be retried. Handle recurrence first — how does a daily job keep firing?"},
      {who:"cand",text:"A recurring job stores a <strong>cron expression</strong> instead of a single run-at. After each execution completes, I <strong>compute the next fire time</strong> from the cron spec and write it back to <code>next_run_at</code>, returning the job to <code>pending</code>. So a cron job is just a one-time job that reschedules itself.<span class='eg'>a job with cron 0 0 * * * runs, then next_run_at is set to tomorrow 00:00; the same due-scan on next_run_at picks it up again.</span>The scheduler doesn't care whether a job is one-time or recurring — it only looks at <code>next_run_at</code>. That keeps the scan path uniform."},
      {who:"intv",text:"Now retries. A job fails — how do you retry, and where does a job that keeps failing end up?"},
      {who:"cand",text:"On failure the worker increments the attempt count and reschedules the job with <strong>exponential backoff plus jitter</strong> — retry in 1s, then 2s, 4s, and so on, rather than immediately hammering a broken dependency.<span class='eg'>next_run_at = now + min(base * 2^attempt, cap) + random_jitter; attempt capped at, say, 5.</span>When retries are exhausted, I don't loop forever — the job goes to a <strong>dead-letter</strong> store for failed jobs. Let me add that box. It captures the job, its payload, and the last error so an operator can inspect a poison job and replay it after fixing the cause, instead of it silently vanishing or spinning retries forever."},
      {who:"intv",text:"Why route exhausted jobs to a separate dead-letter store rather than just marking them failed in the job store?"},
      {who:"cand",text:"Marking them <code>failed</code> in place is fine for state, but the dead-letter store gives me an explicit, monitorable <strong>queue of things needing human attention</strong> — I can alert on its depth, triage poison jobs, and <strong>replay</strong> them as a batch once the underlying bug or dependency is fixed. It also keeps failed work from cluttering the hot due-scan path. So the dead-letter is both a safety net (nothing is lost) and an operational surface (someone can see and act on failures). That satisfies recurrence and retries end to end — now I'd start hardening the distributed failure cases."},
    ],resources:[
      {title:"Cron",url:"https://en.wikipedia.org/wiki/Cron"},
      {title:"Hello Interview — Job Scheduler breakdown",url:"https://www.hellointerview.com/learn/system-design/problem-breakdowns/job-scheduler"},
    ]},
  ],
  systemDives:[
    {title:"Two schedulers double-fire the same job — and the SPOF",tag:"failover",reveal:["coordinator"],turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> you run <b>one</b> scheduler for availability reasons you now regret — when it crashes, nothing fires until it restarts, so it's a SPOF. You add a <b>second</b> scheduler. Now both scan the same due window and both enqueue job 42, which runs <b>twice</b>. You have a SPOF if you run one and double-fires if you run two. Resolve it.</span>"},
      {who:"cand",text:"I need multiple schedulers for availability but exactly-one <em>owner</em> per job at scan time. The clean answer is a <strong>coordinator</strong> for leader election and partition assignment — let me add it. The simplest form: elect a single active leader via <strong>ZooKeeper or etcd</strong>; the leader does the scanning, standbys wait. If the leader dies, the coordinator's lease expires and a standby is elected within seconds — no SPOF, and only one scanner runs so no double-enqueue. The coordinator is the arbiter of who is allowed to act."},
      {who:"intv",text:"A single leader scanning 100M jobs is a scaling ceiling. Can you use all the schedulers without reintroducing double-fires?"},
      {who:"cand",text:"Yes — move from one leader to <strong>partitioned ownership</strong>. The coordinator assigns each scheduler a disjoint slice of the job space — by hash of job id or by shard — so every job has exactly one owner scanning it, and all schedulers work in parallel. Double-fires are impossible because two schedulers never own the same job. When a scheduler dies, the coordinator <strong>reassigns its partitions</strong> to survivors, so it's both horizontally scalable and fault tolerant. The invariant the coordinator enforces is: one owner per partition at any instant."},
      {who:"intv",text:"During a reassignment the old owner might still think it owns a partition while the new owner starts. Now both scan it briefly. How do you stop that split-brain double-fire?"},
      {who:"cand",text:"<strong>Fencing tokens</strong>. Each partition assignment carries a monotonically increasing token; when the scheduler enqueues or claims a job it presents its token, and the job store (or queue) rejects any action from a stale token. So even if a slow old owner wakes up believing it still holds the partition, its writes are fenced off because a higher token has been issued. Combined with a per-job atomic claim — flip <code>pending &rarr; queued</code> conditionally, only if still <code>pending</code> — even an overlap window can't enqueue the same job twice. Leader election gives liveness; fencing plus the conditional claim gives safety."},
    ],resources:[
      {title:"Leader election",url:"https://en.wikipedia.org/wiki/Leader_election"},
      {title:"ZooKeeper overview",url:"https://zookeeper.apache.org/doc/current/zookeeperOver.html"},
      {title:"Hello Interview — Job Scheduler (coordination)",url:"https://www.hellointerview.com/learn/system-design/problem-breakdowns/job-scheduler"},
    ]},
    {title:"At-least-once vs exactly-once execution",tag:"durability",turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a job charges a customer $50. It's enqueued, a worker picks it up, runs the charge, but crashes before acking the queue. The message reappears and another worker runs it — the customer is charged <b>twice</b>. You promised at-least-once. How do you keep the guarantee useful?</span>"},
      {who:"cand",text:"I'll be blunt about the theory first: true <strong>exactly-once execution</strong> across independent failure domains is impossible — you cannot atomically both run a side effect and record that you ran it. So I commit to <strong>at-least-once delivery plus idempotent execution</strong>, which gives exactly-once <em>effects</em>, which is what the customer actually cares about. The redelivery you described is correct behavior; the fix is making the second run a no-op."},
      {who:"intv",text:"Concretely, how does the second run of that charge become a no-op?"},
      {who:"cand",text:"Every execution carries a stable <strong>idempotency key</strong> — the job id plus the run's scheduled time (so run N and run N+1 of a cron job differ).<span class='eg'>execution_id = jobId + ':' + scheduledFireTime; the charge service records that id and refuses a second charge for the same id.</span>The effect is deduplicated at the <strong>side-effecting boundary</strong>: the worker passes the key to the downstream (payment API, DB write) which does an insert-if-absent on that key. So even if the job runs three times, the money moves once. I push idempotency to where the effect lands because that's the only place it can be truly enforced."},
      {who:"intv",text:"Not every downstream supports idempotency keys. What's your fallback, and what do you tell users?"},
      {who:"cand",text:"Where I control the downstream, I use the key. Where I don't, I offer a best-effort dedup layer — a <strong>processed-executions table</strong> the worker checks-and-sets before running: if the execution id is already marked done, skip. It shrinks the double-run window to the gap between doing the effect and recording it, but can't eliminate it for a non-idempotent external call. So the contract I document is explicit: the platform guarantees at-least-once, and job authors <strong>must make handlers idempotent</strong> — the same execution id may be delivered more than once. That honesty is better than pretending exactly-once and quietly double-charging someone."},
    ],resources:[
      {title:"Idempotence",url:"https://en.wikipedia.org/wiki/Idempotence"},
      {title:"Hello Interview — Job Scheduler (execution semantics)",url:"https://www.hellointerview.com/learn/system-design/problem-breakdowns/job-scheduler"},
    ]},
    {title:"A million jobs due at midnight — hot polling and thundering herd",tag:"scaling",turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> of your <b>100M</b> jobs, humans love round numbers, so <b>1M</b> are cron jobs due at exactly 00:00:00. At midnight the due-scan returns a million rows in one tick, the job store gets hammered by polling, and a wall of tasks hits your workers at once. Everything spikes. Fix the herd.</span>"},
      {who:"cand",text:"Two distinct problems: the <strong>hot due-scan</strong> on the store and the <strong>execution thundering herd</strong>. For the scan, I never do a naive full-table poll — I keep a tight <strong>index on <code>next_run_at</code></strong> and read a bounded window, and I move the hottest tier into a <strong>time-bucketed delay structure</strong>: a <strong>Redis sorted set</strong> scored by fire time, so finding due jobs is an O(log n) range pop rather than a DB scan.<span class='eg'>ZRANGEBYSCORE due 0 now — pop just what's due, no scanning of the other 99M.</span>The scheduler polls that small structure frequently and only touches the durable store for state transitions."},
      {who:"intv",text:"Even if you find the million jobs efficiently, they're all due at the same instant. Do a million things really have to fire in second zero?"},
      {who:"cand",text:"Almost never — and this is the key insight. A job scheduled for midnight rarely needs millisecond precision; it needs to run <em>around</em> midnight. So I <strong>spread the herd with jitter</strong>: when computing next_run_at for popular cron times, I add a small random offset within a tolerance window — a few seconds to a couple of minutes depending on the job's SLA — so a million midnight jobs smear across a window instead of stacking on one tick.<span class='eg'>next_run_at = 00:00:00 + rand(0, 120s), so ~8K/s over two minutes instead of 1M in one second.</span>That alone converts a spike into a manageable stream. For jobs that genuinely need exact timing, I don't jitter, but those are rare."},
      {who:"intv",text:"Suppose after jitter you still have a sustained burst bigger than the workers can drain. What keeps the system stable rather than collapsing?"},
      {who:"cand",text:"The <strong>task queue is the shock absorber</strong>. The scheduler enqueues at whatever rate work comes due; workers consume at their sustainable rate; the difference just becomes queue depth, which is fine and self-draining. I <strong>autoscale the worker pool</strong> on queue depth so capacity follows load, and I partition the scheduler so the scan itself scales horizontally. If depth grows unboundedly I apply <strong>backpressure</strong> — throttle lower-priority jobs and let the queue buffer — rather than dropping work. So the herd is handled by three compounding moves: cheap due-discovery (sorted set), spreading the arrival (jitter), and absorbing the remainder (queue + autoscaling). Peak store and worker load become quantities I set, not functions of how many jobs picked midnight."},
    ],resources:[
      {title:"Redis sorted sets",url:"https://redis.io/docs/latest/develop/data-types/sorted-sets/"},
      {title:"Hello Interview — Job Scheduler (scaling)",url:"https://www.hellointerview.com/learn/system-design/problem-breakdowns/job-scheduler"},
      {title:"System Design Primer — asynchronism",url:"https://github.com/donnemartin/system-design-primer"},
    ]},
    {title:"A worker dies mid-execution — lost or run twice?",tag:"failover",turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a worker dequeues job 42, transitions it to <code>running</code>, starts a 3-minute data export, and at minute two the pod is SIGKILLed. The job never finished and never acked. Is job 42 lost forever, or does it silently run twice? Walk me through what happens.</span>"},
      {who:"cand",text:"Neither, if the queue uses a <strong>visibility timeout</strong> instead of deleting on dequeue. When the worker pulled job 42, the message wasn't removed — it was made <em>invisible</em> for a lease period. The worker must <strong>ack</strong> to delete it on success. Because the worker died without acking, the visibility timeout expires and the queue <strong>re-delivers</strong> job 42 to another worker. So the job is not lost — that's the at-least-once guarantee doing its job. It may run partially twice, which is exactly why handlers must be idempotent with the execution id."},
      {who:"intv",text:"Your export takes 3 minutes but the visibility timeout is 30 seconds. It re-delivers while the first worker is still alive and working. Now two workers run it concurrently. Fix that without just cranking the timeout to hours."},
      {who:"cand",text:"A fixed long timeout is bad — a genuine crash then leaves the job stuck for hours. Instead the worker <strong>heartbeats to extend its lease</strong> while it works: every few seconds it renews the visibility timeout, proving it's alive.<span class='eg'>lease starts at 30s; worker calls extend-lease every 10s; if the worker dies, no more extensions, lease lapses in ~30s and the job re-delivers.</span>So a long-running job holds its lease as long as it's healthy, and a dead worker releases it promptly. I also set a hard <strong>execution timeout</strong> — if a job blows past a max runtime it's killed and treated as failed for retry, so a wedged handler can't hold a lease forever."},
      {who:"intv",text:"On restart, the crashed worker's job re-runs — but what about jobs that were due <em>during</em> a broader outage, say the whole scheduler was down for 10 minutes? Are those just missed?"},
      {who:"cand",text:"No — this is why the durable store, not the queue, is the source of truth for what's due. On recovery the scheduler <strong>scans for overdue jobs</strong>: any row with <code>next_run_at &lt; now</code> still in <code>pending</code> is due and simply gets enqueued now, a little late but not lost. Missing a fire time degrades timeliness, not durability. For each such job I decide by policy whether to <strong>run every missed occurrence or just the latest</strong> — for a report you might skip catch-up and run once; for billing you run each. Because next_run_at lives in the durable store and the scan is idempotent, a scheduler outage becomes a bounded lateness on restart, never a silently dropped execution."},
    ],resources:[
      {title:"Kafka documentation — delivery semantics",url:"https://kafka.apache.org/documentation/"},
      {title:"Hello Interview — Job Scheduler (worker failure)",url:"https://www.hellointerview.com/learn/system-design/problem-breakdowns/job-scheduler"},
      {title:"Idempotence",url:"https://en.wikipedia.org/wiki/Idempotence"},
    ]},
  ],
  q:{
    client:[
      {l:"easy",tag:"concept",q:"What does the client send on submit, and how does it query status?",turns:[
        {who:"intv",text:"A user submits run this export at 14:00 and later checks on it. What does the client actually send, and how does it track the job afterward?"},
        {who:"cand",text:"On submit the client sends a job definition — a handler id or target, a payload, and a schedule (a run-at time or a cron expression) — and gets back a <strong>job id</strong>. It stores that id and uses it for everything after: <span class='eg'>GET /jobs/{id} returns status (pending / queued / running / success / failed), next_run_at, and recent run history.</span>The client is a <strong>view</strong> of server truth — it never assumes a job ran; it reads the authoritative state from the job store via the API. For recurring jobs it shows the last few executions and the next scheduled fire time."},
        {who:"intv",text:"How does the user know an execution actually happened without polling constantly?"},
        {who:"cand",text:"Two options depending on the use case. For dashboards, the client polls the status endpoint at a relaxed interval — status changes are not urgent to display. For programmatic consumers I prefer <strong>completion callbacks / webhooks</strong>: when a job reaches a terminal state the system posts to a user-supplied URL, so they learn of success or failure without polling at all. Either way the truth is the job store's execution history; the client just surfaces it. Polling is a convenience, not a correctness mechanism."},
      ],resources:[
        {title:"Hello Interview — Job Scheduler",url:"https://www.hellointerview.com/learn/system-design/problem-breakdowns/job-scheduler"},
      ]},
      {l:"medium",tag:"scaling",q:"A batch client submits a flood of jobs — protect the API.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> an automated client submits <b>50K</b> jobs in a burst (someone backfilling a year of scheduled reports), each a separate POST. That's a spike far above steady-state submit rate. How does the client side avoid melting your API?</span>"},
        {who:"cand",text:"Two levers. First, offer a <strong>batch submit</strong> endpoint so 50K jobs arrive as a handful of bulk requests instead of 50K round trips — one durable write of many rows, far less per-request overhead. Second, the client should respect <strong>rate-limit responses</strong>: when the API returns <code>429</code>, back off with jitter and retry rather than hammering. A well-behaved client submits at a sustainable rate; a misbehaving one gets throttled at the edge. The submit path is a write to the durable store, so I want it bounded and batched, not a firehose of tiny writes."},
        {who:"intv",text:"If the batch is huge, does the client wait for all 50K to be durably stored before it gets an ack?"},
        {who:"cand",text:"For very large batches I make submit <strong>asynchronous</strong>: the API accepts the batch, writes it to a durable intake, and returns a <strong>batch id</strong> immediately with status <code>accepted</code>. The client then polls the batch id to see how many were validated and scheduled. This keeps the request fast and bounded regardless of batch size, and the durability guarantee is preserved because the intake write is durable before the ack. The client treats the batch id like a receipt — the work is safely captured even before every individual job is fully materialized."},
      ],resources:[
        {title:"System Design Primer — rate limiting",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"ByteByteGo",url:"https://bytebytego.com/"},
      ]},
      {l:"medium",tag:"failover",q:"Submit request times out — was the job created?",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> the client POSTs a job, the network stalls, and after 10s the client times out with no response. The user has no idea whether the job was created. They hit submit again. How do you avoid creating the same job twice?</span>"},
        {who:"cand",text:"The client attaches a <strong>client-generated idempotency key</strong> to the submit and reuses the <em>same</em> key on retry. So the retry is safe: if the first request actually reached the API and created the job, the server recognizes the key and returns the <em>same</em> job id rather than creating a duplicate. The user ends up with exactly one scheduled job no matter how many times the flaky network makes them retry. Without this, timeouts on a write path silently create duplicate jobs — which for a payment cron would mean double-charging."},
        {who:"intv",text:"How long does the server remember that idempotency key, and what if the retry comes much later?"},
        {who:"cand",text:"The server persists the key alongside the created job with a retention window — say 24 hours — long enough to cover any realistic retry. Within that window a repeat key returns the original job id; after it, the key is forgotten and a repeat would create a new job, which is acceptable because a retry days later is really a new intent. For safety I make the dedup a <strong>unique constraint on the idempotency key</strong> in the store, so even two concurrent retries racing can't both insert — one wins, the other reads back the existing job. Correctness doesn't depend on timing luck."},
      ],resources:[
        {title:"Idempotence",url:"https://en.wikipedia.org/wiki/Idempotence"},
        {title:"Hello Interview — Job Scheduler",url:"https://www.hellointerview.com/learn/system-design/problem-breakdowns/job-scheduler"},
      ]},
      {l:"medium",tag:"capacity",q:"How much status-polling load do clients generate?",turns:[
        {who:"intv",text:"Put rough numbers on the client side. With 100M jobs registered and clients watching status, how much traffic does the client tier drive, and what does that imply?"},
        {who:"cand",text:"Reads dominate, and by a lot. Submits and executions are modest, but every dashboard and programmatic watcher polls for status.<span class='eg'>say 1M jobs are actively watched and each is polled every 5s &rarr; 200K status reads/s, versus ~10K executions/s and a trickle of submits &mdash; status traffic is ~20x the write path.</span>So the client-facing load is a read-amplification problem: a naive design where everyone polls constantly would size the whole system around dashboard refreshes, not real work."},
        {who:"intv",text:"So do you just let them poll, or push updates? What's the trade-off?"},
        {who:"cand",text:"Polling is dead simple and needs no delivery infrastructure, but it burns read capacity proportional to watcher count regardless of whether anything changed. Push via completion webhooks costs a callback-delivery mechanism with retries, but a job changes state only a handful of times in its life, so it sends far fewer messages. Given status changes are rare and reads are ~20x writes, I decide: <strong>webhooks for programmatic consumers</strong> so they learn of terminal states without polling, and <strong>relaxed, rate-capped polling</strong> for human dashboards where a second of staleness is harmless. That collapses the 200K/s into something an order of magnitude smaller."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"Hello Interview — Job Scheduler",url:"https://www.hellointerview.com/learn/system-design/problem-breakdowns/job-scheduler"},
      ]},
    ],
    api:[
      {l:"medium",tag:"concept",q:"What does the Job API own beyond a thin CRUD layer?",turns:[
        {who:"intv",text:"You drew a Job API box. Beyond writing rows, what does it actually own — especially for a cron submission?"},
        {who:"cand",text:"It owns the edge concerns and the correctness of what enters the store: authentication, <strong>validation</strong>, idempotency, and rate limiting. For a cron job the critical piece is <strong>validating the cron expression</strong> and computing the first <code>next_run_at</code> before persisting — a malformed spec should be rejected at submit, not discovered by the scheduler at 3am.<span class='eg'>parse 0 0 * * *, confirm it's valid, compute the next fire time, reject garbage like 99 * * * * with a 400.</span>It also enforces limits — max frequency, payload size — so no single job can, say, ask to run every millisecond."},
        {who:"intv",text:"Where does the API stop and the scheduler begin? Why not let the API also trigger execution?"},
        {who:"cand",text:"Clean separation of concerns. The API is the <strong>synchronous, user-facing write path</strong> — it validates and durably records intent, then returns. The <strong>scheduler</strong> is the asynchronous engine that later acts on that recorded intent by finding due jobs. Keeping them apart means submit latency is independent of execution load: a midnight execution storm never slows down a user submitting a new job, and vice versa. The API's contract is simply if I acked, your job is durably scheduled — everything about <em>when and how</em> it runs is downstream."},
      ],resources:[
        {title:"Cron",url:"https://en.wikipedia.org/wiki/Cron"},
        {title:"Hello Interview — Job Scheduler",url:"https://www.hellointerview.com/learn/system-design/problem-breakdowns/job-scheduler"},
      ]},
      {l:"medium",tag:"scaling",q:"Submit and status traffic spikes — scale the API tier.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> status-query traffic is <b>100x</b> your submit traffic — dashboards and webhooks-checkers polling job state constantly, tens of thousands of reads/s, while submits are a trickle. How do you scale the API so reads don't starve writes?</span>"},
        {who:"cand",text:"Split the read and write paths so they scale independently. The API tier is <strong>stateless</strong>, so I scale it horizontally behind a load balancer freely. Status reads are the bulk and are cache-friendly — a job's status changes at most a few times in its life — so I serve them from <strong>read replicas</strong> of the job store and a short-TTL cache, keeping the write-primary reserved for submits and the scheduler's state transitions. Reads being slightly stale (a status a second behind) is harmless for a dashboard. So the 100x read load lands on replicas and cache, never contending with the durable write path."},
        {who:"intv",text:"Status reads and the scheduler's due-scan both hit the job store. Do they compete?"},
        {who:"cand",text:"They shouldn't, and I keep them apart deliberately. Status reads go to <strong>read replicas</strong>; the scheduler's due-scan and state writes go to the <strong>primary</strong> (or to the dedicated sorted-set index for the hot tier). Because status reads tolerate staleness they're a perfect replica workload, while the scheduler needs current state to claim jobs, so it reads authoritative. Routing them to different nodes means a dashboard-refresh storm can't slow down finding-and-firing due jobs — the timely-execution requirement is protected from read load."},
      ],resources:[
        {title:"System Design Primer — scaling reads & replicas",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"ByteByteGo",url:"https://bytebytego.com/"},
      ]},
      {l:"medium",tag:"failover",q:"The API acks a submit but the store write didn't commit — durability hole?",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> under load your API returns <code>201 Created</code> to <b>5K</b> submitting clients, but a subset of those writes were only in a buffer and the store node crashed before flushing them. Those jobs are gone but users think they're scheduled. That violates durability. Close the hole.</span>"},
        {who:"cand",text:"The bug is acking before the write is durable. The rule is <strong>never return success until the job is committed to durable, replicated storage</strong>. Concretely the API waits for the store to confirm a <strong>quorum-acknowledged write</strong> — a majority of replicas have it on durable media — before sending <code>201</code>. Yes, that adds a few milliseconds to submit, but durability is the whole promise of this system; a job I acked must survive a node loss. I'd rather a slightly slower submit than a job that silently evaporates."},
        {who:"intv",text:"If the store is briefly unavailable and can't confirm the durable write, what does the API return?"},
        {who:"cand",text:"I <strong>fail closed</strong> on submit — return a <code>503</code> and do <em>not</em> ack, so the client retries (safely, using its idempotency key) rather than believing a job exists that doesn't. This is the opposite of a status read, where I'd happily serve slightly stale data; on the write path I never trade durability for availability. Optionally I front submits with a durable, replicated intake log so I can accept the write even if the main store is momentarily slow — but I still only ack once <em>something</em> durable holds the job. The invariant is simple: an ack is a durability guarantee, never a hope."},
      ],resources:[
        {title:"System Design Primer — availability & consistency",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"Hello Interview — Job Scheduler",url:"https://www.hellointerview.com/learn/system-design/problem-breakdowns/job-scheduler"},
      ]},
      {l:"medium",tag:"capacity",q:"How many Job API instances at peak? Show the math.",turns:[
        {who:"intv",text:"Concrete numbers. Between submits and status queries, how many <strong>Job API instances</strong> do you run at peak? Show me the sizing, don't just say autoscale."},
        {who:"cand",text:"The API is stateless and CPU-light &mdash; authenticate, validate, one store read or write, serialize &mdash; so a modern 4-core instance handles on the order of <strong>~5,000 req/s</strong> at low latency (I'd confirm by load test).<span class='eg'>peak status reads ~100K/s + submits ~2K/s &asymp; 102K req/s; 102K &divide; 5K &asymp; 21 instances; +30% headroom &rarr; ~27, spread across &ge;3 AZs so losing one drops ~1/3 of capacity, not the service.</span>The count is dominated by reads, not the write path."},
        {who:"intv",text:"27 feels heavy for what's mostly a status lookup. What cuts it?"},
        {who:"cand",text:"The number assumes every status read reaches the API. It shouldn't: status is cache-friendly and tolerates staleness, so I serve it from <strong>read replicas plus a short-TTL cache</strong> and keep the write-primary for submits and the scheduler's transitions. The trade-off is provisioning for a cold cache (cost) versus autoscale lag when a cache flush suddenly lands read load on the fleet (risk). I decide: size the fleet to survive submits plus miss traffic &mdash; low-tens, not driven by dashboard polling &mdash; keep a warm floor of a handful of instances, and autoscale above it on request rate."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"ByteByteGo",url:"https://bytebytego.com/"},
      ]},
    ],
    jobdb:[
      {l:"medium",tag:"concept",q:"Model the job store schema and the state machine.",turns:[
        {who:"intv",text:"Pick your datastore for jobs and defend the schema. Give me the row model and how a job moves through its life."},
        {who:"cand",text:"I want a <strong>durable, strongly-consistent</strong> store for the source of truth — a relational DB or a store with conditional writes — because state transitions must be atomic to prevent double-claims. The core table is keyed by job id: definition (handler, payload), schedule (a run-at or cron expression), <code>status</code>, <code>next_run_at</code>, <code>attempt</code>, an <strong>owner/lease</strong> field, and timestamps. Execution history lives in a separate <code>runs</code> table (one row per attempt) so I keep an audit trail.<span class='eg'>status transitions: pending &rarr; queued &rarr; running &rarr; success | failed; failed with attempts left &rarr; pending; failed exhausted &rarr; dead-letter.</span>"},
        {who:"intv",text:"Why keep run history in a separate table rather than just updating the job row?"},
        {who:"cand",text:"Because a recurring job runs thousands of times and users need to see <em>each</em> execution — when it ran, how long, success or failure, the error. If I overwrote the job row I'd lose history. So the job row holds <strong>current state and next fire time</strong> (the hot, mutable part the scheduler scans), and an append-only <strong>runs table</strong> holds the immutable log of every attempt (the cold, queryable part for monitoring). This split also keeps the hot due-scan index small — it only indexes live jobs by next_run_at, not the millions of historical runs. Hot state and cold history have different access patterns, so I store them separately."},
      ],resources:[
        {title:"Hello Interview — Job Scheduler (data model)",url:"https://www.hellointerview.com/learn/system-design/problem-breakdowns/job-scheduler"},
        {title:"System Design Primer — data model",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"hard",tag:"scaling",q:"100M jobs and a hot due-scan — index and shard the store.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> <b>100M</b> registered jobs, and the scheduler must find the ones due each second. A naive <code>SELECT WHERE next_run_at &le; now</code> scans the whole table every tick and pins the DB. Meanwhile writes for state transitions pile up. Make finding due jobs cheap at this scale.</span>"},
        {who:"cand",text:"First, an <strong>index on <code>next_run_at</code></strong> (with status), so the due-scan is a bounded range read — pull only jobs due in the next few seconds, ordered, not a scan of 100M rows. Second, for the hot near-term tier I front the store with a <strong>Redis sorted set scored by fire time</strong>: the scheduler pops due jobs in O(log n) and only writes state transitions back to the durable store.<span class='eg'>ZRANGEBYSCORE due -inf now to pop, then persist the queued transition — the durable store isn't in the tight polling loop.</span>Jobs far in the future don't sit in the hot structure at all — they're loaded in as their fire time approaches."},
        {who:"intv",text:"One store node can't hold 100M jobs and take all the transition writes. How do you shard, and how does that interact with the scheduler?"},
        {who:"cand",text:"I <strong>shard by job id</strong> (hash) so the 100M jobs and their writes spread across many nodes, and I align that with the <strong>scheduler's partitioning</strong>: each scheduler owns a set of shards and scans only those. That makes finding-due-work embarrassingly parallel — no single scanner and no single hot shard. A single-row conditional claim stays cheap per shard. The one thing sharding-by-id doesn't help is a temporal hotspot (everything due at midnight), but that's solved separately by jitter spreading fire times. So id-sharding scales capacity and throughput, and jitter flattens the time axis — the two are orthogonal and both needed."},
      ],resources:[
        {title:"System Design Primer — sharding",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"Redis sorted sets",url:"https://redis.io/docs/latest/develop/data-types/sorted-sets/"},
      ]},
      {l:"hard",tag:"durability",q:"A store node dies — are scheduled jobs lost?",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> the node holding a shard has a disk failure and won't come back. That shard held the definitions and next-run times for millions of jobs — including a customer's daily billing run. Are those jobs gone? Give me your durability story.</span>"},
        {who:"cand",text:"If a shard were a single node, losing it would silently stop millions of jobs from ever firing again — a catastrophic, invisible failure. So every shard is a <strong>replica group</strong> (e.g. 3 replicas across AZs) with <strong>synchronous quorum-acknowledged writes</strong>: a submit or a state transition isn't acked until a majority of replicas hold it durably. A single disk failure loses nothing — surviving replicas have every job, and a fresh replica rebuilds from them. This is why the API waits for the durable quorum ack before telling the user their job is scheduled: the durability promise is enforced at the store's write path."},
        {who:"intv",text:"Quorum writes add latency to every state transition, and the scheduler does a lot of them. Justify the cost."},
        {who:"cand",text:"I'll pay it because losing a job is worse than a slightly slower transition, and a quorum write is only a few milliseconds — negligible against a job's schedule granularity of seconds. Where I optimize is by <strong>keeping the durable writes coarse</strong>: the hot polling loop runs against the in-memory sorted set, and I persist transitions in batches where safe, so I'm not doing a quorum round-trip on every tick for every job. The definition and terminal states go through durable quorum; the ephemeral in-flight bookkeeping can be cheaper. So durability is scoped tightly to what must survive — the job's existence and its committed outcomes."},
      ],resources:[
        {title:"System Design Primer — replication",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"Hello Interview — Job Scheduler (durability)",url:"https://www.hellointerview.com/learn/system-design/problem-breakdowns/job-scheduler"},
      ]},
      {l:"hard",tag:"failover",q:"The store primary fails mid-scan — promote without losing claims.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> the write-primary for a shard crashes while the scheduler is actively claiming due jobs. You promote a replica. Two minutes later the old primary rejoins, still thinking it's primary. Now two nodes could accept job-state writes. What breaks and how do you prevent it?</span>"},
        {who:"cand",text:"This is <strong>split-brain</strong>, and here it means two primaries could each claim job 42 to a different scheduler — a double-fire that survives as two executions. Prevention is <strong>consensus-based promotion</strong>: leader election (Raft/Paxos or the coordinator) grants a monotonically increasing <strong>epoch</strong>. The promoted primary writes under a higher epoch; when the stale old primary rejoins, replicas <strong>reject its writes via the fencing token</strong> and it demotes and re-syncs. There's never a window where two nodes hold the current epoch, so a job is never claimed by two authorities."},
        {who:"intv",text:"During the election window, transitions on that shard pause. Jobs due right then are late. Acceptable?"},
        {who:"cand",text:"Yes — it's the CAP call, and I choose <strong>consistency over availability for writes</strong> during the partition. A few seconds of paused claiming on that shard means those jobs fire a few seconds late, which is a timeliness blip, not a correctness failure — and the durable <code>next_run_at</code> means they'll all still fire on recovery via the overdue scan. Double-firing a billing job, by contrast, is unacceptable. So I pause, elect, fence, resume. Reads (status queries) stay up from replicas throughout. Late-but-correct beats fast-but-double-fired, and using a managed store that does this fencing internally is a strong reason not to hand-roll failover."},
      ],resources:[
        {title:"Leader election",url:"https://en.wikipedia.org/wiki/Leader_election"},
        {title:"System Design Primer — consistency & availability",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"hard",tag:"capacity",q:"Size the job store — storage and nodes for 100M jobs plus run history.",turns:[
        {who:"intv",text:"Size the job store. 100M registered jobs with small definitions, plus a run record for every execution. How much storage, and how many nodes do you provision?"},
        {who:"cand",text:"Two datasets with different growth. The job rows are small and bounded by the catalog; the run history grows with executions and dominates.<span class='eg'>jobs: 100M &times; ~2KB (def + payload + state) &asymp; 200GB. runs: 10K exec/s &asymp; 860M runs/day; retain 30 days &asymp; 26B rows &times; ~300B &asymp; ~8TB. With replication factor 3 &rarr; jobs ~0.6TB, runs ~24TB; at ~2TB usable/node &rarr; ~12 nodes, essentially all for history.</span>Throughput is ~10K exec/s each doing a few state writes, so tens of thousands of writes/s &mdash; well within that node count."},
        {who:"intv",text:"That's sized to keep 30 days of history hot forever. Wasteful?"},
        {who:"cand",text:"Yes, and history is the cheap part to move. The <strong>hot</strong> dataset the scheduler scans is only the live jobs indexed by <code>next_run_at</code> &mdash; a few hundred GB &mdash; and that's what needs fast, replicated, strongly-consistent storage. The append-only run history is cold, queried only for monitoring, so I <strong>tier</strong> it: recent runs on the fast cluster, older ones aged to cheaper object storage with a slower lookup path. The trade-off is added complexity and a latency cliff for old-run queries, which I accept because old runs are rarely read. That cuts the hot cluster several-fold and lets retention/TTL reclaim space automatically."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"Hello Interview — Job Scheduler (data model)",url:"https://www.hellointerview.com/learn/system-design/problem-breakdowns/job-scheduler"},
      ]},
      {l:"hard",tag:"concept",q:"Pick the job-store DB: Postgres vs Cassandra vs DynamoDB, with load and node math.",turns:[
        {who:"intv",text:"Choose the datastore for the job store and defend it with numbers. Start by pinning the load it actually has to take."},
        {who:"cand",text:"Three quantities drive it. <strong>Writes:</strong> 10K executions/s each doing ~3-4 state transitions (pending &rarr; queued &rarr; running &rarr; terminal) plus a run-record insert &rarr; roughly <strong>40-50K writes/s</strong> steady, and a midnight herd of 1M jobs briefly multiplies that. <strong>Reads:</strong> the hot one isn't a point lookup, it's the <strong>due-scan every ~1s</strong> asking for jobs with <code>next_run_at &le; now</code> across 100M rows. <strong>Access shapes:</strong> point r/w by <code>job_id</code>, a <strong>range scan on <code>next_run_at</code></strong>, and an <strong>atomic conditional claim</strong> (flip pending &rarr; queued only if still pending). The conditional claim is the correctness-gating operation, so whatever I pick must do it cheaply and consistently."},
        {who:"intv",text:"Now give me the three candidates with a rough per-node throughput ceiling and the node count each implies."},
        {who:"cand",text:"<strong>Postgres:</strong> a single primary tops out around <strong>10-20K write/s</strong> before WAL/lock contention bites; native btree index on next_run_at and a first-class <code>UPDATE ... WHERE status = 'pending'</code> conditional claim.<span class='eg'>50K write/s &divide; ~15K per primary &asymp; 3-4 write shards (each a replica group); reads served from the next_run_at index + replicas.</span><strong>Cassandra:</strong> LSM writes are cheap, ~<strong>20-50K write/s per node</strong>.<span class='eg'>50K &divide; ~30K &asymp; 2-3 nodes for raw writes, but the due-scan has no cheap global range on next_run_at and its LWT conditional claim needs a Paxos round &asymp; 4x a normal write.</span><strong>DynamoDB:</strong> managed and elastic, but a single partition caps at <strong>~1K WCU / 3K RCU</strong>.<span class='eg'>50K write/s &rarr; needs ~50+ well-spread partitions; a next_run_at GSI concentrates the midnight due-window onto few time-keys &rarr; a hot partition exactly when load peaks.</span>"},
        {who:"intv",text:"Drill into indexing. Why is the next_run_at index the whole ballgame, and what does it cost?"},
        {who:"cand",text:"Without it the due-scan is a <strong>full scan of 100M rows every second</strong> &mdash; the DB does ~100M row-reads/tick just to find the few thousand that are due, saturating IO and starving the transition writes. That's fatal: the one query the scheduler runs constantly would be the most expensive. With a <strong>btree index on <code>next_run_at</code></strong> (ideally a <em>partial</em> index over live statuses, or a <strong>time-bucketed</strong> key) the due-scan becomes a <strong>bounded range read</strong> &mdash; seek to now, read forward a few thousand ordered rows, stop.<span class='eg'>indexed due-scan touches ~10K rows/tick, not 100M &mdash; four orders of magnitude cheaper.</span>The cost is write amplification: every insert and every next_run_at change updates the index too, so a state transition is 2 writes not 1 &mdash; that's why I keep run-history out of this index and only index the small set of live jobs."},
        {who:"intv",text:"So commit to one and say why the others lose."},
        {who:"cand",text:"<strong>Decision: a strongly-consistent relational store &mdash; Postgres now, NewSQL like CockroachDB as it outgrows a handful of shards.</strong> It does my two hot paths natively: the <code>next_run_at</code> range index and the atomic conditional claim, both with strong consistency, and 40-50K write/s fits in ~3-4 sharded replica groups (shard by <code>job_id</code>, aligned with the scheduler's partitions), with a Redis sorted set fronting the tight polling loop so the DB isn't scanned every tick. <strong>Cassandra loses</strong> because the conditional claim (LWT) is expensive and there's no cheap range on next_run_at &mdash; it optimizes the write volume I don't struggle with and penalizes the claim I depend on. <strong>DynamoDB loses</strong> because the next_run_at GSI creates a midnight hot partition &mdash; the failure mode lands exactly at peak. Raw write-scale would flip me to Cassandra/Dynamo, but here correctness (the atomic claim) and the cheap due-scan decide it, so consistency wins over write-scale."},
      ],resources:[
        {title:"Hello Interview — Job Scheduler (data model)",url:"https://www.hellointerview.com/learn/system-design/problem-breakdowns/job-scheduler"},
        {title:"Use The Index, Luke — range scans",url:"https://use-the-index-luke.com/"},
        {title:"System Design Primer — data model",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
    ],
    worker:[
      {l:"medium",tag:"concept",q:"How does a worker execute a task safely — lease, run, ack?",turns:[
        {who:"intv",text:"A worker pulls a task off the queue. Walk me through exactly how it runs the job and reports back, and where idempotency comes in."},
        {who:"cand",text:"The worker dequeues a task with a <strong>visibility-timeout lease</strong>, transitions the job to <code>running</code>, and executes the handler with the job's payload and its <strong>execution id</strong> (job id + scheduled fire time). On success it writes <code>success</code>, appends a run record, and <strong>acks</strong> the queue to delete the message. On failure it records the error and schedules a retry. The execution id is the key to idempotency: the worker passes it to any side-effecting downstream so a re-delivered task produces the same effect once.<span class='eg'>charge(executionId, amount) — the payment service dedups on executionId, so a retry is a no-op.</span>"},
        {who:"intv",text:"Why lease-then-ack rather than just deleting the task when you dequeue it?"},
        {who:"cand",text:"Because delete-on-dequeue is <strong>at-most-once</strong> — if the worker crashes after dequeuing, the job is gone forever, violating durability. Lease-then-ack is <strong>at-least-once</strong>: the message stays (invisible) until the worker proves completion by acking, so a crash mid-run means the lease lapses and the job re-delivers to another worker. I deliberately choose the semantics where a failure causes a <em>re-run</em> (harmless with idempotency) over one where a failure causes a <em>lost execution</em> (unrecoverable). Losing a scheduled job is the one thing this system must never do."},
      ],resources:[
        {title:"Kafka documentation — consumer semantics",url:"https://kafka.apache.org/documentation/"},
        {title:"Idempotence",url:"https://en.wikipedia.org/wiki/Idempotence"},
      ]},
      {l:"medium",tag:"scaling",q:"10K executions/s with uneven job durations — size the pool.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> steady-state is <b>10K</b> executions/s, but job runtimes vary wildly — some finish in 10ms, some run for minutes. A naive fixed worker pool either idles or falls behind. How do you scale execution?</span>"},
        {who:"cand",text:"Workers are <strong>stateless consumers</strong> of the queue, so I <strong>autoscale the pool on queue depth and consumer lag</strong> — when the backlog grows, add workers; when it drains, scale in. Because dispatch is decoupled through the queue, capacity can track load without touching the scheduler or store. For the runtime variance I <strong>separate pools by workload class</strong> — a fast lane for short jobs and a separate lane for long-running jobs — so a handful of multi-minute exports don't head-of-line-block thousands of 10ms tasks waiting behind them."},
        {who:"intv",text:"How do you keep one tenant's giant batch from starving everyone else's jobs?"},
        {who:"cand",text:"Fairness and isolation. I <strong>partition queues by priority and/or tenant</strong> and give workers weighted attention, so one tenant flooding the system can't monopolize the whole pool — their tasks pile in their partition while others drain normally. I also enforce <strong>per-tenant concurrency limits</strong>. Combined with autoscaling, a big batch just means that tenant's lane runs at its cap and takes longer, rather than degrading the timeliness of every other job. The scarce resource is worker slots, so I schedule them fairly rather than first-come-first-served across tenants."},
      ],resources:[
        {title:"System Design Primer — asynchronism & queues",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"ByteByteGo",url:"https://bytebytego.com/"},
      ]},
      {l:"hard",tag:"durability",q:"A worker crashes mid-execution — job lost or resumed?",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a worker is 90 seconds into a job when its pod is OOM-killed. It never acked. Is that execution lost? And when it re-runs, how do you avoid the side effects from the first 90 seconds happening twice?</span>"},
        {who:"cand",text:"Not lost. The worker held the task under a <strong>visibility-timeout lease</strong> and never acked, so once the lease lapses the queue <strong>re-delivers</strong> the task to another worker — the at-least-once guarantee. The re-run risk is the first 90 seconds' side effects repeating. I handle that with <strong>idempotency keyed on the execution id</strong>: any effect the job produced carries that id, and the downstream dedups it, so replaying the whole job re-applies each effect at most once. For multi-step jobs I checkpoint completed steps keyed by execution id so a re-run <strong>skips already-done steps</strong> rather than redoing them."},
        {who:"intv",text:"What if the crash happened <em>after</em> the side effect but <em>before</em> writing success? The re-run redoes a non-idempotent action."},
        {who:"cand",text:"That's the fundamental gap — you can't atomically do an external effect and record it. My answer is to make the boundary idempotent wherever possible (execution id dedup at the downstream), and where the downstream truly can't dedup, to make the effect itself <strong>check-then-act on the execution id</strong>: record intent-to-do before the effect and confirmed-done after, so a re-run sees intent-without-confirmation and can query the downstream to learn the true outcome before re-doing. It shrinks but can't fully close the window for a non-idempotent external call — which is why the platform contract explicitly requires idempotent handlers. I don't pretend to give exactly-once where physics doesn't allow it."},
      ],resources:[
        {title:"Idempotence",url:"https://en.wikipedia.org/wiki/Idempotence"},
        {title:"Hello Interview — Job Scheduler (worker failure)",url:"https://www.hellointerview.com/learn/system-design/problem-breakdowns/job-scheduler"},
      ]},
      {l:"hard",tag:"failover",q:"A long job outlives its lease — premature re-delivery.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> visibility timeout is 60s but a legitimate job takes 5 minutes. At 60s the queue re-delivers it to a second worker while the first is still running — now two workers execute the same job concurrently. How do you fix this without setting a giant timeout that leaves crashed jobs stuck for ages?</span>"},
        {who:"cand",text:"The worker <strong>heartbeats to extend its lease</strong> while healthy. It starts with a modest visibility timeout (60s) and, as long as it's making progress, calls extend-lease periodically to renew it.<span class='eg'>renew every 20s; a healthy 5-minute job keeps extending; a crashed worker stops renewing and the lease lapses in ~60s, triggering re-delivery.</span>So a long job holds its lease exactly as long as it's alive, and a dead worker releases promptly — I get both timely re-delivery on crash and no premature double-run on a slow-but-healthy job."},
        {who:"intv",text:"A worker hangs — alive enough to keep heartbeating but wedged and making no progress. It holds the lease forever. Now what?"},
        {who:"cand",text:"That's why I also enforce a hard <strong>execution timeout / max runtime</strong> independent of the lease: if a job exceeds its allowed wall-clock, the worker (or a supervisor) <strong>kills it</strong> and marks it failed for retry, regardless of heartbeats. Heartbeating proves the <em>process</em> is alive; the execution timeout bounds how long the <em>job</em> may run. A wedged handler thus can't hold a slot forever — it's terminated, the lease releases, and the job either retries or, after exhausting attempts, lands in the dead-letter store for a human to look at. Two independent limits: liveness (heartbeat) and progress (max runtime)."},
      ],resources:[
        {title:"Kafka documentation — session & heartbeat",url:"https://kafka.apache.org/documentation/"},
        {title:"Hello Interview — Job Scheduler (leases)",url:"https://www.hellointerview.com/learn/system-design/problem-breakdowns/job-scheduler"},
      ]},
      {l:"medium",tag:"capacity",q:"How many workers for 10K executions/s? (Little's law)",turns:[
        {who:"intv",text:"Size the worker pool. Steady-state is 10K executions/s and jobs run for varying durations. How many workers, and how do you get the number?"},
        {who:"cand",text:"Little's law gives the concurrency I must sustain: in-flight = arrival rate &times; average duration.<span class='eg'>10K/s &times; ~2s average job &asymp; 20K concurrent executions. If a worker process handles ~50 concurrent IO-bound tasks &rarr; 20K &divide; 50 &asymp; 400 workers steady-state; provision ~1.5x for normal peaks &rarr; ~600.</span>That's the floor for the average; the tail of long jobs and bursts is what makes a fixed number wrong."},
        {who:"intv",text:"Durations vary wildly &mdash; some 10ms, some minutes. A fixed pool either idles or falls behind. So?"},
        {who:"cand",text:"Because workers are stateless queue consumers, I don't fix the pool &mdash; I <strong>autoscale on queue depth and consumer lag</strong>, using the Little's-law number only as a warm floor. The trade-off with a static pool is cost (over-provision for peak) versus lateness (under-provision and jobs fire late); autoscaling tracks load but lags a sudden spike. I also <strong>separate pools by duration class</strong> so multi-minute jobs don't head-of-line-block thousands of 10ms tasks. So: floor from Little's law, scale on backlog, isolate long jobs &mdash; capacity follows load instead of guessing it."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"ByteByteGo",url:"https://bytebytego.com/"},
      ]},
    ],
    scheduler:[
      {l:"medium",tag:"concept",q:"How does the scheduler find due jobs efficiently?",turns:[
        {who:"intv",text:"The scheduler's core job is finding which jobs are due right now. With millions of jobs, how do you do that without scanning everything every tick?"},
        {who:"cand",text:"I keep jobs indexed by fire time and only ever look at the near edge. The durable store has an <strong>index on <code>next_run_at</code></strong> so a due-scan is a bounded range read — jobs due in the next few seconds — not a full scan. For the hot tier I use a <strong>time-bucketed delay structure</strong>, a <strong>Redis sorted set scored by fire time</strong>, so the scheduler pops due jobs in O(log n).<span class='eg'>poll every second: ZRANGEBYSCORE due 0 now, claim each, enqueue it, then set next_run_at ahead (cron) or mark terminal (one-time).</span>Future jobs aren't in the hot set at all — they're pulled in as their fire time nears. Work per tick is proportional to what's actually due, not to the catalog size."},
        {who:"intv",text:"How does the scheduler avoid claiming a job that another scheduler is also scanning?"},
        {who:"cand",text:"Each job is claimed with an <strong>atomic conditional transition</strong> — flip <code>pending &rarr; queued</code> only if it's still <code>pending</code> — so exactly one scheduler wins the claim and the others' updates affect zero rows. On top of that, the coordinator gives each scheduler a <strong>disjoint partition</strong> of jobs so ideally no two even look at the same job. The conditional claim is the safety backstop for the brief overlap during a partition reassignment. Between partitioning (avoid contention) and the atomic claim (make contention safe), a job is enqueued exactly once per fire time."},
      ],resources:[
        {title:"Redis sorted sets",url:"https://redis.io/docs/latest/develop/data-types/sorted-sets/"},
        {title:"Hello Interview — Job Scheduler (finding due jobs)",url:"https://www.hellointerview.com/learn/system-design/problem-breakdowns/job-scheduler"},
      ]},
      {l:"hard",tag:"scaling",q:"Scan cost grows with 100M jobs — scale the scheduler.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> you grow to <b>100M</b> jobs and a single scheduler polling the due structure every second can't keep up — the tick takes longer than a second and jobs start firing late. Scale the scheduler out without double-firing.</span>"},
        {who:"cand",text:"Partition the work. The coordinator splits the job space into <strong>N partitions</strong> (by hash of job id or by shard) and assigns each to a scheduler instance, so each scans only its slice and they run fully in parallel. Add a scheduler, the coordinator rebalances partitions, throughput scales linearly. Because partitions are disjoint, two schedulers never scan the same job, so parallelism doesn't create double-fires. The per-partition hot structure (its own sorted set) keeps each scan bounded, and I size N so each tick comfortably finishes within its polling interval."},
        {who:"intv",text:"A temporal spike — a million jobs at midnight — lands unevenly. Does partitioning by id help there?"},
        {who:"cand",text:"Partitioning by id spreads jobs evenly by <em>identity</em> but not by <em>fire time</em>, so a midnight spike hits all partitions at once — it doesn't overload one partition, but it does mean every scheduler is busy simultaneously. Id-partitioning handles that fine because the load is spread across all of them. The remaining spike is flattened on the <em>time</em> axis by <strong>jitter</strong> — smearing popular cron times across a tolerance window — and absorbed by the <strong>queue</strong> downstream. So scheduler scaling (partition by id) and spike flattening (jitter + queue) are separate, complementary levers; I need both to hit timely execution at 100M jobs with a midnight herd."},
      ],resources:[
        {title:"System Design Primer — sharding & scaling",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"Hello Interview — Job Scheduler (scaling)",url:"https://www.hellointerview.com/learn/system-design/problem-breakdowns/job-scheduler"},
      ]},
      {l:"hard",tag:"durability",q:"The scheduler crashes for 10 minutes — are due jobs missed?",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a scheduler (owning some partitions) crashes and its standby takes ~10 minutes to fully take over. During that window, thousands of jobs became due. Are those executions lost, and how does the system recover them?</span>"},
        {who:"cand",text:"Not lost, because due-ness lives in the <strong>durable store</strong> (<code>next_run_at</code>), not in the scheduler's memory. On takeover the new owner does an <strong>overdue scan</strong>: any job with <code>next_run_at &lt; now</code> still in <code>pending</code> is due and simply enqueued now — a bit late but present. A scheduler outage degrades <strong>timeliness, not durability</strong>: jobs fire late by roughly the outage duration, then the backlog drains. The recovery path is identical to normal scanning; there's no special catch-up code, because the scan is naturally idempotent over the durable next_run_at."},
        {who:"intv",text:"For a cron job that should have fired 5 times during those 10 minutes, do you run it 5 times or once?"},
        {who:"cand",text:"That's a <strong>policy per job</strong>, and I make it explicit. Some jobs want <strong>catch-up / backfill</strong> — run every missed occurrence (e.g. a billing tick per period) — so on recovery I materialize each missed fire time and execute them, each with its own execution id so they're distinct and idempotent. Others want <strong>skip-to-latest</strong> — a cache-refresh job only needs to run once now, not five stale times — so I collapse missed runs into one. I default to skip-to-latest to avoid a thundering backlog, but let job authors opt into catch-up. Either way nothing is silently dropped; the choice is run-each vs run-latest, both driven off the durable schedule."},
      ],resources:[
        {title:"Cron",url:"https://en.wikipedia.org/wiki/Cron"},
        {title:"Hello Interview — Job Scheduler (recovery)",url:"https://www.hellointerview.com/learn/system-design/problem-breakdowns/job-scheduler"},
      ]},
      {l:"hard",tag:"failover",q:"Clock skew across schedulers — early or double fires.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> you run many schedulers on different hosts, and their clocks disagree by a few seconds. One host's clock is fast, so it thinks a job is due before it really is — or during a partition handoff two hosts with skewed clocks both decide a job is due. How do you keep timing correct across a fleet?</span>"},
        {who:"cand",text:"First, don't let wall-clock disagreements cause <strong>double-fires</strong> — that's the serious failure, and it's already prevented by the <strong>atomic conditional claim</strong> plus partition ownership: even if two hosts think a job is due, only one wins the <code>pending &rarr; queued</code> transition, and after a claim <code>next_run_at</code> is advanced so the job isn't due again. So skew can at worst make a job fire slightly early or late, never twice. For timing accuracy I keep hosts synced with <strong>NTP</strong> and treat the store's committed state, not any single host's clock, as the arbiter of what has already been enqueued."},
        {who:"intv",text:"A fast clock still fires a job seconds early. For a job that must not run before its time, how do you bound that?"},
        {who:"cand",text:"I make the <strong>store's authoritative timestamp</strong> the reference rather than the scheduler's local clock — the claim checks due-ness against the database's clock (or a logical time source), so all schedulers agree on now from one source of truth. I can also require that the fire time has passed by the store's clock at claim commit, rejecting a premature claim. For jobs with strict not-before semantics I add a small guard so a few seconds of residual skew errs on the side of firing slightly late, never early. The principle: coordinate timing through a shared authority (the store, NTP-disciplined), and lean on the atomic claim so that even worst-case skew is a small timing error, not a correctness violation."},
      ],resources:[
        {title:"Leader election",url:"https://en.wikipedia.org/wiki/Leader_election"},
        {title:"System Design Primer — consistency patterns",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"medium",tag:"capacity",q:"How many scheduler partitions to clear due jobs within the poll window?",turns:[
        {who:"intv",text:"Size the scheduler. It polls for due jobs on a ~1s tick. How many partitions or instances do you need so due jobs are cleared within the window, including the midnight burst?"},
        {who:"cand",text:"Steady-state is easy; the burst sets the number. Each scheduler pops due jobs from its partition's sorted set and does an atomic claim, so throughput is claims/s.<span class='eg'>steady ~10K due/s and one instance sustaining ~10K claims/s &rarr; 1-2 partitions. But 1M jobs land near midnight; smeared by jitter over a ~20s tolerance that's ~50K/s &rarr; 50K &divide; 10K &asymp; 5 partitions; round to ~6 with headroom so each tick finishes inside its 1s interval.</span>"},
        {who:"intv",text:"Why partition by job id for that, rather than by fire time?"},
        {who:"cand",text:"Partitioning by <strong>hash of job id</strong> spreads the 100M jobs and their scan work evenly and lets me align partitions with the store's shards. The alternative, partitioning by <em>time</em>, would concentrate the whole midnight tick into one partition &mdash; a self-inflicted hotspot. The trade-off is that id-partitioning means a temporal spike lights up every partition at once rather than one, but that's fine because the load is spread, not stacked. So I decide: partition by id for even parallel scanning, flatten the time axis separately with jitter, and size N so the worst-case tick still completes within the poll interval."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"Hello Interview — Job Scheduler (scaling)",url:"https://www.hellointerview.com/learn/system-design/problem-breakdowns/job-scheduler"},
      ]},
    ],
    queue:[
      {l:"medium",tag:"concept",q:"Why a queue between scheduler and workers, and what semantics?",turns:[
        {who:"intv",text:"You put a task queue between the scheduler and the workers. What does it buy you, and what delivery semantics do you configure?"},
        {who:"cand",text:"It <strong>decouples dispatch from execution</strong> and gives me durability across the handoff. The scheduler enqueues a due job and moves on; workers consume independently, so neither blocks the other and a worker slowdown just grows queue depth. I configure <strong>at-least-once delivery with a visibility timeout</strong>: a dequeued message is leased (invisible) until the worker acks, and re-delivered if the worker dies.<span class='eg'>enqueue task, worker leases with 60s visibility, acks on success to delete; no ack &rarr; redelivery.</span>The message itself is durable, so a task that's been enqueued survives even if all workers restart."},
        {who:"intv",text:"Kafka-style log or a classic message queue like SQS/RabbitMQ — which and why?"},
        {who:"cand",text:"For this workload I lean toward a queue with <strong>per-message ack and visibility timeout</strong> (SQS/RabbitMQ-style) because tasks are independent units I want to lease, ack, and redeliver individually, with easy dead-lettering — a log's per-partition offset model makes per-message redelivery and out-of-order completion awkward. A <strong>Kafka-style log</strong> shines when I want high-throughput ordered streams and replay, which is more useful for the change/event stream feeding monitoring than for the task-dispatch path. So: message-queue semantics for task dispatch, log semantics where I want durable ordered replay. The deciding factor is that dispatch needs independent per-task lease/ack, not ordering."},
      ],resources:[
        {title:"Kafka documentation",url:"https://kafka.apache.org/documentation/"},
        {title:"System Design Primer — asynchronism",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"hard",tag:"scaling",q:"Queue depth explodes at a spike — backpressure without loss.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a midnight herd enqueues <b>1M</b> tasks in a couple of minutes but workers can only drain <b>10K/s</b>. Queue depth balloons to hundreds of thousands. How do you keep the queue healthy and not lose tasks?</span>"},
        {who:"cand",text:"A deep queue is the system <em>working as designed</em> — the queue exists to absorb exactly this. Tasks are durable in the queue, so nothing is lost; they just wait. I <strong>autoscale workers on queue depth</strong> to drain faster, and I <strong>partition the queue</strong> so throughput scales horizontally rather than bottlenecking on one broker. The buffer converts an unbounded arrival spike into a bounded, drainable backlog — depth grows, then shrinks, and no work is dropped. The number I care about is drain time, which I keep within jobs' timeliness tolerance by scaling the pool."},
        {who:"intv",text:"If arrival keeps outpacing drain and depth grows without bound, memory or storage runs out. What then?"},
        {who:"cand",text:"I apply <strong>backpressure upstream</strong> rather than letting the queue collapse. The scheduler watches queue depth and, past a threshold, <strong>slows enqueueing of low-priority jobs</strong> — they stay <code>pending</code> in the durable store (their next_run_at simply passes and they're picked up when depth recovers) instead of piling into the queue. Priority partitions ensure urgent jobs still flow while best-effort ones wait. Because the durable store, not the queue, is the source of truth for due-ness, holding jobs back is safe — they're not lost, just deferred. So the queue has a bounded working set and the durable store holds the long tail, and backpressure ripples from the scarce resource (workers) outward."},
      ],resources:[
        {title:"System Design Primer — asynchronism & backpressure",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"ByteByteGo",url:"https://bytebytego.com/"},
      ]},
      {l:"hard",tag:"durability",q:"The queue loses in-flight tasks on a broker failure.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a queue broker node fails while holding <b>200K</b> enqueued-but-unprocessed tasks. If those messages were only in that node's memory, they're gone — 200K scheduled executions silently vanish. How do you make the queue itself durable?</span>"},
        {who:"cand",text:"Enqueued tasks must be <strong>durably persisted and replicated</strong> before the enqueue is considered done — the queue writes each message to disk and replicates to multiple brokers with quorum ack, so a single broker failure loses nothing and a replica takes over with the full backlog. But there's a stronger backstop specific to this system: the <strong>durable job store is the real source of truth</strong>. The queue is a dispatch buffer, not the record of what needs to run. So even if the queue lost messages, those jobs are still <code>queued</code>/<code>pending</code> in the store with a next_run_at, and the scheduler's overdue scan re-enqueues them."},
        {who:"intv",text:"So the queue is allowed to lose messages because the store can rebuild them? Isn't that wasteful reconciliation?"},
        {who:"cand",text:"I don't <em>rely</em> on it as the primary mechanism — I use a replicated, durable queue so message loss is rare. But designing the store as the authority makes the queue loss <strong>recoverable rather than catastrophic</strong>, which is the property I want for a durability-critical system. A job that was enqueued but whose queue message vanished shows up in the overdue scan (its state and next_run_at persisted) and gets re-dispatched — late, not lost. The reconciliation is cheap because it's the same scan the scheduler already runs. Defense in depth: durable queue as the fast path, durable store as the guarantee that no scheduled execution can ever truly disappear."},
      ],resources:[
        {title:"Kafka documentation — replication & durability",url:"https://kafka.apache.org/documentation/"},
        {title:"Hello Interview — Job Scheduler (durability)",url:"https://www.hellointerview.com/learn/system-design/problem-breakdowns/job-scheduler"},
      ]},
      {l:"medium",tag:"capacity",q:"How many task-queue partitions for throughput and the midnight burst?",turns:[
        {who:"intv",text:"Size the task queue. How many partitions do you provision for steady throughput and the midnight burst without it becoming the bottleneck?"},
        {who:"cand",text:"Size on peak drain, not average. Both enqueue and dequeue flow through it, and one partition/broker sustains a bounded throughput.<span class='eg'>steady ~10K msgs/s in and ~10K out; if a partition comfortably handles ~5K msgs/s &rarr; ~4 partitions steady. Midnight smeared by jitter is ~50K/s &rarr; 50K &divide; 5K &asymp; 10; round to ~12-16 for headroom and parallel consumer groups.</span>Backlog is fine &mdash; depth just grows and drains &mdash; so I size partitions for throughput, not to avoid buffering."},
        {who:"intv",text:"More partitions means more parallelism &mdash; any downside to just cranking the count?"},
        {who:"cand",text:"Yes: each partition adds consumer-assignment and rebalance overhead, more connections, and finer-grained ordering to reason about. The trade-off is parallel throughput and priority isolation versus operational complexity and rebalance churn. So I decide: provision partitions from the <strong>peak drain rate</strong> with modest headroom rather than maxing them out, and split into <strong>separate priority partitions</strong> (urgent vs best-effort) so a low-priority flood can't starve time-critical jobs. Throughput comes from partition count; fairness comes from separating classes."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"Kafka documentation",url:"https://kafka.apache.org/documentation/"},
      ]},
    ],
    coordinator:[
      {l:"medium",tag:"concept",q:"What does the coordinator do — leader election and assignment?",turns:[
        {who:"intv",text:"You added a coordinator for leader election and locks. Concretely, what does it manage and how do schedulers use it?"},
        {who:"cand",text:"It's the arbiter of <strong>who is allowed to act</strong>. Using <strong>ZooKeeper or etcd</strong>, it manages two things: <strong>membership</strong> (which scheduler instances are alive, via ephemeral nodes / leases with heartbeats) and <strong>partition assignment</strong> (which instance owns which slice of the job space). Schedulers register, receive their partitions, and renew a lease; if one dies its lease expires and the coordinator reassigns its partitions to survivors.<span class='eg'>ZooKeeper ephemeral znodes: a scheduler's node vanishes when its session drops, triggering a rebalance watched by the others.</span>It gives me both no-SPOF failover and disjoint ownership so nothing double-fires."},
        {who:"intv",text:"Why not have schedulers coordinate peer-to-peer instead of depending on a coordinator?"},
        {who:"cand",text:"Peer-to-peer consensus is exactly what ZooKeeper/etcd already solve correctly — reinventing distributed agreement (who's the leader, who owns what) in application code is a classic source of split-brain bugs. Delegating to a battle-tested consensus system gives me <strong>linearizable membership and assignment</strong> with fencing built in. My schedulers stay simple: they ask the coordinator who owns what and act only within their assignment. The coordinator is small and rarely on the hot path (it's consulted on membership changes, not every job), so it's a reliability asset, not a bottleneck."},
      ],resources:[
        {title:"ZooKeeper overview",url:"https://zookeeper.apache.org/doc/current/zookeeperOver.html"},
        {title:"Leader election",url:"https://en.wikipedia.org/wiki/Leader_election"},
      ]},
      {l:"medium",tag:"scaling",q:"Rebalancing partitions as schedulers come and go.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> you scale from 4 to <b>40</b> schedulers during a busy period, and nodes churn — some crash, some are added. Partitions must be reassigned each time. How do you rebalance without either overloading the coordinator or dropping coverage of some jobs?</span>"},
        {who:"cand",text:"Use <strong>consistent hashing</strong> for partition-to-scheduler assignment so adding or removing a node only moves a small fraction of partitions, not a full reshuffle — churn is cheap and rebalances are incremental. The coordinator only stores the assignment map and membership, which is tiny metadata, so it isn't stressed by the churn itself. Each partition always has exactly one owner in the map, so there's never a gap where some jobs are unscanned; a reassigned partition transfers ownership atomically from old to new owner."},
        {who:"intv",text:"During the moment of handoff, could a partition be owned by nobody (jobs unscanned) or by two (double-scan)?"},
        {who:"cand",text:"Both risks exist in the transition window, and I handle them opposite ways. <strong>Briefly unowned</strong> is acceptable — jobs in that partition just wait a second and are picked up by the overdue scan when the new owner takes over, so it's a small timeliness blip. <strong>Briefly double-owned</strong> is the dangerous one, so I fence it: assignments carry a <strong>fencing token / epoch</strong>, and the atomic per-job claim rejects a stale owner's writes. So the safe failure (a gap) is tolerated because the durable store makes it recoverable, and the unsafe failure (overlap) is prevented by fencing. I bias every ambiguous handoff toward not-double-firing."},
      ],resources:[
        {title:"System Design Primer — consistent hashing",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"ZooKeeper overview",url:"https://zookeeper.apache.org/doc/current/zookeeperOver.html"},
      ]},
      {l:"hard",tag:"failover",q:"Split-brain — two schedulers believe they own a partition.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a network partition isolates a scheduler from the coordinator. The coordinator declares it dead and reassigns its partitions to another node. But the isolated scheduler is still running and still thinks it owns those partitions. For a few seconds two schedulers scan and enqueue the same jobs. Prevent the double-execution.</span>"},
        {who:"cand",text:"This is the textbook <strong>split-brain</strong>, and the fix is <strong>fencing tokens</strong>. Every partition assignment carries a monotonically increasing token. When the coordinator reassigns the partition to the new owner, it issues a <em>higher</em> token. The job store (and queue) record the highest token seen per partition and <strong>reject any enqueue/claim bearing a lower token</strong>. So the isolated old owner, still holding a stale token, has all its writes fenced off the instant the new owner acts — it literally cannot enqueue, even though it believes it still owns the partition. Liveness comes from reassignment; safety comes from fencing."},
        {who:"intv",text:"The old scheduler may have <em>already</em> enqueued job 42 before the new owner got the higher token. Now the task is in the queue twice. Still safe?"},
        {who:"cand",text:"Yes, because I don't rely on fencing alone — the <strong>atomic per-job claim</strong> is the second layer. Enqueue is gated by the conditional transition <code>pending &rarr; queued</code> plus advancing <code>next_run_at</code>; only one enqueue per fire time can win that transition, so even racing owners can't both enqueue job 42 for the same occurrence. And if somehow two task messages did exist, the final backstop is <strong>idempotent execution</strong> keyed on the execution id — the second run is a no-op at the side-effecting boundary. Three layers: fencing tokens (stop the stale owner), atomic claim (one enqueue per fire time), idempotency (harmless duplicate execution). Defense in depth is deliberate because a double-fire on a billing job is unacceptable."},
      ],resources:[
        {title:"Leader election",url:"https://en.wikipedia.org/wiki/Leader_election"},
        {title:"ZooKeeper overview",url:"https://zookeeper.apache.org/doc/current/zookeeperOver.html"},
      ]},
      {l:"medium",tag:"capacity",q:"How much load does the coordinator take, and how big an ensemble?",turns:[
        {who:"intv",text:"Size the coordinator. How much load does it actually carry, and how many nodes in the ensemble?"},
        {who:"cand",text:"Almost none, by design &mdash; it's off the hot path. It handles membership and partition assignment, not per-job traffic, so its load scales with the number of schedulers and how often they renew leases, not with 10K exec/s.<span class='eg'>40 schedulers renewing a lease every 5s &rarr; ~8 renewals/s, plus rare rebalances on membership change &mdash; hundreds of ops/s at most, not thousands.</span>So the coordinator is tiny compute; the real sizing question is the ensemble for fault tolerance."},
        {who:"intv",text:"So 3 nodes or 5?"},
        {who:"cand",text:"It's a quorum trade-off. A <strong>3-node</strong> ensemble tolerates 1 failure and has a fast 2-node write quorum; a <strong>5-node</strong> ensemble tolerates 2 failures but every write needs a 3-node quorum, so it's a touch slower and costs more. Since the coordinator is rarely written to and off the hot path, latency barely matters, so the choice is purely how much redundancy I want. I decide: <strong>3 nodes</strong> across AZs as the default, moving to 5 only if losing the coordinator is judged catastrophic enough to want double-fault tolerance. Either way it stays small and out of the per-job path."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"ZooKeeper overview",url:"https://zookeeper.apache.org/doc/current/zookeeperOver.html"},
      ]},
      {l:"medium",tag:"concept",q:"ZooKeeper vs etcd for coordination — which and why?",turns:[
        {who:"intv",text:"You keep saying ZooKeeper or etcd. Pick one and justify it against the other for this coordinator role."},
        {who:"cand",text:"Both give me what I need: linearizable consistency (ZooKeeper via Zab, etcd via Raft), ephemeral membership, and watches. <strong>ZooKeeper</strong> is battle-tested, and its ephemeral znodes plus watches map cleanly onto membership &mdash; a scheduler's node vanishes when its session drops and peers get notified &mdash; but it's a heavier JVM system to operate. <strong>etcd</strong> has a simpler gRPC/HTTP API, lease-based keys, and backs Kubernetes, so it's lighter to run and its lease + revision model is a clean fit for fencing."},
        {who:"intv",text:"Whichever you pick, where does the fencing token come from?"},
        {who:"cand",text:"That's actually the deciding lens. Both expose a <strong>monotonic revision</strong> &mdash; etcd's <code>mod_revision</code> or ZooKeeper's <code>zxid</code> / znode version &mdash; that I use directly as the fencing epoch on a partition assignment, so the store can reject a stale owner. Since both give it natively, I decide on operational fit: <strong>if we already run Kubernetes, etcd</strong> (one less system to operate, clean lease/revision API); a shop with existing ZooKeeper expertise and Kafka/Hadoop alongside should stay on ZooKeeper. The point is to delegate consensus to a proven system rather than hand-roll it, not that one is universally better."},
      ],resources:[
        {title:"ZooKeeper overview",url:"https://zookeeper.apache.org/doc/current/zookeeperOver.html"},
        {title:"Leader election",url:"https://en.wikipedia.org/wiki/Leader_election"},
      ]},
    ],
    deadletter:[
      {l:"medium",tag:"concept",q:"What goes to the dead-letter, and why separate it?",turns:[
        {who:"intv",text:"You route exhausted jobs to a dead-letter store. What exactly lands there, and why is a separate store better than just leaving them failed?"},
        {who:"cand",text:"A job lands in the dead-letter after it has <strong>exhausted its retry budget</strong> — say 5 attempts with backoff all failed — carrying the job def, payload, execution id, attempt count, and the <strong>last error(s)</strong> for diagnosis.<span class='eg'>a job calling a downstream that's been 500ing all day burns its retries, then dead-letters with the captured error rather than retrying forever.</span>Separating it gives me an explicit, <strong>monitorable surface</strong>: I alert on dead-letter depth, operators triage poison jobs, and I keep permanently-failing work out of the hot retry path so it can't waste worker capacity spinning."},
        {who:"intv",text:"How do you distinguish a poison job (bad input, will never succeed) from a job that failed due to a transient outage?"},
        {who:"cand",text:"The retry policy is the filter. <strong>Transient</strong> failures (timeouts, 503s, connection resets) are retried with backoff and usually succeed within the budget, so they never reach the dead-letter. What survives all retries is likely a <strong>poison job</strong> — bad payload, a permanent downstream error (400, auth failure), or a code bug. I can classify further using the error type: retry on 5xx/timeouts, fail-fast to dead-letter on 4xx/validation errors since retrying won't help. So the dead-letter accumulates genuinely stuck work, and its depth becomes a meaningful signal rather than noise from transient blips."},
      ],resources:[
        {title:"Hello Interview — Job Scheduler (retries & dead-letter)",url:"https://www.hellointerview.com/learn/system-design/problem-breakdowns/job-scheduler"},
        {title:"System Design Primer — reliability",url:"https://github.com/donnemartin/system-design-primer"},
      ]},
      {l:"medium",tag:"scaling",q:"A bad deploy dead-letters a flood of jobs at once.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a broken deploy on a popular downstream makes <b>50K</b> jobs fail their retries within an hour, all pouring into the dead-letter store. It must absorb that flood, and later you need to replay all 50K once the downstream is fixed. How do you handle the volume both ways?</span>"},
        {who:"cand",text:"The dead-letter is just another <strong>durable, append-friendly store</strong>, so absorbing 50K entries is a non-issue — it's sized for writes and I partition it if needed. The bigger design point is that a flood into the dead-letter is a <strong>signal</strong>: a sharp spike in its depth should page someone, because it usually means a systemic downstream failure, not 50K independent bad jobs. That alerting turns the dead-letter into an early-warning system for exactly this kind of bad-deploy blast radius."},
        {who:"intv",text:"Now replay all 50K after the fix. How do you do that without re-creating the same overload?"},
        {who:"cand",text:"Replay is a <strong>controlled, rate-limited re-enqueue</strong>, not a dump. I feed the 50K back through the normal scheduler/queue path at a throttled rate so I don't instantly re-overwhelm the just-recovered downstream — the same backpressure discipline as any herd. Each replayed job keeps its <strong>execution id</strong>, so idempotency still protects any that partially succeeded before failing. I can replay selectively (filter by error type or time window) and dry-run first. So replay reuses the existing dispatch machinery with a throttle, converting a big backlog into a paced drain rather than a second thundering herd."},
      ],resources:[
        {title:"System Design Primer — reliability & queues",url:"https://github.com/donnemartin/system-design-primer"},
        {title:"ByteByteGo",url:"https://bytebytego.com/"},
      ]},
      {l:"hard",tag:"durability",q:"Dead-lettered jobs must never be lost during replay.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> you're replaying <b>10K</b> dead-lettered jobs and the replay worker crashes halfway. Some were re-enqueued, some weren't, and you're unsure which. If you're careless you either lose the un-replayed ones or double-replay the done ones. Make replay safe.</span>"},
        {who:"cand",text:"I treat replay as a <strong>durable, resumable operation</strong>, not a fire-and-forget loop. Each dead-letter entry has a <strong>replay state</strong> (pending &rarr; replayed) that I transition <em>atomically</em> as I re-enqueue it, so on a crash I know exactly which are done. A restarted replay worker simply resumes over entries still in <code>pending</code> — no loss, because un-replayed entries remain durably in the dead-letter, and no duplication, because replayed ones are already marked. The dead-letter store's durability (replicated, quorum-acked) means an entry never disappears whether or not it's been replayed yet."},
        {who:"intv",text:"A job re-enqueued during replay gets processed, but the crash happened right after enqueue and before you marked it replayed. On resume you re-enqueue it. Double-run?"},
        {who:"cand",text:"That window exists, and it's handled by the same guarantee the whole system leans on: <strong>at-least-once plus idempotency</strong>. A re-enqueue of an already-processed job carries the same <strong>execution id</strong>, so the downstream dedups it and the effect happens once regardless of a double-enqueue. So the marking-after-enqueue gap can at worst cause a harmless duplicate delivery, never a wrong effect. I keep replay <strong>idempotent end to end</strong> precisely so I never have to make enqueue-and-mark atomic across two systems — which, as with execution, isn't truly achievable. Durable replay state prevents loss; idempotency neutralizes the duplicate."},
      ],resources:[
        {title:"Idempotence",url:"https://en.wikipedia.org/wiki/Idempotence"},
        {title:"Hello Interview — Job Scheduler (dead-letter & replay)",url:"https://www.hellointerview.com/learn/system-design/problem-breakdowns/job-scheduler"},
      ]},
      {l:"medium",tag:"capacity",q:"Size the dead-letter store — volume and retention.",turns:[
        {who:"intv",text:"Size the dead-letter store. Given retries and a low failure rate, how much volume does it hold, and how do you set retention?"},
        {who:"cand",text:"It's small in steady-state because only jobs that exhaust all retries land there.<span class='eg'>say 0.1% of 10K exec/s finally fail &rarr; ~10/s &asymp; 860K entries/day; each carries def + payload + last error, a few KB &rarr; ~a few GB/day; retain 30 days &asymp; ~100GB.</span>Modest &mdash; but it must also absorb a burst, like a bad deploy dead-lettering 50K jobs in an hour, so I size for write spikes, not just the average."},
        {who:"intv",text:"So how long do you keep entries, and what's the tension?"},
        {who:"cand",text:"The trade-off is retention cost versus operability: too short and I lose the ability to triage and <strong>replay</strong> after a fix; too long and I pay to store stale failures forever. Since replay after fixing a downstream is the whole point of the dead-letter, I decide: retain long enough to cover realistic triage-and-fix cycles &mdash; on the order of <strong>30 days</strong> &mdash; <strong>partition by <code>failed_at</code></strong> so bursts spread and old entries age out cleanly, and <strong>alert on depth</strong> so a flood pages someone. Storage is cheap here; losing replayability is not."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"Hello Interview — Job Scheduler (retries & dead-letter)",url:"https://www.hellointerview.com/learn/system-design/problem-breakdowns/job-scheduler"},
      ]},
      {l:"medium",tag:"concept",q:"What backs the dead-letter — a broker DLQ, a Kafka topic, or a table?",turns:[
        {who:"intv",text:"What actually stores dead-lettered jobs &mdash; a broker's built-in DLQ, a Kafka topic, or a table in your store? Compare the options."},
        {who:"cand",text:"Three candidates. A <strong>broker-native DLQ</strong> (SQS redrive, RabbitMQ dead-letter exchange) routes automatically after max receives and needs no extra plumbing, but it's poor for querying and triage and has retention caps. A <strong>Kafka topic</strong> is durable, high-throughput, and replayable, but querying by job, owner, or error type is awkward &mdash; it's a log, not an index. A <strong>database table</strong> (my <code>dead_letter</code> table) is queryable by error/owner/time, makes selective replay and depth-based alerting trivial via ordinary queries, at the modest volume this sees."},
        {who:"intv",text:"And under a 50K bad-deploy flood &mdash; does the table still win?"},
        {who:"cand",text:"It holds: 50K rows is nothing for a table, and it's append-heavy so I index by <code>failed_at</code> and <code>last_error</code> and partition if needed. Replay is a <strong>rate-limited scan-and-re-enqueue</strong> with a replay-state column so it's resumable after a crash &mdash; something a raw log makes clumsy. Kafka would win on pure throughput, but the dead-letter is an <em>operational surface</em> I need to filter, triage, and selectively replay, so I decide: a <strong>database table as the primary store</strong>, optionally fed by a broker DLQ as the transport that carries exhausted jobs into it. Query ergonomics beat raw throughput for this component."},
      ],resources:[
        {title:"Kafka documentation",url:"https://kafka.apache.org/documentation/"},
        {title:"Hello Interview — Job Scheduler (retries & dead-letter)",url:"https://www.hellointerview.com/learn/system-design/problem-breakdowns/job-scheduler"},
      ]},
    ],
  },
  mockTest:[
    {q:"With 100M registered jobs, how does the scheduler find the ones due each second without scanning everything?",a:"Keep an index on next_run_at (a partial/time-bucketed btree over live jobs) so the due-scan is a bounded range read &mdash; seek to now, read the few thousand ordered rows that are due, stop &mdash; not a 100M-row full scan. Front the near-term horizon with a Redis sorted set scored by fire time so the tight ~1s poll pops due jobs in O(log n) and only writes state transitions back to the durable store. Work per tick is proportional to what is actually due, not to the catalog size."},
    {q:"You promise at-least-once execution. How do you make that safe rather than duplicating side effects?",a:"At-least-once comes from lease-then-ack: a task stays invisible under a visibility-timeout lease until the worker acks, so a crash re-delivers rather than loses the job. Safety comes from idempotency keyed on an execution id (job id + scheduled fire time): every side effect carries that id and the downstream dedups on it, so a replay applies each effect at most once. Multi-step jobs checkpoint completed steps by execution id so a re-run skips finished work. Exactly-once across an external effect is impossible, so the platform contract requires idempotent handlers."},
    {q:"Many scheduler instances run at once. How do you stop two of them from firing the same job?",a:"Two layers. First, the coordinator (ZooKeeper/etcd) gives each scheduler a disjoint partition of the job space via consistent hashing, so ideally no two even look at the same job. Second, every enqueue is gated by an atomic conditional claim &mdash; flip pending &rarr; queued only if still pending and advance next_run_at &mdash; so only one scheduler wins per fire time even during a partition handoff. Assignments carry a fencing token/epoch so a stale owner's writes are rejected. Partitioning avoids contention; the atomic claim makes any residual overlap safe."},
    {q:"A worker is OOM-killed 90 seconds into a job and never acked. Lost? And how do you avoid double side effects on re-run?",a:"Not lost. The task was held under a visibility-timeout lease and never acked, so when the lease lapses the queue re-delivers it to another worker. The re-run risk is the first 90 seconds' effects repeating, handled by idempotency on the execution id: downstreams dedup, and multi-step jobs skip checkpointed steps. For a non-idempotent external call, record intent-before / confirmed-after so a re-run can query the true outcome before redoing &mdash; it shrinks but cannot fully close the window, which is why handlers must be idempotent."},
    {q:"Which datastore backs the job store, and why is the index on next_run_at decisive?",a:"A strongly-consistent relational store (Postgres, or NewSQL like CockroachDB as it grows), sharded by job_id and aligned with the scheduler's partitions. It natively does the two hot paths: a range index on next_run_at and an atomic conditional claim (UPDATE ... WHERE status='pending'). The next_run_at index is decisive because without it the due-scan is a full scan of 100M rows every second (fatal IO); with it the scan touches ~10K rows/tick. Cassandra's LWT claim is expensive and lacks a cheap range on next_run_at; DynamoDB's next_run_at GSI creates a midnight hot partition. Correctness (the claim) and the cheap due-scan beat raw write-scale."},
    {q:"Size the worker pool for 10K executions/s using Little's law.",a:"In-flight = arrival rate &times; average duration. 10K/s &times; ~2s average &asymp; 20K concurrent executions; if one worker handles ~50 concurrent IO-bound tasks &rarr; 20K &divide; 50 &asymp; 400 workers, provision ~1.5x for peaks &rarr; ~600. That is only the floor for the average &mdash; durations vary wildly, so autoscale on queue depth and consumer lag using the Little's-law number as a warm floor, and separate pools by duration class so multi-minute jobs do not head-of-line-block 10ms tasks."},
    {q:"A million cron jobs are all due at midnight in the same second. How do you keep the system timely?",a:"Flatten the time axis and absorb the rest. Add jitter to smear popular cron times across a tolerance window (e.g. ~20s), turning a 1M/s spike into ~50K/s. Partition scheduling by job id so every partition shares the load rather than one being hammered. The durable queue buffers the burst &mdash; a deep queue is working as designed &mdash; and workers autoscale on depth to drain it. Nothing is lost because due-ness lives in the durable store; the herd just fires slightly late, within tolerance."},
    {q:"What is the dead-letter store for, and how do you distinguish a poison job from a transient failure?",a:"Jobs that exhaust their retry budget (e.g. 5 attempts with backoff) land in a separate dead-letter store carrying def, payload, execution id, attempt count, and last error &mdash; an explicit, monitorable surface you alert on by depth, kept out of the hot retry path. The retry policy is the filter: transient failures (timeouts, 503s, resets) are retried with backoff and usually succeed, so they never arrive; what survives all retries is likely poison (bad payload, 4xx/auth, code bug). Fail-fast to dead-letter on 4xx/validation, retry on 5xx/timeouts, so its depth is a meaningful signal. Replay after a fix is a rate-limited re-enqueue with a resumable replay-state so a crash mid-replay neither loses nor double-runs entries."},
  ]
};


(function(){
var d=window.DATA['scheduler'];
var scaling={id:"scaling",name:"From durable cron to scheduler at scale",kind:"scale",
  live:["client","api","jobdb","worker"],
  summary:"Start from a durable job table and workers, then add due discovery, a queue, coordination, and dead-letter handling only when the load or failure mode demands it. The invariant stays simple: never lose a submitted job, and make duplicates harmless.",
  steps:[
    {node:"jobdb",stage:"Stage 0 · Baseline",title:"One durable store — workers claim jobs directly",
      live:["client","api","jobdb","worker"],
      edges:[["client","api","submit"],["api","jobdb","persist"],["jobdb","worker","claim"]],
      narrate:"Draw the smallest correct scheduler first: the API validates a job, durably writes it, and workers claim due rows from the job store. The design protects the core promise — a submitted job is not lost — but the due-scan and handoff are still coupled to the database.",
      details:[
        {k:"win",label:"Why start here",text:"Durability is earned before scale. Once the API acks only after a quorum-committed row, every later component can crash and the job still exists to be found again."},
        {k:"scale",label:"Working numbers",text:"~**100M jobs** registered, ~**10K executions/s** steady, with round-time spikes where **1M jobs** may be due at midnight."},
        {k:"query",label:"Naive but correct",code:"INSERT INTO jobs(job_id, spec, next_run_at, state) VALUES (..., 'pending');\n-- worker loop\nUPDATE jobs SET state='running'\n WHERE job_id=? AND state='pending' AND next_run_at <= now();"}
      ],
      snap:{title:"Load & capacity — Stage 0",cap:"The data is safe, but polling and execution are not yet independently scalable.",
        tables:[{name:"signals",cols:["signal","value","verdict"],rows:[
          {c:["Registered jobs","~100M","durable"]},
          {c:["Steady executions","~10K /s","target"]},
          {c:["Midnight herd","~1M due","risk"],hi:1,tag:"risk"},
          {c:["Handoff buffer","none","DB coupled"]}
        ]}]}},
    {node:"scheduler",stage:"Stage 1 · Due scanner",title:"Workers cannot scan 100M rows &rarr; add scheduler partitions",
      live:["client","api","jobdb","worker","scheduler"],
      edges:[["client","api","submit"],["api","jobdb","persist"],["scheduler","jobdb","poll due"],["jobdb","worker","claim"]],
      narrate:"Letting every worker hunt for due jobs turns the hot table into a polling target. Due discovery needs its own bounded loop that scans only due partitions, claims rows atomically, and leaves workers focused on execution.",
      details:[
        {k:"scale",label:"The number that forces it",text:"The due loop ticks about every **1s** and must handle ~**10K/s** steady. A midnight spike is smeared by jitter to roughly **50K/s**, so about **6 scheduler partitions** give headroom."},
        {k:"pain",label:"What breaks without it",text:"A naive `WHERE next_run_at &le; now` over 100M jobs each tick pins the database and starves state transitions. Workers waste capacity polling instead of running jobs."},
        {k:"fix",label:"The fix — partitioned due discovery",text:"Add scheduler instances that own disjoint job_id partitions, read a time index or sorted set for due jobs, and perform the atomic pending&rarr;queued claim in the store. Work per tick is proportional to due jobs, not catalog size."},
        {k:"key",label:"Still source-of-truth in DB",text:"The sorted set can accelerate the hot loop, but the conditional claim in the job store decides. If the cache is lost, an overdue DB scan rebuilds due work."}
      ],
      snap:{title:"Load & capacity — Stage 1",cap:"Due discovery is bounded and parallel, but dispatch still has no shock absorber.",
        tables:[{name:"signals",cols:["signal","before","after"],rows:[
          {c:["Due scan","100M-row risk","range/sorted-set due only"],hi:1,tag:"fixed"},
          {c:["Steady claims","~10K /s","partitioned"]},
          {c:["Midnight rate","~50K /s after jitter","~6 partitions"]},
          {c:["Tick target","can exceed 1s","finishes within tick"]}
        ]}]}},
    {node:"queue",stage:"Stage 2 · Task queue",title:"Execution bursts back up claims &rarr; decouple with a queue",
      live:["client","api","jobdb","worker","scheduler","queue"],
      edges:[["api","jobdb","persist"],["scheduler","jobdb","poll due"],["scheduler","queue","enqueue"],["queue","worker","dispatch"]],
      narrate:"The scheduler should be fast at finding due work, not blocked by slow handlers or a temporarily undersized worker pool. A durable queue turns a spike into backlog and gives workers leases, visibility timeouts and ack semantics.",
      details:[
        {k:"scale",label:"The number that forces it",text:"Workers need about **20K in-flight** slots for 10K/s at ~2s average duration, with **400–600 workers** as a practical floor. Midnight dispatch can hit **50K msgs/s**."},
        {k:"pain",label:"What breaks without it",text:"Without a buffer, a worker slowdown makes schedulers hold DB claims longer or retry dispatch in place. Jobs fire late, and the database becomes the backpressure queue."},
        {k:"fix",label:"The fix — durable at-least-once queue",text:"Schedulers enqueue due executions and move on. Workers lease messages under a visibility timeout, heartbeat long jobs, and ack only after success. No ack means redelivery, not loss."},
        {k:"gotcha",label:"At-least-once means idempotency",text:"A re-delivered execution must be harmless. Pass `jobId + scheduledFireTime` as the execution id so downstream side effects can dedup."}
      ],
      snap:{title:"Load & capacity — Stage 2",cap:"The queue absorbs scheduling spikes and lets workers scale on lag.",
        tables:[{name:"signals",cols:["signal","value","verdict"],rows:[
          {c:["Queue throughput","10K steady · 50K peak","partitioned"]},
          {c:["Partitions","~12–16","headroom"],hi:1},
          {c:["In-flight workers","~20K tasks","Little's law"]},
          {c:["Crash during execution","lease expires","redelivered"],hi:1,tag:"fixed"}
        ]}]}},
    {node:"coordinator",stage:"Stage 3 · Coordinator",title:"Multiple schedulers can double-own work &rarr; elect and fence",
      live:["client","api","jobdb","worker","scheduler","queue","coordinator"],
      edges:[["api","jobdb","persist"],["coordinator","scheduler","elect"],["scheduler","jobdb","poll due"],["scheduler","queue","enqueue"],["queue","worker","dispatch"]],
      narrate:"Partitioned schedulers scale, but now ownership is a correctness problem. If two schedulers believe they own the same partition during a failover, both can claim or enqueue the same job window.",
      details:[
        {k:"scale",label:"The number that forces it",text:"At **6+ scheduler partitions** and frequent deploys/failovers, manual ownership is not safe. Every claim needs an owner epoch so stale schedulers are fenced."},
        {k:"pain",label:"What breaks without it",text:"Split-brain schedulers double-fire jobs, or an abandoned partition stops firing until a human notices. Both violate the reliability contract: duplicates may be harmful, and silent drops are worse."},
        {k:"fix",label:"The fix — leases, epochs and fencing",text:"A coordinator assigns partitions with short leases and monotonic epochs. The job store accepts claims only from the current epoch; a stale scheduler can keep running but its writes are rejected."},
        {k:"note",label:"Late beats double",text:"On uncertainty, pause, elect, fence and resume. A job firing a few seconds late is recoverable by overdue scan; a double-fired billing job is not."}
      ],
      snap:{title:"Load & capacity — Stage 3",cap:"Ownership is explicit, failover is automatic, and stale writers are fenced.",
        tables:[{name:"signals",cols:["concern","mechanism","result"],rows:[
          {c:["Partition ownership","coordinator lease","single active owner"],hi:1,tag:"fixed"},
          {c:["Stale scheduler","epoch fenced","no double claim"]},
          {c:["Scheduler crash","overdue scan","late not lost"],hi:1},
          {c:["Clock skew","DB claim arbiter","bounded timing error"]}
        ]}]}},
    {node:"deadletter",stage:"Stage 4 · Dead-letter",title:"Retries can loop forever &rarr; isolate exhausted executions",
      live:["client","api","jobdb","worker","scheduler","queue","coordinator","deadletter"],
      edges:[["api","jobdb","persist"],["coordinator","scheduler","elect"],["scheduler","jobdb","poll due"],["scheduler","queue","enqueue"],["queue","worker","dispatch"],["worker","deadletter","on fail"]],
      narrate:"The scheduler can now find and dispatch reliably, but a permanently failing handler can churn forever, hide the real error and starve healthy work. Failed executions need policy, visibility and a terminal place to land.",
      details:[
        {k:"scale",label:"The number that forces it",text:"At **10K executions/s**, even a 0.1% permanent failure rate is 10 poisoned jobs every second. Unbounded retries become a self-inflicted queue flood."},
        {k:"pain",label:"What breaks without it",text:"A bad payload or downstream bug retries forever, burns worker slots, and buries the root cause in logs. Users see pending jobs with no clear final state."},
        {k:"fix",label:"The fix — retry policy + dead-letter",text:"Track attempts in the job store, retry with exponential backoff and jitter, then move exhausted executions to a dead-letter table/topic with reason, payload pointer and replay controls. Operators can inspect and re-drive after a fix."},
        {k:"gotcha",label:"Recurring jobs",text:"Dead-letter the failed execution, not the entire cron definition unless policy says to pause it. The next scheduled fire time can still be computed and run."}
      ],
      snap:{title:"Load & capacity — Stage 4 (full design)",cap:"The complete scheduler has durable intake, bounded due discovery, buffered dispatch, fenced ownership and visible terminal failures.",
        tables:[{name:"signals",cols:["signal","mechanism","result"],rows:[
          {c:["Permanent failures","max attempts + DLQ","no infinite loop"],hi:1,tag:"fixed"},
          {c:["Retry burst","backoff + jitter","smoothed"]},
          {c:["Operator action","inspect + replay","recoverable"]},
          {c:["Core invariant","job store truth","never silently lost"],hi:1}
        ]}]}},
  ]};
d.deepFlows=[scaling].concat(d.deepFlows);
})();
