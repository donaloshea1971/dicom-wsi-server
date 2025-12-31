#!/usr/bin/env python3
"""Check for ICC color profile in DICOM WSI files"""
import requests
import sys

if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

ORTHANC_URL = "http://localhost:8042"
AUTH = ('admin', 'orthanc')

def check_icc_profile(study_id):
    """Check for ICC profile in a study"""
    print(f"\nChecking study: {study_id}")
    print("=" * 60)
    
    # Get study info
    r = requests.get(f'{ORTHANC_URL}/studies/{study_id}', auth=AUTH)
    study = r.json()
    patient = study.get('PatientMainDicomTags', {}).get('PatientName', 'Unknown')
    print(f"Patient: {patient}")
    
    series_ids = study.get('Series', [])
    if not series_ids:
        print("No series found")
        return
    
    r2 = requests.get(f'{ORTHANC_URL}/series/{series_ids[0]}', auth=AUTH)
    series = r2.json()
    instance_ids = series.get('Instances', [])
    
    if not instance_ids:
        print("No instances found")
        return
    
    inst_id = instance_ids[0]
    
    # Get ALL tags
    r3 = requests.get(f'{ORTHANC_URL}/instances/{inst_id}/tags', auth=AUTH)
    tags = r3.json()
    
    # Key color-related tags
    photometric = tags.get('0028,0004', {}).get('Value', 'N/A')
    samples = tags.get('0028,0002', {}).get('Value', 'N/A')
    bits_stored = tags.get('0028,0101', {}).get('Value', 'N/A')
    
    print(f"\nBasic Color Info:")
    print(f"  PhotometricInterpretation: {photometric}")
    print(f"  SamplesPerPixel: {samples}")
    print(f"  BitsStored: {bits_stored}")
    
    # Check for ICC Profile (0028,2000)
    icc_tag = tags.get('0028,2000', None)
    print(f"\nICC Profile (0028,2000):")
    if icc_tag:
        value = icc_tag.get('Value', '')
        if isinstance(value, str):
            print(f"  ✓ Present - {len(value)} bytes (base64)")
        elif isinstance(value, list):
            print(f"  ✓ Present - {len(value)} entries")
        else:
            print(f"  ✓ Present - type: {type(value)}")
    else:
        print("  ✗ Not found")
    
    # Check OpticalPathSequence (0048,0105) - may contain ICC
    optical_path = tags.get('0048,0105', None)
    print(f"\nOpticalPathSequence (0048,0105):")
    if optical_path:
        print("  ✓ Present")
        # Check for nested ICC profile
        value = optical_path.get('Value', [])
        if isinstance(value, list) and len(value) > 0:
            for i, item in enumerate(value):
                if isinstance(item, dict):
                    # Check for ICCProfile in OpticalPathSequence
                    nested_icc = item.get('0028,2000', None)
                    if nested_icc:
                        print(f"    Item {i}: Contains ICC Profile")
                    illumination = item.get('0022,0016', {}).get('Value', 'N/A')
                    if illumination != 'N/A':
                        print(f"    Item {i}: IlluminationTypeCodeSequence present")
    else:
        print("  ✗ Not found")
    
    # Search for any ICC or color related tags
    print(f"\nAll Color-Related Tags:")
    color_keywords = ['icc', 'color', 'optical', 'profile', 'illumin', 'gamma', 'palette']
    found_any = False
    for tag_id, tag_data in tags.items():
        name = tag_data.get('Name', '').lower()
        if any(kw in name for kw in color_keywords):
            found_any = True
            print(f"  {tag_id}: {tag_data.get('Name', '')}")
    if not found_any:
        print("  (none found)")


def main():
    # Check Sierra specifically
    sierra_id = '52391c74-f5a241d4-dbf7ae3c-93247a93-53c02305'
    check_icc_profile(sierra_id)
    
    # Also check a couple other studies for comparison
    print("\n" + "=" * 60)
    print("COMPARISON WITH OTHER STUDIES:")
    
    # Get all studies
    r = requests.get(f'{ORTHANC_URL}/studies', auth=AUTH)
    studies = r.json()[:5]  # Check first 5
    
    for study_id in studies:
        if study_id != sierra_id:
            check_icc_profile(study_id)


if __name__ == "__main__":
    main()

