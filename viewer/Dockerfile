FROM nginx:alpine

# Copy viewer files
COPY index.html /usr/share/nginx/html/
COPY upload.html /usr/share/nginx/html/
COPY test.html /usr/share/nginx/html/
COPY color-correction.js /usr/share/nginx/html/
COPY dicomweb-tilesource.js /usr/share/nginx/html/
COPY annotations.js /usr/share/nginx/html/
COPY sw.js /usr/share/nginx/html/

# Create cache directory for tile proxy cache
RUN mkdir -p /var/cache/nginx/tiles && chown nginx:nginx /var/cache/nginx/tiles

# Create optimized nginx config
RUN cat > /etc/nginx/nginx.conf << 'EOF'
worker_processes auto;
worker_rlimit_nofile 65535;

events {
    worker_connections 4096;
    use epoll;
    multi_accept on;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    # Optimizations
    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;
    keepalive_timeout 65;
    keepalive_requests 1000;
    types_hash_max_size 2048;

    # Buffer sizes
    client_body_buffer_size 128k;
    proxy_buffer_size 16k;
    proxy_buffers 8 32k;
    proxy_busy_buffers_size 64k;

    # Gzip compression
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_min_length 1000;
    gzip_types text/plain text/css text/xml application/json application/javascript 
               application/xml application/xml+rss text/javascript image/svg+xml;

    # Proxy cache for WSI tiles (1GB cache, 7 day retention)
    proxy_cache_path /var/cache/nginx/tiles levels=1:2 keys_zone=tile_cache:100m 
                     max_size=1g inactive=7d use_temp_path=off;

    # Rate limiting (prevent abuse)
    limit_req_zone $binary_remote_addr zone=api_limit:10m rate=30r/s;

    # Upstream connection pooling
    upstream orthanc {
        server dicom-orthanc:8042;
        keepalive 32;
    }

    upstream converter {
        server dicom-converter:8000;
        keepalive 16;
    }

    resolver 127.0.0.11 valid=30s ipv6=off;

    server {
        listen 80;
        server_name _;
        client_max_body_size 5000M;

        # Static files with long cache
        location / {
            root /usr/share/nginx/html;
            index index.html;
            try_files $uri $uri/ /index.html;
            
            # Cache static assets
            location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2)$ {
                expires 30d;
                add_header Cache-Control "public, immutable";
            }
        }

        # Converter API
        location ~ ^/api/(.*)$ {
            limit_req zone=api_limit burst=50 nodelay;
            
            proxy_pass http://converter/$1$is_args$args;
            proxy_http_version 1.1;
            proxy_set_header Connection "";
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_redirect off;
            proxy_read_timeout 600s;
            proxy_connect_timeout 30s;
            
            # Large file uploads
            client_max_body_size 20G;
            proxy_request_buffering off;
        }

        # WSI tiles - CACHED for performance
        location ~ ^/wsi/(.*)$ {
            proxy_pass http://orthanc/wsi/$1$is_args$args;
            proxy_http_version 1.1;
            proxy_set_header Connection "";
            proxy_set_header Host $host;
            proxy_set_header Authorization "Basic YWRtaW46b3J0aGFuYw==";
            proxy_redirect off;
            
            # Aggressive tile caching
            proxy_cache tile_cache;
            proxy_cache_key "$request_uri";
            proxy_cache_valid 200 7d;
            proxy_cache_valid 404 1m;
            proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504;
            proxy_cache_lock on;
            proxy_cache_lock_timeout 5s;
            
            # Cache headers
            add_header X-Cache-Status $upstream_cache_status;
            add_header Cache-Control "public, max-age=604800" always;
            add_header Access-Control-Allow-Origin "*" always;
        }

        # DICOMweb
        location ~ ^/dicom-web/(.*)$ {
            proxy_pass http://orthanc/dicom-web/$1$is_args$args;
            proxy_http_version 1.1;
            proxy_set_header Connection "";
            proxy_set_header Host $host;
            proxy_set_header Authorization "Basic YWRtaW46b3J0aGFuYw==";
            proxy_redirect off;
            
            add_header Access-Control-Allow-Origin "*" always;
        }

        # Health check endpoint
        location /health {
            access_log off;
            return 200 "OK\n";
            add_header Content-Type text/plain;
        }
    }
}
EOF

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
