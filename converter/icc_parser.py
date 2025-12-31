"""
ICC Profile Parser for Color Space Transformation
Extracts gamma curves, color primaries, and builds transformation matrices
"""
import struct
import math
from typing import Dict, List, Tuple, Optional
import logging

logger = logging.getLogger(__name__)


class ICCProfile:
    """Parse ICC profile and extract color transformation data"""
    
    # Standard white points
    D50 = (0.9642, 1.0000, 0.8249)  # ICC PCS white point
    D65 = (0.9505, 1.0000, 1.0890)  # sRGB white point
    
    # sRGB primaries (for output)
    SRGB_PRIMARIES = {
        'red': (0.6400, 0.3300),
        'green': (0.3000, 0.6000),
        'blue': (0.1500, 0.0600),
    }
    
    def __init__(self, data: bytes):
        self.data = data
        self.header = {}
        self.tags = {}
        self.gamma = {'r': 2.2, 'g': 2.2, 'b': 2.2}  # Default sRGB-ish
        self.primaries = None  # XYZ values for RGB primaries
        self.white_point = self.D50
        self.matrix_to_xyz = None
        self.matrix_to_srgb = None
        
        if len(data) >= 128:
            self._parse_header()
            self._parse_tag_table()
            self._extract_color_data()
            self._build_matrices()
    
    def _parse_header(self):
        """Parse ICC profile header (128 bytes)"""
        d = self.data
        self.header = {
            'size': struct.unpack('>I', d[0:4])[0],
            'cmm': d[4:8].decode('ascii', errors='replace').strip(),
            'version': f"{d[8]}.{d[9]}.{d[10]}",
            'profile_class': d[12:16].decode('ascii', errors='replace').strip(),
            'color_space': d[16:20].decode('ascii', errors='replace').strip(),
            'pcs': d[20:24].decode('ascii', errors='replace').strip(),
            'rendering_intent': struct.unpack('>I', d[64:68])[0],
        }
        
        # PCS illuminant (should be D50)
        self.white_point = (
            struct.unpack('>I', d[68:72])[0] / 65536.0,
            struct.unpack('>I', d[72:76])[0] / 65536.0,
            struct.unpack('>I', d[76:80])[0] / 65536.0,
        )
    
    def _parse_tag_table(self):
        """Parse tag table to find tag locations"""
        if len(self.data) < 132:
            return
        
        tag_count = struct.unpack('>I', self.data[128:132])[0]
        offset = 132
        
        for i in range(min(tag_count, 100)):  # Limit for safety
            if offset + 12 > len(self.data):
                break
            
            sig = self.data[offset:offset+4].decode('ascii', errors='replace')
            tag_offset = struct.unpack('>I', self.data[offset+4:offset+8])[0]
            tag_size = struct.unpack('>I', self.data[offset+8:offset+12])[0]
            
            self.tags[sig] = {'offset': tag_offset, 'size': tag_size}
            offset += 12
    
    def _read_xyz(self, tag_name: str) -> Optional[Tuple[float, float, float]]:
        """Read XYZ type tag"""
        if tag_name not in self.tags:
            return None
        
        t = self.tags[tag_name]
        offset = t['offset']
        
        if offset + 20 > len(self.data):
            return None
        
        # XYZ type: 'XYZ ' signature + reserved + X + Y + Z (s15Fixed16)
        sig = self.data[offset:offset+4]
        if sig != b'XYZ ':
            return None
        
        x = struct.unpack('>i', self.data[offset+8:offset+12])[0] / 65536.0
        y = struct.unpack('>i', self.data[offset+12:offset+16])[0] / 65536.0
        z = struct.unpack('>i', self.data[offset+16:offset+20])[0] / 65536.0
        
        return (x, y, z)
    
    def _read_trc(self, tag_name: str) -> float:
        """Read Tone Reproduction Curve (gamma)"""
        if tag_name not in self.tags:
            return 2.2  # Default
        
        t = self.tags[tag_name]
        offset = t['offset']
        
        if offset + 12 > len(self.data):
            return 2.2
        
        sig = self.data[offset:offset+4]
        
        if sig == b'curv':
            # Curve type
            count = struct.unpack('>I', self.data[offset+8:offset+12])[0]
            
            if count == 0:
                # Identity (gamma 1.0)
                return 1.0
            elif count == 1:
                # Single gamma value (u8Fixed8)
                gamma = struct.unpack('>H', self.data[offset+12:offset+14])[0] / 256.0
                return gamma
            else:
                # Curve data - approximate gamma from curve
                # For simplicity, estimate gamma from a few sample points
                return self._estimate_gamma_from_curve(offset + 12, count)
        
        elif sig == b'para':
            # Parametric curve
            func_type = struct.unpack('>H', self.data[offset+8:offset+10])[0]
            
            if func_type == 0:
                # Simple gamma: Y = X^g
                gamma = struct.unpack('>i', self.data[offset+12:offset+16])[0] / 65536.0
                return gamma
            else:
                # More complex parametric - extract first parameter as gamma
                gamma = struct.unpack('>i', self.data[offset+12:offset+16])[0] / 65536.0
                return max(0.1, min(gamma, 10.0))  # Clamp to reasonable range
        
        return 2.2
    
    def _estimate_gamma_from_curve(self, data_offset: int, count: int) -> float:
        """Estimate gamma from curve data by sampling"""
        if count < 2:
            return 2.2
        
        # Read a few points and estimate gamma
        # Using mid-point estimation: gamma = log(Y) / log(X)
        try:
            # Sample at ~50% input
            mid_idx = count // 2
            byte_offset = data_offset + mid_idx * 2
            
            if byte_offset + 2 > len(self.data):
                return 2.2
            
            y_val = struct.unpack('>H', self.data[byte_offset:byte_offset+2])[0] / 65535.0
            x_val = mid_idx / (count - 1)
            
            if x_val > 0 and y_val > 0:
                gamma = math.log(y_val) / math.log(x_val)
                return max(0.1, min(gamma, 10.0))
        except:
            pass
        
        return 2.2
    
    def _extract_color_data(self):
        """Extract gamma and primaries from profile"""
        # Extract gamma curves
        self.gamma = {
            'r': self._read_trc('rTRC'),
            'g': self._read_trc('gTRC'),
            'b': self._read_trc('bTRC'),
        }
        
        # Extract RGB primaries (XYZ values)
        r_xyz = self._read_xyz('rXYZ')
        g_xyz = self._read_xyz('gXYZ')
        b_xyz = self._read_xyz('bXYZ')
        
        if r_xyz and g_xyz and b_xyz:
            self.primaries = {
                'red': r_xyz,
                'green': g_xyz,
                'blue': b_xyz,
            }
        
        # White point
        wtpt = self._read_xyz('wtpt')
        if wtpt:
            self.white_point = wtpt
    
    def _build_matrices(self):
        """Build color transformation matrices"""
        if not self.primaries:
            # No primaries - can't build matrix
            return
        
        # Build matrix from RGB to XYZ (source color space)
        # Each column is the XYZ of one primary
        r = self.primaries['red']
        g = self.primaries['green']
        b = self.primaries['blue']
        
        self.matrix_to_xyz = [
            [r[0], g[0], b[0]],
            [r[1], g[1], b[1]],
            [r[2], g[2], b[2]],
        ]
        
        # Build matrix from XYZ to sRGB
        # sRGB primaries in XYZ (D65)
        srgb_matrix = [
            [ 3.2404542, -1.5371385, -0.4985314],
            [-0.9692660,  1.8760108,  0.0415560],
            [ 0.0556434, -0.2040259,  1.0572252],
        ]
        
        # Combined matrix: source RGB -> XYZ -> sRGB
        self.matrix_to_srgb = self._multiply_matrices(srgb_matrix, self.matrix_to_xyz)
    
    def _multiply_matrices(self, a: List[List[float]], b: List[List[float]]) -> List[List[float]]:
        """Multiply two 3x3 matrices"""
        result = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
        for i in range(3):
            for j in range(3):
                for k in range(3):
                    result[i][j] += a[i][k] * b[k][j]
        return result
    
    def get_color_transform_data(self) -> Dict:
        """Get all data needed for color transformation"""
        return {
            'header': self.header,
            'gamma': self.gamma,
            'primaries': self.primaries,
            'white_point': self.white_point,
            'matrix_to_xyz': self.matrix_to_xyz,
            'matrix_to_srgb': self.matrix_to_srgb,
            'has_full_transform': self.matrix_to_srgb is not None,
        }
    
    def get_webgl_uniforms(self) -> Dict:
        """Get uniform values for WebGL shader"""
        result = {
            'u_gamma': [self.gamma['r'], self.gamma['g'], self.gamma['b']],
            'u_hasMatrix': self.matrix_to_srgb is not None,
        }
        
        if self.matrix_to_srgb:
            # Flatten matrix for WebGL (column-major order)
            m = self.matrix_to_srgb
            result['u_colorMatrix'] = [
                m[0][0], m[1][0], m[2][0],
                m[0][1], m[1][1], m[2][1],
                m[0][2], m[1][2], m[2][2],
            ]
        else:
            # Identity matrix
            result['u_colorMatrix'] = [
                1, 0, 0,
                0, 1, 0,
                0, 0, 1,
            ]
        
        return result


def parse_icc_profile(data: bytes) -> Dict:
    """Parse ICC profile and return color transformation data"""
    profile = ICCProfile(data)
    return {
        'transform': profile.get_color_transform_data(),
        'webgl': profile.get_webgl_uniforms(),
    }

