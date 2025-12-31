#!/usr/bin/env python3
"""Analyze ICC profiles embedded in DICOM WSI files"""
import requests
import base64
import struct
import json
import sys

if sys.stdout.encoding != 'utf-8':
    sys.stdout.reconfigure(encoding='utf-8')

ORTHANC_URL = "http://localhost:8042"
AUTH = ('admin', 'orthanc')


def parse_icc_profile(icc_data: bytes) -> dict:
    """Parse ICC profile header and key tags"""
    if len(icc_data) < 128:
        return {"error": "ICC profile too short"}
    
    # ICC Profile Header (128 bytes)
    profile_size = struct.unpack('>I', icc_data[0:4])[0]
    preferred_cmm = icc_data[4:8].decode('ascii', errors='replace')
    version = f"{icc_data[8]}.{icc_data[9]}.{icc_data[10]}"
    profile_class = icc_data[12:16].decode('ascii', errors='replace').strip()
    color_space = icc_data[16:20].decode('ascii', errors='replace').strip()
    pcs = icc_data[20:24].decode('ascii', errors='replace').strip()  # Profile Connection Space
    
    # Creation date
    year = struct.unpack('>H', icc_data[24:26])[0]
    month = struct.unpack('>H', icc_data[26:28])[0]
    day = struct.unpack('>H', icc_data[28:30])[0]
    
    # Primary platform
    platform = icc_data[40:44].decode('ascii', errors='replace').strip()
    
    # Rendering intent
    rendering_intent = struct.unpack('>I', icc_data[64:68])[0]
    intent_names = {0: 'Perceptual', 1: 'Relative Colorimetric', 2: 'Saturation', 3: 'Absolute Colorimetric'}
    
    # Illuminant (D50 typically)
    illum_x = struct.unpack('>I', icc_data[68:72])[0] / 65536.0
    illum_y = struct.unpack('>I', icc_data[72:76])[0] / 65536.0
    illum_z = struct.unpack('>I', icc_data[76:80])[0] / 65536.0
    
    # Tag count
    tag_count = struct.unpack('>I', icc_data[128:132])[0]
    
    # Parse tags
    tags = {}
    offset = 132
    for i in range(min(tag_count, 50)):  # Limit to prevent issues
        if offset + 12 > len(icc_data):
            break
        tag_sig = icc_data[offset:offset+4].decode('ascii', errors='replace')
        tag_offset = struct.unpack('>I', icc_data[offset+4:offset+8])[0]
        tag_size = struct.unpack('>I', icc_data[offset+8:offset+12])[0]
        tags[tag_sig] = {'offset': tag_offset, 'size': tag_size}
        offset += 12
    
    # Extract key color data
    result = {
        'profile_size': profile_size,
        'version': version,
        'profile_class': profile_class,
        'color_space': color_space,
        'pcs': pcs,
        'platform': platform,
        'rendering_intent': intent_names.get(rendering_intent, str(rendering_intent)),
        'illuminant': {'X': round(illum_x, 4), 'Y': round(illum_y, 4), 'Z': round(illum_z, 4)},
        'creation_date': f"{year}-{month:02d}-{day:02d}",
        'tag_count': tag_count,
        'tags': list(tags.keys()),
    }
    
    # Try to extract gamma/TRC (Tone Reproduction Curve)
    for trc_tag in ['rTRC', 'gTRC', 'bTRC']:
        if trc_tag in tags:
            t = tags[trc_tag]
            if t['offset'] + 12 <= len(icc_data):
                trc_type = icc_data[t['offset']:t['offset']+4].decode('ascii', errors='replace')
                if trc_type == 'curv':
                    count = struct.unpack('>I', icc_data[t['offset']+8:t['offset']+12])[0]
                    if count == 0:
                        result[f'{trc_tag}_gamma'] = 1.0
                    elif count == 1:
                        gamma_val = struct.unpack('>H', icc_data[t['offset']+12:t['offset']+14])[0] / 256.0
                        result[f'{trc_tag}_gamma'] = round(gamma_val, 3)
                    else:
                        result[f'{trc_tag}_type'] = f'curve ({count} points)'
                elif trc_type == 'para':
                    func_type = struct.unpack('>H', icc_data[t['offset']+8:t['offset']+10])[0]
                    result[f'{trc_tag}_type'] = f'parametric (type {func_type})'
    
    # Extract RGB primaries (rXYZ, gXYZ, bXYZ)
    for xyz_tag in ['rXYZ', 'gXYZ', 'bXYZ']:
        if xyz_tag in tags:
            t = tags[xyz_tag]
            if t['offset'] + 20 <= len(icc_data):
                x = struct.unpack('>i', icc_data[t['offset']+8:t['offset']+12])[0] / 65536.0
                y = struct.unpack('>i', icc_data[t['offset']+12:t['offset']+16])[0] / 65536.0
                z = struct.unpack('>i', icc_data[t['offset']+16:t['offset']+20])[0] / 65536.0
                result[xyz_tag] = {'X': round(x, 4), 'Y': round(y, 4), 'Z': round(z, 4)}
    
    return result


def get_icc_from_study(study_id: str) -> tuple:
    """Extract ICC profile from a DICOM study"""
    r = requests.get(f'{ORTHANC_URL}/studies/{study_id}', auth=AUTH)
    study = r.json()
    patient = study.get('PatientMainDicomTags', {}).get('PatientName', 'Unknown')
    
    series_ids = study.get('Series', [])
    if not series_ids:
        return None, patient
    
    r2 = requests.get(f'{ORTHANC_URL}/series/{series_ids[0]}', auth=AUTH)
    series = r2.json()
    instance_ids = series.get('Instances', [])
    
    if not instance_ids:
        return None, patient
    
    inst_id = instance_ids[0]
    r3 = requests.get(f'{ORTHANC_URL}/instances/{inst_id}/tags', auth=AUTH)
    tags = r3.json()
    
    # Check OpticalPathSequence for ICC
    optical_path = tags.get('0048,0105', {}).get('Value', [])
    if optical_path and isinstance(optical_path, list) and len(optical_path) > 0:
        item = optical_path[0]
        if isinstance(item, dict):
            icc_data = item.get('0028,2000', {}).get('Value', None)
            if icc_data:
                # Decode base64 if needed
                if isinstance(icc_data, str):
                    try:
                        return base64.b64decode(icc_data), patient
                    except:
                        pass
                elif isinstance(icc_data, list) and len(icc_data) > 0:
                    # May be raw bytes as list
                    return bytes(icc_data), patient
    
    return None, patient


def main():
    print("=" * 70)
    print("ICC Profile Analysis for DICOM WSI Studies")
    print("=" * 70)
    
    # Get all studies
    r = requests.get(f'{ORTHANC_URL}/studies', auth=AUTH)
    studies = r.json()
    
    all_profiles = []
    
    for study_id in studies:
        icc_data, patient = get_icc_from_study(study_id)
        
        print(f"\n{patient} ({study_id[:12]}...):")
        
        if icc_data:
            profile = parse_icc_profile(icc_data)
            print(f"  ICC Profile: {profile.get('profile_size', '?')} bytes")
            print(f"  Version: {profile.get('version', '?')}")
            print(f"  Color Space: {profile.get('color_space', '?')}")
            print(f"  Profile Class: {profile.get('profile_class', '?')}")
            print(f"  Rendering Intent: {profile.get('rendering_intent', '?')}")
            
            # Gamma info
            for color in ['rTRC', 'gTRC', 'bTRC']:
                gamma_key = f'{color}_gamma'
                type_key = f'{color}_type'
                if gamma_key in profile:
                    print(f"  {color} Gamma: {profile[gamma_key]}")
                elif type_key in profile:
                    print(f"  {color}: {profile[type_key]}")
            
            # RGB Primaries
            if 'rXYZ' in profile:
                print(f"  Red Primary:   X={profile['rXYZ']['X']:.4f} Y={profile['rXYZ']['Y']:.4f} Z={profile['rXYZ']['Z']:.4f}")
            if 'gXYZ' in profile:
                print(f"  Green Primary: X={profile['gXYZ']['X']:.4f} Y={profile['gXYZ']['Y']:.4f} Z={profile['gXYZ']['Z']:.4f}")
            if 'bXYZ' in profile:
                print(f"  Blue Primary:  X={profile['bXYZ']['X']:.4f} Y={profile['bXYZ']['Y']:.4f} Z={profile['bXYZ']['Z']:.4f}")
            
            profile['patient'] = patient
            profile['study_id'] = study_id
            all_profiles.append(profile)
        else:
            print("  No ICC Profile found")
    
    # Output summary for WebGL shader
    print("\n" + "=" * 70)
    print("Summary for WebGL Implementation:")
    print("=" * 70)
    
    # Check if all profiles are sRGB-like
    srgb_gamma = 2.2
    for p in all_profiles:
        gamma_r = p.get('rTRC_gamma', srgb_gamma)
        gamma_g = p.get('gTRC_gamma', srgb_gamma)
        gamma_b = p.get('bTRC_gamma', srgb_gamma)
        
        is_srgb_like = (
            abs(gamma_r - srgb_gamma) < 0.1 and
            abs(gamma_g - srgb_gamma) < 0.1 and
            abs(gamma_b - srgb_gamma) < 0.1
        )
        
        print(f"\n{p.get('patient', 'Unknown')[:30]}:")
        print(f"  Gamma R/G/B: {gamma_r}/{gamma_g}/{gamma_b}")
        print(f"  sRGB-compatible: {'Yes' if is_srgb_like else 'No'}")


if __name__ == "__main__":
    main()

