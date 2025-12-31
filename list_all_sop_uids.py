#!/usr/bin/env python3
"""List all SOP Instance UIDs for WSI images"""

import requests
import sys

# Fix encoding
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

auth = ('admin', 'orthanc')
base_url = 'http://localhost:8042'

print("Finding all WSI SOP Instance UIDs...\n")

# Get all series
series_list = requests.get(f'{base_url}/series', auth=auth).json()

wsi_count = 0
for series_id in series_list:
    series_info = requests.get(f'{base_url}/series/{series_id}', auth=auth).json()
    modality = series_info.get('MainDicomTags', {}).get('Modality', '')
    
    if modality == 'SM':  # Slide Microscopy
        patient_name = series_info.get('MainDicomTags', {}).get('PatientName', 'Unknown')
        print(f"\nPatient: {patient_name}")
        print(f"Series: {series_id}")
        
        # Check if pyramid works
        pyramid_response = requests.get(f'{base_url}/wsi/pyramids/{series_id}', auth=auth)
        if pyramid_response.status_code == 200:
            pyramid = pyramid_response.json()
            print(f"Pyramid: {pyramid['TotalWidth']}x{pyramid['TotalHeight']}, {len(pyramid['Resolutions'])} levels")
        
        # Get first few instances
        instances = series_info.get('Instances', [])
        print(f"Instances: {len(instances)} total")
        
        for i, instance_id in enumerate(instances[:3]):  # Show first 3
            tags = requests.get(f'{base_url}/instances/{instance_id}/tags', auth=auth).json()
            sop_uid = tags.get('0008,0018', {}).get('Value', ['Unknown'])[0]
            image_type = tags.get('0008,0008', {}).get('Value', ['Unknown'])
            
            print(f"  - {sop_uid}")
            print(f"    Type: {'/'.join(image_type[:4]) if isinstance(image_type, list) else image_type}")
            
        if len(instances) > 3:
            print(f"  ... and {len(instances) - 3} more instances")
        
        wsi_count += 1

print(f"\n\nTotal WSI series found: {wsi_count}")
print("\nTo check a specific image, use its SOP Instance UID from the list above.")
