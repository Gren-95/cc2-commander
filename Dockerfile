# ── Build stage ────────────────────────────────────────────
# oven/bun, pinned to an exact patch. NOT `oven/bun:1` or `:latest`: this repo has
# already been bitten once by a base image that moved on its own — Dependabot's #10
# bumped node:22-slim to node:25-slim, which was EOL and had dropped the bundled
# corepack, and the image stopped building (ELEG-69). A runtime that executes the
# TypeScript directly is not a place for a floating tag.
#
# Bun replaced Node + pnpm + tsx here in one move: it is the package manager
# (bun install), the TypeScript runtime (no tsx, no transpile step) and the HTTP
# server (Bun.serve in src/server/index.ts). Keep this version and .github/workflows in
# step — they are the two places a Bun version is named.
FROM oven/bun:1.4.2-slim AS build

WORKDIR /app

# bun.lock is required, not optional: --frozen-lockfile is what makes this build
# reproducible, and it has nothing to compare against without it. The `overrides` that
# used to live in pnpm-workspace.yaml are in package.json now — bun reads them from
# there, which is why that file is gone.
COPY package.json bun.lock ./

RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

# ── Production stage ──────────────────────────────────────
FROM oven/bun:1.4.2-slim

LABEL org.opencontainers.image.source=https://github.com/runnane/elegoo-web
LABEL org.opencontainers.image.description="Web frontend and service for the Elegoo Centauri Carbon 2 printer"
LABEL org.opencontainers.image.licenses=MIT

# Fonts, for the camera overlay (ELEG-71).
#
# `/api/stream/overlay` builds an SVG with `font-family="monospace"` and has sharp
# composite it. The slim images ship NO fonts at all — not even a fallback — so
# librsvg has nothing to resolve `monospace` to and every glyph renders as a tofu box.
# It looks fine on metal only because the host happens to have ~2400 fonts installed.
#
# fonts-dejavu-core carries DejaVu Sans Mono and is ~1 MB; fontconfig is what actually
# does the resolving. Both are needed — the font alone is not enough.
RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-dejavu-core fontconfig \
 && rm -rf /var/lib/apt/lists/* \
 && fc-cache -f \
 && fc-match monospace

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Built frontend + source. Bun runs the TypeScript directly at runtime, which is why
# src/ ships rather than a compiled server bundle — same as production on metal.
COPY --from=build /app/dist ./dist
COPY src ./src

# NOTE: no `COPY data/…` here. `data/` is the runtime DATA_DIR (and is gitignored), so
# it does not exist in a clean clone — that COPY was the second reason this image could
# not be built from a fresh checkout. Nothing under it needs seeding: every consumer
# creates what it needs in DATA_DIR on first write.

# The deploy stamp (ELEG-10), the shape the UI renders as x.y.z+aa (ELEG-48). Without it a container reports
# "unknown", which is honest but useless when someone opens an issue — "which build are
# you running?" is the first question, and a public image needs to answer it itself.
#
# Deliberately the LAST layer: these args change on every commit, so anything below them
# would be rebuilt every time. Empty stays null, so an unstamped local `docker build`
# still degrades to "unknown" rather than lying.
ARG BUILD_COMMIT=""
ARG BUILD_DESCRIBE=""
ARG BUILD_VERSION=""
ARG BUILD_TIME=""
RUN bun -e 'const f=v=>v&&v.length?v:null; require("fs").writeFileSync("build-info.json", JSON.stringify({commit:f(process.env.BUILD_COMMIT),shortCommit:f((process.env.BUILD_COMMIT||"").slice(0,7)),describe:f(process.env.BUILD_DESCRIBE),version:f(process.env.BUILD_VERSION),installedAt:f(process.env.BUILD_TIME)},null,2)+"\n")' \
 && cat build-info.json

ENV NODE_ENV=production
# SERVICE_PORT, not PORT: that is the name src/server/config.ts actually reads. The
# old `ENV PORT=8088` set a variable nothing looked at, and only matched by luck
# because 8088 is also the default.
ENV SERVICE_PORT=8088
EXPOSE 8088 7125

CMD ["bun", "src/server/index.ts"]
