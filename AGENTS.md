# AGENTS.md

Guidance for coding agents (and humans) working in this repo. Follows the
[agents.md](https://agents.md) convention. Topic deep-dives live in
[`.agents/`](.agents/) and are **not** auto-loaded — open the relevant one on demand.

## What this is

A web frontend **and** a Node backend service for an **Elegoo Centauri Carbon 2
(CC2)** FDM printer. The service holds **one** MQTT connection to the printer and
fans that single state stream out to every consumer:

```
Printer MQTT ←→ MqttBridge (singleton) ←→ StateStore
                                             ↓
        ┌──────────┬──────────┬───────────┬──────────┐
     WebSocket   REST API   Moonraker   OctoPrint  Telegram
    (browsers)  (+camera)    (:7125)     (compat)    (bot)
```

**This is a fork, and it has no issue tracker.** Upstream tracked work in an **ELEG**
project reached over an MCP server on the original author's infrastructure; that config
and its env vars are gone, because a fork cannot reach someone else's private portal and
a token nobody here holds is not configuration, it is decoration.

`ELEG-nn` references survive throughout this file and the deep dives. Read them as
provenance — *why this code is shaped this way* — not as tickets to open. They are
frequently the only record of an incident, and that is worth more than the link.

**The thing on the other end is a physical machine with heaters and motors.** That
single fact is what makes this repo different from its siblings, and it has its own
rule below.

## Setup

```bash
bun install
cp .env.example .env       # set PRINTER_IP at minimum
bun run dev                # build, serve on :8088, rebuild+restart on any change
bun run dev:service        # service only (bun --watch), against an existing dist/
```

Bun ≥ 1.2.3, and `bunx playwright install chromium` once for the browser tests. There is
no Node, no pnpm, no tsx, no Vite, no database and no container needed for development.
Bun is the package manager, the TypeScript runtime, the bundler, the test runner **and**
the HTTP server — see the front-door note in `.agents/architecture.md`.

**There is one port in development now, not two.** The service serves the built SPA
itself, so `bun run dev` builds `dist/` and restarts on change rather than running a
separate vite server on :5173 that proxied back. Dev and production are the same shape;
what is lost is hot module replacement, and the rebuild is ~550ms.

## Build / test / lint (run before finishing any change)

```bash
bun run gates          # ⭐ everything (scripts/gates.sh) — and this is literally what CI runs
bun run gates --fix    # biome --write first, then the gates — commit what it rewrites
```

`bun run gates` is the one to run: `biome ci` (**non-writing**, as CI does it),
`tsc` (the browser half), **`bun run service:check`** (the server + telegram half),
**`knip`** (unreachable modules — ELEG-65), the build, `bun test`, and **`playwright
test`** — the last needs a browser binary, so a fresh checkout runs
`bunx playwright install chromium` once. The
individual scripts still exist for a tight inner
loop; details, traps and the known gaps are in
[`.agents/gates.md`](.agents/gates.md) — the file `.agents/repo.json` names as `gatesDoc`.

**`ci.yml` runs `bun run gates` as a single step** (ELEG-5), so the gate list lives in one
place and CI cannot fall behind it — adding a gate to `scripts/gates.sh` needs no
workflow edit. It used to be four hand-listed steps, which is precisely how the backend
came to be typechecked by nothing in CI. A green CI now means the same thing a green
local run means; what that still does *not* prove is in `local/gates.md`.

CI is [`.github/workflows/ci.yml`](.github/workflows/ci.yml) on `ubuntu-latest` —
which works here because **this repo is public** and public repos get free hosted
Actions minutes (the private siblings do not, hence their self-hosted runners).

## Non-negotiable conventions

- **Never command the live printer to test a change.** This is the analogue of the
  sibling ANS repo's live-infrastructure boundary, and it is stricter here because
  the consequences are physical: `set_temperature` heats a real nozzle, `move` and
  `home` drive real motors into whatever is on the bed, `start_print` starts a
  print, `emergency_stop` aborts someone's 14-hour job. Reads are fine and
  encouraged — `GET /api/health`, `/api/status`, `/api/metrics`,
  `bun run dev` against the live printer, watching the MQTT
  log. **Writes are for a human at the machine**, and that makes them *operator
  work* (see the rule below). If a change genuinely cannot be verified without a
  command, say so, give the exact command, and ask — never fire it and report the
  result.
- **TypeScript strict, ESM, and `.js` on every relative import under `src/server/**`.**
  `import { loadConfig } from './config.js'`. Bun resolves `./config.js` to
  `config.ts`, so this no longer *breaks* the way it did under `node --import tsx`,
  where the specifier had to be the one Node resolves — it is now a convention rather
  than a hard constraint. Keep it anyway: the tree is a clean split (every relative
  import under `src/server/**` carries `.js`, every one in the vite-bundled browser
  half — `src/main.ts`, `src/ui/**`, `src/types.ts` — is extensionless, which
  `moduleResolution: "bundler"` accepts), and a half-converted tree is worse than
  either. Match the half you are editing rather than "fixing" 120 imports in
  either direction.
- **There are two tsconfigs and CI only checks one of them.** `tsconfig.json`
  covers the browser half and **excludes `src/server`**; `tsconfig.server.json`
  covers that (via `bun run service:check`). `bun run build` runs the first one only, so
  the **entire backend can be type-broken while the build is green**. Always run
  `bun run gates` (or `bun run service:check` by hand) after touching `src/server/**`.
  This bites harder under Bun than it did before: there is no transpile step at all
  between the checkout and the running service.
  (There used to be a third, `tsconfig.bot.json` — a byte-identical copy of
  `tsconfig.server.json` that no script ever referenced. It went with the dead bot in
  ELEG-23.)
- **Icons are Bootstrap Icons, named in `src/ui/icons.ts` — never an emoji, never a
  raw class at the call site.** The frontend used to draw ~180 emoji, which meant the
  same markup rendered as a flat pictogram on one OS, a colour cartoon on another and a
  tofu box on the Linux machines this dashboard is most often opened from. The webfont
  is shipped from `node_modules`, not a CDN: this service sits on the printer's LAN and
  is regularly opened from a machine with no route to the internet.

  Three call shapes, and **picking the wrong one between the first two is a security
  bug, not a cosmetic one**:

  | | use | why |
  | --- | --- | --- |
  | `icon(name)` | inside an `innerHTML` template, with a label after it | returns an HTML string, carries the `bi-lead` gap |
  | `iconSolo(name)` | same, but the glyph is the element's whole content | no trailing gap, or icon-only buttons render off-centre |
  | `iconText(el, name, text)` | replacing an `el.textContent = …` | appends the text as a **text node**. Those sites interpolate filenames and printer error strings; switching one to `innerHTML` to fit a glyph in turns a crafted filename into script execution |

  Add the glyph to the `ICONS` map rather than writing `bi-…` inline, so one name is
  swapped in one place. Every icon is `aria-hidden`: the accessible name belongs on the
  button (`aria-label`) or the text beside it.

  Four glyphs are deliberately **not** converted, each with a comment saying why:
  the two `<option>` arrows in `index.html` (an `<option>` may only contain text), the
  `⚠️` in the emergency-stop `confirm()` (a native dialog renders plain text), the `▾`
  in `main.css`'s base layer (`::after` content cannot carry a class), and `⌀` in the spool
  calculator's SVG (a typographic symbol, not an icon).

- **Everything the service writes goes under `config.dataDir`, via `data-paths.ts`.**
  Never `process.cwd()`, never a relative `join('data', …)`. The gcode cache and the
  debug-capture endpoints did exactly that until ELEG-70, and it survived unnoticed for
  the life of the repo **because the default makes the two coincide**: `DATA_DIR`
  defaults to `./data`, so `$CWD/data` is the same directory on metal
  (`WorkingDirectory=/opt/elegooweb`) and in the container (`WORKDIR /app`). It only
  diverges for someone who sets `DATA_DIR` elsewhere — which `README.md` and
  `contrib/docker-compose.example.yml` document as supported — and then the writes land in a
  directory nobody mounted or backs up.

  That is a shape worth recognising on its own: **a hardcoded value that happens to equal
  a default is untested by every environment you have.** Grep for `process.cwd()` before
  adding a path, and if a helper needs the directory but has no `config` to hand, add a
  getter to `src/server/data-paths.ts` rather than a parameter — `initDataPaths` sits
  beside `initLogger` in `index.ts` precisely so process-wide paths stay in one place.

- **One MQTT connection, and it belongs to `MqttBridge`.** Never open a second
  client, from a route, a tool, the bot or a test — the printer's broker is small and
  a second registration fights the first. New consumers read from `StateStore` (or
  subscribe to its events) and publish through the bridge. `src/server/index.ts`
  wires exactly one of each; keep it that way. The tree held a violation of this rule
  for its whole life — an unreachable standalone Telegram bot under `src/telegram/`
  with its own `MqttBridge`, no npm script and no way to start it, which also made
  ELEG-3's security fix need applying twice. Deleted in ELEG-23; `git log` has it if a
  standalone deployment is ever wanted, and it would need this rule reckoned with.
- **The frontend is hand-written TypeScript + DOM.** No framework, no JSX, no
  component library: `src/main.ts` composes modules from `src/ui/*.ts`. Match the
  surrounding idiom rather than introducing a framework in one card.
- **Tailwind is compiled by `@tailwindcss/cli`, not a bundler plugin, and that is
  load-bearing.** `bun build` parses CSS but does not understand Tailwind v4: it warns
  `invalid @ rule encountered: '@theme'`, drops the directives, **exits 0**, and emits a
  stylesheet in which not one utility class is defined. A build that fails by handing you
  an unstyled site is worse than one that stops, so `scripts/build.ts` runs the CLI and
  joins the halves itself — and asserts every `url()` the result names actually exists,
  because Tailwind's CLI does not rewrite or copy what it imports (the Bootstrap Icons
  fonts are the case that bit).

- **Styling is Tailwind utilities on the element. There is no stylesheet to edit.**
  `src/styles/main.css` is Tailwind's *configuration* — the palette, `@theme`,
  keyframes and a handful of base rules — and nothing else. Do not add component CSS
  to it; put the utilities on the markup.

  Three things carry styling outside the markup, because they are applied at runtime
  and a class name alone no longer means anything:

  | | |
  | --- | --- |
  | `ui/state-classes.ts` | `toggleState(el, 'active', on)` — the utilities a state implies, per base component. GENERATED from the old stylesheet; edit it directly. |
  | `ui/card-layout.ts` | `CARD_WIDTH_UTILITIES` — the grid span each card width means. |
  | `helpers.ts` | `toggleClasses(el, 'hook a b c', on)` for one-off runtime states. |

  **The design system is `ui/design.ts`.** `CARD`, `LABEL`, `READOUT`, `BTN`, `CHIP`,
  `FIELD`, `GAUGE`, `SWITCH_*`, `EMPTY` and the rest are the vocabulary; a card that
  needs a button uses `BTN` rather than inventing padding. The file explains the one
  structural idea behind them — readouts (what the machine tells you) are borderless and
  mono, actuators (what you tell it) are bordered and grouped — and the two rules that
  follow: **the accent colour means "this control is engaged" and nothing else**, and a
  physical quantity keeps the printer's own colour (nozzle red, bed amber). `index.html`
  cannot import, so it carries the strings literally; the render modules import them.

  **Never put two utilities for one CSS property on one element.** Tailwind guarantees
  no order between them, so which wins is whatever the generated sheet happens to emit
  last — and it renders plausibly either way, which is why every instance of this
  survived review. It is the single cause of every bug the conversion shipped: `hidden`
  lost to `inline-flex` and the Resume button showed beside Pause; `text-bad` lost to
  `text-fg` and the emergency stop came out the same grey as everything else; `bg-accent`
  lost to `bg-surface` and the selected jog step had no fill. `src/__tests__/design-system.test.ts`
  enforces this for the tokens and the state table; it cannot see your markup.

  The corollary is what a **state delta** is for: `add` names what the state sets,
  `remove` names the neutral it displaces, and for every property `add` touches `remove`
  must clear the base's utility for it. Every segmented picker now shares one
  `CHIP_ACTIVE` against one `CHIP` base — there used to be five, differing only in which
  neutral each happened to remove.

  **Prefer `min-[…]` over `max-[…]` when two variants set the same property.**
  Tailwind gives no guaranteed order between overlapping arbitrary max-width variants,
  so `max-[1100px]:col-[span_6]` and `max-[700px]:col-[span_12]` both matched at 390px
  and the wider one won — every card came out half-width on a phone. Ascending `min-*`
  variants have an unambiguous order. Where a `max-*` pair is unavoidable, bound the
  wider one: `min-[701px]:max-[800px]:…`.

  **A class the code queries must stay on the element.** `querySelector`,
  `classList.contains` and the delegated click handlers still look for `main-tab`,
  `file-item`, `settings-card-visible` and ~107 others; those are hooks now, carrying
  no styling. Removing one breaks behaviour silently.
- **Sub-tabs are one shared helper, and every group is scoped.** `ui/subtabs.ts`:
  a strip is `<nav data-subtab-group="X">` with `.subtab` buttons, panels are
  `id="X-subtab-<name>"`, and the choice is remembered per group. Tools and About each
  have one. The first version queried `.subtab` across the document, which was fine
  with one strip and wrong the moment there were two — picking a tool would have
  deactivated Help and Debug.
  About, Help & API and Debug are the three sub-tabs of the About page; Filament Dryer
  and Spool Calculator are the two under Tools.


- **The filament dryer heats the bed on a timer, and that makes it the one tool in
  here with a physical failure mode.** `ui/dryer.ts` holds the presets, the schedule
  maths and the clamps; `ui/dryer-panel.ts` is the only place that sends `1028`
  (`Set temperature`) for drying. Three properties must survive any change:

  - **`MAX_SAFE_C` is a ceiling on everything**, including a temperature typed by hand
    and one restored from localStorage. A non-finite input clamps to the FLOOR, not the
    ceiling — a heater fails cold.
  - **The session stores an absolute `startedAt`.** A tab reopened hours later resolves
    it, sees it expired, and turns the bed off. Storing a remaining-duration instead
    would make a closed tab pause the clock and leave the bed hot.
  - **Every exit turns the heater off** — finished, stopped, or resumed-expired all go
    through `finish()`. Closing the tab mid-session is the case nothing can cover; the
    panel says so rather than implying otherwise.

- **The phone dashboard shows ONE card at a time.** Below 700px a vertical rail down
  the right edge (`ui/mobile-focus.ts`) focuses a single card; `All` restores the
  scrolling dashboard. Two consequences for anything that touches the dashboard:

  - **`applyCardLayout` owns visibility, and it asks `isCardVisible`.** Do not set
    `card.style.display` anywhere else — a layout change and a focus change would
    silently undo each other.
  - **A card needs an entry in `CARD_ICONS` and `CARD_ACCENTS`** as well as
    `CARD_NAMES`, or its rail button renders blank or uncoloured. The layout tests
    assert all three.

- **A list view's controls go in a *static sibling* of the list, never inside it.**
  Every list card re-renders wholesale on a WebSocket update — the render function
  assigns `container.innerHTML`. Anything interactive built inside that container is
  therefore destroyed and rebuilt under the user: a filter input loses focus and
  selection mid-keystroke when a 1036 response lands. Files, Print History, Print
  Reports and Timelapse each pair `#<view>-list` with a `#<view>-controls` div beside
  it, and `src/ui/list-controls.ts` mounts into that once (ELEG-49…52). Sort/filter
  state lives in that module's closure, **outside** the render function, and is
  persisted in `ui-settings.ts`. New list views follow the same shape; the pure half of
  any list logic belongs in `src/ui/list-sort.ts`, which is the only half a test can
  reach. (This rule used to warn against `src/persistence.ts` as the wrong home for such
  state. That file was unreachable and is gone — ELEG-65 — so `ui-settings.ts` is now
  simply the only client-side preference store there is.)
- **`README.md`'s environment-variable table changes with `src/server/config.ts`.** A
  new key without the doc edit in the same commit is drift in the only place anyone
  looks. (There used to be a second doc-parity rule here, for an endpoint that has since
  been removed — see the note at the end of this file.)
- **Auth is one gate, applied once.** `src/server/auth.ts` holds the decisions (password
  hashing, sessions, throttling, constant-time key compare); `src/server/auth-gate.ts`
  holds the HTTP policy and the `/api/auth/*` routes. It is wired in **three** places —
  `nodeRouter` in `index.ts`, the `/ws` upgrade beside it, and the `:7125` listener, which
  takes the gate as a constructor argument because it is a separate server and is the one
  that gets missed. A new endpoint is protected by existing; do not add a per-route check.

  Two properties are load-bearing. **Auth is off until a password is configured** — the
  service is already deployed, so a default-on with nothing to check against is a lockout;
  an unconfigured service logs a warning naming the open control surface instead.
  **The public path list is exact, never a prefix** — a prefix match on `/api/health`
  would open `/api/health-anything`, and `src/__tests__/auth.test.ts` asserts it.

- **Secrets stay server-side and out of git.** `PRINTER_PASSWORD`,
  `TELEGRAM_BOT_TOKEN`, `AI_VLM_API_KEY` are read from the environment
  (`.env`, which is gitignored) at runtime — never hardcoded, never returned to the
  browser, never logged, and **placeholders only** in `.env.example`,
  `contrib/docker-compose.example.yml` and anything else committed. Mirrors the org
  data-protection policy: no real credentials or PII in committed files, issue
  comments, or outbound requests. (The vendor default `elegoo`/`123456` in the README
  is documentation of a published protocol default, not a secret.)
- **Conventional commits ARE the changelog — there is no file.** `CHANGELOG.md` and
  `release-it` were removed once this became a fork nobody upstreams: the file had not
  been touched in 115 commits and every link in it pointed at `runnane/elegoo-web`
  rather than this fork, so it described someone else's repo. `git log --oneline`
  answers "what changed" without going stale.

  The commit convention stays, and matters more without a file collecting it: the
  subject line *is* the release note. `feat:` → minor, `fix:` → patch, and anything
  user-visible needs one of those rather than `chore:`. The version the About panel
  shows never came from the changelog anyway — `build-info.ts` stamps
  `git describe --tags --always --dirty` at install time.
- **Branch → commit → PR, always from fresh `main`.** Finished work never sits as
  uncommitted working-tree changes. Branch `<type>/<eleg-lower>-<kebab-title>`
  (e.g. `feat/eleg-12-layer-chart-zoom`), a conventional commit, one PR, and
  `gh pr create --base main` **explicitly** — `gh` otherwise defaults to the tracked
  branch, which is how a PR merges into a dead branch and never reaches `main`.
  Sync twice: before cutting the branch, and again (`git fetch` + rebase + re-run the
  gates) before opening the PR if `main` moved.

  **Preflight `git switch`, because this checkout is shared.** More than one agent
  works this machine. Check `git rev-parse --abbrev-ref HEAD`,
  `git status --porcelain` and `git worktree list` first; **if `HEAD` is already a
  topic branch, stop and report it** — that is someone else's work in flight, and
  `git switch` carries modified files across. Unrelated dirt is left alone; a dirty
  file *this* issue will touch is an overlap and also a reason to stop. Never stash,
  reset or `git checkout <file>` to clear your path. The bundle's `agent-isolation` and
  `pr-hygiene` skills carry the full rules.
- **One issue → one PR → one merge, and the status is automated.** The tracker's PR
  webhook moves ELEG issues off GitHub events: draft PR → `IN_PROGRESS`,
  opened/readied → `IN_REVIEW`, merged → `MERGED`, closed unmerged → `TODO`. Two
  consequences:
  - **The branch name is what makes it work.** The transition needs the issue key in
    the PR's **branch or title**; a key only in the body is recorded as an
    association and moves nothing. The `<type>/<eleg-lower>-…` convention satisfies
    this by construction.
  - **The automation never moves an issue backwards** out of `MERGED`,
    `IN_PRODUCTION`, `DONE` or `CANCELLED` — so a status you set wrongly by hand will
    not be corrected later. Comment on start and finish; let the automation move the
    status.

  A sub-issue's status also cascades to its parent (a child reaching `IN_PROGRESS`
  starts a `BACKLOG`/`TODO` ancestor; a parent whose every non-`CANCELLED` child is
  `DONE` becomes `DONE`), so don't hand-maintain an epic's status.
- **`IN_PRODUCTION` is real here, and merging is not it.** ELEG has
  `tracksProduction` on because production is a *separate step*: the service runs
  from **`/opt/elegooweb`**, which is **not a git checkout**, under systemd as user
  `elegooweb`. A merged PR changes nothing that is running. See
  [`.agents/deployment.md`](.agents/deployment.md) — and note that performing the
  deploy is operator work.
- **An issue is either repo work or operator work — never both.** Repo work is done
  when its PR merges; operator work is done when a human has run something against
  the live service or the printer and recorded the result. An issue holding both can
  never close cleanly. So when repo work needs a deploy or a printer command
  afterwards, **file that as its own `OPERATOR:`-titled issue**, self-contained: why
  it matters, the exact copy-pasteable commands, what to capture before, and how to
  verify at the *receiver* rather than at the exit code.

  **But "this is operator work" is never where you stop.** An `OPERATOR:` issue is a
  collaboration: say what needs running and why, work out **who can actually run
  it**, give the exact commands, then **ask for the output**, interpret it, and record
  the result on the issue either way.

  | Action | Who runs it |
  | --- | --- |
  | shell on this host, `systemctl`, reading `/opt/elegooweb`, `journalctl` | **them** — give exact commands, ask for output |
  | a printer command (temps, motion, print start/stop, emergency stop) | **them**, at or near the machine |

  And the distinction that decides most of these: **stopping something is not the same
  as starting it.** Stopping a runaway notification loop or disabling a feature flag is
  the safe, reversible direction; arming something — or touching the printer — is the
  direction that needs a human.

  **Do the reads yourself first, then hand over only what is left.** "This needs a
  human" is a claim about *each command*, not about the issue, and bundling them is how
  an errand gets handed over that was mostly answerable. Both `OPERATOR:` issues filed
  in the 2026-08-08 pass turned out to be over-scoped:

  - **ELEG-68** ("confirm the deploy stamp") — `curl localhost:8088/api/health` is on
    the *reads are fine and encouraged* list two rules above; only `sudo cat
    /opt/elegooweb/build-info.json` needs privilege. Running the read answered all of
    it but one line — and answered it *better*, because `/api/health` also reported
    `mqttPhase: null`, which corroborated the stamp's claim from **behaviour** rather
    than trusting the file's own say-so.
  - **ELEG-67** ("does the compat layer still work") — "no test exercises the route
    table" and "does Mainsail still work" are two questions. The first is answerable
    with the isolated local service in [`.agents/testing.md`](.agents/testing.md)
    (TEST-NET `PRINTER_IP`, blanked integrations, non-default ports); only the second
    needs a client.

  So before filing: **go through the commands one at a time** and ask whether *that
  one* needs privilege, a physical presence, or software you do not have. Run the ones
  that do not, put the results on the issue, and cross those steps off the
  instructions. An `OPERATOR:` issue reduced to one command gets done; a ten-step one
  that is mostly already answerable gets postponed, and deservedly.
- **A method number in an issue is a claim, and usually an unchecked one.** Three
  issues in the ELEG tracker named methods that do not do what they said —
  history-delete on 1049 (really `UpdateToken`, which writes the printer's *auth
  token*), AI detection on 2010/2011 (neither exists), OTA on 1064 (really 1039). All
  three were copied out of `METHOD_NAMES` in `src/ui/log-methods.ts`, which is a
  **display label for the log viewer, not a citation**, and which contradicted itself
  by listing 1038 *and* 1049 as history delete.

  **The protocol references are local-only, and are not in a clone (ELEG-66).**
  `data/` is gitignored in full and no file under it has ever been committed, so
  `data/CC2_PROTOCOL_REFERENCE.md` and `data/CC2-OFFICIAL-APP-PATTERNS.md` exist only on
  a machine where someone generated them. Check before citing:

  ```bash
  ls data/CC2_PROTOCOL_REFERENCE.md data/CC2-OFFICIAL-APP-PATTERNS.md
  ```

  If you have them, cite them — they remain the authority, and `.agents/testing.md`
  says how to weigh them against the running code. **If you do not, say so rather than
  citing them anyway**: a citation of a file you cannot open is indistinguishable from
  an invented one, which is the exact failure this rule exists to stop. Fall back to
  **asking the printer** — a `Get…` is a read and is allowed; `.agents/testing.md` has
  the one-liner. Never fire a `Set…` to find out what it does.

  **Record what you learn in code, not only in `data/`.** A protocol finding written
  into a `data/` file is lost to everyone else, because that file never commits. ELEG-55
  put `error_code 1100` in a comment in `src/ui/log-methods.ts` for exactly this reason.
  Do the same.
- **Capture durable learnings — don't relearn them.** A gotcha, a workflow step, a
  project constraint: write it down in the same change. Project facts → this file or
  the relevant [`.agents/`](.agents/) deep-dive; gate particulars →
  [`.agents/gates.md`](.agents/gates.md); a convention no repo owns → the userspace
  bundle, not here; a fact that varies per repo → [`.agents/repo.json`](.agents/repo.json),
  not prose. Cross-session context → persistent memory. Prefer updating the existing
  entry over adding a near-duplicate.

## The `/mcp` surface was removed

An MCP server lived at `POST /mcp` and exposed the printer to AI agents — 6 resources
and 31 tools, including `set_temperature`, `move`, `start_print` and `emergency_stop`.
It is gone: `mcp-server.ts`, `docs/MCP.md`, `.agents/mcp.md` and the doc-parity test with
it, ~1,100 lines. So is the `.mcp.json` that pointed at upstream's issue tracker, and the
`exposeHeaders` argument to `corsHeaders`, whose only caller was `/mcp`'s session
header.

The reason was proportion, not principle. This is a home 3D-printer dashboard, and the
SDK was the heaviest thing in the tree for what it did: `@modelcontextprotocol/sdk`
pulled **express *and* hono** — two complete HTTP frameworks — plus `cors`, `jose` and
`ajv`, into a service that deliberately uses `Bun.serve` and wrote its own
`node-compat.ts` to get off the Node HTTP layer. Nothing in `src/` imported any of them.
`zod` went too; its only use was declaring MCP tool parameters.

If an agent-facing surface is ever wanted again, the compat layers already carry the same
control surface in vocabularies clients speak (Moonraker on `:7125`, OctoPrint under
`/octoprint/*`), and both are behind the same auth gate.

## This file is the source of truth for conventions

[`CLAUDE.md`](CLAUDE.md) exists only to import this file so it loads every session,
plus a pointer at the `.agents/` deep-dives. Put project conventions **here** (or in
the relevant deep-dive), not there — a rule that lives in only one of the two will be
missed by whichever tool reads the other.

## How agent instructions reach this repo

Ten repos run the same agent workflow against **one tracker and one PR webhook**. They
used to do it by copying `.claude/commands/` between each other, which drifted
measurably; RCP-878 replaced that with one bundle plus one manifest per repo, and
ELEG-81 adopted it here. There is nothing left to sync, and no `sha256sum` check to run.

- **The bundle** — `runnane/agent-userspace`: the constitution, the repo-agnostic
  workflow commands (`/fix`, `/auto`, `/plan`, `/research`, `/sweep`), and the
  `pr-hygiene`, `gate-failures` and `agent-isolation` skills. Bare on a workstation, or
  `/agent-userspace:fix` under `--plugin-dir`.
- **[`.agents/repo.json`](.agents/repo.json)** — the facts that differ between repos, and
  three of ELEG's differ from most of the set: `visibility: "public"`,
  `release: "none"` (**not** changesets, and no longer release-it — see above) and
  `liveBoundary: "printer"`.
- **What stays tracked here** — `CLAUDE.md`, this file, the five `.agents/` deep dives
  and [`.agents/gates.md`](.agents/gates.md).

**This repo is public, and that changes what may be written, not just how it is
verified.** Nothing in a commit, an issue link or a generated file here may carry
anything the org keeps internal: credentials, keys, customer or employee data, contract
terms, pricing, security configuration, or infrastructure detail that could aid an
attacker. Where a fixture would otherwise contain such data, **generate it** rather than
sanitise it — sanitising is a process that fails silently once.

**Adding a lesson.** Does it name a command, a runner or a repo-specific path? No → the
bundle, written once. Yes → this file or a `.agents/` deep dive. Is it a fact that varies
per repo? Then it is a manifest field, not prose.

**An agent commits only in the repo it was invoked in.** A lesson that belongs in a
sibling is ported by filing a linked issue in that repo's project, never by editing its
checkout.

## Where things are

| Area | Path |
| --- | --- |
| Service entry point (wires everything) | `src/server/index.ts` |
| MQTT bridge (the single connection) | `src/server/mqtt-bridge.ts` |
| Shared state + events | `src/server/state-store.ts` |
| REST API + camera proxy | `src/server/rest-api.ts` |
| Moonraker / OctoPrint compat | `src/server/{moonraker-compat,moonraker-server,octoprint-compat}.ts` |
| AI print monitor | `src/server/ai-monitor.ts` |
| Telegram bot | `src/server/telegram.ts`, `src/server/allowlist.ts` |
| Config / env parsing | `src/server/config.ts` |
| Frontend entry | `src/main.ts`, `index.html` |
| Frontend cards / views | `src/ui/*.ts` |
| Shared types | `src/types.ts` |
| Tests (logic, `bun test`) | `src/__tests__/**`, `src/server/__tests__/**` |
| Tests (browser, Playwright) | `tests/browser/**` |
| Frontend build / dev loop | `scripts/build.ts`, `scripts/dev.ts` |
| systemd unit + installer | `contrib/` |
| Roadmap | the **ELEG tracker** — there is no roadmap file |

## Deep dives

- [.agents/architecture.md](.agents/architecture.md) — the fan-out, the two HTTP
  servers, state flow, and which layer a change belongs in.
- [.agents/deployment.md](.agents/deployment.md) — `/opt/elegooweb`, the systemd unit,
  the cloudflare tunnel, and what `IN_PRODUCTION` means here.
- [.agents/testing.md](.agents/testing.md) — what the suite actually covers (very
  little), how to probe safely against a live printer, and what nothing checks.
- [.agents/security.md](.agents/security.md) — the exposure posture, the
  unauthenticated control surface, secrets, and the org policy.
- [.agents/lessons.md](.agents/lessons.md) — findings from real bugs that the resulting
  code does not show: `mqtt.js` reconnect behaviour, a CC2 filament-swap event sequence,
  and three client-side memory-leak post-mortems.

## Definition of done

`bun run gates` green (biome + both typechecks + knip + build + tests), `README.md`
updated if a documented surface changed, a conventional commit subject that reads as a
release note, no secrets committed, the issue commented and its PR open.
