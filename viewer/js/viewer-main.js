/**
 * PathView Pro - Viewer Main Module
 * OpenSeadragon initialization, compare mode, and viewer-related functions
 */

// Global viewer state
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

// Internal compare-mode wiring state (avoid duplicated handlers / stale listeners)
var _syncNavigationHandlers = null;
var _compareFocusHandlers = {
    v1: { el: null, fn: null },
    v2: { el: null, fn: null }
};

// Color correction state
var colorCorrection = null;
var currentICCProfile = null;
var iccApplied = false;

// SpaceMouse controller
var spaceNavController = null;

// Annotation state
var annotationManager = null;
var annotationEventSource = null;

/**
 * Show/hide loading overlay or update placeholder text
 */
function showLoading(show, message = 'Loading...') {
    const placeholder = document.getElementById('viewer-placeholder');
    const loadingOverlay = document.getElementById('loading');
    
    if (show) {
        if (loadingOverlay) loadingOverlay.style.display = 'flex';
        if (placeholder) {
            placeholder.style.display = 'flex';
            const loadingText = placeholder.querySelector('p');
            if (loadingText) loadingText.textContent = message;
        }
    } else {
        if (loadingOverlay) loadingOverlay.style.display = 'none';
        if (placeholder) placeholder.style.display = 'none';
    }
}

/**
 * Close metadata modal
 */
function closeMetadataModal() {
    const modal = document.getElementById('metadata-modal');
    if (modal) modal.classList.remove('active');
}

/**
 * Add a text label to a viewer container
 */
function addViewerLabel(viewerId, label) {
    const container = document.getElementById(viewerId);
    if (!container) return;
    
    const existing = container.querySelector('.viewer-label');
    if (existing) existing.remove();
    
    const labelEl = document.createElement('div');
    labelEl.className = 'viewer-label';
    labelEl.textContent = label;
    container.appendChild(labelEl);
}

/**
 * Set the active viewer in comparison mode
 */
function setActiveViewer(num) {
    activeViewer = num;
    const v1 = document.getElementById('osd-viewer');
    const v2 = document.getElementById('osd-viewer-2');
    if (v1) v1.classList.toggle('active-viewer', num === 1);
    if (v2) v2.classList.toggle('active-viewer', num === 2);
    
    if (spaceNavController && spaceNavController.connected) {
        spaceNavController.setViewer(num === 1 ? viewer : viewer2);
    }
}

/**
 * (Re)bind mousedown handlers so clicks select the correct active viewer.
 * Important because `swapViewers()` changes element IDs and can invalidate prior bindings.
 */
function _bindCompareFocusHandlers() {
    const el1 = document.getElementById('osd-viewer');
    const el2 = document.getElementById('osd-viewer-2');

    if (el1) {
        if (_compareFocusHandlers.v1.el && _compareFocusHandlers.v1.fn) {
            _compareFocusHandlers.v1.el.removeEventListener('mousedown', _compareFocusHandlers.v1.fn, true);
        }
        _compareFocusHandlers.v1.el = el1;
        _compareFocusHandlers.v1.fn = () => { if (compareMode) setActiveViewer(1); };
        el1.addEventListener('mousedown', _compareFocusHandlers.v1.fn, true);
    }

    if (el2) {
        if (_compareFocusHandlers.v2.el && _compareFocusHandlers.v2.fn) {
            _compareFocusHandlers.v2.el.removeEventListener('mousedown', _compareFocusHandlers.v2.fn, true);
        }
        _compareFocusHandlers.v2.el = el2;
        _compareFocusHandlers.v2.fn = () => { if (compareMode) setActiveViewer(2); };
        el2.addEventListener('mousedown', _compareFocusHandlers.v2.fn, true);
    }
}

/**
 * Remove previously installed sync handlers (prevents jitter/feedback loops from duplicates).
 */
function _clearSyncNavigationHandlers() {
    if (!_syncNavigationHandlers) return;
    const h = _syncNavigationHandlers;

    try {
        if (viewer) {
            viewer.removeHandler('pan', h.v1Pan);
            viewer.removeHandler('zoom', h.v1Zoom);
        }
    } catch (e) {}

    try {
        if (viewer2) {
            viewer2.removeHandler('pan', h.v2Pan);
            viewer2.removeHandler('zoom', h.v2Zoom);
        }
    } catch (e) {}

    _syncNavigationHandlers = null;
}

/**
 * Load a study into the main viewer or viewer 2
 */
async function loadStudy(studyId) {
    if (compareMode && studyId !== currentStudy && !currentStudy2) {
        const card = document.querySelector(`.study-card[data-id="${studyId}"]`);
        const slideName = card ? card.querySelector('.study-slide-info')?.textContent || studyId.substring(0, 8) : studyId.substring(0, 8);
        loadStudyInViewer2(studyId, slideName);
        return;
    }
    
    showLoading(true);
    currentStudy = studyId;
    closeMetadataModal();
    
    if (annotationManager) {
        annotationManager.destroy();
        annotationManager = null;
    }
    
    const annotationsPanel = document.getElementById('annotations-panel');
    if (annotationsPanel) annotationsPanel.classList.remove('active');

    document.querySelectorAll('.study-card').forEach(card => {
        card.classList.toggle('active', card.dataset.id === studyId);
    });

    const placeholder = document.getElementById('viewer-placeholder');
    if (placeholder) placeholder.style.display = 'none';
    const toolbar = document.getElementById('viewer-toolbar');
    if (toolbar) toolbar.style.display = 'flex';

    try {
        const studyResponse = await authFetch(`/api/studies/${studyId}`);
        const studyData = await studyResponse.json();
        
        if (!studyData.Series || studyData.Series.length === 0) {
            throw new Error('No series found in study');
        }
        
        const seriesId = studyData.Series[0];
        
        let needsGammaCorrection = false;
        try {
            const seriesInfo = await authFetch(`/api/series/${seriesId}`);
            const seriesData = await seriesInfo.json();
            if (seriesData.Instances && seriesData.Instances.length > 0) {
                const instanceId = seriesData.Instances[0];
                const tagsResponse = await authFetch(`/api/instances/${instanceId}/simplified-tags`);
                const tags = await tagsResponse.json();
                const manufacturer = (tags.Manufacturer || '').toLowerCase();
                if (manufacturer.includes('hamamatsu')) {
                    needsGammaCorrection = true;
                }
            }
        } catch (e) {}

        let pyramidResponse = await fetch(`/wsi/pyramids/${seriesId}`);
        let pyramid;
        
        if (!pyramidResponse.ok) {
            const leicaResponse = await authFetch(`/api/leica-pyramid/${studyId}`);
            if (leicaResponse.ok) {
                pyramid = await leicaResponse.json();
                if (pyramid.error) throw new Error('Not a recognized WSI format');
            } else {
                throw new Error('WSI pyramid not available');
            }
        } else {
            pyramid = await pyramidResponse.json();
        }

        if (viewer) viewer.destroy();

        const baseTileWidth = pyramid.TilesSizes[0][0];
        const baseTileHeight = pyramid.TilesSizes[0][1];
        const level0TilesX = pyramid.TilesCount[0][0];
        const level0TilesY = pyramid.TilesCount[0][1];
        
        let compatibleLevels;
        if (level0TilesX * level0TilesY < 200) {
            compatibleLevels = [{
                wsiIndex: 0,
                scale: 1.0,
                width: pyramid.Sizes[0][0],
                height: pyramid.Sizes[0][1],
                tilesX: level0TilesX,
                tilesY: level0TilesY,
                tileWidth: baseTileWidth,
                tileHeight: baseTileHeight
            }];
        } else {
            compatibleLevels = pyramid.Resolutions.map((res, i) => ({
                wsiIndex: i,
                scale: 1.0 / res,
                width: pyramid.Sizes[i][0],
                height: pyramid.Sizes[i][1],
                tilesX: pyramid.TilesCount[i][0],
                tilesY: pyramid.TilesCount[i][1],
                tileWidth: pyramid.TilesSizes[i][0],
                tileHeight: pyramid.TilesSizes[i][1]
            })).filter(level => {
                const tileMatch = level.tileWidth === baseTileWidth && level.tileHeight === baseTileHeight;
                const imageFillsTile = level.width >= level.tileWidth || level.height >= level.tileHeight;
                return tileMatch && imageFillsTile;
            });
            
            if (compatibleLevels.length === 0) {
                compatibleLevels = [{
                    wsiIndex: 0, scale: 1.0, width: pyramid.Sizes[0][0], height: pyramid.Sizes[0][1],
                    tilesX: level0TilesX, tilesY: level0TilesY, tileWidth: baseTileWidth, tileHeight: baseTileHeight
                }];
            }
        }
        
        const wsiLevels = compatibleLevels.reverse();
        const maxLevelIndex = wsiLevels.length - 1;
        wsiLevels.forEach((level, idx) => {
            const highestResLevel = wsiLevels[maxLevelIndex];
            level.scale = level.width / highestResLevel.width;
        });
        
        if (!OpenSeadragon.WsiTileSource) {
            OpenSeadragon.WsiTileSource = function(options) {
                this.wsiSeriesId = options.wsiSeriesId;
                this.wsiLevels = options.wsiLevels;
                this.pyramid = options.pyramid;
                this.sessionId = options.sessionId;
                this.width = options.width;
                this.height = options.height;
                this.aspectRatio = options.width / options.height;
                this.dimensions = new OpenSeadragon.Point(options.width, options.height);
                this.tileOverlap = 0;
                this.minLevel = 0;
                this.maxLevel = this.wsiLevels.length - 1;
                this.ready = true;
            };
            OpenSeadragon.WsiTileSource.prototype = Object.create(OpenSeadragon.TileSource.prototype);
            OpenSeadragon.WsiTileSource.prototype.constructor = OpenSeadragon.WsiTileSource;
            OpenSeadragon.WsiTileSource.prototype.getNumLevels = function() { return this.wsiLevels.length; };
            OpenSeadragon.WsiTileSource.prototype.getLevelScale = function(level) { return this.wsiLevels[level]?.scale || 1; };
            OpenSeadragon.WsiTileSource.prototype.getTileWidth = function(level) { return this.wsiLevels[level]?.tileWidth || 256; };
            OpenSeadragon.WsiTileSource.prototype.getTileHeight = function(level) { return this.wsiLevels[level]?.tileHeight || 256; };
            OpenSeadragon.WsiTileSource.prototype.getTileUrl = function(level, x, y) {
                const wsi = this.wsiLevels[level];
                if (!wsi || x < 0 || y < 0 || x >= wsi.tilesX || y >= wsi.tilesY) return null;
                if (this.pyramid?.IsVirtualPyramid && this.pyramid.Type === 'LeicaMultiFile') {
                    const instanceId = this.pyramid.InstanceIDs[wsi.wsiIndex];
                    const left = x * wsi.tileWidth;
                    const top = y * wsi.tileHeight;
                    return `/wsi/instances/${instanceId}/frames/1/rendered?left=${left}&top=${top}&width=${wsi.tileWidth}&height=${wsi.tileHeight}&_=${this.sessionId}`;
                }
                return `/wsi/tiles/${this.wsiSeriesId}/${wsi.wsiIndex}/${x}/${y}?_=${this.sessionId}`;
            };
        }
        
        const wsiTileSource = new OpenSeadragon.WsiTileSource({
            width: pyramid.TotalWidth, height: pyramid.TotalHeight, sessionId: Date.now(),
            wsiSeriesId: seriesId, wsiLevels: wsiLevels, pyramid: pyramid
        });

        let tileAuthHeaders = {};
        try {
            const token = await auth0Client.getTokenSilently();
            tileAuthHeaders = { 'Authorization': `Bearer ${token}` };
        } catch (e) {}

        viewer = OpenSeadragon({
            id: 'osd-viewer',
            prefixUrl: 'https://cdn.jsdelivr.net/npm/openseadragon@4.1/build/openseadragon/images/',
            showNavigationControl: false,
            // Navigator (minimap) settings
            showNavigator: true,
            navigatorPosition: 'BOTTOM_RIGHT',
            navigatorSizeRatio: 0.15,
            navigatorMaintainSizeRatio: true,
            navigatorAutoResize: true,
            navigatorBackground: '#1a1a2e',
            navigatorBorderColor: '#333',
            // Animation and rendering
            animationTime: 0.2,
            blendTime: 0.1,
            constrainDuringPan: true,
            maxZoomPixelRatio: 4,
            minZoomImageRatio: 0.5,
            immediateRender: true,
            imageLoaderLimit: 12,
            tileSources: wsiTileSource,
            crossOriginPolicy: 'Anonymous',
            loadTilesWithAjax: true,
            ajaxHeaders: tileAuthHeaders,
            preload: true,
        });

        viewer.addHandler('zoom', (e) => {
            const zoomEl = document.getElementById('zoom-level');
            if (zoomEl) zoomEl.textContent = e.zoom.toFixed(1) + 'x';
        });
        
        viewer.addHandler('open', () => {
            showLoading(false);
            connectAnnotationSync(studyId);

            if (spaceNavController) {
                spaceNavController.setViewer(viewer);
            } else if (typeof SpaceNavigatorController !== 'undefined') {
                spaceNavController = new SpaceNavigatorController(viewer);
                
                // Set up button handler for compare mode and single mode
                spaceNavController.onButtonPress = function(evt) {
                    if (!evt.pressed) return; // Only act on press, not release
                    
                    if (compareMode && viewer2) {
                        // In compare mode: LEFT/RIGHT switch active viewer
                        if (evt.button === 'left') {
                            setActiveViewer(1);
                            console.log('🎮 SpaceMouse: Activated LEFT viewer');
                        } else if (evt.button === 'right') {
                            setActiveViewer(2);
                            console.log('🎮 SpaceMouse: Activated RIGHT viewer');
                        }
                    } else {
                        // Single viewer mode: buttons cycle through studies
                        if (evt.button === 'left') {
                            previousStudy();
                        } else if (evt.button === 'right') {
                            nextStudy();
                        }
                    }
                };
                
                spaceNavController.autoConnect().then(connected => {
                    if (connected) updateSpaceNavButton(true, spaceNavController.getConnectionMode());
                });
            }
            
            if (typeof resetAnnotationToolbar === 'function') resetAnnotationToolbar();
            const annotToolbar = document.getElementById('annotation-toolbar');
            if (annotToolbar) annotToolbar.style.display = 'flex';
            
            setTimeout(() => {
                if (typeof loadStudyAnnotations === 'function') loadStudyAnnotations(studyId);
            }, 500);
                
            if (!colorCorrection && typeof ColorCorrection !== 'undefined') {
                const canvas = document.getElementById('osd-viewer');
                colorCorrection = new ColorCorrection(canvas);
            }
            
            const viewerEl = document.getElementById('osd-viewer');
            if (viewerEl) viewerEl.classList.remove('gamma-correct', 'color-corrected');
            
            if (needsGammaCorrection && colorCorrection) {
                colorCorrection.setPreset('Hamamatsu');
                colorCorrection.enable();
                updateGammaBadge();
            }
            
            const colorBadge = document.getElementById('color-badge');
            if (colorBadge) colorBadge.style.display = 'block';
            
            checkICCProfile(currentStudy);
        });

    } catch (e) {
        console.error('Failed to load study:', e);
        showLoading(false);
    }
}

/**
 * Add study to comparison mode
 */
function addToCompare(studyId, slideName) {
    if (!compareMode) {
        enterCompareMode(studyId, slideName);
    } else if (studyId !== currentStudy) {
        loadStudyInViewer2(studyId, slideName);
    }
}

/**
 * Enter comparison mode
 */
function enterCompareMode(studyId, slideName) {
    compareMode = true;
    const container = document.querySelector('.viewer-container');
    const compareToolbar = document.getElementById('compare-toolbar');
    if (container) container.classList.add('compare-mode');
    if (compareToolbar) compareToolbar.classList.add('active');

    // Default to left viewer active on entry
    setActiveViewer(1);
    _bindCompareFocusHandlers();
    
    if (currentStudy === studyId) {
        compareSlideName1 = slideName || studyId.substring(0, 8);
        addViewerLabel('osd-viewer', compareSlideName1);
    } else if (!currentStudy) {
        compareSlideName1 = slideName || studyId.substring(0, 8);
        loadStudy(studyId);
        addViewerLabel('osd-viewer', compareSlideName1);
    } else {
        const currentCard = document.querySelector(`.study-card[data-id="${currentStudy}"]`);
        compareSlideName1 = currentCard ? currentCard.querySelector('.study-slide-info')?.textContent || currentStudy.substring(0, 8) : currentStudy.substring(0, 8);
        addViewerLabel('osd-viewer', compareSlideName1);
        loadStudyInViewer2(studyId, slideName);
    }
    
    updateCompareButtons();
    if (viewer && syncNavigation) setupSyncNavigation();
}

/**
 * Load a study into the secondary viewer
 */
async function loadStudyInViewer2(studyId, slideName) {
    currentStudy2 = studyId;
    compareSlideName2 = slideName || studyId.substring(0, 8);
    
    const placeholder = document.getElementById('viewer-placeholder-2');
    if (placeholder) placeholder.style.display = 'none';
    
    try {
        const response = await authFetch(`/api/studies/${studyId}`);
        const studyData = await response.json();
        const seriesId = studyData.Series[0];
        
        let pyramidResponse = await fetch(`/wsi/pyramids/${seriesId}`);
        let pyramidData;
        
        if (!pyramidResponse.ok) {
            const leicaResponse = await authFetch(`/api/leica-pyramid/${studyId}`);
            if (leicaResponse.ok) pyramidData = await leicaResponse.json();
            else return;
        } else {
            pyramidData = await pyramidResponse.json();
        }
        
        const baseTileWidth = pyramidData.TilesSizes[0][0];
        const baseTileHeight = pyramidData.TilesSizes[0][1];
        const level0TilesX = pyramidData.TilesCount[0][0];
        const level0TilesY = pyramidData.TilesCount[0][1];
        
        let compatibleLevels;
        if (level0TilesX * level0TilesY < 200) {
            compatibleLevels = [{ wsiIndex: 0, scale: 1.0, width: pyramidData.Sizes[0][0], height: pyramidData.Sizes[0][1], tilesX: level0TilesX, tilesY: level0TilesY, tileWidth: baseTileWidth, tileHeight: baseTileHeight }];
        } else {
            compatibleLevels = pyramidData.Resolutions.map((res, i) => ({ wsiIndex: i, scale: 1.0 / res, width: pyramidData.Sizes[i][0], height: pyramidData.Sizes[i][1], tilesX: pyramidData.TilesCount[i][0], tilesY: pyramidData.TilesCount[i][1], tileWidth: pyramidData.TilesSizes[i][0], tileHeight: pyramidData.TilesSizes[i][1] })).filter(level => level.tileWidth === baseTileWidth && level.tileHeight === baseTileHeight && (level.width >= level.tileWidth || level.height >= level.tileHeight));
            if (compatibleLevels.length === 0) compatibleLevels = [{ wsiIndex: 0, scale: 1.0, width: pyramidData.Sizes[0][0], height: pyramidData.Sizes[0][1], tilesX: level0TilesX, tilesY: level0TilesY, tileWidth: baseTileWidth, tileHeight: baseTileHeight }];
        }
        
        const wsiLevels2 = compatibleLevels.reverse();
        const maxLevelIndex = wsiLevels2.length - 1;
        wsiLevels2.forEach((level, idx) => {
            level.scale = level.width / wsiLevels2[maxLevelIndex].width;
        });
        
        let authHeaders = {};
        try {
            const token = await auth0Client.getTokenSilently();
            authHeaders = { 'Authorization': `Bearer ${token}` };
        } catch (e) {}
        
        if (viewer2) viewer2.destroy();
        
        // Ensure WsiTileSource is defined (may not be if viewer2 loads before viewer1)
        if (!OpenSeadragon.WsiTileSource) {
            OpenSeadragon.WsiTileSource = function(options) {
                this.wsiSeriesId = options.wsiSeriesId;
                this.wsiLevels = options.wsiLevels;
                this.pyramid = options.pyramid;
                this.sessionId = options.sessionId;
                this.width = options.width;
                this.height = options.height;
                this.tileSize = options.wsiLevels[0]?.tileWidth || 256;
                this.tileOverlap = 0;
                this.minLevel = 0;
                this.maxLevel = this.wsiLevels.length - 1;
                this.ready = true;
            };
            OpenSeadragon.WsiTileSource.prototype = Object.create(OpenSeadragon.TileSource.prototype);
            OpenSeadragon.WsiTileSource.prototype.constructor = OpenSeadragon.WsiTileSource;
            OpenSeadragon.WsiTileSource.prototype.getNumLevels = function() { return this.wsiLevels.length; };
            OpenSeadragon.WsiTileSource.prototype.getLevelScale = function(level) { return this.wsiLevels[level]?.scale || 1; };
            OpenSeadragon.WsiTileSource.prototype.getTileWidth = function(level) { return this.wsiLevels[level]?.tileWidth || 256; };
            OpenSeadragon.WsiTileSource.prototype.getTileHeight = function(level) { return this.wsiLevels[level]?.tileHeight || 256; };
            OpenSeadragon.WsiTileSource.prototype.getTileUrl = function(level, x, y) {
                const wsi = this.wsiLevels[level];
                if (!wsi || x < 0 || y < 0 || x >= wsi.tilesX || y >= wsi.tilesY) return null;
                if (this.pyramid?.IsVirtualPyramid && this.pyramid.Type === 'LeicaMultiFile') {
                    const instanceId = this.pyramid.InstanceIDs[wsi.wsiIndex];
                    const left = x * wsi.tileWidth;
                    const top = y * wsi.tileHeight;
                    return `/dicom-web/instances/${instanceId}/rendered?window=center:128,width:256&viewport=${wsi.tileWidth},${wsi.tileHeight}&region=${left},${top},${wsi.tileWidth},${wsi.tileHeight}`;
                }
                return `/wsi/tiles/${this.wsiSeriesId}/${wsi.wsiIndex}/${x}/${y}?_=${this.sessionId}`;
            };
        }
        
        const tileSource2 = new OpenSeadragon.WsiTileSource({
            wsiSeriesId: seriesId, wsiLevels: wsiLevels2, pyramid: pyramidData,
            sessionId: Date.now(), width: pyramidData.TotalWidth, height: pyramidData.TotalHeight
        });
        
        viewer2 = OpenSeadragon({
            id: 'osd-viewer-2',
            prefixUrl: 'https://cdn.jsdelivr.net/npm/openseadragon@4.1/build/openseadragon/images/',
            showNavigationControl: false,
            // Navigator (minimap) settings
            showNavigator: true,
            navigatorPosition: 'TOP_RIGHT',
            navigatorSizeRatio: 0.15,
            navigatorMaintainSizeRatio: true,
            navigatorAutoResize: true,
            navigatorBackground: '#1a1a2e',
            navigatorBorderColor: '#333',
            // Match main viewer physics/animation settings
            animationTime: 0.2,
            blendTime: 0.1,
            constrainDuringPan: true,
            maxZoomPixelRatio: 4,
            minZoomImageRatio: 0.5,
            immediateRender: true,
            imageLoaderLimit: 12,
            crossOriginPolicy: 'Anonymous',
            loadTilesWithAjax: true,
            ajaxHeaders: authHeaders,
            tileSources: tileSource2,
            preload: true
        });
        
        viewer2.addHandler('open', () => {
            addViewerLabel('osd-viewer-2', compareSlideName2);
            if (syncNavigation) setupSyncNavigation();
        });
        
        // Ensure focus/click selection works even after swaps / reloads
        _bindCompareFocusHandlers();
        updateCompareButtons();
        
    } catch (e) {
        console.error('Failed to load viewer 2:', e);
    }
}

/**
 * Set up synchronized navigation between viewers
 */
function setupSyncNavigation() {
    if (!viewer || !viewer2) return;
    // Prevent stacking duplicate handlers
    _clearSyncNavigationHandlers();
    let syncing = false;
    const syncFrom = (source, target) => {
        if (syncing || !source || !target) return;
        syncing = true;
        target.viewport.panTo(source.viewport.getCenter());
        target.viewport.zoomTo(source.viewport.getZoom());
        syncing = false;
    };

    const v1Pan = () => { if (syncNavigation && viewer && viewer2) syncFrom(viewer, viewer2); };
    const v1Zoom = () => { if (syncNavigation && viewer && viewer2) syncFrom(viewer, viewer2); };
    const v2Pan = () => { if (syncNavigation && viewer && viewer2) syncFrom(viewer2, viewer); };
    const v2Zoom = () => { if (syncNavigation && viewer && viewer2) syncFrom(viewer2, viewer); };

    viewer.addHandler('pan', v1Pan);
    viewer.addHandler('zoom', v1Zoom);
    viewer2.addHandler('pan', v2Pan);
    viewer2.addHandler('zoom', v2Zoom);

    _syncNavigationHandlers = { v1Pan, v1Zoom, v2Pan, v2Zoom };
}

/**
 * Toggle synchronized navigation
 */
function toggleSyncNavigation() {
    syncNavigation = !syncNavigation;
    const btn = document.getElementById('sync-nav-btn');
    if (btn) btn.classList.toggle('active', syncNavigation);
    if (syncNavigation && viewer && viewer2) {
        setupSyncNavigation();
        viewer2.viewport.panTo(viewer.viewport.getCenter());
        viewer2.viewport.zoomTo(viewer.viewport.getZoom());
    }
}

/**
 * Swap viewers in comparison mode
 * Physically swaps the viewer DOM elements for instant visual swap
 */
function swapViewers() {
    if (!compareMode || !viewer2 || !currentStudy || !currentStudy2) {
        console.log('🔄 Swap: Cannot swap - missing viewer or studies');
        return;
    }

    // If sync is enabled, clear handlers before swapping references (prevents orphaned handlers)
    _clearSyncNavigationHandlers();
    
    // Swap the viewer DOM elements physically
    const container1 = document.getElementById('osd-viewer');
    const container2 = document.getElementById('osd-viewer-2');
    
    if (!container1 || !container2) return;
    
    // Get the parent and swap positions
    const parent = container1.parentNode;
    const placeholder = document.createElement('div');
    
    // Insert placeholder before container1
    parent.insertBefore(placeholder, container1);
    // Move container1 to where container2 is
    parent.insertBefore(container1, container2.nextSibling);
    // Move container2 to placeholder position
    parent.insertBefore(container2, placeholder);
    // Remove placeholder
    parent.removeChild(placeholder);
    
    // Swap the IDs so they match their new positions
    container1.id = 'osd-viewer-2';
    container2.id = 'osd-viewer';
    
    // Swap our references
    [viewer, viewer2] = [viewer2, viewer];
    [currentStudy, currentStudy2] = [currentStudy2, currentStudy];
    [compareSlideName1, compareSlideName2] = [compareSlideName2, compareSlideName1];
    
    // Update labels
    addViewerLabel('osd-viewer', compareSlideName1);
    addViewerLabel('osd-viewer-2', compareSlideName2);
    
    // Update SpaceMouse to point to correct viewer based on active selection
    if (spaceNavController && spaceNavController.connected) {
        spaceNavController.setViewer(activeViewer === 1 ? viewer : viewer2);
    }

    // IDs were changed; rebind focus handlers and re-install sync handlers if needed
    _bindCompareFocusHandlers();
    if (syncNavigation && viewer && viewer2) setupSyncNavigation();
    
    console.log('🔄 Swapped viewers:', compareSlideName1, '↔', compareSlideName2);
}

/**
 * Exit comparison mode
 */
function exitCompareMode() {
    compareMode = false;
    const container = document.querySelector('.viewer-container');
    const compareToolbar = document.getElementById('compare-toolbar');
    if (container) container.classList.remove('compare-mode');
    if (compareToolbar) compareToolbar.classList.remove('active');

    // Ensure we don't leave sync enabled with only one viewer
    syncNavigation = false;
    const btn = document.getElementById('sync-nav-btn');
    if (btn) btn.classList.remove('active');
    _clearSyncNavigationHandlers();
    
    if (viewer2) { viewer2.destroy(); viewer2 = null; }
    currentStudy2 = null;
    compareSlideName2 = '';
    
    const label1 = document.getElementById('osd-viewer')?.querySelector('.viewer-label');
    const label2 = document.getElementById('osd-viewer-2')?.querySelector('.viewer-label');
    if (label1) label1.remove();
    if (label2) label2.remove();
    
    if (spaceNavController) spaceNavController.setViewer(viewer);
    setActiveViewer(1);
    updateCompareButtons();
}

/**
 * Update compare buttons active state
 */
function updateCompareButtons() {
    document.querySelectorAll('.compare-btn').forEach(btn => {
        const id = btn.dataset.compareId;
        btn.classList.toggle('comparing', id === currentStudy || id === currentStudy2);
    });
}

/**
 * Toggle gamma correction (old method)
 */
function toggleGamma() {
    const viewerEl = document.getElementById('osd-viewer');
    if (viewerEl) viewerEl.classList.toggle('gamma-correct');
    updateGammaBadge();
}

/**
 * Update gamma badge UI
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
 * Update specific color parameter
 */
function updateColorParam(param, value) {
    if (!colorCorrection) return;
    colorCorrection.setParam(param, parseFloat(value));
    const display = document.getElementById(`${param}-value`);
    if (display) display.textContent = parseFloat(value).toFixed(2);
    updateGammaBadge();
}

/**
 * Update all color UI elements
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
 * Reset color correction to defaults
 */
function resetColorCorrection() {
    if (colorCorrection) {
        colorCorrection.reset();
        updateColorUI();
        updateGammaBadge();
    }
}

/**
 * Check if study has an ICC profile and update UI
 */
async function checkICCProfile(studyId) {
    console.log('🎨 checkICCProfile called for:', studyId);
    const iccBadge = document.getElementById('icc-badge');
    if (!iccBadge) {
        console.warn('🎨 ICC badge element not found');
        return;
    }
    currentICCProfile = null;
    iccApplied = false;
    
    try {
        const res = await authFetch(`/api/studies/${studyId}/icc-profile?include_transform=true`);
        console.log('🎨 ICC profile response status:', res.status);
        if (res.ok) {
            const data = await res.json();
            console.log('🎨 ICC profile data:', { has_icc: data.has_icc, has_transform: !!data.color_transform });
            currentICCProfile = data;
            if (data.has_icc) {
                const info = data.profile_info || {};
                let typeLabel = info.preferred_cmm === 'ADBE' ? 'Adobe' : (info.preferred_cmm === 'lcms' ? 'sRGB' : 'ICC');
                iccBadge.textContent = `ICC: ${typeLabel}`;
                iccBadge.style.display = 'block';
                if (colorCorrection && data.color_transform) {
                    colorCorrection.iccData = data;
                    colorCorrection.iccTransform = data.color_transform;
                    console.log('🎨 ICC transform loaded into colorCorrection');
                } else {
                    console.warn('🎨 colorCorrection not ready or no transform data');
                }
            } else {
                iccBadge.style.display = 'none';
                console.log('🎨 No ICC profile in slide');
            }
        } else {
            console.warn('🎨 ICC profile fetch failed:', res.status);
        }
    } catch (e) {
        console.error('🎨 ICC profile check error:', e);
    }
}

/**
 * Toggle ICC profile application
 */
function toggleICC() {
    console.log('🎨 toggleICC called', { 
        currentICCProfile: currentICCProfile,
        hasIcc: currentICCProfile?.has_icc, 
        colorCorrection: !!colorCorrection,
        iccTransform: !!colorCorrection?.iccTransform
    });
    
    if (!currentICCProfile?.has_icc || !colorCorrection) {
        console.warn('🎨 toggleICC: cannot toggle - missing profile or colorCorrection');
        return;
    }
    
    const iccBadge = document.getElementById('icc-badge');
    if (iccApplied) {
        console.log('🎨 Disabling ICC');
        colorCorrection.disableICC();
        iccApplied = false;
        if (iccBadge) { iccBadge.style.background = ''; iccBadge.style.color = ''; }
    } else {
        console.log('🎨 Enabling ICC');
        if (colorCorrection.enableICC()) {
            iccApplied = true;
            console.log('🎨 ICC enabled successfully');
            if (iccBadge) { iccBadge.style.background = 'var(--accent)'; iccBadge.style.color = 'var(--bg-primary)'; }
        } else {
            console.warn('🎨 ICC enableICC() returned false');
        }
    }
    updateICCStatusPanel();
}

/**
 * Toggle ICC info or application
 */
function toggleICCInfo() {
    console.log('🎨 toggleICCInfo called', { hasIcc: currentICCProfile?.has_icc });
    if (currentICCProfile?.has_icc) toggleICC();
    else alert('No ICC profile available for this slide.');
}

/**
 * Update the ICC status panel in color settings
 */
function updateICCStatusPanel() {
    const panel = document.getElementById('icc-status-panel');
    const text = document.getElementById('icc-status-text');
    if (!panel || !text) return;
    if (currentICCProfile?.has_icc) {
        panel.style.display = 'block';
        text.innerHTML = `<strong>${currentICCProfile.profile_info?.color_space || 'RGB'}</strong> | <span style="color: ${iccApplied ? 'var(--success)' : 'var(--text-secondary)'}">${iccApplied ? 'APPLIED ✓' : 'NOT APPLIED'}</span> <button onclick="toggleICC()" class="btn-small">${iccApplied ? 'Disable' : 'Apply'}</button>`;
    } else {
        panel.style.display = 'none';
    }
}

/**
 * Navigate to next study in list
 */
function nextStudy() {
    if (!currentStudy || !studyList.length) return;
    const idx = studyList.indexOf(currentStudy);
    if (idx !== -1 && idx < studyList.length - 1) loadStudy(studyList[idx + 1]);
}

/**
 * Navigate to previous study in list
 */
function previousStudy() {
    if (!currentStudy || !studyList.length) return;
    const idx = studyList.indexOf(currentStudy);
    if (idx > 0) loadStudy(studyList[idx - 1]);
}

/**
 * Toggle fullscreen mode
 */
function toggleFullscreen() {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen();
    else document.exitFullscreen();
}
