# ICC Color Profile Implementation

## Overview

PathView Pro implements **ICC (International Color Consortium) color profile** support to ensure accurate color reproduction of Whole Slide Images. Scanner manufacturers embed ICC profiles in their image files that describe the color characteristics of the scanning device. By applying these profiles, the viewer can transform scanner-specific colors to standard sRGB for consistent display across different monitors.

## Why ICC Profiles Matter in Digital Pathology

Different WSI scanners capture colors differently:
- **Hamamatsu NanoZoomer**: Often uses gamma ~2.2 with specific RGB primaries
- **Leica/Aperio**: May have different color calibration
- **Philips IntelliSite**: Has its own color space characteristics

Without ICC correction, the same tissue sample scanned on different devices will appear with different colors - problematic for:
- Diagnostic consistency
- AI/ML training data
- Multi-site studies
- Quality assurance

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        ICC Color Pipeline                                │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  DICOM File                                                              │
│  └── OpticalPathSequence                                                │
│      └── ICCProfile (binary blob)                                       │
│                    │                                                     │
│                    ▼                                                     │
│  ┌─────────────────────────────┐                                        │
│  │   Backend: icc_parser.py    │                                        │
│  │   - Parse ICC header        │                                        │
│  │   - Extract gamma curves    │                                        │
│  │   - Extract RGB primaries   │                                        │
│  │   - Build transform matrix  │                                        │
│  └─────────────────────────────┘                                        │
│                    │                                                     │
│                    ▼                                                     │
│  ┌─────────────────────────────┐                                        │
│  │   API Response (JSON)       │                                        │
│  │   - gamma: {r, g, b}        │                                        │
│  │   - matrix_to_xyz           │                                        │
│  │   - matrix_to_srgb          │                                        │
│  │   - webgl uniforms          │                                        │
│  └─────────────────────────────┘                                        │
│                    │                                                     │
│                    ▼                                                     │
│  ┌─────────────────────────────┐                                        │
│  │  Frontend: WebGL Shader     │                                        │
│  │  or CSS filter fallback     │                                        │
│  └─────────────────────────────┘                                        │
│                    │                                                     │
│                    ▼                                                     │
│              Color-Corrected                                             │
│                 Display                                                  │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## Backend Implementation

### ICC Profile Extraction (`converter/main.py`)

Two API endpoints handle ICC profiles:

```python
# Get ICC profile metadata and transformation data
GET /api/studies/{study_id}/icc-profile?include_transform=true

# Get raw ICC profile binary (downloadable .icc file)
GET /api/studies/{study_id}/icc-profile/raw
```

**Extraction Process:**

1. Fetch DICOM instance from Orthanc
2. Parse with pydicom
3. Look for ICC profile in:
   - `OpticalPathSequence[*].ICCProfile` (most common for WSI)
   - Top-level `ICCProfile` tag
4. Parse and return transformation data

### ICC Parser (`converter/icc_parser.py`)

The `ICCProfile` class parses the binary ICC profile format:

```python
class ICCProfile:
    def __init__(self, data: bytes):
        self._parse_header()      # 128-byte header
        self._parse_tag_table()   # Tag directory
        self._extract_color_data() # Gamma, primaries
        self._build_matrices()    # Transform matrices
```

#### Header Parsing (128 bytes)

| Offset | Size | Field |
|--------|------|-------|
| 0-3 | 4 | Profile size |
| 4-7 | 4 | Preferred CMM |
| 8-11 | 4 | Version (major.minor.patch) |
| 12-15 | 4 | Profile class (e.g., 'mntr' for display) |
| 16-19 | 4 | Color space (e.g., 'RGB ') |
| 20-23 | 4 | PCS (Profile Connection Space, usually 'XYZ ') |
| 68-79 | 12 | PCS illuminant (D50 white point) |

#### Key Tags Extracted

| Tag | Signature | Purpose |
|-----|-----------|---------|
| Red TRC | `rTRC` | Red channel gamma/curve |
| Green TRC | `gTRC` | Green channel gamma/curve |
| Blue TRC | `bTRC` | Blue channel gamma/curve |
| Red XYZ | `rXYZ` | Red primary in XYZ |
| Green XYZ | `gXYZ` | Green primary in XYZ |
| Blue XYZ | `bXYZ` | Blue primary in XYZ |
| White Point | `wtpt` | Media white point |

#### Gamma Curve Parsing

ICC profiles store gamma as either:

1. **Simple gamma** (`curv` with count=1):
   ```python
   gamma = struct.unpack('>H', data)[0] / 256.0
   ```

2. **Parametric curve** (`para`):
   ```python
   gamma = struct.unpack('>i', data)[0] / 65536.0  # s15Fixed16
   ```

3. **Full curve** (`curv` with count>1):
   - Array of output values
   - Estimate gamma from mid-point sampling

#### Matrix Building

```python
def _build_matrices(self):
    # Matrix from source RGB to XYZ
    # Each column is XYZ of one primary
    self.matrix_to_xyz = [
        [r[0], g[0], b[0]],  # X row
        [r[1], g[1], b[1]],  # Y row
        [r[2], g[2], b[2]],  # Z row
    ]
    
    # Standard sRGB XYZ-to-RGB matrix (D65)
    srgb_matrix = [
        [ 3.2404542, -1.5371385, -0.4985314],
        [-0.9692660,  1.8760108,  0.0415560],
        [ 0.0556434, -0.2040259,  1.0572252],
    ]
    
    # Combined: Source RGB → XYZ → sRGB
    self.matrix_to_srgb = srgb_matrix × self.matrix_to_xyz
```

## Frontend Implementation

### Color Correction Filter (`viewer/color-correction.js`)

The `ColorCorrectionFilter` class provides two rendering modes:

#### Mode 1: CSS Filters (Simple, Fast)

Uses CSS `filter` property for basic corrections:

```css
#osd-viewer.color-corrected {
    filter: brightness(1.1) contrast(1.05) saturate(1.1);
}
```

Gamma correction via SVG filter:
```xml
<filter id="gamma-correction">
    <feComponentTransfer>
        <feFuncR type="gamma" exponent="0.4545"/>
        <feFuncG type="gamma" exponent="0.4545"/>
        <feFuncB type="gamma" exponent="0.4545"/>
    </feComponentTransfer>
</filter>
```

#### Mode 2: WebGL Shader (Full ICC Transform)

For accurate per-pixel ICC transformation:

```glsl
// Fragment shader
void main() {
    vec4 texColor = texture2D(u_image, v_texCoord);
    vec3 color = texColor.rgb;
    
    // Step 1: Linearize (apply ICC gamma)
    color = applyGamma(color, u_gamma);
    
    // Step 2: Color space transform (ICC primaries → sRGB)
    if (u_applyMatrix) {
        color = u_colorMatrix * color;
    }
    
    // Step 3: De-linearize (apply sRGB gamma)
    color = applyInverseGamma(color);
    
    // Step 4: User adjustments
    color = color + vec3(u_brightness);
    color = (color - 0.5) * u_contrast + 0.5;
    color = adjustSaturation(color, u_saturation);
    
    gl_FragColor = vec4(clamp(color, 0.0, 1.0), texColor.a);
}
```

### Color Transformation Pipeline

```
Source Image (Scanner RGB)
         │
         ▼
    ┌─────────────┐
    │ Apply Gamma │  color = pow(color, gamma)
    │ (Linearize) │  Convert to linear light
    └─────────────┘
         │
         ▼
    ┌─────────────┐
    │   Matrix    │  color = matrix × color
    │  Transform  │  Scanner RGB → XYZ → sRGB
    └─────────────┘
         │
         ▼
    ┌─────────────┐
    │ Inverse     │  color = pow(color, 1/2.2)
    │ Gamma       │  Convert to sRGB
    └─────────────┘
         │
         ▼
    ┌─────────────┐
    │ User        │  brightness, contrast,
    │ Adjustments │  saturation
    └─────────────┘
         │
         ▼
   Display (sRGB)
```

## API Reference

### Get ICC Profile Info

```http
GET /api/studies/{study_id}/icc-profile?include_transform=true
```

**Response:**
```json
{
    "study_id": "abc123",
    "has_icc": true,
    "location": "OpticalPathSequence[0]",
    "size_bytes": 3144,
    "profile_info": {
        "size": 3144,
        "preferred_cmm": "ADBE",
        "version": "2.1.0",
        "profile_class": "mntr",
        "color_space": "RGB ",
        "pcs": "XYZ "
    },
    "color_transform": {
        "transform": {
            "gamma": { "r": 2.2, "g": 2.2, "b": 2.2 },
            "primaries": {
                "red": [0.4358, 0.2224, 0.0139],
                "green": [0.3853, 0.7170, 0.0971],
                "blue": [0.1430, 0.0606, 0.7139]
            },
            "white_point": [0.9642, 1.0, 0.8249],
            "matrix_to_srgb": [[...], [...], [...]],
            "has_full_transform": true
        },
        "webgl": {
            "u_gamma": [2.2, 2.2, 2.2],
            "u_hasMatrix": true,
            "u_colorMatrix": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]
        }
    }
}
```

### Download Raw ICC Profile

```http
GET /api/studies/{study_id}/icc-profile/raw
```

Returns binary `.icc` file that can be used with color management software.

## User Interface

### Color Panel in Viewer

The viewer provides a collapsible color correction panel:

- **ICC Profile Toggle**: Enable/disable ICC transformation
- **Presets**: sRGB, Hamamatsu, Linear, Vivid, Muted
- **Manual Sliders**:
  - Gamma (0.5 - 3.0)
  - Brightness (-0.5 - +0.5)
  - Contrast (0.5 - 2.0)
  - Saturation (0 - 2.0)

### ICC Status Indicator

When a study has an ICC profile:
- Badge shows "ICC ✓" in green
- Clicking shows profile details
- Option to download raw .icc file

## Limitations & Known Issues

1. **WebGL Fallback**: If WebGL is unavailable, only CSS-based gamma correction is applied (no full matrix transform)

2. **Per-Channel Gamma**: CSS filters don't support per-channel gamma; we use the average

3. **Chromatic Adaptation**: Currently assumes D50 → D65 adaptation is handled by the matrix; complex Bradford transforms not implemented

4. **LUT Profiles**: Full curve LUTs (multi-point TRCs) are approximated by estimating gamma from sample points

5. **CMYK Profiles**: Only RGB profiles are supported; CMYK-to-RGB conversion not implemented

## Testing

To verify ICC implementation:

1. Upload an SVS/NDPI file with embedded ICC profile
2. Open study in viewer
3. Check console for "ICC profile loaded" message
4. Toggle ICC correction and observe color shift
5. Download raw .icc and verify in system color profile viewer

## References

- [ICC Specification v4.4](https://www.color.org/specification/ICC.1-2022-05.pdf)
- [DICOM PS3.3 - Optical Path Module](https://dicom.nema.org/medical/dicom/current/output/html/part03.html#sect_C.8.12.5)
- [sRGB IEC 61966-2-1](https://webstore.iec.ch/publication/6169)
- [WebGL Color Space Handling](https://www.khronos.org/registry/webgl/specs/latest/1.0/)

---

*Implementation Version: 1.0 | Last Updated: January 2026*
