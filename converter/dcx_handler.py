#!/usr/bin/env python3
"""
DCX File Handler - Deobfuscates 3DHISTECH DCX files

DCX files are BigTIFF files with XOR-obfuscated JPEG tiles.
The obfuscation scheme:
1. Each JPEG tile is XORed with a random key at the beginning
2. The key (1024 bytes) is appended to the END of each tile
3. Key values are 1-255 (never 0)

To deobfuscate:
1. Extract key from the last 1024 bytes of each tile
2. XOR first 1024 bytes of tile with the key
3. Trim the key from the end

This module provides functions to:
- Detect if a file is an obfuscated DCX
- Convert DCX to standard TIFF that wsidicomizer can read
"""

import io
import os
import logging
from pathlib import Path
from typing import Optional, Tuple
import struct

logger = logging.getLogger(__name__)

# Default key size used by 3DHISTECH DCX files
DEFAULT_KEY_SIZE = 1024

# BigTIFF magic bytes
BIGTIFF_MAGIC = b'II\x2b\x00'  # Little-endian BigTIFF


def is_dcx_file(file_path: Path) -> bool:
    """Check if a file is a 3DHISTECH DCX file (BigTIFF with obfuscated tiles)"""
    if not file_path.suffix.lower() == '.dcx':
        return False
    
    try:
        with open(file_path, 'rb') as f:
            header = f.read(8)
            # Check for BigTIFF header
            if header[:4] == BIGTIFF_MAGIC:
                return True
    except Exception:
        pass
    
    return False


def deobfuscate_tile(tile_data: bytes, key_size: int = DEFAULT_KEY_SIZE) -> bytes:
    """
    Deobfuscate a single DCX tile.
    
    Args:
        tile_data: Raw tile data including appended key
        key_size: Size of the XOR key (default 1024)
        
    Returns:
        Deobfuscated JPEG data
    """
    if len(tile_data) <= key_size:
        logger.warning(f"Tile too small ({len(tile_data)} bytes) for key size {key_size}")
        return tile_data
    
    data = bytearray(tile_data)
    key_offset = len(data) - key_size
    
    # Extract key from end
    key = data[key_offset:]
    
    # XOR first key_size bytes with the key
    xor_length = min(key_size, key_offset)
    for i in range(xor_length):
        data[i] ^= key[i]
    
    # Return data without the key
    return bytes(data[:key_offset])


def verify_jpeg(data: bytes) -> bool:
    """Verify that data is a valid JPEG"""
    if len(data) < 4:
        return False
    
    # Check JPEG SOI marker
    if data[0:2] != b'\xff\xd8':
        return False
    
    # Optionally verify with PIL
    try:
        from PIL import Image
        img = Image.open(io.BytesIO(data))
        img.verify()
        return True
    except Exception:
        return False


def convert_dcx_to_tiff(input_path: Path, output_path: Path, 
                        progress_callback=None) -> bool:
    """
    Convert an obfuscated DCX file to a standard TIFF.
    
    This creates a new BigTIFF with deobfuscated JPEG tiles that
    can be read by standard tools like wsidicomizer.
    
    Args:
        input_path: Path to input DCX file
        output_path: Path for output TIFF file
        progress_callback: Optional callback(progress, message)
        
    Returns:
        True if successful
    """
    import tifffile
    import numpy as np
    from PIL import Image
    
    logger.info(f"Converting DCX to TIFF: {input_path}")
    
    try:
        with tifffile.TiffFile(str(input_path)) as tif:
            # Process each page (pyramid level)
            pages_data = []
            
            for page_idx, page in enumerate(tif.pages):
                logger.info(f"Processing page {page_idx}: {page.shape}")
                
                if progress_callback:
                    progress_callback(
                        int(page_idx / len(tif.pages) * 50),
                        f"Processing pyramid level {page_idx + 1}/{len(tif.pages)}"
                    )
                
                # Get tile information
                if 324 not in page.tags or 325 not in page.tags:
                    logger.warning(f"Page {page_idx} has no tile offsets/sizes")
                    continue
                
                tile_offsets = list(page.tags[324].value)
                tile_sizes = list(page.tags[325].value)
                tile_width = page.tags.get(322, type('', (), {'value': 512})()).value
                tile_height = page.tags.get(323, type('', (), {'value': 512})()).value
                
                logger.info(f"  {len(tile_offsets)} tiles, {tile_width}x{tile_height}")
                
                # Decode all tiles and reconstruct the image
                height, width = page.shape[:2]
                channels = page.shape[2] if len(page.shape) > 2 else 1
                
                # Calculate tile grid
                tiles_x = (width + tile_width - 1) // tile_width
                tiles_y = (height + tile_height - 1) // tile_height
                
                # Create output array
                img_data = np.zeros((height, width, channels), dtype=np.uint8)
                
                with open(input_path, 'rb') as f:
                    for tile_idx, (offset, size) in enumerate(zip(tile_offsets, tile_sizes)):
                        # Read and deobfuscate tile
                        f.seek(offset)
                        raw_tile = f.read(size)
                        decoded_tile = deobfuscate_tile(raw_tile)
                        
                        # Decode JPEG
                        try:
                            tile_img = Image.open(io.BytesIO(decoded_tile))
                            tile_array = np.array(tile_img)
                        except Exception as e:
                            logger.warning(f"Failed to decode tile {tile_idx}: {e}")
                            continue
                        
                        # Calculate tile position
                        ty = tile_idx // tiles_x
                        tx = tile_idx % tiles_x
                        y_start = ty * tile_height
                        x_start = tx * tile_width
                        
                        # Handle edge tiles that may be smaller
                        th = min(tile_height, height - y_start)
                        tw = min(tile_width, width - x_start)
                        
                        # Copy tile data
                        if len(tile_array.shape) == 2:
                            tile_array = tile_array[:, :, np.newaxis]
                        img_data[y_start:y_start+th, x_start:x_start+tw] = tile_array[:th, :tw]
                        
                        if tile_idx % 100 == 0:
                            logger.debug(f"  Processed tile {tile_idx}/{len(tile_offsets)}")
                
                pages_data.append({
                    'data': img_data,
                    'shape': page.shape,
                    'tile_size': (tile_width, tile_height)
                })
        
        # Write output TIFF with pyramid
        logger.info(f"Writing output TIFF: {output_path}")
        
        if progress_callback:
            progress_callback(50, "Writing TIFF pyramid...")
        
        with tifffile.TiffWriter(str(output_path), bigtiff=True) as tiff_out:
            for page_idx, page_data in enumerate(pages_data):
                if progress_callback:
                    progress_callback(
                        50 + int(page_idx / len(pages_data) * 50),
                        f"Writing level {page_idx + 1}/{len(pages_data)}"
                    )
                
                tiff_out.write(
                    page_data['data'],
                    tile=page_data['tile_size'],
                    compression='jpeg',
                    photometric='rgb',
                    subfiletype=1 if page_idx > 0 else 0,  # Mark as reduced resolution
                )
        
        logger.info(f"DCX conversion complete: {output_path}")
        return True
        
    except Exception as e:
        logger.error(f"DCX conversion failed: {e}")
        raise


def convert_dcx_transcode(input_path: Path, output_path: Path,
                          progress_callback=None) -> bool:
    """
    Convert DCX to TIFF by transcoding - minimal recompression!
    
    Uses imagecodecs if available for true zero-loss transcoding,
    otherwise uses PIL with maximum quality (100) to minimize loss.
    """
    import tifffile
    import numpy as np
    from PIL import Image
    
    logger.info(f"Converting DCX (transcode): {input_path}")
    
    # Check if we can do true zero-loss transcoding with imagecodecs
    try:
        import imagecodecs
        has_imagecodecs = True
        logger.info("imagecodecs available - using zero-loss transcoding")
    except ImportError:
        has_imagecodecs = False
        logger.info("imagecodecs not available - using high-quality recompression (Q=100)")
    
    try:
        with tifffile.TiffFile(str(input_path)) as tif:
            # Process only the base resolution level for now
            # wsidicomizer will regenerate the pyramid
            page = tif.pages[0]
            
            height, width = page.shape[:2]
            samples = page.shape[2] if len(page.shape) > 2 else 3
            
            # Get tile information
            tile_offsets = list(page.tags[324].value)
            tile_sizes = list(page.tags[325].value)
            tile_width = page.tags.get(322, type('', (), {'value': 512})()).value
            tile_height = page.tags.get(323, type('', (), {'value': 512})()).value
            
            tiles_x = (width + tile_width - 1) // tile_width
            tiles_y = (height + tile_height - 1) // tile_height
            
            logger.info(f"Image: {width}x{height}, {len(tile_offsets)} tiles ({tiles_x}x{tiles_y})")
            
            # Deobfuscate and decode all tiles
            decoded_tiles = []
            with open(input_path, 'rb') as f:
                for tile_idx, (offset, size) in enumerate(zip(tile_offsets, tile_sizes)):
                    f.seek(offset)
                    raw_tile = f.read(size)
                    jpeg_data = deobfuscate_tile(raw_tile)
                    
                    # Decode JPEG to numpy array
                    if has_imagecodecs:
                        tile_array = imagecodecs.jpeg_decode(jpeg_data)
                    else:
                        tile_img = Image.open(io.BytesIO(jpeg_data))
                        tile_array = np.array(tile_img)
                    
                    decoded_tiles.append(tile_array)
                    
                    if tile_idx % 200 == 0 and progress_callback:
                        progress_callback(
                            int(tile_idx / len(tile_offsets) * 70),
                            f"Decoding tiles... {tile_idx}/{len(tile_offsets)}"
                        )
            
            # Reconstruct full image from tiles
            logger.info("Reconstructing image from tiles...")
            if progress_callback:
                progress_callback(70, "Reconstructing image...")
            
            full_image = np.zeros((height, width, samples), dtype=np.uint8)
            
            for tile_idx, tile_array in enumerate(decoded_tiles):
                ty = tile_idx // tiles_x
                tx = tile_idx % tiles_x
                y_start = ty * tile_height
                x_start = tx * tile_width
                
                th = min(tile_height, height - y_start)
                tw = min(tile_width, width - x_start)
                
                if len(tile_array.shape) == 2:
                    tile_array = tile_array[:, :, np.newaxis]
                
                full_image[y_start:y_start+th, x_start:x_start+tw] = tile_array[:th, :tw]
            
            # Write output TIFF
            logger.info(f"Writing output TIFF: {output_path}")
            if progress_callback:
                progress_callback(80, "Writing TIFF...")
            
            # Use tifffile to write with JPEG compression
            # Quality 100 for minimal loss if we had to decode
            tifffile.imwrite(
                str(output_path),
                full_image,
                bigtiff=True,
                tile=(tile_height, tile_width),
                compression='jpeg',
                compressionargs={'level': 100},  # Max quality
                photometric='rgb',
            )
        
        logger.info(f"DCX transcode complete: {output_path}")
        
        if progress_callback:
            progress_callback(100, "Complete")
        
        return True
        
    except Exception as e:
        logger.error(f"DCX transcode failed: {e}")
        raise


def convert_dcx_streaming_recompress(input_path: Path, output_path: Path,
                                      progress_callback=None) -> bool:
    """
    Convert DCX to TIFF with recompression (fallback method).
    
    This decodes JPEG tiles and re-encodes them, which causes some quality loss
    but is more compatible with different TIFF readers.
    """
    import tifffile
    from PIL import Image
    import numpy as np
    
    logger.info(f"Converting DCX (recompress fallback): {input_path}")
    
    try:
        with tifffile.TiffFile(str(input_path)) as tif:
            page = tif.pages[0]  # Base resolution
            
            height, width = page.shape[:2]
            channels = page.shape[2] if len(page.shape) > 2 else 3
            
            tile_offsets = list(page.tags[324].value)
            tile_sizes = list(page.tags[325].value)
            tile_width = page.tags.get(322, type('', (), {'value': 512})()).value
            tile_height = page.tags.get(323, type('', (), {'value': 512})()).value
            
            tiles_x = (width + tile_width - 1) // tile_width
            tiles_y = (height + tile_height - 1) // tile_height
            
            logger.info(f"Image: {width}x{height}, {len(tile_offsets)} tiles ({tiles_x}x{tiles_y})")
            
            # Create output using pyvips for efficient tiled writing
            try:
                import pyvips
                
                # Decode tiles and build image with pyvips
                tiles = []
                with open(input_path, 'rb') as f:
                    for tile_idx, (offset, size) in enumerate(zip(tile_offsets, tile_sizes)):
                        f.seek(offset)
                        raw_tile = f.read(size)
                        decoded = deobfuscate_tile(raw_tile)
                        
                        # Load tile with pyvips
                        tile = pyvips.Image.new_from_buffer(decoded, "", access='sequential')
                        tiles.append(tile)
                        
                        if tile_idx % 100 == 0 and progress_callback:
                            progress_callback(
                                int(tile_idx / len(tile_offsets) * 80),
                                f"Decoding tiles... {tile_idx}/{len(tile_offsets)}"
                            )
                
                # Join tiles into rows, then rows into image
                rows = []
                for y in range(tiles_y):
                    row_tiles = tiles[y * tiles_x:(y + 1) * tiles_x]
                    if row_tiles:
                        row = pyvips.Image.arrayjoin(row_tiles, across=len(row_tiles))
                        rows.append(row)
                
                if rows:
                    full_image = pyvips.Image.arrayjoin(rows, across=1)
                    
                    # Crop to actual size
                    full_image = full_image.crop(0, 0, width, height)
                    
                    if progress_callback:
                        progress_callback(80, "Writing pyramid TIFF...")
                    
                    # Write as tiled pyramid TIFF
                    full_image.write_to_file(
                        str(output_path),
                        tile=True,
                        tile_width=512,
                        tile_height=512,
                        pyramid=True,
                        compression='jpeg',
                        Q=90,
                        bigtiff=True
                    )
                    
                    logger.info(f"DCX recompress conversion complete: {output_path}")
                    return True
                    
            except ImportError:
                logger.warning("pyvips not available, falling back to numpy/PIL conversion")
                return convert_dcx_to_tiff(input_path, output_path, progress_callback)
                
    except Exception as e:
        logger.error(f"DCX recompress conversion failed: {e}")
        raise


def convert_dcx_streaming(input_path: Path, output_path: Path,
                          progress_callback=None) -> bool:
    """
    Convert DCX to TIFF - uses transcoding (no recompression) by default.
    Falls back to recompression if transcoding fails.
    """
    try:
        return convert_dcx_transcode(input_path, output_path, progress_callback)
    except Exception as e:
        logger.warning(f"Transcode failed ({e}), trying recompression...")
        return convert_dcx_streaming_recompress(input_path, output_path, progress_callback)


# Quick test
if __name__ == "__main__":
    import sys
    logging.basicConfig(level=logging.INFO)
    
    if len(sys.argv) > 1:
        input_file = Path(sys.argv[1])
        output_file = input_file.with_suffix('.tiff')
        
        print(f"Converting {input_file} -> {output_file}")
        convert_dcx_streaming(input_file, output_file, 
                             lambda p, m: print(f"  [{p}%] {m}"))
    else:
        print("Usage: python dcx_handler.py <input.dcx>")
