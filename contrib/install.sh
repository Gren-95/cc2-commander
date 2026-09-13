#!/bin/bash
#
# Elegoo Web — Installation Script
# Installs CC2 Commander as a systemd service
#

set -e

INSTALL_DIR="/opt/elegooweb"
SERVICE_NAME="elegooweb"
SERVICE_USER="elegooweb"
SERVICE_PORT="${1:-8088}"

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

# Check for Bun — the package manager, the TypeScript runtime and the HTTP server all
# at once. Node and pnpm are no longer required by anything here.
#
# `bun` is resolved to an ABSOLUTE path because it has to go into the systemd unit, and
# the unit's ExecStart is not resolved through $PATH.
if ! command -v bun &> /dev/null; then
    log_error "Bun is not installed. Install it with:"
    log_error "  curl -fsSL https://bun.sh/install | bash"
    log_error "…then move or symlink it somewhere system-wide, e.g. /usr/local/bin/bun."
    exit 1
fi
BUN_BIN="$(command -v bun)"
BUN_VERSION="$(bun --version)"

# 1.2.3 is the floor, not a preference: `Bun.serve({ routes })` — how src/server/spa.ts
# serves the built frontend — does not exist before it, and neither does the bun.lock
# text lockfile this install reads.
BUN_MAJOR="${BUN_VERSION%%.*}"
BUN_REST="${BUN_VERSION#*.}"
BUN_MINOR="${BUN_REST%%.*}"
BUN_PATCH="${BUN_REST#*.}"
BUN_PATCH="${BUN_PATCH%%[!0-9]*}"
if (( BUN_MAJOR < 1 )) \
   || (( BUN_MAJOR == 1 && BUN_MINOR < 2 )) \
   || (( BUN_MAJOR == 1 && BUN_MINOR == 2 && BUN_PATCH < 3 )); then
    log_error "Bun 1.2.3+ required. Found: $BUN_VERSION"
    log_error "  Upgrade with: bun upgrade"
    exit 1
fi
log_info "Bun version: $BUN_VERSION ($BUN_BIN)"

# The unit sets ProtectHome=true, so a bun living under /home or /root is invisible to
# the service no matter what ExecStart says — it would install cleanly and then fail to
# start, which is the worst of both.
case "$BUN_BIN" in
    /home/*|/root/*)
        log_error "Bun is installed at $BUN_BIN, under a home directory."
        log_error "  The service runs with ProtectHome=true and cannot see it there."
        log_error "  Install it system-wide instead, e.g.:"
        log_error "    install -m 0755 $BUN_BIN /usr/local/bin/bun"
        exit 1
        ;;
esac

# Check for rsync — the deploy is delete-consistent and there is no safe fallback.
# Falling back to `cp -r` here would silently reintroduce the exact bug this guards
# against (a file deleted from git stays live in $INSTALL_DIR forever) while reporting
# a successful install, so this exits rather than degrading.
if ! command -v rsync &> /dev/null; then
    log_error "rsync is not installed, and the deploy requires it."
    log_error "  Install it (apt install rsync / dnf install rsync / pacman -S rsync) and re-run."
    log_error "  Do not substitute 'cp -r': it never deletes, so files removed from the"
    log_error "  repository would remain live in $INSTALL_DIR."
    exit 1
fi

# Resolve source directory (repo root = parent of contrib/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Create service user if not exists
if ! id "$SERVICE_USER" &>/dev/null; then
    log_info "Creating service user: $SERVICE_USER"
    useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi

# Build the frontend if the source tree has none.
#
# This builds in $SCRIPT_DIR — the checkout — and NOT in $INSTALL_DIR. Building in the
# install directory is what used to drag the entire dev toolchain (vite, vitest,
# typescript, and at the time release-it) into production, which every later install then
# had to prune back out, emitting the "Failed to create bin ... ENOENT" warnings that
# made a healthy deploy look broken (ELEG-19). $INSTALL_DIR gets runtime dependencies
# and nothing else.
#
# It also drops to $SUDO_USER: this script runs as root, and a root-owned dist/ and
# node_modules/ left behind in someone's working tree is a nasty parting gift.
if [[ ! -d "$SCRIPT_DIR/dist" ]]; then
    log_info "No dist/ in source — building the frontend..."
    if [[ -n "${SUDO_USER:-}" ]]; then
        sudo -u "$SUDO_USER" bash -c "cd $(printf '%q' "$SCRIPT_DIR") && bun install && bun run build"
    else
        log_warn "  No SUDO_USER — building as root, which will leave root-owned files in $SCRIPT_DIR"
        (cd "$SCRIPT_DIR" && bun install && bun run build)
    fi
fi

# Create installation directory
log_info "Creating installation directory: $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR/data"

# Copy source files — delete-consistent, so a file removed from the repository is also
# removed from the deploy.
#
# --delete is scoped to ONE DIRECTORY AT A TIME and is never run over $INSTALL_DIR
# itself. That is the whole safety argument: src/, dist/ and public/ are wholly owned by
# the repository, while the state that must survive an upgrade lives at the install root
# beside them —
#
#   $INSTALL_DIR/.env           the only copy of PRINTER_PASSWORD and
#                               TELEGRAM_BOT_TOKEN. No backup anywhere.
#   $INSTALL_DIR/data/          persisted runtime state (DATA_DIR), created above
#   $INSTALL_DIR/node_modules/  installed deps, not present in the source tree
#
# — so none of them is inside the deletion scope at all. The --exclude list is a second
# line of defence for the case where one of those ever moves inside a synced directory;
# it is deliberately not the only one. Do not "simplify" this into a single
# `rsync -a --delete "$SCRIPT_DIR/" "$INSTALL_DIR/"`, which would put all three back
# under the excludes and one typo away from destroying production.
#
# Note the existing `if [[ ! -f "$INSTALL_DIR/.env" ]]` guard below protects against
# *overwrite* only. It is not cover for --delete.
#
# Trailing slashes are load-bearing: `rsync -a src/ dest/src/` copies the contents,
# `rsync -a src dest/src/` would nest the tree as dest/src/src.
RSYNC_OPTS=(-a --delete --exclude=.env --exclude=data/ --exclude=node_modules/)

log_info "Copying files (delete-consistent)..."
rsync "${RSYNC_OPTS[@]}" "$SCRIPT_DIR/src/" "$INSTALL_DIR/src/"
# dist/ and public/ may be absent from the source; skip rather than sync, because an
# absent source with --delete would empty the deployed copy.
if [[ -d "$SCRIPT_DIR/dist" ]]; then
    rsync "${RSYNC_OPTS[@]}" "$SCRIPT_DIR/dist/" "$INSTALL_DIR/dist/"
else
    log_warn "  No dist/ in source — leaving the deployed frontend untouched"
fi
if [[ -d "$SCRIPT_DIR/public" ]]; then
    rsync "${RSYNC_OPTS[@]}" "$SCRIPT_DIR/public/" "$INSTALL_DIR/public/"
fi
# Single files: no delete semantics to get right.
cp "$SCRIPT_DIR/package.json" "$INSTALL_DIR/"
cp "$SCRIPT_DIR/bun.lock" "$INSTALL_DIR/"
cp "$SCRIPT_DIR/tsconfig.json" "$INSTALL_DIR/"
cp "$SCRIPT_DIR/tsconfig.server.json" "$INSTALL_DIR/" 2>/dev/null || true

# Stamp the deploy — $INSTALL_DIR is not a git checkout, so this file is the only way
# to ask what is actually running. Read back by src/server/build-info.ts and reported
# from /api/health.
#
# Everything here degrades to null rather than failing the install: $SCRIPT_DIR may be
# an unpacked tarball rather than a checkout, and git may be absent from the PATH under
# sudo. `set -e` is active, so every capture is guarded.
#
# It lands at the install root, deliberately outside src/, dist/ and public/ — those are
# wholly owned by the repo and are the directories a delete-consistent copy sweeps.
log_info "Stamping deploy..."
GIT_COMMIT=""
GIT_SHORT=""
GIT_DESCRIBE=""
# -c safe.directory: the installer runs as root over a checkout owned by someone else,
# which git otherwise refuses as "dubious ownership" — that would silently produce an
# unstamped install in the one case this feature exists for.
GIT_CMD=(git -c "safe.directory=$SCRIPT_DIR" -C "$SCRIPT_DIR")
if command -v git &> /dev/null && "${GIT_CMD[@]}" rev-parse --git-dir &> /dev/null; then
    GIT_COMMIT="$("${GIT_CMD[@]}" rev-parse HEAD 2>/dev/null || true)"
    GIT_SHORT="$("${GIT_CMD[@]}" rev-parse --short HEAD 2>/dev/null || true)"
    GIT_DESCRIBE="$("${GIT_CMD[@]}" describe --tags --always --dirty 2>/dev/null || true)"
else
    log_warn "  Source is not a git checkout — /api/health will report an unknown build"
fi
PKG_VERSION="$(bun -e "console.log(require('$SCRIPT_DIR/package.json').version)" 2>/dev/null || true)"

# Serialised by bun rather than by hand: it is already a hard dependency (checked
# above) and it cannot mis-escape a value the way a printf template can.
if BUILD_COMMIT="$GIT_COMMIT" BUILD_SHORT="$GIT_SHORT" BUILD_DESCRIBE="$GIT_DESCRIBE" \
   BUILD_VERSION="$PKG_VERSION" BUILD_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
   bun -e 'const f = (v) => (v ? v : null);
process.stdout.write(JSON.stringify({
  commit: f(process.env.BUILD_COMMIT),
  shortCommit: f(process.env.BUILD_SHORT),
  describe: f(process.env.BUILD_DESCRIBE),
  version: f(process.env.BUILD_VERSION),
  installedAt: f(process.env.BUILD_AT),
}, null, 2) + "\n");' > "$INSTALL_DIR/build-info.json"; then
    log_info "  Deployed build: ${GIT_DESCRIBE:-unknown} (${GIT_COMMIT:-no commit})"
else
    log_warn "  Could not write $INSTALL_DIR/build-info.json — build will report unknown"
fi

# Create .env if it doesn't already exist (preserve existing config on upgrades)
#
# `umask 077` around the redirect, not a chmod after it: the file is the only copy of
# PRINTER_PASSWORD and TELEGRAM_BOT_TOKEN, and a chmod afterwards leaves a
# window — however short — where it exists world-readable. Create it right instead.
if [[ ! -f "$INSTALL_DIR/.env" ]]; then
    log_info "Creating default .env configuration..."
    (
    umask 077
    cat > "$INSTALL_DIR/.env" << EOF
# Elegoo Web — Service Configuration
# See README.md for all available options

# Printer connection — PRINTER_IP is required and the service refuses to start
# without it, which is deliberate (ELEG-73). A placeholder here rather than a real
# address: this file is committed to a public repo, and a default pointing at some
# address on the installer's own LAN is how ELEG-72 happened.
PRINTER_IP=
PRINTER_PASSWORD=123456

# Service port (web UI + API)
SERVICE_PORT=${SERVICE_PORT}

# Camera (auto-detected from printer IP if not set)
# CAMERA_ENABLED=true
# CAMERA_URL=http://<PRINTER_IP>:8080

# Telegram notifications (optional)
# TELEGRAM_BOT_TOKEN=
# TELEGRAM_CHAT_ID=
# PROGRESS_INTERVAL=25

# Data persistence directory
DATA_DIR=/opt/elegooweb/data
EOF
    )
    log_info "  Edit $INSTALL_DIR/.env to configure your printer IP and options"
else
    log_info "Keeping existing .env configuration"
fi

# Runtime dependencies only. Never a plain `bun install` here: devDependencies in
# $INSTALL_DIR are a larger production surface than the service needs, and the next
# production run has to prune them again (ELEG-19). The frontend is built in the source
# checkout above and arrives via rsync, so nothing in this directory needs a toolchain.
#
# --frozen-lockfile as well as --production: bun.lock was just copied in beside
# package.json, and a deploy that silently re-resolves is a deploy that can install
# something the checkout never tested.
log_info "Installing production dependencies..."
cd "$INSTALL_DIR"
bun install --production --frozen-lockfile

# Set ownership and modes.
#
# The modes are stated, not inherited. `cp` onto an existing file keeps that file's mode,
# so an install directory that was once chmod'ed 777 by hand stayed 777 through every
# later deploy and nothing here ever disagreed (ELEG-20). The service runs the TypeScript
# directly under bun, so a world-writable tree is arbitrary code execution
# as $SERVICE_USER, and a world-readable .env is every secret the service holds.
#
# chmod must come AFTER the chown -R: chown does not clear the bits, but doing it in this
# order means the final state is the one written here regardless of what chown found.
log_info "Setting ownership and permissions..."
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"
chmod 750 "$INSTALL_DIR"
chmod 750 "$INSTALL_DIR/data"
chmod 600 "$INSTALL_DIR/.env"
# The individually-copied files at the install root — package.json, bun.lock, the
# tsconfigs, build-info.json. -maxdepth 1 on purpose: src/, dist/ and public/ carry their
# modes from `rsync -a` and are already correct, and a recursive chmod over node_modules/
# would strip the executable bit from package binaries.
find "$INSTALL_DIR" -maxdepth 1 -type f ! -name .env -exec chmod 640 {} +

# Install systemd service.
#
# ExecStart carries an absolute interpreter path — systemd does not search $PATH — and
# bun's own installer puts it anywhere from /usr/local/bin to ~/.bun/bin. So the unit
# ships with a @BUN@ placeholder and the path resolved above is substituted in here,
# rather than the unit guessing and a mismatch surfacing as a start failure.
log_info "Installing systemd service (bun: $BUN_BIN)..."
sed "s|@BUN@|$BUN_BIN|g" "$SCRIPT_DIR/contrib/${SERVICE_NAME}.service" \
    > /etc/systemd/system/${SERVICE_NAME}.service
chmod 644 /etc/systemd/system/${SERVICE_NAME}.service
systemctl daemon-reload

# Enable and (re)start service
log_info "Enabling and restarting service..."
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

# Check status
sleep 2
if systemctl is-active --quiet "$SERVICE_NAME"; then
    log_info "✓ ${SERVICE_NAME} service is running!"
    log_info "  Web UI:  http://localhost:${SERVICE_PORT}"
    log_info "  Config:  $INSTALL_DIR/.env"
    log_info "  Logs:    journalctl -u $SERVICE_NAME -f"
else
    log_warn "Service may not have started correctly"
    log_info "Check logs with: journalctl -u $SERVICE_NAME -e"
fi

log_info "Installation complete!"
