# Proves the /save hardening shared by spike/t{0,4,7,13}/serve.py (#467-#471, #473).
# Run: python spike/test_serve_hardening.py   (stdlib only; no ROM, no browser)
import http.client
import importlib.util
import sys
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
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.ev = self.mod.T0_DIR / "evidence"
        self.made = []

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        for f in self.made:
            f.unlink(missing_ok=True)

    def req(self, method, path, body=b"x", headers=None):
        for attempt in range(3):
            # Windows can RST a connection the server closed with an unread body.
            try:
                c = http.client.HTTPConnection("127.0.0.1", self.port)
                c.request(method, path, body if method == "POST" else None, headers or {})
                r = c.getresponse()
                return r.status, r, r.read()
            except ConnectionError:
                if attempt == 2:
                    raise

    def save(self, name, token=True, **h):
        if token:
            h["X-Save-Token"] = self.mod.TOKEN
        return self.req("POST", "/save?name=" + name, headers=h)[0]

    def test_bad_names_refused(self):
        outside = self.mod.T0_DIR / "evil.txt"
        for n in ["..%2Fevil.txt", "%2Fabs.txt", "C%3A%5Cx", "C:\\x", "C:/x", "a%5Cb", ".hidden", "", "a/b"]:
            self.assertEqual(self.save(n), 400, n)
        self.assertFalse(outside.exists())

    def test_missing_or_wrong_token_refused(self):
        self.assertEqual(self.save("ok.txt", token=False), 403)
        self.assertEqual(self.save("ok.txt", token=False, **{"X-Save-Token": "nope"}), 403)

    def test_foreign_origin_refused(self):
        self.assertEqual(self.save("ok.txt", Origin="http://evil.example"), 403)

    def test_good_save_and_attachment_readback(self):
        self.made.append(self.ev / "page.html")
        self.assertEqual(self.save("page.html", Origin=f"http://127.0.0.1:{self.port}"), 200)
        st, r, body = self.req("GET", "/evidence/page.html")
        self.assertEqual(st, 200)
        self.assertEqual(body, b"x")
        self.assertEqual(r.getheader("Content-Type"), "text/plain; charset=utf-8")
        self.assertTrue(r.getheader("Content-Disposition").startswith("attachment"))
        self.assertEqual(r.getheader("X-Content-Type-Options"), "nosniff")

    def test_index_carries_token(self):
        st, _, body = self.req("GET", "/")
        if st == 200:
            self.assertIn(self.mod.TOKEN.encode(), body)


for _t in SERVERS:
    globals()["Hardening_" + _t] = type("Hardening_" + _t, (Hardening,), {"t": _t})
del Hardening

if __name__ == "__main__":
    unittest.main()
