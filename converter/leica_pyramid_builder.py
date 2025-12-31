#!/usr/bin/env python3
"""
Leica Pyramid Builder
Groups separate Leica DICOM files into a virtual pyramid structure
"""

import logging
from pathlib import Path
from typing import List, Dict, Tuple
import pydicom
from pydicom.uid import generate_uid
import numpy as np

logger = logging.getLogger(__name__)

def analyze_leica_files(dicom_files: List[Path]) -> Dict[str, List[Tuple[Path, int, int]]]:
    """
    Analyze Leica DICOM files and group them by series/study
    Returns dict of study_uid -> [(file_path, width, height), ...]
    """
    studies = {}
    
    for file_path in dicom_files:
        try:
            ds = pydicom.dcmread(file_path, stop_before_pixels=True)
            
            # Get key identifiers
            study_uid = getattr(ds, 'StudyInstanceUID', 'unknown')
            patient_name = str(getattr(ds, 'PatientName', 'unknown'))
            
            # Get image dimensions
            width = int(ds.Columns)
            height = int(ds.Rows)
            
            # Group by study
            key = f"{study_uid}_{patient_name}"
            if key not in studies:
                studies[key] = []
            
            studies[key].append((file_path, width, height))
            logger.info(f"Found Leica file: {file_path.name} - {width}x{height}")
            
        except Exception as e:
            logger.error(f"Error reading {file_path}: {e}")
    
    # Sort each study's files by resolution (largest first)
    for key in studies:
        studies[key].sort(key=lambda x: x[1] * x[2], reverse=True)
    
    return studies

def create_pyramid_series(leica_files: List[Tuple[Path, int, int]], output_dir: Path) -> List[Path]:
    """
    Create a new DICOM series that references all resolution levels as a pyramid
    """
    if not leica_files:
        return []
    
    output_files = []
    
    # Read the highest resolution file as base
    base_path, base_width, base_height = leica_files[0]
    base_ds = pydicom.dcmread(base_path)
    
    # Create new Series and Study UIDs for the pyramid
    pyramid_series_uid = generate_uid()
    pyramid_study_uid = getattr(base_ds, 'StudyInstanceUID', generate_uid())
    
    logger.info(f"Creating pyramid series with {len(leica_files)} levels")
    
    for idx, (file_path, width, height) in enumerate(leica_files):
        try:
            # Read the source file
            ds = pydicom.dcmread(file_path)
            
            # Create new instance for pyramid
            new_ds = ds.copy()
            
            # Update UIDs
            new_ds.SeriesInstanceUID = pyramid_series_uid
            new_ds.SOPInstanceUID = generate_uid()
            
            # Add pyramid-specific tags
            new_ds.ImageType = ['ORIGINAL', 'PRIMARY', 'VOLUME', 'NONE']
            
            # Set instance number based on resolution level
            new_ds.InstanceNumber = str(idx + 1)
            
            # Add private tags to indicate pyramid level
            # Using private creator 0x0009
            new_ds.add_new(0x0009, 0x0010, 'LO', 'LEICA_PYRAMID')
            new_ds.add_new(0x0009, 0x1001, 'US', idx)  # Pyramid level
            new_ds.add_new(0x0009, 0x1002, 'UL', base_width)  # Base width
            new_ds.add_new(0x0009, 0x1003, 'UL', base_height)  # Base height
            
            # Calculate downsampling factor
            downsample_factor = base_width / width
            new_ds.add_new(0x0009, 0x1004, 'FL', downsample_factor)
            
            # Update series description
            new_ds.SeriesDescription = f"Leica Pyramid Level {idx} ({width}x{height})"
            
            # Save the new file
            output_path = output_dir / f"pyramid_level_{idx}_{file_path.name}"
            new_ds.save_as(output_path)
            output_files.append(output_path)
            
            logger.info(f"Created pyramid level {idx}: {width}x{height}, downsample={downsample_factor:.2f}")
            
        except Exception as e:
            logger.error(f"Error processing {file_path}: {e}")
    
    return output_files

def build_leica_pyramids(input_dir: Path, output_dir: Path) -> Dict[str, List[Path]]:
    """
    Find all Leica files and build pyramid series
    """
    # Find all DICOM files
    dicom_files = list(input_dir.glob("*.dcm"))
    logger.info(f"Found {len(dicom_files)} DICOM files in {input_dir}")
    
    # Analyze and group files
    studies = analyze_leica_files(dicom_files)
    
    # Create output directory
    output_dir.mkdir(parents=True, exist_ok=True)
    
    # Build pyramid for each study
    results = {}
    for study_key, files in studies.items():
        logger.info(f"\nProcessing study: {study_key}")
        logger.info(f"Found {len(files)} resolution levels")
        
        # Create pyramid series
        pyramid_files = create_pyramid_series(files, output_dir)
        if pyramid_files:
            results[study_key] = pyramid_files
    
    return results

def create_wsi_metadata_for_leica(leica_files: List[Tuple[Path, int, int]]) -> Dict:
    """
    Create WSI metadata structure that the viewer expects
    """
    if not leica_files:
        return {}
    
    # Get base dimensions from highest resolution
    base_width = leica_files[0][1]
    base_height = leica_files[0][2]
    
    # Build resolutions array
    resolutions = []
    sizes = []
    
    for _, width, height in leica_files:
        downsample = base_width / width
        resolutions.append(downsample)
        sizes.append([width, height])
    
    metadata = {
        "TotalWidth": base_width,
        "TotalHeight": base_height,
        "Resolutions": resolutions,
        "Sizes": sizes,
        "TilesSizes": [[256, 256]] * len(resolutions),  # Standard tile size
        "BackgroundColor": "#ffffff"
    }
    
    return metadata

if __name__ == "__main__":
    import sys
    
    if len(sys.argv) < 3:
        print("Usage: python leica_pyramid_builder.py <input_dir> <output_dir>")
        sys.exit(1)
    
    logging.basicConfig(level=logging.INFO)
    
    input_dir = Path(sys.argv[1])
    output_dir = Path(sys.argv[2])
    
    results = build_leica_pyramids(input_dir, output_dir)
    
    print(f"\nCreated {len(results)} pyramid series")
    for study, files in results.items():
        print(f"  {study}: {len(files)} files")
