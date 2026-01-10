# Authentication Troubleshooting Guide

## Overview

PathView Pro uses Auth0 for authentication. Users must be authenticated to:
- Save and load annotations
- Get calibration data
- Share slides
- Manage cases and blocks

## Architecture

```
Browser (index.html)
  ↓ (Auth0 SDK)
Auth0 Service
  ↓ (JWT Token)
FastAPI Backend (converter/main.py)
  ↓ (auth.py validates token)
PostgreSQL Database (user records)
```

## Configuration

### Required Environment Variables

**Backend (converter service)**:
```bash
AUTH0_DOMAIN=dev-jkm887wawwxknno6.us.auth0.com
AUTH0_AUDIENCE=https://pathviewpro.com/api
DATABASE_URL=postgresql://user:pass@postgres:5432/orthanc
```

**Frontend (index.html)**:
```javascript
const AUTH0_DOMAIN = 'dev-jkm887wawwxknno6.us.auth0.com';
const AUTH0_CLIENT_ID = 'gT8pYvmdyFUhmPSVY5P5pAxiUwmTdvBr';
```

### Auth0 Configuration

1. **Application Type**: Single Page Application (SPA)
2. **Allowed Callback URLs**: 
   - `https://pathviewpro.com/callback`
   - `http://localhost/callback` (for local dev)
3. **Allowed Logout URLs**: 
   - `https://pathviewpro.com`
   - `http://localhost` (for local dev)
4. **Allowed Web Origins**: 
   - `https://pathviewpro.com`
   - `http://localhost` (for local dev)
5. **API Identifier (Audience)**: `https://pathviewpro.com/api`

## Common Issues and Solutions

### Issue 1: 401 Unauthorized on Annotation Endpoints

**Symptoms**:
```
GET /api/studies/{id}/annotations 401 (Unauthorized)
POST /api/studies/{id}/annotations 401 (Unauthorized)
```

**Possible Causes**:

1. **Token not being retrieved**
   - Check browser console for "No auth token available" message
   - Open test page: `/test-auth.html` and click "Get Access Token"
   - If fails, check Auth0 configuration

2. **Token not being sent**
   - Check Network tab → Headers → Authorization
   - Should see: `Authorization: Bearer eyJ...`
   - If missing, check that `authFetch` is being used

3. **Token validation failing on backend**
   - Check converter service logs: `docker logs dicom-converter`
   - Look for JWT verification errors
   - Verify AUTH0_DOMAIN and AUTH0_AUDIENCE are set correctly

4. **JWKS cache issue**
   - Backend caches Auth0 public keys
   - Restart converter service: `docker-compose restart converter`

**Solutions**:

```bash
# 1. Verify environment variables
docker-compose config | grep AUTH0

# 2. Check converter logs
docker logs dicom-converter -f

# 3. Restart services
docker-compose restart converter

# 4. Clear browser cache and re-login
# Open browser DevTools → Application → Storage → Clear site data
```

### Issue 2: Token Retrieved but Still 401

**Cause**: Token audience mismatch

**Solution**:
1. Check token payload in `/test-auth.html`
2. Verify `aud` claim matches `AUTH0_AUDIENCE` environment variable
3. Update Auth0 API settings if needed

### Issue 3: "Authentication service not configured"

**Symptoms**:
```json
{
  "detail": "Authentication service not configured"
}
```

**Solution**:
```bash
# Verify environment variables are set
docker exec dicom-converter env | grep AUTH0

# If missing, add to docker-compose.yml and restart
docker-compose down
docker-compose up -d
```

### Issue 4: Annotations Save Locally but Not Persisted

**Cause**: Database connection issue

**Solution**:
```bash
# Check if PostgreSQL is running
docker ps | grep postgres

# Check database connection in converter
docker logs dicom-converter | grep -i database

# Verify DATABASE_URL is correct
docker exec dicom-converter env | grep DATABASE_URL
```

## Debugging Tools

### 1. Test Auth Page (`/test-auth.html`)

Open in browser: `https://pathviewpro.com/test-auth.html`

Features:
- Check authentication status
- Retrieve and decode JWT token
- Test annotation/calibration endpoints
- View Auth0 configuration

### 2. Browser DevTools

**Console Tab**:
- Look for authentication errors
- Check for "Auth token added to request" debug messages

**Network Tab**:
- Filter by "annotations" or "calibration"
- Check Request Headers for Authorization
- Check Response status and body

**Application Tab**:
- Auth0 tokens stored in localStorage
- Look for keys starting with `@@auth0spajs@@`

### 3. Backend Logs

```bash
# Follow converter logs
docker logs dicom-converter -f

# Search for authentication issues
docker logs dicom-converter | grep -i "auth\|token\|401"

# Check for JWT verification errors
docker logs dicom-converter | grep -i "jwt"
```

## Authentication Flow

### Login Flow

1. User clicks "Login" on landing page
2. Redirects to Auth0 hosted login
3. After authentication, redirects to `/callback`
4. Callback page exchanges code for tokens
5. Tokens stored in localStorage
6. User redirected to main viewer (`/`)

### API Request Flow

1. Frontend needs to make authenticated request
2. Calls `authFetch()` function
3. `authFetch` retrieves token from Auth0 SDK
4. Adds `Authorization: Bearer <token>` header
5. Makes request to backend
6. Backend validates token using Auth0 JWKS
7. Returns response

### Token Validation Flow

1. Backend receives request with Authorization header
2. Extracts JWT token
3. Fetches Auth0 JWKS (public keys)
4. Verifies token signature using JWKS
5. Validates audience, issuer, expiration
6. Extracts user info from token payload
7. Creates/updates user in database
8. Returns user object to endpoint handler

## Testing Authentication

### Manual Test Steps

1. **Open test page**:
   ```
   https://pathviewpro.com/test-auth.html
   ```

2. **Verify authenticated**:
   - Should show green "Authenticated as: [email]"
   - If not, click "Login"

3. **Get access token**:
   - Click "Get Access Token" button
   - Should display token payload
   - Check `aud` (audience) and `exp` (expiration)

4. **Test annotation endpoint**:
   - Click "Test Annotation API"
   - Should return 200 OK or 403 (if no access to that specific study)
   - Should NOT return 401

5. **Test calibration endpoint**:
   - Click "Test Calibration API"
   - Should return 200 OK or 403
   - Should NOT return 401

### Automated Tests

```bash
# Install httpx
pip install httpx

# Run test script
python test_auth_flow.py
```

## Security Considerations

### Token Expiration

- Access tokens expire after 24 hours (configurable in Auth0)
- SDK automatically refreshes using refresh token
- If refresh fails, user must re-login

### Token Storage

- Tokens stored in localStorage (secure for HTTPS)
- Never expose tokens in logs or error messages
- Tokens are JWT - self-contained and verifiable

### CORS Configuration

- Backend allows all origins (`*`) for development
- In production, restrict to specific domain:
  ```python
  allow_origins=["https://pathviewpro.com"]
  ```

## Dev/Test Auth Bypass (for automation/evaluation)

This repo supports an **opt-in auth bypass** intended for **automated testing** and **evaluation** when Auth0 login is a blocker.

- **Backend**: set env vars (converter service)

```bash
AUTH_BYPASS_ENABLED=true
AUTH_BYPASS_SECRET=some-long-random-string
# optional:
AUTH_BYPASS_ALLOWLIST=127.0.0.1,::1,localhost
AUTH_BYPASS_EMAIL=evaluator@local
AUTH_BYPASS_ROLE=user
```

- **Client/API calls**: include a header on requests:
  - `X-Auth-Bypass: <AUTH_BYPASS_SECRET>`

- **Viewer/uploader UI**: set localStorage key in the browser (same origin as the app):

```javascript
localStorage.setItem('PATHVIEW_AUTH_BYPASS_SECRET', '<AUTH_BYPASS_SECRET>');
location.reload();
```

### Safety notes

- **Disabled by default** and requires an explicit secret.
- Keep it **off in production** deployments.
- If you run behind a proxy and the host allowlist blocks you, either update `AUTH_BYPASS_ALLOWLIST` appropriately or set it to `*` for local-only setups.

## Troubleshooting Checklist

- [ ] Auth0 domain and client ID configured correctly
- [ ] Backend AUTH0_DOMAIN and AUTH0_AUDIENCE environment variables set
- [ ] Database connection working (check logs)
- [ ] User can log in successfully
- [ ] Token appears in localStorage after login
- [ ] `authFetch` function retrieves token (check console)
- [ ] Authorization header present in network requests
- [ ] Backend logs show successful token verification
- [ ] User record created in PostgreSQL users table

## Getting Help

If authentication is still not working after following this guide:

1. Collect the following information:
   - Browser console logs (copy all errors)
   - Network tab screenshot showing failed request
   - Converter service logs: `docker logs dicom-converter --tail 100`
   - Environment variables: `docker-compose config | grep AUTH0`
   - Test page results from `/test-auth.html`

2. Check for known issues in GitHub repository

3. Contact support with collected information

## Additional Resources

- [Auth0 SPA SDK Documentation](https://auth0.com/docs/libraries/auth0-spa-js)
- [FastAPI Security Documentation](https://fastapi.tiangolo.com/tutorial/security/)
- [JWT.io Token Debugger](https://jwt.io/)
