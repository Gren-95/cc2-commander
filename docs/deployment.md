# Deployment — and why `MERGED` is not `IN_PRODUCTION`

**This fork deploys as a container.** A merged commit changes nothing that is running
until an image is built, pushed and pulled. That gap is the whole reason this page
exists.

## What is actually running

| | |
| --- | --- |
| image | `ghcr.io/gren-95/cc2-commander:latest` (or a pinned `x.y.z`) |
| built by | `.github/workflows/publish.yml`, on a push to `main` or a `v*` tag |
| exec | `bun src/server/index.ts` — the **TypeScript is run directly**, so there is no compiled backend artefact to go stale |
| config | the compose file's `environment:` block, not a `.env` in your checkout |
| state | whatever is mounted at `/app/data` (`DATA_DIR`) |
| ports | `SERVICE_PORT` 8088 (web + API + `/ws`), `MOONRAKER_PORT` 7125 |
| stamp | `build-info.json`, written into the image as its last layer from `BUILD_*` args |

**The running container is not a git checkout**, which is why the stamp exists at all:
there is no git metadata inside the image to ask. `src/server/build-info.ts` reads that
file back and `/api/health` serves it, so "is my change live?" is one HTTP request
rather than a guess.

An unstamped image reports `unknown` rather than lying. That is what a local
`docker build` produces — the `BUILD_*` args come from the publish workflow — and it is
honest, but it means a locally built image cannot answer the version question.

## What used to be here

A systemd installer: `contrib/install.sh` deployed an rsync copy to `/opt/elegooweb` and
ran it under `elegooweb.service`. It is gone, along with `contrib/` itself, because this
fork ships a container and the systemd path was never used here. `git log` has it.

Consequences worth knowing if you read older commits or ELEG issues: `/opt/elegooweb`,
`rsync --delete`, `sudo bun run service:install` and file-mode rules (ELEG-19, ELEG-20)
all describe a mechanism that no longer exists. Two of their lessons generalise and are
worth keeping in mind anywhere: **`cp` onto an existing file keeps that file's mode**,
so a copy never fixes permissions; and **a successful copy is not a successful deploy**,
which is the rule the verification below is built on.

## Exposure is decided outside this repo

The service binds `0.0.0.0` by default and has **no authentication until one is
configured** (see [security.md](security.md)), so what limits who can reach it is entirely the network
around it: a reverse-proxy vhost and DNS, both configured in the **`~/ansible` (ANS)**
repo rather than here. A change to *who can reach it* is therefore an ANS issue, and the
specifics for a given deployment belong in the **ELEG tracker**, deliberately not in this
public repository.

`BIND_ADDRESS` makes the interface both `SERVICE_PORT` and `MOONRAKER_PORT` listen on
configurable, but the default is still `0.0.0.0`, so **setting nothing changes nothing**.
It is the knob, not the decision. In the container, narrow the published port in
`docker-compose.yml` rather than setting it — see [configuration.md](configuration.md).

Two consequences for anyone testing this:

- **A request from the host itself proves nothing about reachability.** `curl` and any
  local fetch tool resolve and route from inside the network, so a `200` says only that
  the service is up — not that anyone else can get to it. Answering "is this exposed?"
  needs a resolver check (what does public DNS return — a routable address or an RFC1918
  one?) and, for reachability, a client genuinely off the network.
- **The proxy is not the only door.** Because the bind defaults to `0.0.0.0`, ports 8088
  and 7125 are directly reachable from anything routed to the host, bypassing whatever
  vhost or auth the proxy might add — unless the published ports have been narrowed.

Read [security.md](security.md) before adding an endpoint: what protects this service is
network position, not code.

## Operator commands

An agent may read (`ps`, `logs`, `curl`), and — by a standing instruction recorded in
[`CLAUDE.md`](../CLAUDE.md) — rebuilds and recreates the one production container after
each committed change (`docker compose up -d --build cc2-commander`, then verifies). It
does not pull images, run `down` or `restart`, or touch any other service. The commands
below are the ones worth pasting into an `OPERATOR:` issue.

```bash
# what is running, and since when
docker compose ps
docker compose logs -n 100                 # startup banner: build, printer, ports, Telegram

# deploy: pull the new image and recreate
docker compose pull && docker compose up -d

# roll back to a known-good tag — edit `image:` to a pinned x.y.z, then
docker compose up -d
```

**Verify at the receiver, not at the exit code** — a successful `pull` proves nothing:

```bash
curl -s localhost:8088/api/health | jq .   # {"ok":true,"mqtt":"connected","mqttPhase":…,"build":{…}}
docker compose ps                          # did it actually recreate, and is it healthy?
```

Two fields carry the whole check:

- **`build.commit`** answers "is my change live?". Compare it against the commit the
  image was built from. Equal means the pull landed; anything else means it did not,
  whatever the pull said. All nulls means the image was built locally, without the
  publish workflow's stamp.
- **`mqtt":"connected"`** is the one that matters for whether it *works*: the process can
  start happily and fail to reach the printer, and the web UI then looks fine and shows
  nothing.

  **If it is not `connected`, read `mqttPhase` before blaming the deploy** (ELEG-59). The
  coarse field collapses two unrelated failures into `broker_only`, and the instinct
  after a deploy is to roll back — which on 2026-08-08 was the wrong move, because the
  service was fine and the printer's firmware had hung:

  | `mqttPhase` | What it means | Who fixes it |
  | --- | --- | --- |
  | `awaiting_sn` | The broker answered but the printer has never published. Registration was **never attempted**, so `mqttRegisterAttempts` is 0. The machine's Linux side is up; its control application is not. | Power-cycle the **printer**. Not a deploy problem. |
  | `registering` | An SN is known and registration is in flight. Watch `mqttRegisterAttempts` climb. | Wait; if it keeps climbing, the printer is not answering. |
  | `rejected` | The printer already has its maximum of two clients. | Close another client — the vendor app, or a second copy of this service. |

  `mqttMessage` carries the same thing as one sentence, which is usually all you need:

  ```bash
  curl -s localhost:8088/api/health | jq -r '.mqttPhase, .mqttRegisterAttempts, .mqttMessage'
  ```

## What this means for the tracker

ELEG has `tracksProduction` **on**, so `IN_PRODUCTION` exists and is meaningful:

- A merged PR moves the issue to `MERGED` and changes **nothing that is running**.
- `IN_PRODUCTION` means the image was published, pulled, and `/api/health` answered from
  the new code. That is operator work — file it as its own `OPERATOR:` issue rather than
  leaving a code issue open across a manual step, give the exact commands above, and ask
  for the output. **The evidence is `build.commit` from `/api/health` matching the commit
  the image was built from**, not a successful `docker compose pull` — set the status
  from that output rather than from the pull having exited 0.
- The status automation never moves an issue backwards out of `MERGED` /
  `IN_PRODUCTION`, so setting `IN_PRODUCTION` optimistically is not correctable later.
  Set it after the verification, from the output you were given.
