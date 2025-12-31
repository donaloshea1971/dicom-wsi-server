#!/usr/bin/env python3
"""
C-STORE Validation Test Suite for Orthanc DICOM Server

This script tests DICOM C-STORE (DIMSE protocol) functionality by:
1. Sending DICOM files via C-STORE to Orthanc
2. Verifying successful storage via response status
3. Confirming files are queryable via REST API
4. Testing error conditions and batch operations

Author: Diagnexia DICOM WSI Server Team
"""

import os
import sys
import time
import json
import argparse
from pathlib import Path
from typing import List, Dict, Optional, Tuple
from datetime import datetime

import requests
from pydicom import dcmread, Dataset
from pydicom.uid import generate_uid, ImplicitVRLittleEndian
from pynetdicom import AE, evt, StoragePresentationContexts
from pynetdicom.sop_class import (
    VLWholeSlideMicroscopyImageStorage,
    SecondaryCaptureImageStorage,
    CTImageStorage,
    MRImageStorage,
)
from colorama import init, Fore, Style

# Initialize colorama for cross-platform colored output
init(autoreset=True)

class OrthancCStoreValidator:
    """Validates C-STORE functionality for Orthanc DICOM server"""
    
    def __init__(self, 
                 orthanc_host: str = "localhost",
                 orthanc_dicom_port: int = 4242,
                 orthanc_http_port: int = 8042,
                 orthanc_aet: str = "DIAGNEXIA",
                 calling_aet: str = "PYNETDICOM",
                 username: str = "admin",
                 password: str = "orthanc"):
        """
        Initialize the validator with Orthanc connection parameters
        
        Args:
            orthanc_host: Hostname or IP of Orthanc server
            orthanc_dicom_port: DICOM port (default 4242)
            orthanc_http_port: HTTP/REST API port (default 8042)
            orthanc_aet: Application Entity Title of Orthanc
            calling_aet: AE Title of this client
            username: HTTP Basic Auth username
            password: HTTP Basic Auth password
        """
        self.orthanc_host = orthanc_host
        self.orthanc_dicom_port = orthanc_dicom_port
        self.orthanc_http_port = orthanc_http_port
        self.orthanc_aet = orthanc_aet
        self.calling_aet = calling_aet
        self.auth = (username, password)
        self.base_url = f"http://{orthanc_host}:{orthanc_http_port}"
        
        # Track test results
        self.results = {
            "passed": 0,
            "failed": 0,
            "errors": []
        }
    
    def print_header(self, text: str) -> None:
        """Print a formatted header"""
        print(f"\n{Fore.CYAN}{'='*60}")
        print(f"{text:^60}")
        print(f"{'='*60}{Style.RESET_ALL}\n")
    
    def print_test(self, test_name: str) -> None:
        """Print test name"""
        print(f"{Fore.YELLOW}[TEST]{Style.RESET_ALL} {test_name}")
    
    def print_success(self, message: str) -> None:
        """Print success message"""
        print(f"{Fore.GREEN}[PASS]{Style.RESET_ALL} {message}")
        self.results["passed"] += 1
    
    def print_error(self, message: str) -> None:
        """Print error message"""
        print(f"{Fore.RED}[FAIL]{Style.RESET_ALL} {message}")
        self.results["failed"] += 1
        self.results["errors"].append(message)
    
    def print_info(self, message: str) -> None:
        """Print info message"""
        print(f"{Fore.BLUE}[INFO]{Style.RESET_ALL} {message}")
    
    def verify_orthanc_connection(self) -> bool:
        """Verify Orthanc HTTP REST API is accessible"""
        self.print_test("Verifying Orthanc HTTP connection")
        
        try:
            response = requests.get(f"{self.base_url}/system", auth=self.auth, timeout=5)
            if response.status_code == 200:
                system_info = response.json()
                self.print_success(f"Connected to Orthanc {system_info.get('Version', 'Unknown')}")
                self.print_info(f"DICOM AET: {system_info.get('DicomAet', 'Unknown')}")
                self.print_info(f"DICOM Port: {system_info.get('DicomPort', 'Unknown')}")
                return True
            else:
                self.print_error(f"HTTP connection failed: {response.status_code}")
                return False
        except Exception as e:
            self.print_error(f"Cannot connect to Orthanc HTTP API: {e}")
            return False
    
    def create_test_dicom(self, modality: str = "CT", patient_name: str = "TEST^PATIENT") -> Dataset:
        """Create a minimal test DICOM dataset"""
        ds = Dataset()
        
        # Patient Module
        ds.PatientName = patient_name
        ds.PatientID = f"PID_{int(time.time())}"
        ds.PatientBirthDate = "19800101"
        ds.PatientSex = "M"
        
        # Study Module
        ds.StudyInstanceUID = generate_uid()
        ds.StudyDate = datetime.now().strftime("%Y%m%d")
        ds.StudyTime = datetime.now().strftime("%H%M%S")
        ds.StudyID = f"STUDY_{int(time.time())}"
        ds.AccessionNumber = ""
        ds.ReferringPhysicianName = ""
        ds.StudyDescription = "C-STORE Test Study"
        
        # Series Module
        ds.SeriesInstanceUID = generate_uid()
        ds.SeriesNumber = 1
        ds.Modality = modality
        ds.SeriesDescription = "C-STORE Test Series"
        
        # Image Module
        ds.SOPClassUID = CTImageStorage if modality == "CT" else MRImageStorage
        ds.SOPInstanceUID = generate_uid()
        ds.InstanceNumber = 1
        
        # Pixel Data (minimal 2x2 image)
        ds.Rows = 2
        ds.Columns = 2
        ds.BitsAllocated = 16
        ds.BitsStored = 12
        ds.HighBit = 11
        ds.PixelRepresentation = 0
        ds.SamplesPerPixel = 1
        ds.PhotometricInterpretation = "MONOCHROME2"
        ds.PixelData = b'\x00\x00\x00\x00\x00\x00\x00\x00'
        
        # Set transfer syntax
        ds.file_meta = Dataset()
        ds.file_meta.TransferSyntaxUID = ImplicitVRLittleEndian
        
        return ds
    
    def send_c_store(self, dataset: Dataset, test_name: str = "Single C-STORE") -> Tuple[bool, str]:
        """
        Send a single DICOM dataset via C-STORE
        
        Returns:
            Tuple of (success, message)
        """
        self.print_test(test_name)
        
        # Initialize Application Entity
        ae = AE(ae_title=self.calling_aet)
        
        # Add presentation contexts
        ae.requested_contexts = StoragePresentationContexts
        
        # Add WSI context specifically
        ae.add_requested_context(VLWholeSlideMicroscopyImageStorage)
        
        try:
            # Associate with Orthanc
            self.print_info(f"Connecting to {self.orthanc_aet}@{self.orthanc_host}:{self.orthanc_dicom_port}")
            assoc = ae.associate(self.orthanc_host, self.orthanc_dicom_port, ae_title=self.orthanc_aet)
            
            if assoc.is_established:
                self.print_info("Association established")
                
                # Send C-STORE
                status = assoc.send_c_store(dataset)
                
                if status:
                    # Check status
                    if status.Status == 0x0000:  # Success
                        self.print_success(f"C-STORE successful for {dataset.SOPInstanceUID}")
                        assoc.release()
                        return True, "Success"
                    else:
                        error_msg = f"C-STORE failed with status 0x{status.Status:04X}"
                        self.print_error(error_msg)
                        assoc.release()
                        return False, error_msg
                else:
                    self.print_error("No status received")
                    assoc.release()
                    return False, "No status received"
            else:
                self.print_error("Association rejected or aborted")
                return False, "Association failed"
                
        except Exception as e:
            error_msg = f"C-STORE error: {e}"
            self.print_error(error_msg)
            return False, error_msg
    
    def verify_instance_via_rest(self, sop_instance_uid: str, timeout: int = 10) -> bool:
        """Verify instance exists in Orthanc via REST API"""
        self.print_test("Verifying instance via REST API")
        
        # Wait a bit for Orthanc to process
        time.sleep(1)
        
        # Search for instance
        end_time = time.time() + timeout
        while time.time() < end_time:
            try:
                # Use tools/find to search by SOPInstanceUID
                response = requests.post(
                    f"{self.base_url}/tools/find",
                    auth=self.auth,
                    json={
                        "Level": "Instance",
                        "Query": {
                            "SOPInstanceUID": sop_instance_uid
                        }
                    }
                )
                
                if response.status_code == 200:
                    instances = response.json()
                    if instances:
                        instance_id = instances[0]
                        self.print_success(f"Instance found: {instance_id}")
                        
                        # Get instance details
                        detail_response = requests.get(
                            f"{self.base_url}/instances/{instance_id}",
                            auth=self.auth
                        )
                        
                        if detail_response.status_code == 200:
                            details = detail_response.json()
                            self.print_info(f"Patient: {details['MainDicomTags'].get('PatientName', 'Unknown')}")
                            self.print_info(f"Study: {details['MainDicomTags'].get('StudyDescription', 'Unknown')}")
                            return True
                        
            except Exception as e:
                self.print_info(f"Waiting for instance... ({e})")
            
            time.sleep(0.5)
        
        self.print_error(f"Instance {sop_instance_uid} not found in Orthanc after {timeout}s")
        return False
    
    def test_single_c_store(self) -> bool:
        """Test single file C-STORE"""
        self.print_header("Test 1: Single File C-STORE")
        
        # Create test dataset
        ds = self.create_test_dicom(modality="CT", patient_name="CSTORE^TEST^ONE")
        sop_uid = ds.SOPInstanceUID
        
        # Send via C-STORE
        success, message = self.send_c_store(ds, "Single CT Image C-STORE")
        
        if success:
            # Verify via REST
            return self.verify_instance_via_rest(sop_uid)
        
        return False
    
    def test_batch_c_store(self, count: int = 5) -> bool:
        """Test batch C-STORE of multiple files"""
        self.print_header(f"Test 2: Batch C-STORE ({count} files)")
        
        # Create multiple datasets
        datasets = []
        for i in range(count):
            ds = self.create_test_dicom(
                modality="MR" if i % 2 == 0 else "CT",
                patient_name=f"BATCH^TEST^{i+1:03d}"
            )
            datasets.append(ds)
        
        # Initialize AE once for batch
        ae = AE(ae_title=self.calling_aet)
        ae.requested_contexts = StoragePresentationContexts
        
        try:
            # Associate once
            self.print_info(f"Establishing association for batch transfer...")
            assoc = ae.associate(self.orthanc_host, self.orthanc_dicom_port, ae_title=self.orthanc_aet)
            
            if assoc.is_established:
                success_count = 0
                
                for i, ds in enumerate(datasets):
                    self.print_info(f"Sending file {i+1}/{count}...")
                    status = assoc.send_c_store(ds)
                    
                    if status and status.Status == 0x0000:
                        success_count += 1
                        self.print_success(f"Sent {ds.SOPInstanceUID}")
                    else:
                        self.print_error(f"Failed to send file {i+1}")
                
                assoc.release()
                self.print_info(f"Batch complete: {success_count}/{count} successful")
                
                # Verify all instances
                if success_count == count:
                    self.print_test("Verifying batch via REST API")
                    verified = 0
                    for ds in datasets:
                        if self.verify_instance_via_rest(ds.SOPInstanceUID, timeout=5):
                            verified += 1
                    
                    if verified == count:
                        self.print_success(f"All {count} instances verified")
                        return True
                    else:
                        self.print_error(f"Only {verified}/{count} instances verified")
                        return False
                
            else:
                self.print_error("Failed to establish association for batch")
                return False
                
        except Exception as e:
            self.print_error(f"Batch C-STORE error: {e}")
            return False
    
    def test_wrong_aet(self) -> bool:
        """Test C-STORE with wrong AE Title (should succeed with current config)"""
        self.print_header("Test 3: Wrong AE Title Handling")
        
        ds = self.create_test_dicom(patient_name="WRONG^AET^TEST")
        
        ae = AE(ae_title=self.calling_aet)
        ae.requested_contexts = StoragePresentationContexts
        
        try:
            # Try with wrong AET
            self.print_info("Attempting connection with wrong AET...")
            assoc = ae.associate(self.orthanc_host, self.orthanc_dicom_port, ae_title="WRONGAET")
            
            if assoc.is_established:
                self.print_info("Association accepted (DicomCheckCalledAet=false)")
                status = assoc.send_c_store(ds)
                assoc.release()
                
                if status and status.Status == 0x0000:
                    self.print_success("C-STORE accepted with wrong AET (as expected)")
                    return True
                else:
                    self.print_error("C-STORE failed despite association")
                    return False
            else:
                self.print_error("Association rejected (unexpected)")
                return False
                
        except Exception as e:
            self.print_error(f"Error: {e}")
            return False
    
    def test_large_file(self, size_mb: int = 10) -> bool:
        """Test C-STORE with larger file"""
        self.print_header(f"Test 4: Large File C-STORE ({size_mb}MB)")
        
        ds = self.create_test_dicom(patient_name="LARGE^FILE^TEST")
        
        # Create larger pixel data
        rows = 1024
        cols = int((size_mb * 1024 * 1024) / (rows * 2))  # 2 bytes per pixel
        ds.Rows = rows
        ds.Columns = cols
        ds.PixelData = b'\x00\x00' * (rows * cols)
        
        self.print_info(f"Created {rows}x{cols} image (~{len(ds.PixelData)/1024/1024:.1f}MB)")
        
        success, message = self.send_c_store(ds, f"Large File C-STORE")
        
        if success:
            return self.verify_instance_via_rest(ds.SOPInstanceUID)
        
        return False
    
    def test_wsi_file(self, wsi_path: Optional[Path] = None) -> bool:
        """Test C-STORE with WSI file if available"""
        self.print_header("Test 5: WSI File C-STORE")
        
        if not wsi_path:
            # Try to find a WSI file
            test_paths = [
                Path("testdata/wsi_sample.dcm"),
                Path("../testdata/wsi_sample.dcm"),
                Path("test_data/sample_wsi.dcm")
            ]
            
            for path in test_paths:
                if path.exists():
                    wsi_path = path
                    break
            
            if not wsi_path:
                self.print_info("No WSI test file found, creating minimal WSI dataset")
                
                # Create minimal WSI dataset
                ds = Dataset()
                
                # Basic patient/study/series info
                ds.PatientName = "WSI^TEST^PATIENT"
                ds.PatientID = f"WSI_{int(time.time())}"
                ds.StudyInstanceUID = generate_uid()
                ds.SeriesInstanceUID = generate_uid()
                ds.SOPClassUID = VLWholeSlideMicroscopyImageStorage
                ds.SOPInstanceUID = generate_uid()
                ds.Modality = "SM"  # Slide Microscopy
                
                # WSI specific tags
                ds.ImageType = ["DERIVED", "PRIMARY", "VOLUME", "NONE"]
                ds.DimensionOrganizationType = "TILED_FULL"
                ds.NumberOfFrames = 1
                
                # Minimal pixel data
                ds.Rows = 256
                ds.Columns = 256
                ds.TotalPixelMatrixRows = 256
                ds.TotalPixelMatrixColumns = 256
                ds.SamplesPerPixel = 3
                ds.PhotometricInterpretation = "RGB"
                ds.BitsAllocated = 8
                ds.BitsStored = 8
                ds.HighBit = 7
                ds.PixelRepresentation = 0
                ds.PixelData = b'\x00' * (256 * 256 * 3)
                
                ds.file_meta = Dataset()
                ds.file_meta.TransferSyntaxUID = ImplicitVRLittleEndian
                
                success, message = self.send_c_store(ds, "Minimal WSI C-STORE")
                
                if success:
                    return self.verify_instance_via_rest(ds.SOPInstanceUID)
                return False
        
        else:
            # Load and send existing WSI file
            self.print_info(f"Loading WSI file: {wsi_path}")
            try:
                ds = dcmread(str(wsi_path))
                self.print_info(f"WSI dimensions: {ds.get('TotalPixelMatrixRows', 'N/A')}x{ds.get('TotalPixelMatrixColumns', 'N/A')}")
                self.print_info(f"Number of frames: {ds.get('NumberOfFrames', 'N/A')}")
                
                success, message = self.send_c_store(ds, "WSI File C-STORE")
                
                if success:
                    return self.verify_instance_via_rest(ds.SOPInstanceUID)
                return False
                
            except Exception as e:
                self.print_error(f"Failed to load WSI file: {e}")
                return False
    
    def run_all_tests(self) -> None:
        """Run all C-STORE validation tests"""
        self.print_header("C-STORE Validation Suite for Orthanc")
        self.print_info(f"Target: {self.orthanc_aet}@{self.orthanc_host}:{self.orthanc_dicom_port}")
        self.print_info(f"Calling AET: {self.calling_aet}")
        
        # First verify HTTP connection
        if not self.verify_orthanc_connection():
            self.print_error("Cannot proceed without HTTP connection")
            return
        
        # Run tests
        tests = [
            self.test_single_c_store,
            self.test_batch_c_store,
            self.test_wrong_aet,
            self.test_large_file,
            self.test_wsi_file
        ]
        
        for test in tests:
            try:
                test()
            except Exception as e:
                self.print_error(f"Test exception: {e}")
        
        # Print summary
        self.print_header("Test Summary")
        total = self.results["passed"] + self.results["failed"]
        self.print_info(f"Total tests: {total}")
        self.print_success(f"Passed: {self.results['passed']}")
        
        if self.results["failed"] > 0:
            self.print_error(f"Failed: {self.results['failed']}")
            print("\nFailed tests:")
            for error in self.results["errors"]:
                print(f"  - {error}")
        
        # Overall result
        if self.results["failed"] == 0:
            print(f"\n{Fore.GREEN}[✓] All C-STORE tests passed!{Style.RESET_ALL}")
        else:
            print(f"\n{Fore.RED}[✗] Some tests failed. Check configuration.{Style.RESET_ALL}")


def main():
    """Main entry point"""
    parser = argparse.ArgumentParser(description="C-STORE Validation for Orthanc DICOM Server")
    parser.add_argument("--host", default="localhost", help="Orthanc hostname (default: localhost)")
    parser.add_argument("--dicom-port", type=int, default=4242, help="DICOM port (default: 4242)")
    parser.add_argument("--http-port", type=int, default=8042, help="HTTP port (default: 8042)")
    parser.add_argument("--aet", default="DIAGNEXIA", help="Orthanc AE Title (default: DIAGNEXIA)")
    parser.add_argument("--calling-aet", default="PYNETDICOM", help="Calling AE Title (default: PYNETDICOM)")
    parser.add_argument("--username", default="admin", help="HTTP username (default: admin)")
    parser.add_argument("--password", default="orthanc", help="HTTP password (default: orthanc)")
    parser.add_argument("--wsi-file", type=Path, help="Path to WSI DICOM file for testing")
    
    args = parser.parse_args()
    
    # Create validator
    validator = OrthancCStoreValidator(
        orthanc_host=args.host,
        orthanc_dicom_port=args.dicom_port,
        orthanc_http_port=args.http_port,
        orthanc_aet=args.aet,
        calling_aet=args.calling_aet,
        username=args.username,
        password=args.password
    )
    
    # Run tests
    validator.run_all_tests()


if __name__ == "__main__":
    main()
