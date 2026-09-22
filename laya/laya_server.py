#!/usr/bin/env python3
"""Local HTTP bridge that serves Laya-MLX with the same interface as Jev (System One).

The runner POSTs the same {state, questions} payload it sends to Jev and gets the same
{model, answers, usage} shape back. MLX is not thread-safe, so requests are handled one at a time.

  .venv/bin/python laya_server.py --port=8765 --model=aac6fef/laya-multilingual-mlx
"""
import argparse
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

import laya_mlx as laya


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=8765)
    # Default to the multilingual checkpoint so non-English states and instructions work
    p.add_argument("--model", default="aac6fef/laya-multilingual-mlx")
    args = p.parse_args()

    t0 = time.time()
    # Decisions get slower when calls are spaced out (15ms back-to-back vs 27ms with 30ms gaps on an M2 Pro); compile + padding brings it back to ~22ms
    agent = laya.load(args.model, compile=True, pad_to_multiple=16)
    for n in range(4):  # compilation is per input shape, so warm up common lengths
        agent.predict("warmup " * (n * 16 + 1), {"q": {"type": "choice", "instructions": "warmup", "criteria": ["a", "b"]}})
    print(f"[laya-server] loaded {args.model} in {time.time() - t0:.1f}s", flush=True)

    class Handler(BaseHTTPRequestHandler):
        def _send(self, code, obj):
            body = json.dumps(obj, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == "/health":
                self._send(200, {"ok": True, "model": args.model})
            else:
                self._send(404, {"error": "not found"})

        def do_POST(self):
            if self.path != "/v1/systemone":
                self._send(404, {"error": "not found"})
                return
            try:
                req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
                t = time.perf_counter()
                result = agent.predict(req["state"], req["questions"])
                result["model"] = args.model
                result["latency_ms"] = round((time.perf_counter() - t) * 1000, 1)
                self._send(200, result)
            except Exception as e:  # return the reason so the runner can stop
                self._send(400, {"error": f"{type(e).__name__}: {e}"})

        def log_message(self, *_):
            pass

    server = HTTPServer(("127.0.0.1", args.port), Handler)
    print(f"[laya-server] listening on http://127.0.0.1:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
