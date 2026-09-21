#!/usr/bin/env python
# Throwaway dev server for the T0 capability probe. Serves three roots under
# one origin so the page can fetch the core, the harness, and the ROM without
# hitting CORS: no bare filesystem exposure (each prefix maps to one fixed dir
# or one fixed file), unlike rooting http.server at C:\.
import sys
import mimetypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
T0_DIR = REPO_ROOT / "spike" / "t8"
CORE_DIR = REPO_ROOT / "vendor" / "cores" / "snes9x-wasm"
ROM_PATH = Path(sys.argv[1]) if len(sys.argv) > 1 else None
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8802  # T8's assigned port

mimetypes.add_type("application/wasm", ".wasm")


class Handler(BaseHTTPRequestHandler):
    def _serve_file(self, path: Path, content_type: str | None = None):
        if not path.is_file():
            self.send_error(404, f"not found: {path}")
            return
        data = path.read_bytes()
        ctype = content_type or mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        # /save?name=X.txt writes the raw request body into evidence/X.txt.
        # Lets page-side JS hand us evidence bytes directly -- no hand-copying
        # base64 blobs through chat, which silently truncated/corrupted once.
        if not self.path.startswith("/save"):
            self.send_error(404, "unknown POST route")
            return
        name = (self.path.split("name=", 1) + [""])[1].split("&")[0]
        if not name or "/" in name or ".." in name:
            self.send_error(400, "bad name")
            return
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        out = T0_DIR / "evidence" / name
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(body)
        self.send_response(200)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"ok")

    def do_GET(self):
        p = self.path.split("?", 1)[0]
        if p == "/" or p == "":
            self._serve_file(T0_DIR / "index.html", "text/html")
        elif p == "/rom":
            if ROM_PATH is None:
                self.send_error(404, "no ROM configured")
            else:
                self._serve_file(ROM_PATH, "application/octet-stream")
        elif p.startswith("/core/"):
            self._serve_file(CORE_DIR / p[len("/core/"):])
        else:
            # anything else in spike/t0 (harness.js, evidence/*.txt read-back, etc.)
            self._serve_file(T0_DIR / p.lstrip("/"))

    def log_message(self, fmt, *args):
        sys.stderr.write("[serve] " + (fmt % args) + "\n")


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[serve] t0={T0_DIR} core={CORE_DIR} rom={ROM_PATH} port={PORT}")
    srv.serve_forever()
