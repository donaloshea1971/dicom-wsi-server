#!/usr/bin/env python3
"""Check the actual levels in the iSyntax file"""

from pathlib import Path

# Try different approaches to check iSyntax levels
print("Checking iSyntax file structure...\n")

file_path = Path("testdata/isyntax/testslide.isyntax")
if not file_path.exists():
    print(f"File not found: {file_path}")
    exit(1)

print(f"File: {file_path}")
print(f"Size: {file_path.stat().st_size / (1024*1024):.1f} MB")

# Method 1: Try using isyntax module directly
try:
    from isyntax import ISyntax
    print("\n1. Using isyntax module:")
    
    with ISyntax.open(str(file_path)) as isyntax:
        print(f"   Dimensions: {isyntax.dimensions}")
        print(f"   Level count: {isyntax.level_count}")
        
        # Check each level
        for i in range(isyntax.level_count):
            level = isyntax.wsi.get_level(i)
            print(f"   Level {i}: {level.width}x{level.height}")
            
except Exception as e:
    print(f"   Error: {e}")

# Method 2: Try using wsidicomizer
try:
    from wsidicomizer import WsiDicomizer
    print("\n2. Using wsidicomizer:")
    
    with WsiDicomizer.open(str(file_path)) as wsi:
        print(f"   Size: {wsi.size.width}x{wsi.size.height}")
        
        if hasattr(wsi, 'levels'):
            print(f"   Number of levels: {len(wsi.levels)}")
            for i, level in enumerate(wsi.levels):
                print(f"   Level {i}: {level.size.width}x{level.size.height}")
        else:
            print("   No 'levels' attribute found")
            
        # Check internal source
        if hasattr(wsi, '_source'):
            print(f"   Source type: {type(wsi._source)}")
            if hasattr(wsi._source, 'level_count'):
                print(f"   Source level count: {wsi._source.level_count}")
                
except Exception as e:
    print(f"   Error: {e}")
    import traceback
    traceback.print_exc()

# Method 3: Check if it's a multi-frame iSyntax
print("\n3. File format check:")
with open(file_path, 'rb') as f:
    # Read first few bytes to check format
    header = f.read(16)
    print(f"   Header: {header.hex()}")
    
    # iSyntax files often start with specific signatures
    if header.startswith(b'ISYNTAX'):
        print("   Detected: iSyntax format")
    elif header.startswith(b'\x00\x00\x00\x0C'):
        print("   Detected: Possible iSyntax/JPEG2000 format")
