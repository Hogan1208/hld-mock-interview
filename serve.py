import os, json, http.server, socketserver

BASE = os.path.dirname(os.path.abspath(__file__))
LIVE = os.path.join(BASE, "live")
ANS = os.path.join(LIVE, "answers")
QFILE = os.path.join(LIVE, "questions.jsonl")
os.makedirs(ANS, exist_ok=True)
os.chdir(BASE)

class H(http.server.SimpleHTTPRequestHandler):
    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

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
        return super().do_GET()

    def do_POST(self):
        if self.path == "/ask":
            n = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(n).decode("utf-8") if n else "{}"
            try:
                data = json.loads(raw)
            except Exception:
                data = {"id": "bad", "q": raw}
            with open(QFILE, "a", encoding="utf-8") as f:
                f.write(json.dumps(data) + "\n")
            return self._json(200, {"ok": True, "id": data.get("id")})
        return self._json(404, {"error": "not found"})

    def log_message(self, *a):
        pass

socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("127.0.0.1", 4599), H) as httpd:
    httpd.serve_forever()
