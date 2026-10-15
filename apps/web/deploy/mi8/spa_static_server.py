#!/usr/bin/env python3
"""Static SPA server for HCIS web on Mi8VPS (no nginx/Docker on that host).

Mirrors apps/web/nginx.conf for the static part only; /api/ and /auth/callback
are routed to the API by the Mi8 edge proxy before reaching this server.

- /healthz returns "ok".
- Existing files are served; hashed asset types are cached as immutable.
- Missing asset-type files return 404 (never the SPA shell).
- Every other path falls back to index.html, which is never cached.
- Directory listings are never produced.
"""

import argparse
import os
import posixpath
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

ASSET_EXTENSIONS = {
    ".js", ".css", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico", ".woff", ".woff2",
}
SHELL_HEADERS = {
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "0",
}
ASSET_CACHE = "public, max-age=604800, immutable"


class SpaHandler(SimpleHTTPRequestHandler):
    server_version = "hcis-web"
    sys_version = ""

    def _relative_path(self):
        path = posixpath.normpath(unquote(urlsplit(self.path).path))
        return "" if path in ("/", ".") else path.lstrip("/")

    def _send_file(self, relative, cache_headers):
        full = os.path.join(self.directory, relative)
        try:
            handle = open(full, "rb")
        except OSError:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        with handle:
            size = os.fstat(handle.fileno()).st_size
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", self.guess_type(full))
            self.send_header("Content-Length", str(size))
            for name, value in cache_headers.items():
                self.send_header(name, value)
            self.end_headers()
            if self.command != "HEAD":
                self.copyfile(handle, self.wfile)

    def _dispatch(self):
        relative = self._relative_path()
        if relative == "healthz":
            body = b"ok\n"
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)
            return

        full = os.path.join(self.directory, relative)
        extension = posixpath.splitext(relative)[1].lower()
        if relative and relative != "index.html" and os.path.isfile(full):
            cache = {"Cache-Control": ASSET_CACHE} if extension in ASSET_EXTENSIONS else {}
            self._send_file(relative, cache)
        elif extension in ASSET_EXTENSIONS:
            self.send_error(HTTPStatus.NOT_FOUND)
        else:
            self._send_file("index.html", SHELL_HEADERS)

    def do_GET(self):
        self._dispatch()

    def do_HEAD(self):
        self._dispatch()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--root", default=".")
    args = parser.parse_args()
    root = os.path.realpath(args.root)

    def handler(*handler_args, **handler_kwargs):
        return SpaHandler(*handler_args, directory=root, **handler_kwargs)

    ThreadingHTTPServer((args.bind, args.port), handler).serve_forever()


if __name__ == "__main__":
    main()
