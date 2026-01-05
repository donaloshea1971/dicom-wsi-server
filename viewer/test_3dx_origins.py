#!/usr/bin/env python3
"""Test different Origin headers for 3DxNLServer WebSocket"""

import ssl
import socket

def test_with_origin(origin):
    """Test WebSocket upgrade with specific Origin"""
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(3)
    
    try:
        ssl_sock = context.wrap_socket(sock, server_hostname="127.51.68.120")
        ssl_sock.connect(("127.51.68.120", 8181))
        
        # Try different paths with this origin
        for path in ["/", "/ws", "/3dconnexion"]:
            request = (
                f"GET {path} HTTP/1.1\r\n"
                "Host: 127.51.68.120:8181\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
                "Sec-WebSocket-Version: 13\r\n"
                f"Origin: {origin}\r\n"
                "\r\n"
            )
            
            ssl_sock.send(request.encode())
            response = ssl_sock.recv(4096).decode('utf-8', errors='replace')
            status = response.split('\r\n')[0]
            
            if "101" in status:
                print(f"  SUCCESS! Origin={origin}, Path={path}")
                print(f"  {status}")
                return True
                
        ssl_sock.close()
        return False
        
    except Exception as e:
        return False

# Origins to try - 3Dconnexion might whitelist specific origins
origins = [
    "https://www.onshape.com",
    "https://cad.onshape.com", 
    "https://sketchup.com",
    "https://app.sketchup.com",
    "https://3dconnexion.com",
    "https://www.3dconnexion.com",
    "chrome-extension://3dconnexion",
    "moz-extension://3dconnexion",
    "null",  # Some servers accept null origin
    "file://",
    "http://127.0.0.1",
    "https://127.0.0.1",
    "http://127.51.68.120",
    "https://127.51.68.120:8181",
]

print("\n3DxNLServer Origin Test")
print("="*50)
print("Testing different Origin headers...\n")

for origin in origins:
    result = test_with_origin(origin)
    if not result:
        print(f"  [-] {origin}")
    
print("\n" + "="*50)
print("If no success, the server may not support WebSocket at all,")
print("or may require a specific client application/extension.")
