/**
 * The browser half of single-user auth.
 *
 * The session lives in an `HttpOnly` cookie, so this module never sees a token and has
 * nothing to store. It only ever asks the service two things — "is a password required,
 * and am I past it?" — and shows either the sign-in card or the dashboard.
 *
 * That is deliberate. A token in `localStorage` is readable by any script that ends up
 * on the page, and this page renders printer-supplied filenames and error strings; a
 * cookie the JavaScript cannot read is the one shape where an XSS bug does not also mean
 * a stolen credential.
 */

import { $ } from './helpers';

export interface AuthState {
  /** Whether the service is configured to require a password at all. */
  required: boolean;
  /** Whether this browser is past it. Always true when `required` is false. */
  authenticated: boolean;
}

/** Ask the service where we stand. Never throws — a dead service is "not signed in". */
export async function fetchAuthState(): Promise<AuthState> {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (!res.ok) return { required: true, authenticated: false };
    const data = (await res.json()) as { authRequired?: boolean; authenticated?: boolean };
    return {
      required: Boolean(data.authRequired),
      authenticated: Boolean(data.authenticated),
    };
  } catch {
    // Unreachable service. Treating it as "not signed in" is wrong-but-harmless: the
    // sign-in attempt then fails with the real network error, which is what to show.
    return { required: true, authenticated: false };
  }
}

export interface LoginOutcome {
  ok: boolean;
  /** Ready to display. Never echoes what the server said about *which* part was wrong. */
  message: string;
}

/**
 * Exchange a password for a session cookie.
 *
 * The 429 branch matters more than it looks: without it, a throttled user sees "invalid
 * credentials" while typing the right password, and concludes the password is wrong.
 */
export async function login(password: string): Promise<LoginOutcome> {
  let res: Response;
  try {
    res = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
  } catch {
    return { ok: false, message: 'Cannot reach the service. Is it running?' };
  }

  if (res.ok) return { ok: true, message: '' };

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('Retry-After') || 0);
    const minutes = Math.ceil(retryAfter / 60);
    return {
      ok: false,
      message: retryAfter
        ? `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`
        : 'Too many attempts. Try again later.',
    };
  }
  if (res.status === 400) {
    return { ok: false, message: 'This service has no password configured.' };
  }
  return { ok: false, message: 'Incorrect password.' };
}

/** Drop the session. Failure is ignored: the cookie is the server's to clear. */
export async function logout(): Promise<void> {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch {
    // Nothing useful to do — the reload below puts the user at the sign-in card anyway.
  }
}

/**
 * Everything that is not the sign-in card.
 *
 * On a phone the sign-in screen came up with the full app around it: the tab bar along
 * the bottom, the focus rail down the right — thirteen card buttons — and the header's
 * layout control. None of it does anything useful before you are signed in, the rail
 * overlapped the card and clipped the password field, and offering navigation on a login
 * screen invites the question of what it navigates to.
 *
 * Hidden by id rather than by a class on `<body>`: these are three unrelated elements
 * with no shared hook, and `hidden` is the mechanism the rest of the app already uses.
 */
const CHROME_IDS = ['main-tabs-bar', 'header-actions', 'mobile-focus-rail'];

/**
 * Show or hide the app's chrome around the sign-in card.
 *
 * The focus rail is rebuilt by `renderFocusRail` on every layout change, so hiding the
 * element is not enough on its own — `mobile-focus.ts` asks `isSignedOut()` before it
 * draws one.
 */
export function setChromeVisible(visible: boolean): void {
  signedOut = !visible;
  for (const id of CHROME_IDS) {
    document.getElementById(id)?.classList.toggle('hidden', !visible);
  }
}

let signedOut = true;

/** Whether the sign-in card is what the user is looking at. */
export function isSignedOut(): boolean {
  return signedOut;
}

/**
 * Show the sign-in card, with the password field only when there is a password to give.
 *
 * With auth switched off the same card is the old "connect" button, so a service without
 * a password behaves exactly as it did before this feature existed.
 */
export function renderSignIn(state: AuthState): void {
  const fields = $('signin-fields');
  const title = $('connect-title');
  const button = $('connect-btn');

  fields.classList.toggle('hidden', !state.required);
  title.textContent = state.required ? 'Sign in' : 'Connect';
  button.textContent = state.required ? 'Sign in' : 'Connect';

  if (state.required) ($('auth-password') as HTMLInputElement).focus();
}

/**
 * A 401 from any endpoint means the session ended — expired, revoked, or the service
 * restarted (sessions are in memory by design).
 *
 * Reloading rather than swapping the view is the honest move: every card is holding
 * state fetched under a session that no longer exists, and a reload re-derives all of it
 * through the sign-in card instead of leaving stale numbers on screen.
 */
export function handleUnauthorized(): void {
  location.reload();
}

/**
 * Make every `fetch` in the app notice a 401 without each caller remembering to.
 *
 * There are ~40 call sites across the UI modules and they all predate auth. Wrapping the
 * global is the one change that covers them, including the ones built as HTML strings
 * and the ones added later.
 */
export function installUnauthorizedHandler(): void {
  const original = window.fetch;
  // `Object.assign` onto the original keeps the statics — `fetch.preconnect` exists and
  // is part of the type, so a bare arrow function is not a `typeof fetch`.
  window.fetch = Object.assign(async (...args: Parameters<typeof fetch>) => {
    const res = await original(...args);
    // The login route answers 401 on a wrong password; reloading there would throw the
    // user back to an empty form instead of showing them the message.
    const url = typeof args[0] === 'string' ? args[0] : (args[0] as Request).url;
    if (res.status === 401 && !url.includes('/api/auth/')) handleUnauthorized();
    return res;
  }, original);
}
