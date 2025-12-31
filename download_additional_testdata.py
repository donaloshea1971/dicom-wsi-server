#!/usr/bin/env python3
"""
Download additional WSI test data from OpenSlide

This script downloads sample files from various scanner vendors
that can be converted to DICOM using our converter service.
"""
import requests
import sys
from pathlib import Path

if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

BASE_URL = "https://openslide.cs.cmu.edu/download/openslide-testdata/"
OUTPUT_DIR = Path("testdata")

# Additional files to download (smaller representative samples)
DOWNLOADS = {
    # Aperio SVS - additional samples
    "Aperio": [
        "CMU-2.svs",      # ~200MB
        # "CMU-1.svs",    # Large - skip for now
    ],
    # Hamamatsu NDPI - additional samples  
    "Hamamatsu": [
        "OS-1.ndpi",      # Smaller sample
        "OS-2.ndpi",
    ],
    # Ventana BIF
    "Ventana": [
        "OS-1.bif",
        "OS-2.bif", 
    ],
    # Leica SCN
    "Leica": [
        "Leica-1.scn",
    ],
}

def download_file(url, dest_path):
    """Download a file with progress indicator"""
    print(f"  Downloading: {url.split('/')[-1]}...")
    
    response = requests.get(url, stream=True)
    if response.status_code != 200:
        print(f"    ✗ Failed: HTTP {response.status_code}")
        return False
    
    total_size = int(response.headers.get('content-length', 0))
    downloaded = 0
    
    with open(dest_path, 'wb') as f:
        for chunk in response.iter_content(chunk_size=8192):
            f.write(chunk)
            downloaded += len(chunk)
            if total_size:
                pct = downloaded * 100 // total_size
                print(f"\r    Progress: {pct}% ({downloaded/1024/1024:.1f} MB)", end='', flush=True)
    
    print(f"\r    ✓ Downloaded: {downloaded/1024/1024:.1f} MB          ")
    return True

def main():
    print("=" * 60)
    print("OpenSlide Additional Test Data Downloader")
    print("=" * 60)
    print(f"\nFiles will be saved to: {OUTPUT_DIR.absolute()}")
    
    total_downloaded = 0
    
    for vendor, files in DOWNLOADS.items():
        vendor_dir = OUTPUT_DIR / vendor
        vendor_dir.mkdir(parents=True, exist_ok=True)
        
        print(f"\n{vendor}:")
        print("-" * 40)
        
        for filename in files:
            dest_path = vendor_dir / filename
            
            if dest_path.exists():
                print(f"  ⏭ Skipping (exists): {filename}")
                continue
            
            url = f"{BASE_URL}{vendor}/{filename}"
            if download_file(url, dest_path):
                total_downloaded += 1
    
    print("\n" + "=" * 60)
    print(f"Downloaded {total_downloaded} new files")
    print("\nTo convert and upload, use:")
    print("  POST http://localhost:8000/upload with the file")
    print("=" * 60)

if __name__ == "__main__":
    main()

