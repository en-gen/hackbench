#!/usr/bin/env python
# Throwaway dev server for the T0 capability probe. Serves three roots under
# one origin so the page can fetch the core, the harness, and the ROM without
# hitting CORS: no bare filesystem exposure (each prefix maps to one fixed dir
# or one fixed file), unlike rooting http.server at C:\.
import re
import secrets
import sys
import mimetypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
T0_DIR = REPO_ROOT / "spike" / "t7"
CORE_DIR = REPO_ROOT / "vendor" / "cores" / "snes9x-wasm"
ROM_PATH = Path(sys.argv[1]) if len(sys.argv) > 1 else None
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8801  # T7's assigned port

mimetypes.add_type("application/wasm", ".wasm")

# Per-run secret: /save needs it, so a foreign page cannot write evidence.
TOKEN = secrets.token_urlsafe(24)
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
# Windows device names are reserved with any extension ("con.txt" opens the device).
RESERVED = {"CON", "PRN", "AUX", "NUL"} | {f"{d}{i}" for d in ("COM", "LPT") for i in range(1, 10)}
HEAD_RE = re.compile(rb"<head[^>]*>", re.I)
DOCTYPE_RE = re.compile(rb"<!doctype[^>]*>", re.I)


def inside(path: Path, root: Path) -> bool:
    return path.resolve().is_relative_to(root.resolve())


def good_name(name: str) -> bool:
    return bool(NAME_RE.fullmatch(name)) and not name.endswith(".") and name.split(".")[0].upper() not in RESERVED


class Handler(BaseHTTPRequestHandler):
    def _host_ok(self) -> bool:
        # DNS rebinding sends our own port under a foreign name: accept loopback only.
        port = self.server.server_address[1]
        if self.headers.get("Host") in (f"127.0.0.1:{port}", f"localhost:{port}"):
            return True
        self.send_error(403, "bad host")
        return False

    def _serve_file(self, path: Path, content_type: str | None = None, inject: str | None = None, root: Path | None = None):
        if root is not None and not inside(path, root):
            self.send_error(404, "not found")
            return
        if not path.is_file():
            self.send_error(404, f"not found: {path}")
            return
        data = path.read_bytes()
        if inject:
            tag = f'<script>window.SAVE_TOKEN="{inject}"</script>'.encode()
            m = HEAD_RE.search(data) or DOCTYPE_RE.search(data)  # keep the doctype first
            at = m.end() if m else 0
            data = data[:at] + tag + data[at:]
        ctype = content_type or mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        evidence = inside(path, T0_DIR / "evidence")
        if evidence:
            ctype = "text/plain; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        if evidence:
            # saved evidence is untrusted bytes: never active same-origin content
            self.send_header("Content-Disposition", "attachment")
            self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        # /save?name=X.txt writes the raw request body into evidence/X.txt.
        # Lets page-side JS hand us evidence bytes directly -- no hand-copying
        # base64 blobs through chat, which silently truncated/corrupted once.
        if not self.path.startswith("/save"):
            self.send_error(404, "unknown POST route")
            return
        if not self._host_ok():
            return
        origin = self.headers.get("Origin")
        if origin is not None and origin != "http://" + self.headers["Host"]:
            self.send_error(403, "foreign origin")
            return
        if not secrets.compare_digest(self.headers.get("X-Save-Token", ""), TOKEN):
            self.send_error(403, "bad token")
            return
        name = (self.path.split("name=", 1) + [""])[1].split("&")[0]
        if not good_name(name):
            self.send_error(400, "bad name")
            return
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)
        ev = T0_DIR / "evidence"
        out = ev / name
        if not inside(out, ev):
            self.send_error(400, "bad name")
            return
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(body)
        self.send_response(200)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"ok")

    def do_GET(self):
        if not self._host_ok():
            return
        p = self.path.split("?", 1)[0]
        if p in ("", "/", "/index.html"):
            self._serve_file(T0_DIR / "index.html", "text/html", inject=TOKEN)
        elif p == "/rom":
            if ROM_PATH is None:
                self.send_error(404, "no ROM configured")
            else:
                self._serve_file(ROM_PATH, "application/octet-stream")
        elif p.startswith("/core/"):
            self._serve_file(CORE_DIR / p[len("/core/"):], root=CORE_DIR)
        else:
            # anything else in spike/t0 (harness.js, evidence/*.txt read-back, etc.)
            self._serve_file(T0_DIR / p.lstrip("/"), root=T0_DIR)

    def log_message(self, fmt, *args):
        sys.stderr.write("[serve] " + (fmt % args) + "\n")


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[serve] t0={T0_DIR} core={CORE_DIR} rom={ROM_PATH} port={PORT}")
    srv.serve_forever()
