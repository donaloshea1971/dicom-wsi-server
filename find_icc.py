#!/usr/bin/env python3
"""Find any study with actual ICC profile data"""
import requests
import sys

if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

ORTHANC_URL = "http://localhost:8042"
AUTH = ('admin', 'orthanc')

def check_study_icc(study_id):
    """Check if a study has actual ICC profile data"""
    r = requests.get(f'{ORTHANC_URL}/studies/{study_id}', auth=AUTH)
    study = r.json()
    patient = study.get('PatientMainDicomTags', {}).get('PatientName', 'Unknown')
    
    series_ids = study.get('Series', [])
    if not series_ids:
        return patient, None, "No series"
    
    r2 = requests.get(f'{ORTHANC_URL}/series/{series_ids[0]}', auth=AUTH)
    series = r2.json()
    instance_ids = series.get('Instances', [])
    
    if not instance_ids:
        return patient, None, "No instances"
    
    inst_id = instance_ids[0]
    r3 = requests.get(f'{ORTHANC_URL}/instances/{inst_id}/tags', auth=AUTH)
    tags = r3.json()
    
    # Check top-level ICC Profile
    top_icc = tags.get('0028,2000', {})
    if top_icc.get('Value'):
        return patient, "top-level", f"Has data: {type(top_icc.get('Value'))}"
    
    # Check OpticalPathSequence
    optical_path = tags.get('0048,0105', {}).get('Value', [])
    if optical_path and isinstance(optical_path, list):
        for i, item in enumerate(optical_path):
            if isinstance(item, dict):
                icc = item.get('0028,2000', {})
                icc_type = icc.get('Type', 'N/A')
                icc_value = icc.get('Value')
                if icc_value is not None:
                    return patient, f"OpticalPath[{i}]", f"Has data: {type(icc_value)}, len={len(icc_value) if hasattr(icc_value, '__len__') else 'N/A'}"
                elif icc_type != 'N/A':
                    return patient, f"OpticalPath[{i}]", f"Empty (Type={icc_type})"
    
    return patient, None, "No ICC"


# Get all studies
r = requests.get(f'{ORTHANC_URL}/studies', auth=AUTH)
studies = r.json()

print("ICC Profile Status for All Studies:")
print("=" * 70)

has_icc = []
no_icc = []

for study_id in studies:
    patient, location, status = check_study_icc(study_id)
    if "Has data" in status:
        has_icc.append((patient, location, status))
        print(f"✓ {patient[:35]:<35} | {location} | {status}")
    else:
        no_icc.append((patient, location, status))

print(f"\n{'=' * 70}")
print(f"Summary: {len(has_icc)} with ICC data, {len(no_icc)} without")

if not has_icc:
    print("\nNo studies have embedded ICC profile data.")
    print("All have empty ICC Profile tags (placeholders only).")
    print("\nThis is common - many scanners don't embed ICC profiles.")
    print("The viewer should fall back to sRGB assumptions.")

