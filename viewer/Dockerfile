FROM nginx:alpine

# Copy viewer files
COPY index.html /usr/share/nginx/html/
COPY test.html /usr/share/nginx/html/
COPY color-correction.js /usr/share/nginx/html/
COPY dicomweb-tilesource.js /usr/share/nginx/html/

# Create nginx config with reverse proxy to orthanc and converter
RUN cat > /etc/nginx/conf.d/default.conf << 'EOF'
resolver 127.0.0.11 valid=30s;

server {
    listen 80;
    server_name _;
    client_max_body_size 5000M;

    location / {
        root /usr/share/nginx/html;
        index index.html;
        try_files $uri $uri/ /index.html;
    }

    # Converter API - routes to converter service for ICC profiles, uploads, jobs, etc.
    # The converter service proxies Orthanc requests internally
    location ~ ^/api/(.*)$ {
        set $converter http://dicom-converter:8000;
        proxy_pass $converter/$1$is_args$args;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_redirect off;
        proxy_read_timeout 600s;
        
        # Large file uploads (for WSI conversion)
        client_max_body_size 20G;
        proxy_request_buffering off;
    }

    # WSI tiles - match all /wsi/* paths (direct to Orthanc for performance)
    location ~ ^/wsi/(.*)$ {
        set $orthanc http://dicom-orthanc:8042;
        proxy_pass $orthanc/wsi/$1$is_args$args;
        proxy_set_header Host $host;
        proxy_set_header Authorization "Basic YWRtaW46b3J0aGFuYw==";
        proxy_redirect off;
        
        # Tile caching for performance
        add_header 'Cache-Control' 'public, max-age=86400' always;
        add_header 'Access-Control-Allow-Origin' '*' always;
    }

    # DICOMweb - match all /dicom-web/* paths
    location ~ ^/dicom-web/(.*)$ {
        set $orthanc http://dicom-orthanc:8042;
        proxy_pass $orthanc/dicom-web/$1$is_args$args;
        proxy_set_header Host $host;
        proxy_set_header Authorization "Basic YWRtaW46b3J0aGFuYw==";
        proxy_redirect off;
        
        add_header 'Access-Control-Allow-Origin' '*' always;
    }
}
EOF

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
