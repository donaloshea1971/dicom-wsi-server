-- ============================================================================
-- Complete Migration from study_owners/study_shares to slides/slide_shares
-- Run this ONCE to migrate all data and clean up
-- ============================================================================

BEGIN;

-- Step 1: Ensure all studies from study_owners exist in slides
INSERT INTO slides (orthanc_study_id, owner_id, created_at, updated_at)
SELECT study_id, user_id, created_at, created_at
FROM study_owners
WHERE NOT EXISTS (
    SELECT 1 FROM slides WHERE slides.orthanc_study_id = study_owners.study_id
)
ON CONFLICT (orthanc_study_id) DO UPDATE SET 
    owner_id = COALESCE(slides.owner_id, EXCLUDED.owner_id);

-- Step 2: Migrate shares from study_shares to slide_shares
INSERT INTO slide_shares (slide_id, owner_id, shared_with_id, permission, created_at)
SELECT 
    s.id as slide_id,
    ss.owner_id,
    ss.shared_with_id,
    ss.permission,
    ss.created_at
FROM study_shares ss
JOIN slides s ON s.orthanc_study_id = ss.study_id
WHERE NOT EXISTS (
    SELECT 1 FROM slide_shares 
    WHERE slide_shares.slide_id = s.id 
    AND slide_shares.shared_with_id = ss.shared_with_id
)
ON CONFLICT (slide_id, shared_with_id) DO NOTHING;

-- Step 3: Show migration results
DO $$
DECLARE
    slides_count INTEGER;
    slide_shares_count INTEGER;
    old_owners_count INTEGER;
    old_shares_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO slides_count FROM slides WHERE owner_id IS NOT NULL;
    SELECT COUNT(*) INTO slide_shares_count FROM slide_shares;
    SELECT COUNT(*) INTO old_owners_count FROM study_owners;
    SELECT COUNT(*) INTO old_shares_count FROM study_shares;
    
    RAISE NOTICE '=== Migration Results ===';
    RAISE NOTICE 'slides with owners: %', slides_count;
    RAISE NOTICE 'slide_shares: %', slide_shares_count;
    RAISE NOTICE 'old study_owners: %', old_owners_count;
    RAISE NOTICE 'old study_shares: %', old_shares_count;
END $$;

COMMIT;

-- ============================================================================
-- OPTIONAL: Drop old tables after verifying migration
-- Only run this after confirming everything works!
-- ============================================================================

-- DROP TABLE IF EXISTS study_shares;
-- DROP TABLE IF EXISTS study_owners;
