/**
 * PathView Pro - Viewer Main Module
 * OpenSeadragon initialization, compare mode, and viewer-related functions
 */

// Global viewer state (use var for compatibility with inline fallbacks)
var viewer = null;
var currentStudy = null;

// Compare mode state
var compareMode = false;
var viewer2 = null;
var currentStudy2 = null;
var syncNavigation = false;
var activeViewer = 1; // 1 or 2
var compareSlideName1 = '';
var compareSlideName2 = '';

// Color correction state
var colorCorrection = null;
var currentICCProfile = null;

// SpaceMouse controller
var spaceNavController = null;

// Annotation manager
var annotationManager = null;
var annotationEventSource = null;

/**
 * Show/hide loading overlay
 */
function showLoading(show, message = 'Loading...') {
    // Implementation depends on your loading UI
    const placeholder = document.getElementById('viewer-placeholder');
    if (placeholder) {
        if (show) {
            placeholder.style.display = 'flex';
            const loadingText = placeholder.querySelector('p');
            if (loadingText) loadingText.textContent = message;
        } else {
            placeholder.style.display = 'none';
        }
    }
}

/**
 * Close metadata modal
 */
function closeMetadataModal() {
    const modal = document.getElementById('metadata-modal');
    if (modal) modal.style.display = 'none';
}

/**
 * Add label to viewer
 */
function addViewerLabel(viewerId, label) {
    const viewerEl = document.getElementById(viewerId);
    if (!viewerEl) return;
    
    // Remove existing label
    const existing = viewerEl.querySelector('.viewer-label');
    if (existing) existing.remove();
    
    const labelEl = document.createElement('div');
    labelEl.className = 'viewer-label';
    labelEl.textContent = label;
    viewerEl.appendChild(labelEl);
}

/**
 * Set active viewer in compare mode
 */
function setActiveViewer(num) {
    activeViewer = num;
    document.getElementById('osd-viewer').classList.toggle('active-viewer', num === 1);
    document.getElementById('osd-viewer-2').classList.toggle('active-viewer', num === 2);
    
    // Update SpaceMouse viewer reference
    if (spaceNavController && spaceNavController.connected) {
        spaceNavController.setViewer(num === 1 ? viewer : viewer2);
    }
}

/**
 * Set up synchronized navigation between viewers
 */
function setupSyncNavigation() {
    if (!viewer || !viewer2) return;
    
    let syncing = false;
    
    const syncFrom = (source, target) => {
        if (syncing) return;
        syncing = true;
        
        const sourceViewport = source.viewport;
        const targetViewport = target.viewport;
        
        targetViewport.panTo(sourceViewport.getCenter());
        targetViewport.zoomTo(sourceViewport.getZoom());
        
        syncing = false;
    };
    
    viewer.addHandler('pan', () => syncNavigation && syncFrom(viewer, viewer2));
    viewer.addHandler('zoom', () => syncNavigation && syncFrom(viewer, viewer2));
    viewer2.addHandler('pan', () => syncNavigation && syncFrom(viewer2, viewer));
    viewer2.addHandler('zoom', () => syncNavigation && syncFrom(viewer2, viewer));
}

/**
 * Toggle synchronized navigation
 */
function toggleSyncNavigation() {
    syncNavigation = !syncNavigation;
    const btn = document.getElementById('sync-btn');
    if (btn) btn.classList.toggle('active', syncNavigation);
    
    if (syncNavigation && viewer && viewer2) {
        // Sync viewer2 to viewer1
        viewer2.viewport.panTo(viewer.viewport.getCenter());
        viewer2.viewport.zoomTo(viewer.viewport.getZoom());
    }
}

/**
 * Swap viewers in compare mode
 */
function swapViewers() {
    if (!compareMode || !viewer2) return;
    
    // Swap labels
    [compareSlideName1, compareSlideName2] = [compareSlideName2, compareSlideName1];
    addViewerLabel('osd-viewer', compareSlideName1);
    addViewerLabel('osd-viewer-2', compareSlideName2);
    
    // Swap current study references
    [currentStudy, currentStudy2] = [currentStudy2, currentStudy];
    
    // Note: Actually swapping the tile sources would be complex
    // This just swaps the labels for now
}

/**
 * Exit compare mode
 */
function exitCompareMode() {
    compareMode = false;
    
    document.querySelector('.viewer-container').classList.remove('compare-mode');
    document.getElementById('compare-toolbar').classList.remove('active');
    
    // Destroy viewer2
    if (viewer2) {
        viewer2.destroy();
        viewer2 = null;
    }
    currentStudy2 = null;
    compareSlideName2 = '';
    
    // Remove labels
    const label1 = document.getElementById('osd-viewer')?.querySelector('.viewer-label');
    const label2 = document.getElementById('osd-viewer-2')?.querySelector('.viewer-label');
    if (label1) label1.remove();
    if (label2) label2.remove();
    
    // Reset SpaceMouse to main viewer
    if (spaceNavController && spaceNavController.connected) {
        spaceNavController.setViewer(viewer);
    }
    
    updateCompareButtons();
}

/**
 * Update compare buttons state
 */
function updateCompareButtons() {
    document.querySelectorAll('.compare-btn').forEach(btn => {
        const id = btn.dataset.compareId;
        btn.classList.toggle('comparing', id === currentStudy || id === currentStudy2);
    });
}

/**
 * Toggle gamma correction
 */
function toggleGamma() {
    const viewerEl = document.getElementById('osd-viewer');
    viewerEl.classList.toggle('gamma-correct');
    updateGammaBadge();
}

/**
 * Initialize color correction
 */
function initColorCorrection() {
    const canvas = document.getElementById('osd-viewer');
    if (canvas && typeof ColorCorrection !== 'undefined') {
        colorCorrection = new ColorCorrection(canvas);
        console.log('Color correction ready');
    }
}

/**
 * Open color panel
 */
function openColorPanel() {
    const panel = document.getElementById('color-panel');
    if (panel) panel.classList.add('active');
}

/**
 * Close color panel
 */
function closeColorPanel(event) {
    if (event) event.stopPropagation();
    const panel = document.getElementById('color-panel');
    if (panel) panel.classList.remove('active');
}

/**
 * Apply color preset
 */
function applyColorPreset(preset) {
    if (colorCorrection) {
        colorCorrection.setPreset(preset);
        updateColorUI();
        updateGammaBadge();
    }
}

/**
 * Update color parameter
 */
function updateColorParam(param, value) {
    if (!colorCorrection) return;
    
    const numValue = parseFloat(value);
    colorCorrection.setParam(param, numValue);
    
    // Update display
    const display = document.getElementById(`${param}-value`);
    if (display) display.textContent = numValue.toFixed(2);
    
    updateGammaBadge();
}

/**
 * Update color UI sliders
 */
function updateColorUI() {
    if (!colorCorrection) return;
    
    const params = colorCorrection.getParams();
    ['gamma', 'brightness', 'contrast', 'saturation'].forEach(param => {
        const slider = document.getElementById(`${param}-slider`);
        const display = document.getElementById(`${param}-value`);
        if (slider) slider.value = params[param];
        if (display) display.textContent = params[param].toFixed(2);
    });
}

/**
 * Update gamma badge display
 */
function updateGammaBadge() {
    const badge = document.getElementById('gamma-badge');
    if (!badge) return;
    
    if (colorCorrection && colorCorrection.isEnabled()) {
        const params = colorCorrection.getParams();
        badge.textContent = `γ ${params.gamma.toFixed(1)}`;
        badge.style.display = 'block';
    } else {
        badge.style.display = 'none';
    }
}

/**
 * Reset color correction
 */
function resetColorCorrection() {
    if (colorCorrection) {
        colorCorrection.reset();
        updateColorUI();
        updateGammaBadge();
    }
}

/**
 * Toggle fullscreen mode
 */
function toggleFullscreen() {
    if (!document.fullscreenElement) {
        document.getElementById('osd-viewer').requestFullscreen();
    } else {
        document.exitFullscreen();
    }
}

/**
 * Connect to annotation sync SSE
 */
function connectAnnotationSync(studyId) {
    // Disconnect existing connection
    disconnectAnnotationSync();
    
    try {
        annotationEventSource = new EventSource(`/api/studies/${studyId}/events`);
        
        annotationEventSource.onopen = () => {
            console.log('SSE connected for annotations');
        };
        
        annotationEventSource.onerror = (e) => {
            console.log('SSE connection error, will retry...', e);
        };
        
        annotationEventSource.addEventListener('annotation', (e) => {
            try {
                const data = JSON.parse(e.data);
                console.log('SSE annotation event:', data);
                // Handle real-time annotation updates here
            } catch (err) {
                console.error('Failed to parse SSE event:', err);
            }
        });
    } catch (e) {
        console.warn('Could not connect to annotation sync:', e);
    }
}

/**
 * Disconnect annotation sync SSE
 */
function disconnectAnnotationSync() {
    if (annotationEventSource) {
        annotationEventSource.close();
        annotationEventSource = null;
    }
}
