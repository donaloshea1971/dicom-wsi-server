FROM jodogne/orthanc-plugins:latest

# Copy configuration
COPY config/orthanc.json /etc/orthanc/orthanc.json

# Expose ports
EXPOSE 8042 4242

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s \
  CMD curl -f http://localhost:8042/system || exit 1

