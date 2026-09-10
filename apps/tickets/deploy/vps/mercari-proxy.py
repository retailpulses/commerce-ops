#!/usr/bin/env python3
"""Mercari GraphQL HTTP proxy — stateless, stdlib-only, zero dependencies.

Receives {token, query, variables} and forwards to Mercari API.
Designed to run behind Cloudflare Tunnel on the Conoha VPS.
"""

import json
import subprocess
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler

MERCARI_API = "https://api.mercari-shops.com/v1/graphql"


class ProxyHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/graphql":
            self.send_error(404)
            return

        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length))
        except Exception:
            self.send_error(400, "Invalid JSON")
            return

        token = body.get("token")
        query = body.get("query")
        variables = body.get("variables") or {}

        if not token or not query:
            self.send_error(400, "Missing token or query")
            return

        payload = json.dumps({"query": query, "variables": variables})

        try:
            result = subprocess.run(
                [
                    "curl", "-4", "-sS",
                    "-X", "POST", MERCARI_API,
                    "-H", f"Authorization: Bearer {token}",
                    "-H", "Content-Type: application/json",
                    "-H", "User-Agent: Inhouse_ERP/1.0.4",
                    "--data", payload,
                    "--connect-timeout", "10",
                    "--max-time", "30",
                ],
                capture_output=True,
                text=True,
                timeout=35,
            )

            stdout = result.stdout.strip()
            start = stdout.find("{")
            end = stdout.rfind("}")
            if start == -1 or end == -1:
                self.send_response(502)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "errors": [{"message": f"Invalid upstream response: {stdout[:200]}"}]
                }).encode())
                return

            mercari = json.loads(stdout[start:end + 1])
            status = 200
            if mercari.get("errors"):
                status = 422  # GraphQL errors are application-level, not transport

            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(mercari, ensure_ascii=False).encode())

        except subprocess.TimeoutExpired:
            self.send_error(504, "Upstream timeout")
        except Exception as e:
            self.send_error(502, str(e)[:200])

    def do_GET(self):
        """Health check."""
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "ok"}).encode())
        else:
            self.send_error(404)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 9000
    server = HTTPServer(("127.0.0.1", port), ProxyHandler)
    print(f"mercari-proxy running on 127.0.0.1:{port}")
    server.serve_forever()
