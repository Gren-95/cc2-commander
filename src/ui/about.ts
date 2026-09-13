/**
 * "About this project" — what this is, which build is running, and what it is talking
 * to.
 *
 * The build stamp is the reason this panel exists. Production runs from
 * `/opt/elegooweb`, which is not a git checkout (see `.agents/deployment.md`), so the
 * stamp `contrib/install.sh` writes is the only answer to "which commit am I looking
 * at?" — and that is the first question anyone asks when a stranger reports a bug.
 *
 * Which is also why the **Copy diagnostics** button is here rather than the version
 * being something to squint at and retype. It puts the build, the printer, the service
 * and the browser on the clipboard in one go, so an issue can start with facts.
 *
 * An unstamped deploy says so in plain words rather than inventing a version. That is
 * the ELEG-48 rule: a version you cannot trust is worse than none, and all-null is a
 * real state — a dev run from a checkout, or a deploy whose installer never re-ran.
 */

import type { BuildStampish } from '../types';
import { UNKNOWN_VERSION_LABEL, buildVersionLabel } from '../types';
import { escapeHtml } from './helpers';
import { icon } from './icons';
import { toast } from './toast';

/** Where this code comes from. Upstream, not any particular fork. */
const PROJECT_URL = 'https://github.com/runnane/elegoo-web';

const SUMMARY =
  'A web frontend and service for the Elegoo Centauri Carbon 2. One MQTT connection ' +
  'to the printer, fanned out to this dashboard, a REST API, Prometheus metrics, an ' +
  'and Moonraker and OctoPrint compatibility endpoints.';

/** The slice of the service broadcast this panel reads. */
export interface AboutStatus {
  build?: BuildStampish | null;
  uptime?: number;
  printerSn?: string | null;
  printerIp?: string | null;
  wsClients?: number;
  mqtt?: string;
  camera?: string;
}

let status: AboutStatus | null = null;

function formatInstalledAt(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const when = new Date(iso);
  return Number.isNaN(when.getTime()) ? null : when.toLocaleString();
}

function formatUptime(seconds: number | undefined): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null;
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

interface Fact {
  label: string;
  value: string;
  /** Long form, on hover — the full sha behind a short one, say. */
  title?: string;
  /** Rendered in the muted colour: a real but unremarkable absence. */
  muted?: boolean;
}

function factRow(f: Fact): string {
  const attr = f.title ? ` title="${escapeHtml(f.title)}"` : '';
  return `<div class="flex justify-between gap-4 [padding:4px_0] text-[13px]">
      <span class="text-fg-muted">${escapeHtml(f.label)}</span>
      <span class="font-mono ${f.muted ? 'text-fg-muted' : 'text-fg'}"${attr}>${escapeHtml(f.value)}</span>
    </div>`;
}

function card(
  title: string,
  iconName: Parameters<typeof icon>[0],
  facts: Fact[],
  warn = false,
): string {
  return `<div class="min-w-[240px] flex-1 [padding:12px_16px] border ${
    warn ? 'border-[rgba(234,179,8,0.45)]' : 'border-line'
  } rounded-card bg-raised">
      <div class="mb-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-fg-muted">
        ${icon(iconName)} ${escapeHtml(title)}
      </div>
      ${facts.map(factRow).join('')}
    </div>`;
}

/** The build facts, and whether the deploy is stamped at all. */
function buildFacts(stamp: BuildStampish | null | undefined): { facts: Fact[]; stamped: boolean } {
  const version = buildVersionLabel(stamp);
  const stamped = version !== UNKNOWN_VERSION_LABEL;
  const facts: Fact[] = [];

  if (stamped) {
    facts.push({ label: 'Version', value: version, title: stamp?.describe ?? undefined });
  } else {
    facts.push({
      label: 'Version',
      value: 'unstamped',
      muted: true,
      title:
        'No build-info.json. Normal for `bun run dev` from a checkout; on a deployed ' +
        'service it means the installer never wrote a stamp.',
    });
  }
  if (stamp?.shortCommit) {
    facts.push({ label: 'Commit', value: stamp.shortCommit, title: stamp.commit ?? undefined });
  }
  const installed = formatInstalledAt(stamp?.installedAt);
  if (installed) {
    facts.push({ label: 'Installed', value: installed, title: stamp?.installedAt ?? undefined });
  }
  return { facts, stamped };
}

/** Everything worth pasting into a bug report, as plain text. */
export function diagnosticsText(s: AboutStatus | null, userAgent: string): string {
  const stamp = s?.build;
  const lines = [
    'elegoo-web diagnostics',
    `version:   ${buildVersionLabel(stamp)}`,
    `commit:    ${stamp?.commit ?? 'unknown'}`,
    `installed: ${stamp?.installedAt ?? 'unknown'}`,
    `printer:   ${s?.printerSn || 'not registered'} at ${s?.printerIp || 'unknown'}`,
    `mqtt:      ${s?.mqtt ?? 'unknown'}`,
    `camera:    ${s?.camera ?? 'unknown'}`,
    `uptime:    ${formatUptime(s?.uptime) ?? 'unknown'}`,
    `clients:   ${s?.wsClients ?? 'unknown'}`,
    `browser:   ${userAgent}`,
  ];
  return lines.join('\n');
}

/** Called whenever the service broadcasts its status. */
export function setAboutStatus(next: AboutStatus | null | undefined): void {
  status = next ?? null;
  renderAbout();
}

export function renderAbout(): void {
  const host = document.getElementById('about-card');
  if (!host) return;

  const { facts, stamped } = buildFacts(status?.build);
  const uptime = formatUptime(status?.uptime);

  host.innerHTML = `
    <div class="flex flex-col gap-5">
      <div>
        <h3 class="text-[16px] font-semibold text-fg mb-2">Elegoo CC2 web frontend</h3>
        <p class="max-w-[70ch] text-fg-soft leading-[1.5]">${escapeHtml(SUMMARY)}</p>
      </div>

      <div class="flex flex-wrap gap-3">
        ${card('Running build', 'printing', facts, !stamped)}
        ${card('Printer', 'print', [
          {
            label: 'Serial',
            value: status?.printerSn || 'not registered',
            muted: !status?.printerSn,
          },
          { label: 'Address', value: status?.printerIp || 'unknown', muted: !status?.printerIp },
          { label: 'MQTT', value: status?.mqtt ?? 'unknown', muted: status?.mqtt !== 'connected' },
        ])}
        ${card('Service', 'ai', [
          { label: 'Uptime', value: uptime ?? 'unknown', muted: !uptime },
          {
            label: 'Browsers',
            value: String(status?.wsClients ?? '—'),
            muted: status?.wsClients == null,
          },
          {
            label: 'Camera',
            value: status?.camera ?? 'unknown',
            muted: status?.camera !== 'available',
          },
        ])}
      </div>

      <div class="flex flex-wrap items-center gap-4">
        <button id="about-copy" class="inline-flex items-center [padding:7px_14px] rounded-chip border border-line bg-card text-fg text-[13px] font-medium cursor-pointer">
          ${icon('clipboard')} Copy diagnostics
        </button>
        <a href="${PROJECT_URL}" target="_blank" rel="noopener noreferrer" class="text-accent text-[13px] no-underline hover:underline">
          ${icon('link')} Source
        </a>
        <a href="${PROJECT_URL}/issues" target="_blank" rel="noopener noreferrer" class="text-accent text-[13px] no-underline hover:underline">
          ${icon('debug')} Report an issue
        </a>
        <span class="text-[12px] text-fg-muted">MIT licensed</span>
      </div>
    </div>`;

  document.getElementById('about-copy')?.addEventListener('click', async () => {
    const text = diagnosticsText(status, navigator.userAgent);
    try {
      await navigator.clipboard.writeText(text);
      toast('Diagnostics copied', 'success');
    } catch {
      // Clipboard access is refused on an insecure origin, which is exactly how this
      // dashboard is usually reached — over plain HTTP on a LAN. Falling back to a
      // prompt keeps the text reachable rather than failing silently.
      window.prompt('Copy the text below', text);
    }
  });
}
