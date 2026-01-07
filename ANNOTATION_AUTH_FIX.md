# Annotation Authentication Fix

## Problem Summary

Users were experiencing **401 Unauthorized** errors when trying to:
- Load annotations from the backend
- Save new annotations
- Load calibration data for measurements

**Console Errors**:
```
GET /api/studies/{id}/calibration 401 (Unauthorized)
GET /api/studies/{id}/annotations 401 (Unauthorized)
POST /api/studies/{id}/annotations 401 (Unauthorized)
```

## Root Cause

The annotation API endpoints require authentication (`require_user` dependency in FastAPI), but the Auth0 JWT token was not being properly:
1. Retrieved from the Auth0 client
2. Sent in the Authorization header
3. Validated on the backend

## Changes Made

### 1. Frontend Improvements (`viewer/index.html`)

#### Enhanced `authFetch` function:
- Added debug logging to track when tokens are retrieved
- Improved error messages when token retrieval fails
- Better handling of authentication errors

```javascript
async function authFetch(url, options = {}) {
    if (auth0Client) {
        try {
            const token = await auth0Client.getTokenSilently();
            options.headers = {
                ...options.headers,
                'Authorization': `Bearer ${token}`
            };
            console.debug('Auth token added to request:', url);
        } catch (e) {
            console.warn('Failed to get auth token for:', url, e.message);
        }
    }
    return fetch(url, options);
}
```

#### Enhanced annotation loading:
- Added authentication check before loading annotations
- Better error handling and user feedback
- Graceful degradation when auth fails

### 2. Annotation Manager Improvements (`viewer/annotations.js`)

#### Better error handling for 401 responses:

**`loadCalibration()`**:
- Handles 401 gracefully
- Falls back to default calibration values
- Logs appropriate warnings

**`loadAnnotations()`**:
- Handles 401 gracefully
- Starts with empty annotation state
- User can still create annotations if they authenticate later

**`saveAnnotation()`**:
- Shows user-friendly alert when authentication required
- Provides clear error messages
- Prevents silent failures

```javascript
} else if (response.status === 401) {
    console.error('Authentication required to save annotations');
    alert('You must be logged in to save annotations. Please refresh the page and log in.');
    return null;
}
```

### 3. Backend Improvements (`converter/auth.py`)

#### Enhanced token verification:
- Better error logging for debugging
- Check if Auth0 is configured before attempting verification
- More detailed logging of authentication flow

```python
async def verify_token(token: str) -> TokenPayload:
    # Check if Auth0 is configured
    if not AUTH0_DOMAIN or not AUTH0_AUDIENCE:
        logger.error("Auth0 not configured")
        raise HTTPException(...)
    
    # ... verification logic with enhanced logging
    logger.debug(f"Token verified successfully for user: {payload.get('sub')}")
```

#### Improved authentication dependencies:
- `get_current_user`: Better debug logging
- `require_user`: More informative error messages
- Added WWW-Authenticate headers for proper 401 responses

### 4. New Diagnostic Tools

#### A. Test Auth Page (`viewer/test-auth.html`)

Interactive web page for testing authentication:
- Check authentication status
- Retrieve and decode JWT token
- Test annotation/calibration endpoints
- View Auth0 configuration
- Debug token issues

**Usage**: Open `https://pathviewpro.com/test-auth.html` in browser

#### B. Authentication Test Script (`test_auth_flow.py`)

Python script to verify authentication flow:
- Check Auth0 configuration
- Verify converter service health
- Test endpoint authentication
- Validate token handling

**Usage**:
```bash
python test_auth_flow.py
```

#### C. Comprehensive Documentation (`AUTHENTICATION.md`)

Complete troubleshooting guide covering:
- Architecture overview
- Configuration requirements
- Common issues and solutions
- Debugging tools and techniques
- Security considerations
- Step-by-step troubleshooting checklist

## How to Use

### For End Users

1. **If you see "Authentication required" errors**:
   - Refresh the page and log in again
   - Check that you're logged in (profile picture in top-right)
   - Try clicking "Logout" and logging in again

2. **Clear browser cache if issues persist**:
   - Open DevTools → Application → Storage → Clear site data
   - Refresh page and log in again

### For Developers

1. **Use the test page to diagnose issues**:
   ```
   https://pathviewpro.com/test-auth.html
   ```

2. **Check backend logs**:
   ```bash
   docker logs dicom-converter -f
   ```

3. **Run the authentication test script**:
   ```bash
   python test_auth_flow.py
   ```

4. **Verify environment variables**:
   ```bash
   docker-compose config | grep AUTH0
   docker exec dicom-converter env | grep AUTH0
   ```

5. **Read the troubleshooting guide**:
   ```
   See AUTHENTICATION.md for detailed troubleshooting steps
   ```

## Testing the Fix

### Manual Testing

1. **Open the main viewer** (`/`)
2. **Log in** if not already authenticated
3. **Open a slide** from the study list
4. **Check browser console** for:
   - "Auth token added to request" (should appear)
   - "Calibration: X.XXX µm/px" (should load successfully)
   - "Loaded N annotations" (should load successfully)
5. **Try creating an annotation**:
   - Click a tool (Line, Rectangle, Arrow)
   - Draw on the slide
   - Should save without 401 errors
6. **Check Network tab** for annotation requests:
   - Should see `Authorization: Bearer ...` header
   - Should get 200 OK responses

### Automated Testing

```bash
# Test authentication flow
python test_auth_flow.py

# Should output:
# [SUCCESS] ✓ Auth0 JWKS accessible
# [SUCCESS] ✓ Converter service is healthy
# [SUCCESS] ✓ Correctly returns 401 without authentication
# [SUCCESS] ✓ Token validation is working
# [SUCCESS] Tests Passed: 5/5
```

## Configuration Checklist

Ensure these are properly configured:

### Frontend (index.html)
- [ ] `AUTH0_DOMAIN` matches your Auth0 tenant
- [ ] `AUTH0_CLIENT_ID` matches your Auth0 application
- [ ] Callback URL configured in Auth0 application settings

### Backend (docker-compose.yml)
- [ ] `AUTH0_DOMAIN` environment variable set
- [ ] `AUTH0_AUDIENCE` environment variable set
- [ ] `DATABASE_URL` environment variable set for user management

### Auth0 Dashboard
- [ ] Application type: Single Page Application
- [ ] Allowed Callback URLs includes your domain
- [ ] API created with correct identifier (audience)
- [ ] API permissions granted to application

## Security Notes

1. **Tokens are JWT (JSON Web Tokens)**:
   - Self-contained and cryptographically signed
   - Verified using Auth0 public keys (JWKS)
   - Expire after 24 hours by default

2. **Tokens stored in localStorage**:
   - Secure when using HTTPS
   - Auth0 SDK handles storage and retrieval
   - Automatically refreshed when expired

3. **Backend validates every request**:
   - Fetches public keys from Auth0
   - Verifies signature, audience, issuer, expiration
   - Creates/updates user record in database

## Support

If authentication issues persist:

1. Check the troubleshooting guide: `AUTHENTICATION.md`
2. Run diagnostic tools:
   - Open `/test-auth.html` in browser
   - Run `python test_auth_flow.py`
3. Collect logs:
   - Browser console output
   - Network tab screenshots
   - Backend logs: `docker logs dicom-converter`
4. Check configuration:
   - Verify all environment variables
   - Confirm Auth0 settings match

## Future Improvements

Potential enhancements for the authentication system:

1. **Token refresh handling**:
   - Automatically retry failed requests after token refresh
   - Show user notification when token expires

2. **Offline annotation support**:
   - Store annotations locally when offline
   - Sync to backend when connection restored

3. **Role-based access control**:
   - Different permissions for viewers vs editors
   - Admin-only features

4. **SSO integration**:
   - Enterprise SAML support
   - Multi-organization support

5. **Enhanced logging**:
   - Centralized authentication logs
   - Analytics on authentication failures
