FROM nginx:alpine

# Build arguments for credentials (passed at build time)
ARG ORTHANC_USERNAME=admin
ARG ORTHANC_PASSWORD
ARG CORS_ALLOWED_ORIGINS=*

# Copy viewer files
COPY landing.html /usr/share/nginx/html/
COPY callback.html /usr/share/nginx/html/
COPY index.html /usr/share/nginx/html/viewer.html
COPY upload.html /usr/share/nginx/html/
COPY test.html /usr/share/nginx/html/
COPY color-correction.js /usr/share/nginx/html/
COPY dicomweb-tilesource.js /usr/share/nginx/html/
COPY annotations.js /usr/share/nginx/html/
COPY space-navigator.js /usr/share/nginx/html/
COPY spacemouse-calibration.html /usr/share/nginx/html/
COPY sw.js /usr/share/nginx/html/
COPY demo-video.mp4 /usr/share/nginx/html/

# Create cache directory for tile proxy cache
RUN mkdir -p /var/cache/nginx/tiles && chown nginx:nginx /var/cache/nginx/tiles

# Create SSL directory
RUN mkdir -p /etc/nginx/ssl

# Generate base64 auth string from build args
RUN ORTHANC_AUTH=$(echo -n "${ORTHANC_USERNAME}:${ORTHANC_PASSWORD}" | base64) && \
    echo "ORTHANC_AUTH_BASE64=$ORTHANC_AUTH" > /tmp/auth.env

# Create optimized nginx config with security hardening
RUN . /tmp/auth.env && cat > /etc/nginx/nginx.conf << EOF
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

    # ==========================================================================
    # Security: Hide server version
    # ==========================================================================
    server_tokens off;

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
    limit_req_zone \$binary_remote_addr zone=api_limit:10m rate=30r/s;
    limit_req_zone \$binary_remote_addr zone=upload_limit:10m rate=5r/m;

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

    # ==========================================================================
    # Security Headers Map
    # ==========================================================================
    map \$sent_http_content_type \$security_headers {
        default "always";
    }

    server {
        listen 80;
        listen 443 ssl http2;
        server_name _;
        client_max_body_size 5000M;

        # ==========================================================================
        # SSL Configuration (optional - certificates mounted at runtime)
        # ==========================================================================
        ssl_certificate /etc/nginx/ssl/fullchain.pem;
        ssl_certificate_key /etc/nginx/ssl/privkey.pem;
        ssl_session_timeout 1d;
        ssl_session_cache shared:SSL:50m;
        ssl_session_tickets off;
        
        # Modern SSL configuration
        ssl_protocols TLSv1.2 TLSv1.3;
        ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384;
        ssl_prefer_server_ciphers off;

        # ==========================================================================
        # Security Headers
        # ==========================================================================
        add_header X-Frame-Options "SAMEORIGIN" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header X-XSS-Protection "1; mode=block" always;
        add_header Referrer-Policy "strict-origin-when-cross-origin" always;
        add_header Permissions-Policy "geolocation=(), microphone=(), camera=()" always;
        
        # HSTS (uncomment for production with valid SSL)
        # add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

        # Content Security Policy (adjust as needed)
        # Note: SpaceMouse 3DxNLServer runs locally on user's machine at wss://127.51.68.120:8181
        add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.auth0.com https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self' https://*.auth0.com wss://*.auth0.com https://cdn.jsdelivr.net wss://127.51.68.120:8181 ws://localhost:8181 ws://localhost:8182 ws://localhost:8080;" always;

        # Landing page (default)
        location = / {
            root /usr/share/nginx/html;
            try_files /landing.html =404;
        }

        # Auth callback
        location = /callback {
            root /usr/share/nginx/html;
            try_files /callback.html =404;
        }

        # Protected viewer (auth required - checked client-side)
        location = /viewer {
            root /usr/share/nginx/html;
            try_files /viewer.html =404;
        }

        # Let's Encrypt challenge (for certbot)
        location /.well-known/acme-challenge/ {
            root /var/www/certbot;
        }

        # Static files
        location / {
            root /usr/share/nginx/html;
            try_files \$uri \$uri/ /landing.html;
            
            # Cache static assets
            location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|mp4|webm)\$ {
                expires 30d;
                add_header Cache-Control "public, immutable";
            }
        }

        # Converter API
        location ~ ^/api/(.*)\$ {
            limit_req zone=api_limit burst=50 nodelay;
            
            proxy_pass http://converter/\$1\$is_args\$args;
            proxy_http_version 1.1;
            proxy_set_header Connection "";
            proxy_set_header Host \$host;
            proxy_set_header X-Real-IP \$remote_addr;
            proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto \$scheme;
            proxy_redirect off;
            proxy_read_timeout 600s;
            proxy_connect_timeout 30s;
            
            # Large file uploads
            client_max_body_size 20G;
            proxy_request_buffering off;

            # CORS headers (restricted)
            add_header Access-Control-Allow-Origin "${CORS_ALLOWED_ORIGINS}" always;
            add_header Access-Control-Allow-Methods "GET, POST, PUT, DELETE, OPTIONS" always;
            add_header Access-Control-Allow-Headers "Authorization, Content-Type, X-Requested-With" always;
            add_header Access-Control-Allow-Credentials "true" always;

            if (\$request_method = OPTIONS) {
                return 204;
            }
        }

        # File upload endpoints (chunked uploads with longer timeouts)
        location ~ ^/api/upload(/.*)?$ {
            # Lighter rate limiting for chunked uploads (many small requests)
            limit_req zone=api_limit burst=100 nodelay;
            
            proxy_pass http://converter/upload\$1\$is_args\$args;
            proxy_http_version 1.1;
            proxy_set_header Connection "";
            proxy_set_header Host \$host;
            proxy_set_header X-Real-IP \$remote_addr;
            proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto \$scheme;
            proxy_redirect off;
            
            # Long timeouts for large file uploads and conversion
            proxy_read_timeout 7200s;
            proxy_send_timeout 7200s;
            proxy_connect_timeout 60s;
            send_timeout 7200s;
            
            client_max_body_size 20G;
            proxy_request_buffering off;
            
            # CORS for upload
            add_header Access-Control-Allow-Origin "${CORS_ALLOWED_ORIGINS}" always;
            add_header Access-Control-Allow-Methods "GET, POST, PUT, DELETE, OPTIONS" always;
            add_header Access-Control-Allow-Headers "Authorization, Content-Type, X-Requested-With" always;
            add_header Access-Control-Allow-Credentials "true" always;

            if (\$request_method = OPTIONS) {
                return 204;
            }
        }

        # WSI tiles - CACHED for performance
        location ~ ^/wsi/(.*)\$ {
            proxy_pass http://orthanc/wsi/\$1\$is_args\$args;
            proxy_http_version 1.1;
            proxy_set_header Connection "";
            proxy_set_header Host \$host;
            proxy_set_header Authorization "Basic $ORTHANC_AUTH_BASE64";
            proxy_redirect off;
            
            # Aggressive tile caching
            proxy_cache tile_cache;
            proxy_cache_key "\$request_uri";
            proxy_cache_valid 200 7d;
            proxy_cache_valid 404 1m;
            proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504;
            proxy_cache_lock on;
            proxy_cache_lock_timeout 5s;
            
            # Cache headers
            add_header X-Cache-Status \$upstream_cache_status;
            add_header Cache-Control "public, max-age=604800" always;
            add_header Access-Control-Allow-Origin "${CORS_ALLOWED_ORIGINS}" always;
        }

        # DICOMweb
        location ~ ^/dicom-web/(.*)\$ {
            proxy_pass http://orthanc/dicom-web/\$1\$is_args\$args;
            proxy_http_version 1.1;
            proxy_set_header Connection "";
            proxy_set_header Host \$host;
            proxy_set_header Authorization "Basic $ORTHANC_AUTH_BASE64";
            proxy_redirect off;
            
            add_header Access-Control-Allow-Origin "${CORS_ALLOWED_ORIGINS}" always;
        }

        # Health check endpoint
        location /health {
            access_log off;
            return 200 "OK\n";
            add_header Content-Type text/plain;
        }

        # Block access to sensitive files
        location ~ /\. {
            deny all;
            access_log off;
            log_not_found off;
        }
    }
}
EOF

# Create self-signed certificate for development (will be overwritten by Let's Encrypt in production)
RUN apk add --no-cache openssl && \
    openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout /etc/nginx/ssl/privkey.pem \
    -out /etc/nginx/ssl/fullchain.pem \
    -subj "/CN=localhost" && \
    apk del openssl

# Clean up auth file
RUN rm -f /tmp/auth.env

EXPOSE 80 443

CMD ["nginx", "-g", "daemon off;"]
