#!/bin/bash
#
# Elegoo Web — Uninstallation Script
# Removes the CC2 Commander systemd service and optionally removes files
#

set -e

INSTALL_DIR="/opt/elegooweb"
SERVICE_NAME="elegooweb"
SERVICE_USER="elegooweb"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Check if running as root
if [[ $EUID -ne 0 ]]; then
    log_error "This script must be run as root (or via sudo)"
    exit 1
fi

# Stop and disable service
if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
    log_info "Stopping $SERVICE_NAME service..."
    systemctl stop "$SERVICE_NAME"
fi

if systemctl is-enabled --quiet "$SERVICE_NAME" 2>/dev/null; then
    log_info "Disabling $SERVICE_NAME service..."
    systemctl disable "$SERVICE_NAME"
fi

# Remove service file
if [[ -f "/etc/systemd/system/$SERVICE_NAME.service" ]]; then
    log_info "Removing systemd service file..."
    rm "/etc/systemd/system/$SERVICE_NAME.service"
    systemctl daemon-reload
fi

# Ask about removing files
read -p "Remove installation directory ($INSTALL_DIR)? [y/N] " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    log_info "Removing $INSTALL_DIR..."
    rm -rf "$INSTALL_DIR"
else
    log_info "Keeping $INSTALL_DIR (.env and data/ preserved)"
fi

# Ask about removing user
read -p "Remove service user ($SERVICE_USER)? [y/N] " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    if id "$SERVICE_USER" &>/dev/null; then
        log_info "Removing user $SERVICE_USER..."
        userdel "$SERVICE_USER"
    fi
fi

log_info "Uninstallation complete!"
