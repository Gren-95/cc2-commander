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
| `sharp` | a **direct** dependency at 0.35.x, for the camera snapshot path in `rest-api.ts`. The floor predates the transformers removal, which is when the second, older copy of `sharp` it pulled in alongside disappeared. Re-check whether this line is still needed. |

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
(`sharp`, `esbuild`) plus `@biomejs/biome` and `simple-git-hooks`. Adding a name here lets that package execute arbitrary code at
install time — do not add one without a reason.

## Advisories are reported, never gated

`bun audit` is deliberately **not** in `scripts/gates.sh`. See the header of
`.github/workflows/audit.yml` and `docs/gates.md` for the argument: the gate set is
otherwise deterministic and offline, and a gate that can go red because a third party
published something destroys "a red check on your branch is yours".

## What was removed, and why it is worth knowing

- **`dotenv`** — `config.ts` opened with `import 'dotenv/config'`, which had been a no-op
  since the Bun conversion: Bun loads `.env`, `.env.local` and `.env.<NODE_ENV>` before
  any user code runs. Both deployment paths were already covered without it — a dev
  checkout by Bun itself, a container by the `environment:` block compose passes in.
  The shape to recognise: **a dependency that a
  runtime change made redundant stays in `package.json` looking load-bearing**, because
  nothing fails when it is present.
- **`concurrently`** — ran vite and the service side by side. `bun run dev` is one
  process now, so it went with Vite.

## The 513 MB nobody chose, and why making it optional was not enough

`@huggingface/transformers` pulled `onnxruntime-node`, which ships prebuilt binaries for
every platform and accelerator it supports. Measured on this checkout before removal:

| | |
| --- | --- |
| `libonnxruntime_providers_cuda.so` | **302 MB** — needs an NVIDIA GPU and CUDA |
| `bin/napi-v6/win32` + `darwin` | **159 MB** — platforms this never runs on |
| `linux/x64/libonnxruntime.so.1` | 34 MB — the part that actually executes |

~90% of it could not run here: the host is Intel Iris Xe with no `nvidia-smi` and no
`libcuda`. It was **also in every container image**, because the Dockerfile's
`bun install --frozen-lockfile --production` installs the same tree.

The first fix was to make it opt-in — a dynamic import through a variable specifier, a
`bun run ai:install` script, and a startup probe that warned when it was missing. That
took a clean install from 1.2 GB to 404 MB and was the right call at the time.

**It is now removed outright**, along with the `LocalAnalyzer`, the nine CLIP label
strings, the label-config file and its `/api/config/ai-labels` endpoint, and the
classification chart. The lesson worth keeping is the one the opt-in step postponed:
*making an expensive thing optional is not the same as deciding whether it earns its
keep.* Once someone asked what it actually bought — zero-shot classification of a dim
enclosure webcam against hand-tuned sentences, on a printer that does its own failure
detection — the answer was "not much", and the cheaper of the two remaining paths
(`sharp` frame-diffing, which catches the stall a still image cannot show) was the one
worth keeping.

`sharp` stays regardless — `rest-api.ts` imports it directly for the camera snapshot
path, so it is a real dependency rather than something transformers dragged in.

## The exact pins, and why `three` is eight versions behind

Two entries in `package.json` carry an exact version rather than a range, and they are
not oversights:

| pinned | at | why |
| --- | --- | --- |
| `three` | `0.178.0` | `gcode-preview@3.0.0-alpha.4` depends on `three` at **exactly** `0.178.0`, not a range. |
| `@types/three` | `0.178.1` | Follows `three`. Types ahead of the runtime describe a library that is not installed. |

Raising `three` does not upgrade anything. It installs a **second** copy, nested under
`node_modules/gcode-preview/`, because that exact dependency can no longer be satisfied
by the hoisted one. Two copies of three.js in one page means two sets of classes: an
`Object3D` built by the library fails an `instanceof Object3D` check against ours, and
the scene objects stop interoperating. `src/ui/gcode-preview.ts` imports `three`
directly and hands objects to and from the library, so it is exactly the boundary that
breaks.

Nothing catches this. It type-checks, it builds, and the preview fails at runtime.

So `bun outdated` will keep reporting `three` as many versions behind, and that is the
expected state. Verify with:

```bash
bun why three
```

One version heading with both requirers under it is the healthy state:

```text
three@0.178.0
  ├─ cc2-commander (requires 0.178.0)
  └─ gcode-preview@3.0.0-alpha.4 (requires 0.178.0)
```

Two version headings means the split above has happened. `bun pm ls | grep three` is not
the check: `@types/three` matches it too, so it reports two lines when all is well.

**Delete both pins when `gcode-preview` widens its own dependency**, and not before.
`three` and `@types/three` move together, to whatever version `gcode-preview` then
allows.

## Deliberately not taken

`pdfkit` sits at `^0.19.1` with `0.20.2` available. On a `0.x` package a minor bump is
where breaking changes live, it is used only by `src/server/print-report-pdf.ts`, and
there is no advisory forcing the issue. Verifying it means generating a report from a
finished print and looking at the PDF, so it waits for a print rather than riding along
with a routine update.
