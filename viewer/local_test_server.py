#!/usr/bin/env python3
"""
Local test server for SpaceMouse WebSocket testing.
Serves viewer files from localhost so Firefox allows local WebSocket connections.
"""

import http.server
import socketserver
import os
import sys

PORT = 8080
DIRECTORY = os.path.dirname(os.path.abspath(__file__))

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)
    
    def end_headers(self):
        # Add CORS headers to allow connections to remote DICOM server
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
        super().end_headers()
    
    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

def main():
    os.chdir(DIRECTORY)
    
    with socketserver.TCPServer(("", PORT), Handler) as httpd:
        print(f"""
================================================================
  SpaceMouse Local Test Server
================================================================
  Serving viewer files from: {DIRECTORY}
  
  Test Pages:
    Main Viewer:        http://localhost:{PORT}/index.html
    Physics Compare:    http://localhost:{PORT}/spacemouse-physics-compare.html
    SpaceMouse Test:    http://localhost:{PORT}/spacemouse-test.html
    Gamepad Test:       http://localhost:{PORT}/spacemouse-gamepad-test.html
    WebHID Test:        http://localhost:{PORT}/spacemouse-webhid-test.html
  
  Press Ctrl+C to stop
================================================================
""")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServer stopped.")
            sys.exit(0)

if __name__ == "__main__":
    main()
