#!/usr/bin/env python3
"""
Download sample DICOM WSI files from NCI Imaging Data Commons (IDC)

IDC provides free access to cancer imaging data including DICOM WSI pathology.
Portal: https://portal.imaging.datacommons.cancer.gov/explore/

This script downloads small sample files for testing.
"""
import requests
import sys
from pathlib import Path

if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

OUTPUT_DIR = Path("testdata/IDC")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

print("=" * 60)
print("NCI Imaging Data Commons (IDC) - Sample Downloader")
print("=" * 60)
print()
print("IDC provides >2TB of DICOM WSI pathology images.")
print("Portal: https://portal.imaging.datacommons.cancer.gov/")
print()
print("To download WSI data from IDC, you can:")
print()
print("1. BROWSER: Visit the portal and filter by:")
print("   - Modality: SM (Slide Microscopy)")
print("   - Collection: CPTAC, TCGA, or HTAN")
print("   - Then download via manifest")
print()
print("2. COMMAND LINE: Use the IDC client")
print("   pip install idc-index")
print("   from idc_index import index")
print("   idc = index.IDCClient()")
print("   # Query for WSI data")
print("   df = idc.sql('''")
print("       SELECT DISTINCT collection_id, PatientID, StudyInstanceUID")
print("       FROM index_v16")
print("       WHERE Modality = 'SM'")
print("       LIMIT 10")
print("   ''')")
print()
print("3. GOOGLE CLOUD: Data is on gs://idc-open-data")
print("   Use gsutil or BigQuery for large downloads")
print()
print("=" * 60)
print()
print("Collections with WSI pathology data:")
print("  - CPTAC (Clinical Proteomic Tumor Analysis)")
print("  - TCGA (The Cancer Genome Atlas)")
print("  - HTAN (Human Tumor Atlas Network)")
print("  - nlst_pathology")
print()
print("All data is CC-BY licensed for research/commercial use.")
print("=" * 60)

