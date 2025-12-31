"""
Enhanced iSyntax to DICOM conversion with proper pyramid support
"""
import logging
from pathlib import Path
from typing import List, Tuple
import numpy as np
from isyntax import ISyntax
from wsidicomizer import WsiDicomizer
from wsidicomizer.sources import Source
from wsidicomizer.image_data import ImageData, Size, TileSize
from pydicom.uid import generate_uid

logger = logging.getLogger(__name__)


class EnhancedISyntaxSource(Source):
    """
    Enhanced iSyntax source that properly exposes all pyramid levels
    """
    
    def __init__(self, file_path: str):
        self.file_path = Path(file_path)
        self._isyntax = ISyntax.open(str(file_path))
        self._uid = generate_uid()
        
        # Get base dimensions
        self.width, self.height = self._isyntax.dimensions
        self.tile_size = (256, 256)  # Standard tile size
        
        # Build pyramid levels
        self._levels = []
        for i in range(self._isyntax.level_count):
            level = self._isyntax.wsi.get_level(i)
            self._levels.append({
                'index': i,
                'width': level.width,
                'height': level.height,
                'downsample': 2 ** i
            })
        
        logger.info(f"EnhancedISyntaxSource: {len(self._levels)} levels detected")
        for level in self._levels:
            logger.info(f"  Level {level['index']}: {level['width']}x{level['height']}")
    
    @property
    def size(self) -> Size:
        """Full resolution size"""
        return Size(self.width, self.height)
    
    @property
    def tile_size(self) -> TileSize:
        """Tile size for all levels"""
        return TileSize(*self.tile_size)
    
    @property
    def levels(self) -> List[ImageData]:
        """Return all pyramid levels"""
        levels = []
        for level_info in self._levels:
            level_data = ISyntaxLevelImageData(
                source=self,
                level_index=level_info['index'],
                size=Size(level_info['width'], level_info['height']),
                tile_size=self.tile_size
            )
            levels.append(level_data)
        return levels
    
    def get_tile(self, level: int, tile_x: int, tile_y: int) -> np.ndarray:
        """Get a tile from the specified level"""
        tile_width, tile_height = self.tile_size
        x = tile_x * tile_width
        y = tile_y * tile_height
        
        # Read region from iSyntax
        tile_data = self._isyntax.read_region(x, y, tile_width, tile_height, level=level)
        
        # Ensure RGB format (remove alpha if present)
        if tile_data.shape[2] == 4:
            tile_data = tile_data[:, :, :3]
        
        return tile_data
    
    def close(self):
        """Close the iSyntax file"""
        if hasattr(self, '_isyntax'):
            self._isyntax.close()
    
    def __enter__(self):
        return self
    
    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()


class ISyntaxLevelImageData(ImageData):
    """Image data for a specific iSyntax pyramid level"""
    
    def __init__(self, source: EnhancedISyntaxSource, level_index: int, size: Size, tile_size: TileSize):
        self.source = source
        self.level_index = level_index
        self._size = size
        self._tile_size = tile_size
    
    @property
    def size(self) -> Size:
        return self._size
    
    @property
    def tile_size(self) -> TileSize:
        return self._tile_size
    
    def get_tile(self, tile_point: Tuple[int, int]) -> np.ndarray:
        """Get a tile at the specified point"""
        return self.source.get_tile(self.level_index, tile_point[0], tile_point[1])
    
    @property
    def pixel_spacing(self):
        """Pixel spacing for this level"""
        # Calculate based on downsample factor
        base_spacing = 0.25  # microns per pixel at full resolution (typical for 40x)
        downsample = 2 ** self.level_index
        return (base_spacing * downsample, base_spacing * downsample)


def convert_isyntax_with_pyramid(file_path: Path, output_dir: Path) -> List[Path]:
    """
    Convert iSyntax file to DICOM with proper multi-resolution pyramid
    """
    logger.info(f"Converting iSyntax file with enhanced pyramid support: {file_path}")
    
    # Use our enhanced source
    with EnhancedISyntaxSource(str(file_path)) as source:
        # Create WsiDicomizer with our custom source
        with WsiDicomizer(
            source,
            metadata={
                'study_instance_uid': generate_uid(),
                'series_instance_uid': generate_uid(),
                'patient_name': file_path.stem,
                'patient_id': 'ISYNTAX-PYRAMID',
            },
            tile_size=(256, 256)
        ) as wsi:
            logger.info(f"Saving DICOM pyramid with {len(source.levels)} levels...")
            wsi.save(str(output_dir))
    
    # Return list of generated DICOM files
    dicom_files = list(output_dir.glob("*.dcm"))
    logger.info(f"Generated {len(dicom_files)} DICOM files")
    
    return dicom_files
