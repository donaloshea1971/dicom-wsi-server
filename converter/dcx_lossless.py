#!/usr/bin/env python3
"""
DCX Lossless Transcoder

Converts obfuscated DCX files to standard TIFF by copying the raw JPEG tile
data WITHOUT decoding/re-encoding. This preserves 100% original quality.

The approach:
1. Read DCX structure (BigTIFF with obfuscated JPEG tiles)
2. Deobfuscate each tile (XOR with key, strip key bytes)  
3. Write new BigTIFF with raw JPEG bytes at tile offsets
"""

import struct
import io
import logging
from pathlib import Path
from typing import List, Tuple, Optional, BinaryIO

logger = logging.getLogger(__name__)

# DCX obfuscation key size
KEY_SIZE = 1024

# TIFF constants
TIFF_MAGIC_LE = b'II'  # Little-endian
BIGTIFF_VERSION = 43
TIFF_VERSION = 42

# TIFF tag IDs we care about
TAG_NEW_SUBFILE_TYPE = 254
TAG_IMAGE_WIDTH = 256
TAG_IMAGE_LENGTH = 257
TAG_BITS_PER_SAMPLE = 258
TAG_COMPRESSION = 259
TAG_PHOTOMETRIC = 262
TAG_SAMPLES_PER_PIXEL = 277
TAG_ROWS_PER_STRIP = 278
TAG_X_RESOLUTION = 282
TAG_Y_RESOLUTION = 283
TAG_RESOLUTION_UNIT = 296
TAG_TILE_WIDTH = 322
TAG_TILE_LENGTH = 323
TAG_TILE_OFFSETS = 324
TAG_TILE_BYTE_COUNTS = 325
TAG_SAMPLE_FORMAT = 339
TAG_JPEG_TABLES = 347

# TIFF data types
TIFF_SHORT = 3      # 16-bit unsigned
TIFF_LONG = 4       # 32-bit unsigned
TIFF_RATIONAL = 5   # Two LONGs: numerator and denominator
TIFF_LONG8 = 16     # 64-bit unsigned (BigTIFF)


def deobfuscate_tile(tile_data: bytes) -> bytes:
    """Deobfuscate a DCX tile by XORing with key from end"""
    if len(tile_data) <= KEY_SIZE:
        return tile_data
    
    data = bytearray(tile_data)
    key_offset = len(data) - KEY_SIZE
    key = data[key_offset:]
    
    # XOR first KEY_SIZE bytes
    for i in range(min(KEY_SIZE, key_offset)):
        data[i] ^= key[i]
    
    # Return without key
    return bytes(data[:key_offset])


class BigTiffWriter:
    """
    Writes BigTIFF files with pre-compressed JPEG tiles.
    """
    
    def __init__(self, output_path: Path):
        self.output_path = output_path
        self.file: Optional[BinaryIO] = None
        self.current_offset = 0
        self.ifd_offsets: List[int] = []
        self.next_ifd_positions: List[int] = []  # Position of "next IFD offset" field for each IFD
        
    def __enter__(self):
        self.file = open(self.output_path, 'wb')
        self._write_header()
        return self
    
    def __exit__(self, *args):
        if self.file:
            self.file.close()
    
    def _write_header(self):
        """Write BigTIFF header"""
        # Magic number (II = little-endian)
        self.file.write(TIFF_MAGIC_LE)
        # Version (43 for BigTIFF)
        self.file.write(struct.pack('<H', BIGTIFF_VERSION))
        # Byte size of offsets (8 for BigTIFF)
        self.file.write(struct.pack('<H', 8))
        # Always 0
        self.file.write(struct.pack('<H', 0))
        # Offset to first IFD (will be updated)
        self.first_ifd_offset_pos = self.file.tell()
        self.file.write(struct.pack('<Q', 0))  # Placeholder
        self.current_offset = self.file.tell()
    
    def write_page(self, 
                   width: int, height: int,
                   tile_width: int, tile_height: int,
                   jpeg_tiles: List[bytes],
                   samples_per_pixel: int = 3,
                   bits_per_sample: Tuple[int, ...] = (8, 8, 8),
                   jpeg_tables: Optional[bytes] = None,
                   is_reduced: bool = False,
                   x_resolution: Optional[Tuple[int, int]] = None,
                   y_resolution: Optional[Tuple[int, int]] = None,
                   resolution_unit: int = 3) -> int:  # 3 = centimeter
        """
        Write a single page/IFD with pre-compressed JPEG tiles.
        
        Args:
            x_resolution: Tuple of (numerator, denominator) for X resolution
            y_resolution: Tuple of (numerator, denominator) for Y resolution
            resolution_unit: 1=none, 2=inch, 3=centimeter
        
        Returns the offset where this IFD was written.
        """
        # First, write all tile data and collect offsets
        tile_offsets = []
        tile_byte_counts = []
        
        for jpeg_data in jpeg_tiles:
            tile_offsets.append(self.current_offset)
            tile_byte_counts.append(len(jpeg_data))
            self.file.seek(self.current_offset)
            self.file.write(jpeg_data)
            self.current_offset += len(jpeg_data)
        
        # Align to 8-byte boundary
        padding = (8 - (self.current_offset % 8)) % 8
        if padding:
            self.file.write(b'\x00' * padding)
            self.current_offset += padding
        
        # Build IFD entries - write all external data (arrays, rationals) FIRST
        # before setting the IFD offset, to avoid overwriting them
        entries = []
        
        # Image dimensions (inline values, no external data)
        entries.append(self._make_entry(TAG_IMAGE_WIDTH, TIFF_SHORT, 1, width))
        entries.append(self._make_entry(TAG_IMAGE_LENGTH, TIFF_SHORT, 1, height))
        
        # Bits per sample (need to write array for RGB)
        if samples_per_pixel > 1:
            bps_offset = self._write_array(bits_per_sample, '<H')
            entries.append(self._make_entry(TAG_BITS_PER_SAMPLE, TIFF_SHORT, samples_per_pixel, bps_offset))
        else:
            entries.append(self._make_entry(TAG_BITS_PER_SAMPLE, TIFF_SHORT, 1, bits_per_sample[0]))
        
        # Compression (7 = new-style JPEG)
        entries.append(self._make_entry(TAG_COMPRESSION, TIFF_SHORT, 1, 7))
        
        # Photometric (2 = RGB, 6 = YCbCr for JPEG)
        entries.append(self._make_entry(TAG_PHOTOMETRIC, TIFF_SHORT, 1, 6))  # YCbCr is standard for JPEG
        
        # Samples per pixel
        entries.append(self._make_entry(TAG_SAMPLES_PER_PIXEL, TIFF_SHORT, 1, samples_per_pixel))
        
        # Resolution tags (critical for wsidicomizer pixel spacing)
        # In BigTIFF, RATIONAL fits in the 8-byte value field (4+4 bytes), so store inline
        if x_resolution:
            # Pack numerator and denominator as two 32-bit ints into one 64-bit value
            x_res_inline = (x_resolution[1] << 32) | x_resolution[0]  # denom in high 32, num in low 32
            entries.append(self._make_entry(TAG_X_RESOLUTION, TIFF_RATIONAL, 1, x_res_inline))
        if y_resolution:
            y_res_inline = (y_resolution[1] << 32) | y_resolution[0]
            entries.append(self._make_entry(TAG_Y_RESOLUTION, TIFF_RATIONAL, 1, y_res_inline))
        if x_resolution or y_resolution:
            entries.append(self._make_entry(TAG_RESOLUTION_UNIT, TIFF_SHORT, 1, resolution_unit))
        
        # Tile dimensions
        entries.append(self._make_entry(TAG_TILE_WIDTH, TIFF_SHORT, 1, tile_width))
        entries.append(self._make_entry(TAG_TILE_LENGTH, TIFF_SHORT, 1, tile_height))
        
        # Tile offsets (array of LONG8) - external data
        offsets_pos = self._write_array(tile_offsets, '<Q')
        entries.append(self._make_entry(TAG_TILE_OFFSETS, TIFF_LONG8, len(tile_offsets), offsets_pos))
        
        # Tile byte counts (array of LONG8) - external data
        counts_pos = self._write_array(tile_byte_counts, '<Q')
        entries.append(self._make_entry(TAG_TILE_BYTE_COUNTS, TIFF_LONG8, len(tile_byte_counts), counts_pos))
        
        # JPEG tables if provided
        if jpeg_tables:
            tables_offset = self._write_bytes(jpeg_tables)
            entries.append(self._make_entry(TAG_JPEG_TABLES, 7, len(jpeg_tables), tables_offset))
        
        # Subfile type for reduced resolution images
        if is_reduced:
            entries.append(self._make_entry(TAG_NEW_SUBFILE_TYPE, TIFF_LONG, 1, 1))  # reduced
        
        # Sort entries by tag number (required by TIFF spec)
        entries.sort(key=lambda e: e[0])
        
        # NOW set IFD offset - after all external data has been written
        ifd_offset = self.current_offset
        self.ifd_offsets.append(ifd_offset)
        
        # Write IFD at current position (not seeking back)
        self.file.seek(ifd_offset)
        # Number of entries (LONG8 for BigTIFF)
        self.file.write(struct.pack('<Q', len(entries)))
        
        # Write entries
        for tag, dtype, count, value in entries:
            self.file.write(struct.pack('<H', tag))     # Tag ID
            self.file.write(struct.pack('<H', dtype))   # Data type
            self.file.write(struct.pack('<Q', count))   # Count
            self.file.write(struct.pack('<Q', value))   # Value/offset
        
        # Next IFD offset (0 = none for now, will link in finalize)
        next_ifd_pos = self.file.tell()
        self.next_ifd_positions.append(next_ifd_pos)
        self.file.write(struct.pack('<Q', 0))
        
        self.current_offset = self.file.tell()
        
        return ifd_offset
    
    def _make_entry(self, tag: int, dtype: int, count: int, value: int) -> Tuple:
        """Create an IFD entry tuple"""
        return (tag, dtype, count, value)
    
    def _write_array(self, values: List[int], fmt: str) -> int:
        """Write an array of values and return the offset"""
        offset = self.current_offset
        self.file.seek(offset)
        for v in values:
            self.file.write(struct.pack(fmt, v))
        self.current_offset = self.file.tell()
        # Align
        padding = (8 - (self.current_offset % 8)) % 8
        if padding:
            self.file.write(b'\x00' * padding)
            self.current_offset += padding
        return offset
    
    def _write_bytes(self, data: bytes) -> int:
        """Write raw bytes and return the offset"""
        offset = self.current_offset
        self.file.seek(offset)
        self.file.write(data)
        self.current_offset = self.file.tell()
        padding = (8 - (self.current_offset % 8)) % 8
        if padding:
            self.file.write(b'\x00' * padding)
            self.current_offset += padding
        return offset
    
    def _write_rational(self, numerator: int, denominator: int) -> int:
        """Write a RATIONAL value (two 32-bit unsigned ints) and return offset"""
        offset = self.current_offset
        self.file.seek(offset)
        self.file.write(struct.pack('<I', numerator))    # 32-bit unsigned
        self.file.write(struct.pack('<I', denominator))  # 32-bit unsigned
        self.current_offset = self.file.tell()
        # Align to 8-byte boundary
        padding = (8 - (self.current_offset % 8)) % 8
        if padding:
            self.file.write(b'\x00' * padding)
            self.current_offset += padding
        return offset
    
    def finalize(self):
        """Update header to point to first IFD and link IFDs together"""
        # Update first IFD offset in header
        if self.ifd_offsets:
            self.file.seek(self.first_ifd_offset_pos)
            self.file.write(struct.pack('<Q', self.ifd_offsets[0]))
        
        # Link IFDs together (each IFD's "next" pointer to the following IFD)
        for i in range(len(self.ifd_offsets) - 1):
            next_ifd_pos = self.next_ifd_positions[i]
            next_ifd_offset = self.ifd_offsets[i + 1]
            self.file.seek(next_ifd_pos)
            self.file.write(struct.pack('<Q', next_ifd_offset))
        
        logger.info(f"Linked {len(self.ifd_offsets)} IFDs")


def convert_dcx_lossless(input_path: Path, output_path: Path,
                         progress_callback=None) -> bool:
    """
    Convert DCX to standard BigTIFF with lossless JPEG tile transcoding.
    
    STREAMING version - processes one page at a time to minimize memory usage.
    No decode/re-encode - just copy the raw JPEG bytes!
    """
    import tifffile
    
    logger.info(f"Lossless DCX transcode (streaming): {input_path} -> {output_path}")
    
    # First pass: collect page metadata only (no tile data)
    page_metadata = []
    global_resolution = None  # Store resolution from first page
    
    with tifffile.TiffFile(str(input_path)) as tif:
        total_pages = len(tif.pages)
        for page_idx, page in enumerate(tif.pages):
            if 324 not in page.tags or 325 not in page.tags:
                logger.warning(f"Page {page_idx} has no tiles, skipping")
                continue
            
            width = page.shape[1] if len(page.shape) > 1 else page.shape[0]
            height = page.shape[0]
            samples = page.shape[2] if len(page.shape) > 2 else 1
            
            tile_offsets = list(page.tags[324].value)
            tile_sizes = list(page.tags[325].value)
            tile_width = page.tags.get(322, type('', (), {'value': 512})()).value
            tile_height = page.tags.get(323, type('', (), {'value': 512})()).value
            
            # Extract resolution from first page (full resolution)
            x_res = None
            y_res = None
            res_unit = 3  # Default to centimeter
            
            if page_idx == 0:
                # Get resolution tags if present - wrap everything in try/except
                # because tifffile may raise exceptions for malformed RATIONAL values
                try:
                    if 282 in page.tags:  # XResolution
                        try:
                            x_val = page.tags[282].value
                            if isinstance(x_val, tuple) and len(x_val) >= 2:
                                num, denom = int(x_val[0]), int(x_val[1])
                                if denom > 0 and num > 0:
                                    x_res = (num, denom)
                                    logger.info(f"  XResolution from DCX: {x_res}")
                            elif hasattr(x_val, 'numerator') and hasattr(x_val, 'denominator'):
                                if x_val.denominator > 0 and x_val.numerator > 0:
                                    x_res = (int(x_val.numerator), int(x_val.denominator))
                                    logger.info(f"  XResolution from DCX (Fraction): {x_res}")
                            elif isinstance(x_val, (int, float)) and x_val > 0:
                                x_res = (int(x_val), 1)
                                logger.info(f"  XResolution from DCX (scalar): {x_res}")
                        except Exception as e:
                            logger.warning(f"  Error reading XResolution tag: {e}")
                except Exception as e:
                    logger.warning(f"  Error accessing XResolution: {e}")
                    
                try:
                    if 283 in page.tags:  # YResolution
                        try:
                            y_val = page.tags[283].value
                            if isinstance(y_val, tuple) and len(y_val) >= 2:
                                num, denom = int(y_val[0]), int(y_val[1])
                                if denom > 0 and num > 0:
                                    y_res = (num, denom)
                                    logger.info(f"  YResolution from DCX: {y_res}")
                            elif hasattr(y_val, 'numerator') and hasattr(y_val, 'denominator'):
                                if y_val.denominator > 0 and y_val.numerator > 0:
                                    y_res = (int(y_val.numerator), int(y_val.denominator))
                                    logger.info(f"  YResolution from DCX (Fraction): {y_res}")
                            elif isinstance(y_val, (int, float)) and y_val > 0:
                                y_res = (int(y_val), 1)
                                logger.info(f"  YResolution from DCX (scalar): {y_res}")
                        except Exception as e:
                            logger.warning(f"  Error reading YResolution tag: {e}")
                except Exception as e:
                    logger.warning(f"  Error accessing YResolution: {e}")
                    
                try:
                    if 296 in page.tags:  # ResolutionUnit
                        res_unit = int(page.tags[296].value)
                        logger.info(f"  ResolutionUnit from DCX: {res_unit}")
                except Exception as e:
                    logger.warning(f"  Error reading ResolutionUnit: {e}")
                    res_unit = 3
                
                # If no valid resolution found, use a reasonable default for pathology (0.25 µm/pixel = 40000 pixels/cm)
                if not x_res:
                    x_res = (40000, 1)  # 40000 pixels per cm = 0.25 µm/pixel
                    logger.warning(f"  No valid XResolution in DCX, using default: {x_res}")
                if not y_res:
                    y_res = (40000, 1)
                    logger.warning(f"  No valid YResolution in DCX, using default: {y_res}")
                
                global_resolution = {
                    'x_res': x_res,
                    'y_res': y_res,
                    'unit': res_unit
                }
            
            # For reduced resolution pages, scale the resolution
            if page_idx > 0 and global_resolution:
                # Calculate scale factor based on dimensions
                scale = page_metadata[0]['width'] / width if page_metadata else 1
                x_res = (int(global_resolution['x_res'][0] / scale), global_resolution['x_res'][1])
                y_res = (int(global_resolution['y_res'][0] / scale), global_resolution['y_res'][1])
                res_unit = global_resolution['unit']
            
            page_metadata.append({
                'width': width,
                'height': height,
                'tile_width': tile_width,
                'tile_height': tile_height,
                'samples': samples,
                'tile_offsets': tile_offsets,
                'tile_sizes': tile_sizes,
                'is_reduced': page_idx > 0,
                'x_resolution': x_res,
                'y_resolution': y_res,
                'resolution_unit': res_unit,
            })
            logger.info(f"Page {page_idx}: {width}x{height}, {len(tile_offsets)} tiles, res={x_res}")
    
    # Second pass: stream tiles one page at a time
    logger.info(f"Writing lossless TIFF: {output_path}")
    
    with BigTiffWriter(output_path) as writer:
        for page_idx, meta in enumerate(page_metadata):
            if progress_callback:
                progress_callback(
                    int((page_idx / len(page_metadata)) * 95),
                    f"Processing level {page_idx + 1}/{len(page_metadata)}"
                )
            
            # Stream tiles for this page only - don't hold all pages in memory
            jpeg_tiles = []
            with open(input_path, 'rb') as f:
                for tile_idx, (offset, size) in enumerate(zip(meta['tile_offsets'], meta['tile_sizes'])):
                    f.seek(offset)
                    raw_tile = f.read(size)
                    jpeg_data = deobfuscate_tile(raw_tile)
                    jpeg_tiles.append(jpeg_data)
                    
                    # Log progress for large pages
                    if tile_idx > 0 and tile_idx % 1000 == 0:
                        logger.info(f"  Page {page_idx}: processed {tile_idx}/{len(meta['tile_offsets'])} tiles")
            
            # Write this page immediately
            writer.write_page(
                width=meta['width'],
                height=meta['height'],
                tile_width=meta['tile_width'],
                tile_height=meta['tile_height'],
                jpeg_tiles=jpeg_tiles,
                samples_per_pixel=meta['samples'],
                is_reduced=meta['is_reduced'],
                x_resolution=meta.get('x_resolution'),
                y_resolution=meta.get('y_resolution'),
                resolution_unit=meta.get('resolution_unit', 3),
            )
            
            # Free memory for this page's tiles before processing next
            del jpeg_tiles
            
            logger.info(f"  Page {page_idx} written")
        
        writer.finalize()
    
    logger.info(f"Lossless transcode complete: {output_path}")
    if progress_callback:
        progress_callback(100, "Complete")
    
    return True


if __name__ == "__main__":
    import sys
    logging.basicConfig(level=logging.INFO)
    
    if len(sys.argv) > 1:
        input_file = Path(sys.argv[1])
        output_file = input_file.with_suffix('.tiff')
        
        print(f"Lossless transcode: {input_file} -> {output_file}")
        convert_dcx_lossless(input_file, output_file,
                            lambda p, m: print(f"  [{p}%] {m}"))
        
        # Verify output
        import tifffile
        with tifffile.TiffFile(str(output_file)) as tif:
            print(f"\nOutput verification:")
            print(f"  Pages: {len(tif.pages)}")
            for i, page in enumerate(tif.pages):
                print(f"  Page {i}: {page.shape}, compression={page.compression}")
    else:
        print("Usage: python dcx_lossless.py <input.dcx>")
