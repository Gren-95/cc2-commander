/** Settings panel — persistent card layout + Telegram config */

import { toggleState } from './state-classes';
import { readMigrated } from './storage-migration';
import { $, fetchTimeout } from './helpers';
import {
  CARD_WIDTHS,
  CARD_WIDTH_UTILITIES,
  type CardLayout,
  type CardWidth,
  defaultCardLayout,
  normaliseCardLayout,
  widthOf,
} from './card-layout';
import { toast } from './toast';
import { renderSpoolCalc } from './spool-calc';
import { renderDryer } from './dryer-panel';
import { renderHelp } from './help';
import { renderAbout } from './about';
import { bindSubtabs, switchSubtab } from './subtabs';
import { isCardVisible, renderFocusRail, watchBreakpoint } from './mobile-focus';
import { getThemeChoice, setThemeChoice, isThemeChoice } from './theme';
import { playAlert } from './alert-sound';
import { refreshTimestamps } from './relative-time';
import { loadUISettings, saveUISettings } from './ui-settings';

const STORAGE_KEY = 'cc2-commander-card-layout';
/** The pre-rename name. See `storage-migration.ts` — a renamed key is a deleted key. */
const LEGACY_STORAGE_KEY = 'elegoo-web-card-layout';

// ---- Card layout settings (localStorage) ----
//
// What the layout *is* lives in `card-layout.ts`, free of DOM and storage so it can be
// unit-tested (ELEG-44). This half owns persistence and the DOM.

function loadCardLayout(): CardLayout {
  try {
    const raw = readMigrated(STORAGE_KEY, LEGACY_STORAGE_KEY);
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
/** Read the live layout. Mutate it only through `updateCardLayout`. */
export function getCardLayout(): CardLayout {
  return currentLayout;
}

/**
 * Change the layout, persist it and redraw — the single write path.
 *
 * `ui/dashboard-edit.ts` drives drag, resize and dismiss through this rather than
 * touching storage itself. Two owners of one key is how the settings panel and the
 * dashboard would come to disagree about which cards exist.
 */
export function updateCardLayout(mutate: (layout: CardLayout) => void): void {
  mutate(currentLayout);
  saveCardLayout(currentLayout);
  applyCardLayout();
}

export function toggleCardCollapse(cardId: string): void {
  const idx = currentLayout.collapsed.indexOf(cardId);
  if (idx >= 0) {
    currentLayout.collapsed.splice(idx, 1);
  } else {
    currentLayout.collapsed.push(cardId);
  }
  const card = document.getElementById(cardId);
  if (card) toggleState(card, 'collapsed', currentLayout.collapsed.includes(cardId));
  saveCardLayout(currentLayout);
}

/** Apply card order, panel assignment, visibility, and collapse to the DOM */
export function applyCardLayout(): void {
  const grid = document.getElementById('dashboard-grid');
  if (!grid) return;

  // Re-run this whole pass when the viewport crosses the phone breakpoint, so a rotate
  // cannot leave a focus applied with no rail to undo it. Idempotent.
  watchBreakpoint(applyCardLayout);

  // Backfilling a newly added card used to happen here, on the in-memory copy only —
  // so the settings panel, which re-reads from storage, never saw it. It is part of
  // `normaliseCardLayout` now, which both paths go through (ELEG-44).

  for (const id of currentLayout.order) {
    const card = document.getElementById(id);
    if (!card) continue;
    // appendChild on an element already in the grid MOVES it, so iterating the saved
    // order is all the reordering there is.
    grid.appendChild(card);
    card.style.display = isCardVisible(currentLayout, id) ? '' : 'none';
    toggleState(card, 'collapsed', currentLayout.collapsed.includes(id));
    applyCardWidth(card, widthOf(currentLayout, id));
  }

  /*
   * The rail is part of the layout, not decoration: it lists the same cards in the
   * same order and has to be redrawn whenever either changes. Drawing it here means
   * one call site keeps the grid and the rail in step.
   */
  renderFocusRail(currentLayout, activeTab === 'dashboard');

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
  /*
   * Remove first, then add — and only remove what the chosen width does NOT want.
   *
   * All three widths share `col-[span_12]` as their mobile-first base, so a naive
   * "toggle each width on or off in turn" adds that class for the selected width and
   * then strips it again while switching the other two off. Every card ended up with
   * `grid-column: auto` on a phone, 26px wide.
   */
  const wanted = new Set(CARD_WIDTH_UTILITIES[width].split(' ').filter(Boolean));
  for (const w of CARD_WIDTHS) {
    card.classList.toggle(`card-w-${w}`, w === width);
    if (w === width) continue;
    for (const u of CARD_WIDTH_UTILITIES[w].split(' ')) {
      if (u && !wanted.has(u)) card.classList.remove(u);
    }
  }
  for (const u of wanted) card.classList.add(u);
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
/**
 * Show one section of the About page.
 *
 * Debug used to be a main tab of its own. It is a sub-tab here because it belongs with
 * Help — both answer "what is this thing doing?" — but it must not be *stacked under*
 * Help, whose API reference runs to several screens.
 *
 * A thin wrapper over the shared `switchSubtab` so `switchToTab('debug')` still has
 * something to call.
 */
export type HelpSubtab = 'help' | 'debug';

export function switchHelpSubtab(sub: HelpSubtab): void {
  switchSubtab('help', sub);
}

/** Which main tab is showing. The focus rail belongs to the dashboard alone. */
let activeTab: 'dashboard' | 'settings' | 'tools' | 'help' | 'debug' = 'dashboard';

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
  activeTab = tab;
  // Hide the rail immediately on the way out; `applyCardLayout` brings it back.
  renderFocusRail(currentLayout, tab === 'dashboard');

  tabs.forEach((t) => {
    const el = t as HTMLElement;
    toggleState(el, 'active', el.dataset.tab === mainTab);
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
    /*
     * Both tools render regardless of which is showing: the spool calculator draws into
     * a canvas that needs a laid-out element, and the dryer owns a one-second ticker
     * that must keep running while the calculator is in front. Only the panels are
     * swapped.
     */
    bindSubtabs('tools');
    renderSpoolCalc();
    renderDryer();
  } else if (tab === 'help' || tab === 'debug') {
    helpPage?.classList.remove('hidden');
    renderAbout();
    renderHelp();
    bindSubtabs('help');
    // An explicit `switchToTab('debug')` overrides whatever was last remembered.
    if (tab === 'debug') switchSubtab('help', 'debug');
  }
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

  content.innerHTML = `
    <section class="mb-5 [&_h3]:text-[13px] [&_h3]:font-semibold [&_h3]:text-fg-soft [&_h3]:uppercase [&_h3]:tracking-[0.5px] [&_h3]:mb-2">
      <h3>Appearance</h3>
      <p class="text-[0.8rem] text-fg-muted [margin:0_0_8px] [&_code]:bg-input [&_code]:[padding:1px_4px] [&_code]:rounded-[3px] [&_code]:text-[0.75rem]">Auto follows your operating system's light/dark setting.</p>
      <div class="flex items-center gap-3 [padding:6px_0] [&_label]:text-fg-soft [&_label]:text-[13px] [&_label]:min-w-30">
        <label for="settings-theme">Theme</label>
        <select id="settings-theme" class="bg-input border border-line rounded-[4px] text-fg [padding:4px_8px] text-[0.8rem] [.spool-calc-inputs_&]:w-full [.spool-calc-inputs_&]:[padding:6px_10px] [.spool-calc-inputs_&]:text-[14px]">
          <option value="auto">Auto</option>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </div>
      <p class="text-[0.8rem] text-fg-muted [margin:0_0_8px] [&_code]:bg-input [&_code]:[padding:1px_4px] [&_code]:rounded-[3px] [&_code]:text-[0.75rem]">Relative log timestamps read as &ldquo;2m ago&rdquo; instead of a clock. The exact time stays on hover. Absolute is the default, because it is what you need when comparing against <code>journalctl</code>, the printer&rsquo;s display or someone else&rsquo;s screenshot.</p>
      <div class="flex items-center gap-3 [padding:6px_0] [&_label]:text-fg-soft [&_label]:text-[13px] [&_label]:min-w-30">
        <label for="settings-relative-time">Relative log timestamps</label>
        <input type="checkbox" id="settings-relative-time">
      </div>
    </section>

    <section class="mb-5 [&_h3]:text-[13px] [&_h3]:font-semibold [&_h3]:text-fg-soft [&_h3]:uppercase [&_h3]:tracking-[0.5px] [&_h3]:mb-2">
      <h3>Alerts</h3>
      <p class="text-[0.8rem] text-fg-muted [margin:0_0_8px] [&_code]:bg-input [&_code]:[padding:1px_4px] [&_code]:rounded-[3px] [&_code]:text-[0.75rem]">Play a sound when a print finishes, fails, or hits a critical error. Off by default. Only events arriving live make a sound — reconnecting never replays old ones.</p>
      <div class="flex items-center gap-3 [padding:6px_0] [&_label]:text-fg-soft [&_label]:text-[13px] [&_label]:min-w-30">
        <label for="settings-alert-sound">Audible alerts</label>
        <input type="checkbox" id="settings-alert-sound">
      </div>
      <div class="flex items-center gap-3 [padding:6px_0] [&_label]:text-fg-soft [&_label]:text-[13px] [&_label]:min-w-30">
        <label for="settings-alert-volume">Volume</label>
        <input type="range" id="settings-alert-volume" min="0" max="100" step="5">
      </div>
      <div class="mt-2 flex gap-2">
        <button id="settings-alert-test" class="inline-flex items-center justify-center [padding:4px_10px] border border-line rounded-chip text-[11px] font-medium cursor-pointer [transition:all_0.15s] text-fg-soft bg-transparent max-[800px]:[padding:6px_12px] max-[800px]:text-[13px] pointer-coarse:min-h-11 hover:[filter:brightness(1.15)] active:[transform:scale(0.97)] [.spool-actions_&]:text-[9px] [.spool-actions_&]:[padding:2px_8px] [.spool-actions_&]:rounded-[10px] [.file-popover-actions_&]:text-[12px] [.file-popover-actions_&]:[padding:4px_10px] max-[800px]:[.file-actions_&]:min-h-9 max-[800px]:[.file-actions_&]:min-w-9 max-[800px]:[.file-actions_&]:[padding:6px_8px] [.settings-card-move_&]:[padding:1px_6px] [.settings-card-move_&]:text-[10px] [.settings-card-move_&]:leading-[1] [.ai-label-config-delete_&]:text-bad [.ai-label-config-delete_&]:[padding:4px_8px] [.ai-label-config-delete_&]:text-[14px] [.ai-label-config-delete_&]:leading-[1] hover:[.ai-label-config-delete_&]:bg-[rgba(239,_83,_80,_0.15)]">Test sound</button>
      </div>
      <div id="settings-alert-status" class="text-[0.8rem] text-fg-muted [margin:0_0_8px] [&_code]:bg-input [&_code]:[padding:1px_4px] [&_code]:rounded-[3px] [&_code]:text-[0.75rem]"></div>
    </section>

    <section class="mb-5 [&_h3]:text-[13px] [&_h3]:font-semibold [&_h3]:text-fg-soft [&_h3]:uppercase [&_h3]:tracking-[0.5px] [&_h3]:mb-2">
      <h3>Dashboard layout</h3>
      <p class="text-[0.8rem] text-fg-muted [margin:0_0_8px] [&_code]:bg-input [&_code]:[padding:1px_4px] [&_code]:rounded-[3px] [&_code]:text-[0.75rem]">
        The dashboard is one grid, in this order. Untick a card to hide it, and set how
        much of a row each one takes — <strong>Compact</strong> is a quarter of a wide
        screen, <strong>Wide</strong> a half, <strong>Full</strong> the whole row. Narrow
        screens collapse everything to one column regardless.
      </p>
      <p class="text-[13px] text-fg-soft leading-[1.5] mb-3">
        Arrange it on the dashboard itself: the layout button in the header turns on edit
        mode, where you drag cards into order, drag a corner to resize, and use × to hide
        one. Hidden cards go to a tray you can put them back from.
      </p>
      <div class="mt-2 flex gap-2">
        <button id="settings-reset-layout" class="inline-flex items-center justify-center [padding:4px_10px] border border-line rounded-chip text-[11px] font-medium cursor-pointer [transition:all_0.15s] text-fg-soft bg-transparent max-[800px]:[padding:6px_12px] max-[800px]:text-[13px] pointer-coarse:min-h-11 hover:[filter:brightness(1.15)] active:[transform:scale(0.97)] [.spool-actions_&]:text-[9px] [.spool-actions_&]:[padding:2px_8px] [.spool-actions_&]:rounded-[10px] [.file-popover-actions_&]:text-[12px] [.file-popover-actions_&]:[padding:4px_10px] max-[800px]:[.file-actions_&]:min-h-9 max-[800px]:[.file-actions_&]:min-w-9 max-[800px]:[.file-actions_&]:[padding:6px_8px] [.settings-card-move_&]:[padding:1px_6px] [.settings-card-move_&]:text-[10px] [.settings-card-move_&]:leading-[1] [.ai-label-config-delete_&]:text-bad [.ai-label-config-delete_&]:[padding:4px_8px] [.ai-label-config-delete_&]:text-[14px] [.ai-label-config-delete_&]:leading-[1] hover:[.ai-label-config-delete_&]:bg-[rgba(239,_83,_80,_0.15)]">Reset to default</button>
      </div>
    </section>

    <section class="mb-5 [&_h3]:text-[13px] [&_h3]:font-semibold [&_h3]:text-fg-soft [&_h3]:uppercase [&_h3]:tracking-[0.5px] [&_h3]:mb-2">
      <h3>Telegram</h3>
      <div id="settings-telegram" class="">
        <p class="text-[0.8rem] text-fg-muted [margin:0_0_8px] [&_code]:bg-input [&_code]:[padding:1px_4px] [&_code]:rounded-[3px] [&_code]:text-[0.75rem]">Telegram settings are configured via environment variables in <code>.env</code> and require a service restart.</p>
        <div id="settings-telegram-status"></div>
      </div>
    </section>
  `;

  // Bind card visibility toggles

  // Width, which replaced the sidebar/main panel selector.

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
}

async function loadTelegramStatus(): Promise<void> {
  const container = $('settings-telegram-status');
  if (!container) return;

  try {
    const res = await fetchTimeout('/api/config/telegram');
    if (!res.ok) {
      container.innerHTML =
        '<span class="text-[0.8rem] text-fg-muted [margin:0_0_8px] [&_code]:bg-input [&_code]:[padding:1px_4px] [&_code]:rounded-[3px] [&_code]:text-[0.75rem]">Could not load Telegram config</span>';
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
        <div class="flex items-center gap-2 mb-2">
          <span class="text-fg-muted">Disabled</span>
          <span class="text-[0.8rem] text-fg-muted [margin:0_0_8px] [&_code]:bg-input [&_code]:[padding:1px_4px] [&_code]:rounded-[3px] [&_code]:text-[0.75rem]">Set <code>TELEGRAM_BOT_TOKEN</code> and <code>TELEGRAM_CHAT_ID</code> in <code>.env</code></span>
        </div>
      `;
      return;
    }

    container.innerHTML = `
      <div class="flex items-center gap-2 mb-2">
        <span class="text-[#4caf50] font-semibold">Enabled</span>
        ${data.botUsername ? `<span class="text-[0.8rem] text-fg-muted [margin:0_0_8px] [&_code]:bg-input [&_code]:[padding:1px_4px] [&_code]:rounded-[3px] [&_code]:text-[0.75rem]">Bot: @${data.botUsername}</span>` : ''}
      </div>
      <div class="mb-2 [&_label]:block [&_label]:text-[0.8rem] [&_label]:text-fg-muted [&_label]:mb-1">
        <label>Chat ID</label>
        <input type="text" class="bg-input border border-line rounded-chip text-[var(--text)] [padding:6px_10px] text-[0.85rem] w-full disabled:opacity-[0.5] [.settings-input-row_&]:w-20 [.ai-label-config-field_&]:text-[0.8rem] [.ai-label-config-field_&]:[padding:4px_6px] [.ai-label-config-field_&]:resize-y [.ai-label-config-field_&]:min-h-9 [.ai-label-config-field_&]:font-sans" value="${data.chatId}" disabled>
      </div>
      <div class="mb-2 [&_label]:block [&_label]:text-[0.8rem] [&_label]:text-fg-muted [&_label]:mb-1">
        <label>Progress interval</label>
        <div class="settings-input-row flex items-center gap-2">
          <input type="number" id="settings-tg-progress" class="bg-input border border-line rounded-chip text-[var(--text)] [padding:6px_10px] text-[0.85rem] w-full disabled:opacity-[0.5] [.settings-input-row_&]:w-20 [.ai-label-config-field_&]:text-[0.8rem] [.ai-label-config-field_&]:[padding:4px_6px] [.ai-label-config-field_&]:resize-y [.ai-label-config-field_&]:min-h-9 [.ai-label-config-field_&]:font-sans" value="${data.progressInterval}" min="5" max="50" step="5">
          <span class="text-[0.8rem] text-fg-muted [margin:0_0_8px] [&_code]:bg-input [&_code]:[padding:1px_4px] [&_code]:rounded-[3px] [&_code]:text-[0.75rem]">%</span>
          <button id="settings-tg-save" class="inline-flex items-center justify-center [padding:4px_10px] border-0 rounded-chip text-[11px] font-medium cursor-pointer [transition:all_0.15s] text-white bg-accent max-[800px]:[padding:6px_12px] max-[800px]:text-[13px] pointer-coarse:min-h-11 hover:[filter:brightness(1.15)] active:[transform:scale(0.97)] [.spool-actions_&]:text-[9px] [.spool-actions_&]:[padding:2px_8px] [.spool-actions_&]:rounded-[10px] [.file-popover-actions_&]:text-[12px] [.file-popover-actions_&]:[padding:4px_10px] max-[800px]:[.file-actions_&]:min-h-9 max-[800px]:[.file-actions_&]:min-w-9 max-[800px]:[.file-actions_&]:[padding:6px_8px] [.settings-card-move_&]:[padding:1px_6px] [.settings-card-move_&]:text-[10px] [.settings-card-move_&]:leading-[1] [.ai-label-config-delete_&]:text-bad [.ai-label-config-delete_&]:[padding:4px_8px] [.ai-label-config-delete_&]:text-[14px] [.ai-label-config-delete_&]:leading-[1] [.print-dialog-footer_&]:min-w-25 hover:[.ai-label-config-delete_&]:bg-[rgba(239,_83,_80,_0.15)]">Save</button>
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
    container.innerHTML =
      '<span class="text-[0.8rem] text-fg-muted [margin:0_0_8px] [&_code]:bg-input [&_code]:[padding:1px_4px] [&_code]:rounded-[3px] [&_code]:text-[0.75rem]">Could not reach service</span>';
  }
}
