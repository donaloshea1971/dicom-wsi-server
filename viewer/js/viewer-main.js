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
            showNavigator: true,
            navigatorPosition: 'BOTTOM_RIGHT',
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
                
                // Set up button handler for compare mode switching
                spaceNavController.onButtonPress = function(evt) {
                    if (compareMode && viewer2) {
                        // In compare mode: buttons switch active viewer
                        if (evt.pressed) {
                            if (evt.button === 'left') {
                                setActiveViewer(1);
                                console.log('🎮 SpaceMouse: Switched to LEFT viewer');
                            } else if (evt.button === 'right') {
                                setActiveViewer(2);
                                console.log('🎮 SpaceMouse: Switched to RIGHT viewer');
                            }
                        }
                    } else {
                        // Single viewer mode: buttons cycle studies
                        if (evt.pressed) {
                            if (evt.button === 'left' && typeof window.previousStudy === 'function') {
                                window.previousStudy();
                            } else if (evt.button === 'right' && typeof window.nextStudy === 'function') {
                                window.nextStudy();
                            }
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
            showNavigator: true,
            navigatorPosition: 'TOP_RIGHT',
            immediateRender: true,
            loadTilesWithAjax: true,
            ajaxHeaders: authHeaders,
            tileSources: tileSource2
        });
        
        viewer2.addHandler('open', () => {
            addViewerLabel('osd-viewer-2', compareSlideName2);
            if (syncNavigation) setupSyncNavigation();
        });
        
        document.getElementById('osd-viewer-2').addEventListener('mousedown', () => setActiveViewer(2));
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
    let syncing = false;
    const syncFrom = (source, target) => {
        if (syncing) return;
        syncing = true;
        target.viewport.panTo(source.viewport.getCenter());
        target.viewport.zoomTo(source.viewport.getZoom());
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
    const btn = document.getElementById('sync-nav-btn');
    if (btn) btn.classList.toggle('active', syncNavigation);
    if (syncNavigation && viewer && viewer2) {
        viewer2.viewport.panTo(viewer.viewport.getCenter());
        viewer2.viewport.zoomTo(viewer.viewport.getZoom());
    }
}

/**
 * Swap viewers in comparison mode
 */
function swapViewers() {
    if (!compareMode || !viewer2 || !currentStudy || !currentStudy2) return;
    
    // Store current studies and names
    const tempStudy = currentStudy;
    const tempName = compareSlideName1;
    
    // Swap the metadata
    currentStudy = currentStudy2;
    currentStudy2 = tempStudy;
    compareSlideName1 = compareSlideName2;
    compareSlideName2 = tempName;
    
    // Update labels
    addViewerLabel('osd-viewer', compareSlideName1);
    addViewerLabel('osd-viewer-2', compareSlideName2);
    
    // Reload both viewers with swapped content
    // Store viewport state if sync is enabled
    const zoom1 = viewer.viewport.getZoom();
    const center1 = viewer.viewport.getCenter();
    const zoom2 = viewer2.viewport.getZoom();
    const center2 = viewer2.viewport.getCenter();
    
    // Reload viewer 1 with what was in viewer 2
    loadStudyIntoViewer(viewer, currentStudy, () => {
        if (syncNavigation) {
            viewer.viewport.zoomTo(zoom2);
            viewer.viewport.panTo(center2);
        }
    });
    
    // Reload viewer 2 with what was in viewer 1  
    loadStudyIntoViewer(viewer2, currentStudy2, () => {
        if (syncNavigation) {
            viewer2.viewport.zoomTo(zoom1);
            viewer2.viewport.panTo(center1);
        }
    });
    
    console.log('🔄 Swapped viewers:', compareSlideName1, '↔', compareSlideName2);
}

/**
 * Load a study into a specific viewer instance
 */
async function loadStudyIntoViewer(targetViewer, studyId, onComplete) {
    if (!targetViewer || !studyId) return;
    
    let authHeaders = {};
    try {
        if (auth0Client) {
            const token = await auth0Client.getTokenSilently();
            authHeaders = { 'Authorization': `Bearer ${token}` };
        }
    } catch (e) {}
    
    // Get series for this study
    const seriesRes = await fetch(`/api/studies/${studyId}`, { headers: authHeaders });
    const seriesData = await seriesRes.json();
    const seriesId = seriesData.Series?.[0];
    
    if (!seriesId) return;
    
    // Close current and open new
    targetViewer.close();
    targetViewer.addTiledImage({
        tileSource: new OpenSeadragon.WsiTileSource({
            seriesId: seriesId,
            studyId: studyId,
            ajaxHeaders: authHeaders
        }),
        success: () => {
            if (onComplete) onComplete();
        }
    });
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
    
    if (viewer2) { viewer2.destroy(); viewer2 = null; }
    currentStudy2 = null;
    compareSlideName2 = '';
    
    const label1 = document.getElementById('osd-viewer')?.querySelector('.viewer-label');
    const label2 = document.getElementById('osd-viewer-2')?.querySelector('.viewer-label');
    if (label1) label1.remove();
    if (label2) label2.remove();
    
    if (spaceNavController) spaceNavController.setViewer(viewer);
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
    const iccBadge = document.getElementById('icc-badge');
    if (!iccBadge) return;
    currentICCProfile = null;
    iccApplied = false;
    
    try {
        const res = await authFetch(`/api/studies/${studyId}/icc-profile?include_transform=true`);
        if (res.ok) {
            const data = await res.json();
            currentICCProfile = data;
            if (data.has_icc) {
                const info = data.profile_info || {};
                let typeLabel = info.preferred_cmm === 'ADBE' ? 'Adobe' : (info.preferred_cmm === 'lcms' ? 'sRGB' : 'ICC');
                iccBadge.textContent = `ICC: ${typeLabel}`;
                iccBadge.style.display = 'block';
                if (colorCorrection && data.color_transform) {
                    colorCorrection.iccData = data;
                    colorCorrection.iccTransform = data.color_transform;
                }
            } else {
                iccBadge.style.display = 'none';
            }
        }
    } catch (e) {}
}

/**
 * Toggle ICC profile application
 */
function toggleICC() {
    if (!currentICCProfile?.has_icc || !colorCorrection) return;
    const iccBadge = document.getElementById('icc-badge');
    if (iccApplied) {
        colorCorrection.disableICC();
        iccApplied = false;
        if (iccBadge) { iccBadge.style.background = ''; iccBadge.style.color = ''; }
    } else {
        if (colorCorrection.enableICC()) {
            iccApplied = true;
            if (iccBadge) { iccBadge.style.background = 'var(--accent)'; iccBadge.style.color = 'var(--bg-primary)'; }
        }
    }
    updateICCStatusPanel();
}

/**
 * Toggle ICC info or application
 */
function toggleICCInfo() {
    if (currentICCProfile?.has_icc) toggleICC();
    else alert('No ICC profile available.');
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
