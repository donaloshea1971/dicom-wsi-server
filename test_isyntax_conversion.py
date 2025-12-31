#!/usr/bin/env python3
"""Test iSyntax conversion with detailed pyramid checking"""

import requests
import time
import json
from pathlib import Path

# Configuration
CONVERTER_URL = "http://localhost:3000/api"
ORTHANC_URL = "http://localhost:8042"
AUTH = ("admin", "orthanc")

def test_isyntax_conversion():
    """Test iSyntax conversion and verify pyramid generation"""
    
    file_path = "testdata/isyntax/testslide.isyntax"
    
    if not Path(file_path).exists():
        print(f"Error: Test file not found: {file_path}")
        return
    
    print(f"\n{'='*60}")
    print("Testing iSyntax Conversion")
    print(f"{'='*60}\n")
    
    # Upload file
    print("1. Uploading file to converter...")
    with open(file_path, 'rb') as f:
        files = {'file': ('testslide.isyntax', f, 'application/octet-stream')}
        response = requests.post(f"{CONVERTER_URL}/upload", files=files)
    
    if response.status_code != 200:
        print(f"Upload failed: {response.status_code} - {response.text}")
        return
    
    job_data = response.json()
    job_id = job_data['job_id']
    print(f"[OK] Job created: {job_id}")
    
    # Monitor conversion
    print("\n2. Monitoring conversion progress...")
    completed = False
    for i in range(120):  # Max 20 minutes
        response = requests.get(f"{CONVERTER_URL}/jobs/{job_id}")
        if response.status_code != 200:
            print(f"Error checking job status: {response.status_code}")
            break
        
        status = response.json()
        print(f"   [{i*10}s] {status['status']}: {status['message']} ({status.get('progress', 0)}%)")
        
        if status['status'] == 'completed':
            completed = True
            study_uid = status.get('study_uid')
            print(f"\n[SUCCESS] Conversion completed!")
            print(f"  Study UID: {study_uid}")
            break
        elif status['status'] == 'failed':
            print(f"\n[FAILED] Conversion failed: {status['message']}")
            return
        
        time.sleep(10)
    
    if not completed:
        print("\n[TIMEOUT] Conversion timed out")
        return
    
    # Check the pyramid
    print("\n3. Checking WSI pyramid in Orthanc...")
    time.sleep(3)  # Give Orthanc time to process
    
    if study_uid:
        # Get study details
        response = requests.get(f"{ORTHANC_URL}/studies/{study_uid}", auth=AUTH)
        if response.status_code == 200:
            study = response.json()
            series_list = study.get('Series', [])
            print(f"   Found {len(series_list)} series")
            
            for series_id in series_list:
                # Check for WSI pyramid
                response = requests.get(f"{ORTHANC_URL}/wsi/pyramids/{series_id}", auth=AUTH)
                if response.status_code == 200:
                    pyramid = response.json()
                    print(f"\n[SUCCESS] WSI Pyramid found for series {series_id}!")
                    print(f"  Total dimensions: {pyramid.get('TotalWidth')}x{pyramid.get('TotalHeight')}")
                    print(f"  Background color: {pyramid.get('BackgroundColor')}")
                    print(f"  Number of levels: {len(pyramid.get('Resolutions', []))}")
                    
                    resolutions = pyramid.get('Resolutions', [])
                    for i, res in enumerate(resolutions):
                        print(f"    Level {i}: scale factor {res}")
                    
                    # Check tile information
                    tiles_count = pyramid.get('TilesCount', [])
                    tiles_sizes = pyramid.get('TilesSizes', [])
                    for i in range(len(tiles_count)):
                        if i < len(tiles_sizes):
                            print(f"    Level {i}: {tiles_count[i][0]}x{tiles_count[i][1]} tiles of {tiles_sizes[i][0]}x{tiles_sizes[i][1]} pixels")
                    
                    return True
                else:
                    print(f"\n[NO PYRAMID] No WSI pyramid found for series {series_id} (status: {response.status_code})")
                    
                    # Get series details
                    response = requests.get(f"{ORTHANC_URL}/series/{series_id}", auth=AUTH)
                    if response.status_code == 200:
                        series = response.json()
                        instances = series.get('Instances', [])
                        print(f"  Series has {len(instances)} instances")
                        
                        # Check first instance
                        if instances:
                            response = requests.get(f"{ORTHANC_URL}/instances/{instances[0]}/tags", auth=AUTH)
                            if response.status_code == 200:
                                tags = response.json()
                                modality = tags.get('0008,0060', {}).get('Value', [''])[0]
                                rows = tags.get('0028,0010', {}).get('Value', [0])[0]
                                cols = tags.get('0028,0011', {}).get('Value', [0])[0]
                                frames = tags.get('0028,0008', {}).get('Value', [1])[0]
                                sop_class = tags.get('0008,0016', {}).get('Value', [''])[0]
                                print(f"  Modality: {modality}")
                                print(f"  Image: {cols}x{rows}, {frames} frames")
                                print(f"  SOP Class: {sop_class}")
    
    return False

if __name__ == "__main__":
    test_isyntax_conversion()
