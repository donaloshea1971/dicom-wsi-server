"""
Auth0 JWT Authentication for PathView Pro
Handles token validation and user management
"""

import os
import logging
from typing import Optional
from functools import lru_cache

import httpx
from fastapi import Depends, HTTPException, status, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import jwt, JWTError
from pydantic import BaseModel
import asyncpg

logger = logging.getLogger(__name__)

# Auth0 Configuration - MUST be set via environment variables
AUTH0_DOMAIN = os.getenv("AUTH0_DOMAIN")
AUTH0_AUDIENCE = os.getenv("AUTH0_AUDIENCE")
AUTH0_ALGORITHMS = ["RS256"]

if not AUTH0_DOMAIN:
    logger.warning("AUTH0_DOMAIN not set - authentication will fail")
if not AUTH0_AUDIENCE:
    logger.warning("AUTH0_AUDIENCE not set - authentication will fail")

# Database configuration - MUST be set via environment variable
DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    logger.warning("DATABASE_URL not set - user management will fail")

# Security scheme
security = HTTPBearer(auto_error=False)


class User(BaseModel):
    """Authenticated user model"""
    id: Optional[int] = None
    auth0_id: str
    email: str
    name: Optional[str] = None
    picture: Optional[str] = None
    role: str = "user"


class TokenPayload(BaseModel):
    """JWT token payload"""
    sub: str  # Auth0 user ID
    email: Optional[str] = None
    name: Optional[str] = None
    picture: Optional[str] = None


# Cache for Auth0 JWKS (JSON Web Key Set)
_jwks_cache = None


async def get_jwks():
    """Fetch Auth0 JWKS for token verification"""
    global _jwks_cache
    if _jwks_cache is None:
        async with httpx.AsyncClient() as client:
            response = await client.get(
                f"https://{AUTH0_DOMAIN}/.well-known/jwks.json"
            )
            response.raise_for_status()
            _jwks_cache = response.json()
    return _jwks_cache


async def verify_token(token: str) -> TokenPayload:
    """Verify Auth0 JWT token and extract payload"""
    try:
        jwks = await get_jwks()
        
        # Get the key ID from token header
        unverified_header = jwt.get_unverified_header(token)
        rsa_key = {}
        
        for key in jwks["keys"]:
            if key["kid"] == unverified_header["kid"]:
                rsa_key = {
                    "kty": key["kty"],
                    "kid": key["kid"],
                    "use": key["use"],
                    "n": key["n"],
                    "e": key["e"]
                }
                break
        
        if not rsa_key:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Unable to find appropriate key"
            )
        
        # Verify and decode token
        payload = jwt.decode(
            token,
            rsa_key,
            algorithms=AUTH0_ALGORITHMS,
            audience=AUTH0_AUDIENCE,
            issuer=f"https://{AUTH0_DOMAIN}/"
        )
        
        return TokenPayload(
            sub=payload.get("sub"),
            email=payload.get("email") or payload.get(f"https://{AUTH0_DOMAIN}/email"),
            name=payload.get("name") or payload.get(f"https://{AUTH0_DOMAIN}/name"),
            picture=payload.get("picture")
        )
        
    except JWTError as e:
        logger.error(f"JWT verification failed: {e}")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid token: {str(e)}"
        )


# Database connection pool
_db_pool = None


async def get_db_pool():
    """Get or create database connection pool"""
    global _db_pool
    if _db_pool is None:
        try:
            _db_pool = await asyncpg.create_pool(
                DATABASE_URL,
                min_size=2,
                max_size=10
            )
            logger.info("Database connection pool created")
        except Exception as e:
            logger.error(f"Failed to create database pool: {e}")
            # Return None - we'll handle this gracefully
            return None
    return _db_pool


async def get_or_create_user(token_payload: TokenPayload) -> User:
    """Get existing user or create new one from Auth0 token"""
    pool = await get_db_pool()
    
    if pool is None:
        # Database not available - return user without DB ID
        logger.warning("Database not available - returning user without persistence")
        return User(
            auth0_id=token_payload.sub,
            email=token_payload.email or "unknown@email.com",
            name=token_payload.name,
            picture=token_payload.picture,
            role="user"
        )
    
    async with pool.acquire() as conn:
        # Try to get existing user
        row = await conn.fetchrow(
            "SELECT id, auth0_id, email, name, picture, role FROM users WHERE auth0_id = $1",
            token_payload.sub
        )
        
        if row:
            # Update last login
            await conn.execute(
                "UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1",
                row["id"]
            )
            return User(
                id=row["id"],
                auth0_id=row["auth0_id"],
                email=row["email"],
                name=row["name"],
                picture=row["picture"],
                role=row["role"]
            )
        
        # Create new user
        email = token_payload.email or f"{token_payload.sub}@auth0.user"
        row = await conn.fetchrow(
            """
            INSERT INTO users (auth0_id, email, name, picture, role)
            VALUES ($1, $2, $3, $4, 'user')
            ON CONFLICT (auth0_id) DO UPDATE SET
                email = EXCLUDED.email,
                name = EXCLUDED.name,
                picture = EXCLUDED.picture,
                last_login = CURRENT_TIMESTAMP
            RETURNING id, auth0_id, email, name, picture, role
            """,
            token_payload.sub,
            email,
            token_payload.name,
            token_payload.picture
        )
        
        logger.info(f"Created new user: {email}")
        return User(
            id=row["id"],
            auth0_id=row["auth0_id"],
            email=row["email"],
            name=row["name"],
            picture=row["picture"],
            role=row["role"]
        )


async def get_current_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security)
) -> Optional[User]:
    """
    FastAPI dependency to get current authenticated user.
    Returns None if no valid token (allows public access with filtering)
    """
    if credentials is None:
        return None
    
    try:
        token_payload = await verify_token(credentials.credentials)
        user = await get_or_create_user(token_payload)
        return user
    except HTTPException:
        return None
    except Exception as e:
        logger.error(f"Error getting current user: {e}")
        return None


async def require_user(
    credentials: HTTPAuthorizationCredentials = Depends(security)
) -> User:
    """
    FastAPI dependency that requires authentication.
    Raises 401 if not authenticated.
    """
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required"
        )
    
    token_payload = await verify_token(credentials.credentials)
    user = await get_or_create_user(token_payload)
    return user


async def require_admin(user: User = Depends(require_user)) -> User:
    """
    FastAPI dependency that requires admin role.
    Raises 403 if not admin.
    """
    if user.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin access required"
        )
    return user


# =============================================================================
# Study Ownership Functions
# =============================================================================

async def set_study_owner(study_id: str, user_id: int, force: bool = False) -> bool:
    """
    Set the owner of a study.
    
    Args:
        study_id: Orthanc study ID
        user_id: Database user ID
        force: If True, overwrite existing ownership. If False, only set if unowned.
        
    Returns:
        True if ownership was set, False if already owned (when force=False) or error
    """
    pool = await get_db_pool()
    if pool is None:
        logger.error("Database pool not available for set_study_owner")
        return False
    
    async with pool.acquire() as conn:
        try:
            if force:
                # Always set ownership (overwrite if exists)
                await conn.execute(
                    """
                    INSERT INTO study_owners (study_id, user_id)
                    VALUES ($1, $2)
                    ON CONFLICT (study_id) DO UPDATE SET user_id = $2
                    """,
                    study_id,
                    user_id
                )
                logger.info(f"Set study {study_id} owner to user {user_id} (forced)")
                return True
            else:
                # Only set if not already owned
                result = await conn.execute(
                    """
                    INSERT INTO study_owners (study_id, user_id)
                    VALUES ($1, $2)
                    ON CONFLICT (study_id) DO NOTHING
                    """,
                    study_id,
                    user_id
                )
                # Check if insert happened (result format: "INSERT 0 1" or "INSERT 0 0")
                rows_affected = int(result.split()[-1])
                if rows_affected > 0:
                    logger.info(f"Set study {study_id} owner to user {user_id}")
                    return True
                else:
                    # Study already has an owner
                    existing = await conn.fetchrow(
                        "SELECT user_id FROM study_owners WHERE study_id = $1",
                        study_id
                    )
                    if existing and existing["user_id"] == user_id:
                        logger.debug(f"Study {study_id} already owned by user {user_id}")
                        return True  # Already owned by same user
                    else:
                        logger.warning(f"Study {study_id} already owned by user {existing['user_id'] if existing else 'unknown'}")
                        return False
        except Exception as e:
            logger.error(f"Failed to set study owner: {e}")
            return False


async def get_study_owner(study_id: str) -> Optional[int]:
    """Get the owner user_id of a study, or None if unowned"""
    pool = await get_db_pool()
    if pool is None:
        return None
    
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT user_id FROM study_owners WHERE study_id = $1",
            study_id
        )
        return row["user_id"] if row else None


async def get_user_study_ids(user_id: int) -> list[str]:
    """Get list of study IDs visible to a user (owned + shared)"""
    pool = await get_db_pool()
    if pool is None:
        return []
    
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT study_id FROM study_owners WHERE user_id = $1
            UNION
            SELECT study_id FROM study_shares WHERE shared_with_id = $1
            """,
            user_id
        )
        return [row["study_id"] for row in rows]


async def can_access_study(user_id: int, study_id: str) -> bool:
    """Check if user can access a specific study"""
    pool = await get_db_pool()
    if pool is None:
        return True  # Allow access if DB unavailable
    
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT 1 FROM study_owners WHERE study_id = $1 AND user_id = $2
            UNION
            SELECT 1 FROM study_shares WHERE study_id = $1 AND shared_with_id = $2
            """,
            study_id,
            user_id
        )
        return row is not None


async def share_study(study_id: str, owner_id: int, share_with_email: str, permission: str = "view") -> bool:
    """Share a study with another user by email"""
    pool = await get_db_pool()
    if pool is None:
        return False
    
    async with pool.acquire() as conn:
        # Find user by email
        target_user = await conn.fetchrow(
            "SELECT id FROM users WHERE email = $1",
            share_with_email
        )
        
        if not target_user:
            return False
        
        # Verify ownership
        is_owner = await conn.fetchrow(
            "SELECT 1 FROM study_owners WHERE study_id = $1 AND user_id = $2",
            study_id,
            owner_id
        )
        
        if not is_owner:
            return False
        
        # Create share
        await conn.execute(
            """
            INSERT INTO study_shares (study_id, owner_id, shared_with_id, permission)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (study_id, shared_with_id) DO UPDATE SET permission = EXCLUDED.permission
            """,
            study_id,
            owner_id,
            target_user["id"],
            permission
        )
        
        return True


async def unshare_study(study_id: str, owner_id: int, unshare_user_id: int) -> bool:
    """Remove a share from a study"""
    pool = await get_db_pool()
    if pool is None:
        return False
    
    async with pool.acquire() as conn:
        # Verify ownership
        is_owner = await conn.fetchrow(
            "SELECT 1 FROM study_owners WHERE study_id = $1 AND user_id = $2",
            study_id,
            owner_id
        )
        
        if not is_owner:
            return False
        
        # Remove share
        await conn.execute(
            "DELETE FROM study_shares WHERE study_id = $1 AND shared_with_id = $2",
            study_id,
            unshare_user_id
        )
        
        return True


async def get_owned_study_ids(user_id: int) -> set[str]:
    """Get study IDs owned by a user (from slides table)"""
    pool = await get_db_pool()
    if pool is None:
        return set()
    
    try:
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT orthanc_study_id FROM slides WHERE owner_id = $1",
                user_id
            )
            return set(row["orthanc_study_id"] for row in rows)
    except Exception as e:
        logger.error(f"get_owned_study_ids error: {e}")
        return set()


async def get_shared_with_me_study_ids(user_id: int) -> set[str]:
    """Get study IDs shared with a user (from slide_shares table)"""
    pool = await get_db_pool()
    if pool is None:
        return set()
    
    try:
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT s.orthanc_study_id 
                FROM slides s
                JOIN slide_shares ss ON s.id = ss.slide_id
                WHERE ss.shared_with_id = $1
                """,
                user_id
            )
            return set(row["orthanc_study_id"] for row in rows)
    except Exception as e:
        logger.error(f"get_shared_with_me_study_ids error: {e}")
        return set()


async def get_study_shares(study_id: str, owner_id: int) -> list[dict]:
    """Get list of users a study is shared with"""
    pool = await get_db_pool()
    if pool is None:
        return []
    
    async with pool.acquire() as conn:
        # Verify ownership
        is_owner = await conn.fetchrow(
            "SELECT 1 FROM study_owners WHERE study_id = $1 AND user_id = $2",
            study_id,
            owner_id
        )
        
        if not is_owner:
            return []
        
        rows = await conn.fetch(
            """
            SELECT ss.shared_with_id, ss.permission, ss.created_at, u.email, u.name, u.picture
            FROM study_shares ss
            JOIN users u ON ss.shared_with_id = u.id
            WHERE ss.study_id = $1
            """,
            study_id
        )
        
        return [
            {
                "user_id": row["shared_with_id"],
                "email": row["email"],
                "name": row["name"],
                "picture": row["picture"],
                "permission": row["permission"],
                "shared_at": row["created_at"].isoformat() if row["created_at"] else None
            }
            for row in rows
        ]


async def get_share_counts_for_studies(study_ids: list[str]) -> dict[str, int]:
    """Get share counts for multiple studies at once"""
    if not study_ids:
        return {}
    
    pool = await get_db_pool()
    if pool is None:
        return {}
    
    try:
        async with pool.acquire() as conn:
            # Try slide_shares first (new schema), fall back to study_shares
            rows = await conn.fetch(
                """
                SELECT s.orthanc_study_id as study_id, COUNT(ss.id) as share_count
                FROM slides s
                LEFT JOIN slide_shares ss ON s.id = ss.slide_id
                WHERE s.orthanc_study_id = ANY($1)
                GROUP BY s.orthanc_study_id
                """,
                study_ids
            )
            
            return {row["study_id"]: row["share_count"] for row in rows}
    except Exception as e:
        logger.error(f"get_share_counts_for_studies error: {e}")
        return {}


async def search_users(query: str = None, exclude_user_id: int = None, limit: int = 50) -> list[dict]:
    """Search users by email or name. Returns all users if query is None or empty."""
    pool = await get_db_pool()
    if pool is None:
        return []
    
    async with pool.acquire() as conn:
        # If no query, return all users
        if not query:
            if exclude_user_id:
                rows = await conn.fetch(
                    """
                    SELECT id, email, name, picture
                    FROM users
                    WHERE id != $1
                    ORDER BY name, email
                    LIMIT $2
                    """,
                    exclude_user_id,
                    limit
                )
            else:
                rows = await conn.fetch(
                    """
                    SELECT id, email, name, picture
                    FROM users
                    ORDER BY name, email
                    LIMIT $1
                    """,
                    limit
                )
        else:
            # Search by email or name (case insensitive)
            search_pattern = f"%{query}%"
            
            if exclude_user_id:
                rows = await conn.fetch(
                    """
                    SELECT id, email, name, picture
                    FROM users
                    WHERE (email ILIKE $1 OR name ILIKE $1)
                    AND id != $2
                    ORDER BY name, email
                    LIMIT $3
                    """,
                    search_pattern,
                    exclude_user_id,
                    limit
                )
            else:
                rows = await conn.fetch(
                    """
                    SELECT id, email, name, picture
                    FROM users
                    WHERE email ILIKE $1 OR name ILIKE $1
                    ORDER BY name, email
                    LIMIT $2
                    """,
                    search_pattern,
                    limit
                )
        
        return [
            {
                "id": row["id"],
                "email": row["email"],
                "name": row["name"],
                "picture": row["picture"]
            }
            for row in rows
        ]


async def update_user_profile(user_id: int, email: str = None, name: str = None, picture: str = None) -> bool:
    """Update user profile with info from Auth0 userinfo"""
    pool = await get_db_pool()
    if pool is None:
        return False
    
    async with pool.acquire() as conn:
        # Build update query dynamically based on provided fields
        updates = []
        params = []
        param_idx = 1
        
        if email and not email.endswith("@auth0.user"):
            updates.append(f"email = ${param_idx}")
            params.append(email)
            param_idx += 1
        
        if name:
            updates.append(f"name = ${param_idx}")
            params.append(name)
            param_idx += 1
            
        if picture:
            updates.append(f"picture = ${param_idx}")
            params.append(picture)
            param_idx += 1
        
        if not updates:
            return False
        
        params.append(user_id)
        query = f"UPDATE users SET {', '.join(updates)} WHERE id = ${param_idx}"
        
        result = await conn.execute(query, *params)
        logger.info(f"Updated user {user_id} profile: {result}")
        return "UPDATE" in result


async def batch_share_studies(study_ids: list[str], owner_id: int, share_with_email: str, permission: str = "view") -> dict:
    """Share multiple studies with a user at once"""
    pool = await get_db_pool()
    if pool is None:
        return {"success": 0, "failed": len(study_ids), "errors": ["Database unavailable"]}
    
    async with pool.acquire() as conn:
        # Find target user
        target_user = await conn.fetchrow(
            "SELECT id FROM users WHERE email = $1",
            share_with_email
        )
        
        if not target_user:
            return {"success": 0, "failed": len(study_ids), "errors": [f"User {share_with_email} not found"]}
        
        target_user_id = target_user["id"]
        success = 0
        failed = 0
        errors = []
        
        for study_id in study_ids:
            # Verify ownership
            is_owner = await conn.fetchrow(
                "SELECT 1 FROM study_owners WHERE study_id = $1 AND user_id = $2",
                study_id,
                owner_id
            )
            
            if not is_owner:
                failed += 1
                errors.append(f"Not owner of {study_id}")
                continue
            
            try:
                await conn.execute(
                    """
                    INSERT INTO study_shares (study_id, owner_id, shared_with_id, permission)
                    VALUES ($1, $2, $3, $4)
                    ON CONFLICT (study_id, shared_with_id) DO UPDATE SET permission = EXCLUDED.permission
                    """,
                    study_id,
                    owner_id,
                    target_user_id,
                    permission
                )
                success += 1
            except Exception as e:
                failed += 1
                errors.append(f"Failed to share {study_id}: {str(e)}")
        
        return {"success": success, "failed": failed, "errors": errors if errors else None}


# =============================================================================
# Slide Management Functions (New Hierarchy Model)
# =============================================================================

async def get_slides_metadata_bulk(orthanc_ids: list[str]) -> dict:
    """Get slide metadata for multiple Orthanc study IDs at once.
    Returns dict mapping orthanc_id -> metadata"""
    if not orthanc_ids:
        return {}
    
    pool = await get_db_pool()
    if pool is None:
        return {}
    
    try:
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT s.orthanc_study_id, s.display_name, s.stain,
                       s.case_id, s.block_id, s.patient_id,
                       c.accession_number as case_accession,
                       b.block_id as block_name,
                       p.name as patient_name, p.mrn as patient_mrn
                FROM slides s
                LEFT JOIN cases c ON s.case_id = c.id
                LEFT JOIN blocks b ON s.block_id = b.id
                LEFT JOIN patients p ON s.patient_id = p.id
                WHERE s.orthanc_study_id = ANY($1)
                """,
                orthanc_ids
            )
            
            return {
                row["orthanc_study_id"]: {
                    "display_name": row["display_name"],
                    "stain": row["stain"],
                    "case_id": row["case_id"],
                    "block_id": row["block_id"],
                    "patient_id": row["patient_id"],
                    "case_accession": row["case_accession"],
                    "block_name": row["block_name"],
                    "patient_name": row["patient_name"],
                    "patient_mrn": row["patient_mrn"]
                }
                for row in rows
            }
    except Exception as e:
        logger.error(f"get_slides_metadata_bulk error: {e}")
        return {}


async def get_slide_by_orthanc_id(orthanc_study_id: str) -> Optional[dict]:
    """Get slide record by Orthanc study ID"""
    pool = await get_db_pool()
    if pool is None:
        return None
    
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT id, orthanc_study_id, display_name, stain, original_filename,
                       source_format, scanner_manufacturer, width, height, magnification,
                       block_id, case_id, patient_id, owner_id, is_sample,
                       created_at, updated_at
                FROM slides
                WHERE orthanc_study_id = $1
                """,
                orthanc_study_id
            )
            
            if row:
                return dict(row)
            return None
    except Exception as e:
        logger.error(f"get_slide_by_orthanc_id error (table may not exist): {e}")
        return None


async def create_slide(
    orthanc_study_id: str,
    owner_id: Optional[int] = None,
    display_name: Optional[str] = None,
    stain: Optional[str] = None,
    original_filename: Optional[str] = None,
    source_format: Optional[str] = None,
    scanner_manufacturer: Optional[str] = None,
    width: Optional[int] = None,
    height: Optional[int] = None,
    magnification: Optional[str] = None,
    block_id: Optional[int] = None,
    case_id: Optional[int] = None,
    patient_id: Optional[int] = None
) -> Optional[int]:
    """Create a new slide record, returns slide ID"""
    pool = await get_db_pool()
    if pool is None:
        return None
    
    async with pool.acquire() as conn:
        try:
            row = await conn.fetchrow(
                """
                INSERT INTO slides (
                    orthanc_study_id, owner_id, display_name, stain,
                    original_filename, source_format, scanner_manufacturer,
                    width, height, magnification, block_id, case_id, patient_id
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                ON CONFLICT (orthanc_study_id) DO UPDATE SET
                    owner_id = COALESCE(EXCLUDED.owner_id, slides.owner_id),
                    display_name = COALESCE(EXCLUDED.display_name, slides.display_name),
                    stain = COALESCE(EXCLUDED.stain, slides.stain),
                    original_filename = COALESCE(EXCLUDED.original_filename, slides.original_filename),
                    source_format = COALESCE(EXCLUDED.source_format, slides.source_format),
                    updated_at = CURRENT_TIMESTAMP
                RETURNING id
                """,
                orthanc_study_id, owner_id, display_name, stain,
                original_filename, source_format, scanner_manufacturer,
                width, height, magnification, block_id, case_id, patient_id
            )
            return row["id"] if row else None
        except Exception as e:
            logger.error(f"Failed to create slide: {e}")
            return None


async def update_slide(
    slide_id: int,
    display_name: Optional[str] = None,
    stain: Optional[str] = None,
    block_id: Optional[int] = None,
    case_id: Optional[int] = None,
    patient_id: Optional[int] = None
) -> bool:
    """Update slide metadata"""
    pool = await get_db_pool()
    if pool is None:
        return False
    
    async with pool.acquire() as conn:
        # Build dynamic update
        updates = []
        params = []
        idx = 1
        
        if display_name is not None:
            updates.append(f"display_name = ${idx}")
            params.append(display_name)
            idx += 1
        
        if stain is not None:
            updates.append(f"stain = ${idx}")
            params.append(stain)
            idx += 1
            
        # For hierarchy fields, None means "don't change", 0 or -1 means "clear"
        if block_id is not None:
            updates.append(f"block_id = ${idx}")
            params.append(block_id if block_id > 0 else None)
            idx += 1
            
        if case_id is not None:
            updates.append(f"case_id = ${idx}")
            params.append(case_id if case_id > 0 else None)
            idx += 1
            
        if patient_id is not None:
            updates.append(f"patient_id = ${idx}")
            params.append(patient_id if patient_id > 0 else None)
            idx += 1
        
        if not updates:
            return True  # Nothing to update
        
        updates.append("updated_at = CURRENT_TIMESTAMP")
        params.append(slide_id)
        
        query = f"UPDATE slides SET {', '.join(updates)} WHERE id = ${idx}"
        
        try:
            result = await conn.execute(query, *params)
            return "UPDATE 1" in result
        except Exception as e:
            logger.error(f"Failed to update slide: {e}")
            return False


async def get_user_slides(user_id: int) -> list[dict]:
    """Get all slides visible to a user (owned + shared + via case shares)"""
    pool = await get_db_pool()
    if pool is None:
        return []
    
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT DISTINCT s.*, 
                CASE 
                    WHEN s.owner_id = $1 THEN 'owner'
                    WHEN EXISTS (SELECT 1 FROM slide_shares ss WHERE ss.slide_id = s.id AND ss.shared_with_id = $1) THEN 'shared'
                    WHEN EXISTS (SELECT 1 FROM case_shares cs WHERE cs.case_id = s.case_id AND cs.shared_with_id = $1) THEN 'case_shared'
                    ELSE 'sample'
                END as permission
            FROM slides s
            WHERE s.owner_id = $1
               OR EXISTS (SELECT 1 FROM slide_shares ss WHERE ss.slide_id = s.id AND ss.shared_with_id = $1)
               OR EXISTS (SELECT 1 FROM case_shares cs WHERE cs.case_id = s.case_id AND cs.shared_with_id = $1)
               OR s.is_sample = true
            ORDER BY s.created_at DESC
            """,
            user_id
        )
        return [dict(row) for row in rows]


async def get_slides_categorized(user_id: int) -> dict:
    """Get slides organized by ownership category"""
    pool = await get_db_pool()
    if pool is None:
        return {"owned": [], "shared": [], "samples": []}
    
    async with pool.acquire() as conn:
        # Owned slides
        owned = await conn.fetch(
            """
            SELECT s.*, 
                (SELECT COUNT(*) FROM slide_shares ss WHERE ss.slide_id = s.id) as share_count
            FROM slides s
            WHERE s.owner_id = $1
            ORDER BY s.created_at DESC
            """,
            user_id
        )
        
        # Shared with me
        shared = await conn.fetch(
            """
            SELECT s.*, ss.permission, 'slide' as share_type
            FROM slides s
            JOIN slide_shares ss ON ss.slide_id = s.id
            WHERE ss.shared_with_id = $1
            
            UNION
            
            SELECT s.*, cs.permission, 'case' as share_type
            FROM slides s
            JOIN case_shares cs ON cs.case_id = s.case_id
            WHERE cs.shared_with_id = $1
            
            ORDER BY created_at DESC
            """,
            user_id
        )
        
        # Sample slides (unowned or marked as sample)
        samples = await conn.fetch(
            """
            SELECT s.*
            FROM slides s
            WHERE s.is_sample = true
               OR (s.owner_id IS NULL AND NOT EXISTS (
                   SELECT 1 FROM slide_shares ss WHERE ss.slide_id = s.id AND ss.shared_with_id = $1
               ))
            ORDER BY s.created_at DESC
            LIMIT 50
            """,
            user_id
        )
        
        return {
            "owned": [dict(r) for r in owned],
            "shared": [dict(r) for r in shared],
            "samples": [dict(r) for r in samples]
        }


async def get_stain_types() -> list[dict]:
    """Get available stain types for dropdown"""
    pool = await get_db_pool()
    if pool is None:
        # Return defaults if DB unavailable
        return [
            {"code": "HE", "name": "H&E", "category": "Routine"},
            {"code": "ER", "name": "ER", "category": "IHC"},
            {"code": "PR", "name": "PR", "category": "IHC"},
            {"code": "HER2", "name": "HER2", "category": "IHC"},
            {"code": "KI67", "name": "Ki-67", "category": "IHC"},
            {"code": "OTHER", "name": "Other", "category": "Other"},
        ]
    
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT code, name, category FROM stain_types ORDER BY sort_order, name"
        )
        return [dict(r) for r in rows]


# =============================================================================
# Case & Block Management
# =============================================================================

async def create_case(
    owner_id: int,
    accession_number: Optional[str] = None,
    case_type: Optional[str] = None,
    specimen_type: Optional[str] = None,
    patient_id: Optional[int] = None
) -> Optional[int]:
    """Create a new case, returns case ID"""
    pool = await get_db_pool()
    if pool is None:
        return None
    
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO cases (owner_id, accession_number, case_type, specimen_type, patient_id)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id
            """,
            owner_id, accession_number, case_type, specimen_type, patient_id
        )
        return row["id"] if row else None


async def create_block(
    owner_id: int,
    block_id: str,
    case_id: Optional[int] = None,
    tissue_type: Optional[str] = None,
    patient_id: Optional[int] = None
) -> Optional[int]:
    """Create a new block, returns block ID"""
    pool = await get_db_pool()
    if pool is None:
        return None
    
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO blocks (owner_id, block_id, case_id, tissue_type, patient_id)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id
            """,
            owner_id, block_id, case_id, tissue_type, patient_id
        )
        return row["id"] if row else None


async def get_user_blocks(user_id: int) -> list[dict]:
    """Get blocks owned by user"""
    pool = await get_db_pool()
    if pool is None:
        return []
    
    try:
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT b.*,
                    c.accession_number as case_accession,
                    (SELECT COUNT(*) FROM slides s WHERE s.block_id = b.id) as slide_count
                FROM blocks b
                LEFT JOIN cases c ON b.case_id = c.id
                WHERE b.owner_id = $1
                ORDER BY b.created_at DESC
                """,
                user_id
            )
            return [dict(r) for r in rows]
    except Exception as e:
        logger.error(f"get_user_blocks error: {e}")
        return []


async def get_user_cases(user_id: int) -> list[dict]:
    """Get cases owned by or shared with user"""
    pool = await get_db_pool()
    if pool is None:
        return []
    
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT c.*, 
                (SELECT COUNT(*) FROM slides s WHERE s.case_id = c.id) as slide_count,
                p.name as patient_name,
                p.mrn as patient_mrn
            FROM cases c
            LEFT JOIN patients p ON c.patient_id = p.id
            WHERE c.owner_id = $1
               OR EXISTS (SELECT 1 FROM case_shares cs WHERE cs.case_id = c.id AND cs.shared_with_id = $1)
            ORDER BY c.created_at DESC
            """,
            user_id
        )
        return [dict(r) for r in rows]


async def get_user_patients(user_id: int) -> list[dict]:
    """Get patients owned by user"""
    pool = await get_db_pool()
    if pool is None:
        return []
    
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT p.*,
                (SELECT COUNT(*) FROM cases c WHERE c.patient_id = p.id) as case_count,
                (SELECT COUNT(*) FROM slides s WHERE s.patient_id = p.id OR 
                    s.case_id IN (SELECT id FROM cases WHERE patient_id = p.id)) as slide_count
            FROM patients p
            WHERE p.owner_id = $1
            ORDER BY p.name, p.created_at DESC
            """,
            user_id
        )
        return [dict(r) for r in rows]


async def create_patient(
    owner_id: int,
    name: Optional[str] = None,
    mrn: Optional[str] = None
) -> Optional[int]:
    """Create a new patient, returns patient ID"""
    pool = await get_db_pool()
    if pool is None:
        return None
    
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO patients (owner_id, name, mrn)
                VALUES ($1, $2, $3)
                RETURNING id
                """,
                owner_id, name, mrn
            )
            return row["id"] if row else None
    except Exception as e:
        logger.error(f"Failed to create patient: {e}")
        return None
