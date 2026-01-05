# PathView Pro - Security Deployment Guide

## ⚠️ CRITICAL SECURITY NOTICE

This document outlines the security measures implemented and required steps for secure deployment. **Do not deploy to production without completing all steps.**

## Security Changes Summary

### Phase 1: Credential Management ✅

| Change | Status | Description |
|--------|--------|-------------|
| Environment Variables | ✅ | All credentials externalized to `.env` file |
| Port Restriction | ✅ | Only ports 80/443 exposed externally |
| Password Generation | ✅ | Script generates secure random passwords |

### Phase 2: Authentication (Partial)

| Change | Status | Description |
|--------|--------|-------------|
| Proxy Auth Header | ✅ | Dynamic auth from build args |
| JWT Validation at Proxy | ⏳ | Planned - validate tokens before forwarding |
| Converter Auth Enforcement | ⏳ | Planned - require auth on all endpoints |

### Phase 3: Communication Security ✅

| Change | Status | Description |
|--------|--------|-------------|
| TLS Support | ✅ | SSL configured, self-signed for dev |
| Security Headers | ✅ | X-Frame-Options, CSP, HSTS ready |
| CORS Restriction | ✅ | Configurable allowed origins |

### Phase 4: Container Security

| Change | Status | Description |
|--------|--------|-------------|
| Non-root Users | ⏳ | Planned |
| Audit Logging | ⏳ | Planned |

---

## Initial Deployment Steps

### 1. Generate Secure Credentials

```bash
# Make the setup script executable
chmod +x scripts/setup-secure-env.sh

# Run the setup script
./scripts/setup-secure-env.sh
```

This will:
- Generate secure random passwords for PostgreSQL and Orthanc
- Create a `.env` file with your configuration
- Set restrictive file permissions (600)

### 2. Review Generated .env File

```bash
# View the generated configuration (NEVER share this output)
cat .env
```

Ensure all values are set correctly:
- `POSTGRES_PASSWORD` - unique, complex password
- `ORTHANC_PASSWORD` - unique, complex password
- `AUTH0_DOMAIN` - your Auth0 domain
- `AUTH0_AUDIENCE` - your API identifier
- `PUBLIC_URL` - your deployment URL

### 3. Build Containers with Credentials

```bash
# Build all containers (credentials are baked into nginx config)
docker compose build

# Verify no credentials in logs
docker compose config | grep -i password  # Should show ${VAR} references only
```

### 4. Start Services

```bash
# Start in detached mode
docker compose up -d

# Check all services are healthy
docker compose ps

# View logs for any errors
docker compose logs -f
```

---

## TLS/SSL Setup

### Option A: Let's Encrypt (Production)

1. **Enable Certbot in docker-compose.yml:**
   ```yaml
   certbot:
     image: certbot/certbot:latest
     volumes:
       - ssl-certs:/etc/letsencrypt
       - ssl-challenges:/var/www/certbot
     entrypoint: "/bin/sh -c 'certbot certonly --webroot -w /var/www/certbot -d your-domain.com --email admin@your-domain.com --agree-tos --non-interactive && trap exit TERM; while :; do certbot renew; sleep 12h & wait $${!}; done;'"
   ```

2. **Initial certificate request:**
   ```bash
   docker compose run --rm certbot certonly \
     --webroot -w /var/www/certbot \
     -d your-domain.com \
     --email admin@your-domain.com \
     --agree-tos --non-interactive
   ```

3. **Update .env:**
   ```
   ENABLE_TLS=true
   SSL_DOMAIN=your-domain.com
   ```

4. **Rebuild and restart:**
   ```bash
   docker compose down
   docker compose up -d
   ```

### Option B: Custom Certificates

1. **Place certificates in the ssl-certs volume:**
   ```bash
   # Copy your certificates
   docker cp fullchain.pem dicom-viewer:/etc/nginx/ssl/
   docker cp privkey.pem dicom-viewer:/etc/nginx/ssl/
   
   # Restart nginx
   docker compose restart viewer
   ```

---

## Security Checklist

### Before Production Deployment

- [ ] Run `scripts/setup-secure-env.sh` to generate credentials
- [ ] Verify `.env` is NOT committed to git (check `.gitignore`)
- [ ] Set `CORS_ALLOWED_ORIGINS` to your specific domain
- [ ] Enable TLS (`ENABLE_TLS=true`)
- [ ] Obtain valid SSL certificate
- [ ] Enable HSTS header in nginx config (uncomment line)
- [ ] Review Content-Security-Policy header
- [ ] Test authentication flow works correctly
- [ ] Verify no internal services are exposed externally

### Regular Maintenance

- [ ] Rotate passwords quarterly
- [ ] Renew SSL certificates (automatic with Let's Encrypt)
- [ ] Review access logs for suspicious activity
- [ ] Update base images monthly: `docker compose pull`
- [ ] Apply security patches promptly

---

## Network Architecture

```
                    INTERNET
                        │
                        ▼
               ┌────────────────┐
               │   Firewall     │
               │  (80, 443)     │
               └───────┬────────┘
                       │
         ┌─────────────┴─────────────┐
         │      Nginx Proxy          │
         │   (viewer container)      │
         │                           │
         │  ✓ TLS Termination        │
         │  ✓ Security Headers       │
         │  ✓ Rate Limiting          │
         │  ✓ CORS Enforcement       │
         └─────────────┬─────────────┘
                       │
          Internal Docker Network
    ┌──────────┬───────┴───────┬──────────┐
    │          │               │          │
    ▼          ▼               ▼          ▼
┌───────┐  ┌───────┐     ┌─────────┐  ┌───────┐
│Orthanc│  │Convert│     │PostgreSQL│  │ Redis │
│ :8042 │  │ :8000 │     │  :5432   │  │ :6379 │
└───────┘  └───────┘     └──────────┘  └───────┘
    │                          │
    └──── NOT EXPOSED ─────────┘
         EXTERNALLY
```

---

## Known Security Considerations

### Current Limitations

1. **Client-Side Auth Check**: Authentication is verified client-side. The API relies on Auth0 JWT validation, but the Nginx proxy currently passes through all requests to internal services.

2. **Orthanc Auth Bypass**: The proxy adds basic auth to forward requests to Orthanc. Anyone who can reach the proxy can access Orthanc data. This is mitigated by:
   - Not exposing Orthanc ports externally
   - Requiring valid Auth0 token for converter API

3. **No Audit Logging**: Medical data access is not currently logged for compliance purposes.

### Recommended Future Enhancements

1. **Nginx JWT Validation**: Add `lua-resty-jwt` or `njs` module to validate Auth0 tokens at the proxy level before forwarding.

2. **OAuth2 Proxy**: Consider using `oauth2-proxy` as a sidecar for more robust authentication.

3. **Audit Logging**: Implement centralized logging (ELK stack or similar) for HIPAA compliance.

4. **Network Policies**: In Kubernetes deployments, use NetworkPolicies to restrict pod-to-pod communication.

---

## Incident Response

### If Credentials Are Compromised

1. **Immediately:**
   ```bash
   # Stop all services
   docker compose down
   ```

2. **Generate new credentials:**
   ```bash
   ./scripts/setup-secure-env.sh
   ```

3. **Rebuild all containers:**
   ```bash
   docker compose build --no-cache
   ```

4. **Invalidate existing sessions:**
   - Rotate Auth0 signing keys
   - Clear Redis cache: `docker compose exec redis redis-cli FLUSHALL`

5. **Review logs:**
   ```bash
   docker compose logs --since 24h > incident-logs.txt
   ```

6. **Restart services:**
   ```bash
   docker compose up -d
   ```

---

## Compliance Notes

### HIPAA Considerations

PathView Pro handles Protected Health Information (PHI) through DICOM images. For HIPAA compliance:

- ✅ Encryption in transit (TLS)
- ✅ Authentication required (Auth0)
- ⏳ Audit logging (planned)
- ⏳ Access controls (partial)
- ❌ Encryption at rest (not implemented - consider volume encryption)

### GDPR Considerations

- User consent for data processing should be obtained
- Data retention policies should be documented
- Right to erasure should be implementable

---

*Document Version: 1.0 | Last Updated: January 2026*
