#!/usr/bin/env python3
"""
Create a sample DICOM file for testing C-STORE
"""

import numpy as np
from pydicom import Dataset, FileDataset
from pydicom.uid import generate_uid, ExplicitVRLittleEndian, CTImageStorage
from datetime import datetime
from pathlib import Path

def create_sample_dicom(filename="test_ct_image.dcm"):
    """Create a sample CT DICOM file with realistic data"""
    
    # Create file meta information
    file_meta = Dataset()
    file_meta.MediaStorageSOPClassUID = CTImageStorage
    file_meta.MediaStorageSOPInstanceUID = generate_uid()
    file_meta.TransferSyntaxUID = ExplicitVRLittleEndian
    file_meta.ImplementationClassUID = generate_uid()
    
    # Create the FileDataset
    ds = FileDataset(filename, {}, file_meta=file_meta, preamble=b"\0" * 128)
    
    # Patient Information
    ds.PatientName = "TEST^C-STORE^DEMO"
    ds.PatientID = "CSTORE001"
    ds.PatientBirthDate = "19800101"
    ds.PatientSex = "M"
    ds.PatientAge = "044Y"
    
    # Study Information
    ds.StudyInstanceUID = generate_uid()
    ds.StudyDate = datetime.now().strftime("%Y%m%d")
    ds.StudyTime = datetime.now().strftime("%H%M%S.%f")
    ds.StudyID = "CSTORE_TEST_001"
    ds.AccessionNumber = "ACC001"
    ds.StudyDescription = "C-STORE Protocol Test Study"
    ds.ReferringPhysicianName = "Dr. Test"
    
    # Series Information
    ds.SeriesInstanceUID = generate_uid()
    ds.SeriesNumber = 1
    ds.SeriesDate = ds.StudyDate
    ds.SeriesTime = ds.StudyTime
    ds.SeriesDescription = "Axial CT Images"
    ds.Modality = "CT"
    
    # Image Information
    ds.SOPClassUID = CTImageStorage
    ds.SOPInstanceUID = file_meta.MediaStorageSOPInstanceUID
    ds.InstanceNumber = 1
    ds.ImageType = ["ORIGINAL", "PRIMARY", "AXIAL"]
    
    # Image Pixel Data
    ds.Rows = 512
    ds.Columns = 512
    ds.BitsAllocated = 16
    ds.BitsStored = 12
    ds.HighBit = 11
    ds.PixelRepresentation = 0
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.PixelSpacing = [0.5, 0.5]
    
    # CT specific tags
    ds.RescaleIntercept = -1024
    ds.RescaleSlope = 1
    ds.WindowCenter = 40
    ds.WindowWidth = 400
    
    # Create a simple gradient image (512x512)
    # Simulating a circular phantom
    rows, cols = 512, 512
    center = (rows // 2, cols // 2)
    Y, X = np.ogrid[:rows, :cols]
    dist_from_center = np.sqrt((X - center[0])**2 + (Y - center[1])**2)
    
    # Create circular phantom with different densities
    pixel_array = np.zeros((rows, cols), dtype=np.uint16)
    
    # Background (air)
    pixel_array[:] = 0
    
    # Outer circle (water equivalent)
    mask1 = dist_from_center <= 200
    pixel_array[mask1] = 1024  # Water = 0 HU, stored as 1024
    
    # Inner circles (different materials)
    mask2 = dist_from_center <= 100
    pixel_array[mask2] = 1124  # Soft tissue ~100 HU
    
    mask3 = dist_from_center <= 50
    pixel_array[mask3] = 2048  # Bone ~1000 HU
    
    # Add some noise
    noise = np.random.normal(0, 10, pixel_array.shape).astype(np.int16)
    pixel_array = np.clip(pixel_array.astype(np.int16) + noise, 0, 4095).astype(np.uint16)
    
    ds.PixelData = pixel_array.tobytes()
    
    # Equipment Information
    ds.Manufacturer = "C-STORE Test Systems"
    ds.ManufacturerModelName = "Test Scanner v1.0"
    ds.StationName = "TESTSTATION01"
    
    # Save the file
    ds.save_as(filename, write_like_original=False)
    print(f"Created test DICOM file: {filename}")
    print(f"  Patient: {ds.PatientName}")
    print(f"  Study: {ds.StudyDescription}")
    print(f"  Size: {ds.Rows}x{ds.Columns}")
    print(f"  SOP Instance UID: {ds.SOPInstanceUID}")
    
    return filename

if __name__ == "__main__":
    create_sample_dicom()
