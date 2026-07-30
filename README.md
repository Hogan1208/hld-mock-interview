# HLD Mock Interview — SDE-3 System Design

A self-contained mock-interview trainer. You play the **interviewer**; the app plays
both **interviewer** and **candidate**. 14 problems, each with a phased flow
(Requirements → Functional HLD → System deep dives → Component deep dives), a
diagram that grows and animates as the conversation progresses, per-component
**study notes** (role, capacity, data/consistency, scaling levers, failure modes,
trade-offs, and the probes an interviewer will push on), a **Scaling journey** that
shows why each upgrade (cache, shard, replica) is added and what breaks without it,
an **end-to-end Request Walkthrough** that traces a request across the architecture
step by step (real queries, shard/partition routing, sync-vs-async replication, and
failure handling), and — throughout — an **ask-a-doubt box** answered on the fly.

**Interactive deep dives.** Every System- and Component-level question runs a gated
flow built for real study: the interviewer asks → you clear any doubts **about the
question** → the detailed candidate answer is revealed → you ask follow-ups **about
the answer** → then a **quiz scoped to exactly that Q&A** tests you. Doubts are
answered live by an LLM when configured (below), or from each problem's study notes
offline.

## What's in here

```
index.html          # the whole app (open this)
problems/*.js        # 14 problems (URL shortener, feed, chat, rate limiter,
                     #   video, proximity, gdocs, filesync, ticketmaster,
                     #   crawler, adclick, scheduler, inventory, hotel)
serve.py             # local server (static + /answer LLM + /ask + /poll)
live.py              # question-watcher / answer helper for the live bridge
live/                # runtime scratch for live answers (safe to be empty)
```

## How to run it — three modes

### A) Quickest — just open it (works fully offline)
Double-click **`index.html`**, or open it in any browser.
Everything works: all 14 problems, all 4 phases, progressive diagrams, deep-dive
conversations, scaling journeys, resource links, **and every "Ask a doubt" box** —
doubts are answered **instantly and offline**, synthesized from that problem's own
study notes. The interactive deep-dive flow and quizzes work fully offline too.

> Works fully offline. Nothing is uploaded anywhere.

### B) Local server (recommended)
```
cd hld-mock
python3 serve.py
```
Then open **http://127.0.0.1:4599**. Same as A, and it enables the live-answer
endpoint (`/answer`) plus question logging (`/ask` → `live/questions.jsonl`).

### C) Live LLM answers (recommended for deep study)
Point the server at any **OpenAI-compatible** chat endpoint and every ask-a-doubt
box, every "clear your doubt" gate, and quiz grading is answered by a real model —
deep, contextual, grounded on exactly what's on screen. Set the env vars, then run:
```
export LLM_API_KEY=sk-...                       # or OPENAI_API_KEY
export LLM_BASE_URL=https://api.openai.com/v1   # default; OpenRouter/Groq/GitHub
                                                #   Models/Ollama shim all work
export LLM_MODEL=gpt-4o-mini                    # default
python3 serve.py                                # prints "LLM: <model> @ <base>"
```
When a key is set the ask boxes show a **"live answers on"** badge and answers carry
a **live answer** chip. No key → it silently falls back to the offline notes engine,
so nothing breaks. Your questions never leave your machine except the call to the
endpoint you configured.

Prefer a human/agent to hand-write answers instead? Run `python3 live.py watch`
(then `live.py answer <id> "..."`); the app polls `/poll`. This legacy bridge still
works and is independent of the LLM.

## Using it on another laptop
Copy this whole folder (or `hld-mock.zip`) over, then use mode A or B above.
Everything — including instant doubt answers — works offline with no agent needed.
Tip: keeping the folder in a git repo makes syncing between laptops easy —
`git init`, push to your own remote, and `git clone` on the other machine.

## Notes
- No build step, no dependencies beyond Python 3 (only for modes B/C) and a browser.
- `python3` ships with macOS Command Line Tools; on other OSes install Python 3.
- Core content is pre-authored; live LLM answers (mode C) are generated on the fly,
  grounded on the current problem/component/step. Resource links point to real
  references (System Design Primer, Hello Interview, engineering blogs, official docs).
- **Finding the walkthrough:** open a problem, go to **Component deep dives** (phase 4);
  the toolbar shows purple **"End-to-end walkthrough:"** buttons. Step with Prev/Next,
  the arrow keys, or the step dots; **Auto-play** advances on its own; **Esc** closes.
