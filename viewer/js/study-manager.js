/**
 * PathView Pro - Study Manager
 * Handles study loading, filtering, rendering, and list management
 */

// Global state for studies
var studyList = [];  // Store list of study IDs for navigation
var allStudiesCache = { owned: [], shared: [], samples: [] };
var currentViewMode = 'flat'; // 'flat' or 'grouped'
var currentEditSlideId = null;
var currentShareStudyId = null;
var shareSearchTimeout = null;

/**
 * Check if sample slides are hidden
 */
function isSamplesHidden() {
    return localStorage.getItem('hideSamples') === 'true';
}

/**
 * Hide sample slides
 */
function hideSamples() {
    localStorage.setItem('hideSamples', 'true');
    refreshStudies();
}

/**
 * Show sample slides
 */
function showSamples() {
    localStorage.removeItem('hideSamples');
    refreshStudies();
}

/**
 * Refresh and load all studies from the server
 */
async function refreshStudies() {
    const list = document.getElementById('study-list');
    list.innerHTML = '<div class="empty-state"><div class="spinner" style="margin: 0 auto 16px;"></div><p>Loading studies...</p></div>';

    try {
        const hideSamples = isSamplesHidden();
        
        // Try new categorized endpoint first (provides owned/shared/samples separately)
        let categorized = null;
        try {
            const catResponse = await authFetch(`/api/studies/categorized?include_samples=${!hideSamples}`);
            if (catResponse.ok) {
                categorized = await catResponse.json();
            }
        } catch (e) {
            console.log('Categorized endpoint not available, falling back');
        }
        
        if (categorized) {
            // Use categorized data
            const ownedIds = categorized.owned || [];
            const sharedIds = categorized.shared_with_me || [];
            const sampleIds = categorized.samples || [];
            
            // Fetch details for all studies
            const allIds = [...ownedIds, ...sharedIds, ...sampleIds];
            
            if (allIds.length > 0) {
                const studies = await Promise.all(
                    allIds.map(id => authFetch(`/api/studies/${id}`).then(r => r.json()))
                );
                
                const studyMap = {};
                studies.forEach(s => studyMap[s.ID] = s);
                
                // Get share counts from categorized response
                const shareCounts = categorized.share_counts || {};
                
                // Fetch metadata individually for each owned/shared study
                const allRelevantIds = [...ownedIds, ...sharedIds];
                const slideMetadata = {};
                
                // Fetch metadata in parallel
                const metadataPromises = allRelevantIds.map(async (id) => {
                    try {
                        const res = await authFetch(`/api/slides/${id}`);
                        if (res.ok) {
                            const data = await res.json();
                            slideMetadata[id] = data;
                        }
                    } catch (e) {
                        // Slide might not have metadata yet
                    }
                });
                await Promise.all(metadataPromises);
                console.log('Slide metadata from API:', slideMetadata);
                
                // Attach shareCount and slide metadata to studies
                const ownedStudies = ownedIds.map(id => {
                    const study = studyMap[id];
                    if (study) {
                        study.shareCount = shareCounts[id] || 0;
                        // Merge slide metadata if available
                        const meta = slideMetadata[id];
                        if (meta) {
                            study.display_name = meta.display_name;
                            study.stain = meta.stain;
                            study.patient_id = meta.patient_id;
                            study.case_id = meta.case_id;
                            study.block_id = meta.block_id;
                            study.patient_name = meta.patient_name;
                            study.patient_dob = meta.patient_dob;
                            study.case_accession = meta.case_accession;
                            study.block_name = meta.block_name;
                        }
                    }
                    return study;
                }).filter(Boolean);
                
                const sharedStudies = sharedIds.map(id => {
                    const study = studyMap[id];
                    if (study) {
                        const meta = slideMetadata[id];
                        if (meta) {
                            study.display_name = meta.display_name;
                            study.stain = meta.stain;
                            study.patient_id = meta.patient_id;
                            study.case_id = meta.case_id;
                            study.patient_name = meta.patient_name;
                            study.patient_dob = meta.patient_dob;
                            study.case_accession = meta.case_accession;
                            study.block_name = meta.block_name;
                        }
                    }
                    return study;
                }).filter(Boolean);
                
                const sampleStudies = sampleIds.map(id => studyMap[id]).filter(Boolean);
                
                // Store study list for navigation
                studyList = [...ownedIds, ...sharedIds, ...sampleIds];
                
                // Cache for view mode switching
                allStudiesCache = {
                    owned: ownedStudies,
                    shared: sharedStudies,
                    samples: sampleStudies
                };
                
                // Render based on current view mode
                let html = '';
                if (currentViewMode === 'grouped') {
                    html = renderGroupedView(ownedStudies, sharedStudies, sampleStudies, hideSamples);
                } else {
                    html = renderFlatView(ownedStudies, sharedStudies, sampleStudies, hideSamples);
                }
                
                list.innerHTML = html;
            } else {
                list.innerHTML = renderEmptyState(hideSamples);
            }
        } else {
            // Fallback to old endpoint
            const response = await authFetch(`/api/studies?include_samples=${!hideSamples}`);
            const studyIds = await response.json();
            const ids = Array.isArray(studyIds) ? studyIds : (studyIds.value || []);
            
            // Get ownership info
            let ownership = {};
            try {
                const ownershipRes = await authFetch('/api/studies/ownership');
                if (ownershipRes.ok) {
                    ownership = await ownershipRes.json();
                }
            } catch (e) {
                console.log('Could not fetch ownership info');
            }
            
            if (ids && ids.length > 0) {
                const studies = await Promise.all(
                    ids.map(id => authFetch(`/api/studies/${id}`).then(r => r.json()))
                );
                
                const ownedStudies = studies.filter(s => ownership[s.ID] === 'owned');
                const sampleStudies = studies.filter(s => ownership[s.ID] === 'sample');
                
                studyList = [...ownedStudies.map(s => s.ID), ...sampleStudies.map(s => s.ID)];
                
                // Cache for view mode switching
                allStudiesCache = {
                    owned: ownedStudies,
                    shared: [],
                    samples: sampleStudies
                };
                
                // Render based on current view mode
                let html = '';
                if (currentViewMode === 'grouped') {
                    html = renderGroupedView(ownedStudies, [], sampleStudies, hideSamples);
                } else {
                    html = renderFlatView(ownedStudies, [], sampleStudies, hideSamples);
                }
                
                list.innerHTML = html;
            } else {
                list.innerHTML = renderEmptyState(hideSamples);
            }
        }
    } catch (e) {
        list.innerHTML = `
            <div class="empty-state">
                <p style="color: var(--danger);">Failed to load studies</p>
                <p style="margin-top: 8px; font-size: 12px;">${e.message}</p>
            </div>
        `;
    }
}

/**
 * Render a single study card
 */
function renderStudyCard(study, ownershipType) {
    // UID - shortened for display
    const uid = study.ID?.substring(0, 8) + '...' || 'Unknown';
    
    // Slide name and stain
    const slideName = study.display_name || 'Unnamed';
    const stain = study.stain || '';
    const slideInfo = stain ? `${slideName} ${stain}` : slideName;
    
    // Bottom row: Case ID | Patient Name | DOB
    const caseId = study.case_accession || '';
    const patientName = study.patient_name || '';
    const patientDob = study.patient_dob ? study.patient_dob.substring(0, 10) : '';
    
    // Build bottom info parts
    let bottomParts = [];
    if (caseId) bottomParts.push(caseId);
    if (patientName) bottomParts.push(patientName);
    if (patientDob) bottomParts.push(patientDob);
    const bottomInfo = bottomParts.join(' | ') || 'No patient info';
                
    let badge = '';
    if (ownershipType === 'sample') {
        badge = '<span class="sample-badge">SAMPLE</span>';
    } else if (ownershipType === 'shared') {
        badge = '<span class="shared-badge">SHARED</span>';
    }
    
    // Share button only for owned slides
    const isShared = study.shareCount > 0;
    const shareBtn = ownershipType === 'owned' 
        ? `<button class="share-btn ${isShared ? 'shared' : ''}" onclick="event.stopPropagation(); openShareDialog('${study.ID}')" title="${isShared ? 'Shared with ' + study.shareCount + ' user(s)' : 'Share this slide'}">
               <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                   <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
                   <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
               </svg>
           </button>`
        : '';
    
    // Edit button only for owned slides
    const editBtn = ownershipType === 'owned'
        ? `<button class="edit-btn" onclick="event.stopPropagation(); openSlideEditDialog('${study.ID}', '${slideName.replace(/'/g, "\\'")}', '${stain || ''}')" title="Edit slide - assign to Case/Patient">
               ✏️ Edit
           </button>`
        : '';
    
    // Compare button - available for all slides
    const compareBtn = `<button class="compare-btn" onclick="event.stopPropagation(); addToCompare('${study.ID}', '${slideName.replace(/'/g, "\\'")}')" title="Compare with another slide" data-compare-id="${study.ID}">
        ⧉
    </button>`;
                
    return `
        <div class="study-card ${ownershipType === 'sample' ? 'sample-study' : ''} ${ownershipType === 'shared' ? 'shared-study' : ''}" onclick="loadStudy('${study.ID}')" data-id="${study.ID}">
            <div class="study-header">
                <div class="study-uid">${uid} ${badge}</div>
                <div class="card-actions">
                    ${compareBtn}
                    ${editBtn}
                    ${shareBtn}
                </div>
            </div>
            <div class="study-slide-info">${slideInfo}</div>
            <div class="study-meta">${bottomInfo}</div>
        </div>
    `;
}

/**
 * Render empty state when no studies found
 */
function renderEmptyState(samplesHidden) {
    return `
        <div class="empty-state">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <rect x="3" y="3" width="18" height="18" rx="2"/>
                <line x1="3" y1="9" x2="21" y2="9"/>
                <line x1="9" y1="21" x2="9" y2="9"/>
            </svg>
            <p>No slides found</p>
            <p style="margin-top: 8px; font-size: 12px;">Upload a WSI file to get started</p>
            ${samplesHidden ? `
                <button class="btn" style="margin-top: 12px;" onclick="showSamples()">
                    Show Sample Slides
                </button>
            ` : ''}
        </div>
    `;
}

/**
 * Filter studies by search query
 */
function filterStudies(query) {
    const studyListEl = document.getElementById('study-list');
    const cards = studyListEl.querySelectorAll('.study-card');
    const groups = studyListEl.querySelectorAll('.case-group');
    const q = query.toLowerCase().trim();
    
    if (!q) {
        // Show all
        cards.forEach(card => card.style.display = '');
        groups.forEach(g => g.style.display = '');
        return;
    }
    
    // Filter cards
    cards.forEach(card => {
        const text = card.textContent.toLowerCase();
        const matches = text.includes(q);
        card.style.display = matches ? '' : 'none';
    });
    
    // In grouped view, hide empty groups
    groups.forEach(group => {
        const visibleCards = group.querySelectorAll('.study-card:not([style*="display: none"])');
        group.style.display = visibleCards.length > 0 ? '' : 'none';
    });
}

/**
 * Set the view mode (flat or grouped)
 */
function setViewMode(mode) {
    currentViewMode = mode;
    
    // Update buttons
    const flatBtn = document.getElementById('view-flat');
    const groupedBtn = document.getElementById('view-grouped');
    if (flatBtn) flatBtn.classList.toggle('active', mode === 'flat');
    if (groupedBtn) groupedBtn.classList.toggle('active', mode === 'grouped');
    
    // Re-render the study list
    rerenderStudyList();
}

/**
 * Re-render the study list with cached data
 */
function rerenderStudyList() {
    const list = document.getElementById('study-list');
    const hideSamples = isSamplesHidden();
    
    if (currentViewMode === 'grouped') {
        list.innerHTML = renderGroupedView(allStudiesCache.owned, allStudiesCache.shared, allStudiesCache.samples, hideSamples);
    } else {
        list.innerHTML = renderFlatView(allStudiesCache.owned, allStudiesCache.shared, allStudiesCache.samples, hideSamples);
    }
}

/**
 * Render flat view of studies
 */
function renderFlatView(ownedStudies, sharedStudies, sampleStudies, hideSamples) {
    let html = '';
    
    if (ownedStudies.length > 0) {
        html += `<div class="study-section-header">🔬 Your Slides (${ownedStudies.length})</div>`;
        html += ownedStudies.map(study => renderStudyCard(study, 'owned')).join('');
    }
    
    if (sharedStudies.length > 0) {
        html += `<div class="study-section-header" style="margin-top: 16px;">🔗 Shared with You (${sharedStudies.length})</div>`;
        html += sharedStudies.map(study => renderStudyCard(study, 'shared')).join('');
    }
    
    if (sampleStudies.length > 0 && !hideSamples) {
        html += `
            <div class="study-section-header" style="margin-top: 16px; display: flex; justify-content: space-between; align-items: center;">
                <span>📚 Sample Slides (${sampleStudies.length})</span>
                <button class="btn-small" onclick="event.stopPropagation(); hideSamples();" title="Hide sample slides">
                    ✕ Hide
                </button>
            </div>
        `;
        html += sampleStudies.map(study => renderStudyCard(study, 'sample')).join('');
    }
    
    return html || renderEmptyState(hideSamples);
}

/**
 * Render grouped view of studies (by case/patient)
 */
function renderGroupedView(ownedStudies, sharedStudies, sampleStudies, hideSamples) {
    let html = '';
    
    const groups = {};
    const ungrouped = [];
    
    [...ownedStudies, ...sharedStudies].forEach(study => {
        const groupKey = study.case_accession || study.patient_name || null;
        if (groupKey) {
            if (!groups[groupKey]) {
                groups[groupKey] = {
                    key: groupKey,
                    case_accession: study.case_accession,
                    patient_name: study.patient_name,
                    patient_dob: study.patient_dob,
                    slides: []
                };
            }
            groups[groupKey].slides.push(study);
        } else {
            ungrouped.push(study);
        }
    });
    
    const groupKeys = Object.keys(groups).sort();
    if (groupKeys.length > 0) {
        html += `<div class="study-section-header">📁 Cases & Patients (${groupKeys.length})</div>`;
        
        groupKeys.forEach(key => {
            const group = groups[key];
            const isOwned = group.slides.some(s => ownedStudies.includes(s));
            
            html += `
                <div class="case-group">
                    <div class="case-group-header" onclick="toggleCaseGroup(this)">
                        <svg class="expand-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="6 9 12 15 18 9"/>
                        </svg>
                        <div class="case-info">
                            <div class="case-title">${group.case_accession ? '📋 ' + group.case_accession : '👤 ' + group.patient_name}</div>
                            <div class="case-meta">
                                ${group.patient_name && group.case_accession ? group.patient_name + ' • ' : ''}
                                ${group.patient_dob ? group.patient_dob.substring(0, 10) : ''}
                            </div>
                        </div>
                        <span class="slide-count">${group.slides.length} slide${group.slides.length > 1 ? 's' : ''}</span>
                    </div>
                    <div class="case-group-slides">
                        ${group.slides.map(study => renderStudyCard(study, isOwned ? 'owned' : 'shared')).join('')}
                    </div>
                </div>
            `;
        });
    }
    
    if (ungrouped.length > 0) {
        html += `<div class="ungrouped-header">Ungrouped Slides (${ungrouped.length})</div>`;
        html += ungrouped.map(study => renderStudyCard(study, 'owned')).join('');
    }
    
    if (sampleStudies.length > 0 && !hideSamples) {
        html += `
            <div class="study-section-header" style="margin-top: 16px; display: flex; justify-content: space-between; align-items: center;">
                <span>📚 Sample Slides (${sampleStudies.length})</span>
                <button class="btn-small" onclick="event.stopPropagation(); hideSamples();" title="Hide sample slides">
                    ✕ Hide
                </button>
            </div>
        `;
        html += sampleStudies.map(study => renderStudyCard(study, 'sample')).join('');
    }
    
    return html || renderEmptyState(hideSamples);
}

/**
 * Toggle case group expand/collapse
 */
function toggleCaseGroup(header) {
    header.classList.toggle('collapsed');
    const slides = header.nextElementSibling;
    if (slides) slides.classList.toggle('collapsed');
}

/**
 * Open slide edit dialog
 */
async function openSlideEditDialog(slideId, fallbackName, fallbackStain) {
    currentEditSlideId = slideId;
    const idInput = document.getElementById('slide-edit-id');
    const nameInput = document.getElementById('slide-edit-name');
    const stainSelect = document.getElementById('slide-edit-stain');
    const caseSelect = document.getElementById('slide-edit-case');
    const blockSelect = document.getElementById('slide-edit-block');
    const patientSelect = document.getElementById('slide-edit-patient');
    const dialog = document.getElementById('slide-edit-dialog');

    if (idInput) idInput.value = slideId;
    if (nameInput) nameInput.value = fallbackName || '';
    if (stainSelect) stainSelect.value = fallbackStain || '';
    if (caseSelect) caseSelect.innerHTML = '<option value="">-- No Case --</option>';
    if (blockSelect) blockSelect.innerHTML = '<option value="">-- No Block --</option>';
    if (patientSelect) patientSelect.innerHTML = '<option value="">-- No Patient --</option>';
    
    if (dialog) dialog.style.display = 'flex';
    
    try {
        const slideRes = await authFetch(`/api/slides/${slideId}`);
        if (slideRes.ok) {
            const slide = await slideRes.json();
            window.currentSlideData = slide;
            if (nameInput && slide.display_name) nameInput.value = slide.display_name;
            if (stainSelect && slide.stain) stainSelect.value = slide.stain;
        } else {
            window.currentSlideData = null;
        }
    } catch (e) {
        window.currentSlideData = null;
    }
    
    await loadHierarchyOptions();
    if (nameInput) nameInput.focus();
}

/**
 * Load hierarchy options for slide editing
 */
async function loadHierarchyOptions() {
    const slideData = window.currentSlideData;
    
    try {
        const casesRes = await authFetch('/api/cases');
        if (casesRes.ok) {
            const data = await casesRes.json();
            const select = document.getElementById('slide-edit-case');
            if (select) {
                data.cases?.forEach(c => {
                    const opt = document.createElement('option');
                    opt.value = c.id;
                    opt.textContent = c.accession_number || `Case #${c.id}`;
                    if (slideData?.case_id === c.id) opt.selected = true;
                    select.appendChild(opt);
                });
            }
        }
        
        const blocksRes = await authFetch('/api/blocks');
        if (blocksRes.ok) {
            const data = await blocksRes.json();
            const select = document.getElementById('slide-edit-block');
            if (select) {
                data.blocks?.forEach(b => {
                    const opt = document.createElement('option');
                    opt.value = b.id;
                    opt.textContent = b.block_id || `Block #${b.id}`;
                    if (slideData?.block_id === b.id) opt.selected = true;
                    select.appendChild(opt);
                });
            }
        }
        
        const patientsRes = await authFetch('/api/patients');
        if (patientsRes.ok) {
            const data = await patientsRes.json();
            const select = document.getElementById('slide-edit-patient');
            if (select) {
                data.patients?.forEach(p => {
                    const opt = document.createElement('option');
                    opt.value = p.id;
                    opt.textContent = p.name || p.mrn || `Patient #${p.id}`;
                    if (slideData?.patient_id === p.id) opt.selected = true;
                    select.appendChild(opt);
                });
            }
        }
    } catch (e) {
        console.log('Could not load hierarchy options:', e);
    }
}

/**
 * Close slide edit dialog
 */
function closeSlideEditDialog() {
    const dialog = document.getElementById('slide-edit-dialog');
    if (dialog) dialog.style.display = 'none';
    currentEditSlideId = null;
    window.currentSlideData = null;
}

/**
 * Save slide edits
 */
async function saveSlideEdit() {
    const slideId = document.getElementById('slide-edit-id')?.value;
    const displayName = document.getElementById('slide-edit-name')?.value.trim();
    const stain = document.getElementById('slide-edit-stain')?.value;
    const caseId = document.getElementById('slide-edit-case')?.value;
    const blockId = document.getElementById('slide-edit-block')?.value;
    const patientId = document.getElementById('slide-edit-patient')?.value;
    
    if (!slideId) {
        alert('No slide selected');
        return;
    }
    
    try {
        const response = await authFetch(`/api/slides/${slideId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                display_name: displayName || null,
                stain: stain || null,
                case_id: caseId ? parseInt(caseId) : -1,
                block_id: blockId ? parseInt(blockId) : -1,
                patient_id: patientId ? parseInt(patientId) : -1
            })
        });
        
        if (response.ok) {
            closeSlideEditDialog();
            await refreshStudies();
        } else {
            const err = await response.json();
            alert('Failed to save: ' + (err.detail || 'Unknown error'));
        }
    } catch (error) {
        alert('Failed to save slide: ' + error.message);
    }
}

/**
 * Quick create new case
 */
async function showNewCaseForm() {
    const accession = prompt('Enter Case/Accession Number:\n(e.g., S24-12345)');
    if (!accession) return;
    
    try {
        const response = await authFetch('/api/cases', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accession_number: accession.trim() })
        });
        
        if (response.ok) {
            const result = await response.json();
            const select = document.getElementById('slide-edit-case');
            if (select) {
                const opt = document.createElement('option');
                opt.value = result.case_id;
                opt.textContent = accession.trim();
                opt.selected = true;
                select.appendChild(opt);
            }
        } else {
            alert('Failed to create case');
        }
    } catch (e) {
        alert('Error: ' + e.message);
    }
}

/**
 * Quick create new block
 */
async function showNewBlockForm() {
    const blockId = prompt('Enter Block ID:\n(e.g., A1, A2, B1)');
    if (!blockId) return;
    
    const caseId = document.getElementById('slide-edit-case')?.value;
    
    try {
        const response = await authFetch('/api/blocks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                block_id: blockId.trim(),
                case_id: caseId ? parseInt(caseId) : null
            })
        });
        
        if (response.ok) {
            const result = await response.json();
            const select = document.getElementById('slide-edit-block');
            if (select) {
                const opt = document.createElement('option');
                opt.value = result.block_id;
                opt.textContent = blockId.trim();
                opt.selected = true;
                select.appendChild(opt);
            }
        } else {
            alert('Failed to create block');
        }
    } catch (e) {
        alert('Error: ' + e.message);
    }
}

/**
 * Quick create new patient
 */
async function showNewPatientForm() {
    const name = prompt('Enter Patient Name:');
    if (!name) return;
    
    const mrn = prompt('Enter MRN (optional):');
    const dobStr = prompt('Enter Date of Birth (YYYY-MM-DD, optional):');
    
    let dob = null;
    if (dobStr) {
        const dobMatch = dobStr.match(/^\d{4}-\d{2}-\d{2}$/);
        if (dobMatch) dob = dobStr;
        else alert('Invalid date format. Use YYYY-MM-DD.');
    }
    
    try {
        const response = await authFetch('/api/patients', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                name: name.trim(),
                mrn: mrn?.trim() || null,
                dob: dob
            })
        });
        
        if (response.ok) {
            const result = await response.json();
            const select = document.getElementById('slide-edit-patient');
            if (select) {
                const opt = document.createElement('option');
                opt.value = result.patient_id;
                opt.textContent = name.trim() + (dob ? ` (${dob})` : '');
                opt.selected = true;
                select.appendChild(opt);
            }
        } else {
            alert('Failed to create patient');
        }
    } catch (e) {
        alert('Error: ' + e.message);
    }
}

/**
 * Open sharing dialog
 */
async function openShareDialog(studyId) {
    currentShareStudyId = studyId;
    
    let accessInfo = null;
    try {
        const accessResponse = await authFetch(`/api/slides/${studyId}/access-info`);
        if (accessResponse.ok) accessInfo = await accessResponse.json();
    } catch (e) {}
    
    let accessHtml = '';
    if (accessInfo && accessInfo.has_access) {
        let badgeClass = 'owner';
        let badgeText = 'You own this slide';
        
        if (accessInfo.access_type === 'direct_share') {
            badgeClass = 'direct-share';
            badgeText = `Shared with you (${accessInfo.permission})`;
        } else if (accessInfo.access_type === 'case_share') {
            badgeClass = 'case-share';
            badgeText = `Access via case share (${accessInfo.permission})`;
        } else if (accessInfo.access_type === 'sample') {
            badgeClass = 'sample';
            badgeText = 'Sample slide (public)';
        }
        
        accessHtml = `
            <div class="access-info">
                <div class="access-info-label">Your Access</div>
                <span class="access-badge ${badgeClass}">${badgeText}</span>
            </div>
        `;
    }
    
    const isOwner = accessInfo && accessInfo.access_type === 'owner';
    const sharingControlsHtml = isOwner ? `
        <input type="text" class="share-search-input" id="share-search" 
               placeholder="Search by email or name..." 
               oninput="searchUsersToShare(this.value)">
        <div class="share-results" id="share-results">
            <div style="color: var(--text-muted); text-align: center; padding: 20px;">
                Type to search for users
            </div>
        </div>
        <div class="share-current-list" id="share-current">
            <h4>Currently shared with</h4>
            <div id="current-shares">Loading...</div>
        </div>
        
        <div class="public-link-section">
            <h4>🌐 Public Links (No Login Required)</h4>
            <div class="public-link-list" id="public-links-list">
                Loading...
            </div>
            <div class="public-link-create">
                <select id="public-link-expiry">
                    <option value="">Never expires</option>
                    <option value="1">1 day</option>
                    <option value="7">7 days</option>
                    <option value="30">30 days</option>
                    <option value="90">90 days</option>
                </select>
                <button onclick="createPublicLink()">🔗 Create Link</button>
            </div>
        </div>
    ` : `
        <div style="color: var(--text-muted); text-align: center; padding: 20px;">
            Only the slide owner can manage sharing.
        </div>
    `;
    
    const dialog = document.createElement('div');
    dialog.className = 'share-dialog';
    dialog.id = 'share-dialog';
    dialog.innerHTML = `
        <div class="share-dialog-content">
            <h3>🔗 ${isOwner ? 'Share Slide' : 'Slide Access'}</h3>
            ${accessHtml}
            ${sharingControlsHtml}
            <div class="share-dialog-buttons">
                <button class="btn" onclick="closeShareDialog()">Close</button>
            </div>
        </div>
    `;
    
    document.body.appendChild(dialog);
    
    if (isOwner) {
        loadCurrentShares(studyId);
        loadPublicLinks(studyId);
        const searchInput = document.getElementById('share-search');
        if (searchInput) searchInput.focus();
    }
    
    dialog.addEventListener('click', (e) => {
        if (e.target === dialog) closeShareDialog();
    });
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
 * Search users to share with
 */
async function searchUsersToShare(query) {
    const results = document.getElementById('share-results');
    if (!results) return;
    
    if (!query || query.length < 2) {
        results.innerHTML = `<div style="color: var(--text-muted); text-align: center; padding: 20px;">
            Type at least 2 characters to search
        </div>`;
        return;
    }
    
    clearTimeout(shareSearchTimeout);
    shareSearchTimeout = setTimeout(async () => {
        results.innerHTML = `<div style="color: var(--text-muted); text-align: center; padding: 20px;">
            Searching...
        </div>`;
        
        try {
            const response = await authFetch(`/api/users/search?q=${encodeURIComponent(query)}`);
            if (!response.ok) throw new Error('Search failed');
            
            const data = await response.json();
            const users = data.users || [];
            
            if (users.length === 0) {
                results.innerHTML = `<div style="color: var(--text-muted); text-align: center; padding: 20px;">
                    No users found matching "${query}"
                </div>`;
                return;
            }
            
            results.innerHTML = users.map(user => `
                <div class="share-user-item" onclick="shareWithUser('${user.email}', this)">
                    <img src="${user.picture || ''}" class="share-user-avatar" 
                         onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 40 40%27%3E%3Ccircle cx=%2720%27 cy=%2720%27 r=%2720%27 fill=%27%23334155%27/%3E%3C/svg%3E'">
                    <div class="share-user-info">
                        <div class="share-user-name">${user.name || 'Unknown'}</div>
                        <div class="share-user-email">${user.email}</div>
                    </div>
                </div>
            `).join('');
        } catch (e) {
            results.innerHTML = `<div style="color: var(--danger); text-align: center; padding: 20px;">
                Error: ${e.message}
            </div>`;
        }
    }, 300);
}

/**
 * Share slide with a user
 */
async function shareWithUser(email, element) {
    if (!currentShareStudyId) return;
    element.style.opacity = '0.5';
    element.style.pointerEvents = 'none';
    
    try {
        const response = await authFetch(`/api/studies/${currentShareStudyId}/share`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, permission: 'view' })
        });
        
        if (!response.ok) throw new Error('Share failed');
        
        element.innerHTML = `<span style="color: var(--accent);">✓ Shared with ${email}</span>`;
        const shares = await loadCurrentShares(currentShareStudyId);
        updateShareButtonState(currentShareStudyId, shares.length);
        
    } catch (e) {
        element.style.opacity = '1';
        element.style.pointerEvents = 'auto';
        alert('Failed to share: ' + e.message);
    }
}

/**
 * Load current shares for a study
 */
async function loadCurrentShares(studyId) {
    const container = document.getElementById('current-shares');
    if (!container) return [];
    
    try {
        const response = await authFetch(`/api/studies/${studyId}/shares`);
        if (!response.ok) throw new Error('Failed to load shares');
        
        const data = await response.json();
        const shares = data.shares || [];
        
        if (shares.length === 0) {
            container.innerHTML = `<div style="color: var(--text-muted); font-size: 13px;">
                Not shared with anyone yet
            </div>`;
            return [];
        }
        
        container.innerHTML = shares.map(share => `
            <div class="share-current-item">
                <img src="${share.picture || ''}" onerror="this.src='data:image/svg+xml,...'">
                <span class="email">${share.email}</span>
                <button class="share-remove-btn" onclick="unshareWithUser(${share.user_id})">×</button>
            </div>
        `).join('');
        return shares;
    } catch (e) {
        container.innerHTML = `<div style="color: var(--danger); font-size: 13px;">${e.message}</div>`;
        return [];
    }
}

/**
 * Remove user share
 */
async function unshareWithUser(userId) {
    if (!currentShareStudyId) return;
    try {
        const response = await authFetch(`/api/studies/${currentShareStudyId}/share/${userId}`, { method: 'DELETE' });
        if (response.ok) {
            const shares = await loadCurrentShares(currentShareStudyId);
            updateShareButtonState(currentShareStudyId, shares.length);
        }
    } catch (e) {
        alert('Failed to remove share');
    }
}

/**
 * Update share button icon state
 */
function updateShareButtonState(studyId, shareCount) {
    const card = document.querySelector(`.study-card[data-id="${studyId}"]`);
    if (!card) return;
    const btn = card.querySelector('.share-btn');
    if (!btn) return;
    if (shareCount > 0) {
        btn.classList.add('shared');
        btn.title = `Shared with ${shareCount} user(s)`;
    } else {
        btn.classList.remove('shared');
        btn.title = 'Share this study';
    }
}

/**
 * Load public links for a study
 */
async function loadPublicLinks(studyId) {
    const container = document.getElementById('public-links-list');
    if (!container) return;
    
    try {
        const response = await authFetch(`/api/studies/${studyId}/public-links`);
        if (response.ok) {
            const data = await response.json();
            const links = data.links || [];
            if (links.length === 0) {
                container.innerHTML = '<div style="color: var(--text-muted); font-size: 13px;">No public links</div>';
                return;
            }
            container.innerHTML = links.map(link => `
                <div class="public-link-item">
                    <span>${link.title || 'Public Link'}</span>
                    <button onclick="copyPublicLink('${link.token}')">Copy</button>
                    <button onclick="deletePublicLink(${link.id})">Del</button>
                </div>
            `).join('');
        }
    } catch (e) {}
}

/**
 * Create a new public access link
 */
async function createPublicLink() {
    if (!currentShareStudyId) return;
    const days = document.getElementById('public-link-expiry')?.value;
    try {
        const response = await authFetch(`/api/studies/${currentShareStudyId}/public-link`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ expires_in_days: days ? parseInt(days) : null })
        });
        if (response.ok) {
            const result = await response.json();
            copyPublicLink(result.token);
            loadPublicLinks(currentShareStudyId);
        }
    } catch (e) {
        alert('Failed to create public link');
    }
}

/**
 * Copy public link to clipboard
 */
function copyPublicLink(token) {
    const url = window.location.origin + '/viewer/public/' + token;
    navigator.clipboard.writeText(url).then(() => alert('Link copied!'));
}

/**
 * Delete a public link
 */
async function deletePublicLink(linkId) {
    if (!currentShareStudyId || !confirm('Delete this public link?')) return;
    try {
        const response = await authFetch(`/api/studies/${currentShareStudyId}/public-link/${linkId}`, { method: 'DELETE' });
        if (response.ok) loadPublicLinks(currentShareStudyId);
    } catch (e) {}
}
