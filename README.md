# HLD Mock Interview — SDE-3 System Design

A self-contained mock-interview trainer. You play the **interviewer**; the app plays
both **interviewer** and **candidate**. 11 problems, each with a phased flow
(Requirements → Functional HLD → System deep dives → Component deep dives), a
diagram that grows as the conversation progresses, and a box to ask your own
questions.

## What's in here

```
index.html          # the whole app (open this)
problems/*.js        # 11 problems (URL shortener, feed, chat, rate limiter,
                     #   video, proximity, gdocs, filesync, ticketmaster,
                     #   crawler, adclick)
serve.py             # tiny local server (static + /ask + /poll for live answers)
watch.js             # question-watcher used by the live-answer bridge
live/                # runtime scratch for live answers (safe to be empty)
```

## How to run it — three modes

### A) Quickest — just open it (no live AI answers)
Double-click **`index.html`**, or open it in any browser.
Everything works: all 11 problems, all 4 phases, progressive diagrams, deep-dive
conversations, and resource links. The only thing that won't work is the
"Ask your own question" box (it needs the server + an LLM — see C).

> Works fully offline. Nothing is uploaded anywhere.

### B) Local server (adds the ask endpoints)
```
cd hld-mock
python3 serve.py
```
Then open **http://127.0.0.1:4599**. Same as A, plus the `/ask` and `/poll`
endpoints exist so the ask box can be answered (still needs C to actually answer).

### C) Live in-app answers (full experience)
The "Ask your own question" box is answered by **Claude Code running alongside
the app**. To enable it:
1. Start `python3 serve.py` (mode B).
2. Open this folder in **Claude Code** and say:
   *"Run the hld-mock live-answer watcher and answer questions as the candidate."*
   Claude will run `watch.js` in the background; when you ask a question in the
   app, Claude composes the candidate's answer and it appears in the transcript.

Without step C, the ask box will wait and then show a "not being watched" note —
all the pre-authored content still works regardless.

## Using it on another laptop
Copy this whole folder (or `hld-mock.zip`) over, then use mode A or B above.
For live answers (C), you need Claude Code on that laptop too.
Tip: keeping the folder in a git repo makes syncing between laptops easy —
`git init`, push to your own remote, and `git clone` on the other machine.

## Notes
- No build step, no dependencies beyond Python 3 (only for modes B/C) and a browser.
- `python3` ships with macOS Command Line Tools; on other OSes install Python 3.
- All content is pre-authored; resource links point to real references
  (System Design Primer, Hello Interview, engineering blogs, official docs).
