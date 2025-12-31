#!/usr/bin/env python3
"""Check NDPI image metadata"""
import requests
import sys

if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

auth = ('admin', 'orthanc')

# Get the NDPI study (f51940d9)
r = requests.get('http://localhost:8042/studies/f51940d9-6a8ac82a-4e728219-83a73e84-4f8cdcb5', auth=auth)
study = r.json()
series_id = study['Series'][0]

# Get first instance
r2 = requests.get(f'http://localhost:8042/series/{series_id}', auth=auth)
series = r2.json()
instance_id = series['Instances'][0]

# Get simplified tags
r3 = requests.get(f'http://localhost:8042/instances/{instance_id}/simplified-tags', auth=auth)
tags = r3.json()

print("NDPI Image Metadata:")
print("=" * 50)

# Print relevant tags
important_tags = [
    'Manufacturer', 'ManufacturerModelName', 'SoftwareVersions', 
    'DeviceSerialNumber', 'ImageType', 'PhotometricInterpretation',
    'BitsAllocated', 'BitsStored', 'HighBit', 'SamplesPerPixel',
    'PlanarConfiguration', 'PixelRepresentation'
]

for key in important_tags:
    value = tags.get(key, 'N/A')
    print(f'{key}: {value}')

print("\n" + "=" * 50)
print("All tags containing 'gamma' or 'color':")
for key, value in tags.items():
    if 'gamma' in key.lower() or 'color' in key.lower():
        print(f'{key}: {value}')

