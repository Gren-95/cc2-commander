# Architecture

One MQTT connection to the printer, fanned out to six consumers. Everything else
follows from that.

```
              ┌──────────────── printer (CC2) ────────────────┐
              │  MQTT/TCP :1883   ·   MQTT/WS :9001            │
              │  camera MJPEG :8080  ·  UDP discovery :52700   │
              └───────────────────────┬───────────────────────┘
                                      │
                        src/server/mqtt-bridge.ts   ← the ONLY client
                                      │
                        src/server/state-store.ts   ← merged state + events
                                      │
   ┌──────────┬──────────┬────────────┼─────────────┬──────────────┬──────────┐
   │          │          │            │             │              │          │
 /ws       /api/*                /octoprint/*   /moonraker/*   :7125      Telegram
ws-       rest-api              octoprint-     moonraker-    moonraker-  telegram.ts
transport   .ts      server.ts   compat.ts      compat.ts     server.ts  + telegram/
```

`src/server/index.ts` wires exactly one of each and is the only place that does. Read
it first: it is short and it is the whole composition.

## The two HTTP servers

Both are `Bun.serve`. There is no `http.createServer` and no `ws` package anywhere in
this repo any more.

| Port | Source | Serves |
| --- | --- | --- |
| `SERVICE_PORT` (8088) | `Bun.serve` in `index.ts` | the built `dist/` as static routes, the `/ws` WebSocket, then `/octoprint/*`, `/moonraker/*` and everything else falling through to `rest-api.ts` (`/api/*`, `/webcam/*`, SPA fallback) |
| `MOONRAKER_PORT` (7125) | `Bun.serve` in `moonraker-server.ts` | a **dedicated** Moonraker endpoint on its own port, for clients (Mainsail, Fluidd, KlipperScreen) that expect Moonraker at the root |

So the Moonraker compatibility layer exists **twice**, deliberately: path-prefixed on
8088 and root-level on 7125. A change to Moonraker behaviour usually belongs in
`moonraker-compat.ts` (shared logic) rather than in one of the two entry points.

### Three ways in, and the one you are probably editing

A request to 8088 is answered by exactly one of these, checked in this order:

1. **Bun's static route table** — `src/server/spa.ts` walks `dist/` once at startup and
   hands every file to `Bun.serve({ routes })`. These are answered **without entering
   JavaScript**: no handler runs, no object is allocated, and Bun adds `ETag` and
   `Last-Modified` itself. This is the browser's entire asset burst when someone opens
   the dashboard, and it is why the hand-rolled `serveStatic()` (an `existsSync` +
   `createReadStream` per request, with its own MIME table) was deleted from
   `rest-api.ts`.

   The table is built **once**. A `vite build` while the service is running is not
   picked up until it restarts — which is already how production works, since
   `contrib/install.sh` rsyncs and then restarts the unit.

2. **`/ws`** — upgraded in `fetch()` to Bun's native WebSocket server, handled by
   `ws-transport.ts`. Note it does *not* use `server.publish()` for broadcast; see the
   comment on `broadcast()` for why the per-client backpressure check is load-bearing.

3. **Everything else** — the Node-style routers, through `runNodeHandler()` in
   `src/server/node-compat.ts`.

### Why node-compat.ts exists

`rest-api.ts`, `octoprint-compat.ts`, `moonraker-compat.ts`, `moonraker-server.ts` and
the compat layers are written against `IncomingMessage` /
`ServerResponse`. Rewriting them to the fetch types would be an 11k-line change to
routes that **no test exercises** (see [gates.md](gates.md)), so instead they keep their
signature and one adapter object is allocated per request. The static path — the hot one
— skips it entirely.

`node-compat.ts` is the only piece of the Bun migration with no upstream to trust, so it
is also the only part with real test coverage: `src/server/__tests__/node-compat.test.ts`.
If you touch it, read those tests first; two of them exist because the first version of
the shim was wrong in production while looking correct under the test runner.

Dispatch on 8088 is otherwise **ordered prefix matching in a single handler**, not a
router library. The chain lives in `nodeRouter` in `index.ts` and threads **one** `res`
through every router, which is what lets a branch apply CORS headers and then fall
through to the next one. A new route is an `if (url === …)` branch in `rest-api.ts`, and
order matters: the first match wins, and the SPA fallback is last.

## Where a change belongs

- **Printer protocol** (a new MQTT method, a new field in the status delta) →
  `mqtt-bridge.ts` for transport, `printer-state.ts` / `types.ts` for the shape,
  `state-store.ts` for derived state and events. Nothing above this layer should parse
  raw MQTT payloads.
- **Derived state that more than one consumer needs** (zone detection, layer times,
  filament usage) → `state-store.ts`, *not* in the REST handler or the compat layer that
  happens to need it first. The point of the store is that the WebSocket, the REST API
  server and the Telegram bot all see the same numbers.
- **A new browser-facing read or action** → `rest-api.ts` + the matching card in
  `src/ui/*.ts`. Push state changes over `/ws` (`wsTransport.broadcast`) rather than
  making the browser poll.
- **A new machine-facing capability** → the relevant compat layer **and** `README.md` in the same
  commit.
- **A new notification** → `src/server/telegram.ts`, driven off a `state-store` event,
  never off a poll of the printer.

## State flow, and the two things that surprise people

1. **The printer sends deltas, and the store merges them.** A field absent from a
   status message means *unchanged*, not *cleared* — `printer-state.ts` merges rather
   than replaces. Code that treats a snapshot as complete will read stale-looking
   nulls right after a reconnect.
2. **State outlives the process.** `state-persistence.ts` writes to
   `${DATA_DIR}/state.json` and `persistence.load()` runs **before** the MQTT
   connection opens, so the first thing a browser sees may be restored history rather
   than live data. Layer charts, print history and filament usage all depend on this;
   don't "fix" an empty-looking store by clearing the file.

## Frontend

`index.html` + `src/main.ts` compose hand-written DOM modules from `src/ui/*.ts` — no
framework, no JSX, no component library. Each card is a module that owns its own DOM
subtree and subscribes to `ws-client.ts` updates. Layout state (which cards are
collapsed / reordered) is persisted client-side by `ui-settings.ts`.

There used to be a `persistence.ts` here too, saving chart and layer data to
localStorage. It was superseded when chart history moved server-side and then sat
unreachable for the life of the repo; knip found it and ELEG-65 deleted it, along with
`mqtt-client.ts` — a browser-side MQTT client from before the service existed, replaced
by `ws-client.ts`. Both are worth knowing about only because their names still read as
plausible in older notes.

`gcode-preview.ts` and `canvas.ts` are the heavy ones (Three.js). Gcode is fetched
through the service, which pre-caches a file when a print starts
(`precacheGcode`) — the printer's own HTTP server is slow while printing, and that
cache is why the preview loads at all mid-print.

## Optional subsystems

`config.ts` gates each of these; they are off unless configured, and every code path
above must tolerate them being `null`:

- **Telegram** (`TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`)
- **AI print monitoring** (`ai-monitor.ts`) — motion detection via `sharp`, and
  optionally a remote VLM
  (OpenAI-compatible or Ollama). Emits `analysis`, `alert` and `ai_chart_data`, which
  `index.ts` forwards to the WebSocket, the store and Telegram.
- **Camera** (`CAMERA_ENABLED`) — a single upstream MJPEG connection fanned out to all
  viewers by `rest-api.ts`. Same principle as the MQTT bridge: one connection to the
  device, N consumers. Don't add a second reader.
