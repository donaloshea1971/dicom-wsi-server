/**
 * PathView Pro - Upload UI Controller
 * Handles dropzone events, directory traversal, and queue management
 */

// Global state for upload queue
var uploadQueue = [];
var isUploading = false;

// File detection constants
const DICOM_EXTENSIONS = ['.dcm', '.dicom'];
const CONVERT_EXTENSIONS = ['.svs', '.ndpi', '.mrxs', '.scn', '.tiff', '.tif', '.vsi', '.bif'];

/**
 * Initialize dropzone and file input listeners
 */
function initUploadUI() {
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    if (!dropZone || !fileInput) return;

    dropZone.addEventListener('click', () => fileInput.click());
    
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(name => {
        document.body.addEventListener(name, e => {
            e.preventDefault();
            e.stopPropagation();
        });
    });
    
    ['dragenter', 'dragover'].forEach(name => {
        dropZone.addEventListener(name, () => dropZone.classList.add('drag-over'));
    });
    
    ['dragleave', 'drop'].forEach(name => {
        dropZone.addEventListener(name, () => dropZone.classList.remove('drag-over'));
    });

    dropZone.addEventListener('drop', handleDrop);
    fileInput.addEventListener('change', e => {
        addFilesToQueue(Array.from(e.target.files));
        fileInput.value = '';
    });
}

/**
 * Handle files dropped into the zone
 */
async function handleDrop(e) {
    const files = [];
    if (e.dataTransfer.items) {
        const entries = [];
        for (let i = 0; i < e.dataTransfer.items.length; i++) {
            const item = e.dataTransfer.items[i];
            if (item.kind === 'file') {
                const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
                if (entry) entries.push(entry);
                else {
                    const file = item.getAsFile();
                    if (file) files.push(file);
                }
            }
        }
        for (const entry of entries) await traverseEntry(entry, files);
    } else {
        for (let i = 0; i < e.dataTransfer.files.length; i++) {
            files.push(e.dataTransfer.files[i]);
        }
    }
    if (files.length > 0) addFilesToQueue(files);
}

/**
 * Recursively traverse directory entries
 */
async function traverseEntry(entry, files, path = '') {
    if (entry.isFile) {
        const file = await new Promise((res, rej) => entry.file(res, rej));
        file.relativePath = path + file.name;
        files.push(file);
    } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const entries = await new Promise((res, rej) => {
            const all = [];
            const read = () => {
                reader.readEntries(batch => {
                    if (batch.length === 0) res(all);
                    else { all.push(...batch); read(); }
                }, rej);
            };
            read();
        });
        for (const child of entries) await traverseEntry(child, files, path + entry.name + '/');
    }
}

/**
 * Add files to the upload queue
 */
async function addFilesToQueue(files) {
    for (const file of files) {
        const type = await detectFileType(file);
        if (type === 'unknown') continue;
        
        uploadQueue.push({
            id: Date.now() + Math.random(),
            file: file,
            name: file.relativePath || file.name,
            size: file.size,
            type: type,
            status: 'pending',
            progress: 0,
            error: null
        });
    }
    updateQueueUI();
}

/**
 * Detect file type based on extension and magic bytes
 */
async function detectFileType(file) {
    const name = file.name.toLowerCase();
    const ext = '.' + name.split('.').pop();
    if (DICOM_EXTENSIONS.includes(ext)) return 'dicom';
    if (CONVERT_EXTENSIONS.includes(ext)) return 'convert';
    
    const header = await new Promise(res => {
        const r = new FileReader();
        r.onload = () => res(new Uint8Array(r.result));
        r.onerror = () => res(new Uint8Array(0));
        r.readAsArrayBuffer(file.slice(0, 132));
    });
    
    if (header.length >= 132 && header[128] === 0x44 && header[129] === 0x49 && 
        header[130] === 0x43 && header[131] === 0x4D) return 'dicom';
        
    return 'unknown';
}

/**
 * Update the queue list and stats in the UI
 */
function updateQueueUI() {
    const queueEl = document.getElementById('upload-queue');
    const listEl = document.getElementById('queue-list');
    const countEl = document.getElementById('queue-count');
    const statsEl = document.getElementById('upload-stats');
    if (!queueEl || !listEl) return;

    queueEl.style.display = uploadQueue.length > 0 ? 'block' : 'none';
    if (countEl) countEl.textContent = uploadQueue.length;
    
    if (uploadQueue.length === 0) {
        listEl.innerHTML = '<div class="empty-queue">No files in queue</div>';
        if (statsEl) statsEl.classList.remove('active');
        return;
    }
    
    const dicomCount = uploadQueue.filter(f => f.type === 'dicom').length;
    const convertCount = uploadQueue.filter(f => f.type === 'convert').length;
    const totalSize = uploadQueue.reduce((sum, f) => sum + f.size, 0);
    
    if (statsEl) {
        document.getElementById('stat-total').textContent = uploadQueue.length;
        document.getElementById('stat-dicom').textContent = dicomCount;
        document.getElementById('stat-convert').textContent = convertCount;
        document.getElementById('stat-size').textContent = formatSize(totalSize);
        statsEl.classList.add('active');
    }
    
    listEl.innerHTML = uploadQueue.map(item => `
        <div class="queue-item ${item.status}" data-id="${item.id}">
            <div class="queue-item-icon ${item.type} ${item.status === 'uploading' || item.status === 'converting' ? 'spinning' : ''}">
                ${item.type === 'dicom' ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 9h6v6H9z"/></svg>' : 
                  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>'}
            </div>
            <div class="queue-item-info">
                <div class="queue-item-name">${escapeHtml(item.name)}</div>
                <div class="queue-item-meta">
                    <span>${formatSize(item.size)}</span>
                    <span>${item.type === 'dicom' ? 'DICOM' : getFormatName(item.name)}</span>
                </div>
                ${(item.status === 'uploading' || item.status === 'converting') ? `
                    <div class="queue-item-progress"><div class="queue-item-progress-bar" style="width: ${item.progress}%"></div></div>
                    <div style="color: var(--text-secondary); font-size: 11px; margin-top: 4px;">${escapeHtml(item.message || '')}</div>
                ` : ''}
                ${item.error ? `<div style="color: var(--danger); font-size: 12px; margin-top: 4px;">${escapeHtml(item.error)} <button onclick="retryUpload('${item.id}')" class="btn-small">Retry</button></div>` : ''}
            </div>
            <span class="queue-item-status ${item.status}">${item.status === 'pending' ? 'Pending' : item.status === 'complete' ? '✓ Done' : item.status === 'error' ? '✗ Failed' : item.progress + '%'}</span>
            ${(item.status === 'pending' || item.status === 'error') ? `<button class="queue-item-remove" onclick="removeFromQueue('${item.id}')">×</button>` : ''}
        </div>
    `).join('');
}

/**
 * Remove an item from the queue
 */
function removeFromQueue(id) {
    uploadQueue = uploadQueue.filter(item => item.id != id);
    updateQueueUI();
}

/**
 * Clear the entire queue
 */
function clearQueue() {
    if (isUploading) return;
    uploadQueue = [];
    updateQueueUI();
}

/**
 * Start uploading all pending files
 */
async function startUpload() {
    if (isUploading || uploadQueue.length === 0) return;
    
    isUploading = true;
    document.getElementById('upload-btn').disabled = true;
    document.getElementById('clear-btn').disabled = true;
    
    const dicomItems = uploadQueue.filter(f => f.type === 'dicom' && f.status === 'pending');
    const convertFiles = uploadQueue.filter(f => f.type === 'convert' && f.status === 'pending');
    
    if (dicomItems.length > 0) await uploadDicomGroup(dicomItems);
    for (const item of convertFiles) await uploadForConversion(item);
    
    isUploading = false;
    document.getElementById('upload-btn').disabled = false;
    document.getElementById('clear-btn').disabled = false;
    
    const completed = uploadQueue.filter(f => f.status === 'complete').length;
    const failed = uploadQueue.filter(f => f.status === 'error').length;
    alert(`Upload finished. ${completed} succeeded, ${failed} failed.`);
}

/**
 * Retry a failed upload item
 */
async function retryUpload(itemId) {
    const item = uploadQueue.find(i => i.id == itemId);
    if (!item || item.status !== 'error') return;
    
    item.status = 'pending';
    item.progress = 0;
    item.error = null;
    item.message = '';
    updateQueueUI();
    
    if (item.type === 'dicom') await uploadDicomGroup([item]);
    else await uploadForConversion(item);
}
