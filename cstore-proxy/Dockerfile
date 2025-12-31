FROM python:3.11-slim

WORKDIR /app

# Install dependencies
RUN pip install --no-cache-dir \
    pynetdicom==2.0.2 \
    pydicom==2.4.3 \
    requests==2.31.0

# Copy application
COPY cstore_proxy.py .

# Expose DICOM port
EXPOSE 4243

# Run the proxy
CMD ["python", "-u", "cstore_proxy.py"]
