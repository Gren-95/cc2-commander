# The CC2 protocol, and what it does that you would not expect

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

