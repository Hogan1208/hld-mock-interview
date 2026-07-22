window.DATA = window.DATA || {};
window.DATA['feed'] = {
  cat:"fan-out · timelines · ranking",
  title:"Design a social news feed / timeline (Twitter / Instagram)",
  blurb:"Build home timelines for hundreds of millions of users, deliver a celebrity post to tens of millions of followers, and read feeds in <200ms.",
  prompt:"Let's design the home feed for a social network like Twitter or Instagram. A user follows others, posts show up in their followers' home timelines, and opening the app should load a ranked feed fast. We're at hundreds of millions of users, some celebrities have tens of millions of followers. Start with the high-level architecture and rough numbers, then we'll drill into components — and I'll be throwing failure scenarios at you.",
  opening:"Let me frame it before drawing boxes.<br><br><strong>Functional:</strong> create a post (text + media), follow/unfollow, load a ranked home timeline of the people you follow, view a profile. <strong>Non-functional:</strong> home-timeline read p99 < 200ms, read-heavy, highly available (a blank feed is a dead app), and a new post should reach followers within seconds — eventual consistency is fine, but read-your-own-writes is not negotiable.<br><br><strong>Back-of-envelope:</strong> ~300M DAU, each opens the feed ~20x/day → ~6B reads/day ≈ 70K reads/s, peak 3-5x ≈ 300K/s. Writes: ~1 post/user/day → 300M posts/day ≈ 3,500 posts/s. Fan-out is the scary number: avg ~300 followers → 300M x 300 = 90B feed-list writes/day ≈ 1M/s, and one celebrity post at 50M followers is 50M writes on its own. Post metadata ~1KB → ~300GB/day; media lives separately in object storage + CDN, petabytes.<br><br>I'll start deliberately minimal: <strong>client → load balancer → feed service → post + graph DB</strong>. That skeleton is correct — it can build a timeline by querying who you follow and fetching their recent posts. As we hit scale and failure pressure I'll grow it: fan-out, a feed cache, media/CDN. Pick a box and let's push on it.",
  nodes:[
    {id:"client",name:"Client",sub:"mobile / web",x:40,y:150},
    {id:"lb",name:"LB + gateway",sub:"edge",x:210,y:150},
    {id:"feed",name:"Feed service",sub:"read timeline",x:380,y:150},
    {id:"db",name:"Post + graph DB",sub:"posts, follows",x:550,y:150},
    {id:"fanout",name:"Fan-out service",sub:"post delivery",x:380,y:40},
    {id:"cache",name:"Feed cache",sub:"Redis lists",x:550,y:40},
    {id:"media",name:"Media / CDN",sub:"images, video",x:720,y:150},
  ],
  edges:[["client","lb"],["lb","feed"],["feed","db"],["feed","cache"],["cache","db"],["feed","fanout"],["fanout","cache"],["feed","media"]],
  core:["client","lb","feed","db"],
  basic:["client","lb","feed","db"],
  schema:{tables:[
    {name:"posts",pk:"post_id",columns:[
      ["post_id","bigint","snowflake id, primary key"],
      ["author_id","bigint","who wrote it (indexed)"],
      ["text","text","post body"],
      ["media_ids","jsonb NULL","object keys for attached media (null = text only)"],
      ["created_at","timestamptz","creation time"],
    ],rows:[
      ["1487200000001","42","just shipped the new release","[\"med_9f2a\"]","2026-07-22 10:00:00"],
      ["1487200000002","7","good morning","(null)","2026-07-22 10:01:12"],
      ["1487200000003","901","tour dates announced","[\"med_1b3c\",\"med_1b3d\"]","2026-07-22 10:02:30"],
    ]},
    {name:"follows",pk:"follower_id + followee_id",columns:[
      ["follower_id","bigint","the user who follows (indexed)"],
      ["followee_id","bigint","the user being followed (indexed)"],
      ["created_at","timestamptz","when the edge was created"],
    ],rows:[
      ["42","901","2026-06-01 08:00:00"],
      ["7","901","2026-06-02 09:30:00"],
      ["42","7","2026-06-10 12:15:00"],
    ]},
    {name:"users",pk:"user_id",columns:[
      ["user_id","bigint","primary key"],
      ["handle","varchar(30)","unique @handle"],
      ["follower_count","bigint","denormalized count"],
      ["is_celebrity","boolean","true if above fan-out threshold"],
    ],rows:[
      ["42","@ada","318","false"],
      ["7","@grace","512","false"],
      ["901","@popstar","51000000","true"],
    ]},
    {name:"timelines",pk:"user_id",columns:[
      ["user_id","bigint","whose home timeline this is"],
      ["post_ids","list<bigint>","ordered, length-capped list of post ids"],
      ["updated_at","timestamptz","last fan-out write"],
    ],rows:[
      ["42","[1487200000002, 1487200000001]","2026-07-22 10:01:12"],
      ["7","[1487200000001]","2026-07-22 10:00:00"],
    ]},
  ]},
  flows:[
    {id:"post",name:"Create a post (write / fan-out)",steps:[
      {node:"client",text:"Client sends <code>POST /post {text, media?}</code>."},
      {node:"lb",text:"Gateway terminates TLS, authenticates, <strong>rate-limits</strong> the write, routes to a feed-service instance."},
      {node:"media",requires:["media"],text:"If media is attached, the client uploads bytes <strong>directly to object storage</strong>; the post keeps only an object-key reference."},
      {node:"feed",text:"Feed service validates the post and mints a snowflake <code>post_id</code>."},
      {node:"db",text:"Writes the row into <code>posts</code> (canonical, durable), then looks up the author's follower list."},
      {node:"fanout",requires:["fanout"],text:"Fan-out service pushes the <code>post_id</code> into each follower's feed list <strong>async</strong> (skipped for celebrities)."},
      {node:"cache",requires:["cache"],text:"Fan-out writes append the id to each <code>timeline:userId</code> Redis list; the author's own list is updated synchronously for read-your-writes."},
      {node:"client",text:"Returns <code>200</code> with the created post."},
    ]},
    {id:"timeline",name:"Load home timeline (read)",steps:[
      {node:"client",text:"Client issues <code>GET /timeline?cursor=...</code>."},
      {node:"lb",text:"Gateway authenticates and routes the read to the nearest feed-service instance."},
      {node:"cache",requires:["cache"],text:"Range-reads the page of post ids from the user's <code>timeline:userId</code> list — sub-millisecond."},
      {node:"fanout",requires:["fanout"],text:"Merges in recent posts from the handful of <strong>celebrities</strong> the user follows (not fanned out at write time)."},
      {node:"feed",text:"Hydrates the page of ids with a parallel multi-get."},
      {node:"db",text:"Fetches canonical post bodies and author profiles from the post + graph store on cache miss."},
      {node:"media",requires:["media"],text:"Client fetches images and video from the <strong>CDN edge</strong> in parallel with rendering the text."},
      {node:"client",text:"Renders the ranked page; returns a cursor for the next page."},
    ]},
    {id:"media",name:"Attach and view media (CDN)",steps:[
      {node:"client",text:"Client requests a <strong>pre-signed URL</strong> and uploads the file straight to object storage."},
      {node:"media",requires:["media"],text:"An async pipeline transcodes the source into multiple bitrate renditions behind the CDN."},
      {node:"feed",text:"The post carries only the media reference — bytes never flow through the feed path."},
      {node:"db",text:"Persists the post row with the object-key reference in <code>media_ids</code>."},
      {node:"media",requires:["media"],text:"On view, the <strong>CDN edge</strong> serves the right rendition close to the user via adaptive bitrate streaming."},
    ]},
  ],
  requirements:{
    functional:[
      "Create a post — text plus an optional photo or video",
      "Follow and unfollow other users",
      "Load a ranked home timeline of the accounts you follow",
      "View a profile and the posts on it",
    ],
    nonFunctional:[
      "Home-timeline read p99 under 200ms; read-heavy, roughly 20:1 read:write",
      "Highly available — a blank feed is a dead app",
      "A new post reaches followers within seconds (eventual consistency is fine)",
      "Read-your-own-writes: the author always sees their own post immediately",
    ],
  },
  reqBuild:[
    {req:"Create a post",turns:[
      {who:"intv",text:"Start with the simplest thing that satisfies requirement one: a user writes something and taps post. What's the minimal path?"},
      {who:"cand",text:"The <strong>client</strong> hits the <strong>LB + gateway</strong>, which routes to the <strong>feed service</strong>, which writes a post row to the <strong>post + graph DB</strong> keyed by a post id, then returns. The follow graph lives in that same store for now, so a post is just one durable write.<span class='eg'>INSERT INTO posts (post_id, author_id, text, created_at) VALUES (...);</span>My four core boxes already cover creating a post — I'm deliberately not touching delivery yet."},
      {who:"intv",text:"Where do follows live, and how does a post know who should eventually see it?"},
      {who:"cand",text:"The same DB holds a <strong>follow-graph</strong> edge set — an author has a followers list and a following list. But creating a post doesn't need to resolve that yet: the write just makes the post durable. <em>Who</em> sees it and <em>how fast</em> is a read/delivery concern I'll build in requirement two. Keeping create-post to a single write keeps the write path cheap, which matters because writes trigger everything downstream."},
    ],resources:[
      {title:"System Design Primer — the Twitter timeline",url:"https://github.com/donnemartin/system-design-primer#design-the-twitter-timeline-and-search"},
    ]},
    {req:"Load a personalized home timeline (adds fan-out)",reveal:["fanout"],turns:[
      {who:"intv",text:"Requirement two: a user opens the app and expects a ranked timeline of the people they follow. How do you build that feed?"},
      {who:"cand",text:"The naive version is a <strong>read-time fan-in</strong>: query who you follow, fetch each one's recent posts, merge and rank on the fly. Correct, but it re-does that large query on every feed load. Since reads dominate, I'd rather <strong>move the work to write time</strong> — <strong>fan-out on write</strong>. Let me add a <strong>fan-out service</strong> that, when someone posts, pushes that post id into each follower's <strong>pre-built feed list</strong>. A read then just returns an already-built list. For now those lists live in the DB; I'll put them in a cache during the deep dives."},
      {who:"intv",text:"Why precompute at write time instead of just merging at read time?"},
      {who:"cand",text:"Because the read:write ratio is about 20:1, so I want the hot path — the read — to be trivial, and I can afford to spend more on the rarer write.<span class='eg'>Follow 300 accounts: a read-time merge scans 300 authors' recent posts on every load, versus one list lookup if the feed is pre-built.</span>Fan-out on write turns each feed read into a cheap list fetch. It has a nasty failure mode — a celebrity with tens of millions of followers makes one post explode into tens of millions of writes — but that's exactly the kind of thing I'll harden in a deep dive rather than solve prematurely now."},
    ],resources:[
      {title:"System Design Primer — fan-out",url:"https://github.com/donnemartin/system-design-primer#fan-out"},
      {title:"System Design Primer — the Twitter timeline",url:"https://github.com/donnemartin/system-design-primer#design-the-twitter-timeline-and-search"},
    ]},
    {req:"Attach photos and video to posts (adds media / CDN)",reveal:["media"],turns:[
      {who:"intv",text:"Requirement one also allows a photo or a video. A user attaches a 4K clip. Does that flow through the feed service?"},
      {who:"cand",text:"No — media bytes never flow through the feed or post path. Let me add a dedicated <strong>media / CDN</strong> component. On upload the client puts the file <strong>directly into object storage</strong> and the post carries only a <strong>reference</strong> — an object key plus thumbnail metadata. On view, the client fetches the bytes from the <strong>CDN edge</strong>, close to the user, in parallel with rendering the text. So the feed response stays a few KB of JSON no matter how big the video is."},
      {who:"intv",text:"Why keep only a reference in the post rather than storing the media alongside it?"},
      {who:"cand",text:"Bytes are huge and their access pattern is completely different from post metadata, and object storage plus a CDN do that job far better than my app tier.<span class='eg'>A 200MB video is a few-byte object key in the post row, versus proxying 200MB through app servers that also serve latency-critical feeds.</span>It also decouples upload durability from the feed path — the file lands in replicated storage before the post commits — and lets an async pipeline transcode renditions. The transcode and delivery details are a deep dive; here the point is the feed just carries a reference and bytes travel a separate CDN-fronted path."},
    ],resources:[
      {title:"Cloudflare — what is a CDN?",url:"https://www.cloudflare.com/learning/cdn/what-is-a-cdn/"},
      {title:"Apple — HTTP Live Streaming (HLS)",url:"https://developer.apple.com/streaming/"},
    ]},
  ],
  systemDives:[
    {title:"Timeline reads are hammering the DB",tag:"scaling",reveal:["cache"],turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> even with fan-out on write, you materialize feed lists by querying the post + graph DB on every read. At <b>70K</b> feed reads/s the DB p99 climbs past <b>400ms</b>, CPU pegs, and reads start timing out. What's your move?</span>"},
      {who:"cand",text:"The pre-computed feed lists don't belong in the transactional DB on the hot read path — they belong in memory. Let me add a <strong>feed cache</strong> (Redis) holding each user's timeline as a list of post ids: <code>timeline:userId</code> maps to an ordered list of ids. Fan-out writes push ids into these Redis lists, and a read becomes a single range read by cursor — sub-millisecond. The DB drops out of the read path almost entirely; it becomes the durable store of record and the hydration source, not the per-read list builder."},
      {who:"intv",text:"What does the cache store versus the DB, and what's the read path now?"},
      {who:"cand",text:"The <strong>feed cache holds ordered lists of post ids</strong> per user — small and bounded; the <strong>DB holds canonical posts and the follow graph</strong> — large and durable. Read path: range-read the page of ids from Redis, then <strong>hydrate</strong> those ids (post bodies, authors, media refs) in parallel, then return.<span class='eg'>Ids not bodies: 800 ids at 8 bytes is about 6KB per user, so millions of feed lists fit in memory.</span>I trim each list to the top few hundred ids, since nobody scrolls past that in a session; older entries page from the DB on demand."},
      {who:"intv",text:"You've made the cache load-bearing for every read. What happens when a cache node dies?"},
      {who:"cand",text:"The feed cache is <strong>reconstructable, not authoritative</strong> — every list is derivable from the durable posts plus the follow graph. So I run it replicated for availability, and on a genuine miss I <strong>rebuild on demand</strong> from source rather than returning empty. A cache node loss is a latency event, not a correctness or data-loss event. That failure mode — a node coming back cold and cold-missing millions of feeds at once — is worth its own drill-down."},
    ],resources:[
      {title:"Redis — data types (lists)",url:"https://redis.io/docs/latest/develop/data-types/"},
      {title:"System Design Primer — the Twitter timeline",url:"https://github.com/donnemartin/system-design-primer#design-the-twitter-timeline-and-search"},
    ]},
    {title:"A celebrity with 50M followers posts — fan-out melts",tag:"scaling",turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> fan-out on write hums along until a celebrity with <b>50M</b> followers posts. That one post becomes <b>50M</b> feed-list writes, the fan-out tier and cache saturate, and delivery falls minutes behind for everyone. Rethink it.</span>"},
      {who:"cand",text:"Pure fan-out on write melts on the extreme tail, so I go <strong>hybrid, split by author popularity</strong>. The vast majority of accounts still <strong>fan out on write</strong> — cheap, and reads stay instant. For a small set of <strong>celebrities above a follower threshold</strong> I do <em>not</em> fan out; their posts stay in a per-author recent-posts list, and I <strong>merge them in at read time</strong>.<span class='eg'>Follow 300 accounts, 3 of them celebrities: feed = the pre-built list of ~297 normal authors merged with 3 short per-author lists at read time.</span>So 50M writes for one post become zero fan-out writes plus a tiny bounded merge only the followers who actually load their feed ever pay."},
      {who:"intv",text:"Where's the threshold, and doesn't the read-time merge itself get expensive for someone following hundreds of celebrities?"},
      {who:"cand",text:"The threshold is tuned empirically — roughly where fan-out cost outweighs read-merge cost, often somewhere around 10K to 1M followers depending on how often they post. The merge stays bounded because a real user follows only a handful of celebrities, and I cap the read-time pull-in and rank a bounded candidate set. The rare account that follows thousands of big accounts gets its celebrity-merge result cached briefly so repeat loads don't re-merge. Neither pure model's worst case can happen: normal authors never make reads expensive, celebrities never make writes explode."},
      {who:"intv",text:"For the mid-tier accounts that still fan out, reading their million-follower list as one query pins a single shard. Handle that."},
      {who:"cand",text:"I <strong>sub-partition</strong> a large follower list across many nodes and read it as a <strong>parallel, paged scan</strong>, streaming ids in chunks to the fan-out workers rather than materializing millions at once. Each partition serves a slice, so load spreads N-ways and no single node is pinned, and the workers consume the stream in batches without ever holding the whole list in memory. So the true tail uses read-time merge and never does the big read, while the upper-mid tier that still fans out does it as a distributed streaming scan."},
    ],resources:[
      {title:"System Design Primer — fan-out",url:"https://github.com/donnemartin/system-design-primer#fan-out"},
      {title:"System Design Primer — the Twitter timeline",url:"https://github.com/donnemartin/system-design-primer#design-the-twitter-timeline-and-search"},
    ]},
    {title:"A feed-cache node comes back empty — cold-miss storm",tag:"durability",turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a feed cache node restarts and comes back <b>empty</b>. Every user whose timeline lived on it now cold-misses — feed reads have nothing to return, and the app shows blank feeds for <b>millions</b> of users at once. Contain it.</span>"},
      {who:"cand",text:"A blank feed is worse than a slow feed, so the rule is never return empty. Containment: <strong>(1)</strong> run the feed cache as a <strong>replicated cluster</strong> so a node restart fails over to a replica that still holds the lists rather than losing the tier. <strong>(2)</strong> if a list genuinely isn't cached, <strong>rebuild on demand</strong> from source — who they follow plus recent posts from the DB, the same cold-build path a returning user hits. <strong>(3) request coalescing</strong> so a thundering herd of misses for the same popular feeds collapses into one rebuild instead of thousands."},
      {who:"intv",text:"Rebuilding millions of feeds from the DB at once just moves the meltdown to the DB. Then what?"},
      {who:"cand",text:"So I don't rebuild eagerly. Because the cache is derived, I rebuild <strong>lazily — only when a user actually loads</strong>, which naturally spreads the work across the real traffic pattern instead of one synchronized stampede. I protect the DB with per-shard rate limits and coalescing, serve slightly stale results where I can, and I <strong>shard the cache widely</strong> so any one node holds only a modest slice and its loss has a small blast radius. The cache dying stays a latency event, not a correctness one, because everything in it is recomputable."},
      {who:"intv",text:"So you're comfortable the feed cache holds no durable data at all?"},
      {who:"cand",text:"Yes, deliberately — the <strong>durable truth</strong> is the canonical posts and the follow graph in the DB, and any feed list is a <em>recomputable</em> view of those. I can bolt on durability as an <em>optimization</em> — Redis snapshots so a node reloads warm rather than empty, and replicas that keep lists live through a single-node failure — but those speed recovery, they don't change the truth model. No scenario where the cache loses data can lose a user's actual content; worst case it costs a rebuild."},
    ],resources:[
      {title:"Redis — data types (sorted sets)",url:"https://redis.io/docs/latest/develop/data-types/"},
      {title:"System Design Primer — the Twitter timeline",url:"https://github.com/donnemartin/system-design-primer#design-the-twitter-timeline-and-search"},
    ]},
    {title:"Replication lag: a user posts but doesn't see it",tag:"failover",turns:[
      {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a user posts, then immediately pulls to refresh their own home feed — and the post isn't there. The write went to the primary; the feed read hit a replica or cache about <b>500ms</b> behind fan-out. Read-your-writes just broke, and to the user it looks like the post failed. Fix it.</span>"},
      {who:"cand",text:"Read-your-writes on your own timeline is sacred — if you don't see your own post you'll post it again. Fixes, cheapest first: <strong>(1)</strong> on a successful post, <strong>synchronously insert it into the author's own feed list</strong> before returning 200, so the self-view is guaranteed even before async fan-out reaches others. <strong>(2)</strong> the client already holds the post from its optimistic-UI ack, so it can prepend locally regardless of server lag. <strong>(3)</strong> for a short window after a write, <strong>pin that user's feed reads to the freshest source</strong> — the primary or authoritative cache — rather than a lagging replica."},
      {who:"intv",text:"The self-insert covers the author. But their post still trickles out to 50M followers over seconds. Acceptable, and how do you bound it?"},
      {who:"cand",text:"For <em>followers</em>, eventual is fine — nobody expects a stranger's post the same millisecond it's written, and a second or two is imperceptible. What I bound is the <strong>tail</strong>: fan-out must not take minutes. I <strong>prioritize the delivery queue</strong> (fresh posts ahead of backfill), scale fan-out workers with the backlog, and for celebrities skip fan-out entirely via read-time merge so there's no 50M-write tail at all. Author sees it instantly, active followers within a second or two, inactive followers whenever they next load — which is exactly when it matters."},
      {who:"intv",text:"Now the harder version: the write-primary itself fails the instant they post. You promote a replica, then the old primary rejoins thinking it's still primary. What breaks and how do you prevent it?"},
      {who:"cand",text:"That's <strong>split-brain</strong> — two primaries taking divergent writes to the same post and edge keys, which corrupts the graph. Prevention is <strong>consensus-based promotion</strong>: leader election issues a monotonically increasing <strong>epoch</strong>, the new primary writes under a higher epoch, and when the stale old primary rejoins its writes are <strong>rejected via the fencing token</strong> and it re-syncs. Writes on that shard pause for the few-second election — I pick consistency over availability for writes there — but <strong>reads stay up from replicas</strong>, so timelines keep loading. Because post ids are globally unique and fan-out is async and idempotent, the paused writes simply retry and land after promotion with no duplicates."},
    ],resources:[
      {title:"Instagram Engineering — sharding IDs",url:"https://instagram-engineering.com/sharding-ids-at-instagram-1cf5a71e5a5c"},
      {title:"System Design Primer — the Twitter timeline",url:"https://github.com/donnemartin/system-design-primer#design-the-twitter-timeline-and-search"},
    ]},
  ],
  q:{
    client:[
      {l:"medium",tag:"concept",q:"Cursor vs offset pagination for an infinite feed.",turns:[
        {who:"intv",text:"The feed is infinite scroll. The client asks for 'the next 20.' Do you page with <code>OFFSET</code> or a cursor? Be concrete about what breaks."},
        {who:"cand",text:"A <strong>cursor</strong>, not offset. Offset pagination re-scans and re-counts from the top every page, so it gets slower the deeper you scroll, and — worse for a feed — it's unstable: new posts arrive at the head between page loads, so <code>OFFSET 20</code> now points at a different item and the user sees duplicates or skips.<span class='eg'>Read page 1 (items 1-20). Two new posts arrive. Page 2 with OFFSET 20 re-includes items 19-20 you already saw.</span>A cursor encodes a stable position — <code>(score, post_id)</code> or a snowflake id — and I say 'give me items after this cursor,' which is O(1) to seek and immune to head churn."},
        {who:"intv",text:"What exactly goes in the cursor, and how does the client not lose its place if the ranking changes?"},
        {who:"cand",text:"The cursor is an opaque, server-signed token wrapping the ranking key of the last item returned plus a snapshot marker. I <strong>pin the candidate set for a scroll session</strong>: the ranked list is materialized once at the first page (in the feed cache), and paging just walks down that frozen list by cursor. New posts don't reshuffle a live scroll — they surface via the 'N new posts' banner at the top, not by rewriting the page under the user's thumb. So the cursor stays valid for the session and pagination is stable and cheap."},
      ],resources:[
        {title:"System Design Primer — the Twitter timeline",url:"https://github.com/donnemartin/system-design-primer#design-the-twitter-timeline-and-search"},
        {title:"ByteByteGo — system design patterns",url:"https://bytebytego.com/"},
      ]},
      {l:"medium",tag:"concept",q:"How does the 'N new posts' banner work?",turns:[
        {who:"intv",text:"Twitter shows a 'N new posts' pill at the top of a feed you're already looking at. How does the client know N without re-downloading the whole feed?"},
        {who:"cand",text:"The client holds the ranking key of the newest item it has rendered. It periodically asks a cheap endpoint <code>GET /timeline/count?since=cursor</code> which returns just a <em>number</em> — how many items in the user's feed list sit above that cursor — not the items themselves. That's a length lookup against the head of their feed cache list, milliseconds and bytes. When the user taps the pill, then I fetch the actual posts and prepend them."},
        {who:"intv",text:"That count endpoint fires from every open app. What's the cost and how do you keep it honest?"},
        {who:"cand",text:"It's the highest-frequency call in the system, so it must be trivially cheap: a bounded range-count on a Redis list, no hydration, no DB. I also <strong>cap and coarsen</strong> — I return <code>20+</code> rather than an exact 4,312, so a hot account doesn't force an expensive precise count, and I add jitter to the client poll interval so a million clients don't all ask on the same tick. If the count is stale by a few seconds that's completely fine; it's a nudge, not a source of truth."},
      ],resources:[
        {title:"Redis — data types (lists)",url:"https://redis.io/docs/latest/develop/data-types/"},
        {title:"System Design Primer — the Twitter timeline",url:"https://github.com/donnemartin/system-design-primer#design-the-twitter-timeline-and-search"},
      ]},
      {l:"hard",tag:"scaling",q:"Millions of clients polling for new posts.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> 50M clients are foregrounded during a live event, each polling that new-post-count endpoint every 5 seconds. That's <b>10M requests/s</b> of pure 'anything new?' traffic slamming your edge. The real read/write load is on top. How do you not fall over?</span>"},
        {who:"cand",text:"Polling at that fan-in is the enemy. Layered fixes: <strong>(1)</strong> back off adaptively — clients poll slower when the feed is quiet, faster only after activity, and always with jitter so requests don't synchronize. <strong>(2)</strong> serve the count from the <strong>edge/feed cache</strong>, never the origin DB — it's a list-length read that a Redis tier absorbs at that rate. <strong>(3)</strong> for the live-event case, flip hot users to a <strong>push channel</strong> — a persistent WebSocket/SSE connection where the server pushes 'new posts available' instead of millions polling. Push replaces N polls per second with one idle connection that only wakes on real events."},
        {who:"intv",text:"Persistent connections for 50M clients isn't free either. When is push actually worth it?"},
        {who:"cand",text:"It's a trade: push turns request-rate load into connection-count load — memory and file descriptors on a connection tier — but kills the wasted 'nothing changed' round-trips, which are the vast majority of polls. So I use it selectively: push during high-engagement windows (live events, spikes) and for highly active sessions; fall back to adaptive polling for the long tail of mostly-idle apps. The connection tier is horizontally sharded and stateless-per-connection, so it scales by adding nodes, and a dropped connection just degrades that user to polling — no correctness impact."},
      ],resources:[
        {title:"ByteByteGo — system design patterns",url:"https://bytebytego.com/"},
        {title:"System Design Primer — the Twitter timeline",url:"https://github.com/donnemartin/system-design-primer#design-the-twitter-timeline-and-search"},
      ]},
      {l:"medium",tag:"failover",q:"User posts, loses signal mid-request — dupes?",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a user on a subway taps Post. The request leaves the phone, the server commits it, but the response never arrives — the tunnel kills the connection. The app auto-retries when signal returns. Now what?</span>"},
        {who:"cand",text:"Without care that's a <strong>duplicate post</strong>. The fix is a <strong>client-generated idempotency key</strong> — the app mints a UUID for that compose action and sends it on every retry. The server dedupes on it: the first commit records the key, and any retry with the same key returns the <em>same</em> post id instead of creating a second one. So the retry is safe and the user sees exactly one post."},
        {who:"intv",text:"And the UX while the post is in flight and unconfirmed?"},
        {who:"cand",text:"<strong>Optimistic UI</strong>: I render the post immediately in the composer's local state marked 'sending,' so the app feels instant. On ack it flips to 'posted'; on repeated failure it shows 'failed — retry,' keeping the idempotency key so the retry can't dupe. The key insight is that the client is the one place with a stable identity for the intent, so it owns dedup — the server just honors the key. This is the same read-your-writes concern the feed service handles on the read side; here it's on the write side."},
      ],resources:[
        {title:"ByteByteGo — system design patterns",url:"https://bytebytego.com/"},
      ]},
      {l:"medium",tag:"capacity",q:"How big is the push-connection tier during a live event?",turns:[
        {who:"intv",text:"You flip hot users onto persistent push connections during a live event. Concrete numbers: how many connection-tier nodes do you provision, and what bounds one node? Show the math."},
        {who:"cand",text:"Size it from memory per connection. A persistent WebSocket is mostly idle — a file descriptor, socket buffers, a little session state — call it ~10KB resident, and the bound per node is memory and fd limits, not CPU, since idle sockets do almost nothing.<span class='eg'>50M foregrounded clients in a live event x ~10KB = ~500GB of connection state. Budget ~2GB per node to connections after overhead → ~200K connections/node → 50M / 200K = 250 nodes. Add ~30% headroom → ~325.</span>I spread them across AZs so one AZ loss drops a third of capacity, not the whole tier."},
        {who:"intv",text:"325 nodes just to hold idle sockets sounds heavy. What cuts it?"},
        {who:"cand",text:"The count is driven by how many clients I keep connected at once, and I do not need all 50M on push. The trade-off: push turns request-rate load into connection-count load, so I only pay it where it earns out — highly active sessions and live-event windows — and leave the mostly-idle long tail on adaptive polling, which holds zero persistent state. That drops concurrent connections to the genuinely engaged fraction, maybe a few million, so the tier is tens of nodes, not hundreds. The lever is the connect threshold: too aggressive and I provision hundreds of nodes for sockets that never fire; too conservative and I lose the polling-flood relief. So I size for the engaged working set and shed to polling above it."},
      ],resources:[
        {title:"ByteByteGo — system design patterns",url:"https://bytebytego.com/"},
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
      ]},
    ],
    lb:[
      {l:"medium",tag:"concept",q:"LB vs gateway, and read path vs write path.",turns:[
        {who:"intv",text:"You drew 'LB + gateway' as one box. A <code>GET /timeline</code> and a <code>POST /post</code> both land here. Walk me through each, and be precise about LB vs gateway."},
        {who:"cand",text:"The <strong>load balancer</strong> is L4/L7 distribution across healthy instances with health-check ejection. The <strong>gateway</strong> owns cross-cutting concerns: TLS, auth/session, request validation, and <strong>rate limiting</strong>.<br><br><code>GET /timeline</code> is authenticated, then routed to the feed service's read path — this is the high-volume, latency-critical traffic, so I keep it as cheap as possible and lean on the feed cache behind it. <code>POST /post</code> is authenticated, validated, rate-limited (writes are heavier and abuse-prone), and routed to the write path, which persists the post and kicks off fan-out."},
        {who:"intv",text:"Why rate-limit writes so much more aggressively than reads?"},
        {who:"cand",text:"Because a write amplifies. One <code>POST /post</code> can trigger up to tens of millions of downstream fan-out writes, so an abusive write loop is far more dangerous than an abusive read loop — a spam bot posting in a tight loop can multiply into a fan-out flood. Reads are self-limiting per user and cache-absorbed. So the gateway enforces strict per-user and per-IP post limits, plus spam heuristics, before a write is ever allowed to reach the fan-out machinery."},
      ],resources:[
        {title:"System Design Primer — the Twitter timeline",url:"https://github.com/donnemartin/system-design-primer#design-the-twitter-timeline-and-search"},
        {title:"ByteByteGo — system design patterns",url:"https://bytebytego.com/"},
      ]},
      {l:"medium",tag:"concept",q:"Where do timeline reads get routed and cached at the edge?",turns:[
        {who:"intv",text:"You said reads should be cheap. What can the edge actually do for a <em>personalized</em> home timeline, which is different for every user?"},
        {who:"cand",text:"Less than for a public page, since a home timeline is per-user and can't be shared-cached at the CDN. But the edge still earns its keep: TLS termination close to the user, connection reuse, and routing the request to the nearest region that holds that user's feed. The <em>content</em> that is shareable — media, and public profile/post pages — does get CDN-cached. The personalized list itself I serve from the per-user feed cache in-region, not the CDN."},
        {who:"intv",text:"So personalization kills edge caching of the feed. Any part of the read you can still push outward?"},
        {who:"cand",text:"Two things. First, the <strong>new-post count</strong> endpoint is tiny and near-cacheable at the edge with a very short TTL. Second, I do <strong>region affinity</strong>: pin a user to a home region so their feed cache and follow-graph reads are local, avoiding cross-region round-trips on the hot path. The edge's job here is proximity and routing, not content caching — I accept that the personalized list is an in-region cache read, and I make that read fast rather than pretending the CDN can hold it."},
      ],resources:[
        {title:"Cloudflare — what is a CDN?",url:"https://www.cloudflare.com/learning/cdn/what-is-a-cdn/"},
        {title:"System Design Primer — the Twitter timeline",url:"https://github.com/donnemartin/system-design-primer#design-the-twitter-timeline-and-search"},
      ]},
      {l:"hard",tag:"scaling",q:"A live event spikes read traffic 5x in a minute.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a major live event starts. Everyone opens the app at once — timeline reads jump from 70K/s to <b>350K/s</b> in under a minute, plus the polling flood on top. Your LB tier and feed fleet were sized for normal load. What falls over first, and what do you do?</span>"},
        {who:"cand",text:"First to feel it is the <strong>feed service fleet</strong>, then the <strong>feed cache</strong> if hit rates dip. Defenses, layered: <strong>(1)</strong> the feed fleet autoscales on request rate and connection count — it's stateless, so I add pods. <strong>(2)</strong> the LB is horizontally redundant and connection-based; it scales by adding nodes and shedding at the edge. <strong>(3)</strong> most of this surge is <em>reads of pre-computed feeds</em> sitting in the feed cache, which is the whole point of fan-out-on-write — the DB barely feels it. <strong>(4)</strong> load-shedding as a safety valve: under extreme overload, degrade gracefully — serve a slightly staler cached feed, drop the count-poll frequency, shed non-critical calls — rather than collapse."},
        {who:"intv",text:"Autoscaling isn't instant — pods take a minute or two to warm. What covers the gap?"},
        {who:"cand",text:"Headroom plus shedding. I run the fleet with enough baseline over-provisioning to absorb a couple of minutes of surge, and I <strong>pre-scale</strong> ahead of known events (live sports, product launches) since those are predictable. For the unpredictable spike, the gateway does <strong>prioritized load-shedding</strong>: protect timeline reads and post writes, shed the expensive/optional stuff first (exact counts, recommendations), and return cached-but-stale feeds instead of erroring. The user gets a feed that's a few seconds old rather than a spinner — a far better failure mode while capacity catches up."},
      ],resources:[
        {title:"System Design Primer — the Twitter timeline",url:"https://github.com/donnemartin/system-design-primer#design-the-twitter-timeline-and-search"},
        {title:"ByteByteGo — system design patterns",url:"https://bytebytego.com/"},
      ]},
      {l:"hard",tag:"failover",q:"An entire region goes dark.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> your us-east-1 region has a full network partition — LB, feed fleet, caches, and DB replicas there are all unreachable. 40% of your users are homed there. What do they experience in the first 30 seconds, and how do you make it a non-event?</span>"},
        {who:"cand",text:"Without preparation: 40% of users get a dead app — no feed, no posting. To make it a non-event I rely on <strong>GeoDNS/anycast with health checks</strong>: the DNS layer detects us-east-1 failing checks and stops resolving users to it, steering them to the next-nearest healthy region within the health-check interval (~10-30s, tunable). For that to actually work, each region must hold a usable copy of those users' data — follow graph and recent feeds replicated cross-region — so a surviving region can rebuild or serve their timelines."},
        {who:"intv",text:"Reads can be served from a replica. But those users' writes — their posts — were homed in us-east-1. Now what?"},
        {who:"cand",text:"Reads are the easy part since feeds and graph are replicated read-mostly. Writes are the asymmetry. Two options: <strong>(a)</strong> the failed-over region accepts their posts and reconciles when us-east-1 returns, which needs conflict-free post ids (globally-unique, region-independent — snowflake-style) so there's no id collision, or <strong>(b)</strong> post is briefly unavailable for those users while reads stay up. I'd design for (a): posts get globally-unique ids at creation, so any region can accept a write with zero coordination. That turns a region loss into a capacity/latency event, not a correctness one — and reading the feed, which is what matters most, never stops."},
      ],resources:[
        {title:"Consistent hashing",url:"https://en.wikipedia.org/wiki/Consistent_hashing"},
        {title:"Instagram Engineering — sharding IDs",url:"https://instagram-engineering.com/sharding-ids-at-instagram-1cf5a71e5a5c"},
      ]},
      {l:"medium",tag:"capacity",q:"How many gateway nodes for peak traffic?",turns:[
        {who:"intv",text:"Numbers. Peak is ~300K timeline reads/s plus the count-poll flood on top, all landing on the LB + gateway first. How many gateway nodes do you run, and what sizes them — throughput or connections?"},
        {who:"cand",text:"Connections bind first at the edge — every client holds a keep-alive and the poll flood is many short requests — but I size from a per-node request budget since that is the scarce resource. An L7 gateway node doing TLS, auth, and rate-limiting handles maybe ~50K req/s.<span class='eg'>Real requests: ~300K/s reads + ~4K/s writes ≈ 305K/s → 305K / 50K ≈ 7 nodes. But the count-poll flood is 50M clients every 5s ≈ 10M/s; sized against that raw rate it would be 10M / 50K ≈ 200 nodes. Add ~30% headroom.</span>So the poll flood, not the real reads, is what would dominate gateway sizing."},
        {who:"intv",text:"So the poll flood sets your node count. That is a lot of gateway just to answer whether anything is new. What do you do about it?"},
        {who:"cand",text:"I refuse to size the whole tier for pure nothing-changed traffic. The trade-off is scale the fleet to ~200 nodes (cost) versus push the flood off it (complexity), and I push it off: serve the count from the edge/feed-cache with a short TTL so it never reaches an app-serving gateway, add client backoff and jitter so idle apps poll slowly, and flip live-event users to push. That collapses the ~10M/s of effective work back toward the ~305K/s of real requests, so the tier lands around 10-15 nodes across 3 AZs, not 200. I size for real reads and writes and treat the poll flood as something to absorb at the edge, not provision for."},
      ],resources:[
        {title:"ByteByteGo — system design patterns",url:"https://bytebytego.com/"},
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
      ]},
    ],
    feed:[
      {l:"medium",tag:"concept",q:"Walk me through building a home timeline end to end.",turns:[
        {who:"intv",text:"Take me through exactly what happens on <code>GET /timeline</code> for a user who follows 300 people. Every step, and be precise about what you fetch."},
        {who:"cand",text:"In the pre-computed model: <ul><li><strong>Read the feed list</strong> — a per-user list of <em>post ids</em> (not posts), already ranked, from the feed cache: <code>timeline:userId → [postId, postId, ...]</code>.</li><li><strong>Take a page</strong> — the top N ids by cursor.</li><li><strong>Hydrate</strong> — scatter-gather those N post ids against the post store (and author profiles, media urls) in parallel.</li><li><strong>Assemble + return</strong> the page.</li></ul>The key decisions: I store <strong>post ids, not post bodies</strong>, in the feed list, and hydration is a <strong>parallel multi-get</strong>, not N serial reads."},
        {who:"intv",text:"Why store ids and not the posts themselves in the feed list? Storing bodies would save the hydration step."},
        {who:"cand",text:"Because a post lands in the feed lists of all its followers — for a popular author, millions of lists. If I stored the <em>body</em> I'd duplicate that post millions of times, and an edit or delete would have to find and rewrite millions of copies. Storing the <strong>id</strong> means one canonical post in the post store; every feed list holds a cheap 8-byte reference. Hydration re-reads the canonical copy at view time, so edits/deletes are automatically reflected and the feed lists stay tiny — which is exactly what lets me keep millions of them in cache.<span class='eg'>Post body ~1KB x 5M followers = 5GB per celebrity post if inlined; as ids it's 5M x 8B = 40MB, and one 1KB canonical copy.</span>"},
        {who:"intv",text:"Hydration is a scatter-gather to many shards. One shard is slow. Does the whole page stall?"},
        {who:"cand",text:"It shouldn't. Hydration fans out in parallel with a <strong>tight per-shard timeout</strong> and I gather what returns within a deadline. A single slow shard means at worst one or two posts are momentarily missing from the page, not a stalled timeline — I can drop them, backfill on the next page, or serve a cached copy. Tail latency is the real enemy in scatter-gather, so I hedge slow reads and cap the fan-out width by paging. The feed must render on a deadline; a perfect-but-late feed is a failed feed."},
      ],resources:[
        {title:"System Design Primer — the Twitter timeline",url:"https://github.com/donnemartin/system-design-primer#design-the-twitter-timeline-and-search"},
        {title:"Facebook TAO — the social graph store (USENIX)",url:"https://www.usenix.org/conference/atc13/technical-sessions/presentation/bronson"},
      ]},
      {l:"hard",tag:"scaling",q:"A celebrity with 50M followers posts — fan-out melts. (adds fan-out)",reveal:["fanout"],turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> your v1 builds every timeline on read — query who you follow, fetch their recent posts, merge, rank. It works until a celebrity with <b>50M followers</b> posts and the whole site slows down, and separately your read latency is already bad because every feed load is a huge fan-in query. Rethink the delivery model.</span>"},
        {who:"cand",text:"The read-time merge doesn't scale: every one of 300M feed loads does a large fan-in query and re-ranks live — that's the latency problem. The fix is to <strong>move the work to write time</strong>: <strong>fan-out on write</strong>. When someone posts, I push that post id into the pre-computed feed list of each follower, so a read is just 'return my already-built list' — cheap and fast. Let me add a <strong>fan-out service</strong> to do that delivery asynchronously off the write path. But pure fan-out-on-write is exactly what melts on the celebrity: one post = 50M list writes."},
        {who:"intv",text:"So which is it — fan-out on write or on read? You can't have both being the problem."},
        {who:"cand",text:"A <strong>hybrid</strong>, split by author popularity. For the vast majority (normal accounts), <strong>fan-out on write</strong> — cheap, and reads are instant. For a small set of <strong>celebrities above a follower threshold</strong>, I do <em>not</em> fan out; their posts stay in a per-author 'recent posts' list. At read time I take the user's pre-built feed (from normal authors) and <strong>merge in</strong> the recent posts of the handful of celebrities they follow — a small, bounded read-time merge. So 50M writes for one celebrity post become zero fan-out writes plus a tiny merge that only the followers who actually load their feed ever pay for.<span class='eg'>Follow 300 accounts, 3 are celebrities → feed = pre-built list of ~297 authors merged with 3 short per-author lists at read time.</span>"},
        {who:"intv",text:"Where's the threshold, and doesn't the merge itself get expensive for someone following 500 celebrities?"},
        {who:"cand",text:"The threshold is tuned empirically — roughly where fan-out cost outweighs read-merge cost, often ~10K-1M followers depending on their posting rate. The merge stays bounded because a user follows a <em>small</em> number of celebrities in practice, and I cap the read-time pull-in and rank only a bounded candidate set. Edge cases (a user following thousands of celebs) get their celebrity-merge results cached briefly so repeat loads don't re-merge. The whole point of the hybrid is that neither pure model's worst case can happen: normal authors never make reads expensive, celebrities never make writes explode."},
      ],resources:[
        {title:"System Design Primer — fan-out",url:"https://github.com/donnemartin/system-design-primer#fan-out"},
        {title:"System Design Primer — the Twitter timeline",url:"https://github.com/donnemartin/system-design-primer#design-the-twitter-timeline-and-search"},
      ]},
      {l:"medium",tag:"scaling",q:"Timeline reads are hammering the DB. (adds feed cache)",reveal:["cache"],turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> even with fan-out on write, you're materializing feed lists by querying the DB on every read. At 70K feed reads/s the post+graph DB's p99 climbs past 400ms and CPU pegs. Reads are timing out. What's your move?</span>"},
        {who:"cand",text:"The pre-computed feed lists don't belong in the transactional DB on the hot read path — they belong in memory. Let me add a <strong>feed cache</strong> — Redis — holding each user's timeline as a list of post ids: <code>timeline:userId → [ids]</code>. Fan-out writes push ids into these Redis lists, and a read is a single <code>LRANGE</code> by cursor, sub-millisecond. The DB drops out of the read path almost entirely — it becomes the durable store of record and the hydration source, not the per-read list builder."},
        {who:"intv",text:"Cache added. What's the read path now, and what does the cache actually store versus the DB?"},
        {who:"cand",text:"Read path: <code>LRANGE timeline:userId</code> to get the page of ids from Redis → hydrate those ids (post bodies, authors) which may themselves be cached → return. The <strong>feed cache holds ordered lists of post ids</strong> per user (small); the <strong>DB holds canonical posts and the follow graph</strong> (large, durable). The list is trimmed to a bounded length — I only keep the top few hundred ids per user, since nobody scrolls past that in a session, and older entries page from the DB on demand. Redis stays small because it's ids not bodies, and bounded not unbounded — which we should dig into, because I can't hold a feed list for every user who ever signed up."},
      ],resources:[
        {title:"Redis — data types (lists)",url:"https://redis.io/docs/latest/develop/data-types/"},
        {title:"System Design Primer — the Twitter timeline",url:"https://github.com/donnemartin/system-design-primer#design-the-twitter-timeline-and-search"},
      ]},
      {l:"medium",tag:"concept",q:"Serving images and video in the feed. (adds media / CDN)",reveal:["media"],turns:[
        {who:"intv",text:"Every post can have a photo or a video. So far you've only moved ids and text around. How does a 4K video in someone's post actually reach a follower's screen without wrecking your latency budget?"},
        {who:"cand",text:"Media never touches the feed/post hot path as bytes — I keep <strong>only a reference</strong> in the post: an id/url pointing at object storage, plus thumbnail metadata. The actual bytes are served by a dedicated <strong>media + CDN</strong> path. Let me add that component. On upload, the client puts the file straight into object storage; on view, the feed returns the media url and the client fetches the bytes from the <strong>CDN edge</strong>, close to the user, in parallel with rendering the text. So a 4K video is a CDN download the app streams — my feed response stays a few KB of JSON."},
        {who:"intv",text:"A 4K upload from a phone and playback on a 3G connection are very different problems. How do you handle both?"},
        {who:"cand",text:"Uploads go <strong>direct to object storage via a pre-signed URL</strong> so large files bypass my app servers entirely. Then an async pipeline <strong>transcodes</strong> the source into multiple renditions and bitrates. Playback uses <strong>adaptive bitrate streaming</strong> (HLS/DASH): the player picks a rendition matching the viewer's bandwidth and switches on the fly, so the 3G viewer gets a low bitrate that doesn't stall and the wifi viewer gets full quality. All renditions sit behind the CDN. We can drill into that pipeline on the media box — the point here is the feed just carries a reference, and bytes flow on a separate, CDN-fronted path."},
      ],resources:[
        {title:"Apple — HTTP Live Streaming (HLS)",url:"https://developer.apple.com/streaming/"},
        {title:"Cloudflare — what is a CDN?",url:"https://www.cloudflare.com/learning/cdn/what-is-a-cdn/"},
      ]},
      {l:"hard",tag:"durability",q:"Post is acked, then the service crashes before fan-out.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a user posts. The feed service writes the post to the DB, returns 200, and then the pod is SIGKILLed before it enqueues the fan-out job. The post exists but reached <b>zero</b> follower feeds. To the author it looks posted; to everyone else it never happened. How do you guarantee delivery?</span>"},
        {who:"cand",text:"This is a lost-update-across-systems problem: I committed the post but the fan-out never got durably scheduled. The fix is the <strong>transactional outbox</strong> pattern: in the same DB transaction that writes the post, I write a <code>fanout_pending</code> row (or event) to an outbox table. A separate relay reads the outbox and publishes fan-out jobs to the queue, marking them done only after the queue acks. So the post and its intent-to-fan-out commit atomically — a crash after the 200 leaves a durable outbox row that the relay will pick up and process. No post can be acked without a durable fan-out obligation."},
        {who:"intv",text:"The relay might publish the same fan-out job twice (crash after publish, before marking done). Followers get the post inserted twice?"},
        {who:"cand",text:"That's the at-least-once consequence of the outbox, and I make fan-out <strong>idempotent</strong> to absorb it. Inserting into a feed list is keyed by <code>(userId, postId)</code>, so a re-delivered job that inserts the same post id into the same feed is a no-op — a sorted-set add with the post id as member simply overwrites, it doesn't duplicate. So the relay can safely be at-least-once, fan-out replays are harmless, and the guarantee is: acked post ⇒ eventually in every follower's feed, exactly once, even across crashes."},
      ],resources:[
        {title:"Apache Kafka documentation",url:"https://kafka.apache.org/documentation/"},
        {title:"System Design Primer — fan-out",url:"https://github.com/donnemartin/system-design-primer#fan-out"},
      ]},
      {l:"hard",tag:"failover",q:"User posts but doesn't see it in their own feed.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a user posts, then immediately pulls to refresh their own home feed — and their post isn't there. The write went to the primary; the feed read hit a replica/cache that's ~500ms behind the fan-out. Read-your-writes just broke, and to the user it looks like the post failed. Fix it.</span>"},
        {who:"cand",text:"Read-your-writes on your own timeline is sacred — if you don't see your own post, you'll post again. Fixes, cheapest first: <strong>(1)</strong> on a successful post, <strong>synchronously insert it into the author's own feed list</strong> before returning 200 — the author's self-view is guaranteed even before async fan-out to others completes. <strong>(2)</strong> the client already holds the post from the optimistic-UI ack, so it can prepend locally regardless of server lag. <strong>(3)</strong> for a short window after a write, pin that user's feed reads to the freshest source (primary/authoritative cache) rather than a lagging replica."},
        {who:"intv",text:"The self-insert covers the author's own feed. But their post still trickles to 50M followers over seconds-to-minutes. Is that lag acceptable, and how do you bound it?"},
        {who:"cand",text:"For <em>followers</em>, eventual is fine — nobody expects a stranger's post the same millisecond it's written; seconds is imperceptible. What I must bound is the <strong>tail</strong>: fan-out shouldn't take minutes. I bound it by prioritizing the queue (recent posts fan out ahead of backfill), scaling fan-out workers with the backlog, and for celebrities avoiding fan-out entirely via the read-time merge so there's no 50M-write tail at all. So the author sees their post instantly (self-insert), active followers see it within a second or two, and the long tail of inactive followers gets it whenever they next load — which is exactly when it matters. The failure mode I refuse to allow is the author doubting their own post landed."},
      ],resources:[
        {title:"System Design Primer — the Twitter timeline",url:"https://github.com/donnemartin/system-design-primer#design-the-twitter-timeline-and-search"},
        {title:"System Design Primer — fan-out",url:"https://github.com/donnemartin/system-design-primer#fan-out"},
      ]},
      {l:"medium",tag:"capacity",q:"How many feed-service instances at peak?",turns:[
        {who:"intv",text:"Concrete. Peak timeline reads are ~300K/s. How many feed-service instances do you run? Show the math — do not just say autoscale."},
        {who:"cand",text:"Size it from per-instance throughput. The feed service is stateless — range-read a cached list, scatter-gather hydration, assemble JSON — so it is I/O-bound on the cache and post store, and a modern instance handles maybe ~5K req/s within the latency budget (I would confirm with a load test).<span class='eg'>Peak reads ~300K/s → 300K / 5K = 60 instances. Add ~30% headroom → ~80. Writes at ~4K/s peak need ~1-2 instances, negligible. Call it ~80 read-serving instances.</span>Spread across at least 3 AZs so an AZ loss drops a third, not the service."},
        {who:"intv",text:"80 for what is mostly a cache read and a fan-out. What moves that number?"},
        {who:"cand",text:"It is dominated by hydration fan-out width and cache-hit ratio, not the list read. The trade-off: if hydration hits warm caches for post bodies and authors, each read is cheap and I need fewer instances; if it misses and scatter-gathers to many shards, per-request cost rises and the count climbs. So the real lever is keeping hydration cached and paged — bound the fan-out width per page and hedge slow shards — which holds per-request cost flat and lets me run a warm floor of ~40 and autoscale on request rate above it. I provision for the busy-hour reads, not registration count, and lean on the cache tier to keep each request cheap."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"System Design Primer — the Twitter timeline",url:"https://github.com/donnemartin/system-design-primer#design-the-twitter-timeline-and-search"},
      ]},
    ],
    db:[
      {l:"medium",tag:"concept",q:"Datastore, schema, and sharding the follow graph.",turns:[
        {who:"intv",text:"Pick your datastore(s) and defend it, then give me the schema for posts and the follow graph, and how you shard hundreds of billions of edges."},
        {who:"cand",text:"Split by workload. <strong>Posts</strong>: a key-value / wide-column store (Cassandra/DynamoDB-style) — point lookup by post id, huge write throughput, no joins. Schema: <code>postId (PK) → {authorId, text, mediaRef, createdAt}</code>, sharded by hash of post id. <strong>Follow graph</strong>: a purpose-built social-graph store (TAO-style) over sharded storage, holding edges. The two queries I must serve fast are 'who does U follow?' (fan-out on read / building candidate authors) and 'who follows U?' (fan-out on write / delivery), so I store the edge <strong>bidirectionally</strong>: a <code>following</code> list and a <code>followers</code> list, both indexed."},
        {who:"intv",text:"Bidirectional means every follow is two writes and they can diverge. And how do you shard a list of 50M followers for one user?"},
        {who:"cand",text:"Two writes, yes — I write both directions and reconcile asynchronously; a background repair fixes any divergence, and the graph is eventually consistent (a momentarily missing edge just delays one feed insert, not correctness). For the <strong>50M-follower list</strong>, I can't put it on one shard or one key — that's a hot partition. I shard the followers of a single hot user <em>across many partitions</em> (sub-partition the edge list by a hash of the follower id) so reading or writing that list parallelizes across nodes instead of hammering one. Normal users' edge lists live on a single partition keyed by their id; only the hot ones get sub-partitioned."},
        {who:"intv",text:"Why a dedicated graph store instead of just a relational followers table with indexes?"},
        {who:"cand",text:"At this edge count and read rate, the workload is 'give me the neighbor list, fast, billions of times a second,' which is what a TAO-style store optimizes: a caching graph layer over sharded persistent storage, tuned for cheap association reads and list-range queries. A single relational table would need heavy sharding and caching bolted on to survive, essentially reinventing the graph store. The relational model is great for the authoritative edge record; the serving path wants the graph-cache layer in front of it."},
      ],resources:[
        {title:"Facebook TAO — the social graph store (USENIX)",url:"https://www.usenix.org/conference/atc13/technical-sessions/presentation/bronson"},
        {title:"Consistent hashing",url:"https://en.wikipedia.org/wiki/Consistent_hashing"},
      ]},
      {l:"medium",tag:"concept",q:"Store post ids or post bodies in the feed and graph?",turns:[
        {who:"intv",text:"You keep saying 'store ids, not posts.' Where's the canonical post body live, and what breaks if an id points at a post that's since been deleted?"},
        {who:"cand",text:"The <strong>one canonical body</strong> lives in the post store, keyed by post id. Everything else — feed lists, notifications, search — holds <em>references</em> to that id. So a delete is a single write: mark the canonical post deleted. At hydration time an id that resolves to a deleted/blocked post is simply filtered out of the page — the dangling reference in feed lists is harmless and gets trimmed lazily. I never chase down the millions of feed lists that referenced it."},
        {who:"intv",text:"So feed lists accumulate tombstoned ids forever? That's junk building up."},
        {who:"cand",text:"They accumulate a little, but two things bound it: feed lists are <strong>length-capped</strong> (top few hundred ids), so junk ages out of the window naturally as new posts push it off the end, and hydration filters deleted ids so users never see them. I don't need to eagerly purge — the cost of a filtered-out id at read time is negligible versus the cost of rewriting millions of lists on every delete. This is the core denormalization trade: cheap writes and self-healing reads in exchange for tolerating stale references, which the length cap and hydration filter make safe."},
      ],resources:[
        {title:"System Design Primer — the Twitter timeline",url:"https://github.com/donnemartin/system-design-primer#design-the-twitter-timeline-and-search"},
        {title:"Facebook TAO — the social graph store (USENIX)",url:"https://www.usenix.org/conference/atc13/technical-sessions/presentation/bronson"},
      ]},
      {l:"hard",tag:"scaling",q:"Reading a celebrity's 50M-follower list at post time.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> fan-out needs the follower list of a user with <b>50M followers</b> to deliver their post. Reading that list as one query pulls 50M ids and pins the shard that holds it at 100% while every other shard idles. The read itself is now the bottleneck. Fix it.</span>"},
        {who:"cand",text:"This is the hot-partition problem on the graph read side. Because I <strong>sub-partitioned</strong> the follower list of hot users across many nodes, I don't read it as one query — I read it as a <strong>parallel, paged scan across partitions</strong>, streaming ids in chunks to the fan-out workers rather than materializing 50M at once. Each partition serves a slice, so load spreads N-ways and no single node is pinned. Fan-out consumes the stream in batches and writes feed lists as it goes — it never needs the whole list in memory."},
        {who:"intv",text:"But for a celebrity you said you don't even fan out. So why does this read matter?"},
        {who:"cand",text:"Right — for true celebrities the hybrid skips fan-out, so I never do the 50M-follower read at all; their posts are pulled in at read time. This paged-scan matters for the <strong>upper-mid tier</strong>: accounts big enough to have millions of followers but below the celebrity threshold, where fan-out is still the right call. Those are exactly the ones that would pin a shard if read naively. So the two mechanisms compose: sub-partitioned parallel reads for the mid-tier that still fans out, and no-fan-out read-merge for the extreme tail. The follower-count threshold is the dial between them."},
      ],resources:[
        {title:"Facebook TAO — the social graph store (USENIX)",url:"https://www.usenix.org/conference/atc13/technical-sessions/presentation/bronson"},
        {title:"System Design Primer — fan-out",url:"https://github.com/donnemartin/system-design-primer#fan-out"},
      ]},
      {l:"hard",tag:"durability",q:"The shard holding a hot user's data fails.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> the single node holding the shard with a hot user's posts and follower edges has a disk failure and won't come back. That shard held billions of edges and millions of posts. Is that data gone? Walk me through your durability story.</span>"},
        {who:"cand",text:"If the shard were a single node, yes — catastrophic and unacceptable; posts and social graph are the product. The fix is <strong>replication</strong>: every shard is a replica group of ~3 nodes across separate failure domains (AZs), with writes acknowledged by a <strong>quorum</strong> before I return success. A disk failure on one replica loses nothing — the other two hold the data, reads fail over to them instantly, and a fresh replica rebuilds from the survivors. Durability comes from having the data in ≥2 places at all times, not from any one disk."},
        {who:"intv",text:"Quorum writes add latency to every post and every follow. Worth it, and do you read from replicas too?"},
        {who:"cand",text:"Worth it — writes aren't the hot path (reads are 20:1), and a few ms of quorum latency on a post is invisible next to losing posts. Yes, I read from replicas: it multiplies read capacity for the graph and post lookups. Because most reads tolerate slight staleness (a follow edge a few hundred ms behind just delays one feed insert), I serve them from the nearest replica, and reserve stronger reads for the rare cases that need them. So replication buys <strong>durability and read scaling</strong> from one mechanism — the same pattern that makes the failover story cheap."},
      ],resources:[
        {title:"System Design Primer — the Twitter timeline",url:"https://github.com/donnemartin/system-design-primer#design-the-twitter-timeline-and-search"},
        {title:"Facebook TAO — the social graph store (USENIX)",url:"https://www.usenix.org/conference/atc13/technical-sessions/presentation/bronson"},
      ]},
      {l:"hard",tag:"failover",q:"Write-primary dies — promote without split-brain.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> the write-primary for a post shard crashes. You promote a replica. Two minutes later the old primary rejoins, still believing it's primary — now two nodes accept writes to the same keys. What happens and how do you prevent it?</span>"},
        {who:"cand",text:"That's <strong>split-brain</strong>: two primaries taking divergent writes to the same post/edge keys means conflicting data — a corrupted social graph, the worst outcome. Prevention: promotion goes through a <strong>consensus / leader-election</strong> mechanism (Raft/Paxos or a fencing coordinator) that issues a monotonically increasing <strong>epoch/term</strong>. The new primary writes under a higher epoch; when the old primary rejoins with a stale epoch, replicas and clients <strong>reject its writes via the fencing token</strong>, and it's demoted and re-synced. There's never a moment when two nodes hold the current epoch."},
        {who:"intv",text:"During the election window, are writes to that shard just unavailable?"},
        {who:"cand",text:"Briefly, yes — that's the CAP trade-off: to avoid split-brain I choose <strong>consistency over availability for writes</strong> on that shard during the partition, so posts/follows targeting it pause for the election (typically a few seconds). Crucially, <strong>reads stay fully available</strong> from replicas throughout, so timelines keep loading — the traffic that dominates and matters most is unaffected. And because posts get globally-unique ids and fan-out is async and idempotent, the paused writes just retry and land after promotion with no duplication. I'd far rather a handful of posts retry for 3 seconds than corrupt the graph. Managed stores do this fencing internally, which is a strong reason to lean on them over hand-rolled failover."},
      ],resources:[
        {title:"Consistent hashing",url:"https://en.wikipedia.org/wiki/Consistent_hashing"},
        {title:"Facebook TAO — the social graph store (USENIX)",url:"https://www.usenix.org/conference/atc13/technical-sessions/presentation/bronson"},
      ]},
      {l:"medium",tag:"capacity",q:"How much storage and how many nodes for posts and the graph?",turns:[
        {who:"intv",text:"Size the datastore. You quoted ~1KB posts at ~300GB/day, plus a follow graph of billions of edges. How much storage, and how many nodes do you provision?"},
        {who:"cand",text:"Storage dominates here, so I size that then check throughput.<span class='eg'>Posts: 300GB/day x 365 x 5y ≈ 550TB raw; at replication factor 3 → ~1.65PB. Follow graph: 300M users x ~300 follows x 2 directions = 180B edges x ~50B ≈ 9TB raw, ~27TB replicated — small next to posts. Total ~1.7PB. At ~2TB usable/node → ~850 nodes; round to ~900 with headroom.</span>Throughput is easy by comparison — ~3,500 posts/s writes and the follow writes sit well under what 900 wide-column nodes serve, because the ~1M/s feed-list writes live in the cache, not here."},
        {who:"intv",text:"900 nodes holding 5 years of posts hot forever — wasteful?"},
        {who:"cand",text:"Yes, and I would tier rather than keep it all hot. The trade-off: posts are read overwhelmingly in the days after creation and then go cold, so keeping 5-year-old posts on the fast cluster pays for capacity almost nobody reads. I put recent posts on the fast tier and age older ones to cheaper cold storage with a slower lookup path, which can shrink the hot cluster several-fold. The cost is a latency cliff for the rare old-post read plus tiering complexity — acceptable because cold posts are, by definition, rarely fetched. So I provision the hot tier for the working set and let cold storage hold the long tail cheaply."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"Facebook TAO — the social graph store (USENIX)",url:"https://www.usenix.org/conference/atc13/technical-sessions/presentation/bronson"},
      ]},
    ],
    fanout:[
      {l:"medium",tag:"concept",q:"How fan-out on write actually delivers a post.",turns:[
        {who:"intv",text:"You added a fan-out service. Walk me through mechanically what it does when a normal user with 300 followers posts."},
        {who:"cand",text:"On a committed post, the feed service enqueues a fan-out job (post id + author id) to a <strong>queue</strong> (Kafka). Fan-out workers consume it, look up the author's <strong>followers list</strong> from the graph store, and for each follower <strong>insert the post id into that follower's feed list</strong> in the feed cache — a sorted-set add keyed by ranking score. For 300 followers that's 300 cheap list inserts, done async off the user's write path, typically within a second. The read side then just returns the pre-built list."},
        {who:"intv",text:"Why a queue in the middle at all — why not have the feed service write the follower feeds directly?"},
        {who:"cand",text:"Three reasons. <strong>Decoupling</strong>: the post write returns as soon as it's durable; delivery happens independently, so a slow fan-out never slows posting. <strong>Absorption</strong>: the queue buffers spikes — a burst of posts queues up and workers drain at their own rate instead of overwhelming the cache. <strong>Reliability</strong>: the queue is the durable hand-off (paired with the outbox), so a worker crash just means the job is redelivered and retried. Doing it inline would couple post latency to follower count and lose the retry/buffer safety net — unacceptable when one post can be tens of thousands of inserts."},
      ],resources:[
        {title:"System Design Primer — fan-out",url:"https://github.com/donnemartin/system-design-primer#fan-out"},
        {title:"Apache Kafka documentation",url:"https://kafka.apache.org/documentation/"},
      ]},
      {l:"hard",tag:"scaling",q:"Fan-out workers fall hours behind during a spike.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a huge event triggers a burst of posting by many large accounts. Fan-out work jumps to tens of millions of feed inserts per second, the queue backs up, and workers are now <b>hours behind</b> — posts are taking an hour to reach feeds. Fix the backlog.</span>"},
        {who:"cand",text:"First, the queue absorbing the backlog (rather than dropping) is working as designed — but an hour of latency is a product failure. Fixes: <strong>(1) scale workers horizontally</strong> — they're stateless consumers, so I add consumer instances and partitions to raise drain rate. <strong>(2) prioritize the queue</strong> — a high-priority lane for fresh posts and active-user feeds, a low-priority lane for backfilling inactive users, so the posts people are waiting on get delivered first. <strong>(3) lean harder on the hybrid</strong> — dynamically lower the celebrity threshold under load so big accounts stop fanning out and switch to read-time merge, instantly shedding the largest chunk of work."},
        {who:"intv",text:"You add workers but the follower-list reads and cache writes downstream are now the limit. Then what?"},
        {who:"cand",text:"Then I shed and defer, not pile on. <strong>Only fan out to active users</strong> — I don't need to insert into the feed list of someone who hasn't opened the app in weeks; their feed gets built on demand when they return. That can cut the write volume by an order of magnitude since active users are a fraction of total. For the rest, the post is already durable and discoverable via the author's profile and read-time pull, so deferring their feed insert is invisible. The principle: under backlog, deliver to who's watching now, compute the rest lazily. That, plus lowering the fan-out threshold, collapses the tens-of-millions/s down to something the cache tier comfortably drains."},
      ],resources:[
        {title:"System Design Primer — fan-out",url:"https://github.com/donnemartin/system-design-primer#fan-out"},
        {title:"Apache Kafka documentation",url:"https://kafka.apache.org/documentation/"},
      ]},
      {l:"hard",tag:"durability",q:"A worker crashes after delivering to 3M of 50M followers.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a mid-tier account with 50M followers posts and fans out. A worker processing that job crashes after inserting into <b>3M</b> feeds. The job is redelivered to another worker, which starts over from the top. Do the first 3M followers get the post twice?</span>"},
        {who:"cand",text:"No, because the insert is <strong>idempotent</strong>. Each feed list is a sorted set keyed by post id, so re-inserting the same post id for a follower who already has it is a no-op — it updates the score in place, never duplicates. So a redelivered job that re-processes the first 3M is harmless, and it continues on to the remaining 47M. At-least-once delivery from the queue plus idempotent inserts gives me effectively exactly-once feeds without needing the queue to guarantee exactly-once itself."},
        {who:"intv",text:"Restarting a 50M-follower job from scratch wastes the 3M already done. Can you avoid re-doing them?"},
        {who:"cand",text:"Yes — I <strong>chunk the fan-out job</strong>. Instead of one 50M-follower job, the delivery is split into many bounded sub-jobs (e.g. per follower-list partition, each a slice of ids), each independently acked to the queue. A crash only loses the in-flight chunk, which redelivers and re-processes at most a few thousand followers, not 3M. Chunking also parallelizes delivery across workers and makes progress checkpointable. So idempotency protects correctness and chunking protects efficiency — together, a worker crash costs one small re-processed slice, and every follower ends with exactly one copy."},
      ],resources:[
        {title:"Apache Kafka documentation",url:"https://kafka.apache.org/documentation/"},
        {title:"System Design Primer — fan-out",url:"https://github.com/donnemartin/system-design-primer#fan-out"},
      ]},
      {l:"medium",tag:"failover",q:"The fan-out queue is briefly unavailable.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> your Kafka cluster has a partial outage — some partitions are unavailable for a few minutes. Fan-out jobs for posts hashing to those partitions can't be enqueued. Are those posts lost from feeds, and does posting stall?</span>"},
        {who:"cand",text:"Posting must not stall and posts must not be lost. Because I use the <strong>transactional outbox</strong>, the post commit doesn't depend on Kafka being up — the fan-out intent is durably recorded in the outbox in the same transaction as the post. The relay that publishes to Kafka simply <strong>retries with backoff</strong> until the partitions recover, then drains the pending outbox rows. So during the outage posts still succeed, they just fan out a few minutes late — the outbox is the durable buffer that makes Kafka's availability non-blocking for writes."},
        {who:"intv",text:"Kafka itself — how is it configured so a broker failure doesn't lose enqueued jobs?"},
        {who:"cand",text:"Kafka runs <strong>replicated</strong>: each partition has replicas across brokers with a replication factor of 3, and I produce with <code>acks=all</code> so a job is only considered enqueued once it's on a quorum of replicas. A single broker failure triggers leader re-election for its partitions to an in-sync replica with no data loss, and consumers resume from their committed offsets. So the two durable layers compose: the outbox guarantees the job is never lost before Kafka accepts it, and Kafka's replication guarantees it's never lost after. A broker or partition blip becomes a short delivery delay, never a dropped post."},
      ],resources:[
        {title:"Apache Kafka documentation",url:"https://kafka.apache.org/documentation/"},
        {title:"System Design Primer — fan-out",url:"https://github.com/donnemartin/system-design-primer#fan-out"},
      ]},
      {l:"medium",tag:"capacity",q:"How many fan-out workers to keep delivery within seconds?",turns:[
        {who:"intv",text:"Numbers. Fan-out is ~1M feed-list writes/s on average and more at peak. How many fan-out workers do you run to keep delivery within seconds, and what sizes one worker?"},
        {who:"cand",text:"Size from per-worker insert throughput. A worker pulls a job, reads a follower slice, and does batched, pipelined inserts into the feed cache — network-bound, call it ~10K inserts/s per worker.<span class='eg'>Average ~1M writes/s → 1M / 10K = 100 workers. Peak 3-5x ≈ 3-5M/s → 300-500 workers; add headroom → ~600 at peak.</span>They are stateless queue consumers, so I scale by adding consumers and partitions, and let the queue absorb bursts so I size for sustained rate, not the instantaneous spike."},
        {who:"intv",text:"600 workers at peak is a lot. What keeps that from exploding on a celebrity storm?"},
        {who:"cand",text:"The hybrid and active-only delivery cap it well below the naive number. The trade-off: pure fan-out-on-write to every follower would push peak far past 5M/s on a celebrity storm and demand thousands of workers; instead celebrities skip fan-out entirely via read-time merge and I only deliver to active users. That strips the largest and the deadest work off the top, so the sustained rate workers actually see is a fraction of the raw 1M/s. The lever is the fan-out threshold and the activity window — I lower the threshold under backlog to shed more to read-time merge. So I provision ~150-200 workers for steady state and autoscale toward ~600 only under real surge, rather than sizing for a worst case the hybrid prevents."},
      ],resources:[
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
        {title:"System Design Primer — fan-out",url:"https://github.com/donnemartin/system-design-primer#fan-out"},
      ]},
    ],
    cache:[
      {l:"medium",tag:"concept",q:"What's in the feed cache, and ranking a bounded candidate set.",turns:[
        {who:"intv",text:"You said the feed cache holds ranked lists of post ids. Where does the ranking happen, and over what set of posts? You can't score everything a user could possibly see."},
        {who:"cand",text:"Right — ranking runs over a <strong>bounded candidate set</strong>, never the whole universe. The feed cache stores each user's timeline as a Redis sorted set: <code>timeline:userId → {postId: score}</code>. Candidates are assembled from a bounded window — the recent posts fanned in from followees plus the read-time celebrity merge, capped at, say, a few hundred to low thousands. Ranking scores <em>that</em> set by a model (recency, affinity, engagement signals) and the sorted set keeps them ordered. So a read is 'return top-N of an already-scored bounded list.'"},
        {who:"intv",text:"Give me a concrete size and why bounding it this way is safe."},
        {who:"cand",text:"<span class='eg'>Candidate set ~500-1,000 recent post ids per active user; feed list trimmed to top ~800 by score.</span>It's safe because engagement drops off a cliff with feed depth — nobody scrolls past a few hundred items in a session, so scoring 100K candidates would be wasted compute for items no one reaches. Bounding the set makes ranking cheap and constant-cost per user regardless of how prolific the people they follow are, and it keeps each cached list tiny so millions fit in memory. If a user does exhaust the list, I page older posts from the DB and score that next window on demand — ranking stays bounded per page, always."},
      ],resources:[
        {title:"Redis — data types (sorted sets)",url:"https://redis.io/docs/latest/develop/data-types/"},
        {title:"System Design Primer — the Twitter timeline",url:"https://github.com/donnemartin/system-design-primer#design-the-twitter-timeline-and-search"},
      ]},
      {l:"hard",tag:"scaling",q:"You can't hold a feed for all 500M users.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> you have 500M registered users but only ~300M are active, and a huge tail hasn't logged in for months. Pre-computing and caching a feed list for every registered user would need enormous memory and pointless fan-out writes. Bound it.</span>"},
        {who:"cand",text:"I <strong>only maintain feed caches for active users</strong>. Activity is defined by a recency window — logged in within the last N days — tracked cheaply (last-seen timestamp). Fan-out consults this and <em>skips</em> inactive followers entirely: no cached list, no delivery write. That does two things at once — it shrinks the cache to the working set that actually reads feeds, and it cuts fan-out write volume by the inactive fraction, which is often the majority. Active users are the only ones whose feeds anyone looks at, so this is free."},
        {who:"intv",text:"A dormant user comes back after two months. Their feed cache is empty or evicted. What do they see?"},
        {who:"cand",text:"Their feed is <strong>built on demand</strong> on that first load: I query who they follow, pull recent posts (fan-out on read for that one cold session), rank the bounded candidate set, and materialize their feed list into the cache — after which they're an active user again and fan-out resumes delivering to them. The first load is a bit slower (a cold build) but that's an acceptable one-time cost for a returning user, and it's amortized instantly. So the invariant is: feed caches exist for whoever is active <em>now</em>; everyone else's feed is a lazy computation triggered by their return. Memory tracks reality, not registration count."},
      ],resources:[
        {title:"Redis — data types (sorted sets)",url:"https://redis.io/docs/latest/develop/data-types/"},
        {title:"System Design Primer — fan-out",url:"https://github.com/donnemartin/system-design-primer#fan-out"},
      ]},
      {l:"hard",tag:"failover",q:"A feed cache node dies and its timelines cold-miss.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a feed cache node restarts and comes back <b>empty</b>. Every user whose timeline lived on it now cold-misses — their feed reads have nothing to return, and the app shows blank feeds for millions of users at once. Contain it.</span>"},
        {who:"cand",text:"A blank feed is worse than a slow feed, so the priority is: never return empty. Containment: <strong>(1)</strong> run the feed cache as a <strong>replicated cluster</strong> — each shard has replicas, so a node restart fails over to a replica that still holds the lists rather than losing the tier. <strong>(2)</strong> if a list genuinely isn't cached, <strong>rebuild on demand</strong> from source — the feed is reconstructable from the follow graph + recent posts in the DB, which is exactly the cold-build path. So a miss triggers a rebuild, not a blank. <strong>(3) request coalescing</strong> so a thundering herd of misses for the same popular feeds collapses into one rebuild."},
        {who:"intv",text:"Rebuilding millions of feeds from the DB at once — doesn't that just move the meltdown to the DB?"},
        {who:"cand",text:"It would if unmanaged, so I throttle and prioritize the rebuild. The feed cache is <strong>reconstructable, not authoritative</strong> — the DB holds the truth — so I can afford to rebuild lazily: rebuild a user's feed only when they actually load (on-demand), not all at once eagerly, which naturally spreads the load over the traffic pattern instead of a synchronized stampede. I protect the DB with coalescing and per-shard rate limits, and serve slightly stale results where possible. And I keep blast radius small by sharding the cache widely so any one node holds a modest slice. The design principle: the cache dying is a <em>latency</em> event (feeds rebuild a bit slower) not a <em>correctness</em> or availability event, because everything in it can be recomputed."},
      ],resources:[
        {title:"Redis — data types (sorted sets)",url:"https://redis.io/docs/latest/develop/data-types/"},
        {title:"Consistent hashing",url:"https://en.wikipedia.org/wiki/Consistent_hashing"},
      ]},
      {l:"medium",tag:"durability",q:"Is it OK that the feed cache isn't durable?",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> at peak you're holding ~400M active timelines in Redis. A cache node reboots and comes back <b>empty</b> — those users open the app and their feed is gone from memory.</span>The feed cache is volatile. Are you comfortable with what people see living only in memory — and what happens on that reboot?"},
        {who:"cand",text:"Yes, deliberately — the feed cache is explicitly <strong>not the source of truth</strong>. The durable truth is two things in the DB: the <strong>canonical posts</strong> and the <strong>follow graph</strong>. Any user's feed list is a <em>derived</em>, recomputable view of those two — 'recent posts from people I follow, ranked.' So losing a cached list loses nothing permanent; it's regenerated from durable inputs. Putting it in volatile memory is the right call precisely because it's a materialized cache of a query, not primary data."},
        {who:"intv",text:"So you never persist feed lists at all? Even for faster recovery?"},
        {who:"cand",text:"I can add durability as an <em>optimization</em>, not a correctness requirement. Options: Redis AOF/RDB snapshots so a node restart reloads warm rather than empty, and/or replicas that keep the data live through a single-node failure. These speed recovery — they don't change the truth model. I'd enable replication for availability (avoid the blank-feed stampede) and treat on-disk persistence as a nice-to-have for faster warm starts. But the guarantee I rely on is always 'the feed is rebuildable from posts + graph,' so no scenario where the cache loses data can lose a user's actual content — worst case it costs a rebuild."},
      ],resources:[
        {title:"Redis — data types (sorted sets)",url:"https://redis.io/docs/latest/develop/data-types/"},
        {title:"System Design Primer — the Twitter timeline",url:"https://github.com/donnemartin/system-design-primer#design-the-twitter-timeline-and-search"},
      ]},
      {l:"medium",tag:"capacity",q:"How much RAM does the feed cache need?",turns:[
        {who:"intv",text:"Concrete. You hold a ranked list of post ids per active user in Redis. How much memory does the feed cache need, and how many nodes?"},
        {who:"cand",text:"Size per active user, then multiply. Each timeline is a sorted set of post ids trimmed to the top few hundred.<span class='eg'>~800 post ids x 8 bytes = ~6.4KB of ids per user; with sorted-set overhead (member + score + pointers) call it ~3x → ~20KB per timeline. 300M active users x 20KB ≈ 6TB. At ~50GB usable per node → 6TB / 50GB ≈ 120 nodes; with a replica per shard → ~240, plus headroom.</span>That is the whole point of storing ids not bodies — inlining ~1KB bodies would be gigabytes per popular post and blow this up hundreds-fold."},
        {who:"intv",text:"240 nodes of RAM is expensive. What shrinks the footprint?"},
        {who:"cand",text:"Two levers, both trade-offs. First, only hold feeds for active users, not all 500M registered — that is already baked into the 300M figure and cuts memory by the inactive fraction, at the cost of a cold rebuild when a dormant user returns. Second, the trim length: 800 ids is generous, and cutting it to a couple hundred cuts per-user memory proportionally, at the cost of paging to the DB sooner when someone scrolls deep. Since engagement drops off a cliff with feed depth, a shorter list is nearly free in practice. So I tune the active window and trim length to fit the working set in memory rather than provisioning for every registered user at full depth."},
      ],resources:[
        {title:"Redis — data types (sorted sets)",url:"https://redis.io/docs/latest/develop/data-types/"},
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
      ]},
      {l:"medium",tag:"concept",q:"Which cache for the feed lists, and why?",turns:[
        {who:"intv",text:"You keep reaching for Redis for the feed cache. Defend it — why Redis and not Memcached, or just more DB replicas?"},
        {who:"cand",text:"Match it to the access pattern: a per-user ranked list I range-read by cursor and that fan-out appends to constantly. Memcached is a flat key-to-blob cache with no server-side data structures, so a ranked timeline would be one opaque blob I fetch whole, deserialize, mutate, and rewrite on every fan-out insert — hopeless at ~1M inserts/s. More DB replicas keep list-building on disk-backed storage, which is exactly the hot-path cost I am trying to escape. Redis gives me a sorted set per user: score-ordered inserts from fan-out and range reads by cursor, in memory."},
        {who:"intv",text:"Redis is single-threaded per shard and volatile. Does that not bite you?"},
        {who:"cand",text:"Both are acceptable once you weigh them. Single-threaded per shard is fine because I shard widely — each node owns a slice of users, so aggregate throughput scales horizontally and no one node serves the whole keyspace. Volatility is fine because the feed cache is explicitly not the source of truth: every list is recomputable from posts + graph, so a lost node is a rebuild, not data loss. The one thing I would genuinely weigh is self-managed Redis versus a managed equivalent on operational cost — but on data-model fit the sorted-set primitive is decisive. So: Redis for the native ranked-list operations, sharded for throughput and replicated for availability, treated as a rebuildable cache."},
      ],resources:[
        {title:"Redis — data types (sorted sets)",url:"https://redis.io/docs/latest/develop/data-types/"},
        {title:"System Design Primer — the Twitter timeline",url:"https://github.com/donnemartin/system-design-primer#design-the-twitter-timeline-and-search"},
      ]},
    ],
    media:[
      {l:"medium",tag:"concept",q:"Uploading photos and video without touching app servers.",turns:[
        {who:"intv",text:"A user attaches a 200MB video to a post. Walk me through the upload. Be specific about what your servers do and don't handle."},
        {who:"cand",text:"My app servers never see the bytes. The flow: the client asks the media service for a <strong>pre-signed upload URL</strong> scoped to a new object key; the client <strong>uploads the file directly to object storage</strong> (S3-style) using that URL, bypassing my app tier entirely. The post write only carries a <strong>media reference</strong> (the object key + metadata), not the file. Once uploaded, an event triggers the async transcode pipeline. So posting is a tiny JSON write; the 200MB never flows through my request path."},
        {who:"intv",text:"Why pre-signed URLs instead of proxying the upload through your service where you'd have more control?"},
        {who:"cand",text:"Proxying 200MB uploads through app servers would burn bandwidth, memory, and connection time on my fleet for something object storage does better — it's a waste of the tier that also serves latency-critical feeds. Pre-signed URLs give me control where it matters (the URL is short-lived, scoped to one key, size- and type-constrained) while offloading the heavy lifting to storage. It also decouples upload durability from my service being up: the file lands safely in replicated object storage before the post even commits, and if the post write fails the orphaned object is garbage-collected."},
      ],resources:[
        {title:"Cloudflare — what is a CDN?",url:"https://www.cloudflare.com/learning/cdn/what-is-a-cdn/"},
        {title:"System Design Primer — the Twitter timeline",url:"https://github.com/donnemartin/system-design-primer#design-the-twitter-timeline-and-search"},
      ]},
      {l:"hard",tag:"scaling",q:"A viral video is watched by millions at once.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a video post goes viral — <b>10M</b> people play it within an hour, many on poor mobile connections. Served naively from your origin, that's terabytes of egress and your origin bandwidth saturates while low-end phones buffer endlessly. Fix delivery.</span>"},
        {who:"cand",text:"Two levers: a CDN for volume, and adaptive bitrate for the connection variety. <strong>CDN</strong>: the video's segments are cached at edge PoPs, so 10M viewers pull from edges near them and my origin serves each segment essentially once per PoP — origin egress collapses from terabytes to a trickle of cache fills. <strong>Adaptive bitrate (ABR)</strong>: the transcode pipeline produced multiple renditions (e.g. 240p → 1080p), and the player (HLS/DASH) picks the bitrate matching each viewer's bandwidth and switches on the fly — so the low-end phone streams 240p smoothly instead of buffering on 1080p."},
        {who:"intv",text:"The very first views before the CDN is warm still hit origin. And a brand-new viral video isn't cached anywhere yet. Handle the cold start."},
        {who:"cand",text:"The initial cache-fill surge is bounded by an <strong>origin shield</strong> — a mid-tier cache layer between edge PoPs and origin, so all cold edges pull through the shield and origin serves each segment at each bitrate essentially <em>once</em>, no matter how many PoPs warm up. Request coalescing at the shield collapses simultaneous cold misses for the same segment into a single origin fetch. For predictably viral content I can also <strong>pre-warm</strong> — push segments to PoPs ahead of demand. So cold start is a brief, bounded origin blip during warm-up, then the CDN carries the 10M viewers with origin nearly idle. ABR ensures none of them buffer regardless of device."},
      ],resources:[
        {title:"Apple — HTTP Live Streaming (HLS)",url:"https://developer.apple.com/streaming/"},
        {title:"Dynamic Adaptive Streaming over HTTP (DASH)",url:"https://en.wikipedia.org/wiki/Dynamic_Adaptive_Streaming_over_HTTP"},
      ]},
      {l:"medium",tag:"durability",q:"Transcode fails or object storage loses a file.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> a user's video uploads fine, the post commits, but the transcode job crashes halfway — some renditions exist, others don't. Viewers get broken playback for a post that looks live. And separately, could a stored original ever just vanish?</span>"},
        {who:"cand",text:"Two durability concerns. For <strong>transcode</strong>: the pipeline is driven by a durable queue with <strong>idempotent, retryable jobs</strong> — a crashed transcode redelivers and re-runs; renditions are written atomically and the post's media is marked <strong>ready only when all required renditions exist</strong>. Until then the client shows a 'processing' state or falls back to the source/thumbnail, never broken playback. So a half-finished transcode is a retry, not a broken post. For the <strong>stored original</strong>: object storage replicates every object across devices/AZs with very high durability, so a single disk or node loss doesn't lose the file — that's exactly why I upload straight to it rather than any single-copy location."},
        {who:"intv",text:"What if the transcode job keeps failing — a corrupt or unsupported source file?"},
        {who:"cand",text:"After bounded retries it goes to a <strong>dead-letter queue</strong> for inspection rather than retrying forever and burning capacity. The post either stays in 'media unavailable' (text still shows, video greyed) or I notify the author to re-upload — a graceful degrade, not a crash. The key is the post's media state is explicit (processing / ready / failed), driven by the pipeline, so the read path always knows whether a rendition exists before it tries to serve one. The original is safe in durable storage regardless, so I can always re-transcode later once the pipeline handles that format. Durability of the source is guaranteed; availability of a playable rendition degrades gracefully."},
      ],resources:[
        {title:"Apache Kafka documentation",url:"https://kafka.apache.org/documentation/"},
        {title:"Apple — HTTP Live Streaming (HLS)",url:"https://developer.apple.com/streaming/"},
      ]},
      {l:"hard",tag:"failover",q:"A CDN region or the transcode fleet goes down.",turns:[
        {who:"intv",text:"<span class='scenario'><b>Scenario:</b> your CDN provider has a regional outage — edges in one region stop serving. Media in that region 404s or times out for millions of users mid-scroll. Meanwhile the rest of the feed (text) still loads. How do you keep media flowing?</span>"},
        {who:"cand",text:"I don't want to be single-homed on one CDN region or provider. Mitigations: <strong>(1) multi-region CDN with health-based routing</strong> — the DNS/anycast layer detects the failing region and steers media requests to the next-nearest healthy PoP, which fills from the shared origin shield. <strong>(2) multi-CDN</strong> for the highest resilience — media urls can resolve across two providers, failing over if one degrades. <strong>(3)</strong> because the feed text path is fully independent of media, the app <strong>degrades gracefully</strong>: it renders text and thumbnails (thumbnails are tiny and widely cached) while full media retries against a healthy edge, so the feed is usable, not broken, during the blip."},
        {who:"intv",text:"And if the transcode fleet, not the CDN, is what's down during a posting spike?"},
        {who:"cand",text:"Then new posts' media queues up but nothing already-published breaks — a critical separation. Transcode is <strong>async and queue-buffered</strong>, so a fleet outage means renditions are produced late: those posts sit in 'processing' (text + thumbnail visible) until workers recover and drain the backlog, exactly the degrade we designed for. Meanwhile <strong>all previously-transcoded media keeps serving from the CDN</strong>, completely unaffected, because delivery doesn't depend on the transcode fleet being up. The fleet is stateless and autoscaling, so I add workers to burn down the backlog once it recovers. The principle throughout media: keep upload, transcode, and delivery independent, so a failure in one degrades a slice gracefully instead of taking media down."},
      ],resources:[
        {title:"Cloudflare — what is a CDN?",url:"https://www.cloudflare.com/learning/cdn/what-is-a-cdn/"},
        {title:"Dynamic Adaptive Streaming over HTTP (DASH)",url:"https://en.wikipedia.org/wiki/Dynamic_Adaptive_Streaming_over_HTTP"},
      ]},
      {l:"medium",tag:"capacity",q:"How much media storage and CDN egress?",turns:[
        {who:"intv",text:"Size the media path. Posts carry photos and video, and you said media is petabytes. Give me the storage and the egress numbers."},
        {who:"cand",text:"Storage first, then egress.<span class='eg'>Say ~20% of 300M posts/day carry media at ~2MB avg across photos and short video → 300M x 0.2 x 2MB = 120TB/day of originals. Transcoding into a few renditions roughly doubles that → ~240TB/day. Over 5 years → ~440PB — object-storage territory, not a database.</span><span class='eg'>Egress: 6B feed reads/day, ~30% actually fetch a media item at ~500KB effective → 6B x 0.3 x 500KB ≈ 900TB/day served. At a 95% CDN hit ratio the origin serves ~5% → ~45TB/day; the CDN carries the rest.</span>"},
        {who:"intv",text:"440PB and near a petabyte a day of egress — what keeps that affordable?"},
        {who:"cand",text:"The trade-off is where bytes live and who serves them. Storage: keep originals plus renditions in object storage with lifecycle tiering — hot renditions on standard storage, cold originals of old posts aged to archival tiers, since old media is rarely re-fetched — which pulls the effective hot footprint well below 440PB. Egress: the CDN is what makes it affordable, collapsing 900TB/day of viewer demand to ~45TB/day of origin fills, so I pay cheap edge egress for the bulk and expensive origin egress only for misses. The levers are the CDN hit ratio and storage tiering; I optimize both rather than serving petabytes from origin at origin prices."},
      ],resources:[
        {title:"Cloudflare — what is a CDN?",url:"https://www.cloudflare.com/learning/cdn/what-is-a-cdn/"},
        {title:"System Design Primer — back-of-the-envelope",url:"https://github.com/donnemartin/system-design-primer#back-of-the-envelope-calculations"},
      ]},
      {l:"medium",tag:"concept",q:"Which store for the media bytes, and why?",turns:[
        {who:"intv",text:"Where do the media bytes actually live? Defend object storage over putting them in your DB or on a self-managed distributed filesystem."},
        {who:"cand",text:"Match it to the access pattern: write-once large blobs, read by key, served globally behind a CDN, never queried by content. Bytes in the DB is the clear loser — it bloats rows, wrecks the buffer cache the post lookups need, and databases are not built to stream 200MB blobs. A self-managed distributed filesystem (HDFS/Ceph-style) can hold the bytes, but then I own capacity planning, rebalancing, durability, and CDN integration myself. Object storage (S3-style) is purpose-built for exactly this: effectively unlimited, cross-AZ replication for durability, pre-signed direct upload, and native CDN origin integration."},
        {who:"intv",text:"So object storage always wins? Where is the catch?"},
        {who:"cand",text:"The catch is per-request latency and cost: object storage is slower per GET than a local filesystem and charges per request and per GB egress, so hitting it directly for every view would be slow and pricey. That is precisely why it is not the serving path — the CDN sits in front and absorbs the reads, so object storage only takes uploads and cache-fill misses, where its throughput and durability matter and its per-GET latency does not. A self-managed filesystem would only win if I needed POSIX semantics or had a hard reason to avoid a cloud dependency, which I do not here. So: object storage as the durable origin, CDN as the serving tier — the trade-offs land where object storage is strong."},
      ],resources:[
        {title:"Cloudflare — what is a CDN?",url:"https://www.cloudflare.com/learning/cdn/what-is-a-cdn/"},
        {title:"System Design Primer — the Twitter timeline",url:"https://github.com/donnemartin/system-design-primer#design-the-twitter-timeline-and-search"},
      ]},
    ],
  }
};
