#!/usr/bin/env python3
"""Test wsidicomizer's iSyntax support inside Docker"""

# This script will be run inside the converter container
import sys
from pathlib import Path

print("Testing wsidicomizer iSyntax support...\n")

try:
    from wsidicomizer import WsiDicomizer
    from wsidicomizer.sources import ISyntaxSource
    import isyntax
    
    file_path = "/app/testdata/isyntax/testslide.isyntax"
    
    print(f"1. Testing direct wsidicomizer.open():")
    try:
        with WsiDicomizer.open(file_path) as wsi:
            print(f"   Size: {wsi.size.width}x{wsi.size.height}")
            print(f"   Levels: {len(wsi.levels) if hasattr(wsi, 'levels') else 'No levels attribute'}")
            
            if hasattr(wsi, '_source'):
                print(f"   Source type: {type(wsi._source).__name__}")
                
            if hasattr(wsi, 'levels'):
                for i, level in enumerate(wsi.levels[:3]):  # First 3 levels
                    print(f"   Level {i}: {level.size.width}x{level.size.height}")
    except Exception as e:
        print(f"   Error: {e}")
        import traceback
        traceback.print_exc()
    
    print(f"\n2. Testing ISyntaxSource directly:")
    try:
        # Try to use ISyntaxSource directly
        source = ISyntaxSource(file_path)
        print(f"   Created ISyntaxSource")
        print(f"   Levels: {len(source.levels) if hasattr(source, 'levels') else 'No levels'}")
        
        # Try to create WsiDicomizer with the source
        with WsiDicomizer(source) as wsi:
            print(f"   WsiDicomizer created")
            print(f"   Size: {wsi.size.width}x{wsi.size.height}")
            print(f"   Levels: {len(wsi.levels) if hasattr(wsi, 'levels') else 'No levels'}")
    except Exception as e:
        print(f"   Error: {e}")
        import traceback
        traceback.print_exc()
    
    print(f"\n3. Checking wsidicomizer version and sources:")
    import wsidicomizer
    print(f"   wsidicomizer version: {wsidicomizer.__version__ if hasattr(wsidicomizer, '__version__') else 'Unknown'}")
    
    # List available sources
    from wsidicomizer import sources
    print(f"   Available sources: {dir(sources)}")
    
except ImportError as e:
    print(f"Import error: {e}")
    sys.exit(1)
