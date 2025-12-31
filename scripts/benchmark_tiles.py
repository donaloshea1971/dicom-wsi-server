#!/usr/bin/env python3
"""
Tile Serving Benchmark Script for Windows/Cross-platform
Usage: python benchmark_tiles.py [BASE_URL]
"""
import requests
import time
import concurrent.futures
import statistics
import sys
from urllib.parse import urljoin

BASE_URL = sys.argv[1] if len(sys.argv) > 1 else "http://144.126.203.208:8042"
AUTH = ("admin", "orthanc")

def fetch_tile(url):
    """Fetch a single tile and return response time"""
    start = time.perf_counter()
    try:
        r = requests.get(url, auth=AUTH, timeout=30)
        elapsed = time.perf_counter() - start
        return elapsed if r.status_code == 200 else None
    except:
        return None

def main():
    print("=" * 50)
    print("  Orthanc WSI Tile Benchmark")
    print("=" * 50)
    print(f"Base URL: {BASE_URL}\n")
    
    # Get first study
    try:
        studies = requests.get(f"{BASE_URL}/studies", auth=AUTH, timeout=10).json()
        if not studies:
            print("No studies found!")
            return
        study_id = studies[0]
        print(f"Using study: {study_id}")
        
        # Get series
        study_info = requests.get(f"{BASE_URL}/studies/{study_id}", auth=AUTH, timeout=10).json()
        series_id = study_info["Series"][0]
        print(f"Using series: {series_id}\n")
    except Exception as e:
        print(f"Error fetching study info: {e}")
        return
    
    # Build tile URL
    tile_base = f"{BASE_URL}/wsi/pyramids/{series_id}"
    
    # === Test 1: Single Tile Latency ===
    print("=== 1. Single Tile Latency (10 requests) ===")
    latencies = []
    for i in range(10):
        url = f"{tile_base}/0/0/0"
        elapsed = fetch_tile(url)
        if elapsed:
            latencies.append(elapsed)
            print(f"  Request {i+1}: {elapsed*1000:.1f}ms")
    
    if latencies:
        print(f"  Average: {statistics.mean(latencies)*1000:.1f}ms")
        print(f"  Median:  {statistics.median(latencies)*1000:.1f}ms")
        print(f"  Min:     {min(latencies)*1000:.1f}ms")
        print(f"  Max:     {max(latencies)*1000:.1f}ms")
    print()
    
    # === Test 2: Concurrent Throughput ===
    print("=== 2. Concurrent Tile Throughput ===")
    print("  Fetching 50 tiles with 10 parallel connections...")
    
    urls = [f"{tile_base}/0/{i%8}/{i%8}" for i in range(50)]
    
    start = time.perf_counter()
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
        results = list(executor.map(fetch_tile, urls))
    elapsed = time.perf_counter() - start
    
    successful = [r for r in results if r is not None]
    print(f"  Time: {elapsed:.2f}s for {len(successful)}/{len(urls)} tiles")
    print(f"  Rate: {len(successful)/elapsed:.1f} tiles/sec")
    print()
    
    # === Test 3: Pyramid Level Scan ===
    print("=== 3. Pyramid Level Scan ===")
    for level in range(4):
        urls = [f"{tile_base}/{level}/{x}/{y}" for x in range(4) for y in range(4)]
        start = time.perf_counter()
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
            results = list(executor.map(fetch_tile, urls))
        elapsed = time.perf_counter() - start
        successful = sum(1 for r in results if r is not None)
        print(f"  Level {level} ({successful}/16 tiles): {elapsed:.2f}s")
    print()
    
    # === Test 4: System Statistics ===
    print("=== 4. System Statistics ===")
    try:
        stats = requests.get(f"{BASE_URL}/statistics", auth=AUTH, timeout=10).json()
        print(f"  Studies:   {stats.get('CountStudies', 'N/A')}")
        print(f"  Series:    {stats.get('CountSeries', 'N/A')}")
        print(f"  Instances: {stats.get('CountInstances', 'N/A')}")
        disk_gb = int(stats.get('TotalDiskSize', 0)) / (1024**3)
        print(f"  Disk Size: {disk_gb:.2f} GB")
    except Exception as e:
        print(f"  Error: {e}")
    
    print("\nBenchmark complete!")

if __name__ == "__main__":
    main()
