# PathView Pro - Database Schema

> **Source of Truth:** `scripts/init_schema.sql`  
> **Database:** PostgreSQL  
> **Last Updated:** January 2026

---

## Quick Reference: Table Names

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `users` | Auth0 synced user accounts | `id`, `auth0_id`, `email` |
| `patients` | Top-level patient container | `id`, `mrn`, `owner_id` |
| `cases` | Accession/specimen level | `id`, `accession_number`, `patient_id` |
| `blocks` | Tissue block level | `id`, `block_id`, `case_id` |
| `slides` | **Primary image entity** | `id`, `orthanc_study_id`, `owner_id` |
| `slide_shares` | Direct slide sharing | `slide_id`, `shared_with_id` |
| `case_shares` | Case-level sharing | `case_id`, `shared_with_id` |
| `pending_shares` | Email-based shares (unregistered) | `slide_id` OR `case_id`, `target_email` |
| `public_shares` | Anonymous link access | `slide_id` OR `case_id`, `token` |
| `annotations` | Slide markups/measurements | `id`, `slide_id`, `study_id` |
| `annotation_comments` | Discussion threads | `annotation_id`, `user_id` |
| `annotation_events` | Real-time sync events | `slide_id`, `event_type` |
| `stain_types` | Seed data for stain codes | `code`, `name` |

---

## ID Types

⚠️ **Important distinction:**

| ID Type | Column Name | Format | Used In |
|---------|-------------|--------|---------|
| **Internal DB ID** | `id`, `slide_id`, `user_id` | Integer (SERIAL) | Foreign keys, most tables |
| **Orthanc Study ID** | `orthanc_study_id`, `study_id` | UUID string | `slides.orthanc_study_id`, `annotations.study_id`, API URLs |
| **Auth0 ID** | `auth0_id` | String (e.g., `google-oauth2\|123...`) | JWT tokens, user lookup |

---

## Entity Relationship Diagram

```
┌─────────────┐
│   users     │
│  (Auth0)    │
└──────┬──────┘
       │ owner_id
       ▼
┌─────────────┐     ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  patients   │────▶│   cases     │────▶│   blocks    │────▶│   slides    │
│  (optional) │     │  (optional) │     │  (optional) │     │  (primary)  │
└─────────────┘     └─────────────┘     └─────────────┘     └──────┬──────┘
                                                                   │
       ┌───────────────────────────┬───────────────────────────────┼───────────────────────┐
       │                           │                               │                       │
       ▼                           ▼                               ▼                       ▼
┌─────────────┐           ┌─────────────┐                 ┌─────────────┐         ┌─────────────┐
│slide_shares │           │pending_shares│                │public_shares│         │ annotations │
│  (direct)   │           │  (email)    │                 │  (links)    │         │  (markups)  │
└─────────────┘           └─────────────┘                 └─────────────┘         └──────┬──────┘
                                                                                         │
                                                                                         ▼
                                                                                 ┌─────────────┐
                                                                                 │ annotation_ │
                                                                                 │  comments   │
                                                                                 └─────────────┘
```

---

## Core Tables

### `users`
Auth0 synchronized user accounts.

| Column | Type | Description |
|--------|------|-------------|
| `id` | SERIAL PK | Internal user ID (use for FKs) |
| `auth0_id` | VARCHAR(255) | Auth0 subject (`sub` claim) - UNIQUE |
| `email` | VARCHAR(255) | User email - UNIQUE |
| `name` | VARCHAR(255) | Display name |
| `picture` | VARCHAR(500) | Avatar URL |
| `role` | VARCHAR(50) | `'user'` or `'admin'` |
| `created_at` | TIMESTAMP | Account creation |
| `last_login` | TIMESTAMP | Last authentication |

**Indexes:** `auth0_id`, `email`

---

### `slides`
**Primary image entity** - links to Orthanc storage.

| Column | Type | Description |
|--------|------|-------------|
| `id` | SERIAL PK | Internal slide ID (use for FKs) |
| `orthanc_study_id` | VARCHAR(255) | **Orthanc Study ID** - UNIQUE |
| `owner_id` | INTEGER FK | References `users.id` |
| `display_name` | VARCHAR(255) | Slide name shown in UI |
| `stain` | VARCHAR(100) | H&E, ER, PR, etc. |
| `original_filename` | VARCHAR(500) | Source file name |
| `source_format` | VARCHAR(50) | NDPI, SVS, iSyntax, etc. |
| `is_sample` | BOOLEAN | Public sample slide |
| `case_id` | INTEGER FK | Optional case reference |
| `patient_id` | INTEGER FK | Optional patient reference |
| `block_id` | INTEGER FK | Optional block reference |
| `width` | INTEGER | Image width in pixels |
| `height` | INTEGER | Image height in pixels |

**Indexes:** `orthanc_study_id`, `owner_id`, `case_id`

---

## Sharing Tables

### `slide_shares`
Direct slide-level sharing with registered users.

| Column | Type | Description |
|--------|------|-------------|
| `id` | SERIAL PK | Share record ID |
| `slide_id` | INTEGER FK | References `slides.id` - CASCADE |
| `owner_id` | INTEGER FK | User who shared |
| `shared_with_id` | INTEGER FK | User receiving access |
| `permission` | VARCHAR(50) | `'view'`, `'annotate'`, `'full'` |

**Unique:** `(slide_id, shared_with_id)`

---

### `case_shares`
Case-level sharing - grants access to ALL slides in a case.

| Column | Type | Description |
|--------|------|-------------|
| `id` | SERIAL PK | Share record ID |
| `case_id` | INTEGER FK | References `cases.id` - CASCADE |
| `owner_id` | INTEGER FK | User who shared |
| `shared_with_id` | INTEGER FK | User receiving access |
| `permission` | VARCHAR(50) | `'view'`, `'annotate'`, `'full'` |

**Unique:** `(case_id, shared_with_id)`

---

### `pending_shares`
Email-based shares for users who haven't registered yet.

| Column | Type | Description |
|--------|------|-------------|
| `id` | SERIAL PK | Share record ID |
| `slide_id` | INTEGER FK | References `slides.id` (XOR with case_id) |
| `case_id` | INTEGER FK | References `cases.id` (XOR with slide_id) |
| `owner_id` | INTEGER FK | User who shared |
| `target_email` | VARCHAR(255) | Email of recipient |
| `permission` | VARCHAR(50) | Permission level |

**Constraint:** Either `slide_id` OR `case_id` must be set, not both.

---

### `public_shares`
Anonymous link-based access (no login required).

| Column | Type | Description |
|--------|------|-------------|
| `id` | SERIAL PK | Share record ID |
| `token` | VARCHAR(64) | URL-safe random token - UNIQUE |
| `slide_id` | INTEGER FK | References `slides.id` (XOR with case_id) |
| `case_id` | INTEGER FK | References `cases.id` (XOR with slide_id) |
| `owner_id` | INTEGER FK | Link creator |
| `permission` | VARCHAR(50) | `'view'` or `'annotate'` |
| `password_hash` | VARCHAR(255) | Optional password protection |
| `expires_at` | TIMESTAMP | NULL = never expires |
| `max_views` | INTEGER | NULL = unlimited |
| `view_count` | INTEGER | Current view count |

**Constraint:** Either `slide_id` OR `case_id` must be set, not both.

**Public metadata contract (important):**

- Public-link endpoints must **not** expose PHI/PII (patient name/DOB/MRN, accession numbers, etc.).
- Public responses should be limited to **non-sensitive display fields** (e.g. link `title`, slide `display_name` if treated as non-PHI, optional `stain`, optional sharer `owner_name`) and **technical identifiers required to render** (e.g. Orthanc `study_id` and Orthanc series id for WSI tiles).

---

## Annotation Tables

### `annotations`
Slide markups and measurements.

| Column | Type | Description |
|--------|------|-------------|
| `id` | VARCHAR(32) PK | UUID-style annotation ID |
| `slide_id` | INTEGER FK | References `slides.id` - CASCADE |
| `study_id` | VARCHAR(255) | **Orthanc Study ID** (legacy/API compatibility) |
| `user_id` | INTEGER FK | Creator |
| `type` | VARCHAR(50) | `'measurement'`, `'region'`, etc. |
| `tool` | VARCHAR(50) | `'ruler'`, `'area'`, `'freehand'`, etc. |
| `geometry` | JSONB | Shape coordinates |
| `properties` | JSONB | Color, label, measurements |

⚠️ **Note:** `study_id` here is the Orthanc ID string, not the internal `slides.id`.

---

### `annotation_comments`
Discussion threads on annotations.

| Column | Type | Description |
|--------|------|-------------|
| `id` | SERIAL PK | Comment ID |
| `annotation_id` | VARCHAR(32) FK | References `annotations.id` - CASCADE |
| `user_id` | INTEGER FK | Comment author |
| `guest_name` | VARCHAR(100) | For anonymous/public comments |
| `content` | TEXT | Comment text |
| `parent_id` | INTEGER FK | For threaded replies |
| `is_resolved` | BOOLEAN | Thread resolved status |

---

## Common Query Patterns

### Get slides accessible to a user
```sql
-- Use the helper function
SELECT * FROM get_user_slides(user_id);

-- Or manually:
-- 1. Owned slides
SELECT s.* FROM slides s WHERE s.owner_id = :user_id

UNION

-- 2. Directly shared
SELECT s.* FROM slides s
JOIN slide_shares ss ON s.id = ss.slide_id
WHERE ss.shared_with_id = :user_id

UNION

-- 3. Via case share
SELECT s.* FROM slides s
JOIN case_shares cs ON s.case_id = cs.case_id
WHERE cs.shared_with_id = :user_id
```

### Delete a slide and all related data
```sql
-- Order matters due to foreign keys, or use CASCADE
BEGIN;
  DELETE FROM annotations WHERE study_id = :orthanc_study_id;  -- uses orthanc ID
  DELETE FROM slide_shares WHERE slide_id = :slide_db_id;      -- uses internal ID
  DELETE FROM pending_shares WHERE slide_id = :slide_db_id;
  DELETE FROM public_shares WHERE slide_id = :slide_db_id;
  DELETE FROM slides WHERE id = :slide_db_id;
COMMIT;
```

### Check if user can access a slide
```sql
SELECT EXISTS (
  SELECT 1 FROM slides s
  WHERE s.orthanc_study_id = :orthanc_id
  AND (
    s.owner_id = :user_id
    OR s.is_sample = true
    OR EXISTS (SELECT 1 FROM slide_shares ss WHERE ss.slide_id = s.id AND ss.shared_with_id = :user_id)
    OR EXISTS (SELECT 1 FROM case_shares cs WHERE cs.case_id = s.case_id AND cs.shared_with_id = :user_id)
  )
);
```

---

## Cascade Behavior

| Parent Table | Child Table | On Delete |
|--------------|-------------|-----------|
| `users` | `slides.owner_id` | SET NULL |
| `users` | `*_shares.owner_id` | CASCADE |
| `slides` | `slide_shares` | CASCADE |
| `slides` | `pending_shares` | CASCADE |
| `slides` | `public_shares` | CASCADE |
| `slides` | `annotations` | CASCADE |
| `annotations` | `annotation_comments` | CASCADE |
| `cases` | `slides.case_id` | SET NULL |
| `cases` | `case_shares` | CASCADE |

---

## Permission Levels

| Permission | View Slide | Create Annotations | Edit Own Annotations | Delete Own Annotations | Edit Others' |
|------------|------------|-------------------|---------------------|----------------------|--------------|
| `view` | ✅ | ❌ | ❌ | ❌ | ❌ |
| `annotate` | ✅ | ✅ | ✅ | ✅ | ❌ |
| `full` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `owner` | ✅ | ✅ | ✅ | ✅ | ✅ |
