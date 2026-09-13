# Dependencies

Why the `overrides` block in `package.json` looks the way it does, and what may and may
not be changed in it. Not auto-loaded — open it when touching dependencies or when
`bun audit` reports something.

## Where this used to live

In `pnpm-workspace.yaml`, with the reasons as comments beside each line. Bun reads
`overrides` from `package.json`, which is JSON and cannot carry a comment — so the
reasons moved here. **A floor without a recorded reason is a floor nobody can ever
date or delete**, which is the failure this file exists to prevent.

## The floors

Every entry in `overrides` is a **floor** raising a transitive dependency to its patched
version (ELEG-63) — not a compatibility shim, and not a pin.

A floor rather than a lockfile bump on purpose: `bun update` moves the lockfile and the
next resolution can quietly move it back, whereas an override is re-asserted on every
install.

| override | why |
| --- | --- |
| `undici` | advisory floor; reached through several parents |
| `hono`, `@hono/node-server`, `qs`, `body-parser`, `fast-uri`, `ip-address` | all reached through `@modelcontextprotocol/sdk` → express/ajv. The SDK's own declared ranges already permit these versions; only the lockfile was stale. |
| `adm-zip`, `protobufjs` | `@huggingface/transformers` → `onnxruntime-{node,web}`. These two **do** cross their parent's declared range (onnxruntime-node wants `adm-zip ^0.5.16`), so they are the only entries upstream has not itself blessed. Reached solely through the dynamic import in `src/server/ai-monitor.ts`, i.e. only when `AI_PROVIDER` selects the local CLIP path — which no test covers. Verified by importing the package. |
| `sharp` | also a **direct** dependency here at 0.35.x, and that copy was never affected; the advisory is against the second, older copy transformers pulled in beside it. The floor collapses the two into one, which also halves the native binary payload. |

When a direct dependency's own range catches up, **delete the line** rather than leaving
a floor nobody can date. Check with `bun why <pkg>`.

### One that was deleted

`esbuild: '>=0.28.1'` is gone. It was there because `tsx` depended on esbuild and `tsx`
was a *runtime* dependency — production ran the TypeScript under `node --import tsx`, so
it was not a build-only advisory. Bun executes the TypeScript itself, `tsx` was removed
with it, and Vite 8 bundles with Rolldown rather than esbuild. `bun why esbuild` now
reports the package is not in the lockfile at all.

## Post-install scripts

`trustedDependencies` is Bun's equivalent of pnpm's `onlyBuiltDependencies`: the
allowlist of packages permitted to run install scripts. It holds the native builds
(`sharp`, `onnxruntime-node`, `protobufjs`) plus `@biomejs/biome` and
`simple-git-hooks`. Adding a name here lets that package execute arbitrary code at
install time — do not add one without a reason.

## Advisories are reported, never gated

`bun audit` is deliberately **not** in `scripts/gates.sh`. See the header of
`.github/workflows/audit.yml` and `.agents/gates.md` for the argument: the gate set is
otherwise deterministic and offline, and a gate that can go red because a third party
published something destroys "a red check on your branch is yours".

## What was removed, and why it is worth knowing

- **`dotenv`** — `config.ts` opened with `import 'dotenv/config'`, which had been a no-op
  since the Bun conversion: Bun loads `.env`, `.env.local` and `.env.<NODE_ENV>` before
  any user code runs. All three deployment paths were already covered without it — dev
  and Docker by Bun itself, production by systemd's
  `EnvironmentFile=/opt/elegooweb/.env`. The shape to recognise: **a dependency that a
  runtime change made redundant stays in `package.json` looking load-bearing**, because
  nothing fails when it is present.
- **`concurrently`** — ran vite and the service side by side. `bun run dev` is one
  process now, so it went with Vite.

## The 513 MB nobody chose

`@huggingface/transformers` pulls `onnxruntime-node`, which ships prebuilt binaries for
every platform and accelerator it supports. Measured on this checkout:

| | |
| --- | --- |
| `libonnxruntime_providers_cuda.so` | **302 MB** — needs an NVIDIA GPU and CUDA |
| `bin/napi-v6/win32` + `darwin` | **159 MB** — platforms this never runs on |
| `linux/x64/libonnxruntime.so.1` | 34 MB — the part that actually executes |

So ~90% of it cannot run here: the host is Intel Iris Xe with no `nvidia-smi` and no
`libcuda`. It is **also in every container image**, because the Dockerfile's
`bun install --frozen-lockfile --production` installs the same tree.

**Resolved: the package is no longer a dependency.** `bun run ai:install` adds it when
someone wants local analysis, and a clean install is **404 MB instead of 1.2 GB**.

Two things make that safe, and both are easy to get wrong:

1. **The import specifier goes through a variable.** Written inline,
   `await import('@huggingface/transformers')` is resolved by `tsc` at compile time and
   fails the typecheck on any checkout that has not installed it — measured, TS2307. The
   slice of the API this repo uses is declared locally as `TransformersModule` instead.
2. **The absence is reported at startup, not on first use.** `initialize()` is lazy, so
   without a probe in `start()` an operator who set `AI_LOCAL_ENABLED=true` would see
   `Local: <model>` in the log, conclude it was working, and find out only when a camera
   frame arrived — which on an offline printer is never. It now warns once, names the
   command, and does not repeat per frame.

`sharp` stays either way — `rest-api.ts` imports it directly for the camera snapshot
path, so it is a real dependency rather than something transformers dragged in.
