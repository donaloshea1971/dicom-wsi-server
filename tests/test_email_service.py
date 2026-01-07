"""
Unit tests for the email_service.py module.

Tests cover:
- Email configuration checking
- Email sending via Brevo API
- Share notification emails
"""

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# Add converter module to path
sys.path.insert(0, str(Path(__file__).parent.parent / "converter"))


# =============================================================================
# Test Configuration Functions
# =============================================================================

class TestEmailConfiguration:
    """Tests for email configuration functions."""

    def test_is_email_configured_true(self, monkeypatch):
        """Test is_email_configured returns True when API key is set."""
        monkeypatch.setenv("BREVO_API_KEY", "xkeysib-test-api-key")
        
        # Reload module to pick up new env var
        import email_service
        import importlib
        importlib.reload(email_service)
        
        assert email_service.is_email_configured() is True

    def test_is_email_configured_false(self, monkeypatch):
        """Test is_email_configured returns False when API key is empty."""
        monkeypatch.setenv("BREVO_API_KEY", "")
        
        import email_service
        import importlib
        importlib.reload(email_service)
        
        assert email_service.is_email_configured() is False

    def test_is_email_configured_missing(self, monkeypatch):
        """Test is_email_configured returns False when API key not set."""
        monkeypatch.delenv("BREVO_API_KEY", raising=False)
        
        import email_service
        import importlib
        importlib.reload(email_service)
        
        assert email_service.is_email_configured() is False


# =============================================================================
# Test Email Sending
# =============================================================================

class TestSendEmail:
    """Tests for send_email function."""

    def test_send_email_not_configured(self, monkeypatch):
        """Test send_email returns False when not configured."""
        monkeypatch.setenv("BREVO_API_KEY", "")
        
        import email_service
        import importlib
        importlib.reload(email_service)
        
        result = email_service.send_email(
            to_email="test@example.com",
            subject="Test Subject",
            html_body="<p>Test body</p>",
        )
        
        assert result is False

    def test_send_email_success(self, monkeypatch):
        """Test successful email sending."""
        monkeypatch.setenv("BREVO_API_KEY", "test-api-key")
        
        import email_service
        import importlib
        importlib.reload(email_service)
        
        # Mock httpx client
        mock_response = MagicMock()
        mock_response.status_code = 201
        
        with patch("email_service.httpx.Client") as mock_client_class:
            mock_client = MagicMock()
            mock_client.post.return_value = mock_response
            mock_client.__enter__ = MagicMock(return_value=mock_client)
            mock_client.__exit__ = MagicMock(return_value=None)
            mock_client_class.return_value = mock_client
            
            result = email_service.send_email(
                to_email="recipient@example.com",
                subject="Test Subject",
                html_body="<p>Test HTML body</p>",
                text_body="Test text body",
            )
            
            assert result is True
            mock_client.post.assert_called_once()
            
            # Verify the payload structure
            call_args = mock_client.post.call_args
            payload = call_args[1]["json"]
            
            assert payload["to"][0]["email"] == "recipient@example.com"
            assert payload["subject"] == "Test Subject"
            assert payload["htmlContent"] == "<p>Test HTML body</p>"
            assert payload["textContent"] == "Test text body"

    def test_send_email_api_error(self, monkeypatch):
        """Test email sending with API error."""
        monkeypatch.setenv("BREVO_API_KEY", "test-api-key")
        
        import email_service
        import importlib
        importlib.reload(email_service)
        
        mock_response = MagicMock()
        mock_response.status_code = 400
        mock_response.text = "Bad Request"
        
        with patch("email_service.httpx.Client") as mock_client_class:
            mock_client = MagicMock()
            mock_client.post.return_value = mock_response
            mock_client.__enter__ = MagicMock(return_value=mock_client)
            mock_client.__exit__ = MagicMock(return_value=None)
            mock_client_class.return_value = mock_client
            
            result = email_service.send_email(
                to_email="recipient@example.com",
                subject="Test",
                html_body="<p>Test</p>",
            )
            
            assert result is False

    def test_send_email_exception(self, monkeypatch):
        """Test email sending with exception."""
        monkeypatch.setenv("BREVO_API_KEY", "test-api-key")
        
        import email_service
        import importlib
        importlib.reload(email_service)
        
        with patch("email_service.httpx.Client") as mock_client_class:
            mock_client = MagicMock()
            mock_client.post.side_effect = Exception("Network error")
            mock_client.__enter__ = MagicMock(return_value=mock_client)
            mock_client.__exit__ = MagicMock(return_value=None)
            mock_client_class.return_value = mock_client
            
            result = email_service.send_email(
                to_email="recipient@example.com",
                subject="Test",
                html_body="<p>Test</p>",
            )
            
            assert result is False


# =============================================================================
# Test Share Notification
# =============================================================================

class TestSendShareNotification:
    """Tests for send_share_notification function."""

    def test_send_share_notification_success(self, monkeypatch, sample_share_notification_data):
        """Test successful share notification."""
        monkeypatch.setenv("BREVO_API_KEY", "test-api-key")
        
        import email_service
        import importlib
        importlib.reload(email_service)
        
        mock_response = MagicMock()
        mock_response.status_code = 200
        
        with patch("email_service.httpx.Client") as mock_client_class:
            mock_client = MagicMock()
            mock_client.post.return_value = mock_response
            mock_client.__enter__ = MagicMock(return_value=mock_client)
            mock_client.__exit__ = MagicMock(return_value=None)
            mock_client_class.return_value = mock_client
            
            result = email_service.send_share_notification(
                **sample_share_notification_data
            )
            
            assert result is True
            
            # Verify email contains share information
            call_args = mock_client.post.call_args
            payload = call_args[1]["json"]
            
            assert sample_share_notification_data["recipient_email"] == payload["to"][0]["email"]
            assert sample_share_notification_data["sharer_name"] in payload["subject"]

    def test_send_share_notification_with_minimal_data(self, monkeypatch):
        """Test share notification with minimal slide details."""
        monkeypatch.setenv("BREVO_API_KEY", "test-api-key")
        
        import email_service
        import importlib
        importlib.reload(email_service)
        
        mock_response = MagicMock()
        mock_response.status_code = 200
        
        with patch("email_service.httpx.Client") as mock_client_class:
            mock_client = MagicMock()
            mock_client.post.return_value = mock_response
            mock_client.__enter__ = MagicMock(return_value=mock_client)
            mock_client.__exit__ = MagicMock(return_value=None)
            mock_client_class.return_value = mock_client
            
            # Minimal data - most fields are None
            result = email_service.send_share_notification(
                recipient_email="test@example.com",
                recipient_name=None,
                sharer_name="Sharer",
                sharer_email="sharer@example.com",
                slide_name=None,
                stain=None,
                patient_name=None,
                case_accession=None,
                patient_dob=None,
                slide_id="study-123",
            )
            
            assert result is True

    def test_send_share_notification_uses_email_as_name(self, monkeypatch):
        """Test share notification uses email when name not provided."""
        monkeypatch.setenv("BREVO_API_KEY", "test-api-key")
        
        import email_service
        import importlib
        importlib.reload(email_service)
        
        mock_response = MagicMock()
        mock_response.status_code = 200
        
        with patch("email_service.httpx.Client") as mock_client_class:
            mock_client = MagicMock()
            mock_client.post.return_value = mock_response
            mock_client.__enter__ = MagicMock(return_value=mock_client)
            mock_client.__exit__ = MagicMock(return_value=None)
            mock_client_class.return_value = mock_client
            
            result = email_service.send_share_notification(
                recipient_email="test@example.com",
                recipient_name=None,  # No name
                sharer_name="Sharer",
                sharer_email="sharer@example.com",
                slide_name="Test Slide",
                stain="H&E",
                patient_name=None,
                case_accession=None,
                patient_dob=None,
                slide_id="study-123",
            )
            
            assert result is True
            
            # Verify HTML contains the email address as recipient display
            call_args = mock_client.post.call_args
            payload = call_args[1]["json"]
            assert "test@example.com" in payload["htmlContent"]

    def test_send_share_notification_includes_view_link(self, monkeypatch):
        """Test share notification includes correct view link."""
        monkeypatch.setenv("BREVO_API_KEY", "test-api-key")
        monkeypatch.setenv("APP_URL", "https://pathview.example.com")
        
        import email_service
        import importlib
        importlib.reload(email_service)
        
        mock_response = MagicMock()
        mock_response.status_code = 200
        
        with patch("email_service.httpx.Client") as mock_client_class:
            mock_client = MagicMock()
            mock_client.post.return_value = mock_response
            mock_client.__enter__ = MagicMock(return_value=mock_client)
            mock_client.__exit__ = MagicMock(return_value=None)
            mock_client_class.return_value = mock_client
            
            result = email_service.send_share_notification(
                recipient_email="test@example.com",
                recipient_name="Test User",
                sharer_name="Sharer",
                sharer_email="sharer@example.com",
                slide_name="Test Slide",
                stain="H&E",
                patient_name="Patient Name",
                case_accession="ACC-001",
                patient_dob="1980-01-01",
                slide_id="study-abc-123",
            )
            
            assert result is True
            
            # Verify the view link contains the study ID
            call_args = mock_client.post.call_args
            payload = call_args[1]["json"]
            
            assert "study-abc-123" in payload["htmlContent"]
            assert "viewer?study=study-abc-123" in payload["htmlContent"]


# =============================================================================
# Test Email Content Structure
# =============================================================================

class TestEmailContent:
    """Tests for email content structure."""

    def test_share_notification_html_structure(self, monkeypatch):
        """Test share notification HTML has proper structure."""
        monkeypatch.setenv("BREVO_API_KEY", "test-api-key")
        
        import email_service
        import importlib
        importlib.reload(email_service)
        
        mock_response = MagicMock()
        mock_response.status_code = 200
        
        with patch("email_service.httpx.Client") as mock_client_class:
            mock_client = MagicMock()
            mock_client.post.return_value = mock_response
            mock_client.__enter__ = MagicMock(return_value=mock_client)
            mock_client.__exit__ = MagicMock(return_value=None)
            mock_client_class.return_value = mock_client
            
            email_service.send_share_notification(
                recipient_email="test@example.com",
                recipient_name="Test User",
                sharer_name="Sharer",
                sharer_email="sharer@example.com",
                slide_name="Test Slide",
                stain="H&E",
                patient_name="Patient",
                case_accession="ACC-001",
                patient_dob="1980-01-01",
                slide_id="study-123",
            )
            
            call_args = mock_client.post.call_args
            payload = call_args[1]["json"]
            html = payload["htmlContent"]
            
            # Verify HTML structure
            assert "<!DOCTYPE html>" in html
            assert "<html>" in html
            assert "<head>" in html
            assert "<body>" in html
            assert "</html>" in html
            
            # Verify content elements
            assert "Slide Shared With You" in html
            assert "Sharer" in html
            assert "Test Slide" in html
            assert "H&E" in html

    def test_share_notification_text_fallback(self, monkeypatch):
        """Test share notification includes text fallback."""
        monkeypatch.setenv("BREVO_API_KEY", "test-api-key")
        
        import email_service
        import importlib
        importlib.reload(email_service)
        
        mock_response = MagicMock()
        mock_response.status_code = 200
        
        with patch("email_service.httpx.Client") as mock_client_class:
            mock_client = MagicMock()
            mock_client.post.return_value = mock_response
            mock_client.__enter__ = MagicMock(return_value=mock_client)
            mock_client.__exit__ = MagicMock(return_value=None)
            mock_client_class.return_value = mock_client
            
            email_service.send_share_notification(
                recipient_email="test@example.com",
                recipient_name="Test User",
                sharer_name="Sharer",
                sharer_email="sharer@example.com",
                slide_name="Test Slide",
                stain="H&E",
                patient_name=None,
                case_accession=None,
                patient_dob=None,
                slide_id="study-123",
            )
            
            call_args = mock_client.post.call_args
            payload = call_args[1]["json"]
            
            # Should include text content as fallback
            assert "textContent" in payload
            assert "Slide Shared With You" in payload["textContent"]
            assert "Test Slide" in payload["textContent"]
