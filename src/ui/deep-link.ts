/**
 * Addressable tabs: `?tab=tools&subtab=spool`.
 *
 * Every view in this app was previously reachable only by clicking, which means none of
 * them could be linked, bookmarked, or opened directly — including by a screenshot
 * script, which had to click its way to each one and guess when it had arrived.
 *
 * ## Query string rather than a hash or a path
 *
 * A path (`/tools/spool`) would need the SPA fallback to answer it, and that fallback is
 * already the subject of one bug this session — `/api/canvas` was being served the
 * dashboard's HTML. A hash is not sent to the server at all, which is tidy, but it
 * collides with in-page anchors. A query string is unambiguous, survives a reload, and
 * the server never has to know about it.
 *
 * ## Reading and writing are deliberately asymmetric
 *
 * The URL is read ONCE, at startup, and then only written. It is not a source of truth
 * that the app watches: making it one means every tab change is a history entry, and a
 * dashboard you click around for ten minutes becomes ten minutes of Back presses. The
 * URL is replaced, never pushed, for the same reason.
 */

/**
 * Nothing is imported from `settings.ts` on purpose.
 *
 * `settings.ts` writes the URL through `updateDeepLink`, so importing `switchToTab`
 * back out of it would close a cycle — the same one `file-browsing.ts` was created to
 * break. Parsing is a pure function of the query string and the panels that exist;
 * `main.ts` owns both and does the switching.
 */

/** Tabs `switchToTab` accepts. `debug` is a section of About rather than a tab. */
const TABS = ['dashboard', 'settings', 'tools', 'help', 'debug'] as const;
type Tab = (typeof TABS)[number];

/** Which subtab group belongs to which tab, so `?subtab=` needs no group named. */
const SUBTAB_GROUP: Partial<Record<Tab, string>> = {
  tools: 'tools',
  help: 'help',
  debug: 'help',
};

function isTab(value: string | null): value is Tab {
  return value !== null && (TABS as readonly string[]).includes(value);
}

/**
 * Open whatever the URL asks for.
 *
 * Silent about nonsense: `?tab=banana` leaves you on the dashboard rather than showing
 * an error, because a bad link is not worth a dialog and the sensible fallback is
 * obvious. Returns what it applied, which is what the tests assert.
 */
export interface DeepLink {
  tab?: Tab;
  /** The group the subtab belongs to, so the caller need not re-derive it. */
  group?: string;
  subtab?: string;
}

/**
 * What the query string asks for, if anything.
 *
 * Pure: `available` is the list of panel names that exist in this build, which the
 * caller reads from the DOM. Silent about nonsense — `?tab=banana` yields nothing
 * rather than an error, because a bad link is not worth a dialog and the fallback (stay
 * where you are) is obvious.
 */
export function parseDeepLink(search: string, available: (group: string) => string[]): DeepLink {
  const params = new URLSearchParams(search);
  const link: DeepLink = {};

  const tab = params.get('tab');
  if (isTab(tab)) link.tab = tab;

  const subtab = params.get('subtab');
  // A subtab only means something inside a tab that has them, and only if that panel
  // exists here — `?subtab=spool` on the dashboard is a typo, not an instruction.
  const group = SUBTAB_GROUP[link.tab ?? 'dashboard'];
  if (subtab && group && available(group).includes(subtab)) {
    link.group = group;
    link.subtab = subtab;
  }

  return link;
}

/**
 * Put a subtab in the address bar, if it is the one on screen.
 *
 * `switchSubtab` runs for a group whenever its parent tab is opened — including to
 * restore a remembered panel — so writing unconditionally would let the About page's
 * group rewrite the URL while you are looking at Tools. The active tab is read from the
 * DOM rather than imported from `settings.ts`, which keeps this module importing nothing
 * and therefore incapable of closing a cycle.
 */
export function updateDeepLinkSubtab(group: string, subtab: string): void {
  const active = document.querySelector('.main-tab.active') as HTMLElement | null;
  const tab = active?.dataset.tab;
  if (!tab || SUBTAB_GROUP[tab as Tab] !== group) return;
  updateDeepLink(tab, subtab);
}

/**
 * Put the current view in the address bar.
 *
 * `replaceState`, never `pushState`: clicking between tabs is navigation within one
 * screen, not a journey, and turning it into history makes the Back button useless for
 * leaving the app. The dashboard is the default and is left out of the URL, so the bare
 * origin stays the canonical address.
 */
export function updateDeepLink(tab: string, subtab?: string): void {
  const url = new URL(location.href);

  if (tab === 'dashboard') url.searchParams.delete('tab');
  else url.searchParams.set('tab', tab);

  const group = SUBTAB_GROUP[tab as Tab];
  if (group && subtab) url.searchParams.set('subtab', subtab);
  else url.searchParams.delete('subtab');

  history.replaceState(
    null,
    '',
    url.searchParams.size ? `?${url.searchParams}` : location.pathname,
  );
}
