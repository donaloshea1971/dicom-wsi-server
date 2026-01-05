-- =============================================================================
-- PathView Pro - Slide Hierarchy Schema
-- Run this AFTER user_schema.sql to add Patient/Case/Block/Slide hierarchy
-- =============================================================================

-- =============================================================================
-- PATIENTS - Top level container (optional)
-- =============================================================================
CREATE TABLE IF NOT EXISTS patients (
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

CREATE INDEX IF NOT EXISTS idx_patients_mrn ON patients(mrn);
CREATE INDEX IF NOT EXISTS idx_patients_owner ON patients(owner_id);
CREATE INDEX IF NOT EXISTS idx_patients_name ON patients(name);

-- =============================================================================
-- CASES - Accession/specimen level (optional container)
-- =============================================================================
CREATE TABLE IF NOT EXISTS cases (
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

CREATE INDEX IF NOT EXISTS idx_cases_patient ON cases(patient_id);
CREATE INDEX IF NOT EXISTS idx_cases_accession ON cases(accession_number);
CREATE INDEX IF NOT EXISTS idx_cases_owner ON cases(owner_id);

-- =============================================================================
-- BLOCKS - Tissue block level (optional container)
-- =============================================================================
CREATE TABLE IF NOT EXISTS blocks (
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

CREATE INDEX IF NOT EXISTS idx_blocks_case ON blocks(case_id);
CREATE INDEX IF NOT EXISTS idx_blocks_patient ON blocks(patient_id);
CREATE INDEX IF NOT EXISTS idx_blocks_owner ON blocks(owner_id);

-- =============================================================================
-- SLIDES - The actual WSI images (links to Orthanc)
-- This replaces study_owners as the primary entity
-- =============================================================================
CREATE TABLE IF NOT EXISTS slides (
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
    
    -- Image properties (cached from DICOM)
    width INTEGER,
    height INTEGER,
    magnification VARCHAR(20),           -- 20x, 40x, etc.
    
    -- Ownership & visibility
    owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    is_sample BOOLEAN DEFAULT FALSE,     -- Public sample slide
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_slides_orthanc ON slides(orthanc_study_id);
CREATE INDEX IF NOT EXISTS idx_slides_block ON slides(block_id);
CREATE INDEX IF NOT EXISTS idx_slides_case ON slides(case_id);
CREATE INDEX IF NOT EXISTS idx_slides_patient ON slides(patient_id);
CREATE INDEX IF NOT EXISTS idx_slides_owner ON slides(owner_id);
CREATE INDEX IF NOT EXISTS idx_slides_stain ON slides(stain);

-- =============================================================================
-- SLIDE SHARING (new table, replaces study_shares for new model)
-- =============================================================================
CREATE TABLE IF NOT EXISTS slide_shares (
    id SERIAL PRIMARY KEY,
    slide_id INTEGER NOT NULL REFERENCES slides(id) ON DELETE CASCADE,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    shared_with_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permission VARCHAR(50) DEFAULT 'view',  -- view, annotate, full
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(slide_id, shared_with_id)
);

CREATE INDEX IF NOT EXISTS idx_slide_shares_slide ON slide_shares(slide_id);
CREATE INDEX IF NOT EXISTS idx_slide_shares_shared_with ON slide_shares(shared_with_id);

-- =============================================================================
-- CASE SHARING - Share entire cases (all slides within)
-- =============================================================================
CREATE TABLE IF NOT EXISTS case_shares (
    id SERIAL PRIMARY KEY,
    case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    shared_with_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permission VARCHAR(50) DEFAULT 'view',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(case_id, shared_with_id)
);

CREATE INDEX IF NOT EXISTS idx_case_shares_case ON case_shares(case_id);
CREATE INDEX IF NOT EXISTS idx_case_shares_shared_with ON case_shares(shared_with_id);

-- =============================================================================
-- MIGRATION: Copy existing data from study_owners/study_shares to slides
-- =============================================================================

-- Migrate study_owners to slides (only if slides table is empty)
INSERT INTO slides (orthanc_study_id, owner_id, created_at)
SELECT so.study_id, so.user_id, so.created_at
FROM study_owners so
WHERE NOT EXISTS (SELECT 1 FROM slides WHERE orthanc_study_id = so.study_id)
ON CONFLICT (orthanc_study_id) DO NOTHING;

-- Migrate study_shares to slide_shares
INSERT INTO slide_shares (slide_id, owner_id, shared_with_id, permission, created_at)
SELECT s.id, ss.owner_id, ss.shared_with_id, ss.permission, ss.created_at
FROM study_shares ss
JOIN slides s ON s.orthanc_study_id = ss.study_id
WHERE NOT EXISTS (
    SELECT 1 FROM slide_shares 
    WHERE slide_id = s.id AND shared_with_id = ss.shared_with_id
)
ON CONFLICT (slide_id, shared_with_id) DO NOTHING;

-- Add slide_id column to annotations if not exists
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'annotations' AND column_name = 'slide_id'
    ) THEN
        ALTER TABLE annotations ADD COLUMN slide_id INTEGER REFERENCES slides(id) ON DELETE CASCADE;
        CREATE INDEX IF NOT EXISTS idx_annotations_slide ON annotations(slide_id);
    END IF;
END $$;

-- Update annotations to link to slides
UPDATE annotations a 
SET slide_id = s.id 
FROM slides s 
WHERE s.orthanc_study_id = a.study_id AND a.slide_id IS NULL;

-- =============================================================================
-- HELPER FUNCTIONS
-- =============================================================================

-- Get all slides visible to a user (owned + shared + via case shares)
CREATE OR REPLACE FUNCTION get_user_slides(p_user_id INTEGER)
RETURNS TABLE(
    slide_id INTEGER,
    orthanc_study_id VARCHAR(255),
    permission VARCHAR(50),
    source VARCHAR(20)
) AS $$
BEGIN
    RETURN QUERY
    -- Directly owned slides
    SELECT s.id, s.orthanc_study_id, 'owner'::VARCHAR(50), 'owned'::VARCHAR(20)
    FROM slides s
    WHERE s.owner_id = p_user_id
    
    UNION
    
    -- Directly shared slides
    SELECT s.id, s.orthanc_study_id, ss.permission, 'shared'::VARCHAR(20)
    FROM slide_shares ss
    JOIN slides s ON ss.slide_id = s.id
    WHERE ss.shared_with_id = p_user_id
    
    UNION
    
    -- Slides in shared cases
    SELECT s.id, s.orthanc_study_id, cs.permission, 'case_shared'::VARCHAR(20)
    FROM case_shares cs
    JOIN slides s ON s.case_id = cs.case_id
    WHERE cs.shared_with_id = p_user_id;
END;
$$ LANGUAGE plpgsql;

-- Get slide hierarchy info
CREATE OR REPLACE FUNCTION get_slide_hierarchy(p_slide_id INTEGER)
RETURNS TABLE(
    slide_id INTEGER,
    slide_name VARCHAR(255),
    block_id INTEGER,
    block_name VARCHAR(50),
    case_id INTEGER,
    case_accession VARCHAR(100),
    patient_id INTEGER,
    patient_name VARCHAR(255)
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        s.id,
        COALESCE(s.display_name, s.original_filename)::VARCHAR(255),
        b.id,
        b.block_id,
        c.id,
        c.accession_number,
        p.id,
        p.name
    FROM slides s
    LEFT JOIN blocks b ON s.block_id = b.id
    LEFT JOIN cases c ON COALESCE(s.case_id, b.case_id) = c.id
    LEFT JOIN patients p ON COALESCE(s.patient_id, b.patient_id, c.patient_id) = p.id
    WHERE s.id = p_slide_id;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- COMMON STAINS REFERENCE (for dropdown)
-- =============================================================================
CREATE TABLE IF NOT EXISTS stain_types (
    id SERIAL PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    category VARCHAR(50),  -- Routine, IHC, Special, etc.
    sort_order INTEGER DEFAULT 0
);

INSERT INTO stain_types (code, name, category, sort_order) VALUES
('HE', 'H&E (Hematoxylin & Eosin)', 'Routine', 1),
('ER', 'Estrogen Receptor', 'IHC - Breast', 10),
('PR', 'Progesterone Receptor', 'IHC - Breast', 11),
('HER2', 'HER2/neu', 'IHC - Breast', 12),
('KI67', 'Ki-67', 'IHC - Proliferation', 20),
('P53', 'p53', 'IHC - Tumor Suppressor', 21),
('CK7', 'Cytokeratin 7', 'IHC - Cytokeratin', 30),
('CK20', 'Cytokeratin 20', 'IHC - Cytokeratin', 31),
('CD3', 'CD3 (T-cell)', 'IHC - Lymphoid', 40),
('CD20', 'CD20 (B-cell)', 'IHC - Lymphoid', 41),
('CD45', 'CD45 (LCA)', 'IHC - Lymphoid', 42),
('S100', 'S-100', 'IHC - Neural/Melanocytic', 50),
('SOX10', 'SOX10', 'IHC - Melanocytic', 51),
('MELAN', 'Melan-A', 'IHC - Melanocytic', 52),
('PAS', 'PAS', 'Special', 60),
('PASD', 'PAS-D (Diastase)', 'Special', 61),
('TRICHROME', 'Trichrome', 'Special', 62),
('RETICULIN', 'Reticulin', 'Special', 63),
('AFB', 'AFB (Acid-Fast)', 'Special - Micro', 70),
('GMS', 'GMS (Fungal)', 'Special - Micro', 71),
('OTHER', 'Other', 'Other', 99)
ON CONFLICT (code) DO NOTHING;
