#!/usr/bin/env python3
"""
C-STORE Proxy Service

This service acts as a DICOM C-STORE SCP (server) that receives DICOM files
and forwards them to Orthanc via REST API, bypassing the C-STORE bug in
Orthanc mainline version.

Features:
- Receives C-STORE requests on port 4243
- Forwards files to Orthanc REST API
- Supports all DICOM SOP classes
- Handles compressed transfer syntaxes
- Provides detailed logging
"""

import os
import sys
import time
import logging
import tempfile
from datetime import datetime
from typing import Optional, Dict, Any

import requests
from pydicom import dcmread
from pynetdicom import AE, evt, ALL_TRANSFER_SYNTAXES, StoragePresentationContexts
from pynetdicom.sop_class import VLWholeSlideMicroscopyImageStorage
from pydicom.uid import (
    ImplicitVRLittleEndian,
    ExplicitVRLittleEndian,
    ExplicitVRBigEndian,
    JPEGBaseline8Bit,
    JPEGExtended12Bit,
    JPEGLossless,
    JPEGLosslessSV1,
    JPEGLSLossless,
    JPEGLSNearLossless,
    JPEG2000Lossless,
    JPEG2000,
    RLELossless,
)

# Extended transfer syntaxes including all JPEG variants
EXTENDED_TRANSFER_SYNTAXES = [
    ImplicitVRLittleEndian,
    ExplicitVRLittleEndian,
    ExplicitVRBigEndian,
    JPEGBaseline8Bit,        # 1.2.840.10008.1.2.4.50 - JPEG Baseline (Process 1)
    JPEGExtended12Bit,       # 1.2.840.10008.1.2.4.51 - JPEG Extended (Process 2 & 4)
    JPEGLossless,            # 1.2.840.10008.1.2.4.57 - JPEG Lossless
    JPEGLosslessSV1,         # 1.2.840.10008.1.2.4.70 - JPEG Lossless SV1
    JPEGLSLossless,          # 1.2.840.10008.1.2.4.80 - JPEG-LS Lossless
    JPEGLSNearLossless,      # 1.2.840.10008.1.2.4.81 - JPEG-LS Near Lossless
    JPEG2000Lossless,        # 1.2.840.10008.1.2.4.90 - JPEG 2000 Lossless
    JPEG2000,                # 1.2.840.10008.1.2.4.91 - JPEG 2000
    RLELossless,             # 1.2.840.10008.1.2.5 - RLE Lossless
]

# Configuration from environment
ORTHANC_URL = os.environ.get("ORTHANC_URL", "http://localhost:8042")
ORTHANC_USERNAME = os.environ.get("ORTHANC_USERNAME", "admin")
ORTHANC_PASSWORD = os.environ.get("ORTHANC_PASSWORD", "orthanc")
PROXY_AET = os.environ.get("PROXY_AET", "CSTORE_PROXY")
PROXY_PORT = int(os.environ.get("PROXY_PORT", "4243"))

# Set up logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger(__name__)


class CStoreProxy:
    """C-STORE Proxy that forwards to Orthanc REST API"""
    
    def __init__(self):
        self.orthanc_url = ORTHANC_URL
        self.orthanc_auth = (ORTHANC_USERNAME, ORTHANC_PASSWORD)
        self.stats = {
            "received": 0,
            "forwarded": 0,
            "failed": 0
        }
        self.last_log_time = time.time()
        
    def handle_store(self, event):
        """Handle C-STORE requests"""
        self.stats["received"] += 1
        
        try:
            # Get dataset
            dataset = event.dataset
            
            # Get transfer syntax UID as string
            ts_uid = str(event.context.transfer_syntax[0])
            
            # Determine endianness and VR based on transfer syntax
            # Most transfer syntaxes are little endian explicit VR
            # Only Implicit VR Little Endian (1.2.840.10008.1.2) is implicit
            # Only Explicit VR Big Endian (1.2.840.10008.1.2.2) is big endian
            dataset.is_little_endian = (ts_uid != '1.2.840.10008.1.2.2')  # Not Big Endian
            dataset.is_implicit_VR = (ts_uid == '1.2.840.10008.1.2')  # Implicit VR Little Endian
            
            # Get metadata
            patient_name = str(dataset.get("PatientName", "Unknown"))
            study_uid = str(dataset.get("StudyInstanceUID", "Unknown"))
            series_uid = str(dataset.get("SeriesInstanceUID", "Unknown"))
            sop_uid = str(dataset.get("SOPInstanceUID", "Unknown"))
            modality = str(dataset.get("Modality", "Unknown"))
            
            logger.info(f"C-STORE received: Patient={patient_name}, "
                       f"Modality={modality}, SOP={sop_uid}")
            
            # Save to temporary file
            with tempfile.NamedTemporaryFile(mode='wb', suffix='.dcm', delete=False) as tmp_file:
                tmp_path = tmp_file.name
                
                # Set file meta information
                dataset.file_meta = event.file_meta
                dataset.save_as(tmp_file, write_like_original=False)
            
            # Forward to Orthanc
            success = self.forward_to_orthanc(tmp_path, sop_uid)
            
            if success:
                self.stats["forwarded"] += 1
                status = 0x0000  # Success
            else:
                self.stats["failed"] += 1
                status = 0xC000  # Error - cannot process
                
            # Log stats periodically
            current_time = time.time()
            if current_time - self.last_log_time > 30:
                self.log_stats()
                self.last_log_time = current_time
                
            return status
            
        except Exception as e:
            logger.error(f"Error handling C-STORE: {e}")
            self.stats["failed"] += 1
            return 0xC000  # Error - cannot process
        finally:
            # Clean up temporary file
            if 'tmp_path' in locals() and os.path.exists(tmp_path):
                try:
                    os.unlink(tmp_path)
                except:
                    pass
    
    def forward_to_orthanc(self, file_path: str, sop_uid: str) -> bool:
        """Forward DICOM file to Orthanc via REST API"""
        try:
            # Read file
            with open(file_path, 'rb') as f:
                dicom_data = f.read()
            
            # Upload to Orthanc (long timeout for large WSI files)
            response = requests.post(
                f"{self.orthanc_url}/instances",
                auth=self.orthanc_auth,
                data=dicom_data,
                headers={"Content-Type": "application/dicom"},
                timeout=1800  # 30 minutes for large WSI files
            )
            
            if response.status_code == 200:
                result = response.json()
                instance_id = result.get("ID", "Unknown")
                logger.info(f"Uploaded to Orthanc: Instance ID={instance_id}")
                return True
            else:
                logger.error(f"Orthanc upload failed: {response.status_code} - {response.text}")
                return False
                
        except Exception as e:
            logger.error(f"Error forwarding to Orthanc: {e}")
            return False
    
    def log_stats(self):
        """Log current statistics"""
        logger.info(f"Stats: Received={self.stats['received']}, "
                   f"Forwarded={self.stats['forwarded']}, "
                   f"Failed={self.stats['failed']}")


def handle_echo(event):
    """Handle C-ECHO (ping) requests"""
    logger.info(f"Received C-ECHO from {event.assoc.requestor.ae_title}")
    return 0x0000


def handle_association(event):
    """Handle new associations"""
    logger.info(f"Association received from {event.assoc.requestor.ae_title} "
               f"at {event.assoc.requestor.address}:{event.assoc.requestor.port}")


def main():
    """Main entry point"""
    logger.info(f"Starting C-STORE Proxy Service")
    logger.info(f"Proxy AET: {PROXY_AET}")
    logger.info(f"Proxy Port: {PROXY_PORT}")
    logger.info(f"Orthanc URL: {ORTHANC_URL}")
    
    # Create proxy instance
    proxy = CStoreProxy()
    
    # Create Application Entity
    ae = AE(ae_title=PROXY_AET)
    
    # Add all storage presentation contexts with extended transfer syntaxes (including JPEG)
    for context in StoragePresentationContexts:
        ae.add_supported_context(
            context.abstract_syntax,
            EXTENDED_TRANSFER_SYNTAXES,
            scp_role=True,
            scu_role=False
        )
    
    # Ensure WSI is supported with all JPEG variants (critical for 3DHISTECH, etc.)
    ae.add_supported_context(
        VLWholeSlideMicroscopyImageStorage,
        EXTENDED_TRANSFER_SYNTAXES,
        scp_role=True,
        scu_role=False
    )
    
    logger.info(f"Supporting {len(StoragePresentationContexts) + 1} SOP classes "
               f"with {len(EXTENDED_TRANSFER_SYNTAXES)} transfer syntaxes each (including JPEG)")
    
    # Set handlers
    handlers = [
        (evt.EVT_C_STORE, proxy.handle_store),
        (evt.EVT_C_ECHO, handle_echo),
        (evt.EVT_ACCEPTED, handle_association),
    ]
    
    # Start server
    logger.info(f"Starting DICOM server on port {PROXY_PORT}...")
    ae.start_server(
        ("0.0.0.0", PROXY_PORT),
        evt_handlers=handlers,
        block=True
    )


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        logger.info("Shutting down C-STORE Proxy...")
    except Exception as e:
        logger.error(f"Fatal error: {e}")
        sys.exit(1)