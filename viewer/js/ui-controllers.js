/**
 * PathView Pro - UI Controllers
 * Modals, dropdowns, keyboard shortcuts, and UI interactions
 */

/**
 * Open the uploader page
 */
function openUploader() {
    window.location.href = '/upload.html';
}

/**
 * Open the Performance Evaluation page (BYOD evidence capture)
 * Pass currentStudy when available so the page can optionally sample real WSI tile timings.
 */
function openPerformanceEvaluation() {
    try {
        const url = new URL('/performance-eval.html', window.location.origin);
        if (typeof currentStudy !== 'undefined' && currentStudy) {
            url.searchParams.set('study', currentStudy);
        }
        window.location.href = url.toString();
    } catch (e) {
        // Fallback for older browsers
        const study = (typeof currentStudy !== 'undefined' && currentStudy) ? `?study=${encodeURIComponent(currentStudy)}` : '';
        window.location.href = `/performance-eval.html${study}`;
    }
}

/**
 * Open color correction panel
 */
function openColorPanel() {
    const panel = document.getElementById('color-panel');
    if (panel) {
        panel.classList.add('active');
        updateColorUI();
        updateICCStatusPanel();
    }
}

/**
 * Close color correction panel
 */
function closeColorPanel(event) {
    if (event && event.target !== event.currentTarget) return;
    const panel = document.getElementById('color-panel');
    if (panel) panel.classList.remove('active');
}

/**
 * Toggle keyboard help overlay
 */
function toggleKeyboardHelp() {
    const help = document.getElementById('keyboard-help');
    if (help) {
        help.style.display = help.style.display === 'none' ? 'flex' : 'none';
    }
}

/**
 * Escape HTML for safe display
 */
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Get tool icon for annotation type
 */
function getToolIcon(tool) {
    const icons = {
        line: '📏',
        rectangle: '⬜',
        polygon: '🔷',
        point: '📍',
        arrow: '➡️',
        text: '📝'
    };
    return icons[tool] || '📌';
}

/**
 * Format relative time (e.g., "5m ago")
 */
function formatTimeAgo(isoDate) {
    if (!isoDate) return '';
    const date = new Date(isoDate);
    const now = new Date();
    const diff = Math.floor((now - date) / 1000);
    
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    if (diff < 604800) return Math.floor(diff / 86400) + 'd ago';
    return date.toLocaleDateString();
}

/**
 * Reset annotation toolbar to default pan mode
 */
function resetAnnotationToolbar() {
    document.querySelectorAll('.annotation-toolbar .tool-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    const panBtn = document.getElementById('tool-pan');
    if (panBtn) panBtn.classList.add('active');
    
    const panel = document.getElementById('annotations-panel');
    if (panel) panel.classList.remove('active');
    
    if (typeof currentAnnotationTool !== 'undefined') currentAnnotationTool = null;
}

/**
 * Show image metadata modal
 */
async function showMetadata() {
    if (!currentStudy) return;
    
    const modal = document.getElementById('metadata-modal');
    const content = document.getElementById('metadata-content');
    if (modal) modal.classList.add('active');
    if (content) content.innerHTML = '<div class="spinner"></div>';
    
    const cacheBust = `?_=${Date.now()}`;

    try {
        const studyRes = await authFetch(`/api/studies/${currentStudy}${cacheBust}`);
        const study = await studyRes.json();
        
        const seriesId = study.Series[0];
        const seriesRes = await authFetch(`/api/series/${seriesId}${cacheBust}`);
        let instances = [];
        try {
            const series = await seriesRes.json();
            instances = series.Instances || [];
        } catch(e) {}

        const pyramidRes = await fetch(`/wsi/pyramids/${seriesId}${cacheBust}`);
        let pyramid = null;
        try {
            pyramid = await pyramidRes.json();
        } catch(e) {}

        let instanceTags = null;
        if (instances.length > 0) {
            try {
                const tagsRes = await authFetch(`/api/instances/${instances[0]}/simplified-tags${cacheBust}`);
                instanceTags = await tagsRes.json();
            } catch(e) {}
        }

        let html = '';

        // Patient info
        html += `<div class="metadata-section">
            <h4>Patient Information</h4>
            <div class="metadata-grid">
                ${metadataItem('Patient Name', study.PatientMainDicomTags?.PatientName)}
                ${metadataItem('Patient ID', study.PatientMainDicomTags?.PatientID)}
                ${metadataItem('Birth Date', formatDate(study.PatientMainDicomTags?.PatientBirthDate))}
                ${metadataItem('Sex', study.PatientMainDicomTags?.PatientSex)}
            </div>
        </div>`;

        // Study info
        html += `<div class="metadata-section">
            <h4>Study Information</h4>
            <div class="metadata-grid">
                ${metadataItem('Study Description', study.MainDicomTags?.StudyDescription)}
                ${metadataItem('Study Date', formatDate(study.MainDicomTags?.StudyDate))}
                ${metadataItem('Accession Number', study.MainDicomTags?.AccessionNumber)}
                ${metadataItem('Study ID', study.MainDicomTags?.StudyID)}
                ${metadataItem('Referring Physician', study.MainDicomTags?.ReferringPhysicianName)}
                ${metadataItem('Study Instance UID', study.MainDicomTags?.StudyInstanceUID)}
            </div>
        </div>`;

        // Scanner/Acquisition info
        const manufacturer = instanceTags?.Manufacturer || instanceTags?.['00080070']?.Value?.[0] || '';
        const model = instanceTags?.ManufacturerModelName || instanceTags?.['00081090']?.Value?.[0] || '';
        const software = instanceTags?.SoftwareVersions || instanceTags?.['00181020']?.Value?.[0] || '';
        const stationName = instanceTags?.StationName || instanceTags?.['00081010']?.Value?.[0] || '';
        const deviceSerial = instanceTags?.DeviceSerialNumber || instanceTags?.['00181000']?.Value?.[0] || '';
        const acquisitionDate = instanceTags?.AcquisitionDateTime || instanceTags?.ContentDate || instanceTags?.['00080022']?.Value?.[0] || '';
        const sopClass = instanceTags?.SOPClassUID || instanceTags?.['00080016']?.Value?.[0] || '';
        const isWSI = sopClass.includes('1.2.840.10008.5.1.4.1.1.77.1.6');
        const institutionName = instanceTags?.InstitutionName || instanceTags?.['00080080']?.Value?.[0] || '';
        
        const isConverted = manufacturer.toLowerCase().includes('wsidicom') || 
                           software.toLowerCase().includes('dicom server converter') ||
                           institutionName.toLowerCase().startsWith('converted:');
        
        html += `<div class="metadata-section">
            <h4>Scanner / Acquisition</h4>
            <div class="metadata-grid">
                ${metadataItem('Source Type', isConverted ? 'Converted' : 'Native DICOM WSI')}
                ${metadataItem('Manufacturer', manufacturer)}
                ${metadataItem('Scanner Model', model)}
                ${metadataItem('Software Version', software)}
                ${metadataItem('Station Name', stationName)}
                ${metadataItem('Device Serial', deviceSerial)}
                ${metadataItem('Acquisition Date', formatDate(acquisitionDate))}
                ${metadataItem('SOP Class', isWSI ? 'VL Whole Slide Microscopy' : sopClass)}
            </div>
        </div>`;

        if (pyramid && pyramid.TotalWidth) {
            html += `<div class="metadata-section">
                <h4>Image Information</h4>
                <div class="metadata-grid">
                    ${metadataItem('Dimensions', `${pyramid.TotalWidth} × ${pyramid.TotalHeight} px`)}
                    ${metadataItem('Megapixels', ((pyramid.TotalWidth * pyramid.TotalHeight) / 1000000).toFixed(1) + ' MP')}
                    ${metadataItem('Pyramid Levels', pyramid.Resolutions?.length || 0)}
                    ${metadataItem('Tile Size', `${pyramid.TilesSizes?.[0]?.[0]} × ${pyramid.TilesSizes?.[0]?.[1]} px`)}
                </div>
            </div>`;
        }
        
        if (content) content.innerHTML = html;

    } catch (e) {
        if (content) content.innerHTML = `<p style="color: var(--danger);">Failed to load metadata: ${e.message}</p>`;
    }
}

/**
 * Helper to render a metadata item
 */
function metadataItem(label, value) {
    const displayValue = value || '—';
    return `<div class="metadata-item">
        <span class="metadata-label">${label}</span>
        <span class="metadata-value">${displayValue}</span>
    </div>`;
}

/**
 * Helper to format DICOM date
 */
function formatDate(dicomDate) {
    if (!dicomDate || dicomDate.length < 8) return dicomDate || '—';
    return `${dicomDate.substring(0,4)}-${dicomDate.substring(4,6)}-${dicomDate.substring(6,8)}`;
}

/**
 * Close metadata modal
 */
function closeMetadataModal(event) {
    if (event && event.target !== event.currentTarget) return;
    const modal = document.getElementById('metadata-modal');
    if (modal) modal.classList.remove('active');
}

// =========================================
// Space Navigator (3D Mouse) Support
// =========================================

/**
 * Initialize SpaceNavigator UI
 */
function initSpaceNavigator() {
    // NOTE: `typeof X === 'undefined'` is the safe check; `!typeof X === 'undefined'` is a logic bug.
    if (typeof SpaceNavigatorController === 'undefined' || !SpaceNavigatorController.isSupported()) {
        console.log('Space Navigator not supported or controller script missing');
        return;
    }
    const badge = document.getElementById('space-nav-badge');
    if (badge) badge.style.display = 'block';
}

/**
 * Toggle SpaceNavigator connection cycle
 */
async function toggleSpaceNavigator() {
    if (!viewer) {
        alert('Please load a study first.');
        return;
    }
    
    if (!spaceNavController || !spaceNavController.connected) {
        await connectSpaceMouse();
        return;
    }
    
    const currentMode = spaceNavController.getConnectionMode();
    if (currentMode === 'webhid') {
        await spaceNavController.disconnect();
        const gamepad = spaceNavController._findSpaceMouseGamepad();
        if (gamepad) {
            spaceNavController._connectViaGamepad(gamepad);
            updateSpaceNavButton(true, 'gamepad');
        } else {
            updateSpaceNavButton(false);
        }
    } else {
        await disconnectSpaceMouse();
    }
}

/**
 * Connect to SpaceMouse
 */
async function connectSpaceMouse() {
    if (typeof SpaceNavigatorController === 'undefined') return;

    // In compare mode, reconnect to the currently active viewer so right/left behaves consistently.
    const targetViewer = (typeof compareMode !== 'undefined' && compareMode && typeof activeViewer !== 'undefined' && activeViewer === 2 && typeof viewer2 !== 'undefined' && viewer2)
        ? viewer2
        : viewer;

    spaceNavController = new SpaceNavigatorController(targetViewer);
    spaceNavController.onStatusChange = (status) => {
        if (status === 'connected') updateSpaceNavButton(true, spaceNavController.getConnectionMode());
        else updateSpaceNavButton(false);
    };

    // Mirror viewer-main behavior: in compare mode, SpaceMouse buttons switch active pane.
    spaceNavController.onButtonPress = function(evt) {
        if (!evt.pressed) return;
        if (typeof compareMode !== 'undefined' && compareMode && typeof viewer2 !== 'undefined' && viewer2) {
            if (evt.button === 'left' && typeof setActiveViewer === 'function') setActiveViewer(1);
            else if (evt.button === 'right' && typeof setActiveViewer === 'function') setActiveViewer(2);
        } else {
            if (evt.button === 'left' && typeof previousStudy === 'function') previousStudy();
            else if (evt.button === 'right' && typeof nextStudy === 'function') nextStudy();
        }
    };

    await spaceNavController.connect();

    // Ensure controller points at the active viewer after connection.
    if (typeof compareMode !== 'undefined' && compareMode && typeof setActiveViewer === 'function') {
        setActiveViewer(typeof activeViewer !== 'undefined' ? activeViewer : 1);
    }
}

/**
 * Disconnect SpaceMouse
 */
async function disconnectSpaceMouse() {
    if (spaceNavController) {
        await spaceNavController.disconnect();
        spaceNavController = null;
        updateSpaceNavButton(false);
    }
}

/**
 * Update SpaceMouse badge UI
 */
function updateSpaceNavButton(connected, connectionMode) {
    const badge = document.getElementById('space-nav-badge');
    if (!badge) return;
    
    if (connected) {
        badge.classList.add('connected');
        let bgColor = 'var(--accent)';
        if (connectionMode === '3dxware') bgColor = '#8b5cf6';
        else if (connectionMode === 'gamepad') bgColor = '#f59e0b';
        
        badge.style.background = bgColor;
        badge.style.color = '#000';
        badge.title = `SpaceMouse (${connectionMode}) - click to cycle`;
    } else {
        badge.classList.remove('connected');
        badge.style.background = 'var(--bg-tertiary)';
        badge.style.color = 'var(--text-muted)';
        badge.title = 'Click to connect SpaceMouse';
    }
}

/**
 * Open SpaceMouse context menu
 */
function openSpaceMouseMenu(event) {
    event.preventDefault();
    const existingMenu = document.getElementById('spacemouse-context-menu');
    if (existingMenu) existingMenu.remove();
    
    const connected = spaceNavController && spaceNavController.connected;
    const menu = document.createElement('div');
    menu.id = 'spacemouse-context-menu';
    menu.style.cssText = `position:fixed; left:${event.clientX}px; top:${event.clientY}px; background:rgba(15,23,42,0.98); border:1px solid #334155; border-radius:8px; padding:8px 0; min-width:200px; z-index:10000; box-shadow:0 10px 40px rgba(0,0,0,0.5); font-size:13px;`;
    
    const items = connected ? [
        { label: '🎯 Toggle Crosshair', action: () => spaceNavController.toggleCrosshair() },
        { label: '⚙️ Config Panel', action: () => spaceNavController.createConfigPanel() },
        { label: '🔌 Reselect Device', action: reselectSpaceMouse },
        { divider: true },
        { label: '❌ Disconnect', action: disconnectSpaceMouse, style: 'color:#ef4444' }
    ] : [
        { label: '🔌 Connect SpaceMouse', action: connectSpaceMouse }
    ];
    
    items.push({ divider: true }, { label: '🎓 Calibration', action: () => window.open('/spacemouse-calibration.html') });

    items.forEach(item => {
        if (item.divider) {
            const d = document.createElement('div');
            d.style.cssText = 'height:1px; background:#334155; margin:6px 0;';
            menu.appendChild(d);
        } else {
            const div = document.createElement('div');
            div.textContent = item.label;
            div.style.cssText = `padding:8px 16px; cursor:pointer; color:#e2e8f0; ${item.style || ''}`;
            div.onclick = () => { menu.remove(); item.action(); };
            div.onmouseenter = () => div.style.background = '#1e293b';
            div.onmouseleave = () => div.style.background = '';
            menu.appendChild(div);
        }
    });
    
    document.body.appendChild(menu);
    const close = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', close); } };
    setTimeout(() => document.addEventListener('click', close), 0);
}

async function reselectSpaceMouse() {
    await disconnectSpaceMouse();
    await connectSpaceMouse();
}

async function toggleSpaceMouseMode() {
    if (spaceNavController && spaceNavController.connected) {
        const mode = spaceNavController.getConnectionMode();
        await spaceNavController.disconnect();
        if (mode === 'webhid') {
            const gp = spaceNavController._findSpaceMouseGamepad();
            if (gp) spaceNavController._connectViaGamepad(gp);
            else await spaceNavController.connect();
        } else {
            await spaceNavController.connect();
        }
    }
}

// =========================================
// Global Event Listeners
// =========================================

// Close dropdowns on outside click
document.addEventListener('click', (e) => {
    // User menu dropdown
    const userMenu = document.getElementById('user-menu');
    const userDropdown = document.getElementById('user-dropdown');
    if (userMenu && userDropdown && !userMenu.contains(e.target)) {
        userDropdown.classList.remove('active');
    }
    
    // Export menu
    const exportMenu = document.getElementById('export-menu');
    if (exportMenu && exportMenu.style.display === 'block' && !e.target.closest('.export-dropdown')) {
        exportMenu.style.display = 'none';
    }
});

// Keyboard shortcuts for navigation and tools
document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    
    const key = e.key.toLowerCase();
    
    // Global shortcuts
    if (key === '?' || (e.shiftKey && key === '/')) {
        toggleKeyboardHelp();
        e.preventDefault();
        return;
    }
    
    if (key === 'escape') {
        if (compareMode) exitCompareMode();
        if (typeof closeMetadataModal === 'function') closeMetadataModal();
        if (typeof closeColorPanel === 'function') closeColorPanel();
        if (typeof closeSlideEditDialog === 'function') closeSlideEditDialog();
        if (typeof closeAnnotationEdit === 'function') closeAnnotationEdit();
        if (typeof hideCommentsPanel === 'function') hideCommentsPanel();
        return;
    }

    // Viewer-specific navigation
    const activeV = compareMode && activeViewer === 2 && viewer2 ? viewer2 : viewer;
    if (activeV) {
        const vp = activeV.viewport;
        const center = vp.getCenter();
        const panStep = 0.1;

        switch (key) {
            case 'w': case 'arrowup': vp.panTo(new OpenSeadragon.Point(center.x, center.y - panStep)); break;
            case 's': case 'arrowdown': vp.panTo(new OpenSeadragon.Point(center.x, center.y + panStep)); break;
            case 'a': case 'arrowleft': if (!e.ctrlKey && !e.metaKey) vp.panTo(new OpenSeadragon.Point(center.x - panStep, center.y)); break;
            case 'd': case 'arrowright': vp.panTo(new OpenSeadragon.Point(center.x + panStep, center.y)); break;
            case '1': vp.goHome(); break;
            case '2': vp.zoomTo(2); break;
            case '3': vp.zoomTo(5); break;
            case '4': vp.zoomTo(10); break;
            case '5': vp.zoomTo(20); break;
            case '6': vp.zoomTo(40); break;
            case '+': case '=': vp.zoomBy(1.5); break;
            case '-': case '_': vp.zoomBy(0.67); break;
            case 'f': toggleFullscreen(); break;
            case '[': if (typeof previousStudy === 'function') previousStudy(); break;
            case ']': if (typeof nextStudy === 'function') nextStudy(); break;
        }
    }
    
    // Annotation tool shortcuts
    if (typeof annotationManager !== 'undefined' && annotationManager) {
        switch (key) {
            case 'p': setAnnotationTool(null); break;
            case 'l': setAnnotationTool('line'); break;
            case 'r': setAnnotationTool('rectangle'); break;
            case 'g': setAnnotationTool('polygon'); break;
            case 'e': setAnnotationTool('ellipse'); break;
            case 'm': setAnnotationTool('point'); break;
            case 't': setAnnotationTool('text'); break;
        }
        if (e.shiftKey && key === 'a') setAnnotationTool('arrow');
    }
});
