#!/usr/bin/env python3
"""Test the converter's actual pyramid generation"""

import requests
import time
import json
from pathlib import Path

# Configuration
CONVERTER_URL = "http://localhost:8000"
ORTHANC_URL = "http://localhost:8042"
AUTH = ("admin", "orthanc")

def test_conversion(file_path):
    """Test conversion and check pyramid generation"""
    
    print(f"\n{'='*60}")
    print(f"Testing conversion of: {file_path}")
    print(f"{'='*60}\n")
    
    # Upload file for conversion
    with open(file_path, 'rb') as f:
        files = {'file': (Path(file_path).name, f, 'application/octet-stream')}
        response = requests.post(f"{CONVERTER_URL}/upload", files=files)
    
    if response.status_code != 200:
        print(f"Upload failed: {response.text}")
        return
    
    job_data = response.json()
    job_id = job_data['job_id']
    print(f"Job ID: {job_id}")
    
    # Monitor conversion progress
    for i in range(60):  # Max 10 minutes
        response = requests.get(f"{CONVERTER_URL}/jobs/{job_id}")
        if response.status_code != 200:
            print(f"Job status check failed: {response.text}")
            break
            
        status_data = response.json()
        print(f"[{i*10}s] Status: {status_data['status']} - {status_data['message']} ({status_data.get('progress', 0)}%)")
        
        if status_data['status'] == 'completed':
            study_uid = status_data.get('study_uid')
            print(f"\n✓ Conversion completed!")
            print(f"Study UID: {study_uid}")
            
            # Check the pyramid in Orthanc
            if study_uid:
                time.sleep(2)  # Give Orthanc time to process
                check_pyramid(study_uid)
            break
            
        elif status_data['status'] == 'failed':
            print(f"\n✗ Conversion failed: {status_data['message']}")
            break
        
        time.sleep(10)

def check_pyramid(study_uid):
    """Check if the study has a proper WSI pyramid"""
    
    print(f"\nChecking pyramid for study: {study_uid}")
    
    # Get study details
    response = requests.get(f"{ORTHANC_URL}/studies/{study_uid}", auth=AUTH)
    if response.status_code != 200:
        print(f"Failed to get study details: {response.status_code}")
        return
    
    study_data = response.json()
    series_list = study_data.get('Series', [])
    
    print(f"Number of series: {len(series_list)}")
    
    for series_id in series_list:
        # Get series details
        response = requests.get(f"{ORTHANC_URL}/series/{series_id}", auth=AUTH)
        if response.status_code != 200:
            continue
            
        series_data = response.json()
        instances = series_data.get('Instances', [])
        
        print(f"\nSeries {series_id}:")
        print(f"  Instances: {len(instances)}")
        print(f"  Modality: {series_data['MainDicomTags'].get('Modality', 'N/A')}")
        
        # Check for WSI pyramid
        response = requests.get(f"{ORTHANC_URL}/wsi/pyramids/{series_id}", auth=AUTH)
        if response.status_code == 200:
            pyramid_data = response.json()
            print(f"  ✓ WSI Pyramid found!")
            print(f"    Resolutions: {pyramid_data.get('Resolutions', [])}")
            print(f"    Total size: {pyramid_data.get('TotalWidth', 'N/A')}x{pyramid_data.get('TotalHeight', 'N/A')}")
            print(f"    Tile size: {pyramid_data.get('TilesSizes', 'N/A')}")
            
            # Count frames/instances per level
            if 'TilesCount' in pyramid_data:
                for level, tiles in enumerate(pyramid_data['TilesCount']):
                    if isinstance(tiles, list) and len(tiles) >= 2:
                        print(f"    Level {level}: {tiles[0]}x{tiles[1]} tiles")
        else:
            print(f"  ✗ No WSI pyramid found (status: {response.status_code})")
            
            # Check individual instances
            for i, instance_id in enumerate(instances[:3]):  # Check first 3 instances
                response = requests.get(f"{ORTHANC_URL}/instances/{instance_id}/tags", auth=AUTH)
                if response.status_code == 200:
                    tags = response.json()
                    rows = tags.get('0028,0010', {}).get('Value', ['N/A'])[0]
                    cols = tags.get('0028,0011', {}).get('Value', ['N/A'])[0]
                    frames = tags.get('0028,0008', {}).get('Value', [1])[0]
                    print(f"    Instance {i}: {cols}x{rows}, {frames} frames")

def main():
    """Test various file formats"""
    
    test_files = [
        "testdata/isyntax/testslide.isyntax",
        # Add other test files here if available
    ]
    
    for file_path in test_files:
        if Path(file_path).exists():
            test_conversion(file_path)
        else:
            print(f"Test file not found: {file_path}")

if __name__ == "__main__":
    main()
