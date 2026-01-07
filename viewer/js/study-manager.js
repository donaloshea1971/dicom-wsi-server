/**
 * PathView Pro - Study Manager
 * Handles study loading, filtering, rendering, and list management
 */

// Global state for studies
let studyList = [];  // Store list of study IDs for navigation
let allStudiesCache = { owned: [], shared: [], samples: [] };
let currentViewMode = 'flat'; // 'flat' or 'grouped'

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
    document.getElementById('view-flat').classList.toggle('active', mode === 'flat');
    document.getElementById('view-grouped').classList.toggle('active', mode === 'grouped');
    
    // Re-render the study list
    rerenderStudyList();
}

/**
 * Re-render the study list with cached data
 */
function rerenderStudyList() {
    const list = document.getElementById('study-list');
    const hideSamples = localStorage.getItem('hideSampleSlides') === 'true';
    
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
    
    // Group owned slides by case_accession or patient_name
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
    
    // Render groups
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
    
    // Render ungrouped
    if (ungrouped.length > 0) {
        html += `<div class="ungrouped-header">Ungrouped Slides (${ungrouped.length})</div>`;
        html += ungrouped.map(study => renderStudyCard(study, 'owned')).join('');
    }
    
    // Sample slides
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
    slides.classList.toggle('collapsed');
}
