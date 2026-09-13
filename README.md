# CC2 Commander

A self-hosted web dashboard for **Elegoo Centauri Carbon 2 (CC2)** FDM printers. The Bun service maintains a single MQTT connection to the printer and exposes state to browsers via WebSocket, REST API, and Prometheus metrics.

## Features

- **Two-panel dashboard**: Resizable sidebar + main grid, collapsible/reorderable cards, responsive breakpoints
- **Print status**: Progress with thumbnail, temperatures, fan speeds, toolhead position, active filament
- **3D gcode preview**: Three.js toolpath visualization with layer follow mode and nozzle tracking
- **Live charts**: Temperature, fan speed, print speed, AI confidence, and layer time graphs with zoom/pan
- **Canvas/AMS display**: Spool-style filament slots with colors, types, filament editing, load/unload
- **Camera feed**: Live MJPEG stream with single-upstream fan-out proxy, snapshot button, fullscreen overlay
- **Printer control**: Temperature presets, fans, speed mode, LED toggle, XY/Z movement, emergency stop
- **Print management**: File browser with thumbnails/popovers, start dialog, pause/resume/stop, USB support
- **Zone detection**: Server-side toolhead zone tracking (print area, cutter, purge) for AI/event suppression
- **Telegram notifications**: Print events, progress updates, camera snapshots, AI alerts
- **MQTT Log**: Real-time structured log with diff view, method filtering, pinning
- **Debug panel**: Live state tree with change tracking, watched paths, export
- **Event log**: Print events, errors, milestones with timestamps and severity
- **Print history**: Method 1036 history with auto-load on connect
- **Print reports**: PDF generation with stats, charts, snapshots
- **Timelapse viewer**: Download/play timelapse videos
- **Spool calculator**: Remaining weight/meters from measured thickness
- **Moonraker/OctoPrint compatibility**: API layers for Mainsail/Fluidd/KlipperScreen and OctoPrint clients
- **Prometheus metrics**: `/api/metrics/prometheus` endpoint for monitoring
- **PWA support**: Installable app with manifest + service worker
- **Dark theme**: Modern UI with CSS custom properties, responsive at 1200/800/480px breakpoints

## How It Works

The backend service (`src/server/`) runs on Bun and connects to the printer's MQTT broker over TCP:1883, acting as a bridge:
- **WebSocket** (`/ws`): Real-time state updates pushed to all connected browsers
- **REST API** (`/api/*`): Snapshots, file operations, camera proxy, commands
- **Static files**: Serves the built `dist/` frontend in production (SPA fallback to `index.html`)
- **Prometheus** (`/api/metrics`): Printer telemetry for monitoring

The CC2 printer runs its own MQTT broker on two ports:
- **Port 1883** — MQTT over TCP (used by the service)
- **Port 9001** — MQTT over WebSocket (legacy direct-connect mode)

### Protocol

Communication uses the CC2 MQTT protocol:
1. **Discovery**: UDP broadcast on port 52700 (not available from browser — IP entered manually)
2. **Connect**: MQTT 3.1.1 over WebSocket, auth `elegoo`/`123456` (or access code)
3. **Register**: Publish to `elegoo/<sn>/api_register`
4. **Subscribe**: `elegoo/<sn>/api_status` for delta status updates
5. **Commands**: Publish to `elegoo/<sn>/<client_id>/api_request`
6. **Heartbeat**: PING every 10 seconds to maintain connection

See [CC2 Protocol Documentation](https://github.com/danielcherubini/elegoo-homeassistant/blob/main/docs/CC2_PROTOCOL.md) for the full protocol reference.

## Docker

### Quick Start (docker run)

```bash
docker run -d \
  --name cc2-commander \
  --restart unless-stopped \
  -p 8088:8088 \
  -p 7125:7125 \
  -e PRINTER_IP=192.168.1.150 \
  -v elegoo-data:/app/data \
  ghcr.io/gren-95/cc2-commander:latest
```

Web UI: `http://localhost:8088` · Moonraker API: `http://localhost:7125`

To keep the data on a host path you can browse, instead of a named volume:

```bash
mkdir -p ./elegoo-data
docker run -d \
  --name cc2-commander \
  --restart unless-stopped \
  -p 8088:8088 \
  -p 7125:7125 \
  -e PRINTER_IP=192.168.1.150 \
  -v ./elegoo-data:/app/data \
  ghcr.io/gren-95/cc2-commander:latest
```

Everything then appears under `./elegoo-data` — `reports/`, `gcode-cache/`, `logs/`,
`state.json`, `moonraker-db.json`.

> **Mount the directory, not the individual files.** A bind mount whose source does not
> exist yet is created by Docker as a **directory**, so `-v ./elegoo-data/state.json:
> /app/data/state.json` gives the service a directory where it expects a file. It does
> not crash — the container stays `Up` and the UI works — it just logs
> `EISDIR: illegal operation on a directory` and silently never persists anything.

### Docker Compose

**No checkout? Use this.** It pulls the published image, so there is nothing to build.
Save it as `docker-compose.yml`, set `PRINTER_IP`, then `docker compose up -d`:

> The `docker-compose.yml` in this repository is deliberately different: it **builds**
> from the checkout rather than pulling. If you have the source, building what is in
> front of you is the thing that cannot be stale. Same file otherwise.

```yaml
services:
  cc2-commander:
    image: ghcr.io/gren-95/cc2-commander:latest
    # build: .  # Uncomment to build locally instead of pulling
    container_name: cc2-commander
    restart: unless-stopped
    ports:
      - "8088:8088"   # Web UI + API + WebSocket
      - "7125:7125"   # Moonraker compatibility API
    environment:
      # ── Required ──────────────────────────────────────
      PRINTER_IP: "192.168.1.150"

      # ── Optional: Printer ─────────────────────────────
      # PRINTER_PASSWORD: "123456"       # Access code (default: 123456)
      # SERVICE_PORT: "8088"             # Web UI port (default: 8088)
      # MOONRAKER_PORT: "7125"           # Moonraker compat port (default: 7125)
      # CAMERA_ENABLED: "true"           # Camera proxy (default: true)
      # CAMERA_URL: ""                   # Override (default: http://<PRINTER_IP>:8080)

      # ── Optional: Telegram notifications ──────────────
      # TELEGRAM_BOT_TOKEN: ""
      # TELEGRAM_CHAT_ID: ""
      # PROGRESS_INTERVAL: "25"          # Notify every N% (default: 25)

      # ── Optional: Data persistence ────────────────────
      # DATA_DIR: "./data"               # Data directory (default: ./data)

    volumes:
      # One host path for everything, so the data is easy to get at. A named volume
      # (`elegoo-data:/app/data`, declared under a top-level `volumes:`) works too.
      #
      # Mount the DIRECTORY, never the individual files inside it — see the warning
      # above for what binding `state.json` directly does.
      - ./elegoo-data:/app/data
```

Every variable the service reads is in the [Environment Variables](#environment-variables)
table below; the commented lines above are the ones worth knowing about first.

### Image tags

| Tag | What it is |
|-----|------------|
| `latest` | the newest build of `main` — use this unless you have a reason not to |
| `x.y.z`, `x.y` | a specific release, pinned |

Images are built for **linux/amd64 and linux/arm64**, so a Raspberry Pi next to the
printer works. Each image carries its own build stamp — the version shows in the web UI's
status dropdown, which is the first thing to quote when reporting a problem.

### Build Locally

```bash
docker build -t ghcr.io/gren-95/cc2-commander:local .
docker run -d -p 8088:8088 -p 7125:7125 -e PRINTER_IP=192.168.1.150 ghcr.io/gren-95/cc2-commander:local
```

A locally built image reports its version as `unknown`, which is expected: the stamp is
supplied by the publish workflow, not by `docker build`.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PRINTER_IP` | **required** | Printer IPv4 address. The service refuses to start without it |
| `PRINTER_PASSWORD` | `123456` | Printer access code |
| `PRINTER_SN` | — (discovered) | Printer serial number, e.g. `F01U3UD3798YT8K`. Normally discovered automatically and then cached in `<DATA_DIR>/printer-sn.json`, so this is rarely needed. Set it if a **first** start hangs at "registering": the printer only publishes while a client is registered, so a service that has never learned the serial has nothing to overhear |
| `SERVICE_PORT` | `8088` | Web UI / API / WebSocket port |
| `MOONRAKER_PORT` | `7125` | Moonraker compatibility API port |
| `CAMERA_ENABLED` | `true` | Enable camera MJPEG proxy |
| `CAMERA_URL` | `http://<PRINTER_IP>:8080` | Override camera URL |
| `CORS_ALLOWED_ORIGINS` | — (same-origin) | Comma-separated origins allowed to make cross-origin requests to `/api/*`, `/moonraker/*`, `/octoprint/*` and `:7125`. Unset means **no cross-origin access**. `*` restores the old allow-everything behaviour |
| `AUTH_PASSWORD_HASH` | — | Password hash for the dashboard login. Generate with `bun run auth:secret`. **With no password set, every endpoint answers without credentials** |
| `AUTH_PASSWORD` | — | Plaintext alternative, hashed at startup. Prefer the hash |
| `AUTH_API_KEY` | — | Shared secret for clients that cannot hold a cookie (Moonraker, OctoPrint, slicers). Sent as `X-Api-Key` or `Authorization: Bearer` |
| `AUTH_SESSION_HOURS` | `720` | Absolute session lifetime |
| `AUTH_IDLE_HOURS` | `168` | How long a session survives unused |
| `AUTH_ENABLED` | — | `false` keeps auth off even with a password set |
| `AUTH_PASSWORD` | — | Plaintext password, hashed at startup and never stored. Use when you would rather not paste a hash; a hash wins if both are set |
| `AUTH_SECRET` | — | Signs session tokens so a restart does not sign every browser out. Rotating it signs out everywhere |
| `TELEGRAM_BOT_TOKEN` | — | Telegram bot token (enables notifications) |
| `TELEGRAM_CHAT_ID` | — | Telegram chat ID — where notifications are **sent** |
| `TELEGRAM_ALLOWED_CHAT_IDS` | `TELEGRAM_CHAT_ID` | Comma-separated numeric sender ids permitted to **issue** bot commands. Anyone else is ignored silently |
| `PROGRESS_INTERVAL` | `25` | Notify every N% progress |
| `DATA_DIR` | `./data` | Data directory for state, reports, logs |
| `HOMEASSISTANT_URL` | — | Home Assistant base URL, e.g. `http://homeassistant.local:8123` |
| `HOMEASSISTANT_TOKEN` | — | Long-lived access token. **Read-only use** — this service issues nothing but `GET /api/states/…` |
| `HOMEASSISTANT_ENTITIES` | — | Comma-separated entity ids, e.g. `sensor.dry_box_humidity,sensor.workshop_temperature` |

### Passwords, and staying logged in

Two ways to set the password, and you only need one:

```bash
bun run auth:secret          # prints AUTH_PASSWORD_HASH, AUTH_API_KEY and AUTH_SECRET
```

```ini
AUTH_PASSWORD_HASH=scrypt\$65536\$8\$1\$…   # every $ BACKSLASH-ESCAPED — see below
# — or, if you would rather not handle a hash —
AUTH_PASSWORD=your-password                  # hashed at startup, never stored
```

**In a container, prefer `AUTH_PASSWORD`.** An scrypt hash contains `$`, and the two
things that read `.env` disagree about it:

| reads `.env` | `scrypt\$65536\$…` becomes | so a hash must be |
| --- | --- | --- |
| **Bun** (bare metal, `bun run dev`) | `scrypt$65536$…` — unescaped | escaped |
| **Docker** (`env_file:` in compose) | `scrypt\$65536\$…` — literal | **not** escaped |

One file cannot satisfy both. An unescaped hash read by Bun collapses to the bare word
`scrypt`; an escaped one read by Docker keeps its backslashes. Either way every login
answers 401 and nothing says why — which looks exactly like a forgotten password.

A password has no `$`, so `AUTH_PASSWORD` survives both parsers unchanged. It is hashed
at startup and never stored. Use the hash when the service reads `.env` directly rather
than through Docker, and paste the line `auth:secret` prints as-is.

The service checks the hash shape at startup and logs an error naming whichever direction
it went wrong.

`AUTH_SECRET` signs session tokens so they are still valid after a restart — without it,
every deploy signs every browser out. Rotating the secret is how you sign out everywhere;
it invalidates every outstanding token at once.

### Home Assistant (ambient temperature and humidity)

The printer reports its own nozzle, bed and chamber. It cannot tell you the **humidity of
the room the filament is sitting in** — which decides whether a spool prints cleanly or
strings, and is the only way to know whether a drying session achieved anything.

Set all three `HOMEASSISTANT_*` variables and the readings appear in the Temperatures
card. Humidity is tinted: green below 40%, amber to 60%, red above — coarse advisory
bands, since this is someone else's sensor and not a control input.

Make the token under your Home Assistant profile → Security → **Long-lived access
tokens**. It carries the permissions of the account that made it, so prefer an account
with little access: this service only ever issues `GET /api/states/<entity>` and never
writes, but the token itself does not know that. It is read from the environment, never
logged, and never sent to the browser — `/api/home-assistant` returns readings only.

Entities are polled once a minute. Home Assistant being down, or a renamed entity, shows
as "Home Assistant unreachable" on that row and changes nothing else: a thermometer on
another machine is not a reason for a printer dashboard to stop working.

### Volumes

All persistent data lives under `/app/data` inside the container:

| Path | Contents |
|------|----------|
| `/app/data/state.json` | Persisted printer state (survives restarts) |
| `/app/data/moonraker-db.json` | Moonraker compatibility database |
| `/app/data/reports/` | Print reports with snapshots and PDFs |
| `/app/data/gcode-cache/` | Downloaded gcode files for 3D preview |
| `/app/data/logs/` | MQTT capture logs (from debug panel) |

### Ports

| Port | Protocol | Purpose |
|------|----------|---------|
| 8088 | HTTP/WS | Web UI, REST API, WebSocket, camera proxy |
| 7125 | HTTP/WS | Moonraker compatibility API (for Mainsail/Fluidd/KlipperScreen) |

## Authentication

The service ships with **no authentication**: every endpoint — including printer control
and the camera — answers any request that reaches the port. That is fine on a trusted LAN
and not fine anywhere else, so if the port is reachable from outside, set a password:

```bash
bun run auth:secret        # prompts for a password, prints both values
# paste AUTH_PASSWORD_HASH and AUTH_API_KEY into .env, then restart
```

Two credentials, because there are two kinds of client:

| | credential | used by |
| --- | --- | --- |
| Browser | session cookie from the login form | the dashboard |
| Machine | `AUTH_API_KEY` in a header | Moonraker (Mainsail, Fluidd), OctoPrint (slicers) |

A slicer cannot log in and hold a cookie, and a browser should not carry a bearer token in
JavaScript, so each gets the mechanism native to it. Machine clients send either header:

```
X-Api-Key: <AUTH_API_KEY>
Authorization: Bearer <AUTH_API_KEY>
```

**Configuring a password changes what existing clients need.** Mainsail, Fluidd,
OrcaSlicer and anything talking to `:7125` or `/octoprint` will get `401` until the key is
set in their config. That is the point, but it is worth doing deliberately rather than
discovering mid-print.

What stays reachable without credentials: the static app shell, the login routes, and
`/api/health` — which reports liveness but withholds the printer serial and the build
commit until the caller is known.

Sessions live in memory only, so a restart signs you out. That is deliberate: a session
token on disk is a credential at rest in the same `DATA_DIR` this service serves reports
and camera stills from.

## Prerequisites

- [Bun](https://bun.sh) 1.2.3 or newer — `curl -fsSL https://bun.sh/install | bash`
- An Elegoo CC2 printer on the same network, set to **LAN-only mode**

Bun is the package manager, the TypeScript runtime and the HTTP server. There is no
Node.js, no pnpm and no transpile step; `src/server/` runs as-is.

## Quick Start

```bash
bun install
bun run dev
```

This builds the frontend, starts the service, and rebuilds on change. Open
`http://localhost:8088` — one port, the same shape as production.

The dev server answers to `localhost` only. To reach it by another name — a machine
hostname, a LAN address, a tunnel — list them in `.env` (which is gitignored), so that
no environment-specific hostname is committed:

```bash
```

This is a **dev-server** setting: `vite build` ignores it, and production never runs vite.

### Develop in a container (nothing generated on your machine)

`bun install` puts 552 MB in `node_modules/`, and `bunx playwright install` puts **1.3 GB**
in `~/.cache/ms-playwright` — outside the project entirely. Add `dist/`, the runtime
`data/` and the test output and a checkout costs about 1.9 GB of host disk.

The `dev` service in `docker-compose.yml` keeps all of it in Docker volumes instead. Only the source stays
on the host, bind-mounted, so an editor edits real files and git behaves normally:

```bash
docker compose --profile dev up -d --build     # first run pulls a browser
docker compose exec dev bun run gates
docker compose logs -f dev
```

The service comes up on `http://localhost:8088` exactly as `bun run dev` does, rebuilding
and restarting on change. Every generated directory is a named volume mounted **on top of**
the bind mount — `node_modules`, `dist`, `data`, `test-results`, `playwright-report`, and
the browsers at `/ms-playwright` — so the container has its own and the host directory is
never written to.

**The catch, and it is a real one:** with `node_modules` only inside the container, your
editor's TypeScript server has no types — no autocomplete, no go-to-definition, every
import underlined. The fix is to run the editor in the container too (VS Code Dev
Containers, JetBrains remote). There is no arrangement that gives you both an empty host
and a host language server.

Two things worth knowing:

- **`UID`/`GID`.** The container runs as your user so it cannot leave root-owned files in
  the bind mount, and the volumes are seeded from directories the image creates as uid
  1000. If `id -u` gives something else, pass it (`UID=$(id -u) GID=$(id -g) docker
  compose …`) and recreate the volumes with `down -v` — seeding happens once, on an empty
  volume.
- **Reclaiming the host copies.** Nothing deletes them for you. Once the container works,
  `node_modules/`, `dist/`, `test-results/` and `~/.cache/ms-playwright` can go. Look at
  `data/` before removing it — it holds the gcode cache and any drying session, and the
  container's `data` volume starts empty.

## Build

```bash
bun run build
```

Production output goes to `dist/`. The service serves it on port 8088 from Bun's static
route table, which is built once at startup — so a rebuild needs a service restart to
be picked up.

## Production Deployment

Run the published image. `docker compose up -d` with the file from
[Docker Compose](#docker-compose) above is the whole deployment:

```bash
docker compose pull && docker compose up -d    # upgrade to the latest image
docker compose logs -f                         # tail logs
docker compose restart                         # after editing the compose file
docker compose down                            # stop and remove
```

Web UI: `http://<host>:8088`. Config lives in the compose file's `environment:` block,
and the data you care about is under whatever you mounted at `/app/data`.

**A merged commit is not a deployed one.** The image is built and pushed by the publish
workflow on a tag or a push to `main`; until you pull it, the container keeps running the
build it started with. The version in the web UI's status dropdown is the authoritative
answer to "which build is this?" — it comes from a stamp baked into the image, so it
cannot drift from what is actually running.

There is no systemd installer any more. `contrib/` held one — `install.sh`,
`uninstall.sh` and an `elegooweb.service` unit that deployed to `/opt/elegooweb` — and it
was removed because this fork deploys as a container and nobody ran it. `git log` has it
if a no-Docker install is ever wanted again.

## Project Structure

```
src/
├── main.ts              # Entry point, WsClient, render loop, sidebar resize
├── ws-client.ts         # WebSocket client (connects to service, not printer)
├── types.ts             # CC2 protocol types, status codes, zone detection
├── printer-state.ts     # Browser-side state with delta merge + zones
├── log-store.ts         # Ring buffer (500 entries) for MQTT log
├── chart-store.ts       # Ring-buffer time-series store for charts
├── server/
│   ├── index.ts             # Service entry point
│   ├── mqtt-bridge.ts       # Singleton MQTT connection to printer
│   ├── state-store.ts       # Centralized state, event detection, zone tracking
│   ├── ws-transport.ts      # WebSocket server for browsers
│   ├── rest-api.ts          # REST API, MJPEG fan-out proxy, Prometheus
│   ├── config.ts            # Environment-based configuration (.env)
│   ├── logger.ts            # Winston structured logging with rotation
│   ├── telegram.ts          # Telegram bot notifications
│   ├── allowlist.ts         # Who may talk to the Telegram bot
│   ├── moonraker-compat.ts  # Moonraker API compatibility
│   ├── moonraker-server.ts  # Moonraker standalone server (:7125)
│   ├── octoprint-compat.ts  # OctoPrint API compatibility
│   ├── state-persistence.ts # Persist/restore state across restarts
│   ├── print-report-collector.ts  # Collect print data for reports
│   └── print-report-pdf.ts       # PDF report generation
├── ui/
│   ├── dashboard.ts       # Re-export barrel for all UI modules
│   ├── helpers.ts         # Shared DOM/formatting utilities
│   ├── print-status.ts    # Print status sidebar card
│   ├── service-status.ts  # Header badge + dropdown (service health + system info)
│   ├── canvas.ts          # Canvas/AMS spool visualization
│   ├── files.ts           # File browser with popovers
│   ├── controls.ts        # Control event handlers
│   ├── charts.ts          # Canvas 2D live charts with zoom/pan
│   ├── gcode-preview.ts   # 3D gcode toolpath (Three.js)
│   ├── log.ts             # MQTT log panel
│   ├── log-methods.ts     # MQTT method ID labels and filtering
│   ├── structured-log.ts  # Structured log with diff/pin/filter
│   ├── system-info.ts     # System information display component
│   ├── debug-panel.ts     # Live state tree, change tracking, export
│   ├── settings.ts        # Card layout + tab management
│   ├── event-log.ts       # Print event log
│   ├── print-history.ts   # Print history
│   ├── print-reports.ts   # PDF print reports
│   ├── print-dialog.ts    # Print start confirmation dialog
│   ├── maintenance.ts     # Self-check, auto-level, vibration, PID
│   ├── timelapse.ts       # Timelapse viewer
│   ├── layer-chart.ts     # Layer time chart
│   ├── filament-editor.ts # Canvas filament editor
│   ├── spool-calc.ts      # Spool calculator
│   ├── toast.ts           # Toast notifications
│   ├── help.ts            # Help tab / API docs
│   └── ui-settings.ts    # UI preference persistence
└── styles/
    └── main.css           # Dark theme, two-panel layout, responsive
```

## Supported Printers

- Elegoo Centauri Carbon 2
- Other CC2-protocol printers (Elegoo Cura, etc.)

Resin printers (Mars, Saturn) use a different protocol (SDCP over WebSocket) and are not currently supported.

## Limitations

- **Max 2 MQTT connections**: The printer limits concurrent MQTT clients. The service uses one slot.
- **No UDP discovery**: Browsers can't send UDP — printer IP must be configured in `.env`.
- **Camera CORS**: The MJPEG stream on port 8080 is proxied through the service to avoid CORS issues.
- **LAN-only**: Cloud mode is not supported.

## Protocol Quirks

- Method 1045 (thumbnail) requires `file_name` (with underscore), but 1046 (file detail) requires `filename` (no underscore). Using the wrong form returns error 1003.
- `total_layer` is often missing from delta status updates — fetched separately via method 1046.
- Fan speed is PWM 0-255, not percentage. Convert: `pct = Math.round(speed / 255 * 100)`.
- `gcode_move` (not `gcode_move_inf`) — code normalizes the old name at ingest for firmware compat.
- Sub-status 1066 is undocumented but observed during Canvas filament swaps (firmware 01.03.01.89).
- Canvas filament swaps: sub_status mostly stays at 2075 (Printing) with brief flickers to 1045/1066; `zones.current` is the reliable indicator (toolhead moves to cutter/purge areas).
- Sensor-based filament runout (`filament_detected` 1→0) during `machineStatus === 2` always means filament change, never actual runout. Real runouts trigger exception codes 109/1211.

## Zone Detection

Server-side toolhead zone tracking based on `gcode_move.x/y` coordinates:

| Zone | Center | Boundary | Purpose |
|------|--------|----------|---------|
| `cutter_area` | X=254, Y≈3.5 | X:245-265, Y:-5-15 | Filament cutter |
| `purge_area` | X=52.5, Y=264 | X:40-65, Y:257-275 | Purge/poop area |
| `print_area` | — | X:0-256, Y:0-256 | Normal printing |
| `outside` | — | everything else | Fallback |

Used to suppress false filament runout events during Canvas filament changes.

## Credits

- [gcode-preview](https://github.com/remcoder/gcode-preview) — Three.js gcode toolpath visualization
- [elegoo-link](https://github.com/ELEGOO-3D/elegoo-link) — Elegoo's official C++ SDK
- [elegoo-homeassistant](https://github.com/danielcherubini/elegoo-homeassistant) — CC2 protocol documentation
- [Fluidd](https://github.com/fluidd-core/fluidd) — UI design inspiration
- [mqtt.js](https://github.com/mqttjs/MQTT.js) — MQTT client library

## License

MIT
