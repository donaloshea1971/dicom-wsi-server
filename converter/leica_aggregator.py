#!/usr/bin/env python3
"""
Leica Multi-File Aggregator
Aggregates separate Leica DICOM files into a unified multi-resolution pyramid
"""

import logging
import asyncio
from pathlib import Path
from typing import List, Dict, Optional
import pydicom
from pydicom.uid import generate_uid
import httpx

logger = logging.getLogger(__name__)

class LeicaAggregator:
    def __init__(self, orthanc_url: str = "http://orthanc:8042", auth: tuple = ("admin", "orthanc")):
        self.orthanc_url = orthanc_url
        self.auth = auth
        
    async def find_leica_studies(self) -> List[str]:
        """Find all studies that might contain Leica multi-file pyramids"""
        async with httpx.AsyncClient() as client:
            # Get all studies
            studies_response = await client.get(
                f"{self.orthanc_url}/studies",
                auth=self.auth
            )
            studies_response.raise_for_status()
            study_ids = studies_response.json()
            
            leica_studies = []
            for study_id in study_ids:
                if await self._is_leica_multifile_study(study_id):
                    leica_studies.append(study_id)
                    
            return leica_studies
    
    async def _is_leica_multifile_study(self, study_id: str) -> bool:
        """Check if a study contains Leica multi-file WSI data"""
        async with httpx.AsyncClient() as client:
            # Get study details
            study_response = await client.get(
                f"{self.orthanc_url}/studies/{study_id}",
                auth=self.auth
            )
            study_response.raise_for_status()
            study_data = study_response.json()
            
            # Check for multiple SM (Slide Microscopy) instances
            sm_instances = []
            for series_id in study_data['Series']:
                series_response = await client.get(
                    f"{self.orthanc_url}/series/{series_id}",
                    auth=self.auth
                )
                series_response.raise_for_status()
                series_data = series_response.json()
                
                # Check modality
                if series_data['MainDicomTags'].get('Modality') == 'SM':
                    # Get instances
                    instances_response = await client.get(
                        f"{self.orthanc_url}/series/{series_id}/instances",
                        auth=self.auth
                    )
                    instances_response.raise_for_status()
                    instances = instances_response.json()
                    
                    for instance in instances:
                        # Get instance tags
                        tags_response = await client.get(
                            f"{self.orthanc_url}/instances/{instance['ID']}/simplified-tags",
                            auth=self.auth
                        )
                        tags_response.raise_for_status()
                        tags = tags_response.json()
                        
                        # Check for Leica manufacturer
                        manufacturer = tags.get('Manufacturer', '')
                        if 'Leica' in manufacturer or len(instances) > 1:
                            sm_instances.append({
                                'id': instance['ID'],
                                'width': int(tags.get('Columns', 0)),
                                'height': int(tags.get('Rows', 0)),
                                'series_id': series_id
                            })
            
            # If we have multiple SM instances with different resolutions, it's likely a Leica multi-file
            if len(sm_instances) >= 2:
                # Check if they have different resolutions
                resolutions = set((inst['width'], inst['height']) for inst in sm_instances)
                return len(resolutions) > 1
                
            return False
    
    async def create_aggregated_series(self, study_id: str) -> Optional[str]:
        """Create a new aggregated series from Leica multi-file instances"""
        async with httpx.AsyncClient() as client:
            # Collect all SM instances in the study
            instances = await self._collect_study_instances(study_id)
            
            if len(instances) < 2:
                logger.warning(f"Study {study_id} has less than 2 SM instances")
                return None
                
            # Sort by resolution (largest first)
            instances.sort(key=lambda x: x['width'] * x['height'], reverse=True)
            
            logger.info(f"Creating aggregated series for {len(instances)} instances")
            
            # Create new series with aggregated metadata
            new_series_uid = generate_uid()
            base_instance = instances[0]
            
            # For each instance, create a modified copy in the new series
            for idx, instance in enumerate(instances):
                # Download the DICOM file
                dicom_response = await client.get(
                    f"{self.orthanc_url}/instances/{instance['id']}/file",
                    auth=self.auth
                )
                dicom_response.raise_for_status()
                
                # Parse DICOM
                from io import BytesIO
                ds = pydicom.dcmread(BytesIO(dicom_response.content))
                
                # Modify metadata for aggregation
                ds.SeriesInstanceUID = new_series_uid
                ds.SeriesDescription = f"Leica Aggregated Pyramid (Level {idx})"
                ds.InstanceNumber = str(idx + 1)
                
                # Add custom tags to indicate pyramid level
                # Using private creator 0x0009
                ds.add_new(0x0009, 0x0010, 'LO', 'LEICA_AGGREGATED')
                ds.add_new(0x0009, 0x1001, 'US', idx)  # Pyramid level
                ds.add_new(0x0009, 0x1002, 'UL', instances[0]['width'])  # Base width
                ds.add_new(0x0009, 0x1003, 'UL', instances[0]['height'])  # Base height
                
                # Calculate downsampling factor
                downsample_factor = instances[0]['width'] / instance['width']
                ds.add_new(0x0009, 0x1004, 'FL', downsample_factor)
                
                # Upload to Orthanc
                output = BytesIO()
                ds.save_as(output, write_like_original=False)
                output.seek(0)
                
                upload_response = await client.post(
                    f"{self.orthanc_url}/instances",
                    auth=self.auth,
                    content=output.read(),
                    headers={'Content-Type': 'application/dicom'}
                )
                
                if upload_response.status_code == 200:
                    logger.info(f"Uploaded aggregated instance {idx + 1}/{len(instances)}")
                else:
                    logger.error(f"Failed to upload instance: {upload_response.text}")
                    
            return new_series_uid
            
    async def _collect_study_instances(self, study_id: str) -> List[Dict]:
        """Collect all SM instances from a study"""
        instances = []
        
        async with httpx.AsyncClient() as client:
            study_response = await client.get(
                f"{self.orthanc_url}/studies/{study_id}",
                auth=self.auth
            )
            study_response.raise_for_status()
            study_data = study_response.json()
            
            for series_id in study_data['Series']:
                series_response = await client.get(
                    f"{self.orthanc_url}/series/{series_id}",
                    auth=self.auth
                )
                series_response.raise_for_status()
                series_data = series_response.json()
                
                if series_data['MainDicomTags'].get('Modality') == 'SM':
                    instances_response = await client.get(
                        f"{self.orthanc_url}/series/{series_id}/instances",
                        auth=self.auth
                    )
                    instances_response.raise_for_status()
                    series_instances = instances_response.json()
                    
                    for instance in series_instances:
                        tags_response = await client.get(
                            f"{self.orthanc_url}/instances/{instance['ID']}/simplified-tags",
                            auth=self.auth
                        )
                        tags_response.raise_for_status()
                        tags = tags_response.json()
                        
                        instances.append({
                            'id': instance['ID'],
                            'width': int(tags.get('Columns', 0)),
                            'height': int(tags.get('Rows', 0)),
                            'series_id': series_id
                        })
                        
        return instances

async def aggregate_all_leica_studies():
    """Find and aggregate all Leica multi-file studies in Orthanc"""
    aggregator = LeicaAggregator()
    
    logger.info("Searching for Leica multi-file studies...")
    leica_studies = await aggregator.find_leica_studies()
    
    logger.info(f"Found {len(leica_studies)} potential Leica multi-file studies")
    
    for study_id in leica_studies:
        logger.info(f"Processing study {study_id}")
        new_series = await aggregator.create_aggregated_series(study_id)
        if new_series:
            logger.info(f"Created aggregated series: {new_series}")
        else:
            logger.error(f"Failed to aggregate study {study_id}")

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(aggregate_all_leica_studies())
