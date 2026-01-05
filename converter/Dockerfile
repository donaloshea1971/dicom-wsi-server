# DICOM WSI Conversion Service
# Converts proprietary WSI formats (iSyntax, NDPI, SVS) to DICOM

FROM python:3.11-slim

# Install system dependencies for OpenSlide and image processing
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libopenslide0 \
    libopenslide-dev \
    libopenjp2-7 \
    libopenjp2-7-dev \
    libtiff-dev \
    libvips-dev \
    libturbojpeg0 \
    libturbojpeg0-dev \
    libjpeg-dev \
    libwebp-dev \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy requirements first for layer caching
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Create upload directories
RUN mkdir -p /uploads/incoming /uploads/processing /uploads/completed /uploads/failed

# Expose FastAPI port
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

# Run with uvicorn - single worker for consistent in-memory state (chunked uploads)
# Background conversion tasks handle the heavy lifting anyway
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--timeout-keep-alive", "300"]

