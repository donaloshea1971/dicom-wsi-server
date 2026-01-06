"""
Email notification service for PathView Pro
"""
import os
import smtplib
import logging
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from typing import Optional

logger = logging.getLogger(__name__)

# Email configuration from environment
SMTP_HOST = os.getenv("SMTP_HOST", "")
SMTP_PORT = int(os.getenv("SMTP_PORT", "587"))
SMTP_USER = os.getenv("SMTP_USER", "")
SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "")
SMTP_FROM = os.getenv("SMTP_FROM", "noreply@pathviewpro.com")
APP_URL = os.getenv("APP_URL", "https://pathviewpro.com")


def is_email_configured() -> bool:
    """Check if email is properly configured"""
    return bool(SMTP_HOST and SMTP_USER and SMTP_PASSWORD)


def send_email(to_email: str, subject: str, html_body: str, text_body: Optional[str] = None) -> bool:
    """Send an email"""
    if not is_email_configured():
        logger.warning("Email not configured - skipping send")
        return False
    
    try:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = SMTP_FROM
        msg["To"] = to_email
        
        # Plain text fallback
        if text_body:
            msg.attach(MIMEText(text_body, "plain"))
        
        # HTML body
        msg.attach(MIMEText(html_body, "html"))
        
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as server:
            server.starttls()
            server.login(SMTP_USER, SMTP_PASSWORD)
            server.sendmail(SMTP_FROM, to_email, msg.as_string())
        
        logger.info(f"Email sent to {to_email}: {subject}")
        return True
        
    except Exception as e:
        logger.error(f"Failed to send email to {to_email}: {e}")
        return False


def send_share_notification(
    recipient_email: str,
    recipient_name: Optional[str],
    sharer_name: str,
    sharer_email: str,
    slide_name: str,
    stain: Optional[str],
    patient_name: Optional[str],
    case_accession: Optional[str],
    patient_dob: Optional[str],
    slide_id: str
) -> bool:
    """Send notification when a slide is shared"""
    
    recipient_display = recipient_name or recipient_email
    
    # Build slide details
    details_parts = []
    if slide_name:
        details_parts.append(f"<strong>Slide:</strong> {slide_name}")
    if stain:
        details_parts.append(f"<strong>Stain:</strong> {stain}")
    if case_accession:
        details_parts.append(f"<strong>Case ID:</strong> {case_accession}")
    if patient_name:
        details_parts.append(f"<strong>Patient:</strong> {patient_name}")
    if patient_dob:
        details_parts.append(f"<strong>DOB:</strong> {patient_dob}")
    
    details_html = "<br>".join(details_parts) if details_parts else "No additional details"
    
    subject = f"🔬 {sharer_name} shared a slide with you on PathView Pro"
    
    html_body = f"""
    <!DOCTYPE html>
    <html>
    <head>
        <style>
            body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0a0a0f; color: #f8fafc; }}
            .container {{ max-width: 600px; margin: 0 auto; padding: 40px 20px; }}
            .card {{ background: #12121a; border-radius: 12px; padding: 32px; border: 1px solid rgba(148,163,184,0.1); }}
            .header {{ color: #10b981; font-size: 24px; margin-bottom: 20px; }}
            .details {{ background: #1a1a25; padding: 20px; border-radius: 8px; margin: 20px 0; line-height: 1.8; }}
            .btn {{ display: inline-block; background: #10b981; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; margin-top: 20px; }}
            .footer {{ color: #64748b; font-size: 12px; margin-top: 30px; }}
        </style>
    </head>
    <body>
        <div class="container">
            <div class="card">
                <div class="header">🔬 Slide Shared With You</div>
                <p>Hi {recipient_display},</p>
                <p><strong>{sharer_name}</strong> ({sharer_email}) has shared a slide with you on PathView Pro.</p>
                
                <div class="details">
                    {details_html}
                </div>
                
                <a href="{APP_URL}/viewer?study={slide_id}" class="btn">View Slide</a>
                
                <div class="footer">
                    <p>This email was sent from PathView Pro. If you didn't expect this, you can ignore it.</p>
                </div>
            </div>
        </div>
    </body>
    </html>
    """
    
    text_body = f"""
    Slide Shared With You
    
    Hi {recipient_display},
    
    {sharer_name} ({sharer_email}) has shared a slide with you on PathView Pro.
    
    Slide Details:
    - Slide: {slide_name or 'N/A'}
    - Stain: {stain or 'N/A'}
    - Case ID: {case_accession or 'N/A'}
    - Patient: {patient_name or 'N/A'}
    - DOB: {patient_dob or 'N/A'}
    
    View the slide: {APP_URL}/viewer?study={slide_id}
    """
    
    return send_email(recipient_email, subject, html_body, text_body)
