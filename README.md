# HLD Mock Interview — SDE-3 System Design

A self-contained mock-interview trainer. You play the **interviewer**; the app plays
both **interviewer** and **candidate**. 13 problems, each with a phased flow
(Requirements → Functional HLD → System deep dives → Component deep dives), a
diagram that grows and animates as the conversation progresses, per-component
**study notes** (role, capacity, data/consistency, scaling levers, failure modes,
trade-offs, and the probes an interviewer will push on), an **end-to-end Request
Walkthrough** that traces a request across the architecture step by step (real
queries, shard/partition routing, sync-vs-async replication, and failure handling —
with a focused diagram and a travelling request pulse), and a box to ask your own
questions.

## What's in here

```
index.html          # the whole app (open this)
problems/*.js        # 13 problems (URL shortener, feed, chat, rate limiter,
                     #   video, proximity, gdocs, filesync, ticketmaster,
                     #   crawler, adclick, scheduler, inventory)
serve.py             # tiny local server (static + /ask + /poll for live answers)
live.py              # question-watcher / answer helper for the live bridge
live/                # runtime scratch for live answers (safe to be empty)
```

## How to run it — three modes

### A) Quickest — just open it (works fully offline)
Double-click **`index.html`**, or open it in any browser.
Everything works: all 13 problems, all 4 phases, progressive diagrams, deep-dive
conversations, resource links, **and the "Ask your own question" box** — doubts are
answered **instantly and offline**, synthesized from that problem's own study notes
(role, data/consistency, scaling, failure modes, trade-offs, Q&A threads and system
dives). The "Grade my answer" button on quizzes is also instant and offline.

> Works fully offline. Nothing is uploaded anywhere.

### B) Local server (optional — logs your questions)
```
cd hld-mock
python3 serve.py
```
Then open **http://127.0.0.1:4599**. Identical to A, and additionally records each
doubt to `live/questions.jsonl` via `/ask` (handy for review). Answers still appear
instantly from the offline engine — no LLM required.

### C) Live agent-authored answers (optional override)
If you want a human/agent to hand-write richer answers instead of the offline ones,
run the server (mode B) and have an AI coding agent (Copilot CLI or Claude Code)
watch the queue with `live.py`:
- `python3 live.py watch` — blocks until a new question arrives, prints it.
- `python3 live.py list` — prints all unanswered questions.
- `python3 live.py answer <id> "..."` — writes an answer (the app polls `/poll`).

This is purely optional — the offline engine already answers every doubt on its own.

## Using it on another laptop
Copy this whole folder (or `hld-mock.zip`) over, then use mode A or B above.
Everything — including instant doubt answers — works offline with no agent needed.
Tip: keeping the folder in a git repo makes syncing between laptops easy —
`git init`, push to your own remote, and `git clone` on the other machine.

## Notes
- No build step, no dependencies beyond Python 3 (only for modes B/C) and a browser.
- `python3` ships with macOS Command Line Tools; on other OSes install Python 3.
- All content is pre-authored; resource links point to real references
  (System Design Primer, Hello Interview, engineering blogs, official docs).
- **Finding the walkthrough:** open a problem, go to **Component deep dives** (phase 4);
  the toolbar shows purple **"End-to-end walkthrough:"** buttons. Step with Prev/Next,
  the arrow keys, or the step dots; **Auto-play** advances on its own; **Esc** closes.
