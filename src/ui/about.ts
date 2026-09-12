/**
 * "About this project" — what this is, and **which build of it is actually running**.
 *
 * The second half is the point. Production runs from `/opt/elegooweb`, which is not a
 * git checkout (see `.agents/deployment.md`), so the only way to answer "which commit
 * am I looking at?" is the stamp the installer wrote — and that is the first question
 * anyone asks when a stranger reports a bug. It was previously reachable only by
 * opening the service-status dropdown and reading one row of it.
 *
 * An unstamped deploy says so in plain words rather than inventing a version. That is
 * the ELEG-48 rule: a version you cannot trust is worse than none, and all-null is a
 * real state — a dev run from a checkout, or a deploy whose installer never re-ran.
 */

import type { BuildStampish } from '../types';
import { UNKNOWN_VERSION_LABEL, buildVersionLabel } from '../types';
import { escapeHtml } from './helpers';
import { icon } from './icons';

/** Where this code comes from. Upstream, not any particular fork. */
const PROJECT_URL = 'https://github.com/runnane/elegoo-web';

const SUMMARY =
  'A web frontend and service for the Elegoo Centauri Carbon 2. One MQTT connection ' +
  'to the printer, fanned out to this dashboard, a REST API, Prometheus metrics, an ' +
  'MCP server, and Moonraker and OctoPrint compatibility endpoints.';

function formatInstalledAt(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return null;
  return when.toLocaleString();
}

/** One `label: value` line, with an optional `title` for the long form. */
function row(label: string, value: string, title?: string): string {
  const attr = title ? ` title="${escapeHtml(title)}"` : '';
  return `<div class="about-row">
      <span class="about-label">${escapeHtml(label)}</span>
      <span class="about-value"${attr}>${escapeHtml(value)}</span>
    </div>`;
}

/**
 * Render the About panel.
 *
 * `stamp` is whatever the service last reported; null before the first broadcast.
 */
export function renderAbout(stamp: BuildStampish | null | undefined): void {
  const host = document.getElementById('about-card');
  if (!host) return;

  const version = buildVersionLabel(stamp);
  const stamped = version !== UNKNOWN_VERSION_LABEL;
  const installed = formatInstalledAt(stamp?.installedAt);

  const rows: string[] = [];

  if (stamped) {
    rows.push(row('Version', version, stamp?.describe ?? undefined));
  } else {
    rows.push(
      row(
        'Version',
        'unknown — running unstamped',
        'No build-info.json. Normal for `bun run dev` from a checkout; on a deployed ' +
          'service it means the installer never wrote a stamp.',
      ),
    );
  }

  if (stamp?.shortCommit) {
    rows.push(row('Commit', stamp.shortCommit, stamp.commit ?? undefined));
  }
  if (installed) {
    rows.push(row('Installed', installed, stamp?.installedAt ?? undefined));
  }

  host.innerHTML = `
    <p class="about-summary">${escapeHtml(SUMMARY)}</p>
    <div class="about-build ${stamped ? '' : 'about-build-unstamped'}">
      <div class="about-build-title">${icon('printing')} Running build</div>
      ${rows.join('')}
    </div>
    <p class="about-links">
      <a href="${PROJECT_URL}" target="_blank" rel="noopener noreferrer">
        ${icon('link')} Source &amp; issue tracker
      </a>
    </p>
  `;
}
