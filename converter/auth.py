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
        user = User(
            id=row["id"],
            auth0_id=row["auth0_id"],
            email=row["email"],
            name=row["name"],
            picture=row["picture"],
            role=row["role"]
        )
        
        # Process any pending shares for this user
        await process_pending_shares(user.id, email)
        
        return user


async def process_pending_shares(user_id: int, user_email: str):
    """Process pending shares when a new user registers or logs in.
    
    Converts pending_shares records into actual slide_shares/case_shares.
    """
    pool = await get_db_pool()
    if pool is None:
        return
    
    try:
        async with pool.acquire() as conn:
            # Find pending shares for this email
            pending = await conn.fetch(
                """
                SELECT id, slide_id, case_id, owner_id, permission
                FROM pending_shares
                WHERE target_email = $1
                """,
                user_email.lower()
            )
            
            if not pending:
                return
            
            logger.info(f"Processing {len(pending)} pending shares for {user_email}")
            
            for share in pending:
                try:
                    if share["slide_id"]:
                        # Create slide share
                        await conn.execute(
                            """
                            INSERT INTO slide_shares (slide_id, owner_id, shared_with_id, permission)
                            VALUES ($1, $2, $3, $4)
                            ON CONFLICT (slide_id, shared_with_id) DO UPDATE SET permission = EXCLUDED.permission
                            """,
                            share["slide_id"],
                            share["owner_id"],
                            user_id,
                            share["permission"]
                        )
                        logger.info(f"Converted pending slide share {share['id']} for user {user_email}")
                    
                    elif share["case_id"]:
                        # Create case share
                        await conn.execute(
                            """
                            INSERT INTO case_shares (case_id, owner_id, shared_with_id, permission)
                            VALUES ($1, $2, $3, $4)
                            ON CONFLICT (case_id, shared_with_id) DO UPDATE SET permission = EXCLUDED.permission
                            """,
                            share["case_id"],
                            share["owner_id"],
                            user_id,
                            share["permission"]
                        )
                        logger.info(f"Converted pending case share {share['id']} for user {user_email}")
                    
                    # Delete the pending share
                    await conn.execute(
                        "DELETE FROM pending_shares WHERE id = $1",
                        share["id"]
                    )
                except Exception as e:
                    logger.error(f"Failed to convert pending share {share['id']}: {e}")
                    
    except Exception as e:
        logger.error(f"Error processing pending shares for {user_email}: {e}")


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
    Set the owner of a study by creating/updating a slide record.
    
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
                    INSERT INTO slides (orthanc_study_id, owner_id)
                    VALUES ($1, $2)
                    ON CONFLICT (orthanc_study_id) DO UPDATE SET owner_id = $2, updated_at = CURRENT_TIMESTAMP
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
                    INSERT INTO slides (orthanc_study_id, owner_id)
                    VALUES ($1, $2)
                    ON CONFLICT (orthanc_study_id) DO NOTHING
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
                        "SELECT owner_id FROM slides WHERE orthanc_study_id = $1",
                        study_id
                    )
                    if existing and existing["owner_id"] == user_id:
                        logger.debug(f"Study {study_id} already owned by user {user_id}")
                        return True  # Already owned by same user
                    else:
                        logger.warning(f"Study {study_id} already owned by user {existing['owner_id'] if existing else 'unknown'}")
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
            "SELECT owner_id FROM slides WHERE orthanc_study_id = $1",
            study_id
        )
        return row["owner_id"] if row else None


async def get_user_slide_ids(user_id: int) -> list[str]:
    """Get list of study IDs visible to a user (owned + shared via slide or case)"""
    pool = await get_db_pool()
    if pool is None:
        return []
    
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            -- Owned slides
            SELECT orthanc_study_id as study_id FROM slides WHERE owner_id = $1
            UNION
            -- Directly shared slides
            SELECT s.orthanc_study_id as study_id FROM slides s
            JOIN slide_shares ss ON s.id = ss.slide_id WHERE ss.shared_with_id = $1
            UNION
            -- Slides in shared cases
            SELECT s.orthanc_study_id as study_id FROM slides s
            JOIN case_shares cs ON s.case_id = cs.case_id WHERE cs.shared_with_id = $1
            """,
            user_id
        )
        return [row["study_id"] for row in rows]


async def can_access_study(user_id: Optional[int], study_id: str) -> bool:
    """Check if user can access a specific study/slide.
    
    Access is granted if:
    1. User owns the slide (slides.owner_id)
    2. Slide is directly shared with user (slide_shares)
    3. Slide's case is shared with user (case_shares)
    4. Slide is a public sample (slides.is_sample = true)
    5. Slide has no owner record (unowned/sample - accessible to all authenticated users)
    
    For unauthenticated requests (user_id=None), only samples are accessible.
    """
    pool = await get_db_pool()
    if pool is None:
        return True  # Allow access if DB unavailable (fail open for development)
    
    async with pool.acquire() as conn:
        # First check if this slide exists in our database at all
        slide_exists = await conn.fetchrow(
            "SELECT id, owner_id, is_sample FROM slides WHERE orthanc_study_id = $1",
            study_id
        )
        
        # If no record exists, it's an unowned/sample study
        if not slide_exists:
            # Allow access to any authenticated user, or unauthenticated if it's a sample
            return user_id is not None or True  # Unowned slides are effectively samples
        
        # If it's explicitly a sample, allow access to anyone
        if slide_exists["is_sample"]:
            return True
        
        # For non-sample slides, user must be authenticated
        if user_id is None:
            logger.debug(f"Access denied: unauthenticated request for non-sample slide {study_id}")
            return False
        
        # Check ownership and sharing
        row = await conn.fetchrow(
            """
            SELECT 1 FROM slides s
            WHERE s.orthanc_study_id = $2
            AND (
                -- User owns the slide
                s.owner_id = $1
                -- Slide is directly shared with user
                OR EXISTS (
                    SELECT 1 FROM slide_shares ss
                    WHERE ss.slide_id = s.id AND ss.shared_with_id = $1
                )
                -- Slide's case is shared with user
                OR EXISTS (
                    SELECT 1 FROM case_shares cs
                    WHERE cs.case_id = s.case_id AND cs.shared_with_id = $1
                )
            )
            """,
            user_id,
            study_id
        )
        
        if row:
            return True
        
        # Log access denial for debugging
        logger.debug(f"Access denied: user {user_id} cannot access slide {study_id}")
        return False


async def share_slide(study_id: str, owner_id: int, share_with_email: str, permission: str = "view") -> dict:
    """Share a slide with another user by email.
    
    Args:
        study_id: Orthanc study UUID (maps to slides.orthanc_study_id)
        owner_id: ID of the slide owner
        share_with_email: Email of user to share with
        permission: Permission level ('view', 'annotate', 'full')
    
    Returns dict with:
    - success: bool
    - pending: bool (if share is pending user registration)
    - message: str
    """
    pool = await get_db_pool()
    if pool is None:
        return {"success": False, "pending": False, "message": "Database unavailable"}
    
    async with pool.acquire() as conn:
        # Get slide record (must exist)
        slide = await conn.fetchrow(
            "SELECT id, owner_id FROM slides WHERE orthanc_study_id = $1",
            study_id
        )
        
        if not slide:
            logger.warning(f"share_slide: slide not found for {study_id}")
            return {"success": False, "pending": False, "message": "Slide not found"}
        
        # Verify ownership
        if slide["owner_id"] != owner_id:
            logger.warning(f"share_slide: user {owner_id} doesn't own slide {study_id}")
            return {"success": False, "pending": False, "message": "Not owner of this slide"}
        
        # Find user by email
        target_user = await conn.fetchrow(
            "SELECT id FROM users WHERE email = $1",
            share_with_email
        )
        
        if target_user:
            # User exists - create direct share
            await conn.execute(
                """
                INSERT INTO slide_shares (slide_id, owner_id, shared_with_id, permission)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (slide_id, shared_with_id) DO UPDATE SET permission = EXCLUDED.permission
                """,
                slide["id"],
                owner_id,
                target_user["id"],
                permission
            )
            logger.info(f"Shared slide {study_id} with user {target_user['id']}")
            return {"success": True, "pending": False, "message": "Shared successfully"}
        else:
            # User doesn't exist - create pending share
            try:
                await conn.execute(
                    """
                    INSERT INTO pending_shares (slide_id, owner_id, target_email, permission)
                    VALUES ($1, $2, $3, $4)
                    ON CONFLICT (slide_id, target_email) DO UPDATE SET permission = EXCLUDED.permission
                    """,
                    slide["id"],
                    owner_id,
                    share_with_email.lower(),
                    permission
                )
                logger.info(f"Created pending share for slide {study_id} to {share_with_email}")
                return {"success": True, "pending": True, "message": f"Share pending - {share_with_email} will see this when they sign up"}
            except Exception as e:
                logger.error(f"Failed to create pending share: {e}")
                return {"success": False, "pending": False, "message": "Failed to create pending share"}


async def unshare_slide(study_id: str, owner_id: int, unshare_user_id: int) -> dict:
    """Remove a direct share from a slide.
    
    Args:
        study_id: Orthanc study UUID (maps to slides.orthanc_study_id)
        owner_id: ID of the slide owner
        unshare_user_id: ID of user to remove share from
    
    Returns dict with:
    - success: bool
    - message: str
    - has_inherited_access: bool (if user still has access via case share)
    - inherited_from: dict (case info if inherited access exists)
    """
    logger.info(f"unshare_slide called: study_id={study_id}, owner_id={owner_id}, unshare_user_id={unshare_user_id}")
    
    pool = await get_db_pool()
    if pool is None:
        logger.error("unshare_slide: no database pool")
        return {"success": False, "message": "Database unavailable", "has_inherited_access": False}
    
    async with pool.acquire() as conn:
        # Get slide and verify ownership
        slide = await conn.fetchrow(
            "SELECT id, owner_id, case_id FROM slides WHERE orthanc_study_id = $1",
            study_id
        )
        
        logger.info(f"unshare_slide: slide lookup result: {dict(slide) if slide else None}")
        
        if not slide:
            logger.warning(f"unshare_slide: slide not found for {study_id}")
            return {"success": False, "message": "Slide not found", "has_inherited_access": False}
            
        if slide["owner_id"] != owner_id:
            logger.warning(f"unshare_slide: owner mismatch - slide owner={slide['owner_id']}, caller={owner_id}")
            return {"success": False, "message": "Not owner of this slide", "has_inherited_access": False}
        
        # Remove share from slide_shares
        result = await conn.execute(
            "DELETE FROM slide_shares WHERE slide_id = $1 AND shared_with_id = $2",
            slide["id"],
            unshare_user_id
        )
        logger.info(f"unshare_slide: DELETE result={result}")
        
        # Check if user still has inherited access via case share
        has_inherited_access = False
        inherited_from = None
        
        if slide["case_id"]:
            case_share = await conn.fetchrow(
                """
                SELECT cs.id, c.accession_number, c.case_type
                FROM case_shares cs
                JOIN cases c ON cs.case_id = c.id
                WHERE cs.case_id = $1 AND cs.shared_with_id = $2
                """,
                slide["case_id"],
                unshare_user_id
            )
            
            if case_share:
                has_inherited_access = True
                inherited_from = {
                    "case_id": slide["case_id"],
                    "accession": case_share["accession_number"],
                    "case_type": case_share["case_type"]
                }
                logger.info(f"unshare_slide: user {unshare_user_id} still has access via case {slide['case_id']}")
        
        message = "Share removed"
        if has_inherited_access:
            message = f"Direct share removed, but user still has access via case share (Case: {inherited_from['accession'] or inherited_from['case_id']})"
        
        return {
            "success": True,
            "message": message,
            "has_inherited_access": has_inherited_access,
            "inherited_from": inherited_from
        }


async def get_owned_slide_ids(user_id: int) -> set[str]:
    """Get Orthanc study IDs for slides owned by a user.
    
    Returns set of orthanc_study_id values from slides table.
    """
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
        logger.error(f"get_owned_slide_ids error: {e}")
        return set()


async def get_shared_with_me_slide_ids(user_id: int) -> set[str]:
    """Get Orthanc study IDs for slides shared with a user.
    
    Returns set of orthanc_study_id values from slide_shares table.
    """
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
        logger.error(f"get_shared_with_me_slide_ids error: {e}")
        return set()


async def get_study_shares(study_id: str, owner_id: int) -> list[dict]:
    """Get comprehensive list of users with access to a study.
    
    Returns shares from:
    - Direct shares (slide_shares table)
    - Inherited shares from case (case_shares table)
    - Pending shares for unregistered users (pending_shares table)
    
    Each share includes an 'access_origin' field: 'direct', 'case', or 'pending'
    """
    pool = await get_db_pool()
    if pool is None:
        return []
    
    async with pool.acquire() as conn:
        # Get slide and verify ownership
        slide = await conn.fetchrow(
            "SELECT id, owner_id, case_id FROM slides WHERE orthanc_study_id = $1",
            study_id
        )
        
        if not slide or slide["owner_id"] != owner_id:
            return []
        
        shares = []
        seen_users = set()  # Track user IDs to avoid duplicates
        
        # 1. Direct slide shares
        direct_shares = await conn.fetch(
            """
            SELECT ss.shared_with_id, ss.permission, ss.created_at, u.email, u.name, u.picture
            FROM slide_shares ss
            JOIN users u ON ss.shared_with_id = u.id
            WHERE ss.slide_id = $1
            """,
            slide["id"]
        )
        
        for row in direct_shares:
            shares.append({
                "user_id": row["shared_with_id"],
                "email": row["email"],
                "name": row["name"],
                "picture": row["picture"],
                "permission": row["permission"],
                "shared_at": row["created_at"].isoformat() if row["created_at"] else None,
                "access_origin": "direct"
            })
            seen_users.add(row["shared_with_id"])
        
        # 2. Inherited case shares (if slide belongs to a case)
        if slide["case_id"]:
            case_shares = await conn.fetch(
                """
                SELECT cs.shared_with_id, cs.permission, cs.created_at, u.email, u.name, u.picture,
                       c.accession_number as case_accession
                FROM case_shares cs
                JOIN users u ON cs.shared_with_id = u.id
                JOIN cases c ON cs.case_id = c.id
                WHERE cs.case_id = $1
                """,
                slide["case_id"]
            )
            
            for row in case_shares:
                # Skip if user already has direct access
                if row["shared_with_id"] in seen_users:
                    continue
                shares.append({
                    "user_id": row["shared_with_id"],
                    "email": row["email"],
                    "name": row["name"],
                    "picture": row["picture"],
                    "permission": row["permission"],
                    "shared_at": row["created_at"].isoformat() if row["created_at"] else None,
                    "access_origin": "case",
                    "case_id": slide["case_id"],
                    "case_accession": row["case_accession"]
                })
                seen_users.add(row["shared_with_id"])
        
        # 3. Pending shares (for users not yet registered)
        pending_slide_shares = await conn.fetch(
            """
            SELECT ps.id as pending_id, ps.target_email, ps.permission, ps.created_at
            FROM pending_shares ps
            WHERE ps.slide_id = $1
            """,
            slide["id"]
        )
        
        for row in pending_slide_shares:
            shares.append({
                "pending_id": row["pending_id"],
                "email": row["target_email"],
                "name": None,
                "picture": None,
                "permission": row["permission"],
                "shared_at": row["created_at"].isoformat() if row["created_at"] else None,
                "access_origin": "pending"
            })
        
        # 4. Pending case shares (if slide belongs to a case)
        if slide["case_id"]:
            pending_case_shares = await conn.fetch(
                """
                SELECT ps.id as pending_id, ps.target_email, ps.permission, ps.created_at,
                       c.accession_number as case_accession
                FROM pending_shares ps
                JOIN cases c ON ps.case_id = c.id
                WHERE ps.case_id = $1 AND ps.target_email NOT IN (
                    SELECT target_email FROM pending_shares WHERE slide_id = $2
                )
                """,
                slide["case_id"],
                slide["id"]
            )
            
            for row in pending_case_shares:
                shares.append({
                    "pending_id": row["pending_id"],
                    "email": row["target_email"],
                    "name": None,
                    "picture": None,
                    "permission": row["permission"],
                    "shared_at": row["created_at"].isoformat() if row["created_at"] else None,
                    "access_origin": "pending_case",
                    "case_id": slide["case_id"],
                    "case_accession": row["case_accession"]
                })
        
        return shares


async def get_share_counts_for_studies(study_ids: list[str]) -> dict[str, int]:
    """Get share counts for multiple studies at once"""
    if not study_ids:
        return {}
    
    pool = await get_db_pool()
    if pool is None:
        return {}
    
    try:
        async with pool.acquire() as conn:
            # Query slide_shares for share counts
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


# =============================================================================
# Case-Level Sharing Functions
# =============================================================================

async def share_case(case_id: int, owner_id: int, share_with_email: str, permission: str = "view") -> dict:
    """Share an entire case (and all its slides) with another user by email.
    
    Returns dict with:
    - success: bool
    - pending: bool (if share is pending user registration)
    - message: str
    """
    logger.info(f"share_case: case_id={case_id}, owner_id={owner_id}, share_with={share_with_email}")
    
    pool = await get_db_pool()
    if pool is None:
        return {"success": False, "pending": False, "message": "Database unavailable"}
    
    async with pool.acquire() as conn:
        # Verify case exists and user has access to it
        case = await conn.fetchrow(
            """
            SELECT c.id, c.owner_id FROM cases c
            WHERE c.id = $1 AND c.owner_id = $2
            """,
            case_id,
            owner_id
        )
        
        if not case:
            logger.warning(f"share_case: case {case_id} not found or not owned by {owner_id}")
            return {"success": False, "pending": False, "message": "Case not found or not owned"}
        
        # Find target user by email
        target_user = await conn.fetchrow(
            "SELECT id FROM users WHERE email = $1",
            share_with_email
        )
        
        if target_user:
            # User exists - create direct share
            await conn.execute(
                """
                INSERT INTO case_shares (case_id, owner_id, shared_with_id, permission)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (case_id, shared_with_id) DO UPDATE SET permission = EXCLUDED.permission
                """,
                case_id,
                owner_id,
                target_user["id"],
                permission
            )
            logger.info(f"Shared case {case_id} with user {target_user['id']}")
            return {"success": True, "pending": False, "message": "Case shared successfully"}
        else:
            # User doesn't exist - create pending share
            try:
                await conn.execute(
                    """
                    INSERT INTO pending_shares (case_id, owner_id, target_email, permission)
                    VALUES ($1, $2, $3, $4)
                    ON CONFLICT (case_id, target_email) DO UPDATE SET permission = EXCLUDED.permission
                    """,
                    case_id,
                    owner_id,
                    share_with_email.lower(),
                    permission
                )
                logger.info(f"Created pending share for case {case_id} to {share_with_email}")
                return {"success": True, "pending": True, "message": f"Share pending - {share_with_email} will see this when they sign up"}
            except Exception as e:
                logger.error(f"Failed to create pending case share: {e}")
                return {"success": False, "pending": False, "message": "Failed to create pending share"}


async def unshare_case(case_id: int, owner_id: int, unshare_user_id: int) -> dict:
    """Remove a case share.
    
    Returns dict with:
    - success: bool
    - message: str
    """
    logger.info(f"unshare_case: case_id={case_id}, owner_id={owner_id}, unshare_user_id={unshare_user_id}")
    
    pool = await get_db_pool()
    if pool is None:
        return {"success": False, "message": "Database unavailable"}
    
    async with pool.acquire() as conn:
        # Verify ownership
        case = await conn.fetchrow(
            "SELECT id, owner_id FROM cases WHERE id = $1",
            case_id
        )
        
        if not case:
            logger.warning(f"unshare_case: case {case_id} not found")
            return {"success": False, "message": "Case not found"}
            
        if case["owner_id"] != owner_id:
            logger.warning(f"unshare_case: case {case_id} not owned by {owner_id}")
            return {"success": False, "message": "Not owner of this case"}
        
        # Remove share
        result = await conn.execute(
            "DELETE FROM case_shares WHERE case_id = $1 AND shared_with_id = $2",
            case_id,
            unshare_user_id
        )
        logger.info(f"unshare_case: DELETE result={result}")
        
        return {"success": True, "message": "Case share removed"}


async def delete_pending_slide_share(study_id: str, owner_id: int, target_email: str) -> dict:
    """Remove a pending slide share before the user registers.
    
    Returns dict with:
    - success: bool
    - message: str
    """
    logger.info(f"delete_pending_slide_share: study_id={study_id}, owner_id={owner_id}, email={target_email}")
    
    pool = await get_db_pool()
    if pool is None:
        return {"success": False, "message": "Database unavailable"}
    
    async with pool.acquire() as conn:
        # Get slide and verify ownership
        slide = await conn.fetchrow(
            "SELECT id, owner_id FROM slides WHERE orthanc_study_id = $1",
            study_id
        )
        
        if not slide:
            return {"success": False, "message": "Slide not found"}
            
        if slide["owner_id"] != owner_id:
            return {"success": False, "message": "Not owner of this slide"}
        
        # Remove pending share
        result = await conn.execute(
            "DELETE FROM pending_shares WHERE slide_id = $1 AND target_email = $2",
            slide["id"],
            target_email.lower()
        )
        logger.info(f"delete_pending_slide_share: DELETE result={result}")
        
        # Check if any rows were deleted
        if "DELETE 0" in result:
            return {"success": False, "message": "Pending share not found"}
        
        return {"success": True, "message": "Pending share removed"}


async def delete_pending_case_share(case_id: int, owner_id: int, target_email: str) -> dict:
    """Remove a pending case share before the user registers.
    
    Returns dict with:
    - success: bool
    - message: str
    """
    logger.info(f"delete_pending_case_share: case_id={case_id}, owner_id={owner_id}, email={target_email}")
    
    pool = await get_db_pool()
    if pool is None:
        return {"success": False, "message": "Database unavailable"}
    
    async with pool.acquire() as conn:
        # Verify ownership
        case = await conn.fetchrow(
            "SELECT id, owner_id FROM cases WHERE id = $1",
            case_id
        )
        
        if not case:
            return {"success": False, "message": "Case not found"}
            
        if case["owner_id"] != owner_id:
            return {"success": False, "message": "Not owner of this case"}
        
        # Remove pending share
        result = await conn.execute(
            "DELETE FROM pending_shares WHERE case_id = $1 AND target_email = $2",
            case_id,
            target_email.lower()
        )
        logger.info(f"delete_pending_case_share: DELETE result={result}")
        
        # Check if any rows were deleted
        if "DELETE 0" in result:
            return {"success": False, "message": "Pending share not found"}
        
        return {"success": True, "message": "Pending share removed"}


async def get_case_shares(case_id: int, owner_id: int) -> list[dict]:
    """Get comprehensive list of users with access to a case.
    
    Returns shares from:
    - Direct case shares (case_shares table)
    - Pending shares for unregistered users (pending_shares table)
    
    Each share includes an 'access_origin' field: 'direct' or 'pending'
    """
    pool = await get_db_pool()
    if pool is None:
        return []
    
    async with pool.acquire() as conn:
        # Verify ownership
        case = await conn.fetchrow(
            "SELECT id, owner_id FROM cases WHERE id = $1",
            case_id
        )
        
        if not case or case["owner_id"] != owner_id:
            return []
        
        shares = []
        
        # 1. Direct case shares
        direct_shares = await conn.fetch(
            """
            SELECT cs.shared_with_id, cs.permission, cs.created_at, u.email, u.name, u.picture
            FROM case_shares cs
            JOIN users u ON cs.shared_with_id = u.id
            WHERE cs.case_id = $1
            """,
            case_id
        )
        
        for row in direct_shares:
            shares.append({
                "user_id": row["shared_with_id"],
                "email": row["email"],
                "name": row["name"],
                "picture": row["picture"],
                "permission": row["permission"],
                "shared_at": row["created_at"].isoformat() if row["created_at"] else None,
                "access_origin": "direct"
            })
        
        # 2. Pending shares (for users not yet registered)
        pending_shares = await conn.fetch(
            """
            SELECT ps.id as pending_id, ps.target_email, ps.permission, ps.created_at
            FROM pending_shares ps
            WHERE ps.case_id = $1
            """,
            case_id
        )
        
        for row in pending_shares:
            shares.append({
                "pending_id": row["pending_id"],
                "email": row["target_email"],
                "name": None,
                "picture": None,
                "permission": row["permission"],
                "shared_at": row["created_at"].isoformat() if row["created_at"] else None,
                "access_origin": "pending"
            })
        
        return shares


async def get_slide_access_info(user_id: int, study_id: str) -> dict:
    """Get detailed access information for a slide - used by UI to show share source"""
    pool = await get_db_pool()
    if pool is None:
        return {"has_access": False}
    
    async with pool.acquire() as conn:
        slide = await conn.fetchrow(
            "SELECT id, owner_id, case_id, is_sample FROM slides WHERE orthanc_study_id = $1",
            study_id
        )
        
        if not slide:
            return {"has_access": False}
        
        # Check owner
        if slide["owner_id"] == user_id:
            return {"has_access": True, "access_type": "owner"}
        
        # Check if sample
        if slide["is_sample"]:
            return {"has_access": True, "access_type": "sample"}
        
        # Check direct share
        direct_share = await conn.fetchrow(
            "SELECT permission FROM slide_shares WHERE slide_id = $1 AND shared_with_id = $2",
            slide["id"],
            user_id
        )
        if direct_share:
            return {"has_access": True, "access_type": "direct_share", "permission": direct_share["permission"]}
        
        # Check case share
        if slide["case_id"]:
            case_share = await conn.fetchrow(
                "SELECT permission FROM case_shares WHERE case_id = $1 AND shared_with_id = $2",
                slide["case_id"],
                user_id
            )
            if case_share:
                return {"has_access": True, "access_type": "case_share", "permission": case_share["permission"]}
        
        return {"has_access": False}


async def get_user_by_email(email: str) -> Optional[dict]:
    """Get user by email address"""
    pool = await get_db_pool()
    if pool is None:
        return None
    
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT id, email, name, picture FROM users WHERE email = $1",
                email
            )
            return dict(row) if row else None
    except Exception as e:
        logger.error(f"get_user_by_email error: {e}")
        return None


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
    """Share multiple studies with a user at once.
    
    If the target user is not registered, creates pending shares instead.
    
    Returns dict with:
    - success: int (count of successful shares)
    - failed: int (count of failed shares)
    - pending: bool (true if shares are pending user registration)
    - errors: list[str] (error messages, if any)
    """
    pool = await get_db_pool()
    if pool is None:
        return {"success": 0, "failed": len(study_ids), "pending": False, "errors": ["Database unavailable"]}
    
    async with pool.acquire() as conn:
        # Find target user
        target_user = await conn.fetchrow(
            "SELECT id FROM users WHERE email = $1",
            share_with_email.lower()
        )
        
        is_pending = target_user is None
        target_user_id = target_user["id"] if target_user else None
        
        success = 0
        failed = 0
        errors = []
        
        for study_id in study_ids:
            # Get slide and verify ownership
            slide = await conn.fetchrow(
                "SELECT id, owner_id FROM slides WHERE orthanc_study_id = $1",
                study_id
            )
            
            if not slide:
                failed += 1
                errors.append(f"Slide record not found for {study_id}")
                continue
                
            if slide["owner_id"] != owner_id:
                failed += 1
                errors.append(f"Not owner of {study_id}")
                continue
            
            try:
                if target_user_id:
                    # User exists - create direct share
                    await conn.execute(
                        """
                        INSERT INTO slide_shares (slide_id, owner_id, shared_with_id, permission)
                        VALUES ($1, $2, $3, $4)
                        ON CONFLICT (slide_id, shared_with_id) DO UPDATE SET permission = EXCLUDED.permission
                        """,
                        slide["id"],
                        owner_id,
                        target_user_id,
                        permission
                    )
                    success += 1
                else:
                    # User doesn't exist - create pending share
                    await conn.execute(
                        """
                        INSERT INTO pending_shares (slide_id, owner_id, target_email, permission)
                        VALUES ($1, $2, $3, $4)
                        ON CONFLICT (slide_id, target_email) DO UPDATE SET permission = EXCLUDED.permission
                        """,
                        slide["id"],
                        owner_id,
                        share_with_email.lower(),
                        permission
                    )
                    success += 1
            except Exception as e:
                failed += 1
                errors.append(f"Failed to share {study_id}: {str(e)}")
        
        return {
            "success": success, 
            "failed": failed, 
            "pending": is_pending,
            "errors": errors if errors else None
        }


async def batch_unshare_studies(study_ids: list[str], owner_id: int, unshare_user_id: int) -> dict:
    """Unshare multiple studies from a user at once"""
    pool = await get_db_pool()
    if pool is None:
        return {"success": 0, "failed": len(study_ids), "errors": ["Database unavailable"]}
    
    success = 0
    failed = 0
    errors = []
    
    async with pool.acquire() as conn:
        for study_id in study_ids:
            # Verify ownership
            slide = await conn.fetchrow(
                "SELECT id, owner_id FROM slides WHERE orthanc_study_id = $1",
                study_id
            )
            
            if not slide:
                failed += 1
                errors.append(f"Slide not found: {study_id}")
                continue
            
            if slide["owner_id"] != owner_id:
                failed += 1
                errors.append(f"Not owner of {study_id}")
                continue
            
            try:
                result = await conn.execute(
                    "DELETE FROM slide_shares WHERE slide_id = $1 AND shared_with_id = $2",
                    slide["id"],
                    unshare_user_id
                )
                # Check if any row was deleted
                if "DELETE 1" in result or "DELETE" in result:
                    success += 1
                else:
                    failed += 1
                    errors.append(f"Share not found for {study_id}")
            except Exception as e:
                failed += 1
                errors.append(f"Failed to unshare {study_id}: {str(e)}")
    
    return {"success": success, "failed": failed, "errors": errors if errors else None}


# =============================================================================
# Slide Management Functions (New Hierarchy Model)
# =============================================================================

async def get_slides_metadata_bulk(orthanc_ids: list[str]) -> dict:
    """Get slide metadata for multiple Orthanc study IDs at once.
    Returns dict mapping orthanc_id -> metadata"""
    print(f"[AUTH] get_slides_metadata_bulk called with {len(orthanc_ids) if orthanc_ids else 0} IDs")
    print(f"[AUTH] First few IDs: {orthanc_ids[:3] if orthanc_ids else []}")
    
    if not orthanc_ids:
        print("[AUTH] empty orthanc_ids, returning {}")
        return {}
    
    pool = await get_db_pool()
    if pool is None:
        print("[AUTH] no database pool!")
        return {}
    
    try:
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT s.orthanc_study_id, s.display_name, s.stain,
                       s.case_id, s.block_id, s.patient_id,
                       c.accession_number as case_accession,
                       b.block_id as block_name,
                       p.name as patient_name, p.mrn as patient_mrn, p.dob as patient_dob
                FROM slides s
                LEFT JOIN cases c ON s.case_id = c.id
                LEFT JOIN blocks b ON s.block_id = b.id
                LEFT JOIN patients p ON s.patient_id = p.id
                WHERE s.orthanc_study_id = ANY($1)
                """,
                orthanc_ids
            )
            
            print(f"[AUTH] query returned {len(rows)} rows")
            if rows:
                print(f"[AUTH] First row: {dict(rows[0])}")
            result = {
                row["orthanc_study_id"]: {
                    "display_name": row["display_name"],
                    "stain": row["stain"],
                    "case_id": row["case_id"],
                    "block_id": row["block_id"],
                    "patient_id": row["patient_id"],
                    "case_accession": row["case_accession"],
                    "block_name": row["block_name"],
                    "patient_name": row["patient_name"],
                    "patient_mrn": row["patient_mrn"],
                    "patient_dob": str(row["patient_dob"]) if row["patient_dob"] else None
                }
                for row in rows
            }
            logger.info(f"get_slides_metadata_bulk: returning {len(result)} entries")
            return result
    except Exception as e:
        logger.error(f"get_slides_metadata_bulk error: {e}", exc_info=True)
        return {}


async def get_slide_by_orthanc_id(orthanc_study_id: str) -> Optional[dict]:
    """Get slide record by Orthanc study ID with joined patient/case/block info"""
    pool = await get_db_pool()
    if pool is None:
        return None
    
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT s.id, s.orthanc_study_id, s.display_name, s.stain, s.original_filename,
                       s.source_format, s.scanner_manufacturer, s.width, s.height, s.magnification,
                       s.block_id, s.case_id, s.patient_id, s.owner_id, s.is_sample,
                       s.created_at, s.updated_at,
                       p.name as patient_name, p.mrn as patient_mrn, p.dob as patient_dob,
                       c.accession_number as case_accession,
                       b.block_id as block_name
                FROM slides s
                LEFT JOIN patients p ON s.patient_id = p.id
                LEFT JOIN cases c ON s.case_id = c.id
                LEFT JOIN blocks b ON s.block_id = b.id
                WHERE s.orthanc_study_id = $1
                """,
                orthanc_study_id
            )
            
            if row:
                result = dict(row)
                # Convert date to string
                if result.get('patient_dob'):
                    result['patient_dob'] = str(result['patient_dob'])
                return result
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
    mrn: Optional[str] = None,
    dob: Optional[str] = None  # YYYY-MM-DD format
) -> Optional[int]:
    """Create a new patient, returns patient ID"""
    pool = await get_db_pool()
    if pool is None:
        return None
    
    # Parse dob string to date if provided
    dob_date = None
    if dob:
        try:
            from datetime import datetime
            dob_date = datetime.strptime(dob, "%Y-%m-%d").date()
        except ValueError:
            logger.warning(f"Invalid DOB format: {dob}")
    
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO patients (owner_id, name, mrn, dob)
                VALUES ($1, $2, $3, $4)
                RETURNING id
                """,
                owner_id, name, mrn, dob_date
            )
            return row["id"] if row else None
    except Exception as e:
        logger.error(f"Failed to create patient: {e}")
        return None
