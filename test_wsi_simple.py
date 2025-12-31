#!/usr/bin/env python3
import wsidicomizer
from wsidicomizer import WsiDicomizer

print("wsidicomizer version:", getattr(wsidicomizer, '__version__', 'Unknown'))

wsi = WsiDicomizer.open('/app/testdata/isyntax/testslide.isyntax')
print("Source type:", type(wsi._source))
print("Has levels:", hasattr(wsi, 'levels'))
print("Number of levels:", len(wsi.levels) if hasattr(wsi, 'levels') else 0)

if hasattr(wsi, 'levels'):
    for i, level in enumerate(wsi.levels[:3]):
        print(f"Level {i}: {level.size.width}x{level.size.height}")

wsi.close()
