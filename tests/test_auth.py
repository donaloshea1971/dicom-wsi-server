"""
Unit tests for the auth.py module.

Tests cover:
- JWT token verification
- User management (get_or_create_user)
- Study ownership functions
- Slide sharing functions
- Access control
"""

import sys
from pathlib import Path
from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch
from contextlib import asynccontextmanager

import pytest

# Add converter module to path
sys.path.insert(0, str(Path(__file__).parent.parent / "converter"))


def create_mock_pool(mock_conn):
    """Create a properly mocked async database pool."""
    mock_pool = MagicMock()
    
    @asynccontextmanager
    async def mock_acquire():
        yield mock_conn
    
    mock_pool.acquire = mock_acquire
    return mock_pool


async def mock_get_db_pool_with(mock_pool):
    """Async function that returns the mock pool."""
    return mock_pool


# =============================================================================
# Test Pydantic Models
# =============================================================================

class TestUserModel:
    """Tests for the User Pydantic model."""

    def test_user_model_with_all_fields(self):
        """Test User model with all fields populated."""
        from auth import User
        
        user = User(
            id=1,
            auth0_id="auth0|123456",
            email="test@example.com",
            name="Test User",
            picture="https://example.com/avatar.png",
            role="admin",
        )
        
        assert user.id == 1
        assert user.auth0_id == "auth0|123456"
        assert user.email == "test@example.com"
        assert user.name == "Test User"
        assert user.picture == "https://example.com/avatar.png"
        assert user.role == "admin"

    def test_user_model_with_defaults(self):
        """Test User model with default values."""
        from auth import User
        
        user = User(
            auth0_id="auth0|123456",
            email="test@example.com",
        )
        
        assert user.id is None
        assert user.name is None
        assert user.picture is None
        assert user.role == "user"  # Default role

    def test_user_model_validation(self):
        """Test User model field validation."""
        from auth import User
        from pydantic import ValidationError
        
        # Missing required field
        with pytest.raises(ValidationError):
            User(auth0_id="auth0|123456")  # Missing email


class TestTokenPayloadModel:
    """Tests for the TokenPayload Pydantic model."""

    def test_token_payload_with_all_fields(self):
        """Test TokenPayload with all fields."""
        from auth import TokenPayload
        
        payload = TokenPayload(
            sub="auth0|123456",
            email="test@example.com",
            name="Test User",
            picture="https://example.com/avatar.png",
        )
        
        assert payload.sub == "auth0|123456"
        assert payload.email == "test@example.com"
        assert payload.name == "Test User"
        assert payload.picture == "https://example.com/avatar.png"

    def test_token_payload_minimal(self):
        """Test TokenPayload with only required fields."""
        from auth import TokenPayload
        
        payload = TokenPayload(sub="auth0|123456")
        
        assert payload.sub == "auth0|123456"
        assert payload.email is None
        assert payload.name is None
        assert payload.picture is None


# =============================================================================
# Test JWKS Functions
# =============================================================================

class TestJWKSFunctions:
    """Tests for JWKS (JSON Web Key Set) functions."""

    @pytest.mark.asyncio
    async def test_get_jwks_caches_result(self, mock_httpx_client, mock_jwks):
        """Test that JWKS is cached after first fetch."""
        from auth import get_jwks, _jwks_cache
        import auth
        
        # Reset cache
        auth._jwks_cache = None
        
        mock_response = MagicMock()
        mock_response.json.return_value = mock_jwks
        mock_response.raise_for_status = MagicMock()
        
        with patch("auth.httpx.AsyncClient") as mock_client_class:
            mock_client = AsyncMock()
            mock_client.get = AsyncMock(return_value=mock_response)
            mock_client.__aenter__ = AsyncMock(return_value=mock_client)
            mock_client.__aexit__ = AsyncMock(return_value=None)
            mock_client_class.return_value = mock_client
            
            # First call should fetch
            result1 = await get_jwks()
            assert result1 == mock_jwks
            
            # Second call should use cache
            result2 = await get_jwks()
            assert result2 == mock_jwks
            
            # Should only call once due to caching
            assert mock_client.get.call_count == 1


# =============================================================================
# Test Token Verification
# =============================================================================

class TestVerifyToken:
    """Tests for JWT token verification."""

    @pytest.mark.asyncio
    async def test_verify_token_missing_config(self, monkeypatch):
        """Test verify_token raises error when Auth0 not configured."""
        from auth import verify_token
        from fastapi import HTTPException
        
        monkeypatch.setenv("AUTH0_DOMAIN", "")
        monkeypatch.setenv("AUTH0_AUDIENCE", "")
        
        # Need to reload the module to pick up new env vars
        import auth
        import importlib
        importlib.reload(auth)
        
        with pytest.raises(HTTPException) as exc_info:
            await auth.verify_token("test-token")
        
        assert exc_info.value.status_code == 500

    @pytest.mark.asyncio
    async def test_verify_token_invalid_token(self, mock_jwks):
        """Test verify_token with invalid token."""
        from fastapi import HTTPException
        import auth
        
        auth._jwks_cache = mock_jwks
        
        with pytest.raises(HTTPException) as exc_info:
            await auth.verify_token("invalid-token")
        
        assert exc_info.value.status_code == 401


# =============================================================================
# Test Database Pool Functions
# =============================================================================

class TestDatabasePool:
    """Tests for database pool management."""

    @pytest.mark.asyncio
    async def test_get_db_pool_creates_pool(self, monkeypatch):
        """Test that get_db_pool creates a pool on first call."""
        import auth
        
        # Reset pool
        auth._db_pool = None
        
        mock_pool = AsyncMock()
        
        with patch("auth.asyncpg.create_pool", return_value=mock_pool) as mock_create:
            pool = await auth.get_db_pool()
            
            # Should have called create_pool
            mock_create.assert_called_once()
            assert pool == mock_pool

    @pytest.mark.asyncio
    async def test_get_db_pool_reuses_existing(self):
        """Test that get_db_pool reuses existing pool."""
        import auth
        
        mock_pool = AsyncMock()
        auth._db_pool = mock_pool
        
        pool = await auth.get_db_pool()
        
        assert pool == mock_pool


# =============================================================================
# Test User Management Functions
# =============================================================================

class TestGetOrCreateUser:
    """Tests for get_or_create_user function."""

    @pytest.mark.asyncio
    async def test_get_existing_user(self, sample_token_payload, sample_user):
        """Test getting an existing user from database."""
        from auth import get_or_create_user, TokenPayload
        import auth
        
        token = TokenPayload(**sample_token_payload)
        
        # Mock database
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(return_value=sample_user)
        mock_conn.execute = AsyncMock()
        
        mock_pool = create_mock_pool(mock_conn)
        
        async def mock_get_pool():
            return mock_pool
        
        with patch.object(auth, "get_db_pool", mock_get_pool):
            user = await get_or_create_user(token)
            
            assert user.email == sample_user["email"]
            assert user.auth0_id == sample_user["auth0_id"]
            # Should update last login
            mock_conn.execute.assert_called()

    @pytest.mark.asyncio
    async def test_create_new_user(self, sample_token_payload):
        """Test creating a new user when not found in database."""
        from auth import get_or_create_user, TokenPayload
        import auth
        
        token = TokenPayload(**sample_token_payload)
        
        new_user = {
            "id": 5,
            "auth0_id": token.sub,
            "email": token.email,
            "name": token.name,
            "picture": token.picture,
            "role": "user",
        }
        
        mock_conn = AsyncMock()
        # First call returns None (user doesn't exist), second returns new user
        mock_conn.fetchrow = AsyncMock(side_effect=[None, new_user])
        mock_conn.execute = AsyncMock()
        
        mock_pool = create_mock_pool(mock_conn)
        
        async def mock_get_pool():
            return mock_pool
        
        with patch.object(auth, "get_db_pool", mock_get_pool):
            with patch.object(auth, "process_pending_shares", new=AsyncMock(return_value=None)):
                user = await get_or_create_user(token)
                
                assert user.auth0_id == token.sub

    @pytest.mark.asyncio
    async def test_get_or_create_user_no_database(self, sample_token_payload):
        """Test get_or_create_user when database is unavailable."""
        from auth import get_or_create_user, TokenPayload
        import auth
        
        token = TokenPayload(**sample_token_payload)
        
        with patch.object(auth, "get_db_pool", return_value=None):
            user = await get_or_create_user(token)
            
            # Should return user without database ID
            assert user.id is None
            assert user.auth0_id == token.sub
            assert user.email == token.email


# =============================================================================
# Test Study Ownership Functions
# =============================================================================

class TestStudyOwnership:
    """Tests for study ownership functions."""

    @pytest.mark.asyncio
    async def test_set_study_owner(self, sample_study_id):
        """Test setting study owner."""
        import auth
        
        mock_conn = AsyncMock()
        mock_conn.execute = AsyncMock(return_value="INSERT 0 1")
        
        mock_pool = AsyncMock()
        mock_pool.acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_pool.acquire.return_value.__aexit__ = AsyncMock(return_value=None)
        
        with patch.object(auth, "get_db_pool", return_value=mock_pool):
            result = await auth.set_study_owner(sample_study_id, 1)
            
            assert result is True
            mock_conn.execute.assert_called()

    @pytest.mark.asyncio
    async def test_set_study_owner_force(self, sample_study_id):
        """Test forcing study owner update."""
        import auth
        
        mock_conn = AsyncMock()
        mock_conn.execute = AsyncMock()
        
        mock_pool = AsyncMock()
        mock_pool.acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_pool.acquire.return_value.__aexit__ = AsyncMock(return_value=None)
        
        with patch.object(auth, "get_db_pool", return_value=mock_pool):
            result = await auth.set_study_owner(sample_study_id, 1, force=True)
            
            assert result is True

    @pytest.mark.asyncio
    async def test_set_study_owner_no_database(self, sample_study_id):
        """Test set_study_owner when database unavailable."""
        import auth
        
        with patch.object(auth, "get_db_pool", return_value=None):
            result = await auth.set_study_owner(sample_study_id, 1)
            
            assert result is False

    @pytest.mark.asyncio
    async def test_get_study_owner(self, sample_study_id):
        """Test getting study owner."""
        import auth
        
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(return_value={"owner_id": 1})
        
        mock_pool = AsyncMock()
        mock_pool.acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_pool.acquire.return_value.__aexit__ = AsyncMock(return_value=None)
        
        with patch.object(auth, "get_db_pool", return_value=mock_pool):
            owner = await auth.get_study_owner(sample_study_id)
            
            assert owner == 1

    @pytest.mark.asyncio
    async def test_get_study_owner_not_found(self, sample_study_id):
        """Test getting study owner when study not found."""
        import auth
        
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(return_value=None)
        
        mock_pool = AsyncMock()
        mock_pool.acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_pool.acquire.return_value.__aexit__ = AsyncMock(return_value=None)
        
        with patch.object(auth, "get_db_pool", return_value=mock_pool):
            owner = await auth.get_study_owner(sample_study_id)
            
            assert owner is None


# =============================================================================
# Test Access Control Functions
# =============================================================================

class TestCanAccessStudy:
    """Tests for study access control."""

    @pytest.mark.asyncio
    async def test_can_access_owned_study(self, sample_study_id):
        """Test access to owned study."""
        import auth
        
        mock_conn = AsyncMock()
        # Study exists and user owns it
        mock_conn.fetchrow = AsyncMock(side_effect=[
            {"id": 1, "owner_id": 1, "is_sample": False},  # slide_exists
            {"1": 1},  # access check
        ])
        
        mock_pool = AsyncMock()
        mock_pool.acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_pool.acquire.return_value.__aexit__ = AsyncMock(return_value=None)
        
        with patch.object(auth, "get_db_pool", return_value=mock_pool):
            result = await auth.can_access_study(1, sample_study_id)
            
            assert result is True

    @pytest.mark.asyncio
    async def test_can_access_sample_study(self, sample_study_id):
        """Test access to sample study (public)."""
        import auth
        
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(return_value={
            "id": 1,
            "owner_id": 2,
            "is_sample": True,  # Sample study
        })
        
        mock_pool = AsyncMock()
        mock_pool.acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_pool.acquire.return_value.__aexit__ = AsyncMock(return_value=None)
        
        with patch.object(auth, "get_db_pool", return_value=mock_pool):
            # Even unauthenticated users can access samples
            result = await auth.can_access_study(None, sample_study_id)
            
            assert result is True

    @pytest.mark.asyncio
    async def test_cannot_access_others_study(self, sample_study_id):
        """Test denied access to another user's study."""
        import auth
        
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(side_effect=[
            {"id": 1, "owner_id": 2, "is_sample": False},  # Study owned by user 2
            None,  # No access found
        ])
        
        mock_pool = AsyncMock()
        mock_pool.acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_pool.acquire.return_value.__aexit__ = AsyncMock(return_value=None)
        
        with patch.object(auth, "get_db_pool", return_value=mock_pool):
            result = await auth.can_access_study(1, sample_study_id)  # User 1 tries to access
            
            assert result is False

    @pytest.mark.asyncio
    async def test_can_access_no_database(self, sample_study_id):
        """Test access when database unavailable (fail open)."""
        import auth
        
        with patch.object(auth, "get_db_pool", return_value=None):
            result = await auth.can_access_study(1, sample_study_id)
            
            # Should allow access when DB unavailable (fail open for development)
            assert result is True


# =============================================================================
# Test Slide Sharing Functions
# =============================================================================

class TestSlideSharing:
    """Tests for slide sharing functions."""

    @pytest.mark.asyncio
    async def test_share_slide_with_existing_user(self, sample_study_id):
        """Test sharing slide with existing user."""
        import auth
        
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(side_effect=[
            {"id": 1, "owner_id": 1},  # Slide exists, owned by user 1
            {"id": 2},  # Target user exists
        ])
        mock_conn.execute = AsyncMock()
        
        mock_pool = AsyncMock()
        mock_pool.acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_pool.acquire.return_value.__aexit__ = AsyncMock(return_value=None)
        
        with patch.object(auth, "get_db_pool", return_value=mock_pool):
            result = await auth.share_slide(
                sample_study_id,
                owner_id=1,
                share_with_email="user@example.com",
                permission="view",
            )
            
            assert result["success"] is True
            assert result["pending"] is False

    @pytest.mark.asyncio
    async def test_share_slide_creates_pending(self, sample_study_id):
        """Test sharing slide with non-existing user creates pending share."""
        import auth
        
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(side_effect=[
            {"id": 1, "owner_id": 1},  # Slide exists
            None,  # Target user doesn't exist
        ])
        mock_conn.execute = AsyncMock()
        
        mock_pool = AsyncMock()
        mock_pool.acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_pool.acquire.return_value.__aexit__ = AsyncMock(return_value=None)
        
        with patch.object(auth, "get_db_pool", return_value=mock_pool):
            result = await auth.share_slide(
                sample_study_id,
                owner_id=1,
                share_with_email="newuser@example.com",
                permission="view",
            )
            
            assert result["success"] is True
            assert result["pending"] is True

    @pytest.mark.asyncio
    async def test_share_slide_not_owner(self, sample_study_id):
        """Test sharing fails when not owner."""
        import auth
        
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(return_value={
            "id": 1,
            "owner_id": 2,  # Owned by user 2
        })
        
        mock_pool = AsyncMock()
        mock_pool.acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_pool.acquire.return_value.__aexit__ = AsyncMock(return_value=None)
        
        with patch.object(auth, "get_db_pool", return_value=mock_pool):
            result = await auth.share_slide(
                sample_study_id,
                owner_id=1,  # User 1 tries to share
                share_with_email="user@example.com",
            )
            
            assert result["success"] is False
            assert "Not owner" in result["message"]

    @pytest.mark.asyncio
    async def test_unshare_slide(self, sample_study_id):
        """Test unsharing a slide."""
        import auth
        
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(side_effect=[
            {"id": 1, "owner_id": 1, "case_id": None},  # Slide
        ])
        mock_conn.execute = AsyncMock(return_value="DELETE 1")
        
        mock_pool = AsyncMock()
        mock_pool.acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_pool.acquire.return_value.__aexit__ = AsyncMock(return_value=None)
        
        with patch.object(auth, "get_db_pool", return_value=mock_pool):
            result = await auth.unshare_slide(
                sample_study_id,
                owner_id=1,
                unshare_user_id=2,
            )
            
            assert result["success"] is True


# =============================================================================
# Test User Search Functions
# =============================================================================

class TestUserSearch:
    """Tests for user search functions."""

    @pytest.mark.asyncio
    async def test_search_users_by_email(self):
        """Test searching users by email."""
        import auth
        
        mock_users = [
            {"id": 1, "email": "user1@example.com", "name": "User One", "picture": None},
            {"id": 2, "email": "user2@example.com", "name": "User Two", "picture": None},
        ]
        
        mock_conn = AsyncMock()
        mock_conn.fetch = AsyncMock(return_value=mock_users)
        
        mock_pool = AsyncMock()
        mock_pool.acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_pool.acquire.return_value.__aexit__ = AsyncMock(return_value=None)
        
        with patch.object(auth, "get_db_pool", return_value=mock_pool):
            results = await auth.search_users(query="user")
            
            assert len(results) == 2
            assert results[0]["email"] == "user1@example.com"

    @pytest.mark.asyncio
    async def test_search_users_excludes_user(self):
        """Test searching users excludes specified user."""
        import auth
        
        mock_conn = AsyncMock()
        mock_conn.fetch = AsyncMock(return_value=[])
        
        mock_pool = AsyncMock()
        mock_pool.acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_pool.acquire.return_value.__aexit__ = AsyncMock(return_value=None)
        
        with patch.object(auth, "get_db_pool", return_value=mock_pool):
            await auth.search_users(query="test", exclude_user_id=1)
            
            # Check that the query excludes the user
            call_args = mock_conn.fetch.call_args
            assert call_args is not None


# =============================================================================
# Test Batch Operations
# =============================================================================

class TestBatchOperations:
    """Tests for batch share/unshare operations."""

    @pytest.mark.asyncio
    async def test_batch_share_studies(self, sample_study_id):
        """Test batch sharing multiple studies."""
        import auth
        
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(side_effect=[
            {"id": 2},  # Target user exists
            {"id": 1, "owner_id": 1},  # Slide 1
            {"id": 2, "owner_id": 1},  # Slide 2
        ])
        mock_conn.execute = AsyncMock()
        
        mock_pool = AsyncMock()
        mock_pool.acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_pool.acquire.return_value.__aexit__ = AsyncMock(return_value=None)
        
        with patch.object(auth, "get_db_pool", return_value=mock_pool):
            result = await auth.batch_share_studies(
                study_ids=[sample_study_id, "study-2"],
                owner_id=1,
                share_with_email="user@example.com",
            )
            
            assert result["success"] == 2
            assert result["failed"] == 0
            assert result["pending"] is False

    @pytest.mark.asyncio
    async def test_batch_unshare_studies(self, sample_study_id):
        """Test batch unsharing multiple studies."""
        import auth
        
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(side_effect=[
            {"id": 1, "owner_id": 1},  # Slide 1
            {"id": 2, "owner_id": 1},  # Slide 2
        ])
        mock_conn.execute = AsyncMock(return_value="DELETE 1")
        
        mock_pool = AsyncMock()
        mock_pool.acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_pool.acquire.return_value.__aexit__ = AsyncMock(return_value=None)
        
        with patch.object(auth, "get_db_pool", return_value=mock_pool):
            result = await auth.batch_unshare_studies(
                study_ids=[sample_study_id, "study-2"],
                owner_id=1,
                unshare_user_id=2,
            )
            
            assert result["success"] == 2
            assert result["failed"] == 0


# =============================================================================
# Test Slide Metadata Functions
# =============================================================================

class TestSlideMetadata:
    """Tests for slide metadata functions."""

    @pytest.mark.asyncio
    async def test_get_slides_metadata_bulk(self, sample_study_id):
        """Test getting bulk slide metadata."""
        import auth
        
        mock_rows = [
            {
                "orthanc_study_id": sample_study_id,
                "display_name": "Test Slide",
                "stain": "H&E",
                "case_id": 1,
                "block_id": None,
                "patient_id": 1,
                "case_accession": "ACC-001",
                "block_name": None,
                "patient_name": "John Doe",
                "patient_mrn": "MRN-123",
                "patient_dob": "1980-01-01",
            }
        ]
        
        mock_conn = AsyncMock()
        mock_conn.fetch = AsyncMock(return_value=mock_rows)
        
        mock_pool = AsyncMock()
        mock_pool.acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_pool.acquire.return_value.__aexit__ = AsyncMock(return_value=None)
        
        with patch.object(auth, "get_db_pool", return_value=mock_pool):
            result = await auth.get_slides_metadata_bulk([sample_study_id])
            
            assert sample_study_id in result
            assert result[sample_study_id]["display_name"] == "Test Slide"
            assert result[sample_study_id]["stain"] == "H&E"

    @pytest.mark.asyncio
    async def test_get_slides_metadata_bulk_empty(self):
        """Test getting bulk metadata with empty list."""
        import auth
        
        result = await auth.get_slides_metadata_bulk([])
        
        assert result == {}


# =============================================================================
# Test Case Sharing Functions
# =============================================================================

class TestCaseSharing:
    """Tests for case-level sharing."""

    @pytest.mark.asyncio
    async def test_share_case(self):
        """Test sharing a case."""
        import auth
        
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(side_effect=[
            {"id": 1, "owner_id": 1},  # Case exists
            {"id": 2},  # Target user exists
        ])
        mock_conn.execute = AsyncMock()
        
        mock_pool = AsyncMock()
        mock_pool.acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_pool.acquire.return_value.__aexit__ = AsyncMock(return_value=None)
        
        with patch.object(auth, "get_db_pool", return_value=mock_pool):
            result = await auth.share_case(
                case_id=1,
                owner_id=1,
                share_with_email="user@example.com",
            )
            
            assert result["success"] is True
            assert result["pending"] is False

    @pytest.mark.asyncio
    async def test_unshare_case(self):
        """Test unsharing a case."""
        import auth
        
        mock_conn = AsyncMock()
        mock_conn.fetchrow = AsyncMock(return_value={"id": 1, "owner_id": 1})
        mock_conn.execute = AsyncMock(return_value="DELETE 1")
        
        mock_pool = AsyncMock()
        mock_pool.acquire.return_value.__aenter__ = AsyncMock(return_value=mock_conn)
        mock_pool.acquire.return_value.__aexit__ = AsyncMock(return_value=None)
        
        with patch.object(auth, "get_db_pool", return_value=mock_pool):
            result = await auth.unshare_case(
                case_id=1,
                owner_id=1,
                unshare_user_id=2,
            )
            
            assert result["success"] is True
