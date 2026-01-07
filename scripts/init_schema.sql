-- =============================================================================
-- PathView Pro - Unified Database Schema
-- Consolidates user management and slide hierarchy
-- =============================================================================

-- =============================================================================
-- USERS - Synced from Auth0
-- =============================================================================
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    auth0_id VARCHAR(255) UNIQUE NOT NULL,  -- Auth0 user ID (sub claim)
    email VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255),
    picture VARCHAR(500),
    role VARCHAR(50) DEFAULT 'user',        -- 'user', 'admin'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_auth0 ON users(auth0_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

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
    patient_id INTEGER REFERENCES patients(id) ON DELETE SET NULL,
    
    accession_number VARCHAR(100),       -- e.g., S24-12345
    case_type VARCHAR(100),              -- Surgical, Biopsy, Cytology, etc.
    specimen_type VARCHAR(255),          -- Breast Excision, Skin Punch, etc.
    received_date DATE,
    
    -- Clinical info
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
    case_id INTEGER REFERENCES cases(id) ON DELETE SET NULL,
    patient_id INTEGER REFERENCES patients(id) ON DELETE SET NULL,
    
    block_id VARCHAR(50),                -- A1, A2, B1, etc.
    tissue_type VARCHAR(255),            -- Tumor, Margin, Lymph Node, etc.
    
    -- Ownership
    owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_blocks_case ON blocks(case_id);
CREATE INDEX IF NOT EXISTS idx_blocks_owner ON blocks(owner_id);

-- =============================================================================
-- SLIDES - The primary image entity (links to Orthanc)
-- =============================================================================
CREATE TABLE IF NOT EXISTS slides (
    id SERIAL PRIMARY KEY,
    
    -- Hierarchy parents
    block_id INTEGER REFERENCES blocks(id) ON DELETE SET NULL,
    case_id INTEGER REFERENCES cases(id) ON DELETE SET NULL,
    patient_id INTEGER REFERENCES patients(id) ON DELETE SET NULL,
    
    -- Orthanc reference
    orthanc_study_id VARCHAR(255) NOT NULL UNIQUE,
    
    -- Display info
    display_name VARCHAR(255),
    stain VARCHAR(100),
    
    -- Technical info
    original_filename VARCHAR(500),
    source_format VARCHAR(50),
    scanner_manufacturer VARCHAR(255),
    study_instance_uid VARCHAR(255),
    series_instance_uid VARCHAR(255),
    
    -- Image properties
    width INTEGER,
    height INTEGER,
    magnification VARCHAR(20),
    
    -- Ownership & visibility
    owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    is_sample BOOLEAN DEFAULT FALSE,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_slides_orthanc ON slides(orthanc_study_id);
CREATE INDEX IF NOT EXISTS idx_slides_owner ON slides(owner_id);
CREATE INDEX IF NOT EXISTS idx_slides_case ON slides(case_id);

-- =============================================================================
-- SHARING - Direct and Inherited
-- =============================================================================

-- Slide-level sharing
CREATE TABLE IF NOT EXISTS slide_shares (
    id SERIAL PRIMARY KEY,
    slide_id INTEGER NOT NULL REFERENCES slides(id) ON DELETE CASCADE,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    shared_with_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permission VARCHAR(50) DEFAULT 'view',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(slide_id, shared_with_id)
);

-- Case-level sharing (grants access to all slides in the case)
CREATE TABLE IF NOT EXISTS case_shares (
    id SERIAL PRIMARY KEY,
    case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    shared_with_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permission VARCHAR(50) DEFAULT 'view',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(case_id, shared_with_id)
);

-- Pending shares (email-based for unregistered users)
CREATE TABLE IF NOT EXISTS pending_shares (
    id SERIAL PRIMARY KEY,
    slide_id INTEGER REFERENCES slides(id) ON DELETE CASCADE,
    case_id INTEGER REFERENCES cases(id) ON DELETE CASCADE,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_email VARCHAR(255) NOT NULL,
    permission VARCHAR(50) DEFAULT 'view',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT pending_shares_target_check CHECK (
        (slide_id IS NOT NULL AND case_id IS NULL) OR 
        (slide_id IS NULL AND case_id IS NOT NULL)
    ),
    UNIQUE(slide_id, target_email),
    UNIQUE(case_id, target_email)
);

-- =============================================================================
-- ANNOTATIONS - Slide-bound markups
-- =============================================================================
CREATE TABLE IF NOT EXISTS annotations (
    id VARCHAR(32) PRIMARY KEY,
    slide_id INTEGER NOT NULL REFERENCES slides(id) ON DELETE CASCADE,
    study_id VARCHAR(255) NOT NULL, -- Legacy reference kept for API compatibility
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    type VARCHAR(50) NOT NULL,
    tool VARCHAR(50) NOT NULL,
    geometry JSONB NOT NULL,
    properties JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_annotations_slide ON annotations(slide_id);

-- =============================================================================
-- PUBLIC SHARES - Anonymous link-based access (no login required)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public_shares (
    id SERIAL PRIMARY KEY,
    token VARCHAR(64) UNIQUE NOT NULL,      -- Random URL-safe token
    
    -- Target (one of these)
    slide_id INTEGER REFERENCES slides(id) ON DELETE CASCADE,
    case_id INTEGER REFERENCES cases(id) ON DELETE CASCADE,
    
    -- Share settings
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permission VARCHAR(50) DEFAULT 'view',   -- 'view' or 'annotate'
    password_hash VARCHAR(255),              -- Optional password protection
    
    -- Expiration
    expires_at TIMESTAMP,                    -- NULL = never expires
    max_views INTEGER,                       -- NULL = unlimited
    view_count INTEGER DEFAULT 0,
    
    -- Metadata
    title VARCHAR(255),                      -- Custom title for link
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_accessed_at TIMESTAMP,
    
    CONSTRAINT public_shares_target_check CHECK (
        (slide_id IS NOT NULL AND case_id IS NULL) OR 
        (slide_id IS NULL AND case_id IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_public_shares_token ON public_shares(token);
CREATE INDEX IF NOT EXISTS idx_public_shares_owner ON public_shares(owner_id);
CREATE INDEX IF NOT EXISTS idx_public_shares_slide ON public_shares(slide_id);
CREATE INDEX IF NOT EXISTS idx_public_shares_case ON public_shares(case_id);

-- =============================================================================
-- ANNOTATION COMMENTS - Discussion threads on annotations
-- =============================================================================
CREATE TABLE IF NOT EXISTS annotation_comments (
    id SERIAL PRIMARY KEY,
    annotation_id VARCHAR(32) NOT NULL REFERENCES annotations(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    
    -- For public/anonymous comments
    guest_name VARCHAR(100),
    
    -- Comment content
    content TEXT NOT NULL,
    
    -- Threading (reply to another comment)
    parent_id INTEGER REFERENCES annotation_comments(id) ON DELETE CASCADE,
    
    -- Status
    is_resolved BOOLEAN DEFAULT FALSE,
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_comments_annotation ON annotation_comments(annotation_id);
CREATE INDEX IF NOT EXISTS idx_comments_user ON annotation_comments(user_id);
CREATE INDEX IF NOT EXISTS idx_comments_parent ON annotation_comments(parent_id);

-- =============================================================================
-- ANNOTATION EVENTS - For real-time sync and activity tracking
-- =============================================================================
CREATE TABLE IF NOT EXISTS annotation_events (
    id SERIAL PRIMARY KEY,
    slide_id INTEGER NOT NULL REFERENCES slides(id) ON DELETE CASCADE,
    annotation_id VARCHAR(32),               -- May be NULL for delete events
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    
    event_type VARCHAR(50) NOT NULL,         -- 'create', 'update', 'delete', 'comment'
    event_data JSONB,                        -- Full annotation data or diff
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_events_slide ON annotation_events(slide_id);
CREATE INDEX IF NOT EXISTS idx_events_created ON annotation_events(created_at DESC);

-- =============================================================================
-- HELPER FUNCTIONS
-- =============================================================================

-- Get all slides visible to a user
CREATE OR REPLACE FUNCTION get_user_slides(p_user_id INTEGER)
RETURNS TABLE(
    slide_id INTEGER,
    orthanc_study_id VARCHAR(255),
    permission VARCHAR(50),
    access_type VARCHAR(20)
) AS $$
BEGIN
    RETURN QUERY
    -- Owned slides
    SELECT s.id, s.orthanc_study_id, 'owner'::VARCHAR(50), 'owned'::VARCHAR(20)
    FROM slides s
    WHERE s.owner_id = p_user_id
    
    UNION
    
    -- Directly shared slides
    SELECT s.id, s.orthanc_study_id, ss.permission, 'direct'::VARCHAR(20)
    FROM slide_shares ss
    JOIN slides s ON ss.slide_id = s.id
    WHERE ss.shared_with_id = p_user_id
    
    UNION
    
    -- Inherited via case sharing
    SELECT s.id, s.orthanc_study_id, cs.permission, 'case'::VARCHAR(20)
    FROM case_shares cs
    JOIN slides s ON s.case_id = cs.case_id
    WHERE cs.shared_with_id = p_user_id;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- SEED DATA
-- =============================================================================
CREATE TABLE IF NOT EXISTS stain_types (
    id SERIAL PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    category VARCHAR(50),
    sort_order INTEGER DEFAULT 0
);

INSERT INTO stain_types (code, name, category, sort_order) VALUES
('HE', 'H&E (Hematoxylin & Eosin)', 'Routine', 1),
('ER', 'Estrogen Receptor', 'IHC', 10),
('PR', 'Progesterone Receptor', 'IHC', 11),
('HER2', 'HER2/neu', 'IHC', 12),
('KI67', 'Ki-67', 'IHC', 20),
('OTHER', 'Other', 'Other', 99)
ON CONFLICT (code) DO NOTHING;
