#!/usr/bin/env python3
"""Debug ICC profile extraction from DICOM"""
import requests
import json
import sys

if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

ORTHANC_URL = "http://localhost:8042"
AUTH = ('admin', 'orthanc')

# Sierra study
study_id = '52391c74-f5a241d4-dbf7ae3c-93247a93-53c02305'

# Get first instance
r = requests.get(f'{ORTHANC_URL}/studies/{study_id}', auth=AUTH)
study = r.json()
series_ids = study.get('Series', [])

r2 = requests.get(f'{ORTHANC_URL}/series/{series_ids[0]}', auth=AUTH)
series = r2.json()
instance_ids = series.get('Instances', [])

inst_id = instance_ids[0]
r3 = requests.get(f'{ORTHANC_URL}/instances/{inst_id}/tags', auth=AUTH)
tags = r3.json()

# Check OpticalPathSequence structure
optical_path = tags.get('0048,0105', {})
print("OpticalPathSequence (0048,0105):")
print(f"  Type: {optical_path.get('Type', 'N/A')}")
print(f"  Name: {optical_path.get('Name', 'N/A')}")

value = optical_path.get('Value', [])
print(f"  Value type: {type(value)}")
print(f"  Value length: {len(value) if isinstance(value, list) else 'N/A'}")

if isinstance(value, list) and len(value) > 0:
    item = value[0]
    print(f"\n  Item[0] type: {type(item)}")
    print(f"  Item[0] keys: {list(item.keys()) if isinstance(item, dict) else 'N/A'}")
    
    if isinstance(item, dict):
        # Look for ICC Profile in different locations
        icc_tag = item.get('0028,2000', {})
        print(f"\n  ICC Profile tag (0028,2000) in item:")
        print(f"    Present: {bool(icc_tag)}")
        if icc_tag:
            print(f"    Type: {icc_tag.get('Type', 'N/A')}")
            print(f"    Name: {icc_tag.get('Name', 'N/A')}")
            icc_value = icc_tag.get('Value', None)
            print(f"    Value type: {type(icc_value)}")
            if icc_value:
                if isinstance(icc_value, str):
                    print(f"    Value length (str): {len(icc_value)}")
                    print(f"    Value preview: {icc_value[:100]}...")
                elif isinstance(icc_value, list):
                    print(f"    Value length (list): {len(icc_value)}")
                elif isinstance(icc_value, bytes):
                    print(f"    Value length (bytes): {len(icc_value)}")
        
        # Print all keys in item
        print(f"\n  All tags in OpticalPathSequence item[0]:")
        for k, v in item.items():
            name = v.get('Name', 'Unknown') if isinstance(v, dict) else 'N/A'
            print(f"    {k}: {name}")

