/** Settings panel — persistent card layout + Telegram config */

import { icon, iconSolo } from './icons';
import { $, fetchTimeout } from './helpers';
import {
  CARD_NAMES,
  CARD_WIDTH_LABELS,
  CARD_WIDTHS,
  type CardLayout,
  type CardWidth,
  defaultCardLayout,
  normaliseCardLayout,
  widthOf,
} from './card-layout';
import { toast } from './toast';
import { renderSpoolCalc } from './spool-calc';
import { renderHelp } from './help';
import { renderAbout } from './about';
import type { BuildStampish } from '../types';
import { getThemeChoice, setThemeChoice, isThemeChoice } from './theme';
import { playAlert } from './alert-sound';
import { refreshTimestamps } from './relative-time';
import { loadUISettings, saveUISettings } from './ui-settings';

const STORAGE_KEY = 'elegoo-web-card-layout';

// ---- Card layout settings (localStorage) ----
//
// What the layout *is* lives in `card-layout.ts`, free of DOM and storage so it can be
// unit-tested (ELEG-44). This half owns persistence and the DOM.

function loadCardLayout(): CardLayout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return normaliseCardLayout(JSON.parse(raw));
  } catch {
    /* unreadable or malformed — fall through to the defaults */
  }
  return defaultCardLayout();
}

function saveCardLayout(layout: CardLayout): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
}

let currentLayout = loadCardLayout();

/** Toggle a card's collapsed state */
export function toggleCardCollapse(cardId: string): void {
  const idx = currentLayout.collapsed.indexOf(cardId);
  if (idx >= 0) {
    currentLayout.collapsed.splice(idx, 1);
  } else {
    currentLayout.collapsed.push(cardId);
  }
  const card = document.getElementById(cardId);
  if (card) card.classList.toggle('collapsed', currentLayout.collapsed.includes(cardId));
  saveCardLayout(currentLayout);
}

/** Apply card order, panel assignment, visibility, and collapse to the DOM */
export function applyCardLayout(): void {
  const grid = document.getElementById('dashboard-grid');
  if (!grid) return;

  // Backfilling a newly added card used to happen here, on the in-memory copy only —
  // so the settings panel, which re-reads from storage, never saw it. It is part of
  // `normaliseCardLayout` now, which both paths go through (ELEG-44).

  for (const id of currentLayout.order) {
    const card = document.getElementById(id);
    if (!card) continue;
    // appendChild on an element already in the grid MOVES it, so iterating the saved
    // order is all the reordering there is.
    grid.appendChild(card);
    card.style.display = currentLayout.hidden.includes(id) ? 'none' : '';
    card.classList.toggle('collapsed', currentLayout.collapsed.includes(id));
    applyCardWidth(card, widthOf(currentLayout, id));
  }

  // Bind collapse toggle on card headers (idempotent via data attribute)
  for (const child of [...grid.children] as HTMLElement[]) {
    if (!child.id || child.dataset.collapseInit) continue;
    child.dataset.collapseInit = '1';
    const header =
      (child.querySelector(
        '.card-header, .card-head, .files-header, .log-header',
      ) as HTMLElement) || (child.querySelector('h3') as HTMLElement);
    if (!header) continue;
    header.style.cursor = 'pointer';
    header.addEventListener('click', (e) => {
      // Don't collapse when clicking buttons/inputs/selects inside the header
      const t = e.target as HTMLElement;
      if (t.closest('button, input, select, label, a, .toggle')) return;
      toggleCardCollapse(child.id);
    });
  }
}

/** One `card-w-*` class at a time, so a width change cannot leave two spans applied. */
function applyCardWidth(card: HTMLElement, width: CardWidth): void {
  for (const w of CARD_WIDTHS) card.classList.toggle(`card-w-${w}`, w === width);
}

// ---- Settings Tab ----

let settingsRendered = false;

/** Switch to the Settings tab */
export function openSettings(): void {
  switchToTab('settings');
  renderSettingsContent();
}

/** Switch between main tabs (dashboard / settings / tools / help / debug) */
/** Which section of the merged About page is showing. */
export type HelpSubtab = 'help' | 'debug';

let subtabsBound = false;

/**
 * Show one section of the About page.
 *
 * Debug used to be a main tab of its own. It is a sub-tab here because it belongs with
 * Help — both answer "what is this thing doing?" — but it must not be *stacked under*
 * Help, whose API reference runs to several screens.
 */
export function switchHelpSubtab(sub: HelpSubtab): void {
  for (const btn of document.querySelectorAll('.subtab')) {
    const el = btn as HTMLElement;
    const on = el.dataset.subtab === sub;
    el.classList.toggle('active', on);
    el.setAttribute('aria-selected', String(on));
  }
  document.getElementById('help-subtab-help')?.classList.toggle('hidden', sub !== 'help');
  document.getElementById('help-subtab-debug')?.classList.toggle('hidden', sub !== 'debug');
}

function bindHelpSubtabs(): void {
  if (subtabsBound) return;
  subtabsBound = true;
  for (const btn of document.querySelectorAll('.subtab')) {
    btn.addEventListener('click', () => {
      switchHelpSubtab(((btn as HTMLElement).dataset.subtab as HelpSubtab) ?? 'help');
    });
  }
}

export function switchToTab(tab: 'dashboard' | 'settings' | 'tools' | 'help' | 'debug'): void {
  const connectDialog = document.getElementById('connect-dialog');
  const dashboard = document.getElementById('dashboard');
  const settingsPage = document.getElementById('settings-tab-content');
  const toolsPage = document.getElementById('tools-tab-content');
  const helpPage = document.getElementById('help-tab-content');
  const tabs = document.querySelectorAll('.main-tab');

  if (!dashboard || !settingsPage) return;

  /*
   * `debug` is no longer a tab of its own — it is a section of the About page. It stays
   * in the union so `switchToTab('debug')` keeps working and lands where a caller
   * expects: the About page, opened on Debug.
   */
  const mainTab = tab === 'debug' ? 'help' : tab;

  tabs.forEach((t) => {
    const el = t as HTMLElement;
    el.classList.toggle('active', el.dataset.tab === mainTab);
  });

  // Hide all pages first
  settingsPage.classList.add('hidden');
  toolsPage?.classList.add('hidden');
  helpPage?.classList.add('hidden');
  dashboard.classList.add('hidden');
  connectDialog?.classList.add('hidden');

  if (tab === 'dashboard') {
    // Show dashboard (or connect dialog if not yet connected)
    if (dashboard.dataset.connected !== 'true' && connectDialog) {
      connectDialog.classList.remove('hidden');
    } else {
      dashboard.classList.remove('hidden');
    }
  } else if (tab === 'settings') {
    settingsPage.classList.remove('hidden');
    renderSettingsContent();
  } else if (tab === 'tools') {
    toolsPage?.classList.remove('hidden');
    renderSpoolCalc();
  } else if (tab === 'help' || tab === 'debug') {
    helpPage?.classList.remove('hidden');
    bindHelpSubtabs();
    renderAbout(lastBuildStamp);
    renderHelp();
    switchHelpSubtab(tab === 'debug' ? 'debug' : 'help');
  }
}

/**
 * The last stamp the service reported, kept so the About panel can be drawn on tab
 * open rather than only when a broadcast happens to arrive.
 */
let lastBuildStamp: BuildStampish | null = null;

/** Called from the service-status renderer on every `service_status` broadcast. */
export function setBuildStamp(stamp: BuildStampish | null | undefined): void {
  lastBuildStamp = stamp ?? null;
  renderAbout(lastBuildStamp);
}

/** Render settings content into the settings page (called on tab switch) */
export function renderSettingsContent(): void {
  const content = document.getElementById('settings-content');
  if (!content) return;
  if (settingsRendered) return;
  settingsRendered = true;

  buildSettingsHTML(content);
}

function buildSettingsHTML(content: HTMLElement): void {
  currentLayout = loadCardLayout();

  /**
   * One row per card: visible, width, position.
   *
   * The panel dropdown is gone with the sidebar. It used to conflate two decisions —
   * picking "sidebar" also picked narrow, and there was no way to have a narrow card
   * further down the page. Width is its own control now.
   */
  function buildCardRows(order: string[]): string {
    return order
      .map((id, index) => {
        const name = CARD_NAMES[id] || id;
        const isHidden = currentLayout.hidden.includes(id);
        const width = widthOf(currentLayout, id);
        const first = index === 0;
        const last = index === order.length - 1;
        return `
        <div class="settings-card-row${isHidden ? ' settings-card-row-hidden' : ''}" data-card-id="${id}">
          <span class="settings-card-index" aria-hidden="true">${index + 1}</span>
          <label class="settings-card-label">
            <input type="checkbox" class="settings-card-visible" data-card-id="${id}" ${isHidden ? '' : 'checked'}>
            <span>${name}</span>
          </label>
          <select class="settings-card-width log-select" data-card-id="${id}" aria-label="Width">
            ${CARD_WIDTHS.map(
              (w) =>
                `<option value="${w}" ${w === width ? 'selected' : ''}>${CARD_WIDTH_LABELS[w]}</option>`,
            ).join('')}
          </select>
          <span class="settings-card-move">
            <button class="btn btn-sm btn-ghost settings-move-up" data-card-id="${id}" title="Move up" aria-label="Move ${id} up" ${first ? 'disabled' : ''}>${iconSolo('moveUp')}</button>
            <button class="btn btn-sm btn-ghost settings-move-down" data-card-id="${id}" title="Move down" aria-label="Move ${id} down" ${last ? 'disabled' : ''}>${iconSolo('moveDown')}</button>
          </span>
        </div>
      `;
      })
      .join('');
  }

  content.innerHTML = `
    <section class="settings-section">
      <h3>Appearance</h3>
      <p class="settings-hint">Auto follows your operating system's light/dark setting.</p>
      <div class="settings-row">
        <label for="settings-theme">Theme</label>
        <select id="settings-theme" class="log-select">
          <option value="auto">Auto</option>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </div>
      <p class="settings-hint">Relative log timestamps read as &ldquo;2m ago&rdquo; instead of a clock. The exact time stays on hover. Absolute is the default, because it is what you need when comparing against <code>journalctl</code>, the printer&rsquo;s display or someone else&rsquo;s screenshot.</p>
      <div class="settings-row">
        <label for="settings-relative-time">Relative log timestamps</label>
        <input type="checkbox" id="settings-relative-time">
      </div>
    </section>

    <section class="settings-section">
      <h3>Alerts</h3>
      <p class="settings-hint">Play a sound when a print finishes, fails, or hits a critical error. Off by default. Only events arriving live make a sound — reconnecting never replays old ones.</p>
      <div class="settings-row">
        <label for="settings-alert-sound">Audible alerts</label>
        <input type="checkbox" id="settings-alert-sound">
      </div>
      <div class="settings-row">
        <label for="settings-alert-volume">Volume</label>
        <input type="range" id="settings-alert-volume" min="0" max="100" step="5">
      </div>
      <div class="settings-actions">
        <button id="settings-alert-test" class="btn btn-sm btn-ghost">Test sound</button>
      </div>
      <div id="settings-alert-status" class="settings-hint"></div>
    </section>

    <section class="settings-section">
      <h3>Dashboard layout</h3>
      <p class="settings-hint">
        The dashboard is one grid, in this order. Untick a card to hide it, and set how
        much of a row each one takes — <strong>Compact</strong> is a quarter of a wide
        screen, <strong>Wide</strong> a half, <strong>Full</strong> the whole row. Narrow
        screens collapse everything to one column regardless.
      </p>
      <div id="settings-card-list" class="settings-card-list">
        ${buildCardRows(currentLayout.order)}
      </div>
      <div class="settings-actions">
        <button id="settings-reset-layout" class="btn btn-sm btn-ghost">Reset to default</button>
      </div>
    </section>

    <section class="settings-section">
      <h3>Telegram</h3>
      <div id="settings-telegram" class="settings-telegram">
        <p class="settings-hint">Telegram settings are configured via environment variables in <code>.env</code> and require a service restart.</p>
        <div id="settings-telegram-status"></div>
      </div>
    </section>

    <section class="settings-section">
      <h3>AI Local Labels</h3>
      <p class="settings-hint">Customize the CLIP/SigLIP classification labels, their severity types, and detection thresholds.</p>
      <div id="settings-ai-labels">
        <div class="settings-hint">Loading...</div>
      </div>
    </section>
  `;

  // Bind card visibility toggles
  content.querySelectorAll('.settings-card-visible').forEach((cb) => {
    cb.addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement;
      const cardId = input.dataset.cardId!;
      if (input.checked) {
        currentLayout.hidden = currentLayout.hidden.filter((h) => h !== cardId);
      } else {
        if (!currentLayout.hidden.includes(cardId)) {
          currentLayout.hidden.push(cardId);
        }
      }
      saveCardLayout(currentLayout);
      applyCardLayout();
    });
  });

  // Width, which replaced the sidebar/main panel selector.
  content.querySelectorAll('.settings-card-width').forEach((sel) => {
    sel.addEventListener('change', (e) => {
      const select = e.target as HTMLSelectElement;
      const cardId = select.dataset.cardId;
      if (!cardId) return;
      currentLayout.width[cardId] = select.value as CardWidth;
      saveCardLayout(currentLayout);
      applyCardLayout();
      // No re-render: changing a width does not move anything in this list, and
      // rebuilding it would throw away the focus the user is holding on the select.
    });
  });

  /**
   * Move a card one place in the single order list.
   *
   * The re-render afterwards is what keeps the row numbers and the disabled state of
   * the first/last buttons honest — both are derived from position.
   */
  const move = (cardId: string, delta: -1 | 1): void => {
    const list = currentLayout.order;
    const idx = list.indexOf(cardId);
    const next = idx + delta;
    if (idx < 0 || next < 0 || next >= list.length) return;
    [list[idx], list[next]] = [list[next], list[idx]];
    saveCardLayout(currentLayout);
    applyCardLayout();
    settingsRendered = false;
    renderSettingsContent();
    // Keep the keyboard on the button that was just pressed, which has moved with the
    // row — otherwise a second press needs a fresh tab-hunt down the list.
    const selector = delta < 0 ? '.settings-move-up' : '.settings-move-down';
    const again = document.querySelector(
      `${selector}[data-card-id="${cardId}"]`,
    ) as HTMLElement | null;
    again?.focus();
  };

  content.querySelectorAll('.settings-move-up').forEach((btn) => {
    btn.addEventListener('click', () => move((btn as HTMLElement).dataset.cardId ?? '', -1));
  });
  content.querySelectorAll('.settings-move-down').forEach((btn) => {
    btn.addEventListener('click', () => move((btn as HTMLElement).dataset.cardId ?? '', 1));
  });

  // Reset button
  const themeSelect = content.querySelector('#settings-theme') as HTMLSelectElement | null;
  if (themeSelect) {
    themeSelect.value = getThemeChoice();
    themeSelect.addEventListener('change', () => {
      if (isThemeChoice(themeSelect.value)) setThemeChoice(themeSelect.value);
    });
  }

  // ---- Relative log timestamps (ELEG-45) ----
  const relTime = content.querySelector('#settings-relative-time') as HTMLInputElement | null;
  if (relTime) {
    relTime.checked = loadUISettings().relativeTimestamps;
    relTime.addEventListener('change', () => {
      saveUISettings({ relativeTimestamps: relTime.checked });
      // Apply immediately rather than waiting up to a second for the next tick — and
      // note this rewrites the existing spans in place, so the log is not re-rendered
      // and the scroll position and expanded rows survive the switch.
      refreshTimestamps();
    });
  }

  // ---- Audible alerts (ELEG-46) ----
  const alertToggle = content.querySelector('#settings-alert-sound') as HTMLInputElement | null;
  const alertVolume = content.querySelector('#settings-alert-volume') as HTMLInputElement | null;
  const alertTest = content.querySelector('#settings-alert-test') as HTMLButtonElement | null;
  const alertStatus = content.querySelector('#settings-alert-status') as HTMLElement | null;

  if (alertToggle && alertVolume) {
    const settings = loadUISettings();
    alertToggle.checked = settings.alertSound;
    alertVolume.value = String(Math.round(settings.alertVolume * 100));

    alertToggle.addEventListener('change', () => {
      saveUISettings({ alertSound: alertToggle.checked });
    });
    alertVolume.addEventListener('change', () => {
      saveUISettings({ alertVolume: Number(alertVolume.value) / 100 });
    });
  }

  if (alertTest && alertStatus) {
    alertTest.addEventListener('click', async () => {
      // The test button exists because otherwise the only way to find out whether this
      // works is to wait for a failed print (ELEG-46). It reports the blocked state
      // explicitly rather than appearing to do nothing.
      const state = await playAlert('success');
      if (state === 'blocked') {
        alertStatus.textContent =
          'The browser is blocking audio for this page. Interact with the page (click anywhere), then try again.';
      } else if (state === 'unsupported') {
        alertStatus.textContent = 'This browser has no Web Audio support, so alerts cannot play.';
      } else {
        alertStatus.textContent = 'Played.';
      }
    });
  }

  content.querySelector('#settings-reset-layout')?.addEventListener('click', () => {
    // Confirmed because it discards arranging work and cannot be undone. Scoped to the
    // layout key alone: chart resolution, log filters and camera selection live in a
    // separate store (`ui-settings.ts`) and are untouched — which is the whole reason
    // to have this rather than telling people to clear site data (ELEG-44).
    if (
      !confirm(
        'Reset the dashboard layout to its default?\n\n' +
          'Card order, widths, and hidden and collapsed cards are all restored. ' +
          'Other settings — chart resolution, log filters, camera selection — are kept.',
      )
    ) {
      return;
    }
    currentLayout = defaultCardLayout();
    saveCardLayout(currentLayout);
    applyCardLayout();
    settingsRendered = false;
    renderSettingsContent();
    toast('Layout reset to default', 'success');
  });

  // Load telegram status
  loadTelegramStatus();
  // Load AI label configs
  loadAILabels();
}

async function loadTelegramStatus(): Promise<void> {
  const container = $('settings-telegram-status');
  if (!container) return;

  try {
    const res = await fetchTimeout('/api/config/telegram');
    if (!res.ok) {
      container.innerHTML = '<span class="settings-hint">Could not load Telegram config</span>';
      return;
    }
    const data = (await res.json()) as {
      enabled: boolean;
      chatId: string;
      progressInterval: number;
      botUsername?: string;
    };

    if (!data.enabled) {
      container.innerHTML = `
        <div class="settings-telegram-row">
          <span class="ai-config-off">Disabled</span>
          <span class="settings-hint">Set <code>TELEGRAM_BOT_TOKEN</code> and <code>TELEGRAM_CHAT_ID</code> in <code>.env</code></span>
        </div>
      `;
      return;
    }

    container.innerHTML = `
      <div class="settings-telegram-row">
        <span class="ai-config-on">Enabled</span>
        ${data.botUsername ? `<span class="settings-hint">Bot: @${data.botUsername}</span>` : ''}
      </div>
      <div class="settings-telegram-field">
        <label>Chat ID</label>
        <input type="text" class="settings-input" value="${data.chatId}" disabled>
      </div>
      <div class="settings-telegram-field">
        <label>Progress interval</label>
        <div class="settings-input-row">
          <input type="number" id="settings-tg-progress" class="settings-input" value="${data.progressInterval}" min="5" max="50" step="5">
          <span class="settings-hint">%</span>
          <button id="settings-tg-save" class="btn btn-sm btn-primary">Save</button>
        </div>
      </div>
    `;

    container.querySelector('#settings-tg-save')?.addEventListener('click', async () => {
      const input = container.querySelector('#settings-tg-progress') as HTMLInputElement;
      const val = parseInt(input.value, 10);
      if (isNaN(val) || val < 5 || val > 50) {
        toast('Invalid interval (5-50)', 'error');
        return;
      }
      try {
        const saveRes = await fetchTimeout('/api/config/telegram', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ progressInterval: val }),
        });
        if (saveRes.ok) {
          toast('Telegram settings saved', 'success');
        } else {
          toast('Failed to save', 'error');
        }
      } catch {
        toast('Network error', 'error');
      }
    });
  } catch {
    container.innerHTML = '<span class="settings-hint">Could not reach service</span>';
  }
}

// ---- AI Label Configuration ----

interface AILabelConfig {
  label: string;
  issueType: string;
  severity: 'ok' | 'warning' | 'critical';
  warnThreshold: number;
  critThreshold: number;
  group: string;
}

async function loadAILabels(): Promise<void> {
  const container = $('settings-ai-labels');
  if (!container) return;

  try {
    const res = await fetchTimeout('/api/config/ai-labels');
    if (!res.ok) {
      container.innerHTML = '<span class="settings-hint">Could not load AI label config</span>';
      return;
    }
    const data = (await res.json()) as { labels: AILabelConfig[]; enabled: boolean };

    if (!data.enabled) {
      container.innerHTML = `
        <div class="settings-hint">AI local classification is not enabled. Set <code>AI_ENABLED=true</code> and <code>AI_LOCAL_ENABLED=true</code> in <code>.env</code>.</div>
      `;
      return;
    }

    renderAILabelEditor(container, data.labels);
  } catch {
    container.innerHTML = '<span class="settings-hint">Could not reach service</span>';
  }
}

function renderAILabelEditor(container: HTMLElement, labels: AILabelConfig[]): void {
  const rows = labels
    .map((lc, idx) => {
      const sevOpts = ['ok', 'warning', 'critical']
        .map(
          (s) =>
            `<option value="${s}" ${lc.severity === s ? 'selected' : ''}>${s.toUpperCase()}</option>`,
        )
        .join('');
      const groupOpts = [
        'Print in Progress',
        'Spaghetti/Failure',
        'Empty Bed',
        'Paused/Stopped',
        'Other',
      ]
        .map((g) => `<option value="${g}" ${lc.group === g ? 'selected' : ''}>${g}</option>`)
        .join('');
      return `
      <div class="ai-label-config-row" data-idx="${idx}">
        <div class="ai-label-config-field ai-label-config-label">
          <label>Label</label>
          <textarea class="settings-input ai-lc-label" rows="2" data-idx="${idx}" title="${lc.label}">${lc.label}</textarea>
        </div>
        <div class="ai-label-config-field">
          <label>Issue Type</label>
          <input type="text" class="settings-input ai-lc-issue" value="${lc.issueType}" data-idx="${idx}" placeholder="e.g. spaghetti">
        </div>
        <div class="ai-label-config-field">
          <label>Group</label>
          <select class="settings-input ai-lc-group" data-idx="${idx}">${groupOpts}</select>
        </div>
        <div class="ai-label-config-field">
          <label>Severity</label>
          <select class="settings-input ai-lc-severity" data-idx="${idx}">${sevOpts}</select>
        </div>
        <div class="ai-label-config-field">
          <label>Warn @</label>
          <input type="number" class="settings-input ai-lc-warn" value="${lc.warnThreshold}" data-idx="${idx}" min="0" max="1" step="0.05">
        </div>
        <div class="ai-label-config-field">
          <label>Crit @</label>
          <input type="number" class="settings-input ai-lc-crit" value="${lc.critThreshold}" data-idx="${idx}" min="0" max="1" step="0.05">
        </div>
        <div class="ai-label-config-field ai-label-config-delete">
          <label>&nbsp;</label>
          <button class="btn btn-sm btn-ghost ai-lc-delete" data-idx="${idx}" title="Delete this label" aria-label="Delete this label">${iconSolo('close')}</button>
        </div>
      </div>
    `;
    })
    .join('');

  container.innerHTML = `
    <div class="ai-label-config-list">${rows}</div>
    <div class="settings-actions">
      <button id="ai-labels-add" class="btn btn-sm btn-ghost">${icon('add')} Add Label</button>
      <button id="ai-labels-save" class="btn btn-sm btn-primary">Save Labels</button>
      <button id="ai-labels-reset" class="btn btn-sm btn-ghost">Reset to Defaults</button>
    </div>
  `;

  // Delete label buttons
  container.querySelectorAll('.ai-lc-delete').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = parseInt((btn as HTMLElement).dataset.idx!, 10);
      const current = collectLabelConfigs(container);
      if (!current) return;
      current.splice(idx, 1);
      renderAILabelEditor(container, current);
    });
  });

  // Add label button
  container.querySelector('#ai-labels-add')?.addEventListener('click', () => {
    const current = collectLabelConfigs(container);
    if (!current) return;
    current.push({
      label: '',
      issueType: 'ok',
      severity: 'ok',
      warnThreshold: 0.5,
      critThreshold: 0.8,
      group: 'Other',
    });
    renderAILabelEditor(container, current);
  });

  container.querySelector('#ai-labels-save')?.addEventListener('click', async () => {
    const updated = collectLabelConfigs(container);
    if (!updated) return;
    if (updated.length === 0) {
      toast('Add at least one label', 'error');
      return;
    }
    const emptyIdx = updated.findIndex((l) => !l.label);
    if (emptyIdx >= 0) {
      toast(`Label ${emptyIdx + 1} cannot be empty`, 'error');
      return;
    }
    try {
      const res = await fetchTimeout('/api/config/ai-labels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ labels: updated }),
      });
      if (res.ok) {
        toast('AI label config saved', 'success');
      } else {
        const err = await res.json().catch(() => ({ error: 'Unknown' }));
        toast(`Save failed: ${(err as { error: string }).error}`, 'error');
      }
    } catch {
      toast('Network error', 'error');
    }
  });

  container.querySelector('#ai-labels-reset')?.addEventListener('click', async () => {
    if (!confirm('Reset all AI label configs to defaults?')) return;
    try {
      const res = await fetchTimeout('/api/config/ai-labels', { method: 'DELETE' });
      if (res.ok) {
        const data = (await res.json()) as { labels: AILabelConfig[] };
        renderAILabelEditor(container, data.labels);
        toast('AI labels reset to defaults', 'success');
      } else {
        toast('Reset failed', 'error');
      }
    } catch {
      toast('Network error', 'error');
    }
  });
}

function collectLabelConfigs(container: HTMLElement): AILabelConfig[] | null {
  const rows = container.querySelectorAll('.ai-label-config-row');
  const configs: AILabelConfig[] = [];
  for (const row of rows) {
    const idx = (row as HTMLElement).dataset.idx!;
    const label = (
      row.querySelector(`.ai-lc-label[data-idx="${idx}"]`) as HTMLTextAreaElement
    )?.value.trim();
    const issueType = (
      row.querySelector(`.ai-lc-issue[data-idx="${idx}"]`) as HTMLInputElement
    )?.value.trim();
    const group =
      (row.querySelector(`.ai-lc-group[data-idx="${idx}"]`) as HTMLSelectElement)?.value || 'Other';
    const severity = (row.querySelector(`.ai-lc-severity[data-idx="${idx}"]`) as HTMLSelectElement)
      ?.value as 'ok' | 'warning' | 'critical';
    const warnThreshold = parseFloat(
      (row.querySelector(`.ai-lc-warn[data-idx="${idx}"]`) as HTMLInputElement)?.value,
    );
    const critThreshold = parseFloat(
      (row.querySelector(`.ai-lc-crit[data-idx="${idx}"]`) as HTMLInputElement)?.value,
    );

    // Allow empty labels only for newly added rows (they'll be filled in)
    configs.push({
      label: label || '',
      issueType: issueType || 'ok',
      severity: severity || 'ok',
      warnThreshold: isNaN(warnThreshold) ? 0.5 : warnThreshold,
      critThreshold: isNaN(critThreshold) ? 0.8 : critThreshold,
      group: group || 'Other',
    });
  }
  return configs;
}
