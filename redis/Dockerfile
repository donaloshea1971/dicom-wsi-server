FROM redis:7-alpine

# Optimized Redis config for tile caching
RUN cat > /usr/local/etc/redis/redis.conf << 'EOF'
# Memory management
maxmemory 200mb
maxmemory-policy allkeys-lru

# Persistence (AOF for durability)
appendonly yes
appendfsync everysec

# Performance
tcp-keepalive 300
timeout 0

# Logging
loglevel warning
EOF

CMD ["redis-server", "/usr/local/etc/redis/redis.conf"]

