#!/usr/bin/env python3
"""Test the enhanced iSyntax converter"""

import requests
import time
import json
from pathlib import Path

# Configuration
CONVERTER_URL = "http://localhost:3000/api"
ORTHANC_URL = "http://localhost:8042"
AUTH = ("admin", "orthanc")

def test_enhanced_conversion():
    """Test the enhanced iSyntax conversion"""
    
    file_path = "testdata/isyntax/testslide.isyntax"
    
    if not Path(file_path).exists():
        print(f"Error: Test file not found: {file_path}")
        return
    
    print("\n" + "="*60)
    print("Testing Enhanced iSyntax Pyramid Conversion")
    print("="*60 + "\n")
    
    # Upload file
    print("1. Uploading iSyntax file...")
    with open(file_path, 'rb') as f:
        files = {'file': ('testslide.isyntax', f, 'application/octet-stream')}
        response = requests.post(f"{CONVERTER_URL}/upload", files=files)
    
    if response.status_code != 200:
        print(f"[ERROR] Upload failed: {response.status_code} - {response.text}")
        return
    
    job_data = response.json()
    job_id = job_data['job_id']
    print(f"[OK] Job created: {job_id}")
    
    # Monitor conversion
    print("\n2. Monitoring conversion progress...")
    start_time = time.time()
    completed = False
    
    for i in range(300):  # Max 50 minutes (for large conversions)
        response = requests.get(f"{CONVERTER_URL}/jobs/{job_id}")
        if response.status_code != 200:
            print(f"[ERROR] Job status check failed: {response.status_code}")
            break
        
        status = response.json()
        elapsed = int(time.time() - start_time)
        print(f"   [{elapsed}s] {status['status']}: {status['message']} ({status.get('progress', 0)}%)")
        
        if status['status'] == 'completed':
            completed = True
            study_uid = status.get('study_uid')
            print(f"\n[SUCCESS] Conversion completed in {elapsed} seconds!")
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
    print("\n3. Verifying WSI pyramid in Orthanc...")
    time.sleep(5)  # Give Orthanc time to process
    
    if study_uid:
        # Get study details
        response = requests.get(f"{ORTHANC_URL}/studies/{study_uid}", auth=AUTH)
        if response.status_code == 200:
            study = response.json()
            series_list = study.get('Series', [])
            print(f"   Found {len(series_list)} series")
            
            total_instances = 0
            pyramid_found = False
            
            for series_id in series_list:
                # Get series details
                response = requests.get(f"{ORTHANC_URL}/series/{series_id}", auth=AUTH)
                if response.status_code == 200:
                    series = response.json()
                    instances = series.get('Instances', [])
                    total_instances += len(instances)
                    
                    print(f"\n   Series {series_id}:")
                    print(f"     Instances: {len(instances)}")
                    print(f"     Modality: {series['MainDicomTags'].get('Modality', 'N/A')}")
                    print(f"     Description: {series['MainDicomTags'].get('SeriesDescription', 'N/A')}")
                
                # Check for WSI pyramid
                response = requests.get(f"{ORTHANC_URL}/wsi/pyramids/{series_id}", auth=AUTH)
                if response.status_code == 200:
                    pyramid = response.json()
                    pyramid_found = True
                    print(f"\n[SUCCESS] WSI Pyramid found!")
                    print(f"  Total dimensions: {pyramid.get('TotalWidth')}x{pyramid.get('TotalHeight')}")
                    print(f"  Number of levels: {len(pyramid.get('Resolutions', []))}")
                    
                    # Show pyramid structure
                    resolutions = pyramid.get('Resolutions', [])
                    tiles_count = pyramid.get('TilesCount', [])
                    tiles_sizes = pyramid.get('TilesSizes', [])
                    
                    print("\n  Pyramid structure:")
                    for i in range(len(resolutions)):
                        if i < len(tiles_count) and i < len(tiles_sizes):
                            scale = resolutions[i]
                            tiles = tiles_count[i]
                            tile_size = tiles_sizes[i]
                            level_width = int(pyramid.get('TotalWidth', 0) / scale)
                            level_height = int(pyramid.get('TotalHeight', 0) / scale)
                            print(f"    Level {i}: {level_width}x{level_height} pixels, "
                                  f"{tiles[0]}x{tiles[1]} tiles of {tile_size[0]}x{tile_size[1]}")
            
            print(f"\n  Total DICOM instances: {total_instances}")
            
            if pyramid_found and total_instances > 10:
                print("\n[SUCCESS] Enhanced iSyntax conversion successful!")
                print("  - Multi-resolution pyramid created")
                print(f"  - {total_instances} DICOM files generated")
                print("  - Ready for viewing in OpenSeadragon")
            else:
                print("\n[WARNING] Pyramid may be incomplete")
                print(f"  - Pyramid found: {pyramid_found}")
                print(f"  - Instance count: {total_instances}")

if __name__ == "__main__":
    test_enhanced_conversion()
