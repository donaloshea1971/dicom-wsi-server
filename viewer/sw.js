// Service Worker for WSI Tile Caching
const CACHE_NAME = 'wsi-tiles-v1';
const TILE_CACHE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_CACHE_SIZE = 500; // Max tiles to cache

// Patterns to cache
const TILE_PATTERNS = [
    /\/wsi\/tiles\//,
    /\/wsi\/pyramids\//
];

// Install - pre-cache essential files
self.addEventListener('install', (event) => {
    console.log('[SW] Installing service worker');
    self.skipWaiting();
});

// Activate - clean old caches
self.addEventListener('activate', (event) => {
    console.log('[SW] Activating service worker');
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames
                    .filter((name) => name !== CACHE_NAME)
                    .map((name) => caches.delete(name))
            );
        })
    );
    self.clients.claim();
});

// Fetch - cache tiles
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    
    // Only cache tile requests
    const isTile = TILE_PATTERNS.some(pattern => pattern.test(url.pathname));
    
    if (isTile && event.request.method === 'GET') {
        event.respondWith(
            caches.open(CACHE_NAME).then((cache) => {
                return cache.match(event.request).then((cachedResponse) => {
                    if (cachedResponse) {
                        // Return cached tile
                        return cachedResponse;
                    }
                    
                    // Fetch and cache
                    return fetch(event.request).then((response) => {
                        if (response.ok) {
                            // Clone and cache
                            cache.put(event.request, response.clone());
                            
                            // Trim cache if too large
                            trimCache(cache);
                        }
                        return response;
                    }).catch(() => {
                        // Network failed, return placeholder
                        return new Response('', { status: 503 });
                    });
                });
            })
        );
    }
});

// Trim cache to max size
async function trimCache(cache) {
    const keys = await cache.keys();
    if (keys.length > MAX_CACHE_SIZE) {
        // Delete oldest entries (first in list)
        const toDelete = keys.slice(0, keys.length - MAX_CACHE_SIZE);
        await Promise.all(toDelete.map(key => cache.delete(key)));
    }
}

// Listen for messages
self.addEventListener('message', (event) => {
    if (event.data === 'clearCache') {
        caches.delete(CACHE_NAME).then(() => {
            console.log('[SW] Cache cleared');
        });
    }
});
