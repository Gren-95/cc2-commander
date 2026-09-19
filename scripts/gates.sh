#!/usr/bin/env bash
# The gate set, in one place.
#
#   bun run gates          # everything
#   bun run gates --fix    # `biome check --write` first, then everything
#
# THIS FILE IS WHAT CI RUNS (ELEG-5). .github/workflows/ci.yml is one step,
# `bun run gates`, so this script is the single list of what has to pass and the two
# cannot drift apart. Add a gate here and CI picks it up with no workflow edit.
#
# It used to be four hand-listed steps in ci.yml, which is how `service:check` came
# to be missing from them: tsconfig.json excludes src/server, CI only
# ran the build (which uses that config), and so the entire backend was typechecked by
# nothing in CI. Measured at the time: a deliberate type error in src/server/config.ts
# left the build PASSING and only `service:check` caught it. Production runs the
# TypeScript directly under bun, so such an error reaches the running service with no
# compile step in between.
#
# On biome: CI runs the NON-writing `biome ci`. `bun run check` auto-fixes and exits 0,
# so an auto-fix you did not commit still fails CI's lint step: hence --fix runs the
# writer first and then re-checks, and you commit what it rewrote.
#
# NOTE the deliberate absence of a path argument (ELEG-79). A path narrows the file set
# and SILENTLY OVERRIDES biome.json's `includes`, with no warning that it did. This ran
# `biome ci src/` while `includes` said `src/**`, so the two agreed by accident and the
# root config files were linted by nothing: `biome ci src/` checked 84 files and passed
# while `biome ci` checked 87 and found real formatting drift in both. Scope belongs in
# biome.json alone; do not reintroduce a path here or in package.json's biome scripts.
#
# What this cannot check is in docs/gates.md. In short: the suite is
# small and almost entirely pure functions, nothing exercises a connection or a route,
# there is no browser and no screenshot, and no gate on earth can tell you whether a
# change does the right thing to a physical printer.
#
# Deliberately no test count here or in the footer: vitest prints one two lines above it
# every run. A number in a string that nothing updates only ever drifts (ELEG-15).

set -uo pipefail
cd "$(dirname "$0")/.."

fix=0
for arg in "$@"; do
  case "$arg" in
    --fix) fix=1 ;;
    *)
      echo "unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

failed=()
passed=()
skipped=()

run() {
  local label="$1"
  shift
  printf '\n\033[1m▶ %s\033[0m  (%s)\n' "$label" "$*"
  if "$@"; then
    passed+=("$label")
  else
    failed+=("$label")
  fi
}

# Install exactly what bun.lock says before judging anything. CI installs fresh, so a
# local node_modules that has drifted from the lockfile runs different tools than CI and
# the two stop meaning the same thing. It happened: the dev container's node_modules
# volume was re-seeded from an older image, and the gates ran biome 2.5.9 against a
# lockfile pinning 2.5.13 -- green locally on a tree CI would have judged differently.
# ~10ms when already in sync. --frozen-lockfile fails rather than rewriting bun.lock, so
# package.json/lockfile drift is caught here too, first.
run 'dependencies match bun.lock' bun install --frozen-lockfile --silent

if [ "$fix" = 1 ]; then
  printf '\n\033[1m▶ biome check --write\033[0m  (fixing before the gates)\n'
  bun run check || true
fi

# Order mirrors ci.yml: cheapest signal first.
run 'biome ci (non-writing, as CI runs it)' bunx biome ci
run 'typecheck: browser half (tsconfig.json)' bunx tsc
run 'typecheck: service half (tsconfig.server.json)' bun run service:check
# Dead-code check (ELEG-65). Neither typecheck complains about a module nothing
# imports, and the bundler tree-shakes it out SILENTLY, so an unreachable file
# survives looking perfectly legitimate. Four have been found that way, all by hand.
# Scoped to `files` only: unused *exports* are noisy here, and a check that cries wolf
# gets ignored. See docs/gates.md.
run 'dead code (knip)' bunx knip --no-config-hints
run 'build (bun + tailwind cli)' bun scripts/build.ts
run 'unit tests (bun test)' bun test src/__tests__ src/server/__tests__
# The browser half. These six suites used to run under `@vitest-environment jsdom`;
# they now run in Chromium, which is the whole reason the DOM assertions are worth
# anything: jsdom does not implement `inert`, so the focus trap's central safety
# property could only be asserted as "the attribute was set" and checked by hand.
#
# Needs a browser binary. Rather than fail a fresh checkout (or CI, whose workflow is a
# protected file nobody has authorised adding an install step to) this SKIPS when no
# browser is present and says so loudly. A skipped gate is not a passed one: the summary
# below lists it separately so a green run cannot be mistaken for a covered one.
if bunx playwright install --dry-run chromium >/dev/null 2>&1 && \
   [ -d "${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}" ] && \
   ls "${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}" 2>/dev/null | grep -q chromium; then
  run 'browser tests (playwright)' bunx playwright test
else
  skipped+=('browser tests (playwright): no browser; run `bunx playwright install chromium`')
fi

printf '\n\033[1m── gates ──\033[0m\n'
for g in "${passed[@]:-}"; do [ -n "$g" ] && printf '\033[32m  ✓ %s\033[0m\n' "$g"; done
for g in "${skipped[@]:-}"; do [ -n "$g" ] && printf '\033[33m  ⊘ %s\033[0m\n' "$g"; done
for g in "${failed[@]:-}"; do [ -n "$g" ] && printf '\033[31m  ✗ %s\033[0m\n' "$g"; done

if [ "${#failed[@]}" -gt 0 ]; then
  printf '\n\033[31m%d gate(s) failed. Fix them before opening a PR.\033[0m\n' "${#failed[@]}"
  exit 1
fi
printf '\n\033[32mAll gates green.\033[0m\n'
printf '\033[2mNo browser and no screenshot: see docs/gates.md for what this does NOT prove.\033[0m\n'
if [ "$fix" = 0 ]; then
  echo 'Reminder: if you edit anything else, re-run `bun run gates --fix` and commit what biome rewrites.'
fi
