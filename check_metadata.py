#!/usr/bin/env python3
"""Check DICOM metadata for source format tracking"""
import requests
import sys

if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

auth = ('admin', 'orthanc')

# Get latest studies
r = requests.get('http://localhost:8042/studies?expand', auth=auth)
studies = r.json()

print("=" * 70)
print("DICOM Metadata - Source Format Tracking")
print("=" * 70)

print(f"Total studies: {len(studies)}\n")

for study in studies:  # Check all studies
    study_id = study['ID']
    patient = study.get('PatientMainDicomTags', {}).get('PatientName', '(unnamed)')
    
    print(f"\nStudy: {patient}")
    print(f"  ID: {study_id[:20]}...")
    
    # Get first series
    series_list = study.get('Series', [])
    if not series_list:
        print("  No series found")
        continue
    
    series_id = series_list[0]
    
    # Get first instance
    series_r = requests.get(f'http://localhost:8042/series/{series_id}', auth=auth)
    series_data = series_r.json()
    instances = series_data.get('Instances', [])
    
    if not instances:
        print("  No instances found")
        continue
    
    instance_id = instances[0]
    
    # Get instance tags
    tags_r = requests.get(f'http://localhost:8042/instances/{instance_id}/simplified-tags', auth=auth)
    tags = tags_r.json()
    
    # Print relevant metadata
    print(f"  Manufacturer: {tags.get('Manufacturer', 'NOT SET')}")
    print(f"  Model: {tags.get('ManufacturerModelName', 'NOT SET')}")
    print(f"  Software: {tags.get('SoftwareVersions', 'NOT SET')}")
    print(f"  Institution: {tags.get('InstitutionName', 'NOT SET')}")
    print(f"  Series Desc: {tags.get('SeriesDescription', 'NOT SET')}")

print("\n" + "=" * 70)

