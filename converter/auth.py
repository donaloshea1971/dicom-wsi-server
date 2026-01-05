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

async def set_study_owner(study_id: str, user_id: int) -> bool:
    """Set the owner of a study"""
    pool = await get_db_pool()
    if pool is None:
        return False
    
    async with pool.acquire() as conn:
        try:
            await conn.execute(
                """
                INSERT INTO study_owners (study_id, user_id)
                VALUES ($1, $2)
                ON CONFLICT (study_id) DO NOTHING
                """,
                study_id,
                user_id
            )
            return True
        except Exception as e:
            logger.error(f"Failed to set study owner: {e}")
            return False


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
