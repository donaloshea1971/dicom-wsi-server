#!/usr/bin/env python3
"""
Download comprehensive WSI test data based on the 20-file validation list.
Focuses on files we don't already have.
"""
import requests
import sys
from pathlib import Path

if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

BASE_URL = "https://openslide.cs.cmu.edu/download/openslide-testdata/"
OUTPUT_DIR = Path("testdata")

# Files we already have (skip these)
ALREADY_HAVE = [
    "CMU-1-Small-Region.svs",  # testdata/
    "CMU-1.ndpi",               # testdata/
    "Leica-1.scn",              # testdata/Leica/
    "CMU-2.svs",                # testdata/Aperio/
    "OS-1.ndpi", "OS-2.ndpi",   # testdata/Hamamatsu/
    "OS-1.bif", "OS-2.bif",     # testdata/Ventana/
    "testslide.isyntax",        # testdata/isyntax/
]

# Additional files to download (prioritized by usefulness)
DOWNLOADS = {
    # Priority 1: Core formats we're missing
    "Aperio": {
        "files": ["CMU-1.svs"],  # Full version, 550MB
        "priority": 1,
        "description": "Full Aperio JPEG2000 reference"
    },
    
    # Priority 2: Additional vendor formats
    "Hamamatsu-vms": {
        "files": [],  # Skip - multi-file format, complex
        "priority": 3,
        "description": "Hamamatsu VMS (multi-file)"
    },
    
    "Mirax": {
        "files": ["CMU-1.zip"],  # 3DHISTECH MIRAX
        "priority": 2,
        "description": "3DHISTECH MIRAX format"
    },
    
    "Zeiss": {
        "files": [],  # Often requires special handling
        "priority": 3,
        "description": "Zeiss ZVI format"
    },
    
    "Olympus": {
        "files": [],  # Complex multi-file
        "priority": 3,
        "description": "Olympus VSI format"
    },
    
    "Generic-TIFF": {
        "files": [],  # Very large (2.5GB), skip for now
        "priority": 4,
        "description": "Generic TIFF (very large)"
    },
}

def get_file_size_mb(url):
    """Get file size from HEAD request"""
    try:
        r = requests.head(url, timeout=10)
        size = int(r.headers.get('content-length', 0))
        return size / (1024 * 1024)
    except:
        return 0

def download_file(url, dest_path):
    """Download file with progress"""
    print(f"  Downloading: {url.split('/')[-1]}")
    
    response = requests.get(url, stream=True, timeout=600)
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
                mb = downloaded / (1024*1024)
                print(f"\r    Progress: {pct}% ({mb:.1f} MB)", end='', flush=True)
    
    print(f"\r    ✓ Complete: {downloaded/(1024*1024):.1f} MB          ")
    return True

def main():
    print("=" * 70)
    print("Comprehensive WSI Test Data Downloader")
    print("=" * 70)
    
    # Show what we already have
    print("\n✅ Already downloaded:")
    for f in ALREADY_HAVE:
        print(f"   - {f}")
    
    print("\n📥 Files to download:")
    print("-" * 70)
    
    total_to_download = 0
    download_list = []
    
    for vendor, config in DOWNLOADS.items():
        if config["files"] and config["priority"] <= 2:
            vendor_dir = OUTPUT_DIR / vendor
            vendor_dir.mkdir(parents=True, exist_ok=True)
            
            for filename in config["files"]:
                dest = vendor_dir / filename
                if dest.exists():
                    print(f"   ⏭ {vendor}/{filename} (exists)")
                    continue
                
                url = f"{BASE_URL}{vendor}/{filename}"
                size_mb = get_file_size_mb(url)
                print(f"   📁 {vendor}/{filename} ({size_mb:.0f} MB) - {config['description']}")
                total_to_download += size_mb
                download_list.append((url, dest, vendor, filename))
    
    if not download_list:
        print("\n✅ All priority files already downloaded!")
        return
    
    print(f"\n📊 Total to download: {total_to_download:.0f} MB")
    print("-" * 70)
    
    # Ask for confirmation
    response = input("\nProceed with download? (y/n): ").strip().lower()
    if response != 'y':
        print("Download cancelled.")
        return
    
    # Download files
    print("\n📥 Downloading...")
    for url, dest, vendor, filename in download_list:
        print(f"\n{vendor}/{filename}:")
        download_file(url, dest)
    
    print("\n" + "=" * 70)
    print("✅ Download complete!")
    print("=" * 70)

if __name__ == "__main__":
    main()

