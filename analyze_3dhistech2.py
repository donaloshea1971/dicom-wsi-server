#!/usr/bin/env python3
"""Analyze 3DHISTECH-2 WSI structure"""

import requests
import sys
from collections import defaultdict

# Fix encoding
if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

auth = ('admin', 'orthanc')
base_url = 'http://localhost:8042'
series_id = 'f746a6ec-50faf3bf-8c9a652f-cbb0490f-14eceea3'

print("Analyzing 3DHISTECH-2 WSI structure...\n")

# Get all instances in the series
series_info = requests.get(f'{base_url}/series/{series_id}', auth=auth).json()
instances = series_info.get('Instances', [])

print(f"Total instances: {len(instances)}")

# Analyze each instance
instance_data = []
for i, instance_id in enumerate(instances):
    tags = requests.get(f'{base_url}/instances/{instance_id}/tags', auth=auth).json()
    
    # Extract key information
    data = {
        'id': instance_id,
        'instance_number': tags.get('0020,0013', {}).get('Value', ['?'])[0],
        'image_type': tags.get('0008,0008', {}).get('Value', ['?']),
        'rows': tags.get('0028,0010', {}).get('Value', ['?'])[0],
        'columns': tags.get('0028,0011', {}).get('Value', ['?'])[0],
        'total_pixel_matrix_cols': tags.get('0048,0006', {}).get('Value', ['?'])[0],
        'total_pixel_matrix_rows': tags.get('0048,0007', {}).get('Value', ['?'])[0],
        'number_of_frames': tags.get('0028,0008', {}).get('Value', ['1'])[0],
        'frame_increment_pointer': tags.get('0028,0009', {}).get('Value', None),
        'dimension_organization_type': tags.get('0020,9311', {}).get('Value', ['?'])[0] if '0020,9311' in tags else None,
        'dimension_organization_uid': tags.get('0020,9164', {}).get('Value', ['?'])[0] if '0020,9164' in tags else None,
    }
    
    # Check for concatenation info
    if '0020,9228' in tags:  # Concatenation Frame Offset Number
        data['concat_frame_offset'] = tags['0020,9228']['Value'][0]
    
    # Check for per-frame functional groups
    if '5200,9230' in tags:
        data['has_per_frame_groups'] = True
        # Count frames
        per_frame = tags['5200,9230']['Value']
        data['actual_frames'] = len(per_frame) if isinstance(per_frame, list) else 1
    else:
        data['has_per_frame_groups'] = False
        data['actual_frames'] = 1
    
    instance_data.append(data)

# Sort by instance number
instance_data.sort(key=lambda x: int(x['instance_number']) if str(x['instance_number']).isdigit() else 999)

# Display analysis
print("\nInstance Analysis:")
print("-" * 120)
print(f"{'Inst#':<6} {'Type':<40} {'Size':<12} {'Matrix':<15} {'Frames':<10} {'Per-Frame':<10}")
print("-" * 120)

for inst in instance_data:
    image_type = '/'.join(inst['image_type'][:4]) if isinstance(inst['image_type'], list) else str(inst['image_type'])
    size = f"{inst['columns']}x{inst['rows']}"
    matrix = f"{inst['total_pixel_matrix_cols']}x{inst['total_pixel_matrix_rows']}"
    frames = f"{inst['number_of_frames']}"
    per_frame = "Yes" if inst['has_per_frame_groups'] else "No"
    
    print(f"{inst['instance_number']:<6} {image_type:<40} {size:<12} {matrix:<15} {frames:<10} {per_frame:<10}")

# Group by image type
print("\n\nGrouping by Image Type:")
type_groups = defaultdict(list)
for inst in instance_data:
    image_type = '/'.join(inst['image_type'][:4]) if isinstance(inst['image_type'], list) else str(inst['image_type'])
    type_groups[image_type].append(inst)

for img_type, instances in type_groups.items():
    print(f"\n{img_type}: {len(instances)} instances")
    for inst in instances[:3]:  # Show first 3
        print(f"  - Instance {inst['instance_number']}: {inst['columns']}x{inst['rows']}, {inst['number_of_frames']} frames")

# Check if this is a concatenated dataset
concat_instances = [i for i in instance_data if 'concat_frame_offset' in i]
if concat_instances:
    print(f"\n\nWARNING: Found {len(concat_instances)} concatenated instances")
    print("This might be why the WSI plugin is having issues")

# Check dimension organization
dim_org_instances = [i for i in instance_data if i['dimension_organization_type']]
if dim_org_instances:
    print(f"\n\nDimension Organization found in {len(dim_org_instances)} instances")
    org_types = set(i['dimension_organization_type'] for i in dim_org_instances)
    print(f"Organization types: {org_types}")

# Recommendations
print("\n\nAnalysis Summary:")
if len(type_groups) > 3:
    print("- This appears to be a complex multi-instance WSI with different image types")
    print("- The WSI plugin might be struggling to assemble the pyramid from these separate instances")

if concat_instances:
    print("- Concatenation is present, which might not be fully supported")

if not dim_org_instances:
    print("- No dimension organization found, which is unusual for modern WSI")

# Test specific instance rendering
print("\n\nTesting individual instance rendering...")
test_instances = instance_data[:3]
for inst in test_instances:
    if inst['has_per_frame_groups'] and int(inst['actual_frames']) > 1:
        # Try to render a frame
        render_url = f"{base_url}/wsi/instances/{inst['id']}/frames/1/rendered?window-center=128&window-width=256"
        r = requests.get(render_url, auth=auth)
        print(f"Instance {inst['instance_number']} frame rendering: {r.status_code}")
