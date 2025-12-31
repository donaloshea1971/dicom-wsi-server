FROM nginx:alpine

# Copy viewer files
COPY index.html /usr/share/nginx/html/
COPY test.html /usr/share/nginx/html/
COPY color-correction.js /usr/share/nginx/html/
COPY dicomweb-tilesource.js /usr/share/nginx/html/

# Create nginx config with reverse proxy to orthanc
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

    # Orthanc API - match all /api/* paths
    location ~ ^/api/(.*)$ {
        set $orthanc http://dicom-orthanc:8042;
        proxy_pass $orthanc/$1$is_args$args;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Authorization "Basic YWRtaW46b3J0aGFuYw==";
        proxy_redirect off;
        proxy_read_timeout 600s;
    }

    # WSI tiles - match all /wsi/* paths
    location ~ ^/wsi/(.*)$ {
        set $orthanc http://dicom-orthanc:8042;
        proxy_pass $orthanc/wsi/$1$is_args$args;
        proxy_set_header Host $host;
        proxy_set_header Authorization "Basic YWRtaW46b3J0aGFuYw==";
        proxy_redirect off;
    }

    # DICOMweb - match all /dicom-web/* paths
    location ~ ^/dicom-web/(.*)$ {
        set $orthanc http://dicom-orthanc:8042;
        proxy_pass $orthanc/dicom-web/$1$is_args$args;
        proxy_set_header Host $host;
        proxy_set_header Authorization "Basic YWRtaW46b3J0aGFuYw==";
        proxy_redirect off;
    }
}
EOF

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
