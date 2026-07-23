#!/usr/bin/env python3
"""Live doubt-answering helper for the HLD mock-interview app.

The browser posts questions to serve.py, which appends them to
live/questions.jsonl. This script is the other half of that bridge: it lets the
agent (Copilot / Claude) running alongside the app see pending questions and
write answers back, which the app then polls and shows in the transcript.

Usage:
  python3 live.py list            # print all unanswered questions (JSON lines)
  python3 live.py next            # print just the oldest unanswered question
  python3 live.py watch           # block until a new question arrives, print it, exit
  python3 live.py answer <id> "answer text"   # write the answer for a question
  python3 live.py answer <id> -   # read the answer body from stdin

Answers support **bold** markdown; the app converts it to <strong>.
"""
import json
import os
import sys
import time

BASE = os.path.dirname(os.path.abspath(__file__))
LIVE = os.path.join(BASE, "live")
ANS = os.path.join(LIVE, "answers")
QFILE = os.path.join(LIVE, "questions.jsonl")
os.makedirs(ANS, exist_ok=True)


def questions():
    out = []
    try:
        with open(QFILE, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    out.append(json.loads(line))
                except Exception:
                    pass
    except FileNotFoundError:
        pass
    return out


def is_answered(qid):
    return os.path.exists(os.path.join(ANS, qid + ".txt"))


def pending():
    return [q for q in questions() if q.get("id") and not is_answered(q["id"])]


def cmd_list():
    items = pending()
    if not items:
        print("(no pending questions)")
        return
    for q in items:
        print(json.dumps(q, ensure_ascii=False))


def cmd_next():
    items = pending()
    if not items:
        print("(no pending questions)")
        return
    print(json.dumps(items[0], ensure_ascii=False))


def cmd_watch(interval=1.5):
    seen = {q["id"] for q in questions() if q.get("id")}
    sys.stderr.write("watching live/questions.jsonl for new doubts... (Ctrl-C to stop)\n")
    sys.stderr.flush()
    while True:
        for q in pending():
            qid = q["id"]
            if qid not in seen or not is_answered(qid):
                print(json.dumps(q, ensure_ascii=False))
                sys.stdout.flush()
                return
        time.sleep(interval)


def cmd_answer(qid, text):
    if text == "-":
        text = sys.stdin.read()
    path = os.path.join(ANS, qid + ".txt")
    with open(path, "w", encoding="utf-8") as f:
        f.write(text.strip() + "\n")
    print("wrote " + path)


def main(argv):
    if not argv:
        print(__doc__)
        return 1
    cmd = argv[0]
    if cmd == "list":
        cmd_list()
    elif cmd == "next":
        cmd_next()
    elif cmd == "watch":
        cmd_watch()
    elif cmd == "answer":
        if len(argv) < 3:
            sys.stderr.write('usage: python3 live.py answer <id> "text" (or - for stdin)\n')
            return 1
        cmd_answer(argv[1], " ".join(argv[2:]) if argv[2] != "-" else "-")
    else:
        sys.stderr.write("unknown command: " + cmd + "\n")
        print(__doc__)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
