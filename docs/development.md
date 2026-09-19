# Development

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

Only `dist/` and `node_modules/` appear in the checkout, as empty 4KB mount points —
Bun resolves one and the server serves the other from `/app`, so those two cannot live
anywhere else. Everything else the container generates (`data`, the Playwright output,
screenshots) is mounted OUTSIDE `/app`, because a volume mounted inside the bind-mounted
project needs a host directory to mount onto, and that directory reappears however often
you delete it.

**Do not delete the two mount points while the container is running.** Removing the
directory a volume is mounted on detaches the mount: the container then sees an empty
`node_modules`, and anything it writes goes through to the host. `docker compose
--profile dev up -d --force-recreate` puts it right.

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

## The README pictures

`docs/images/` holds each README picture twice, `<name>-light.png` and `<name>-dark.png`,
and the README picks between them with `prefers-color-scheme`. Regenerate the lot with:

```bash
bun run screenshots --readme            # needs AUTH_PASSWORD (or --password) if auth is on
```

It photographs a **running service with a real printer behind it** — an empty dashboard
is all `--` — so point it at production (`--url`) or a dev service, never at a second
service beside production: that would be a second MQTT connection. It only loads pages;
it presses nothing, and it stops with an error rather than shoot the dryer if a drying
session is running.

Look at every picture before committing: the script checks that each one really rendered
in the theme it was asked for, but it cannot tell whether the printer was mid-print, or
whether a sensor name from Home Assistant is now in a public README.
