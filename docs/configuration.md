# Configuration

Everything you can set, and where it goes. Moved out of the README so the front
page stays the size of a front page.

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
| `HOMEASSISTANT_TOKEN` | — | Long-lived access token. Almost entirely read-only — see below for the one write |
| `HOMEASSISTANT_ENTITIES` | — | Comma-separated entity ids, e.g. `sensor.dry_box_humidity,sensor.workshop_temperature` |
| `HOMEASSISTANT_BUZZER_ENTITY` | — | Optional, and independent of the three above: an entity to ring on a critical error or a failed print, e.g. `switch.printer_buzzer`. Needs only `HOMEASSISTANT_URL` and `HOMEASSISTANT_TOKEN`, not `HOMEASSISTANT_ENTITIES` |

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
with little access: reading issues nothing but `GET /api/states/<entity>`, and the one
write this service makes — ringing `HOMEASSISTANT_BUZZER_ENTITY`, below — calls exactly
two generic services against exactly that one entity, never anything named by a reading
or by anything outside this service. The token itself does not enforce any of that, so
the account it comes from is still what actually limits the blast radius of a bug here.
It is read from the environment, never logged, and never sent to the browser —
`/api/home-assistant` returns readings only.

Entities are polled once a minute. Home Assistant being down, or a renamed entity, shows
as "Home Assistant unreachable" on that row and changes nothing else: a thermometer on
another machine is not a reason for a printer dashboard to stop working.

#### Ringing a buzzer on error

Set `HOMEASSISTANT_BUZZER_ENTITY` to a switch, siren, script or any other entity that
answers to Home Assistant's generic `turn_on`/`turn_off` services, and this service
turns it on for ten seconds — not configurable, deliberately, so a failure that leaves
the off command unsent cannot leave a siren running forever — on a failed print or a new
exception this app's own `CRITICAL_EXCEPTIONS` list treats as one. A routine pause, like
a filament-change prompt, does not ring it; that list is the same one the browser's own
audible alert uses, so the two agree on what counts as serious.

Needs only `HOMEASSISTANT_URL` and `HOMEASSISTANT_TOKEN` — not `HOMEASSISTANT_ENTITIES`,
which is for sensors this has nothing to do with. A Home Assistant outage, an unreachable
host or a rejected call is logged and otherwise ignored: it never blocks or fails the
printer's own error handling.

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

