#!/usr/bin/env python3
"""Test different WebSocket paths for 3DxNLServer"""

import ssl
import socket

def test_path(path):
    """Test a specific WebSocket path"""
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(3)
    
    try:
        ssl_sock = context.wrap_socket(sock, server_hostname="127.51.68.120")
        ssl_sock.connect(("127.51.68.120", 8181))
        
        request = (
            f"GET {path} HTTP/1.1\r\n"
            "Host: 127.51.68.120:8181\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "Origin: http://localhost\r\n"
            "\r\n"
        )
        
        ssl_sock.send(request.encode())
        response = ssl_sock.recv(4096).decode('utf-8', errors='replace')
        
        # Extract status line
        status_line = response.split('\r\n')[0]
        
        if "101" in status_line:
            print(f"  [SUCCESS] {path} -> {status_line}")
            return True
        elif "400" in status_line:
            # Extract error message if any
            if "Illegal" in response:
                print(f"  [FAIL] {path} -> Illegal Request")
            else:
                print(f"  [FAIL] {path} -> 400 Bad Request")
        elif "404" in status_line:
            print(f"  [FAIL] {path} -> 404 Not Found")
        else:
            print(f"  [????] {path} -> {status_line}")
            
        ssl_sock.close()
        return False
        
    except Exception as e:
        print(f"  [ERROR] {path} -> {type(e).__name__}")
        return False

# Paths to try based on 3Dconnexion documentation and common patterns
paths = [
    "/3DxService",
    "/3DxService/",
    "/3DxWare",
    "/3DxWare/",
    "/socket",
    "/ws",
    "/websocket",
    "/3dconnexion",
    "/v1",
    "/api",
    "/api/v1",
    "/3DxNLServer",
    "/connect",
    "/client",
    "/device",
    "/SpaceMouse",
    "",  # Empty path
]

print("\n3DxNLServer Path Discovery")
print("="*50)
print(f"Testing {len(paths)} different WebSocket paths...\n")

for path in paths:
    test_path(path)

print("\nDone!")
