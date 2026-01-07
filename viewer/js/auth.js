/**
 * PathView Pro - Authentication and API Utilities
 * Handles Auth0 authentication, user management, and API requests
 */

// Auth0 Configuration
const AUTH0_DOMAIN = 'dev-jkm887wawwxknno6.us.auth0.com';
const AUTH0_CLIENT_ID = 'gT8pYvmdyFUhmPSVY5P5pAxiUwmTdvBr';

// Global auth state
let auth0Client = null;
let currentUser = null;

// Configuration (only define if not already defined)
if (typeof CONFIG === 'undefined') {
    var CONFIG = {
        orthancUrl: '/dicom-web',
        converterUrl: '/api'
    };
}

/**
 * Initialize Auth0 and check authentication
 */
async function initAuth() {
    try {
        auth0Client = await auth0.createAuth0Client({
            domain: AUTH0_DOMAIN,
            clientId: AUTH0_CLIENT_ID,
            authorizationParams: {
                redirect_uri: 'https://pathviewpro.com/callback',
                audience: 'https://pathviewpro.com/api'
            },
            cacheLocation: 'localstorage',
            useRefreshTokens: true,
            useRefreshTokensFallback: true
        });

        const isAuthenticated = await auth0Client.isAuthenticated();
        
        if (!isAuthenticated) {
            // Not logged in - redirect to landing
            window.location.href = '/';
            return false;
        }

        // Get user info
        currentUser = await auth0Client.getUser();
        updateUserUI();
        
        // Sync profile to backend (email, name, picture)
        syncUserProfile();
        
        return true;
    } catch (e) {
        console.error('Auth init error:', e);
        // If Auth0 not configured, allow access (dev mode)
        if (AUTH0_DOMAIN === 'YOUR_AUTH0_DOMAIN') {
            console.warn('Auth0 not configured - running in dev mode');
            return true;
        }
        return false;
    }
}

/**
 * Update UI with current user info
 */
function updateUserUI() {
    if (!currentUser) return;
    
    const userMenu = document.getElementById('user-menu');
    const userAvatar = document.getElementById('user-avatar');
    const userName = document.getElementById('user-name');
    const userEmail = document.getElementById('user-email');
    
    if (userMenu) userMenu.style.display = 'block';
    if (userAvatar) userAvatar.src = currentUser.picture || '';
    if (userName) userName.textContent = currentUser.name || currentUser.email?.split('@')[0] || 'User';
    if (userEmail) userEmail.textContent = currentUser.email || '';
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
 * Authenticated API fetch helper
 * Automatically adds auth token to requests
 */
async function authFetch(url, options = {}) {
    // Get access token if authenticated
    if (auth0Client) {
        try {
            const token = await auth0Client.getTokenSilently();
            options.headers = {
                ...options.headers,
                'Authorization': `Bearer ${token}`
            };
            console.debug('Auth token added to request:', url);
        } catch (e) {
            console.error('Token retrieval error:', e.error || e.message, e);
            
            // Handle specific Auth0 errors that require re-authentication
            const errorCode = e.error || e.message || '';
            if (errorCode.includes('login_required') || 
                errorCode.includes('consent_required') ||
                errorCode.includes('invalid_grant') ||
                errorCode.includes('missing_refresh_token')) {
                console.warn('Session expired or invalid - redirecting to login');
                // Clear any stale state and redirect to login
                await auth0Client.loginWithRedirect({
                    appState: { returnTo: window.location.pathname }
                });
                return new Response(null, { status: 401 }); // Return empty response while redirecting
            }
            
            // For other errors, log and proceed without token
            console.warn('Failed to get auth token for:', url, '- proceeding without auth');
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
