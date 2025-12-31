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

    location /api/studies {
        set $orthanc http://dicom-orthanc:8042;
        proxy_pass $orthanc/studies;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Authorization "Basic YWRtaW46b3J0aGFuYw==";
        proxy_redirect off;
        proxy_read_timeout 600s;
    }

    location /api/series {
        set $orthanc http://dicom-orthanc:8042;
        proxy_pass $orthanc/series;
        proxy_set_header Host $host;
        proxy_set_header Authorization "Basic YWRtaW46b3J0aGFuYw==";
        proxy_redirect off;
    }

    location /api/instances {
        set $orthanc http://dicom-orthanc:8042;
        proxy_pass $orthanc/instances;
        proxy_set_header Host $host;
        proxy_set_header Authorization "Basic YWRtaW46b3J0aGFuYw==";
        proxy_redirect off;
    }

    location /api/patients {
        set $orthanc http://dicom-orthanc:8042;
        proxy_pass $orthanc/patients;
        proxy_set_header Host $host;
        proxy_set_header Authorization "Basic YWRtaW46b3J0aGFuYw==";
        proxy_redirect off;
    }

    location /api/system {
        set $orthanc http://dicom-orthanc:8042;
        proxy_pass $orthanc/system;
        proxy_set_header Host $host;
        proxy_set_header Authorization "Basic YWRtaW46b3J0aGFuYw==";
        proxy_redirect off;
    }

    location /wsi/ {
        set $orthanc http://dicom-orthanc:8042;
        proxy_pass $orthanc/wsi/;
        proxy_set_header Host $host;
        proxy_set_header Authorization "Basic YWRtaW46b3J0aGFuYw==";
        proxy_redirect off;
    }

    location /dicom-web/ {
        set $orthanc http://dicom-orthanc:8042;
        proxy_pass $orthanc/dicom-web/;
        proxy_set_header Host $host;
        proxy_set_header Authorization "Basic YWRtaW46b3J0aGFuYw==";
        proxy_redirect off;
    }
}
EOF

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
