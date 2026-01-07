/**
 * PathView Pro - Annotation UI Controller
 * Handles annotation list, comments, exports, and real-time syncing
 */

// Global state for annotations
var currentAnnotationTool = null;
var currentCommentsAnnotationId = null;

/**
 * Initialize annotation manager
 */
function initAnnotations() {
    if (!viewer || !window.AnnotationManager) {
        console.warn('Cannot initialize annotations: viewer or AnnotationManager not ready');
        return false;
    }
    
    // Destroy existing manager if switching images
    if (annotationManager) {
        annotationManager.destroy();
        annotationManager = null;
    }
    
    annotationManager = new AnnotationManager(viewer, { authFetch });
    annotationManager.init();
    console.log('Annotation system initialized');
    return true;
}

/**
 * Set current annotation tool
 */
function setAnnotationTool(tool) {
    if (!annotationManager || !annotationManager.isReady()) {
        console.warn('Annotation manager not ready');
        return;
    }
    
    currentAnnotationTool = tool;
    annotationManager.setTool(tool);
    
    // Update toolbar button states
    document.querySelectorAll('.annotation-toolbar .tool-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    
    const activeBtn = document.getElementById(tool ? `tool-${tool}` : 'tool-pan');
    if (activeBtn) {
        activeBtn.classList.add('active');
    }
    
    console.log('Tool set to:', tool || 'pan');
}

/**
 * Toggle annotations list panel
 */
function toggleAnnotationsPanel() {
    const panel = document.getElementById('annotations-panel');
    const listBtn = document.getElementById('tool-list');

    panel.classList.toggle('active');
    if (listBtn) listBtn.classList.toggle('active');

    if (panel.classList.contains('active')) {
        updateAnnotationsList();
    }
}

/**
 * Toggle annotation export menu
 */
function toggleExportMenu() {
    const menu = document.getElementById('export-menu');
    if (menu) {
        menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
    }
}

/**
 * Export annotations in JSON or GeoJSON format
 */
async function exportAnnotations(format = 'json') {
    if (!currentStudy) {
        alert('No study loaded');
        return;
    }
    
    try {
        console.log('Exporting annotations for:', currentStudy, 'format:', format);
        const response = await authFetch(`/api/studies/${currentStudy}/annotations/export?format=${format}`);
        if (!response.ok) {
            const errorText = await response.text().catch(() => 'Unknown error');
            console.error('Export failed:', response.status, errorText);
            throw new Error(`Export failed: ${response.status} - ${errorText}`);
        }
        
        const data = await response.json();
        
        // Create downloadable file
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = `annotations_${currentStudy.slice(0, 8)}_${new Date().toISOString().slice(0, 10)}.${format === 'geojson' ? 'geojson' : 'json'}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        console.log(`Exported ${data.count || data.features?.length || 0} annotations as ${format}`);
    } catch (e) {
        console.error('Export error:', e);
        alert('Failed to export annotations: ' + e.message);
    }
}

/**
 * Set base color for new annotations
 */
function setAnnotationColor(color) {
    if (annotationManager) {
        annotationManager.setColor(color);
        console.log('Annotation color set to:', color);
    }
}

/**
 * Trigger file input for annotation import
 */
function triggerImportAnnotations() {
    const input = document.getElementById('import-annotations-file');
    if (input) input.click();
}

/**
 * Handle annotation file import
 */
async function importAnnotationsFile(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    if (!currentStudy) {
        alert('Please load a slide first');
        return;
    }
    
    try {
        const text = await file.text();
        const data = JSON.parse(text);
        
        let annotations = [];
        if (data.type === 'FeatureCollection' && data.features) {
            annotations = data.features.map(feature => ({
                type: feature.properties?.annotation_type || feature.geometry?.type || 'unknown',
                tool: feature.properties?.tool || feature.geometry?.type?.toLowerCase() || 'unknown',
                geometry: feature.geometry,
                properties: feature.properties || {}
            }));
        } else if (data.annotations) {
            annotations = data.annotations;
        } else if (Array.isArray(data)) {
            annotations = data;
        }
        
        if (annotations.length === 0) {
            alert('No annotations found in file');
            return;
        }
        
        let imported = 0;
        for (const ann of annotations) {
            try {
                const response = await authFetch(`/api/studies/${currentStudy}/annotations`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        type: ann.type || 'region',
                        tool: ann.tool || 'rectangle',
                        geometry: ann.geometry,
                        properties: ann.properties || {}
                    })
                });
                if (response.ok) imported++;
            } catch (e) {
                console.warn('Failed to import annotation:', e);
            }
        }
        
        if (annotationManager) {
            await annotationManager.loadAnnotations(currentStudy);
        }
        updateAnnotationsList();
        
        alert(`Imported ${imported} of ${annotations.length} annotations`);
        console.log(`Imported ${imported} annotations from ${file.name}`);
        
    } catch (e) {
        console.error('Import error:', e);
        alert('Failed to import annotations: ' + e.message);
    }
    
    event.target.value = '';
}

/**
 * Update the UI list of annotations
 */
function updateAnnotationsList() {
    const list = document.getElementById('annotations-list');
    
    if (!annotationManager) {
        list.innerHTML = `
            <div style="text-align: center; color: var(--text-secondary); padding: 20px; font-size: 12px;">
                No annotations yet.<br>Use the tools on the left to add measurements.
            </div>
        `;
        return;
    }
    
    const annotations = annotationManager.getAnnotationList();
    
    if (annotations.length === 0) {
        list.innerHTML = `
            <div style="text-align: center; color: var(--text-secondary); padding: 20px; font-size: 12px;">
                No annotations yet.<br>Use the tools on the left to add measurements.
            </div>
        `;
        return;
    }
    
    list.innerHTML = annotations.map(a => `
        <div class="annotation-item" data-id="${a.id}">
            <div class="annotation-item-header">
                <span class="annotation-item-type">${getToolIcon(a.tool)} ${a.label || a.tool}</span>
                <div style="display: flex; gap: 4px;">
                    <button class="annotation-item-comment" data-comment="${a.id}" title="Comments" style="background: none; border: none; color: var(--text-secondary); cursor: pointer; padding: 2px; font-size: 12px;">💬</button>
                    <button class="annotation-item-delete" data-delete="${a.id}" title="Delete">×</button>
                </div>
            </div>
            ${a.measurement ? `<div class="annotation-item-measurement">${a.measurement}</div>` : ''}
            ${a.description ? `<div style="color: var(--text-secondary); font-size: 11px; margin-top: 4px; font-style: italic;">${a.description}</div>` : ''}
        </div>
    `).join('');
    
    // Attach event listeners
    list.querySelectorAll('.annotation-item').forEach(item => {
        const id = item.dataset.id;

        item.addEventListener('click', (e) => {
            if (e.target.closest('.annotation-item-delete') || e.target.closest('.annotation-item-comment')) return;
            selectAnnotation(id);
        });
        
        const commentBtn = item.querySelector('.annotation-item-comment');
        if (commentBtn) {
            commentBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                showCommentsPanel(id);
            });
        }
        
        item.addEventListener('mouseenter', () => {
            if (annotationManager) {
                annotationManager.highlightAnnotation(id, true);
            }
            item.style.borderColor = 'var(--accent)';
        });
        
        item.addEventListener('mouseleave', () => {
            if (annotationManager) {
                annotationManager.highlightAnnotation(id, false);
            }
            item.style.borderColor = '';
        });
    });
    
    list.querySelectorAll('.annotation-item-delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const id = btn.dataset.delete;
            deleteAnnotation(id);
        });
    });
}

/**
 * Delete an annotation
 */
async function deleteAnnotation(annotationId) {
    if (!annotationManager) return;
    
    await annotationManager.deleteAnnotation(annotationId);
    updateAnnotationsList();
}

/**
 * Navigate viewer to annotation
 */
function goToAnnotation(annotationId) {
    if (!annotationManager) return;
    annotationManager.goToAnnotation(annotationId);
}

/**
 * Select annotation and open edit dialog
 */
function selectAnnotation(annotationId) {
    goToAnnotation(annotationId);
    setTimeout(() => {
        editAnnotation(annotationId);
    }, 300);
}

/**
 * Open annotation edit modal
 */
function editAnnotation(annotationId) {
    if (!annotationManager) return;
    
    const annotation = annotationManager.annotations.find(a => a.id === annotationId);
    if (!annotation) return;
    
    const editId = document.getElementById('edit-annotation-id');
    const editLabel = document.getElementById('edit-annotation-label');
    const editDesc = document.getElementById('edit-annotation-desc');
    const modal = document.getElementById('annotation-edit-modal');
    
    if (editId) editId.value = annotationId;
    if (editLabel) editLabel.value = annotation.properties?.label || '';
    if (editDesc) editDesc.value = annotation.properties?.description || '';
    
    if (modal) {
        modal.classList.add('active');
        if (editLabel) editLabel.focus();
    }
}

/**
 * Close annotation edit modal
 */
function closeAnnotationEdit(event) {
    if (event && event.target !== event.currentTarget) return;
    const modal = document.getElementById('annotation-edit-modal');
    if (modal) modal.classList.remove('active');
}

/**
 * Save annotation edits to server
 */
async function saveAnnotationEdit() {
    const annotationId = document.getElementById('edit-annotation-id').value;
    const label = document.getElementById('edit-annotation-label').value.trim();
    const description = document.getElementById('edit-annotation-desc').value.trim();
    
    if (!annotationManager || !annotationId) return;
    
    const annotation = annotationManager.annotations.find(a => a.id === annotationId);
    if (annotation) {
        if (!annotation.properties) annotation.properties = {};
        annotation.properties.label = label || annotation.properties.label;
        annotation.properties.description = description;
        
        try {
            await authFetch(`/api/studies/${currentStudy}/annotations/${annotationId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    properties: annotation.properties
                })
            });
        } catch (e) {
            console.warn('Could not save to server:', e);
        }
        
        annotationManager.render();
        updateAnnotationsList();
    }
    
    closeAnnotationEdit();
}

/**
 * Clear all annotations for current study
 */
async function clearAnnotations() {
    if (!annotationManager || !currentStudy) return;
    
    if (!confirm('Are you sure you want to delete all annotations for this slide?')) return;
    
    try {
        await authFetch(`/api/studies/${currentStudy}/annotations`, { method: 'DELETE' });
        annotationManager.clearAll();
        updateAnnotationsList();
    } catch (e) {
        console.error('Failed to clear annotations:', e);
    }
}

/**
 * Load all annotations for a study
 */
async function loadStudyAnnotations(studyId) {
    console.log('Loading annotations for study:', studyId);
    
    if (!initAnnotations()) {
        console.error('Failed to initialize annotations');
        return;
    }
    
    await new Promise(resolve => setTimeout(resolve, 100));
    
    if (!annotationManager || !annotationManager.isReady()) {
        console.error('Annotation manager not ready after init');
        return;
    }
    
    try {
        await annotationManager.loadCalibration(studyId);
        
        const calibrationValue = document.getElementById('calibration-value');
        if (calibrationValue) {
            const spacing = annotationManager.pixelSpacing[0];
            const source = annotationManager.calibrationSource;
            calibrationValue.innerHTML = `${spacing.toFixed(3)} µm/px <span style="opacity: 0.6">(${source})</span>`;
        }
        
        await annotationManager.loadAnnotations(studyId);
        updateAnnotationsList();
        
        console.log('Annotations loaded successfully');
        
    } catch (e) {
        console.error('Failed to load study annotations:', e);
        const calibrationValue = document.getElementById('calibration-value');
        if (calibrationValue) {
            calibrationValue.innerHTML = '<span style="color: #ff6b6b">Auth required</span>';
        }
    }
}

/**
 * Show comments panel for an annotation
 */
function showCommentsPanel(annotationId) {
    currentCommentsAnnotationId = annotationId;
    
    let panel = document.getElementById('comments-panel');
    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'comments-panel';
        panel.className = 'comments-panel';
        panel.innerHTML = `
            <div class="comments-header">
                <h4>💬 Comments</h4>
                <button class="comments-close" onclick="hideCommentsPanel()">×</button>
            </div>
            <div class="comments-list" id="comments-list">
                Loading...
            </div>
            <div class="comments-input">
                <textarea id="comment-input" placeholder="Add a comment..." rows="2"></textarea>
                <button onclick="addComment()">Post Comment</button>
            </div>
        `;
        document.body.appendChild(panel);
    }
    
    panel.classList.add('visible');
    loadComments(annotationId);
}

/**
 * Hide comments panel
 */
function hideCommentsPanel() {
    const panel = document.getElementById('comments-panel');
    if (panel) panel.classList.remove('visible');
    currentCommentsAnnotationId = null;
}

/**
 * Load comments for an annotation from server
 */
async function loadComments(annotationId) {
    const container = document.getElementById('comments-list');
    if (!container) return;
    
    try {
        const response = await authFetch(`/api/annotations/${annotationId}/comments`);
        if (!response.ok) throw new Error('Failed to load comments');
        
        const data = await response.json();
        const comments = data.comments || [];
        
        if (comments.length === 0) {
            container.innerHTML = `<div style="color: var(--text-muted); text-align: center; padding: 20px;">
                No comments yet. Be the first!
            </div>`;
            return;
        }
        
        container.innerHTML = comments.map(comment => `
            <div class="comment-item" data-id="${comment.id}">
                <div class="comment-header">
                    <span class="comment-author">${comment.user_name}</span>
                    <span class="comment-time">${formatTimeAgo(comment.created_at)}</span>
                </div>
                <div class="comment-content">${escapeHtml(comment.content)}</div>
                <div class="comment-actions">
                    <button onclick="replyToComment(${comment.id})">Reply</button>
                    ${comment.is_resolved ? '<span style="color: #10b981;">✓ Resolved</span>' : 
                      `<button onclick="resolveComment(${comment.id})">Mark Resolved</button>`}
                </div>
            </div>
        `).join('');
        
    } catch (e) {
        container.innerHTML = `<div style="color: var(--danger);">${e.message}</div>`;
    }
}

/**
 * Post a new comment
 */
async function addComment() {
    if (!currentCommentsAnnotationId) return;
    
    const input = document.getElementById('comment-input');
    const content = input.value.trim();
    if (!content) return;
    
    try {
        const response = await authFetch(`/api/annotations/${currentCommentsAnnotationId}/comments`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content })
        });
        
        if (!response.ok) throw new Error('Failed to post comment');
        
        input.value = '';
        loadComments(currentCommentsAnnotationId);
        
    } catch (e) {
        alert('Failed to post comment: ' + e.message);
    }
}

/**
 * Mark a comment as resolved
 */
async function resolveComment(commentId) {
    try {
        const response = await authFetch(`/api/comments/${commentId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_resolved: true })
        });
        
        if (!response.ok) throw new Error('Failed to resolve');
        loadComments(currentCommentsAnnotationId);
        
    } catch (e) {
        alert('Failed to resolve: ' + e.message);
    }
}

/**
 * Connect to real-time annotation sync (SSE)
 */
function connectAnnotationSync(studyId) {
    if (annotationEventSource) {
        annotationEventSource.close();
    }
    
    let indicator = document.getElementById('sync-indicator');
    if (!indicator) {
        indicator = document.createElement('div');
        indicator.id = 'sync-indicator';
        indicator.className = 'sync-indicator';
        indicator.innerHTML = '<div class="dot"></div><span>Live sync</span>';
        document.body.appendChild(indicator);
    }
    
    try {
        annotationEventSource = new EventSource(`/api/studies/${studyId}/events`);
        
        annotationEventSource.onopen = () => {
            console.log('SSE connected for annotations');
            indicator.classList.remove('disconnected');
            indicator.querySelector('span').textContent = 'Live sync';
        };
        
        annotationEventSource.addEventListener('annotation', (event) => {
            try {
                const data = JSON.parse(event.data);
                if (annotationManager) {
                    annotationManager.loadAnnotations();
                    updateAnnotationsList();
                }
            } catch (e) {
                console.error('Failed to parse annotation event:', e);
            }
        });
        
        annotationEventSource.onerror = (e) => {
            console.warn('SSE connection error, will retry...', e);
            indicator.classList.add('disconnected');
            indicator.querySelector('span').textContent = 'Reconnecting...';
        };
        
    } catch (e) {
        console.error('Failed to connect SSE:', e);
    }
}

/**
 * Disconnect real-time annotation sync
 */
function disconnectAnnotationSync() {
    if (annotationEventSource) {
        annotationEventSource.close();
        annotationEventSource = null;
    }
    
    const indicator = document.getElementById('sync-indicator');
    if (indicator) indicator.remove();
}
