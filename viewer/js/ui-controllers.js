/**
 * PathView Pro - UI Controllers
 * Modals, dropdowns, keyboard shortcuts, and UI interactions
 */

// Current share dialog state
let currentShareStudyId = null;

/**
 * Open the uploader page
 */
function openUploader() {
    window.open('/upload', '_blank');
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
 * Close share dialog
 */
function closeShareDialog() {
    const dialog = document.getElementById('share-dialog');
    if (dialog) dialog.remove();
    currentShareStudyId = null;
}

/**
 * Format time ago string
 */
function formatTimeAgo(isoDate) {
    const date = new Date(isoDate);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    
    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    return `${diffDays}d ago`;
}

/**
 * Escape HTML for safe display
 */
function escapeHtml(text) {
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
        arrow: '➡️'
    };
    return icons[tool] || '📌';
}

/**
 * Toggle annotations panel
 */
function toggleAnnotationsPanel() {
    const panel = document.getElementById('annotations-panel');
    if (panel) {
        panel.classList.toggle('active');
    }
}

/**
 * Toggle export menu
 */
function toggleExportMenu() {
    const menu = document.getElementById('export-menu');
    if (menu) {
        menu.classList.toggle('active');
    }
}

/**
 * Set annotation tool
 */
function setAnnotationTool(tool) {
    if (!annotationManager) return;
    
    annotationManager.setTool(tool);
    
    // Update toolbar buttons
    document.querySelectorAll('.annotation-tool-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tool === tool);
    });
}

/**
 * Set annotation color
 */
function setAnnotationColor(color) {
    if (!annotationManager) return;
    annotationManager.setColor(color);
}

/**
 * Reset annotation toolbar
 */
function resetAnnotationToolbar() {
    document.querySelectorAll('.annotation-tool-btn').forEach(btn => {
        btn.classList.remove('active');
    });
}

/**
 * Trigger import annotations file dialog
 */
function triggerImportAnnotations() {
    const input = document.getElementById('import-annotations-input');
    if (input) input.click();
}

/**
 * Initialize SpaceNavigator
 */
function initSpaceNavigator() {
    if (!SpaceNavigatorController.isSupported()) {
        console.log('WebHID not supported - Space Navigator unavailable');
        return;
    }

    // Show the badge when WebHID is supported
    const badge = document.getElementById('space-nav-badge');
    if (badge) {
        badge.style.display = 'block';
    }
}

/**
 * Open SpaceMouse calibration
 */
function openSpaceMouseCalibration(event) {
    if (event) event.preventDefault();
    window.open('/spacemouse-calibration.html', '_blank');
}

/**
 * Update SpaceNav button state
 */
function updateSpaceNavButton(connected, connectionMode) {
    const badge = document.getElementById('space-nav-badge');
    if (!badge) return;
    
    if (connected) {
        badge.style.background = connectionMode === 'webhid' ? '#10b981' : '#f59e0b';
        badge.style.color = '#000';
        badge.title = `SpaceMouse connected (${connectionMode})`;
    } else {
        badge.style.background = 'var(--bg-tertiary)';
        badge.style.color = 'var(--text-muted)';
        badge.title = 'Click to connect SpaceMouse';
    }
}

/**
 * Toggle SpaceNavigator connection
 */
async function toggleSpaceNavigator() {
    if (!viewer) {
        alert('Please load a study first before connecting the SpaceMouse.');
        return;
    }

    if (spaceNavController && spaceNavController.connected) {
        await spaceNavController.disconnect();
        updateSpaceNavButton(false);
    } else {
        await connectSpaceMouse();
    }
}

/**
 * Connect SpaceMouse
 */
async function connectSpaceMouse() {
    if (!viewer) return;
    
    spaceNavController = new SpaceNavigatorController(viewer);
    spaceNavController.onStatusChange = (status) => {
        if (status === 'connected') {
            const mode = spaceNavController.getConnectionMode();
            updateSpaceNavButton(true, mode);
        } else if (status === 'disconnected') {
            updateSpaceNavButton(false);
        }
    };
    
    const connected = await spaceNavController.connect();
    if (connected) {
        const mode = spaceNavController.getConnectionMode();
        updateSpaceNavButton(true, mode);
    }
}

/**
 * Disconnect SpaceMouse
 */
async function disconnectSpaceMouse() {
    if (spaceNavController) {
        await spaceNavController.disconnect();
        updateSpaceNavButton(false);
    }
}

// Keyboard shortcuts handler
document.addEventListener('keydown', (e) => {
    // Skip if typing in input/textarea
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    
    // Help toggle with '?'
    if (e.key === '?' || (e.shiftKey && e.key === '/')) {
        toggleKeyboardHelp();
        e.preventDefault();
        return;
    }
    
    if (!viewer) return;
    const viewport = viewer.viewport;
    
    switch (e.key) {
        case '1': // Overview (fit to screen)
            viewport.fitBounds(viewport.getHomeBounds());
            e.preventDefault();
            break;
        case '2': // 2x
            viewport.zoomTo(2);
            e.preventDefault();
            break;
        case '3': // 5x
            viewport.zoomTo(5);
            e.preventDefault();
            break;
        case '4': // 10x
            viewport.zoomTo(10);
            e.preventDefault();
            break;
        case '5': // 20x
            viewport.zoomTo(20);
            e.preventDefault();
            break;
        case '6': // 40x
            viewport.zoomTo(40);
            e.preventDefault();
            break;
        case 'Home':
        case '0':
            viewport.goHome();
            e.preventDefault();
            break;
        case 'f':
        case 'F':
            toggleFullscreen();
            e.preventDefault();
            break;
        case 'g':
        case 'G':
            toggleGamma();
            e.preventDefault();
            break;
        case 'Escape':
            // Close panels/modals
            closeColorPanel();
            toggleKeyboardHelp();
            break;
    }
    
    // Arrow key navigation
    const panAmount = e.shiftKey ? 0.2 : 0.1;
    switch (e.key) {
        case 'ArrowLeft':
            viewport.panBy(new OpenSeadragon.Point(-panAmount, 0));
            e.preventDefault();
            break;
        case 'ArrowRight':
            viewport.panBy(new OpenSeadragon.Point(panAmount, 0));
            e.preventDefault();
            break;
        case 'ArrowUp':
            viewport.panBy(new OpenSeadragon.Point(0, -panAmount));
            e.preventDefault();
            break;
        case 'ArrowDown':
            viewport.panBy(new OpenSeadragon.Point(0, panAmount));
            e.preventDefault();
            break;
    }
    
    // Study navigation with [ and ]
    if (e.key === '[' || e.key === ']') {
        const currentIndex = studyList.indexOf(currentStudy);
        if (currentIndex === -1) return;
        
        const nextIndex = e.key === ']' 
            ? (currentIndex + 1) % studyList.length
            : (currentIndex - 1 + studyList.length) % studyList.length;
        
        loadStudy(studyList[nextIndex]);
        e.preventDefault();
    }
});

// Close dropdowns when clicking outside
document.addEventListener('click', (e) => {
    // Close export menu
    const exportMenu = document.getElementById('export-menu');
    const exportBtn = e.target.closest('[onclick*="toggleExportMenu"]');
    if (exportMenu && exportMenu.classList.contains('active') && !exportBtn) {
        exportMenu.classList.remove('active');
    }
});
