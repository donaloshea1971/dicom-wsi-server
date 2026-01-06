# =============================================================================
# PathView Pro - Production Deployment Script (Windows PowerShell)
# =============================================================================
# Usage: .\scripts\deploy.ps1 [command]
# Commands:
#   setup     - Initial server setup and first deployment
#   deploy    - Pull latest code and redeploy
#   update    - Update specific service (deploy.ps1 update converter)
#   logs      - View logs (deploy.ps1 logs converter)
#   backup    - Backup database
#   status    - Show service status
#   stop      - Stop all services
#   restart   - Restart all services
# =============================================================================

param(
    [Parameter(Position=0)]
    [string]$Command = "help",
    
    [Parameter(Position=1)]
    [string]$Arg1
)

$ErrorActionPreference = "Stop"

# Colors
function Write-Log { param([string]$Message) Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message" -ForegroundColor Green }
function Write-Warn { param([string]$Message) Write-Host "[WARN] $Message" -ForegroundColor Yellow }
function Write-Err { param([string]$Message) Write-Host "[ERROR] $Message" -ForegroundColor Red; exit 1 }

# =============================================================================
# Check prerequisites
# =============================================================================
function Test-Prerequisites {
    Write-Log "Checking prerequisites..."
    
    # Check Docker
    try {
        $null = docker --version
    } catch {
        Write-Err "Docker is not installed or not in PATH."
    }
    
    # Check Docker Compose
    try {
        $null = docker compose version
    } catch {
        Write-Err "Docker Compose V2 is not available."
    }
    
    # Check .env file
    if (-not (Test-Path ".env")) {
        if (Test-Path "config\env.example") {
            Write-Warn ".env file not found. Copying from config\env.example..."
            Copy-Item "config\env.example" ".env"
            Write-Warn "Please edit .env with your production values before continuing!"
            exit 1
        } else {
            Write-Err ".env file not found and no template available."
        }
    }
    
    Write-Log "Prerequisites check passed"
}

# =============================================================================
# Load environment variables from .env
# =============================================================================
function Import-EnvFile {
    if (Test-Path ".env") {
        Get-Content ".env" | ForEach-Object {
            if ($_ -match "^\s*([^#][^=]+)=(.*)$") {
                $name = $matches[1].Trim()
                $value = $matches[2].Trim()
                Set-Item -Path "env:$name" -Value $value
            }
        }
    }
}

# =============================================================================
# Initial setup
# =============================================================================
function Start-Setup {
    Write-Log "Starting initial setup..."
    Test-Prerequisites
    Import-EnvFile
    
    # Validate required variables
    if ([string]::IsNullOrEmpty($env:POSTGRES_PASSWORD) -or $env:POSTGRES_PASSWORD -eq "CHANGE_ME_GENERATE_SECURE_PASSWORD") {
        Write-Err "Please set a secure POSTGRES_PASSWORD in .env"
    }
    
    if ([string]::IsNullOrEmpty($env:ORTHANC_PASSWORD) -or $env:ORTHANC_PASSWORD -eq "CHANGE_ME_GENERATE_SECURE_PASSWORD") {
        Write-Err "Please set a secure ORTHANC_PASSWORD in .env"
    }
    
    if ([string]::IsNullOrEmpty($env:AUTH0_DOMAIN)) {
        Write-Err "Please set AUTH0_DOMAIN in .env"
    }
    
    # Build and start
    Write-Log "Building containers..."
    docker compose build --no-cache
    
    Write-Log "Starting services..."
    docker compose up -d
    
    # Wait for services
    Write-Log "Waiting for services to be healthy..."
    Start-Sleep -Seconds 30
    
    # Initialize database
    Write-Log "Initializing database schema..."
    $pgUser = if ($env:POSTGRES_USER) { $env:POSTGRES_USER } else { "orthanc" }
    $pgDb = if ($env:POSTGRES_DB) { $env:POSTGRES_DB } else { "orthanc" }
    
    Get-Content "scripts\init_schema.sql" | docker compose exec -T postgres psql -U $pgUser -d $pgDb
    
    Get-ServiceStatus
    Write-Log "Setup complete!"
}

# =============================================================================
# Deploy/update
# =============================================================================
function Start-Deploy {
    Write-Log "Starting deployment..."
    Test-Prerequisites
    Import-EnvFile
    
    # Pull latest code if git repo
    if (Test-Path ".git") {
        Write-Log "Pulling latest code..."
        git pull origin main
    }
    
    # Build and restart
    Write-Log "Rebuilding containers..."
    docker compose build
    
    Write-Log "Restarting services..."
    docker compose up -d
    
    # Run migrations
    Write-Log "Running database migrations..."
    $pgUser = if ($env:POSTGRES_USER) { $env:POSTGRES_USER } else { "orthanc" }
    $pgDb = if ($env:POSTGRES_DB) { $env:POSTGRES_DB } else { "orthanc" }
    Get-Content "scripts\init_schema.sql" | docker compose exec -T postgres psql -U $pgUser -d $pgDb 2>$null
    
    # Cleanup
    Write-Log "Cleaning up old images..."
    docker image prune -f
    
    Get-ServiceStatus
    Write-Log "Deployment complete!"
}

# =============================================================================
# Update specific service
# =============================================================================
function Update-Service {
    param([string]$ServiceName)
    
    if ([string]::IsNullOrEmpty($ServiceName)) {
        Write-Err "Please specify a service: converter, viewer, orthanc, postgres, redis"
    }
    
    Write-Log "Updating service: $ServiceName"
    docker compose build $ServiceName
    docker compose up -d $ServiceName
    Write-Log "Service $ServiceName updated"
}

# =============================================================================
# View logs
# =============================================================================
function Get-ServiceLogs {
    param([string]$ServiceName)
    
    if ([string]::IsNullOrEmpty($ServiceName)) {
        docker compose logs -f --tail=100
    } else {
        docker compose logs -f --tail=100 $ServiceName
    }
}

# =============================================================================
# Backup
# =============================================================================
function Start-Backup {
    Write-Log "Starting backup..."
    Import-EnvFile
    
    $timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
    $backupDir = ".\backups\$timestamp"
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
    
    $pgUser = if ($env:POSTGRES_USER) { $env:POSTGRES_USER } else { "orthanc" }
    $pgDb = if ($env:POSTGRES_DB) { $env:POSTGRES_DB } else { "orthanc" }
    
    # Backup PostgreSQL
    Write-Log "Backing up PostgreSQL..."
    docker compose exec -T postgres pg_dump -U $pgUser $pgDb > "$backupDir\postgres.sql"
    
    # Compress
    Write-Log "Compressing backup..."
    Compress-Archive -Path $backupDir -DestinationPath "$backupDir.zip"
    Remove-Item -Path $backupDir -Recurse -Force
    
    Write-Log "Backup complete: $backupDir.zip"
}

# =============================================================================
# Status
# =============================================================================
function Get-ServiceStatus {
    Write-Log "Service Status:"
    Write-Host ""
    docker compose ps
    Write-Host ""
    
    Write-Log "Health Checks:"
    Write-Host ""
    
    $services = @("postgres", "redis", "orthanc", "converter", "viewer")
    foreach ($service in $services) {
        $status = docker compose ps $service --format "{{.Status}}" 2>$null
        if ($status -match "healthy|Up") {
            Write-Host "  [OK] $service`: $status" -ForegroundColor Green
        } else {
            Write-Host "  [!!] $service`: $status" -ForegroundColor Red
        }
    }
    
    Write-Host ""
    Write-Log "Resource Usage:"
    docker stats --no-stream --format "table {{.Name}}`t{{.CPUPerc}}`t{{.MemUsage}}" | Select-String -Pattern "(NAME|dicom)"
}

# =============================================================================
# Stop
# =============================================================================
function Stop-Services {
    Write-Log "Stopping all services..."
    docker compose down
    Write-Log "All services stopped"
}

# =============================================================================
# Restart
# =============================================================================
function Restart-Services {
    Write-Log "Restarting all services..."
    docker compose restart
    Write-Log "All services restarted"
}

# =============================================================================
# Help
# =============================================================================
function Show-Help {
    Write-Host "PathView Pro Deployment Script (Windows)" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Usage: .\scripts\deploy.ps1 [command]"
    Write-Host ""
    Write-Host "Commands:"
    Write-Host "  setup     - Initial server setup and first deployment"
    Write-Host "  deploy    - Pull latest code and redeploy all services"
    Write-Host "  update    - Update specific service (e.g., deploy.ps1 update converter)"
    Write-Host "  logs      - View logs (e.g., deploy.ps1 logs converter)"
    Write-Host "  backup    - Backup database"
    Write-Host "  status    - Show service status"
    Write-Host "  stop      - Stop all services"
    Write-Host "  restart   - Restart all services"
}

# =============================================================================
# Main
# =============================================================================
switch ($Command.ToLower()) {
    "setup"   { Start-Setup }
    "deploy"  { Start-Deploy }
    "update"  { Update-Service -ServiceName $Arg1 }
    "logs"    { Get-ServiceLogs -ServiceName $Arg1 }
    "backup"  { Start-Backup }
    "status"  { Get-ServiceStatus }
    "stop"    { Stop-Services }
    "restart" { Restart-Services }
    default   { Show-Help }
}
