/**
 * PathView Pro - Upload Polling Controller
 * Specifically handles job status polling for conversion jobs
 */

/**
 * Poll for chunked upload status (server assembles and converts)
 */
async function pollChunkedUploadStatus(item, uploadId, initialToken) {
    item.status = 'converting';
    let consecutiveErrors = 0;
    const maxConsecutiveErrors = 30; // 1.5 min of failures
    
    while (true) {
        try {
            // Re-fetch token to avoid expiration during long conversions
            const token = typeof getAuthToken === 'function' ? await getAuthToken() : initialToken;
            
            const status = await fetchWithRetry(`/api/upload/${uploadId}/status`, {
                headers: token ? { 'Authorization': `Bearer ${token}` } : {}
            }, 2);
            
            consecutiveErrors = 0;
            item.progress = status.progress;
            item.message = status.message;
            item.jobId = status.job_id;
            if (typeof updateQueueUI === 'function') updateQueueUI();
            
            if (status.status === 'completed') {
                item.status = 'complete';
                item.progress = 100;
                
                // Backup: claim the study from client side in case backend claim failed
                if (status.study_id && token) {
                    try {
                        const claimRes = await fetch(`/api/studies/${status.study_id}/claim`, {
                            method: 'POST',
                            headers: { 'Authorization': `Bearer ${token}` }
                        });
                        if (claimRes.ok) {
                            console.log(`✅ Client claimed converted study: ${status.study_id}`);
                        } else {
                            console.log(`ℹ️ Study claim returned ${claimRes.status} (may already be owned)`);
                        }
                    } catch (e) {
                        console.warn('Client claim attempt failed:', e.message);
                    }
                }
                
                return;
            }
            
            if (status.status === 'failed') {
                throw new Error(status.message || 'Conversion failed');
            }
            
            const pollInterval = item.progress > 60 ? 3000 : 2000;
            await sleep(pollInterval);
            
        } catch (e) {
            consecutiveErrors++;
            console.warn(`Status poll error ${consecutiveErrors}/${maxConsecutiveErrors}:`, e.message);
            
            if (consecutiveErrors >= maxConsecutiveErrors) {
                item.status = 'error';
                item.message = 'Lost connection to server during conversion';
                if (typeof updateQueueUI === 'function') updateQueueUI();
                throw new Error('Lost connection to server during conversion');
            }
            
            item.message = `Checking status... (retry ${consecutiveErrors})`;
            if (typeof updateQueueUI === 'function') updateQueueUI();
            await sleep(3000);
        }
    }
}

/**
 * Poll for conversion job status (simple upload)
 */
async function pollConversionStatus(item, initialToken) {
    item.status = 'converting';
    item.progress = 50;
    
    while (true) {
        try {
            // Re-fetch token to avoid expiration
            const token = typeof getAuthToken === 'function' ? await getAuthToken() : initialToken;
            
            const job = await fetchWithRetry(`/api/jobs/${item.jobId}`, {
                headers: token ? { 'Authorization': `Bearer ${token}` } : {}
            });
            
            // Map job progress (0-100) to our progress (50-100)
            item.progress = 50 + Math.round(job.progress * 0.5);
            item.message = job.message;
            if (typeof updateQueueUI === 'function') updateQueueUI();
            
            if (job.status === 'completed') {
                item.status = 'complete';
                item.progress = 100;
                
                // Backup: claim the study from client side
                const studyId = job.study_id || job.study_uid;
                if (studyId && token) {
                    try {
                        const claimRes = await fetch(`/api/studies/${studyId}/claim`, {
                            method: 'POST',
                            headers: { 'Authorization': `Bearer ${token}` }
                        });
                        if (claimRes.ok) {
                            console.log(`✅ Client claimed converted study: ${studyId}`);
                        } else {
                            console.log(`ℹ️ Study claim returned ${claimRes.status} (may already be owned)`);
                        }
                    } catch (e) {
                        console.warn('Client claim attempt failed:', e.message);
                    }
                }
                
                return;
            }
            
            if (job.status === 'failed') {
                throw new Error(job.message || 'Conversion failed');
            }
            
            await sleep(2000);
            
        } catch (e) {
            console.warn('Job status poll error:', e.message);
            await sleep(3000);
        }
    }
}
