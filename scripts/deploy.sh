#!/bin/bash
# =============================================================================
# PathView Pro - Production Deployment Script
# =============================================================================
# Usage: ./scripts/deploy.sh [command]
# Commands:
#   setup     - Initial server setup and first deployment
#   deploy    - Pull latest code and redeploy
#   update    - Update specific service (deploy update converter)
#   logs      - View logs (deploy logs converter)
#   ssl       - Setup/renew SSL certificates
#   backup    - Backup database and volumes
#   restore   - Restore from backup
#   status    - Show service status
# =============================================================================

set -e

# Configuration
PROJECT_NAME="pathviewpro"
COMPOSE_FILE="docker-compose.yml"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log() { echo -e "${GREEN}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# =============================================================================
# Check prerequisites
# =============================================================================
check_prerequisites() {
    log "Checking prerequisites..."
    
    # Check Docker
    if ! command -v docker &> /dev/null; then
        error "Docker is not installed. Please install Docker first."
    fi
    
    # Check Docker Compose
    if ! docker compose version &> /dev/null; then
        error "Docker Compose V2 is not installed. Please install Docker Compose."
    fi
    
    # Check if .env exists
    if [ ! -f ".env" ]; then
        if [ -f "config/env.example" ]; then
            warn ".env file not found. Copying from config/env.example..."
            cp config/env.example .env
            warn "Please edit .env with your production values before continuing!"
            exit 1
        else
            error ".env file not found and no template available."
        fi
    fi
    
    log "Prerequisites check passed ✓"
}

# =============================================================================
# Initial server setup
# =============================================================================
setup() {
    log "Starting initial setup..."
    check_prerequisites
    
    # Load environment variables
    set -a
    source .env
    set +a
    
    # Validate required variables
    if [ -z "$POSTGRES_PASSWORD" ] || [ "$POSTGRES_PASSWORD" == "CHANGE_ME_GENERATE_SECURE_PASSWORD" ]; then
        error "Please set a secure POSTGRES_PASSWORD in .env"
    fi
    
    if [ -z "$ORTHANC_PASSWORD" ] || [ "$ORTHANC_PASSWORD" == "CHANGE_ME_GENERATE_SECURE_PASSWORD" ]; then
        error "Please set a secure ORTHANC_PASSWORD in .env"
    fi
    
    if [ -z "$AUTH0_DOMAIN" ]; then
        error "Please set AUTH0_DOMAIN in .env"
    fi
    
    # Pull latest images and build
    log "Building containers..."
    docker compose build --no-cache
    
    # Start services
    log "Starting services..."
    docker compose up -d
    
    # Wait for services to be healthy
    log "Waiting for services to be healthy..."
    sleep 30
    
    # Initialize database schema
    log "Initializing database schema..."
    docker compose exec -T postgres psql -U ${POSTGRES_USER:-orthanc} -d ${POSTGRES_DB:-orthanc} < scripts/init_schema.sql || warn "Schema may already exist"
    
    # Show status
    status
    
    log "Setup complete! ✓"
    log "Access your application at: ${PUBLIC_URL:-http://localhost}"
}

# =============================================================================
# Deploy/update application
# =============================================================================
deploy() {
    log "Starting deployment..."
    check_prerequisites
    
    # Pull latest code (if git repo)
    if [ -d ".git" ]; then
        log "Pulling latest code..."
        git pull origin main || warn "Git pull failed, continuing with local code"
    fi
    
    # Load environment
    set -a
    source .env
    set +a
    
    # Build and restart
    log "Rebuilding containers..."
    docker compose build
    
    log "Restarting services..."
    docker compose up -d
    
    # Run any database migrations
    log "Running database migrations..."
    docker compose exec -T postgres psql -U ${POSTGRES_USER:-orthanc} -d ${POSTGRES_DB:-orthanc} < scripts/init_schema.sql 2>/dev/null || true
    
    # Clean up old images
    log "Cleaning up old images..."
    docker image prune -f
    
    status
    log "Deployment complete! ✓"
}

# =============================================================================
# Update specific service
# =============================================================================
update_service() {
    SERVICE=$1
    if [ -z "$SERVICE" ]; then
        error "Please specify a service: converter, viewer, orthanc, postgres, redis"
    fi
    
    log "Updating service: $SERVICE"
    docker compose build $SERVICE
    docker compose up -d $SERVICE
    log "Service $SERVICE updated ✓"
}

# =============================================================================
# View logs
# =============================================================================
logs() {
    SERVICE=$1
    if [ -z "$SERVICE" ]; then
        docker compose logs -f --tail=100
    else
        docker compose logs -f --tail=100 $SERVICE
    fi
}

# =============================================================================
# Setup SSL with Let's Encrypt
# =============================================================================
setup_ssl() {
    log "Setting up SSL certificates..."
    
    set -a
    source .env
    set +a
    
    if [ -z "$SSL_DOMAIN" ]; then
        error "Please set SSL_DOMAIN in .env"
    fi
    
    if [ -z "$SSL_EMAIL" ]; then
        error "Please set SSL_EMAIL in .env"
    fi
    
    # Create certbot directories
    mkdir -p ./certbot/conf ./certbot/www
    
    # Get certificates
    docker run --rm \
        -v ./certbot/conf:/etc/letsencrypt \
        -v ./certbot/www:/var/www/certbot \
        -p 80:80 \
        certbot/certbot certonly \
        --standalone \
        --preferred-challenges http \
        --email $SSL_EMAIL \
        --agree-tos \
        --no-eff-email \
        -d $SSL_DOMAIN
    
    # Copy certificates to SSL volume
    docker compose cp ./certbot/conf/live/$SSL_DOMAIN/fullchain.pem viewer:/etc/nginx/ssl/fullchain.pem
    docker compose cp ./certbot/conf/live/$SSL_DOMAIN/privkey.pem viewer:/etc/nginx/ssl/privkey.pem
    
    # Reload nginx
    docker compose exec viewer nginx -s reload
    
    log "SSL setup complete! ✓"
}

# =============================================================================
# Backup
# =============================================================================
backup() {
    log "Starting backup..."
    
    BACKUP_DIR="./backups/$(date +%Y%m%d_%H%M%S)"
    mkdir -p $BACKUP_DIR
    
    set -a
    source .env
    set +a
    
    # Backup PostgreSQL
    log "Backing up PostgreSQL..."
    docker compose exec -T postgres pg_dump -U ${POSTGRES_USER:-orthanc} ${POSTGRES_DB:-orthanc} > $BACKUP_DIR/postgres.sql
    
    # Backup volumes info
    log "Backing up volume information..."
    docker volume ls --filter name=${PROJECT_NAME} > $BACKUP_DIR/volumes.txt
    
    # Compress backup
    log "Compressing backup..."
    tar -czf $BACKUP_DIR.tar.gz -C ./backups $(basename $BACKUP_DIR)
    rm -rf $BACKUP_DIR
    
    log "Backup complete: $BACKUP_DIR.tar.gz ✓"
}

# =============================================================================
# Restore from backup
# =============================================================================
restore() {
    BACKUP_FILE=$1
    if [ -z "$BACKUP_FILE" ]; then
        error "Please specify backup file: deploy restore backups/20240101_120000.tar.gz"
    fi
    
    if [ ! -f "$BACKUP_FILE" ]; then
        error "Backup file not found: $BACKUP_FILE"
    fi
    
    log "Restoring from: $BACKUP_FILE"
    warn "This will overwrite current data. Press Ctrl+C to cancel, or Enter to continue..."
    read
    
    set -a
    source .env
    set +a
    
    # Extract backup
    TEMP_DIR=$(mktemp -d)
    tar -xzf $BACKUP_FILE -C $TEMP_DIR
    BACKUP_NAME=$(ls $TEMP_DIR)
    
    # Restore PostgreSQL
    log "Restoring PostgreSQL..."
    docker compose exec -T postgres psql -U ${POSTGRES_USER:-orthanc} -d ${POSTGRES_DB:-orthanc} < $TEMP_DIR/$BACKUP_NAME/postgres.sql
    
    # Cleanup
    rm -rf $TEMP_DIR
    
    log "Restore complete! ✓"
}

# =============================================================================
# Show status
# =============================================================================
status() {
    log "Service Status:"
    echo ""
    docker compose ps
    echo ""
    
    log "Health Checks:"
    echo ""
    
    # Check each service
    for service in postgres redis orthanc converter viewer; do
        STATUS=$(docker compose ps $service --format "{{.Status}}" 2>/dev/null || echo "not running")
        if [[ $STATUS == *"healthy"* ]] || [[ $STATUS == *"Up"* ]]; then
            echo -e "  ${GREEN}✓${NC} $service: $STATUS"
        else
            echo -e "  ${RED}✗${NC} $service: $STATUS"
        fi
    done
    
    echo ""
    log "Resource Usage:"
    docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}" | grep -E "(NAME|dicom)"
}

# =============================================================================
# Stop all services
# =============================================================================
stop() {
    log "Stopping all services..."
    docker compose down
    log "All services stopped ✓"
}

# =============================================================================
# Restart all services
# =============================================================================
restart() {
    log "Restarting all services..."
    docker compose restart
    log "All services restarted ✓"
}

# =============================================================================
# Main
# =============================================================================
case "$1" in
    setup)
        setup
        ;;
    deploy)
        deploy
        ;;
    update)
        update_service $2
        ;;
    logs)
        logs $2
        ;;
    ssl)
        setup_ssl
        ;;
    backup)
        backup
        ;;
    restore)
        restore $2
        ;;
    status)
        status
        ;;
    stop)
        stop
        ;;
    restart)
        restart
        ;;
    *)
        echo "PathView Pro Deployment Script"
        echo ""
        echo "Usage: $0 [command]"
        echo ""
        echo "Commands:"
        echo "  setup     - Initial server setup and first deployment"
        echo "  deploy    - Pull latest code and redeploy all services"
        echo "  update    - Update specific service (e.g., $0 update converter)"
        echo "  logs      - View logs (e.g., $0 logs converter)"
        echo "  ssl       - Setup/renew Let's Encrypt SSL certificates"
        echo "  backup    - Backup database"
        echo "  restore   - Restore from backup"
        echo "  status    - Show service status"
        echo "  stop      - Stop all services"
        echo "  restart   - Restart all services"
        ;;
esac
