#!/usr/bin/env python3
"""Check ICC profiles for all studies via the new API endpoint"""
import requests
import sys

if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

r = requests.get('http://localhost:8042/studies', auth=('admin','orthanc'))
studies = r.json()

print('ICC Profile Check - All Studies:')
print('=' * 70)

has_icc_count = 0
no_icc_count = 0

for study_id in studies:
    # Get patient name
    sr = requests.get(f'http://localhost:8042/studies/{study_id}', auth=('admin','orthanc'))
    patient = sr.json().get('PatientMainDicomTags', {}).get('PatientName', 'Unknown')
    
    # Check ICC
    icc_r = requests.get(f'http://localhost:8000/studies/{study_id}/icc-profile')
    if icc_r.status_code == 200:
        data = icc_r.json()
        has_icc = data.get('has_icc', False)
        
        if has_icc:
            size = data.get('size_bytes', 0)
            info = data.get('profile_info', {})
            color_space = info.get('color_space', '?')
            cmm = info.get('preferred_cmm', '?')
            print(f"✓ {patient[:40]:<40} | {size:>8,} bytes | {color_space} | {cmm}")
            has_icc_count += 1
        else:
            print(f"✗ {patient[:40]:<40} | No ICC profile")
            no_icc_count += 1
    else:
        print(f"? {patient[:40]:<40} | Error: {icc_r.status_code}")
        no_icc_count += 1

print('=' * 70)
print(f"Summary: {has_icc_count} with ICC, {no_icc_count} without")

