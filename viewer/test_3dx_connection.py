#!/usr/bin/env python3
"""
Test direct connection to 3DxNLServer WebSocket.
This bypasses browser security to see if the server actually works.
"""

import asyncio
import ssl
import json
import socket

try:
    import websockets
except ImportError:
    print("Installing websockets...")
    import subprocess
    subprocess.run(["pip", "install", "websockets"])
    import websockets

async def test_websocket_with_subprotocol():
    """Try connecting with various subprotocols"""
    url = "wss://127.51.68.120:8181"
    
    ssl_context = ssl.create_default_context()
    ssl_context.check_hostname = False
    ssl_context.verify_mode = ssl.CERT_NONE
    
    # Common 3Dconnexion subprotocols to try
    subprotocols = [
        ["3DxWare"],
        ["3DconnexionJS"],
        ["v1.3DconnexionJS"],
        ["3Dconnexion"],
        None  # No subprotocol
    ]
    
    for subproto in subprotocols:
        try:
            print(f"\nTrying subprotocol: {subproto}")
            async with websockets.connect(
                url, 
                ssl=ssl_context,
                subprotocols=subproto,
                additional_headers={
                    "Origin": "http://localhost",
                    "User-Agent": "Mozilla/5.0"
                }
            ) as ws:
                print(f"  SUCCESS with {subproto}!")
                return ws
        except Exception as e:
            print(f"  Failed: {type(e).__name__}")

async def test_raw_https():
    """See what the server responds with to a plain HTTPS request"""
    import urllib.request
    import ssl
    
    url = "https://127.51.68.120:8181/"
    
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    
    try:
        req = urllib.request.Request(url, headers={
            "Upgrade": "websocket",
            "Connection": "Upgrade",
            "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
            "Sec-WebSocket-Version": "13"
        })
        response = urllib.request.urlopen(req, context=ctx, timeout=5)
        print(f"Response: {response.status}")
        print(f"Headers: {dict(response.headers)}")
        print(f"Body: {response.read()[:500]}")
    except urllib.error.HTTPError as e:
        print(f"HTTP Error: {e.code}")
        print(f"Headers: {dict(e.headers)}")
        try:
            body = e.read().decode('utf-8', errors='replace')
            print(f"Body: {body[:500]}")
        except:
            pass
    except Exception as e:
        print(f"Error: {type(e).__name__}: {e}")

def test_raw_socket():
    """Test raw TCP connection to see what the server sends"""
    print("\n" + "="*60)
    print("Testing raw TCP connection")
    print("="*60)
    
    try:
        # Create SSL socket
        context = ssl.create_default_context()
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(5)
        
        ssl_sock = context.wrap_socket(sock, server_hostname="127.51.68.120")
        ssl_sock.connect(("127.51.68.120", 8181))
        
        print("TCP + TLS connected!")
        
        # Try sending a minimal HTTP request
        request = (
            "GET / HTTP/1.1\r\n"
            "Host: 127.51.68.120:8181\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "Sec-WebSocket-Protocol: 3DxWare\r\n"
            "Origin: http://localhost\r\n"
            "\r\n"
        )
        
        print(f"\nSending WebSocket upgrade request...")
        ssl_sock.send(request.encode())
        
        response = ssl_sock.recv(4096)
        print(f"\nResponse:\n{response.decode('utf-8', errors='replace')}")
        
        ssl_sock.close()
        
    except Exception as e:
        print(f"Error: {type(e).__name__}: {e}")

async def main():
    print("\n3DxNLServer Connection Tests")
    print("="*60)
    
    print("\n[Test 1] Raw Socket with WebSocket Upgrade")
    test_raw_socket()
    
    print("\n[Test 2] WebSocket with Subprotocols")
    await test_websocket_with_subprotocol()
    
    print("\n[Test 3] Raw HTTPS Request")
    await test_raw_https()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n\nTest stopped.")
