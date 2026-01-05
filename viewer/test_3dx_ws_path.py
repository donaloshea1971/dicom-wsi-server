#!/usr/bin/env python3
"""Check what /ws and /websocket return"""

import ssl
import socket
import asyncio

try:
    import websockets
except ImportError:
    import subprocess
    subprocess.run(["pip", "install", "websockets"])
    import websockets

def get_path_content(path):
    """Get content from a path (regular HTTP)"""
    context = ssl.create_default_context()
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(3)
    
    ssl_sock = context.wrap_socket(sock, server_hostname="127.51.68.120")
    ssl_sock.connect(("127.51.68.120", 8181))
    
    request = (
        f"GET {path} HTTP/1.1\r\n"
        "Host: 127.51.68.120:8181\r\n"
        "Connection: close\r\n"
        "\r\n"
    )
    
    ssl_sock.send(request.encode())
    response = ssl_sock.recv(4096).decode('utf-8', errors='replace')
    ssl_sock.close()
    
    return response

async def try_websocket(path):
    """Try WebSocket connection to specific path"""
    url = f"wss://127.51.68.120:8181{path}"
    
    ssl_context = ssl.create_default_context()
    ssl_context.check_hostname = False
    ssl_context.verify_mode = ssl.CERT_NONE
    
    try:
        print(f"\nTrying WebSocket to {url}...")
        async with websockets.connect(url, ssl=ssl_context) as ws:
            print("  CONNECTED!")
            
            # Listen for a few seconds
            print("  Listening for 5 seconds...")
            for _ in range(10):
                try:
                    msg = await asyncio.wait_for(ws.recv(), timeout=0.5)
                    print(f"  Received: {msg[:200]}")
                except asyncio.TimeoutError:
                    pass
            return True
    except Exception as e:
        print(f"  Failed: {type(e).__name__}: {str(e)[:100]}")
        return False

async def main():
    print("\n3DxNLServer /ws and /websocket Investigation")
    print("="*60)
    
    # Check what /ws returns
    print("\n[1] HTTP GET /ws:")
    print("-"*40)
    response = get_path_content("/ws")
    print(response[:1000])
    
    # Check what /websocket returns
    print("\n[2] HTTP GET /websocket:")
    print("-"*40)
    response = get_path_content("/websocket")
    print(response[:1000])
    
    # Try WebSocket to these paths
    print("\n[3] WebSocket Connections:")
    print("-"*40)
    await try_websocket("/ws")
    await try_websocket("/websocket")
    
    # Also try some variations
    for path in ["/ws/SpaceMouse", "/websocket/connect", "/ws/v1"]:
        await try_websocket(path)

if __name__ == "__main__":
    asyncio.run(main())
