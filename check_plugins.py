#!/usr/bin/env python3
"""Check Orthanc plugins and WSI endpoints"""

import requests
import sys

# Fix encoding
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

auth = ('admin', 'orthanc')
base_url = 'http://localhost:8042'

print("Checking Orthanc plugins and endpoints...\n")

# Check system info
system = requests.get(f'{base_url}/system', auth=auth).json()
print(f"Orthanc version: {system.get('Version', 'Unknown')}")
print(f"Plugins loaded: {system.get('Plugins', [])}")

# Check various endpoints
endpoints = [
    '/plugins',
    '/plugins/explorer.js',
    '/plugins/wsi',
    '/wsi',
    '/app/viewer.html',
    '/wsi/app',
    '/osimis-viewer/app',
    '/stone-webviewer',
]

print("\nChecking endpoints:")
for endpoint in endpoints:
    try:
        r = requests.get(f'{base_url}{endpoint}', auth=auth)
        print(f"  {endpoint}: {r.status_code}")
        if r.status_code == 200 and endpoint == '/plugins':
            # List available plugins
            print(f"    Available: {r.json()}")
    except Exception as e:
        print(f"  {endpoint}: Error - {e}")

# Check if we can get the list of series and their pyramid info
print("\nChecking series with WSI data:")
series_list = requests.get(f'{base_url}/series', auth=auth).json()
print(f"Total series: {len(series_list)}")

# For each series, try to get WSI info
for series_id in series_list[:2]:  # Check first 2
    series_info = requests.get(f'{base_url}/series/{series_id}', auth=auth).json()
    modality = series_info.get('MainDicomTags', {}).get('Modality', 'Unknown')
    
    if modality == 'SM':  # Slide Microscopy
        print(f"\nSeries {series_id} (Modality: {modality}):")
        
        # Try different WSI endpoints
        wsi_endpoints = [
            f'/wsi/series/{series_id}',
            f'/series/{series_id}/pyramid',
            f'/series/{series_id}/tiles',
            f'/wsi/pyramids/{series_id}',
        ]
        
        for endpoint in wsi_endpoints:
            r = requests.get(f'{base_url}{endpoint}', auth=auth)
            print(f"  {endpoint}: {r.status_code}")
            if r.status_code == 200:
                print(f"    Response: {r.text[:200]}...")

# Check the viewer configuration
print("\nChecking viewer configuration...")
viewer_config_url = 'http://localhost:8080/config.json'
try:
    r = requests.get(viewer_config_url)
    print(f"Viewer config ({viewer_config_url}): {r.status_code}")
    if r.status_code == 200:
        print(f"Config: {r.json()}")
except Exception as e:
    print(f"Viewer config error: {e}")
