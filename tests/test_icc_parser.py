"""
Unit tests for the icc_parser.py module.

Tests cover:
- ICC profile header parsing
- Tag table parsing
- Gamma extraction
- Color transformation matrix building
- WebGL uniform generation
"""

import sys
import struct
from pathlib import Path
from unittest.mock import MagicMock

import pytest

# Add converter module to path
sys.path.insert(0, str(Path(__file__).parent.parent / "converter"))


# =============================================================================
# Helper Functions for Creating Test ICC Data
# =============================================================================

def create_icc_header(
    profile_size: int = 1000,
    cmm: str = "appl",
    version: tuple = (4, 3, 0),
    profile_class: str = "mntr",
    color_space: str = "RGB ",
    pcs: str = "XYZ ",
    rendering_intent: int = 0,
    white_point: tuple = (0.9642, 1.0, 0.8249),
) -> bytes:
    """Create an ICC profile header."""
    header = bytearray(128)
    
    # Profile size
    struct.pack_into(">I", header, 0, profile_size)
    
    # CMM Type
    header[4:8] = cmm.encode("ascii")
    
    # Version
    header[8] = version[0]
    header[9] = version[1]
    header[10] = version[2]
    
    # Profile class
    header[12:16] = profile_class.encode("ascii")
    
    # Color space
    header[16:20] = color_space.encode("ascii")
    
    # PCS
    header[20:24] = pcs.encode("ascii")
    
    # Rendering intent
    struct.pack_into(">I", header, 64, rendering_intent)
    
    # PCS illuminant (XYZ)
    struct.pack_into(">I", header, 68, int(white_point[0] * 65536))
    struct.pack_into(">I", header, 72, int(white_point[1] * 65536))
    struct.pack_into(">I", header, 76, int(white_point[2] * 65536))
    
    return bytes(header)


def create_xyz_tag(x: float, y: float, z: float) -> bytes:
    """Create an XYZ type tag."""
    tag = bytearray(20)
    tag[0:4] = b"XYZ "  # Signature
    # Reserved bytes 4-8
    struct.pack_into(">i", tag, 8, int(x * 65536))
    struct.pack_into(">i", tag, 12, int(y * 65536))
    struct.pack_into(">i", tag, 16, int(z * 65536))
    return bytes(tag)


def create_curv_tag_gamma(gamma: float) -> bytes:
    """Create a curve tag with single gamma value."""
    tag = bytearray(14)
    tag[0:4] = b"curv"  # Signature
    # Reserved bytes 4-8
    struct.pack_into(">I", tag, 8, 1)  # Count = 1 (single gamma)
    struct.pack_into(">H", tag, 12, int(gamma * 256))  # u8Fixed8 gamma
    return bytes(tag)


def create_curv_tag_identity() -> bytes:
    """Create a curve tag with identity (gamma 1.0)."""
    tag = bytearray(12)
    tag[0:4] = b"curv"
    struct.pack_into(">I", tag, 8, 0)  # Count = 0 (identity)
    return bytes(tag)


def create_para_tag_gamma(gamma: float) -> bytes:
    """Create a parametric curve tag."""
    tag = bytearray(16)
    tag[0:4] = b"para"
    struct.pack_into(">H", tag, 8, 0)  # Function type 0 (simple gamma)
    # Reserved bytes 10-12
    struct.pack_into(">i", tag, 12, int(gamma * 65536))  # s15Fixed16 gamma
    return bytes(tag)


def create_tag_table(tags: dict) -> tuple:
    """Create tag table and tag data.
    
    Args:
        tags: Dict of tag_sig -> tag_data
        
    Returns:
        (tag_table_bytes, tag_data_bytes, tag_offsets)
    """
    tag_count = len(tags)
    tag_table = bytearray(4 + tag_count * 12)
    struct.pack_into(">I", tag_table, 0, tag_count)
    
    # Calculate base offset for tag data (header + tag table)
    base_offset = 128 + 4 + tag_count * 12
    current_offset = base_offset
    
    tag_data = bytearray()
    tag_offsets = {}
    
    for idx, (sig, data) in enumerate(tags.items()):
        # Write tag entry
        entry_offset = 4 + idx * 12
        tag_table[entry_offset:entry_offset+4] = sig.encode("ascii")
        struct.pack_into(">I", tag_table, entry_offset + 4, current_offset)
        struct.pack_into(">I", tag_table, entry_offset + 8, len(data))
        
        tag_offsets[sig] = current_offset
        tag_data.extend(data)
        current_offset += len(data)
    
    return bytes(tag_table), bytes(tag_data), tag_offsets


# =============================================================================
# Test ICCProfile Class
# =============================================================================

class TestICCProfileHeader:
    """Tests for ICC profile header parsing."""

    def test_parse_header_basic(self):
        """Test basic header parsing."""
        from icc_parser import ICCProfile
        
        header = create_icc_header(
            profile_size=1000,
            cmm="appl",
            version=(4, 3, 0),
            profile_class="mntr",
            color_space="RGB ",
            pcs="XYZ ",
        )
        tag_table = struct.pack(">I", 0)  # 0 tags
        
        profile = ICCProfile(header + tag_table)
        
        assert profile.header["size"] == 1000
        assert profile.header["cmm"] == "appl"
        assert profile.header["version"] == "4.3.0"
        assert profile.header["profile_class"] == "mntr"
        # Color space may be stripped of trailing space by the parser
        assert profile.header["color_space"].strip() == "RGB"
        assert profile.header["pcs"].strip() == "XYZ"

    def test_parse_header_white_point(self):
        """Test white point extraction from header."""
        from icc_parser import ICCProfile
        
        white_point = (0.9642, 1.0, 0.8249)  # D50
        header = create_icc_header(white_point=white_point)
        tag_table = struct.pack(">I", 0)
        
        profile = ICCProfile(header + tag_table)
        
        # Allow small floating point error
        assert abs(profile.white_point[0] - white_point[0]) < 0.0001
        assert abs(profile.white_point[1] - white_point[1]) < 0.0001
        assert abs(profile.white_point[2] - white_point[2]) < 0.0001

    def test_parse_invalid_short_data(self):
        """Test parsing with too short data."""
        from icc_parser import ICCProfile
        
        # Less than 128 bytes
        profile = ICCProfile(b"\x00" * 100)
        
        # Should have empty/default values
        assert profile.header == {}

    def test_parse_rendering_intent(self):
        """Test rendering intent parsing."""
        from icc_parser import ICCProfile
        
        for intent in [0, 1, 2, 3]:
            header = create_icc_header(rendering_intent=intent)
            tag_table = struct.pack(">I", 0)
            
            profile = ICCProfile(header + tag_table)
            
            assert profile.header["rendering_intent"] == intent


# =============================================================================
# Test Tag Table Parsing
# =============================================================================

class TestTagTableParsing:
    """Tests for tag table parsing."""

    def test_parse_empty_tag_table(self):
        """Test parsing profile with no tags."""
        from icc_parser import ICCProfile
        
        header = create_icc_header()
        tag_table = struct.pack(">I", 0)  # 0 tags
        
        profile = ICCProfile(header + tag_table)
        
        assert len(profile.tags) == 0

    def test_parse_tag_locations(self):
        """Test that tag locations are correctly parsed."""
        from icc_parser import ICCProfile
        
        header = create_icc_header()
        
        # Create tags with known data
        tags = {
            "rXYZ": create_xyz_tag(0.4361, 0.2225, 0.0139),
            "gXYZ": create_xyz_tag(0.3851, 0.7169, 0.0971),
            "bXYZ": create_xyz_tag(0.1431, 0.0606, 0.7139),
        }
        tag_table, tag_data, _ = create_tag_table(tags)
        
        profile = ICCProfile(header + tag_table + tag_data)
        
        assert "rXYZ" in profile.tags
        assert "gXYZ" in profile.tags
        assert "bXYZ" in profile.tags


# =============================================================================
# Test Gamma Extraction
# =============================================================================

class TestGammaExtraction:
    """Tests for gamma/TRC extraction."""

    def test_extract_gamma_from_curv_single(self):
        """Test extracting single gamma value from curve tag."""
        from icc_parser import ICCProfile
        
        header = create_icc_header()
        
        gamma_value = 2.2
        tags = {
            "rTRC": create_curv_tag_gamma(gamma_value),
            "gTRC": create_curv_tag_gamma(gamma_value),
            "bTRC": create_curv_tag_gamma(gamma_value),
        }
        tag_table, tag_data, _ = create_tag_table(tags)
        
        profile = ICCProfile(header + tag_table + tag_data)
        
        # Allow small error due to fixed-point conversion
        assert abs(profile.gamma["r"] - gamma_value) < 0.01
        assert abs(profile.gamma["g"] - gamma_value) < 0.01
        assert abs(profile.gamma["b"] - gamma_value) < 0.01

    def test_extract_gamma_identity(self):
        """Test extracting identity gamma (1.0)."""
        from icc_parser import ICCProfile
        
        header = create_icc_header()
        
        tags = {
            "rTRC": create_curv_tag_identity(),
            "gTRC": create_curv_tag_identity(),
            "bTRC": create_curv_tag_identity(),
        }
        tag_table, tag_data, _ = create_tag_table(tags)
        
        profile = ICCProfile(header + tag_table + tag_data)
        
        assert profile.gamma["r"] == 1.0
        assert profile.gamma["g"] == 1.0
        assert profile.gamma["b"] == 1.0

    def test_extract_gamma_from_para(self):
        """Test extracting gamma from parametric curve."""
        from icc_parser import ICCProfile
        
        header = create_icc_header()
        
        gamma_value = 2.4
        tags = {
            "rTRC": create_para_tag_gamma(gamma_value),
            "gTRC": create_para_tag_gamma(gamma_value),
            "bTRC": create_para_tag_gamma(gamma_value),
        }
        tag_table, tag_data, _ = create_tag_table(tags)
        
        profile = ICCProfile(header + tag_table + tag_data)
        
        assert abs(profile.gamma["r"] - gamma_value) < 0.01
        assert abs(profile.gamma["g"] - gamma_value) < 0.01
        assert abs(profile.gamma["b"] - gamma_value) < 0.01

    def test_default_gamma_without_trc(self):
        """Test default gamma when TRC tags missing."""
        from icc_parser import ICCProfile
        
        header = create_icc_header()
        tag_table = struct.pack(">I", 0)  # No tags
        
        profile = ICCProfile(header + tag_table)
        
        # Default to 2.2
        assert profile.gamma["r"] == 2.2
        assert profile.gamma["g"] == 2.2
        assert profile.gamma["b"] == 2.2


# =============================================================================
# Test Primaries Extraction
# =============================================================================

class TestPrimariesExtraction:
    """Tests for RGB primaries extraction."""

    def test_extract_rgb_primaries(self):
        """Test extracting RGB primary XYZ values."""
        from icc_parser import ICCProfile
        
        header = create_icc_header()
        
        # sRGB-like primaries
        red_xyz = (0.4361, 0.2225, 0.0139)
        green_xyz = (0.3851, 0.7169, 0.0971)
        blue_xyz = (0.1431, 0.0606, 0.7139)
        
        tags = {
            "rXYZ": create_xyz_tag(*red_xyz),
            "gXYZ": create_xyz_tag(*green_xyz),
            "bXYZ": create_xyz_tag(*blue_xyz),
        }
        tag_table, tag_data, _ = create_tag_table(tags)
        
        profile = ICCProfile(header + tag_table + tag_data)
        
        assert profile.primaries is not None
        
        # Check red primary
        assert abs(profile.primaries["red"][0] - red_xyz[0]) < 0.0001
        assert abs(profile.primaries["red"][1] - red_xyz[1]) < 0.0001
        assert abs(profile.primaries["red"][2] - red_xyz[2]) < 0.0001
        
        # Check green primary
        assert abs(profile.primaries["green"][0] - green_xyz[0]) < 0.0001
        
        # Check blue primary
        assert abs(profile.primaries["blue"][0] - blue_xyz[0]) < 0.0001

    def test_no_primaries_without_xyz_tags(self):
        """Test primaries is None without XYZ tags."""
        from icc_parser import ICCProfile
        
        header = create_icc_header()
        tag_table = struct.pack(">I", 0)
        
        profile = ICCProfile(header + tag_table)
        
        assert profile.primaries is None


# =============================================================================
# Test Matrix Building
# =============================================================================

class TestMatrixBuilding:
    """Tests for color transformation matrix building."""

    def test_build_matrix_to_xyz(self):
        """Test building RGB to XYZ matrix."""
        from icc_parser import ICCProfile
        
        header = create_icc_header()
        
        # Simple primaries
        tags = {
            "rXYZ": create_xyz_tag(1.0, 0.0, 0.0),
            "gXYZ": create_xyz_tag(0.0, 1.0, 0.0),
            "bXYZ": create_xyz_tag(0.0, 0.0, 1.0),
        }
        tag_table, tag_data, _ = create_tag_table(tags)
        
        profile = ICCProfile(header + tag_table + tag_data)
        
        assert profile.matrix_to_xyz is not None
        
        # With these primaries, matrix should be identity-like
        # Each column is an XYZ primary
        assert abs(profile.matrix_to_xyz[0][0] - 1.0) < 0.0001
        assert abs(profile.matrix_to_xyz[1][1] - 1.0) < 0.0001
        assert abs(profile.matrix_to_xyz[2][2] - 1.0) < 0.0001

    def test_build_matrix_to_srgb(self):
        """Test building combined RGB to sRGB matrix."""
        from icc_parser import ICCProfile
        
        header = create_icc_header()
        
        # sRGB primaries
        tags = {
            "rXYZ": create_xyz_tag(0.4361, 0.2225, 0.0139),
            "gXYZ": create_xyz_tag(0.3851, 0.7169, 0.0971),
            "bXYZ": create_xyz_tag(0.1431, 0.0606, 0.7139),
        }
        tag_table, tag_data, _ = create_tag_table(tags)
        
        profile = ICCProfile(header + tag_table + tag_data)
        
        assert profile.matrix_to_srgb is not None
        # Matrix should be 3x3
        assert len(profile.matrix_to_srgb) == 3
        assert len(profile.matrix_to_srgb[0]) == 3

    def test_no_matrix_without_primaries(self):
        """Test matrix is None without primaries."""
        from icc_parser import ICCProfile
        
        header = create_icc_header()
        tag_table = struct.pack(">I", 0)
        
        profile = ICCProfile(header + tag_table)
        
        assert profile.matrix_to_xyz is None
        assert profile.matrix_to_srgb is None


# =============================================================================
# Test WebGL Uniform Generation
# =============================================================================

class TestWebGLUniforms:
    """Tests for WebGL uniform generation."""

    def test_get_webgl_uniforms_with_matrix(self):
        """Test WebGL uniforms with full color transform."""
        from icc_parser import ICCProfile
        
        header = create_icc_header()
        
        tags = {
            "rXYZ": create_xyz_tag(0.4361, 0.2225, 0.0139),
            "gXYZ": create_xyz_tag(0.3851, 0.7169, 0.0971),
            "bXYZ": create_xyz_tag(0.1431, 0.0606, 0.7139),
            "rTRC": create_curv_tag_gamma(2.2),
            "gTRC": create_curv_tag_gamma(2.2),
            "bTRC": create_curv_tag_gamma(2.2),
        }
        tag_table, tag_data, _ = create_tag_table(tags)
        
        profile = ICCProfile(header + tag_table + tag_data)
        uniforms = profile.get_webgl_uniforms()
        
        assert "u_gamma" in uniforms
        assert "u_hasMatrix" in uniforms
        assert "u_colorMatrix" in uniforms
        
        assert uniforms["u_hasMatrix"] is True
        assert len(uniforms["u_gamma"]) == 3
        assert len(uniforms["u_colorMatrix"]) == 9  # 3x3 flattened

    def test_get_webgl_uniforms_without_matrix(self):
        """Test WebGL uniforms without matrix (identity)."""
        from icc_parser import ICCProfile
        
        header = create_icc_header()
        tag_table = struct.pack(">I", 0)
        
        profile = ICCProfile(header + tag_table)
        uniforms = profile.get_webgl_uniforms()
        
        assert uniforms["u_hasMatrix"] is False
        
        # Should return identity matrix
        expected_identity = [1, 0, 0, 0, 1, 0, 0, 0, 1]
        assert uniforms["u_colorMatrix"] == expected_identity


# =============================================================================
# Test Color Transform Data
# =============================================================================

class TestColorTransformData:
    """Tests for get_color_transform_data method."""

    def test_get_color_transform_data_complete(self):
        """Test getting complete color transform data."""
        from icc_parser import ICCProfile
        
        header = create_icc_header()
        
        tags = {
            "rXYZ": create_xyz_tag(0.4361, 0.2225, 0.0139),
            "gXYZ": create_xyz_tag(0.3851, 0.7169, 0.0971),
            "bXYZ": create_xyz_tag(0.1431, 0.0606, 0.7139),
            "rTRC": create_curv_tag_gamma(2.2),
            "gTRC": create_curv_tag_gamma(2.2),
            "bTRC": create_curv_tag_gamma(2.2),
        }
        tag_table, tag_data, _ = create_tag_table(tags)
        
        profile = ICCProfile(header + tag_table + tag_data)
        data = profile.get_color_transform_data()
        
        assert "header" in data
        assert "gamma" in data
        assert "primaries" in data
        assert "white_point" in data
        assert "matrix_to_xyz" in data
        assert "matrix_to_srgb" in data
        assert "has_full_transform" in data
        
        assert data["has_full_transform"] is True

    def test_get_color_transform_data_minimal(self):
        """Test getting minimal color transform data."""
        from icc_parser import ICCProfile
        
        header = create_icc_header()
        tag_table = struct.pack(">I", 0)
        
        profile = ICCProfile(header + tag_table)
        data = profile.get_color_transform_data()
        
        assert data["has_full_transform"] is False
        assert data["primaries"] is None
        assert data["matrix_to_srgb"] is None


# =============================================================================
# Test parse_icc_profile Function
# =============================================================================

class TestParseICCProfileFunction:
    """Tests for the parse_icc_profile convenience function."""

    def test_parse_icc_profile_returns_dict(self):
        """Test that parse_icc_profile returns expected dict structure."""
        from icc_parser import parse_icc_profile
        
        header = create_icc_header()
        tag_table = struct.pack(">I", 0)
        
        result = parse_icc_profile(header + tag_table)
        
        assert "transform" in result
        assert "webgl" in result
        
        assert "header" in result["transform"]
        assert "gamma" in result["transform"]
        
        assert "u_gamma" in result["webgl"]
        assert "u_colorMatrix" in result["webgl"]

    def test_parse_icc_profile_with_full_data(self):
        """Test parsing complete ICC profile."""
        from icc_parser import parse_icc_profile
        
        header = create_icc_header()
        
        tags = {
            "rXYZ": create_xyz_tag(0.4361, 0.2225, 0.0139),
            "gXYZ": create_xyz_tag(0.3851, 0.7169, 0.0971),
            "bXYZ": create_xyz_tag(0.1431, 0.0606, 0.7139),
            "rTRC": create_curv_tag_gamma(2.2),
            "gTRC": create_curv_tag_gamma(2.2),
            "bTRC": create_curv_tag_gamma(2.2),
        }
        tag_table, tag_data, _ = create_tag_table(tags)
        
        result = parse_icc_profile(header + tag_table + tag_data)
        
        assert result["transform"]["has_full_transform"] is True
        assert result["webgl"]["u_hasMatrix"] is True


# =============================================================================
# Test Edge Cases
# =============================================================================

class TestEdgeCases:
    """Tests for edge cases and error handling."""

    def test_empty_data(self):
        """Test parsing empty data."""
        from icc_parser import ICCProfile
        
        profile = ICCProfile(b"")
        
        # Should handle gracefully
        assert profile.header == {}
        assert len(profile.tags) == 0

    def test_invalid_tag_signature(self):
        """Test profile with corrupt tag table."""
        from icc_parser import ICCProfile
        
        header = create_icc_header()
        # Invalid tag count (very large)
        tag_table = struct.pack(">I", 999999999)
        
        profile = ICCProfile(header + tag_table)
        
        # Should limit tag count and handle gracefully
        assert len(profile.tags) <= 100  # Safety limit

    def test_extreme_gamma_values(self):
        """Test handling of extreme gamma values."""
        from icc_parser import ICCProfile
        
        header = create_icc_header()
        
        # Create curve with extreme gamma
        extreme_gamma_tag = bytearray(16)
        extreme_gamma_tag[0:4] = b"para"
        struct.pack_into(">H", extreme_gamma_tag, 8, 0)
        struct.pack_into(">i", extreme_gamma_tag, 12, int(100.0 * 65536))  # gamma = 100
        
        tags = {
            "rTRC": bytes(extreme_gamma_tag),
            "gTRC": bytes(extreme_gamma_tag),
            "bTRC": bytes(extreme_gamma_tag),
        }
        tag_table, tag_data, _ = create_tag_table(tags)
        
        profile = ICCProfile(header + tag_table + tag_data)
        
        # Verify gamma is extracted (even if extreme)
        # The parser reads the value as-is from the profile
        assert profile.gamma["r"] > 0
        assert isinstance(profile.gamma["r"], float)
