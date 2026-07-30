import os, json, http.server, socketserver, urllib.request, urllib.error

BASE = os.path.dirname(os.path.abspath(__file__))
LIVE = os.path.join(BASE, "live")
ANS = os.path.join(LIVE, "answers")
QFILE = os.path.join(LIVE, "questions.jsonl")
os.makedirs(ANS, exist_ok=True)
os.chdir(BASE)

# ---------------------------------------------------------------------------
# LLM config (read at request time so you can export vars, then launch, then
# tweak without editing code). Any OpenAI-compatible /chat/completions endpoint
# works: OpenAI, GitHub Models, OpenRouter, Groq, Together, a local llama.cpp /
# Ollama OpenAI shim, etc. Point LLM_BASE_URL at it and set the key + model.
#
#   export LLM_API_KEY=sk-...                        # or OPENAI_API_KEY
#   export LLM_BASE_URL=https://api.openai.com/v1    # default
#   export LLM_MODEL=gpt-4o-mini                     # default
# ---------------------------------------------------------------------------
def llm_cfg():
    key = os.environ.get("LLM_API_KEY") or os.environ.get("OPENAI_API_KEY") or ""
    base = (os.environ.get("LLM_BASE_URL") or os.environ.get("OPENAI_BASE_URL")
            or "https://api.openai.com/v1").rstrip("/")
    model = os.environ.get("LLM_MODEL") or os.environ.get("OPENAI_MODEL") or "gpt-4o-mini"
    return key, base, model


TUTOR_SYSTEM = (
    "You are a principal engineer running a senior (6+ years) system-design mock "
    "interview and study session. The learner is the interviewer/student, not the "
    "candidate. Answer their doubt directly and in depth.\n"
    "Rules:\n"
    "- Be concrete: use real numbers, a worked example, and name the exact "
    "mechanism (query, index, partition key, quorum, offset, lock, etc.).\n"
    "- Prefer a short scenario ('say 50k RPS hits this, one shard holds ...') over "
    "abstract description.\n"
    "- When trade-offs exist, state the alternatives and why you'd pick one at this "
    "scale.\n"
    "- Stay tightly scoped to the component/flow/question in the context. Don't "
    "re-explain the whole system.\n"
    "- Use **bold** for key terms and short paragraphs or bullets. Keep it to "
    "roughly 120-220 words unless the question truly needs more. Plain text with "
    "**bold** only — no markdown headers or code fences."
)


def call_llm(question, ctx, system=None):
    key, base, model = llm_cfg()
    if not key:
        return None, "no-key"
    user = question if not ctx else (ctx + "\n\nDoubt / question:\n" + question)
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system or TUTOR_SYSTEM},
            {"role": "user", "content": user},
        ],
        "temperature": 0.4,
        "max_tokens": 900,
    }
    req = urllib.request.Request(
        base + "/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + key,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            body = json.loads(r.read().decode("utf-8"))
        msg = (((body.get("choices") or [{}])[0]).get("message") or {}).get("content")
        if not msg:
            return None, "empty-response"
        return msg.strip(), None
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8")[:400]
        except Exception:
            pass
        return None, "http-%s %s" % (e.code, detail)
    except Exception as e:
        return None, "error: %s" % (str(e)[:200])


class H(http.server.SimpleHTTPRequestHandler):
    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        n = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(n).decode("utf-8") if n else "{}"
        try:
            return json.loads(raw)
        except Exception:
            return {"q": raw}

    def do_GET(self):
        if self.path.startswith("/poll"):
            out = {}
            try:
                for fn in os.listdir(ANS):
                    if fn.endswith(".txt"):
                        with open(os.path.join(ANS, fn), "r", encoding="utf-8") as f:
                            out[fn[:-4]] = f.read()
            except Exception:
                pass
            return self._json(200, out)
        if self.path.startswith("/llm-status"):
            key, base, model = llm_cfg()
            return self._json(200, {"enabled": bool(key),
                                    "model": model if key else None,
                                    "base": base if key else None})
        return super().do_GET()

    def do_POST(self):
        # Synchronous LLM answer — deep, contextual doubt-clearing. Always 200;
        # {answer} on success, {error} so the client falls back to offline notes.
        if self.path == "/answer":
            data = self._read_json()
            q = (data.get("q") or "").strip()
            if not q:
                return self._json(200, {"error": "empty-question"})
            ans, err = call_llm(q, data.get("ctx") or "", data.get("system"))
            if ans is None:
                return self._json(200, {"error": err or "unknown"})
            return self._json(200, {"answer": ans})
        # Legacy async bridge: log the question for an agent (live.py) to answer.
        if self.path == "/ask":
            data = self._read_json()
            with open(QFILE, "a", encoding="utf-8") as f:
                f.write(json.dumps(data) + "\n")
            return self._json(200, {"ok": True, "id": data.get("id")})
        return self._json(404, {"error": "not found"})

    def log_message(self, *a):
        pass


socketserver.TCPServer.allow_reuse_address = True
if __name__ == "__main__":
    key, base, model = llm_cfg()
    status = ("LLM: %s @ %s" % (model, base)) if key else \
        "LLM: OFF (export LLM_API_KEY for live answers; offline notes still work)"
    print("HLD mock-interview server on http://127.0.0.1:4599  —  " + status)
    with socketserver.TCPServer(("127.0.0.1", 4599), H) as httpd:
        httpd.serve_forever()
