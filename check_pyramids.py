#!/usr/bin/env python3
"""Check pyramid levels for all studies"""
import requests
import sys

if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

auth = ('admin', 'orthanc')

r = requests.get('http://localhost:8042/studies?expand', auth=auth)
studies = r.json()

print("=" * 80)
print("WSI Pyramid Summary")
print("=" * 80)

for s in studies:
    patient = s.get('PatientMainDicomTags', {}).get('PatientName', '(converted)')
    study_id = s['ID']
    series_list = s.get('Series', [])
    
    print(f"\n{patient}")
    print(f"  Study: {study_id}")
    
    for series_id in series_list:
        wsi = requests.get(f'http://localhost:8042/wsi/pyramids/{series_id}', auth=auth)
        if wsi.status_code == 200:
            p = wsi.json()
            levels = len(p.get('Resolutions', []))
            width = p.get('TotalWidth', 0)
            height = p.get('TotalHeight', 0)
            print(f"  ✓ Pyramid: {levels} levels, {width}x{height}")
        else:
            print(f"  ✗ No pyramid (status {wsi.status_code})")

print("\n" + "=" * 80)

