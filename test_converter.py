#!/usr/bin/env python3
"""Test the WSI format converter"""

import requests
import sys
import time
from pathlib import Path

if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

CONVERTER_URL = "http://localhost:8000"

def upload_file(file_path):
    """Upload a WSI file for conversion"""
    print(f"\nUploading: {file_path.name}")
    print(f"  Size: {file_path.stat().st_size / (1024*1024):.1f} MB")
    
    with open(file_path, 'rb') as f:
        files = {'file': (file_path.name, f)}
        response = requests.post(f"{CONVERTER_URL}/upload", files=files, timeout=300)
    
    if response.status_code == 200:
        result = response.json()
        print(f"  ✓ Upload accepted")
        print(f"  Job ID: {result.get('job_id', 'N/A')}")
        print(f"  Status: {result.get('status', 'N/A')}")
        return result.get('job_id')
    else:
        print(f"  ✗ Upload failed: {response.status_code}")
        print(f"  Error: {response.text[:200]}")
        return None

def check_job_status(job_id):
    """Check the status of a conversion job"""
    response = requests.get(f"{CONVERTER_URL}/jobs/{job_id}")
    if response.status_code == 200:
        return response.json()
    return None

def wait_for_job(job_id, timeout=300):
    """Wait for a job to complete"""
    print(f"\nWaiting for job {job_id}...")
    start_time = time.time()
    
    while time.time() - start_time < timeout:
        status = check_job_status(job_id)
        if status:
            state = status.get('status', 'unknown')
            print(f"  Status: {state}")
            
            if state == 'completed':
                print(f"  ✓ Conversion completed!")
                if 'study_id' in status:
                    print(f"  Study ID: {status['study_id']}")
                return status
            elif state == 'failed':
                print(f"  ✗ Conversion failed: {status.get('error', 'Unknown error')}")
                return status
            elif state in ['pending', 'processing', 'converting']:
                pass  # Still working
            else:
                print(f"  Unknown state: {state}")
        
        time.sleep(5)
    
    print(f"  ✗ Timeout waiting for job")
    return None

def main():
    print("="*60)
    print("WSI Format Converter Test")
    print("="*60)
    
    # Check converter health
    try:
        r = requests.get(f"{CONVERTER_URL}/health")
        if r.status_code == 200:
            print("✓ Converter is healthy")
        else:
            print(f"✗ Converter health check failed: {r.status_code}")
            return
    except Exception as e:
        print(f"✗ Cannot connect to converter: {e}")
        return
    
    # Test files
    test_files = [
        Path("testdata/CMU-1-Small-Region.svs"),  # Aperio SVS
        Path("testdata/CMU-1.ndpi"),               # Hamamatsu NDPI
    ]
    
    jobs = []
    
    for file_path in test_files:
        if file_path.exists():
            job_id = upload_file(file_path)
            if job_id:
                jobs.append((file_path.name, job_id))
        else:
            print(f"\n⚠ File not found: {file_path}")
    
    # Wait for all jobs to complete
    print("\n" + "="*60)
    print("Waiting for conversions...")
    print("="*60)
    
    for filename, job_id in jobs:
        print(f"\n{filename}:")
        result = wait_for_job(job_id)
        if result and result.get('status') == 'completed':
            # Check if the converted study is in Orthanc
            study_id = result.get('study_id')
            if study_id:
                orthanc_r = requests.get(
                    f"http://localhost:8042/studies/{study_id}",
                    auth=('admin', 'orthanc')
                )
                if orthanc_r.status_code == 200:
                    study = orthanc_r.json()
                    series_count = len(study.get('Series', []))
                    print(f"  ✓ Study in Orthanc: {series_count} series")
    
    # List all jobs
    print("\n" + "="*60)
    print("All Jobs:")
    print("="*60)
    
    jobs_response = requests.get(f"{CONVERTER_URL}/jobs")
    if jobs_response.status_code == 200:
        all_jobs = jobs_response.json()
        for job in all_jobs[-5:]:  # Show last 5
            print(f"  {job.get('job_id', 'N/A')}: {job.get('status', 'unknown')} - {job.get('filename', 'N/A')}")

if __name__ == "__main__":
    main()
