#!/usr/bin/env python3
"""
Test script to verify Auth0 authentication flow
Simulates frontend authentication and backend token verification
"""

import os
import sys
import json
import asyncio
import httpx
from jose import jwt, JWTError
from datetime import datetime, timedelta


# Configuration (update these with your actual values)
AUTH0_DOMAIN = os.getenv("AUTH0_DOMAIN", "dev-jkm887wawwxknno6.us.auth0.com")
AUTH0_AUDIENCE = os.getenv("AUTH0_AUDIENCE", "https://pathviewpro.com/api")
AUTH0_CLIENT_ID = os.getenv("AUTH0_CLIENT_ID", "gT8pYvmdyFUhmPSVY5P5pAxiUwmTdvBr")
CONVERTER_URL = os.getenv("CONVERTER_URL", "http://localhost:8000")


def print_status(message, status="INFO"):
    """Print colored status message"""
    colors = {
        "INFO": "\033[94m",  # Blue
        "SUCCESS": "\033[92m",  # Green
        "WARNING": "\033[93m",  # Yellow
        "ERROR": "\033[91m",  # Red
        "RESET": "\033[0m"
    }
    print(f"{colors.get(status, colors['INFO'])}[{status}]{colors['RESET']} {message}")


async def check_auth0_config():
    """Verify Auth0 is reachable and properly configured"""
    print_status("Checking Auth0 configuration...", "INFO")
    
    try:
        async with httpx.AsyncClient() as client:
            # Check JWKS endpoint
            jwks_url = f"https://{AUTH0_DOMAIN}/.well-known/jwks.json"
            response = await client.get(jwks_url)
            
            if response.status_code == 200:
                jwks = response.json()
                print_status(f"✓ Auth0 JWKS accessible: {len(jwks.get('keys', []))} keys found", "SUCCESS")
                return True
            else:
                print_status(f"✗ Failed to fetch JWKS: HTTP {response.status_code}", "ERROR")
                return False
                
    except Exception as e:
        print_status(f"✗ Error checking Auth0: {e}", "ERROR")
        return False


async def check_converter_health():
    """Check if converter service is reachable"""
    print_status("Checking converter service...", "INFO")
    
    try:
        async with httpx.AsyncClient() as client:
            response = await client.get(f"{CONVERTER_URL}/health", timeout=5.0)
            
            if response.status_code == 200:
                print_status("✓ Converter service is healthy", "SUCCESS")
                return True
            else:
                print_status(f"✗ Converter returned HTTP {response.status_code}", "WARNING")
                return False
                
    except httpx.ConnectError:
        print_status(f"✗ Cannot connect to converter at {CONVERTER_URL}", "ERROR")
        print_status("  Make sure the converter service is running", "INFO")
        return False
    except Exception as e:
        print_status(f"✗ Error checking converter: {e}", "ERROR")
        return False


async def test_annotation_endpoint_without_auth():
    """Test annotation endpoint without authentication (should fail)"""
    print_status("Testing annotation endpoint without auth...", "INFO")
    
    try:
        async with httpx.AsyncClient() as client:
            # Use a sample study ID
            test_study_id = "test-study-123"
            url = f"{CONVERTER_URL}/studies/{test_study_id}/annotations"
            
            response = await client.get(url, timeout=10.0)
            
            if response.status_code == 401:
                print_status("✓ Correctly returns 401 without authentication", "SUCCESS")
                return True
            else:
                print_status(f"✗ Unexpected status code: {response.status_code}", "WARNING")
                print_status(f"  Expected 401, got {response.status_code}", "INFO")
                return False
                
    except Exception as e:
        print_status(f"✗ Error testing endpoint: {e}", "ERROR")
        return False


def decode_token_unsafe(token: str) -> dict:
    """Decode JWT token without verification (for inspection only)"""
    try:
        parts = token.split('.')
        if len(parts) != 3:
            return None
            
        # Decode payload (add padding if needed)
        payload_encoded = parts[1]
        padding = 4 - len(payload_encoded) % 4
        if padding != 4:
            payload_encoded += '=' * padding
            
        import base64
        payload_bytes = base64.urlsafe_b64decode(payload_encoded)
        payload = json.loads(payload_bytes)
        return payload
    except Exception as e:
        print_status(f"Failed to decode token: {e}", "ERROR")
        return None


async def test_with_mock_token():
    """Test with a mock token (will fail validation but tests flow)"""
    print_status("Testing with mock token (will fail validation)...", "INFO")
    
    # Create a mock token payload
    mock_payload = {
        "sub": "auth0|test-user-123",
        "email": "test@example.com",
        "aud": AUTH0_AUDIENCE,
        "iss": f"https://{AUTH0_DOMAIN}/",
        "exp": int((datetime.utcnow() + timedelta(hours=1)).timestamp()),
        "iat": int(datetime.utcnow().timestamp())
    }
    
    # This is NOT a valid signed token - just for testing the flow
    mock_token = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6InRlc3QifQ.eyJzdWIiOiJhdXRoMHx0ZXN0In0.test"
    
    try:
        async with httpx.AsyncClient() as client:
            test_study_id = "test-study-123"
            url = f"{CONVERTER_URL}/studies/{test_study_id}/annotations"
            
            response = await client.get(
                url,
                headers={"Authorization": f"Bearer {mock_token}"},
                timeout=10.0
            )
            
            if response.status_code == 401:
                # Check if it's the right kind of 401
                try:
                    error_detail = response.json()
                    detail = error_detail.get("detail", "")
                    
                    if "Invalid token" in detail or "Unable to find appropriate key" in detail:
                        print_status("✓ Token validation is working (rejected mock token)", "SUCCESS")
                        return True
                    else:
                        print_status(f"✗ Unexpected error: {detail}", "WARNING")
                        return False
                except:
                    print_status("✓ Token rejected (validation working)", "SUCCESS")
                    return True
            else:
                print_status(f"✗ Unexpected status: {response.status_code}", "WARNING")
                return False
                
    except Exception as e:
        print_status(f"✗ Error: {e}", "ERROR")
        return False


async def check_environment_variables():
    """Check if required environment variables are set"""
    print_status("Checking environment variables...", "INFO")
    
    required = {
        "AUTH0_DOMAIN": AUTH0_DOMAIN,
        "AUTH0_AUDIENCE": AUTH0_AUDIENCE,
        "AUTH0_CLIENT_ID": AUTH0_CLIENT_ID
    }
    
    all_set = True
    for key, value in required.items():
        if value and value != f"YOUR_{key}":
            print_status(f"✓ {key}: {value}", "SUCCESS")
        else:
            print_status(f"✗ {key}: Not set or using default", "ERROR")
            all_set = False
    
    return all_set


async def main():
    """Run all tests"""
    print("\n" + "="*60)
    print("PathView Pro - Authentication Flow Test")
    print("="*60 + "\n")
    
    results = {}
    
    # 1. Check environment variables
    results['env_vars'] = await check_environment_variables()
    print()
    
    # 2. Check Auth0 configuration
    results['auth0_config'] = await check_auth0_config()
    print()
    
    # 3. Check converter service
    results['converter_health'] = await check_converter_health()
    print()
    
    # 4. Test annotation endpoint without auth
    if results['converter_health']:
        results['no_auth_test'] = await test_annotation_endpoint_without_auth()
        print()
        
        # 5. Test with mock token
        results['mock_token_test'] = await test_with_mock_token()
        print()
    
    # Summary
    print("="*60)
    print("SUMMARY")
    print("="*60)
    
    passed = sum(1 for v in results.values() if v)
    total = len(results)
    
    for test_name, result in results.items():
        status = "PASS" if result else "FAIL"
        color = "SUCCESS" if result else "ERROR"
        print_status(f"{test_name}: {status}", color)
    
    print()
    print_status(f"Tests Passed: {passed}/{total}", "SUCCESS" if passed == total else "WARNING")
    
    if passed == total:
        print()
        print_status("✓ Authentication system is properly configured!", "SUCCESS")
        print_status("  Users should be able to authenticate and save annotations.", "INFO")
    else:
        print()
        print_status("✗ Some tests failed. Check the errors above.", "ERROR")
        print_status("  Refer to AUTHENTICATION.md for troubleshooting steps.", "INFO")
    
    print("\n" + "="*60 + "\n")
    
    return passed == total


if __name__ == "__main__":
    try:
        success = asyncio.run(main())
        sys.exit(0 if success else 1)
    except KeyboardInterrupt:
        print("\n\nTest interrupted by user")
        sys.exit(1)
    except Exception as e:
        print_status(f"Fatal error: {e}", "ERROR")
        import traceback
        traceback.print_exc()
        sys.exit(1)
