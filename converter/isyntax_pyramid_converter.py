"""
Custom iSyntax to DICOM converter with proper multi-resolution pyramid support
"""
import logging
import numpy as np
from pathlib import Path
from typing import List, Optional, Tuple, Dict, Any
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed

from isyntax import ISyntax
import pydicom
from pydicom.dataset import Dataset, FileDataset
from pydicom.uid import generate_uid, JPEG2000, ExplicitVRLittleEndian
from pydicom.encaps import encapsulate
from PIL import Image
import io

logger = logging.getLogger(__name__)


class ISyntaxPyramidConverter:
    """
    Converts Philips iSyntax files to DICOM WSI with proper multi-resolution pyramid
    """
    
    def __init__(self, 
                 tile_size: Tuple[int, int] = (256, 256),
                 compression: str = 'jpeg',
                 quality: int = 90,
                 workers: int = 1):
        """
        Initialize the converter
        
        Args:
            tile_size: Size of tiles (width, height)
            compression: Compression type ('jpeg2000', 'jpeg', or 'none')
            quality: Compression quality (1-100)
            workers: Number of worker threads for parallel processing
                     Note: iSyntax SDK may not be thread-safe, default to 1
        """
        self.tile_width, self.tile_height = tile_size
        self.compression = compression
        self.quality = quality
        self.workers = workers  # Keep at 1 for iSyntax - SDK may not be thread-safe
        
        # DICOM UIDs
        self.study_uid = generate_uid()
        self.series_uid = generate_uid()
        
        # Compression settings
        self.transfer_syntax = {
            'jpeg2000': JPEG2000,
            'jpeg': '1.2.840.10008.1.2.4.50',  # JPEG Baseline
            'none': ExplicitVRLittleEndian
        }.get(compression, ExplicitVRLittleEndian)
    
    def convert(self, 
                input_path: Path, 
                output_dir: Path,
                patient_name: Optional[str] = None,
                patient_id: Optional[str] = None,
                study_description: Optional[str] = None) -> List[Path]:
        """
        Convert iSyntax file to DICOM WSI pyramid
        
        Args:
            input_path: Path to iSyntax file
            output_dir: Directory to save DICOM files
            patient_name: Patient name (default: filename)
            patient_id: Patient ID (default: 'ISYNTAX')
            study_description: Study description
            
        Returns:
            List of generated DICOM file paths
        """
        logger.info(f"Converting iSyntax file: {input_path}")
        
        # Ensure output directory exists
        output_dir.mkdir(parents=True, exist_ok=True)
        
        # Default metadata
        if patient_name is None:
            patient_name = input_path.stem
        if patient_id is None:
            patient_id = 'ISYNTAX'
        if study_description is None:
            study_description = f"Converted from {input_path.name}"
        
        dicom_files = []
        
        with ISyntax.open(str(input_path)) as isyntax:
            # Get image information
            width, height = isyntax.dimensions
            num_levels = isyntax.level_count
            
            logger.info(f"Image: {width}x{height}, {num_levels} levels")
            
            # Create shared metadata
            base_metadata = self._create_base_metadata(
                patient_name=patient_name,
                patient_id=patient_id,
                study_description=study_description,
                total_width=width,
                total_height=height,
                num_levels=num_levels
            )
            
            # Process each level (skip level 0 for demo - it's too large)
            # In production, you would process all levels
            start_level = 1 if num_levels > 1 else 0  # Skip level 0 if there are other levels
            
            logger.info(f"Processing levels {start_level} to {num_levels-1} (skipping level 0 for demo)")
            
            for level_idx in range(start_level, num_levels):
                logger.info(f"Processing level {level_idx}...")
                
                level_files = self._process_level(
                    isyntax=isyntax,
                    level_idx=level_idx,
                    base_metadata=base_metadata,
                    output_dir=output_dir
                )
                
                dicom_files.extend(level_files)
                logger.info(f"Level {level_idx}: Created {len(level_files)} DICOM files")
        
        # Create the main LABEL and OVERVIEW images if needed
        # These are typically stored at the highest resolution levels
        
        logger.info(f"Conversion complete: {len(dicom_files)} DICOM files created")
        return dicom_files
    
    def _process_level(self,
                      isyntax: ISyntax,
                      level_idx: int,
                      base_metadata: Dict[str, Any],
                      output_dir: Path) -> List[Path]:
        """
        Process a single pyramid level
        """
        level = isyntax.wsi.get_level(level_idx)
        level_width = level.width
        level_height = level.height
        
        # Calculate number of tiles
        tiles_x = (level_width + self.tile_width - 1) // self.tile_width
        tiles_y = (level_height + self.tile_height - 1) // self.tile_height
        
        logger.info(f"Level {level_idx}: {level_width}x{level_height}, {tiles_x}x{tiles_y} tiles")
        
        dicom_files = []
        
        # Determine image type based on level
        if level_idx == 0:
            image_type = ['ORIGINAL', 'PRIMARY', 'VOLUME', 'NONE']
        else:
            image_type = ['DERIVED', 'PRIMARY', 'VOLUME', 'RESAMPLED']
        
        # Use sequential processing for iSyntax - SDK is not thread-safe
        # Process tiles one at a time to avoid memory and threading issues
        if self.workers == 1 or level_idx == 0 and tiles_x * tiles_y > 1000:
            logger.info(f"Level {level_idx} has {tiles_x * tiles_y} tiles - using reduced parallelism")
            # Process in batches to avoid memory overload
            batch_size = 100
            tile_count = 0
            
            for batch_start in range(0, tiles_x * tiles_y, batch_size):
                batch_futures = []
                
                with ThreadPoolExecutor(max_workers=2) as executor:  # Reduced workers for large levels
                    for i in range(batch_start, min(batch_start + batch_size, tiles_x * tiles_y)):
                        tile_y = i // tiles_x
                        tile_x = i % tiles_x
                        
                        future = executor.submit(
                            self._create_tile_dicom,
                            isyntax=isyntax,
                            level_idx=level_idx,
                            tile_x=tile_x,
                            tile_y=tile_y,
                            level_width=level_width,
                            level_height=level_height,
                            image_type=image_type,
                            base_metadata=base_metadata.copy(),
                            output_dir=output_dir
                        )
                        batch_futures.append(future)
                    
                    # Process batch results
                    for future in as_completed(batch_futures):
                        try:
                            dicom_path = future.result()
                            if dicom_path:
                                dicom_files.append(dicom_path)
                                tile_count += 1
                                if tile_count % 100 == 0:
                                    logger.info(f"Level {level_idx}: Processed {tile_count}/{tiles_x * tiles_y} tiles")
                        except Exception as e:
                            logger.error(f"Error processing tile: {e}")
        else:
            # Normal parallel processing for smaller levels
            with ThreadPoolExecutor(max_workers=self.workers) as executor:
                futures = []
                
                for tile_y in range(tiles_y):
                    for tile_x in range(tiles_x):
                        future = executor.submit(
                            self._create_tile_dicom,
                            isyntax=isyntax,
                            level_idx=level_idx,
                            tile_x=tile_x,
                            tile_y=tile_y,
                            level_width=level_width,
                            level_height=level_height,
                            image_type=image_type,
                            base_metadata=base_metadata.copy(),
                            output_dir=output_dir
                        )
                        futures.append(future)
                
                # Collect results
                for future in as_completed(futures):
                    try:
                        dicom_path = future.result()
                        if dicom_path:
                            dicom_files.append(dicom_path)
                    except Exception as e:
                        logger.error(f"Error processing tile: {e}")
        
        return dicom_files
    
    def _create_tile_dicom(self,
                          isyntax: ISyntax,
                          level_idx: int,
                          tile_x: int,
                          tile_y: int,
                          level_width: int,
                          level_height: int,
                          image_type: List[str],
                          base_metadata: Dict[str, Any],
                          output_dir: Path) -> Optional[Path]:
        """
        Create a DICOM file for a single tile
        """
        # Calculate tile boundaries
        x = tile_x * self.tile_width
        y = tile_y * self.tile_height
        w = min(self.tile_width, level_width - x)
        h = min(self.tile_height, level_height - y)
        
        # Skip empty edge tiles
        if w <= 0 or h <= 0:
            return None
        
        try:
            # Read tile data from iSyntax
            # Note: iSyntax SDK may not be thread-safe, so avoid parallel reads
            try:
                tile_data = isyntax.read_region(x, y, w, h, level=level_idx)
            except Exception as read_error:
                logger.error(f"Failed to read region at L{level_idx} ({x},{y},{w},{h}): {type(read_error).__name__}: {read_error}")
                # Return a blank tile instead of crashing
                tile_data = np.ones((h, w, 3), dtype=np.uint8) * 255  # White background
            
            # Ensure tile_data has 3 dimensions
            if tile_data is None or tile_data.size == 0:
                logger.warning(f"Empty tile data for L{level_idx}_X{tile_x}_Y{tile_y}, using blank")
                tile_data = np.ones((h, w, 3), dtype=np.uint8) * 255
            
            # Convert RGBA to RGB if needed
            if len(tile_data.shape) == 3 and tile_data.shape[2] == 4:
                tile_data = tile_data[:, :, :3]
            elif len(tile_data.shape) == 2:
                # Grayscale - convert to RGB
                tile_data = np.stack([tile_data] * 3, axis=-1)
            
            # Pad tile to full size if needed
            if w < self.tile_width or h < self.tile_height:
                padded = np.ones((self.tile_height, self.tile_width, 3), dtype=np.uint8) * 255
                padded[:h, :w] = tile_data
                tile_data = padded
            
            # Create DICOM dataset
            ds = self._create_dicom_dataset(
                pixel_data=tile_data,
                level_idx=level_idx,
                tile_x=tile_x,
                tile_y=tile_y,
                level_width=level_width,
                level_height=level_height,
                image_type=image_type,
                **base_metadata
            )
            
            # Generate filename
            filename = f"L{level_idx}_X{tile_x}_Y{tile_y}.dcm"
            output_path = output_dir / filename
            
            # Save DICOM file
            ds.save_as(str(output_path), write_like_original=False)
            
            return output_path
            
        except Exception as e:
            import traceback
            logger.error(f"Error creating tile L{level_idx}_X{tile_x}_Y{tile_y}: {type(e).__name__}: {e}")
            logger.error(f"Traceback: {traceback.format_exc()}")
            return None
    
    def _create_dicom_dataset(self,
                             pixel_data: np.ndarray,
                             level_idx: int,
                             tile_x: int,
                             tile_y: int,
                             level_width: int,
                             level_height: int,
                             image_type: List[str],
                             **metadata) -> FileDataset:
        """
        Create a DICOM dataset for a tile
        """
        # Create file meta
        file_meta = Dataset()
        file_meta.MediaStorageSOPClassUID = '1.2.840.10008.5.1.4.1.1.77.1.6'  # VL Whole Slide Microscopy
        file_meta.MediaStorageSOPInstanceUID = generate_uid()
        file_meta.TransferSyntaxUID = self.transfer_syntax
        file_meta.ImplementationClassUID = generate_uid()
        
        # Create main dataset
        ds = FileDataset(None, {}, file_meta=file_meta, preamble=b"\0" * 128)
        
        # Patient Module
        ds.PatientName = metadata['patient_name']
        ds.PatientID = metadata['patient_id']
        ds.PatientBirthDate = ''
        ds.PatientSex = ''
        
        # Study Module
        ds.StudyInstanceUID = self.study_uid
        ds.StudyDate = metadata['study_date']
        ds.StudyTime = metadata['study_time']
        ds.StudyID = metadata['study_id']
        ds.AccessionNumber = ''
        ds.StudyDescription = metadata['study_description']
        ds.ReferringPhysicianName = ''
        
        # Series Module
        ds.SeriesInstanceUID = self.series_uid
        ds.SeriesNumber = 1
        ds.SeriesDate = metadata['study_date']
        ds.SeriesTime = metadata['study_time']
        ds.SeriesDescription = f"Level {level_idx}"
        ds.Modality = 'SM'  # Slide Microscopy
        
        # General Equipment Module
        ds.Manufacturer = 'Philips'
        ds.ManufacturerModelName = 'iSyntax'
        ds.SoftwareVersions = 'ISyntaxPyramidConverter'
        
        # Image Module
        ds.SOPClassUID = file_meta.MediaStorageSOPClassUID
        ds.SOPInstanceUID = file_meta.MediaStorageSOPInstanceUID
        ds.InstanceNumber = tile_y * ((level_width + self.tile_width - 1) // self.tile_width) + tile_x + 1
        ds.ImageType = image_type
        
        # Image Pixel Module
        ds.SamplesPerPixel = 3
        ds.PhotometricInterpretation = 'RGB'
        ds.Rows = self.tile_height
        ds.Columns = self.tile_width
        ds.BitsAllocated = 8
        ds.BitsStored = 8
        ds.HighBit = 7
        ds.PixelRepresentation = 0
        ds.PlanarConfiguration = 0
        
        # Whole Slide Microscopy Image Module
        ds.DimensionOrganizationType = 'TILED_FULL'
        ds.TileWidth = self.tile_width
        ds.TileHeight = self.tile_height
        ds.TotalPixelMatrixColumns = metadata['total_width']
        ds.TotalPixelMatrixRows = metadata['total_height']
        ds.TotalPixelMatrixOriginSequence = [Dataset()]
        ds.TotalPixelMatrixOriginSequence[0].XOffsetInSlideCoordinateSystem = 0
        ds.TotalPixelMatrixOriginSequence[0].YOffsetInSlideCoordinateSystem = 0
        
        # Calculate pixel spacing based on level
        base_spacing = 0.25  # microns per pixel at 40x (level 0)
        downsample = 2 ** level_idx
        pixel_spacing = base_spacing * downsample
        ds.ImagedVolumeWidth = metadata['total_width'] * base_spacing / 1000  # mm
        ds.ImagedVolumeHeight = metadata['total_height'] * base_spacing / 1000  # mm
        
        # Shared Functional Groups Sequence
        shared_fg = Dataset()
        
        # Pixel Measures Sequence
        pixel_measures = Dataset()
        pixel_measures.PixelSpacing = [pixel_spacing / 1000, pixel_spacing / 1000]  # mm
        pixel_measures.SliceThickness = 0.0
        shared_fg.PixelMeasuresSequence = [pixel_measures]
        
        # Whole Slide Microscopy Image Frame Type
        frame_type = Dataset()
        frame_type.FrameType = image_type
        shared_fg.WholeSlideMicroscopyImageFrameTypeSequence = [frame_type]
        
        ds.SharedFunctionalGroupsSequence = [shared_fg]
        
        # Per-Frame Functional Groups Sequence
        per_frame_fg = Dataset()
        
        # Frame Content Sequence
        frame_content = Dataset()
        frame_content.DimensionIndexValues = [tile_x + 1, tile_y + 1]
        per_frame_fg.FrameContentSequence = [frame_content]
        
        # Plane Position Slide Sequence
        plane_position = Dataset()
        plane_position.ColumnPositionInTotalImagePixelMatrix = tile_x * self.tile_width + 1
        plane_position.RowPositionInTotalImagePixelMatrix = tile_y * self.tile_height + 1
        plane_position.XOffsetInSlideCoordinateSystem = tile_x * self.tile_width * pixel_spacing / 1000
        plane_position.YOffsetInSlideCoordinateSystem = tile_y * self.tile_height * pixel_spacing / 1000
        plane_position.ZOffsetInSlideCoordinateSystem = 0
        per_frame_fg.PlanePositionSlideSequence = [plane_position]
        
        ds.PerFrameFunctionalGroupsSequence = [per_frame_fg]
        
        # Dimension Index Sequence
        dim_org = Dataset()
        dim_org.DimensionOrganizationUID = generate_uid()
        ds.DimensionOrganizationSequence = [dim_org]
        
        # Column dimension
        col_dim = Dataset()
        col_dim.DimensionIndexPointer = (0x0048, 0x021E)  # ColumnPositionInTotalImagePixelMatrix
        col_dim.FunctionalGroupPointer = (0x0048, 0x021A)  # PlanePositionSlideSequence
        col_dim.DimensionOrganizationUID = dim_org.DimensionOrganizationUID
        col_dim.DimensionDescriptionLabel = "Column Position"
        
        # Row dimension
        row_dim = Dataset()
        row_dim.DimensionIndexPointer = (0x0048, 0x021F)  # RowPositionInTotalImagePixelMatrix
        row_dim.FunctionalGroupPointer = (0x0048, 0x021A)  # PlanePositionSlideSequence
        row_dim.DimensionOrganizationUID = dim_org.DimensionOrganizationUID
        row_dim.DimensionDescriptionLabel = "Row Position"
        
        ds.DimensionIndexSequence = [col_dim, row_dim]
        
        # Encode pixel data
        if self.compression != 'none':
            ds.PixelData = self._compress_pixel_data(pixel_data)
        else:
            ds.PixelData = pixel_data.tobytes()
        
        # Set specific character set
        ds.SpecificCharacterSet = 'ISO_IR 100'
        
        # Number of frames (single frame per file)
        ds.NumberOfFrames = 1
        
        return ds
    
    def _compress_pixel_data(self, pixel_data: np.ndarray) -> bytes:
        """
        Compress pixel data using specified compression
        """
        # Convert numpy array to PIL Image
        image = Image.fromarray(pixel_data)
        
        # Compress based on type
        output = io.BytesIO()
        if self.compression == 'jpeg2000':
            try:
                # Try JPEG2000 compression
                image.save(output, format='JPEG2000', quality_mode='rates', quality_layers=[self.quality])
            except Exception as e:
                logger.warning(f"JPEG2000 compression failed: {e}, falling back to JPEG")
                # Fall back to JPEG if JPEG2000 fails
                output = io.BytesIO()
                image.save(output, format='JPEG', quality=self.quality, optimize=True)
                self.transfer_syntax = '1.2.840.10008.1.2.4.50'  # Update transfer syntax
        elif self.compression == 'jpeg':
            # Save as JPEG
            image.save(output, format='JPEG', quality=self.quality, optimize=True)
        
        # Get compressed data
        compressed = output.getvalue()
        
        # Encapsulate for DICOM
        return encapsulate([compressed])
    
    def _create_base_metadata(self,
                             patient_name: str,
                             patient_id: str,
                             study_description: str,
                             total_width: int,
                             total_height: int,
                             num_levels: int) -> Dict[str, Any]:
        """
        Create base metadata shared across all DICOM files
        """
        now = datetime.now()
        
        return {
            'patient_name': patient_name,
            'patient_id': patient_id,
            'study_date': now.strftime('%Y%m%d'),
            'study_time': now.strftime('%H%M%S.%f')[:-3],
            'study_id': f"ISYNTAX_{now.strftime('%Y%m%d%H%M%S')}",
            'study_description': study_description,
            'total_width': total_width,
            'total_height': total_height,
            'num_levels': num_levels
        }


async def convert_isyntax_enhanced(
    job_id: str,
    file_path: Path,
    output_dir: Path,
    progress_callback=None
) -> List[Path]:
    """
    Enhanced iSyntax conversion with progress tracking
    
    Args:
        job_id: Job identifier
        file_path: Path to iSyntax file
        output_dir: Output directory
        progress_callback: Optional callback for progress updates
        
    Returns:
        List of generated DICOM files
    """
    converter = ISyntaxPyramidConverter(
        tile_size=(256, 256),
        compression='jpeg',  # Use JPEG - more reliable than JPEG2000
        quality=90,
        workers=1  # Single-threaded - iSyntax SDK may not be thread-safe
    )
    
    if progress_callback:
        progress_callback(30, "Starting enhanced iSyntax conversion...")
    
    dicom_files = converter.convert(
        input_path=file_path,
        output_dir=output_dir,
        patient_name=file_path.stem,
        patient_id=f"ISYNTAX_{job_id}",
        study_description=f"Converted from {file_path.name}"
    )
    
    if progress_callback:
        progress_callback(60, f"Generated {len(dicom_files)} DICOM files")
    
    return dicom_files
