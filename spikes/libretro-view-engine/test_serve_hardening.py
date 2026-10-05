# Proves the hardening shared by the nine probe servers spikes/libretro-view-engine/t{0,1,4,5,6,7,8,10,13}/serve.py
# (#467-#471, #473, #475, #484): /save name, token, Host, Origin; GET containment;
# evidence served as an inert attachment. Run: python spikes/libretro-view-engine/test_serve_hardening.py
# (stdlib only; no ROM, no browser).
import http.client
import importlib.util
import os
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
SERVERS = ["t0", "t1", "t4", "t5", "t6", "t7", "t8", "t10", "t13"]


def load(t):
    spec = importlib.util.spec_from_file_location("serve_" + t, HERE / t / "serve.py")
    mod = importlib.util.module_from_spec(spec)
    sys.argv = ["serve.py"]
    spec.loader.exec_module(mod)
    return mod


class Hardening(unittest.TestCase):
    def setUp(self):
        self.mod = load(self.t)
        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), self.mod.Handler)
        self.port = self.srv.server_address[1]
        self.me = f"127.0.0.1:{self.port}"
        # shutdown() blocks up to one poll interval (default 0.5 s), which was
        # ~0.5 s of the 81 tests = 41 s of CI. 10 ms keeps the same coverage.
        threading.Thread(target=self.srv.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True).start()
        self.ev = self.mod.T0_DIR / "evidence"
        self.made = []

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        for f in self.made:
            f.unlink(missing_ok=True)

    def req(self, method, path, body=b"x", headers=None):
        h = {"Host": self.me, **(headers or {})}
        for attempt in range(3):
            # Windows can RST a connection the server closed with an unread body.
            try:
                c = http.client.HTTPConnection("127.0.0.1", self.port)
                c.putrequest(method, path, skip_host=True)
                for k, v in h.items():
                    c.putheader(k, v)
                c.putheader("Content-Length", str(len(body)) if method == "POST" else "0")
                c.endheaders(body if method == "POST" else None)
                r = c.getresponse()
                return r.status, r, r.read()
            except ConnectionError:
                if attempt == 2:
                    raise

    def save(self, name, token=True, **h):
        if token:
            h.setdefault("X-Save-Token", self.mod.TOKEN)
        return self.req("POST", "/save?name=" + name, headers=h)[0]

    def refused(self, name, code, **kw):
        # The status must be a refusal AND nothing may have been written.
        # Compare directory listings: Path.exists() is True for device names like CON.
        before = set(os.listdir(self.ev)) if self.ev.is_dir() else set()
        self.assertEqual(self.save(name, **kw), code, name)
        after = set(os.listdir(self.ev)) if self.ev.is_dir() else set()
        self.assertEqual(before, after, name)

    def test_bad_names_refused(self):
        outside = self.mod.T0_DIR / "evil.txt"
        for n in ["..%2Fevil.txt", "%2Fabs.txt", "C%3A%5Cx", "C:" + chr(92) + "x", "C:/x", "a%5Cb", ".hidden", "", "a/b", "..", "a%20b", "x%20"]:
            self.assertEqual(self.save(n), 400, n)
        self.assertFalse(outside.exists())

    def test_reserved_and_trailing_dot_refused(self):
        for n in ["CON", "con.txt", "Nul.tar.gz", "aux", "PRN.x", "COM1", "lpt9.png", "COM9.txt", "x.", "x.png."]:
            self.refused(n, 400)

    def test_containment_helper(self):
        inside = self.mod.inside
        self.assertTrue(inside(self.ev / "a.txt", self.ev))
        self.assertFalse(inside(self.ev / ".." / "serve.py", self.ev))
        self.assertFalse(inside(Path("C:/Windows/win.ini"), self.mod.T0_DIR))
        with tempfile.TemporaryDirectory() as d:
            link = Path(d) / "lnk"
            try:
                os.symlink(self.mod.T0_DIR.parent, link, target_is_directory=True)
            except OSError:
                return  # no symlink privilege: helper checks above still ran
            self.assertTrue(inside(link / self.t / "x", self.mod.T0_DIR))

    def test_missing_or_wrong_token_refused(self):
        self.refused("ok.txt", 403, token=False)
        self.refused("ok.txt", 403, token=False, **{"X-Save-Token": "nope"})

    def test_origin_must_equal_own_origin(self):
        for o in ["http://evil.example", f"http://127.0.0.1:{self.port + 1}", "http://127.0.0.1.evil.example",
                  f"http://{self.me}.evil.example", f"https://{self.me}", "null"]:
            self.refused("ok.txt", 403, Origin=o)

    def test_foreign_host_refused_everywhere(self):
        for host in ["evil.example", f"evil.example:{self.port}", "127.0.0.1", f"127.0.0.1.evil.example:{self.port}"]:
            self.assertEqual(self.req("GET", "/", headers={"Host": host})[0], 403, host)
            self.assertEqual(self.req("GET", "/harness.js", headers={"Host": host})[0], 403, host)
            self.assertEqual(self.save("ok.txt", Host=host, Origin="http://" + host), 403, host)
            self.assertFalse((self.ev / "ok.txt").exists())
        self.assertEqual(self.req("GET", "/", headers={"Host": f"localhost:{self.port}"})[0], 200)

    def test_good_save_and_attachment_readback(self):
        self.made.append(self.ev / "page.html")
        self.assertEqual(self.save("page.html", Origin=f"http://{self.me}"), 200)
        self.assertEqual((self.ev / "page.html").read_bytes(), b"x")
        # A case-insensitive FS (Windows, macOS) serves /EVIDENCE/ from the same dir,
        # so it must still be an attachment; a case-sensitive one (Linux CI) 404s it.
        folds = (self.mod.T0_DIR / "EVIDENCE" / "page.html").exists()
        self.assertEqual(self.req("GET", "/EVIDENCE/page.html")[0], 200 if folds else 404)
        for url in ["/evidence/page.html"] + (["/EVIDENCE/page.html"] if folds else []):
            st, r, body = self.req("GET", url)
            self.assertEqual(st, 200, url)
            self.assertEqual(body, b"x")
            self.assertEqual(r.getheader("Content-Type"), "text/plain; charset=utf-8", url)
            self.assertEqual(r.getheader("Content-Disposition"), "attachment", url)
            self.assertEqual(r.getheader("X-Content-Type-Options"), "nosniff", url)

    def test_index_carries_token_after_doctype(self):
        for route in ["/", "/index.html"]:
            st, _, body = self.req("GET", route)
            self.assertEqual(st, 200, route)
            tag = f'<script>window.SAVE_TOKEN="{self.mod.TOKEN}"</script>'.encode()
            self.assertIn(tag, body)
            self.assertTrue(body.lstrip().lower().startswith(b"<!doctype"), route)
            self.assertGreater(body.index(tag), body.lower().index(b"<!doctype"))

    def test_get_traversal_refused(self):
        paths = ["/C:/Windows/win.ini", "//C:/Windows/win.ini", "/core/C:/Windows/win.ini", "/core//C:/Windows/win.ini",
                 "/../../README.md", "/../../../README.md", "/core/../../../README.md", "/..%5C..%5CREADME.md"]
        for p in paths:
            st, _, body = self.req("GET", p)
            self.assertIn(st, (403, 404), p)
            self.assertNotIn(b"HackBench", body, p)
        # sanity: an in-root file still serves
        self.assertEqual(self.req("GET", "/harness.js")[0], 200)


for _t in SERVERS:
    globals()["Hardening_" + _t] = type("Hardening_" + _t, (Hardening,), {"t": _t})
del Hardening

if __name__ == "__main__":
    unittest.main()
