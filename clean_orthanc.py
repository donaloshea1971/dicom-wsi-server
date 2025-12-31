#!/usr/bin/env python3
"""Clean all studies from Orthanc database"""

import sys
import requests
import time

# Fix encoding
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

ORTHANC_URL = "http://localhost:8042"
ORTHANC_AUTH = ("admin", "orthanc")

def clean_orthanc():
    """Delete all studies from Orthanc"""
    print("Cleaning Orthanc database...")
    
    # Get all studies
    response = requests.get(f"{ORTHANC_URL}/studies", auth=ORTHANC_AUTH)
    studies = response.json()
    
    print(f"Found {len(studies)} studies to delete")
    
    # Delete each study
    for study_id in studies:
        print(f"Deleting study {study_id}...")
        try:
            response = requests.delete(f"{ORTHANC_URL}/studies/{study_id}", auth=ORTHANC_AUTH)
            if response.status_code == 200:
                print(f"  ✓ Deleted")
            else:
                print(f"  ✗ Failed: {response.status_code}")
        except Exception as e:
            print(f"  ✗ Error: {e}")
    
    # Wait a moment for cleanup
    time.sleep(2)
    
    # Verify
    response = requests.get(f"{ORTHANC_URL}/statistics", auth=ORTHANC_AUTH)
    stats = response.json()
    
    print("\nFinal statistics:")
    print(f"  Studies: {stats.get('CountStudies', 0)}")
    print(f"  Series: {stats.get('CountSeries', 0)}")
    print(f"  Instances: {stats.get('CountInstances', 0)}")
    
    if stats.get('CountStudies', 0) == 0:
        print("\n✓ Database cleaned successfully!")
    else:
        print("\n✗ Some studies remain")

if __name__ == "__main__":
    clean_orthanc()
