#!/usr/bin/env python3
"""Check WSI structure in Orthanc"""

import requests
import sys

# Fix encoding
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

auth = ('admin', 'orthanc')
base_url = 'http://localhost:8042'

print("Searching for patient 20240917094737...")

# Get all patients
patients = requests.get(f'{base_url}/patients', auth=auth).json()

for patient_id in patients:
    patient_info = requests.get(f'{base_url}/patients/{patient_id}', auth=auth).json()
    patient_name = patient_info.get('MainDicomTags', {}).get('PatientName', '')
    
    if '20240917094737' in patient_name:
        print(f"\nFound Patient: {patient_name}")
        print(f"Patient Orthanc ID: {patient_id}")
        
        # Get studies
        studies = patient_info.get('Studies', [])
        print(f"Number of studies: {len(studies)}")
        
        for study_id in studies:
            study_info = requests.get(f'{base_url}/studies/{study_id}', auth=auth).json()
            study_date = study_info.get('MainDicomTags', {}).get('StudyDate', 'Unknown')
            print(f"\n  Study ID: {study_id}")
            print(f"  Study Date: {study_date}")
            
            # Get series
            series_list = study_info.get('Series', [])
            print(f"  Number of series: {len(series_list)}")
            
            for series_id in series_list:
                series_info = requests.get(f'{base_url}/series/{series_id}', auth=auth).json()
                series_desc = series_info.get('MainDicomTags', {}).get('SeriesDescription', 'No description')
                modality = series_info.get('MainDicomTags', {}).get('Modality', 'Unknown')
                
                print(f"\n    Series ID: {series_id}")
                print(f"    Series Description: {series_desc}")
                print(f"    Modality: {modality}")
                
                # Get instances
                instances = series_info.get('Instances', [])
                print(f"    Number of instances: {len(instances)}")
                
                # Check a few instances for details
                for i, instance_id in enumerate(instances[:3]):
                    instance_info = requests.get(f'{base_url}/instances/{instance_id}/tags', auth=auth).json()
                    
                    rows = instance_info.get('0028,0010', {}).get('Value', ['Unknown'])[0]
                    cols = instance_info.get('0028,0011', {}).get('Value', ['Unknown'])[0]
                    instance_num = instance_info.get('0020,0013', {}).get('Value', ['Unknown'])[0]
                    
                    print(f"      Instance {i+1}: {cols}x{rows} (Instance Number: {instance_num})")
                
                if len(instances) > 3:
                    print(f"      ... and {len(instances) - 3} more instances")

# Also check if WSI plugin is properly loaded
print("\n\nChecking Orthanc plugins...")
system_info = requests.get(f'{base_url}/system', auth=auth).json()
plugins = system_info.get('Plugins', [])
print(f"Loaded plugins: {plugins}")

# Check if WSI viewer routes are available
print("\nChecking WSI viewer routes...")
try:
    # Check if the WSI viewer endpoint exists
    response = requests.get(f'{base_url}/wsi/app/index.html', auth=auth)
    print(f"WSI viewer endpoint status: {response.status_code}")
except Exception as e:
    print(f"Error accessing WSI viewer: {e}")

# Check DICOMweb endpoints
print("\nChecking DICOMweb endpoints...")
try:
    response = requests.get(f'{base_url}/dicom-web/studies', auth=auth)
    print(f"DICOMweb studies endpoint status: {response.status_code}")
except Exception as e:
    print(f"Error accessing DICOMweb: {e}")
