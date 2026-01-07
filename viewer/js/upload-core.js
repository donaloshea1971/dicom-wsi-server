/**
 * PathView Pro - Upload Core Engine
 * Handles chunked uploads, parallel processing, and retry logic
 */

// Constants
const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB chunks
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const CONCURRENT_CHUNKS = 3; // Upload 3 chunks in parallel

/**
 * Upload a DICOM group via REST API
 */
async function uploadDicomGroup(items) {
    const token = typeof getAuthToken === 'function' ? await getAuthToken() : null;
    
    for (const item of items) {
        item.status = 'uploading';
        item.progress = 0;
        item.error = null;
        if (typeof updateQueueUI === 'function') updateQueueUI();
        
        let success = false;
        let lastError = null;
        
        for (let attempt = 1; attempt <= MAX_RETRIES && !success; attempt++) {
            try {
                item.message = attempt > 1 ? `Retry ${attempt}/${MAX_RETRIES}...` : 'Uploading...';
                if (typeof updateQueueUI === 'function') updateQueueUI();
                
                const headers = {
                    'Content-Type': 'application/dicom'
                };
                
                if (token) {
                    headers['Authorization'] = `Bearer ${token}`;
                }
                
                const response = await fetch('/api/instances', {
                    method: 'POST',
                    body: item.file,
                    headers: headers
                });
                
                if (response.ok) {
                    const result = await response.json();
                    
                    // Orthanc can return a single object or an array of objects
                    const instances = Array.isArray(result) ? result : [result];
                    
                    for (const res of instances) {
                        const studyId = res.ParentStudy;
                        if (token && studyId) {
                            try {
                                const claimRes = await fetch(`/api/studies/${studyId}/claim`, {
                                    method: 'POST',
                                    headers: { 'Authorization': `Bearer ${token}` }
                                });
                                if (claimRes.ok) {
                                    console.log(`✅ Claimed study: ${studyId}`);
                                } else {
                                    console.warn(`⚠️ Claim failed for study ${studyId}: ${claimRes.status}`);
                                }
                            } catch (claimErr) {
                                console.warn(`⚠️ Error claiming study ${studyId}:`, claimErr);
                            }
                        }
                    }
                    
                    item.status = 'complete';
                    item.progress = 100;
                    item.message = '';
                    success = true;
                } else {
                    const text = await response.text();
                    throw new Error(`HTTP ${response.status}: ${text}`);
                }
            } catch (e) {
                lastError = e;
                console.warn(`DICOM upload attempt ${attempt} failed:`, e.message);
                
                if (attempt < MAX_RETRIES) {
                    item.message = `Retry in ${RETRY_DELAY_MS/1000}s...`;
                    if (typeof updateQueueUI === 'function') updateQueueUI();
                    await sleep(RETRY_DELAY_MS * attempt);
                }
            }
        }
        
        if (!success) {
            item.status = 'error';
            item.error = formatError(lastError);
            console.error('DICOM upload failed after retries:', lastError);
        }
        
        if (typeof updateQueueUI === 'function') updateQueueUI();
    }
}

/**
 * Upload file for conversion using chunked upload for large files
 */
async function uploadForConversion(item) {
    item.status = 'uploading';
    item.progress = 0;
    item.error = null;
    item.uploadId = null;
    item.chunksUploaded = 0;
    item.totalChunks = 0;
    if (typeof updateQueueUI === 'function') updateQueueUI();
    
    const token = typeof getAuthToken === 'function' ? await getAuthToken() : null;
    
    try {
        // Use chunked upload for large files (>50MB), simple upload for smaller
        if (item.file.size > 50 * 1024 * 1024) {
            await uploadChunked(item, token);
        } else {
            await uploadSimple(item, token);
        }
    } catch (e) {
        item.status = 'error';
        item.error = formatError(e);
        console.error('Upload failed:', e);
    }
    
    if (typeof updateQueueUI === 'function') updateQueueUI();
}

/**
 * Simple upload for smaller files (with retry)
 */
async function uploadSimple(item, token) {
    const formData = new FormData();
    formData.append('file', item.file);
    
    let lastError = null;
    
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            item.message = attempt > 1 ? `Retry ${attempt}/${MAX_RETRIES}...` : 'Uploading...';
            if (typeof updateQueueUI === 'function') updateQueueUI();
            
            const response = await uploadWithProgress(
                '/api/upload',
                formData,
                token,
                (progress) => {
                    item.progress = Math.round(progress * 50); // Upload is 0-50%
                    if (typeof updateQueueUI === 'function') updateQueueUI();
                }
            );
            
            // Success - start polling for conversion
            item.jobId = response.job_id;
            if (typeof pollConversionStatus === 'function') {
                await pollConversionStatus(item, token);
            }
            return;
            
        } catch (e) {
            lastError = e;
            console.warn(`Upload attempt ${attempt} failed:`, e.message);
            
            if (attempt < MAX_RETRIES) {
                item.message = `Retry in ${RETRY_DELAY_MS/1000}s... (${e.message})`;
                if (typeof updateQueueUI === 'function') updateQueueUI();
                await sleep(RETRY_DELAY_MS * attempt); // Exponential backoff
            }
        }
    }
    
    throw lastError || new Error('Upload failed after retries');
}

/**
 * Chunked upload for large files
 */
async function uploadChunked(item, token) {
    // Initialize chunked upload
    item.message = 'Initializing upload...';
    if (typeof updateQueueUI === 'function') updateQueueUI();
    
    const initResponse = await fetchWithRetry('/api/upload/init', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(token && { 'Authorization': `Bearer ${token}` })
        },
        body: JSON.stringify({
            filename: item.file.name,
            file_size: item.file.size,
            chunk_size: CHUNK_SIZE
        })
    });
    
    const { upload_id, total_chunks, chunk_size } = initResponse;
    item.uploadId = upload_id;
    item.totalChunks = total_chunks;
    item.chunksUploaded = 0;
    
    console.log(`📦 Chunked upload started: ${upload_id}, ${total_chunks} chunks`);
    
    const chunkQueue = Array.from({ length: total_chunks }, (_, i) => i);
    const failedChunks = new Set();
    
    while (chunkQueue.length > 0 || failedChunks.size > 0) {
        const batch = [];
        while (batch.length < CONCURRENT_CHUNKS && chunkQueue.length > 0) {
            batch.push(chunkQueue.shift());
        }
        
        if (batch.length === 0 && failedChunks.size > 0) {
            const retryChunks = Array.from(failedChunks).slice(0, CONCURRENT_CHUNKS);
            retryChunks.forEach(c => failedChunks.delete(c));
            batch.push(...retryChunks);
            item.message = `Retrying ${batch.length} failed chunks...`;
            if (typeof updateQueueUI === 'function') updateQueueUI();
            await sleep(RETRY_DELAY_MS);
        }
        
        if (batch.length === 0) break;
        
        const results = await Promise.all(
            batch.map(chunkIndex => uploadChunk(item, upload_id, chunkIndex, chunk_size, token))
        );
        
        results.forEach((success, i) => {
            if (success) {
                item.chunksUploaded++;
            } else {
                failedChunks.add(batch[i]);
            }
        });
        
        item.progress = Math.round((item.chunksUploaded / total_chunks) * 50);
        item.message = `Uploading ${item.chunksUploaded}/${total_chunks} chunks`;
        if (typeof updateQueueUI === 'function') updateQueueUI();
        
        if (failedChunks.size > total_chunks * 0.3) {
            throw new Error(`Too many chunk failures (${failedChunks.size}/${total_chunks})`);
        }
    }
    
    item.message = 'Assembling file...';
    item.progress = 50;
    if (typeof updateQueueUI === 'function') updateQueueUI();
    
    await fetchWithRetry(`/api/upload/${upload_id}/complete`, {
        method: 'POST',
        headers: token ? { 'Authorization': `Bearer ${token}` } : {}
    });
    
    if (typeof pollChunkedUploadStatus === 'function') {
        await pollChunkedUploadStatus(item, upload_id, token);
    }
}

/**
 * Upload a single chunk with retry
 */
async function uploadChunk(item, uploadId, chunkIndex, chunkSize, token) {
    const start = chunkIndex * chunkSize;
    const end = Math.min(start + chunkSize, item.file.size);
    const chunk = item.file.slice(start, end);
    
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const response = await fetch(`/api/upload/${uploadId}/chunk/${chunkIndex}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/octet-stream',
                    ...(token && { 'Authorization': `Bearer ${token}` })
                },
                body: chunk
            });
            
            if (!response.ok) {
                const text = await response.text();
                throw new Error(`HTTP ${response.status}: ${text}`);
            }
            
            return true;
        } catch (e) {
            console.warn(`Chunk ${chunkIndex} attempt ${attempt} failed:`, e.message);
            if (attempt < MAX_RETRIES) {
                await sleep(RETRY_DELAY_MS * attempt);
            }
        }
    }
    
    return false;
}

/**
 * Upload with progress tracking using XMLHttpRequest
 */
function uploadWithProgress(url, formData, token, onProgress) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        
        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
                onProgress(e.loaded / e.total);
            }
        };
        
        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                try {
                    resolve(JSON.parse(xhr.responseText));
                } catch {
                    resolve({ success: true });
                }
            } else {
                reject(new Error(`HTTP ${xhr.status}: ${xhr.responseText || 'Unknown error'}`));
            }
        };
        
        xhr.onerror = () => reject(new Error('Network error - check your connection'));
        xhr.ontimeout = () => reject(new Error('Upload timed out'));
        
        xhr.open('POST', url);
        xhr.timeout = 30 * 60 * 1000; // 30 minute timeout
        
        if (token) {
            xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        }
        
        xhr.send(formData);
    });
}

/**
 * Fetch with automatic retry
 */
async function fetchWithRetry(url, options = {}, retries = MAX_RETRIES) {
    let lastError = null;
    
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const controller = new AbortController();
            const timeoutMs = url.includes('/status') ? 60000 : 300000;
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
            
            const response = await fetch(url, {
                ...options,
                signal: controller.signal
            });
            
            clearTimeout(timeoutId);
            
            if (!response.ok) {
                const text = await response.text();
                throw new Error(`HTTP ${response.status}: ${text}`);
            }
            
            return await response.json();
            
        } catch (e) {
            lastError = e;
            if (e.name === 'AbortError') {
                lastError = new Error('Request timed out');
            }
            if (e.message.includes('HTTP 4')) {
                throw e;
            }
            if (attempt < retries) {
                console.log(`Retry ${attempt}/${retries} for ${url} after error: ${e.message}`);
                await sleep(RETRY_DELAY_MS * attempt);
            }
        }
    }
    
    throw lastError;
}

/**
 * Format error messages for users
 */
function formatError(error) {
    const msg = error.message || String(error);
    if (msg.includes('Network error') || msg.includes('Failed to fetch')) return 'Network error - check connection';
    if (msg.includes('timeout') || msg.includes('Timeout')) return 'Upload timed out';
    if (msg.includes('HTTP 5')) return 'Server error';
    if (msg.includes('too large') || msg.includes('413')) return 'File too large (max 20GB)';
    return msg.length > 100 ? msg.substring(0, 100) + '...' : msg;
}

/**
 * Utility: format size in bytes to human readable
 */
function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

/**
 * Utility: escape HTML
 */
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Utility: sleep for ms
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Utility: get human readable format name
 */
function getFormatName(filename) {
    const ext = filename.toLowerCase().split('.').pop();
    const formats = {
        'svs': 'Aperio SVS',
        'ndpi': 'Hamamatsu NDPI',
        'mrxs': 'MIRAX',
        'scn': 'Leica SCN',
        'tiff': 'TIFF',
        'tif': 'TIFF',
        'vsi': 'Olympus VSI',
        'bif': 'Ventana BIF',
        'isyntax': 'Philips iSyntax',
        'dcm': 'DICOM',
        'dicom': 'DICOM',
        'zip': 'ZIP Archive'
    };
    return formats[ext] || ext.toUpperCase();
}
