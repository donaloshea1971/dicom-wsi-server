-- User management schema for PathView Pro
-- Run this on the PostgreSQL database

-- Users table (synced from Auth0)
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    auth0_id VARCHAR(255) UNIQUE NOT NULL,  -- Auth0 user ID (sub claim)
    email VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255),
    picture VARCHAR(500),
    role VARCHAR(50) DEFAULT 'user',  -- 'user', 'admin'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Study ownership - links Orthanc studies to users
CREATE TABLE IF NOT EXISTS study_owners (
    id SERIAL PRIMARY KEY,
    study_id VARCHAR(255) NOT NULL,  -- Orthanc study UUID
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(study_id)  -- Each study has one owner
);

-- Study sharing - allows sharing studies between users
CREATE TABLE IF NOT EXISTS study_shares (
    id SERIAL PRIMARY KEY,
    study_id VARCHAR(255) NOT NULL,
    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    shared_with_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permission VARCHAR(50) DEFAULT 'view',  -- 'view', 'annotate', 'full'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(study_id, shared_with_id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_study_owners_user ON study_owners(user_id);
CREATE INDEX IF NOT EXISTS idx_study_owners_study ON study_owners(study_id);
CREATE INDEX IF NOT EXISTS idx_study_shares_shared_with ON study_shares(shared_with_id);
CREATE INDEX IF NOT EXISTS idx_users_auth0 ON users(auth0_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Annotations table - persistent storage for study annotations
CREATE TABLE IF NOT EXISTS annotations (
    id VARCHAR(32) PRIMARY KEY,  -- Short UUID
    study_id VARCHAR(255) NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    type VARCHAR(50) NOT NULL,  -- measurement, marker, region, text
    tool VARCHAR(50) NOT NULL,  -- line, polygon, rectangle, point, arrow, text
    geometry JSONB NOT NULL,    -- GeoJSON geometry
    properties JSONB DEFAULT '{}',  -- color, label, measurement, etc.
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for annotation queries
CREATE INDEX IF NOT EXISTS idx_annotations_study ON annotations(study_id);
CREATE INDEX IF NOT EXISTS idx_annotations_user ON annotations(user_id);
CREATE INDEX IF NOT EXISTS idx_annotations_type ON annotations(type);

-- Function to get studies visible to a user (owned + shared)
CREATE OR REPLACE FUNCTION get_user_studies(p_user_id INTEGER)
RETURNS TABLE(study_id VARCHAR(255), permission VARCHAR(50)) AS $$
BEGIN
    RETURN QUERY
    -- Owned studies
    SELECT so.study_id, 'owner'::VARCHAR(50) as permission
    FROM study_owners so
    WHERE so.user_id = p_user_id
    
    UNION
    
    -- Shared studies
    SELECT ss.study_id, ss.permission
    FROM study_shares ss
    WHERE ss.shared_with_id = p_user_id;
END;
$$ LANGUAGE plpgsql;
