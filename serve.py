#!/usr/bin/env python3
"""
Amanah Budget local server.

  python serve.py                      # http://localhost:8080 (+ prints your Wi-Fi address)
  python serve.py --port 9000
  python serve.py --https --cert cert.pem --key key.pem   # for full offline/install on your phone

Only uses the Python standard library.
"""
import argparse
import http.server
import os
import socket
import ssl
import sys


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))  # no packets are actually sent
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".json": "application/json",
        ".webmanifest": "application/manifest+json",
        ".svg": "image/svg+xml",
    }

    def end_headers(self):
        # Let the service worker control updates; avoid stale browser HTTP cache.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # keep the console quiet


def main():
    ap = argparse.ArgumentParser(description="Serve Amanah Budget on your home network")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--https", action="store_true", help="serve over HTTPS (needs --cert and --key)")
    ap.add_argument("--cert", default="cert.pem")
    ap.add_argument("--key", default="key.pem")
    args = ap.parse_args()

    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    httpd = http.server.ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    scheme = "http"
    if args.https:
        if not (os.path.exists(args.cert) and os.path.exists(args.key)):
            sys.exit(f"Certificate files not found: {args.cert} / {args.key} (see README, step 4)")
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(args.cert, args.key)
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
        scheme = "https"

    ip = lan_ip()
    print("\n  Amanah Budget is running\n")
    print(f"  On this computer:   {scheme}://localhost:{args.port}")
    if ip:
        print(f"  On your phone:      {scheme}://{ip}:{args.port}   (same Wi-Fi)")
    print("\n  Press Ctrl+C to stop.\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  Stopped.")


if __name__ == "__main__":
    main()
