FROM nginx:alpine

# Copy viewer files (we're in viewer/ context)
COPY index.html /usr/share/nginx/html/
COPY test.html /usr/share/nginx/html/
COPY color-correction.js /usr/share/nginx/html/
COPY dicomweb-tilesource.js /usr/share/nginx/html/

# Create nginx config for reverse proxy
RUN echo 'server { \
    listen 80; \
    server_name _; \
    client_max_body_size 5000M; \
    \
    location / { \
        root /usr/share/nginx/html; \
        index index.html; \
        try_files $uri $uri/ /index.html; \
    } \
    \
    location /api/ { \
        proxy_pass http://orthanc:8042/; \
        proxy_set_header Host $host; \
        proxy_set_header X-Real-IP $remote_addr; \
        proxy_read_timeout 600s; \
    } \
    \
    location /wsi/ { \
        proxy_pass http://orthanc:8042/wsi/; \
        proxy_set_header Host $host; \
    } \
    \
    location /dicom-web/ { \
        proxy_pass http://orthanc:8042/dicom-web/; \
        proxy_set_header Host $host; \
    } \
}' > /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
