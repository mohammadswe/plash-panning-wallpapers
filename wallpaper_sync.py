#!/usr/bin/env python3
import sys
import os
import urllib.parse
from http.server import HTTPServer, BaseHTTPRequestHandler
import subprocess

PORT = 8765
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

def set_wallpaper(file_path):
    if not os.path.isabs(file_path):
        file_path = os.path.normpath(os.path.join(BASE_DIR, file_path))
    
    if not os.path.exists(file_path):
        print(f"[Sync] File not found: {file_path}", file=sys.stderr)
        return False

    script = f'''tell application "System Events"
    set theDesktops to a reference to every desktop
    repeat with aDesktop in theDesktops
        set picture of aDesktop to POSIX file "{file_path}"
    end repeat
end tell'''

    try:
        res = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=5)
        if res.returncode == 0:
            print(f"[Sync] Native wallpaper set to: {os.path.basename(file_path)}")
            return True
        else:
            print(f"[Sync] osascript error: {res.stderr.strip()}", file=sys.stderr)
            return False
    except Exception as e:
        print(f"[Sync] Failed to run osascript: {e}", file=sys.stderr)
        return False

class SyncHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/sync":
            params = urllib.parse.parse_qs(parsed.query)
            file_arg = params.get("file", [None])[0]
            if file_arg:
                success = set_wallpaper(file_arg)
                self.send_response(200 if success else 400)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(b'{"status":"ok"}' if success else b'{"status":"error"}')
                return
        elif parsed.path == "/ping":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(b'{"status":"pong"}')
            return

        self.send_response(404)
        self.end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()

    def log_message(self, format, *args):
        pass

def run():
    server = HTTPServer(("127.0.0.1", PORT), SyncHandler)
    print(f"[Sync Server] Running on http://127.0.0.1:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()

if __name__ == "__main__":
    run()
