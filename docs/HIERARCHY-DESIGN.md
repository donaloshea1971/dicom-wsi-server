# PathView Pro - Flexible Slide Hierarchy Design

## Core Concept

**Rename "Study" → "Slide"** throughout the application.

Each entity level can:
- Exist independently (orphan slides are fine)
- Contain anything from below
- Be reorganized at any time

```
Patient (optional)
  └── Case (optional)
        └── Block (optional)
              └── Slide (the actual WSI image)
```

Valid configurations:
- ✅ Standalone Slide (no parent)
- ✅ Block → Slides (no Case/Patient)
- ✅ Case → Slides (no Blocks)
- ✅ Patient → Case → Block → Slides (full hierarchy)
- ✅ Patient → Slides (skip Case/Block)

---

## Database Schema

```sql
-- =============================================================================
-- PATIENTS - Top level container (optional)
-- =============================================================================
CREATE TABLE patients (
    id SERIAL PRIMARY KEY,
    mrn VARCHAR(100),                    -- Medical Record Number
    name VARCHAR(255),
    date_of_birth DATE,
    sex VARCHAR(20),
    
    -- Ownership
    owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_patients_mrn ON patients(mrn);
CREATE INDEX idx_patients_owner ON patients(owner_id);

-- =============================================================================
-- CASES - Accession/specimen level (optional container)
-- =============================================================================
CREATE TABLE cases (
    id SERIAL PRIMARY KEY,
    patient_id INTEGER REFERENCES patients(id) ON DELETE SET NULL,  -- Optional!
    
    accession_number VARCHAR(100),       -- e.g., S24-12345
    case_type VARCHAR(100),              -- Surgical, Biopsy, Cytology, etc.
    specimen_type VARCHAR(255),          -- Breast Excision, Skin Punch, etc.
    received_date DATE,
    
    -- Clinical info (editable)
    clinical_history TEXT,
    diagnosis TEXT,
    
    -- Ownership
    owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_cases_patient ON cases(patient_id);
CREATE INDEX idx_cases_accession ON cases(accession_number);
CREATE INDEX idx_cases_owner ON cases(owner_id);

-- =============================================================================
-- BLOCKS - Tissue block level (optional container)
-- =============================================================================
CREATE TABLE blocks (
    id SERIAL PRIMARY KEY,
    case_id INTEGER REFERENCES cases(id) ON DELETE SET NULL,        -- Optional!
    patient_id INTEGER REFERENCES patients(id) ON DELETE SET NULL,  -- Direct link if no case
    
    block_id VARCHAR(50),                -- A1, A2, B1, etc.
    tissue_type VARCHAR(255),            -- Tumor, Margin, Lymph Node, etc.
    
    -- Ownership
    owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_blocks_case ON blocks(case_id);
CREATE INDEX idx_blocks_patient ON blocks(patient_id);

-- =============================================================================
-- SLIDES - The actual WSI images (links to Orthanc)
-- =============================================================================
CREATE TABLE slides (
    id SERIAL PRIMARY KEY,
    
    -- Flexible parent (only one should be set, or none for orphan)
    block_id INTEGER REFERENCES blocks(id) ON DELETE SET NULL,
    case_id INTEGER REFERENCES cases(id) ON DELETE SET NULL,
    patient_id INTEGER REFERENCES patients(id) ON DELETE SET NULL,
    
    -- Orthanc reference (the key link!)
    orthanc_study_id VARCHAR(255) NOT NULL UNIQUE,  -- The Orthanc Study UUID
    
    -- Editable display info (overrides DICOM if set)
    display_name VARCHAR(255),           -- User-editable slide name
    stain VARCHAR(100),                  -- H&E, ER, PR, HER2, Ki67, etc.
    
    -- Original file info (for reference)
    original_filename VARCHAR(500),
    source_format VARCHAR(50),           -- SVS, NDPI, iSyntax, etc.
    scanner_manufacturer VARCHAR(255),
    
    -- DICOM UIDs (for reference/export)
    study_instance_uid VARCHAR(255),
    series_instance_uid VARCHAR(255),
    sop_instance_uid VARCHAR(255),
    
    -- Image properties
    width INTEGER,
    height INTEGER,
    magnification VARCHAR(20),           -- 20x, 40x, etc.
    
    -- Ownership & visibility
    owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    is_sample BOOLEAN DEFAULT FALSE,     -- Public sample slide
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_slides_orthanc ON slides(orthanc_study_id);
CREATE INDEX idx_slides_block ON slides(block_id);
CREATE INDEX idx_slides_case ON slides(case_id);
CREATE INDEX idx_slides_patient ON slides(patient_id);
CREATE INDEX idx_slides_owner ON slides(owner_id);

-- =============================================================================
-- SLIDE SHARING (replaces study_shares)
-- =============================================================================
CREATE TABLE slide_shares (
    id SERIAL PRIMARY KEY,
    slide_id INTEGER NOT NULL REFERENCES slides(id) ON DELETE CASCADE,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    shared_with_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permission VARCHAR(50) DEFAULT 'view',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(slide_id, shared_with_id)
);

-- Also allow sharing at Case level (shares all slides in case)
CREATE TABLE case_shares (
    id SERIAL PRIMARY KEY,
    case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    shared_with_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permission VARCHAR(50) DEFAULT 'view',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(case_id, shared_with_id)
);
```

---

## Migration from Current Schema

```sql
-- Step 1: Create new slides table from existing study_owners
INSERT INTO slides (orthanc_study_id, owner_id, created_at)
SELECT study_id, user_id, created_at
FROM study_owners;

-- Step 2: Migrate shares
INSERT INTO slide_shares (slide_id, owner_id, shared_with_id, permission, created_at)
SELECT s.id, ss.owner_id, ss.shared_with_id, ss.permission, ss.created_at
FROM study_shares ss
JOIN slides s ON s.orthanc_study_id = ss.study_id;

-- Step 3: Update annotations to reference slides
ALTER TABLE annotations ADD COLUMN slide_id INTEGER REFERENCES slides(id);
UPDATE annotations a SET slide_id = s.id FROM slides s WHERE s.orthanc_study_id = a.study_id;
```

---

## Conversion Metadata Input

When uploading a WSI file, offer optional metadata form:

```
┌─────────────────────────────────────────────────────────┐
│  📤 Upload WSI File                                     │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  File: breast_excision_A1_HE.svs                        │
│                                                         │
│  ─── Slide Info (embedded in DICOM) ───                 │
│  Slide Name: [Breast Excision A1 H&E          ]        │
│  Stain:      [H&E                    ▼]                │
│                                                         │
│  ─── Organization (optional) ───                        │
│  Patient:    [                       ] or [+ New]      │
│  Case:       [S24-12345              ] or [+ New]      │
│  Block:      [A1                     ] or [+ New]      │
│                                                         │
│  ─── Auto-parse from filename ───                       │
│  [✓] Try to extract case/block from filename           │
│      Detected: Case=S24-12345, Block=A1, Stain=HE      │
│                                                         │
│  [Upload & Convert]                                     │
└─────────────────────────────────────────────────────────┘
```

---

## DICOM Tag Mapping

When converting, embed user-provided metadata:

| Field | DICOM Tag | Notes |
|-------|-----------|-------|
| Patient Name | (0010,0010) | From patient record |
| Patient ID/MRN | (0010,0020) | From patient record |
| Accession Number | (0008,0050) | Case accession |
| Study Description | (0008,1030) | Case type + specimen |
| Series Description | (0008,103E) | Block ID + tissue type |
| Content Description | (0070,0081) | Slide name + stain |
| Institution Name | (0008,0080) | Could store original filename |

---

## API Endpoints

```
# Patients
GET    /api/patients
POST   /api/patients
GET    /api/patients/{id}
PUT    /api/patients/{id}
DELETE /api/patients/{id}
GET    /api/patients/{id}/cases
GET    /api/patients/{id}/slides

# Cases  
GET    /api/cases
POST   /api/cases
GET    /api/cases/{id}
PUT    /api/cases/{id}
DELETE /api/cases/{id}
GET    /api/cases/{id}/blocks
GET    /api/cases/{id}/slides

# Blocks
GET    /api/blocks
POST   /api/blocks
GET    /api/blocks/{id}
PUT    /api/blocks/{id}
DELETE /api/blocks/{id}
GET    /api/blocks/{id}/slides

# Slides (renamed from studies)
GET    /api/slides
POST   /api/slides                    # Create metadata only
GET    /api/slides/{id}
PUT    /api/slides/{id}              # Edit display_name, stain, etc.
DELETE /api/slides/{id}
PUT    /api/slides/{id}/assign       # Move to block/case/patient
POST   /api/slides/{id}/share

# Organization actions
POST   /api/slides/{id}/assign-to-block/{block_id}
POST   /api/slides/{id}/assign-to-case/{case_id}
POST   /api/slides/{id}/assign-to-patient/{patient_id}
POST   /api/slides/{id}/unassign     # Make orphan
```

---

## UI Changes

### 1. Rename "Study" → "Slide"
- Sidebar: "My Slides" instead of "My Studies"
- Cards: Show slide name, stain badge
- URL: `/viewer?slide=xxx` instead of `?study=xxx`

### 2. Sidebar Organization
```
┌─────────────────────────┐
│ 📁 My Slides            │
├─────────────────────────┤
│ ▼ 👤 John Smith         │  ← Patient (collapsible)
│   ▼ 📋 S24-12345        │  ← Case
│     ▼ 🧱 Block A1       │  ← Block
│       🔬 H&E            │  ← Slide
│       🔬 ER             │
│       🔬 PR             │
│     ▼ 🧱 Block A2       │
│       🔬 H&E            │
│                         │
│ ▼ 📋 S24-12346          │  ← Case (no patient)
│   🔬 Frozen Section     │  ← Slide (no block)
│                         │
│ 🔬 Unassigned Slide 1   │  ← Orphan slide
│ 🔬 Unassigned Slide 2   │
└─────────────────────────┘
```

### 3. Drag & Drop Organization
- Drag slide to case/block to assign
- Drag block to case to assign
- Right-click → "Move to..." menu

### 4. Edit Slide Metadata
- Click slide name to edit
- Stain dropdown
- Auto-save on change

---

## Implementation Priority

### Phase 1: Database & Rename (1-2 days)
1. Create new tables
2. Migrate existing data
3. Rename "Study" → "Slide" in UI

### Phase 2: Slide Management (2-3 days)
4. Edit slide name/stain
5. Create cases/blocks
6. Assign slides to hierarchy

### Phase 3: Smart Upload (2-3 days)
7. Metadata input form on upload
8. Filename parsing
9. Embed metadata in DICOM on conversion

### Phase 4: Advanced Organization (3-5 days)
10. Drag & drop
11. Case sharing
12. Batch operations
