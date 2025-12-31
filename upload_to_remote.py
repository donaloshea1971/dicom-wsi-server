import requests
import os
import sys
import time

sys.stdout.reconfigure(encoding='utf-8')

CONVERTER = 'http://144.126.203.208:8000'

# Proprietary files to convert
files_to_convert = [
    'testdata/CMU-1-Small-Region.svs',
    'testdata/Leica/Leica-1.scn',
    'testdata/Hamamatsu/OS-1.ndpi',
]

print('=== Uploading to Converter ===')
jobs = []
for filepath in files_to_convert:
    if not os.path.exists(filepath):
        print(f'SKIP: {filepath} not found')
        continue
    
    size_mb = os.path.getsize(filepath) / (1024*1024)
    print(f'Uploading {os.path.basename(filepath)} ({size_mb:.1f} MB)...')
    
    with open(filepath, 'rb') as f:
        try:
            r = requests.post(f'{CONVERTER}/upload', files={'file': f}, timeout=600)
            if r.status_code == 200:
                job = r.json()
                jobs.append(job['job_id'])
                print(f"  -> Job: {job['job_id']}")
            else:
                print(f'  -> FAIL: {r.status_code} {r.text[:100]}')
        except Exception as e:
            print(f'  -> ERROR: {e}')

print(f'\nWaiting for conversions...')
time.sleep(10)

# Check job status
r = requests.get(f'{CONVERTER}/jobs')
if r.status_code == 200:
    all_jobs = r.json().get('jobs', [])
    print(f'\n=== Job Status ({len(all_jobs)} total) ===')
    for job in all_jobs[-10:]:
        print(f"{job['filename']}: {job['status']} - {job.get('message', '')[:60]}")

