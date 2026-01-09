/**
 * PathView Pro - Authentication and API Utilities
 * Handles Auth0 authentication, user management, and API requests
 */

// Auth0 Configuration
var AUTH0_DOMAIN = 'dev-jkm887wawwxknno6.us.auth0.com';
var AUTH0_CLIENT_ID = 'gT8pYvmdyFUhmPSVY5P5pAxiUwmTdvBr'; // Ensure this matches Auth0 Dashboard
var AUTH0_AUDIENCE = 'https://pathviewpro.com/api';

// Global auth state
var auth0Client = null;
var currentUser = null;

// Configuration (only define if not already defined)
if (typeof CONFIG === 'undefined') {
    var CONFIG = {
        orthancUrl: '/dicom-web',
        converterUrl: '/api'
    };
}

/**
 * Initialize Auth0 and check authentication
 * @param {boolean} redirectIfUnauthed - Whether to redirect to home if not logged in
 */
async function initAuth(redirectIfUnauthed = true) {
    try {
        console.log('🔐 Initializing Auth0...');
        auth0Client = await auth0.createAuth0Client({
            domain: AUTH0_DOMAIN,
            clientId: AUTH0_CLIENT_ID,
            authorizationParams: {
                redirect_uri: window.location.origin + '/callback',
                audience: AUTH0_AUDIENCE
            },
            cacheLocation: 'localstorage',
            useRefreshTokens: true,
            useRefreshTokensFallback: true
        });
        // Explicitly expose on window for cross-module access
        window.auth0Client = auth0Client;

        // Handle callback if present in URL
        if (window.location.search.includes('code=')) {
            await auth0Client.handleRedirectCallback();
            window.history.replaceState({}, document.title, window.location.pathname);
        }

        const isAuthenticated = await auth0Client.isAuthenticated();
        
        if (!isAuthenticated) {
            updateUserUI(false);
            if (redirectIfUnauthed) {
                console.log('User not authenticated, redirecting to landing...');
                window.location.href = '/';
            }
            return false;
        }

        // Get user info
        currentUser = await auth0Client.getUser();
        updateUserUI(true);
        
        // Sync profile to backend
        syncUserProfile();
        
        return true;
    } catch (e) {
        console.error('Auth init error:', e);
        updateUserUI(false);
        return false;
    }
}

/**
 * Update UI with current user info
 * @param {boolean} authenticated - Current auth status
 */
function updateUserUI(authenticated = true) {
    const userMenu = document.getElementById('user-menu');
    const userAvatar = document.getElementById('user-avatar');
    const userName = document.getElementById('user-name');
    const userEmail = document.getElementById('user-email');
    const authBadge = document.getElementById('auth-badge');
    const loginBtn = document.getElementById('login-btn');
    
    if (authenticated && currentUser) {
        if (userMenu) userMenu.style.display = 'block';
        if (loginBtn) loginBtn.style.display = 'none';
        if (userAvatar) userAvatar.src = currentUser.picture || '';
        if (userName) userName.textContent = currentUser.name || currentUser.email?.split('@')[0] || 'User';
        if (userEmail) userEmail.textContent = currentUser.email || '';
        
        if (authBadge) {
            authBadge.innerHTML = `✓ Logged in as <strong>${currentUser.email}</strong> - uploads will be saved to your account`;
            authBadge.style.color = 'var(--success)';
        }
    } else {
        if (userMenu) userMenu.style.display = 'none';
        if (loginBtn) loginBtn.style.display = 'block';
        
        if (authBadge) {
            authBadge.innerHTML = '⚠ Not logged in - <button onclick="login()" style="color: var(--accent); background: none; border: none; cursor: pointer; text-decoration: underline; padding: 0; font: inherit;">Click to login</button> to own your uploads';
            authBadge.style.color = 'var(--warning)';
        }
    }
}

/**
 * Trigger login redirect
 */
async function login() {
    if (!auth0Client) return;
    await auth0Client.loginWithRedirect({
        authorizationParams: {
            redirect_uri: window.location.href
        }
    });
}

/**
 * Sync Auth0 profile info to backend database
 */
async function syncUserProfile() {
    if (!currentUser || !auth0Client) return;
    
    try {
        const token = await auth0Client.getTokenSilently();
        await fetch('/api/users/me', {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                email: currentUser.email,
                name: currentUser.name,
                picture: currentUser.picture
            })
        });
    } catch (e) {
        // Silent fail - profile sync is non-critical
        console.debug('Profile sync:', e.message);
    }
}

/**
 * Toggle user dropdown menu
 */
function toggleUserDropdown() {
    const dropdown = document.getElementById('user-dropdown');
    if (dropdown) dropdown.classList.toggle('active');
}

/**
 * Logout user
 */
async function logout() {
    if (auth0Client) {
        await auth0Client.logout({
            logoutParams: {
                returnTo: window.location.origin
            }
        });
    } else {
        window.location.href = '/';
    }
}

/**
 * Get current Auth0 access token
 */
async function getAuthToken() {
    if (!auth0Client) {
        console.warn('🔐 getAuthToken: auth0Client not initialized');
        return null;
    }
    try {
        const token = await auth0Client.getTokenSilently();
        return token;
    } catch (e) {
        console.error('🔐 getAuthToken failed:', e.error || e.message);
        return null;
    }
}

/**
 * Authenticated API fetch helper
 * Automatically adds auth token to requests
 */
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
            console.error('Token retrieval error:', e.error || e.message);
            
            // Handle Auth0 errors requiring re-authentication
            const errorCode = e.error || e.message || '';
            if (errorCode.includes('login_required') || 
                errorCode.includes('consent_required') ||
                errorCode.includes('invalid_grant') ||
                errorCode.includes('missing_refresh_token')) {
                console.warn('Session expired - redirecting to login');
                await auth0Client.loginWithRedirect({
                    appState: { returnTo: window.location.pathname }
                });
                return new Response(null, { status: 401 });
            }
            console.warn('Failed to get auth token for:', url);
        }
    }
    return fetch(url, options);
}

/**
 * Format DICOM patient name (Last^First^Middle -> First Last)
 */
function formatDicomName(name) {
    if (!name) return null;
    const parts = name.split('^');
    if (parts.length >= 2) {
        return `${parts[1]} ${parts[0]}`.trim();
    }
    return name;
}

/**
 * Format DICOM date (YYYYMMDD -> YYYY-MM-DD)
 */
function formatDicomDate(date) {
    if (!date || date.length !== 8) return null;
    return `${date.substring(0, 4)}-${date.substring(4, 6)}-${date.substring(6, 8)}`;
}

/**
 * Check Orthanc server status
 */
async function checkServerStatus() {
    const badge = document.getElementById('server-status');
    try {
        const response = await fetch('/api/system');
        const data = await response.json();
        
        if (data.Version) {
            badge.textContent = `Orthanc ${data.Version}`;
            badge.classList.add('connected');
        } else {
            badge.textContent = 'Orthanc connected';
            badge.classList.add('connected');
        }
    } catch (e) {
        badge.textContent = 'Server offline';
        badge.classList.remove('connected');
    }
}

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
    const userMenu = document.getElementById('user-menu');
    const dropdown = document.getElementById('user-dropdown');
    if (userMenu && dropdown && !userMenu.contains(e.target)) {
        dropdown.classList.remove('active');
    }
});

// Register Service Worker for tile caching
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js')
        .then(reg => console.log('Service Worker registered for tile caching'))
        .catch(err => console.log('Service Worker not available:', err));
}
