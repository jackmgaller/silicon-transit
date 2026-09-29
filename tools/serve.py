"""Static dev server that disables caching, so edits show up on reload.

POST /__snap?name=foo with a PNG body saves it to tools/snaps/foo.png
(used to inspect canvas renders at full resolution while developing).

Usage: python3 tools/serve.py [port]
"""
import http.server
import os
import re
import sys
import urllib.parse

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
SNAPS = os.path.join(ROOT, "tools", "snaps")


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    def do_POST(self):
        url = urllib.parse.urlparse(self.path)
        if url.path != "/__snap":
            self.send_error(404)
            return
        name = urllib.parse.parse_qs(url.query).get("name", ["snap"])[0]
        name = re.sub(r"[^A-Za-z0-9_-]", "", name) or "snap"
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        os.makedirs(SNAPS, exist_ok=True)
        with open(os.path.join(SNAPS, name + ".png"), "wb") as f:
            f.write(body)
        self.send_response(204)
        self.end_headers()


if __name__ == "__main__":
    os.chdir(ROOT)
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 4912
    http.server.ThreadingHTTPServer(("127.0.0.1", port), NoCache).serve_forever()
