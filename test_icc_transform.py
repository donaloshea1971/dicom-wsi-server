#!/usr/bin/env python
"""Test ICC transform endpoint"""
import sys
sys.stdout.reconfigure(encoding='utf-8')

import requests
import json

ORTHANC_URL = "http://localhost:8042"
VIEWER_URL = "http://localhost:3000"

# Find Sierra study (Adobe RGB profile)
studies = requests.get(f"{ORTHANC_URL}/studies", auth=('admin', 'orthanc')).json()
sierra_id = None

for sid in studies:
    details = requests.get(f"{ORTHANC_URL}/studies/{sid}", auth=('admin', 'orthanc')).json()
    name = details.get('PatientMainDicomTags', {}).get('PatientName', '')
    if 'PathQA' in name or 'Sierra' in name:
        sierra_id = sid
        print(f"Found Sierra study: {name}")
        break

if not sierra_id:
    print("Sierra study not found. Using first study.")
    sierra_id = studies[0]

# Test ICC transform endpoint
res = requests.get(f"{VIEWER_URL}/api/studies/{sierra_id}/icc-profile?include_transform=true")
data = res.json()

print("\n" + "="*60)
print("ICC Profile Transform Data:")
print("="*60)
print(json.dumps(data, indent=2, default=str))

