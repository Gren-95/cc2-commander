/**
 * What the compat layers say about authentication.
 *
 * Both layers used to answer credential requests with a plausible fixed string:
 * OctoPrint returned `apikey: 'elegoo-cc2-compat'`, Moonraker answered
 * `access.get_api_key` with `'elegoo-compat-api-key'`. Nothing was ever checked against
 * either. A client that asked got an answer and displayed itself as **authenticated**,
 * and anyone auditing the code could find the handling and conclude an auth path
 * existed. ELEG-2's description had to carry a warning not to read these as evidence:
 * that warning was only necessary because the code lied (ELEG-26).
 *
 * Since `AUTH_API_KEY` exists, that answer is conditional, and every function here takes
 * the flag rather than assuming. Getting this wrong reintroduces the exact dishonesty the
 * module was written to remove, only from the other side: telling a Mainsail user there is
 * no authentication to configure, and then refusing them with a 401. The gate in
 * `auth-gate.ts` is what actually decides; these endpoints only describe it.
 *
 * The real key is never emitted, in either state. "API key auth is on" is a fact a client
 * needs; the key itself is something its operator already has.
 *
 * Kept in its own module, free of dependencies, so both layers say the same thing and
 * the shapes can be asserted directly: the compat layers are pure state→JSON
 * translation, which `docs/testing.md` names as the high-value test target, and a
 * client breaks silently when a field's shape drifts.
 */

/** Phrased for a human reading a client's error, in whichever state they are in. */
export const NO_API_KEY_MESSAGE =
  'This service has no authentication and issues no API key. ' +
  'Access is controlled by the network it is reachable from.';

/**
 * The same method when a key IS required.
 *
 * It still refuses: `access.get_api_key` means "hand me the key", and a service that
 * hands out its own credential to an unauthenticated caller has no credential. But it
 * says where to get one instead of claiming there is nothing to get.
 */
export const API_KEY_NOT_RETRIEVABLE_MESSAGE =
  'This service requires an API key, but does not issue or return one through this API. ' +
  'Use the value of AUTH_API_KEY from the service configuration, sent as X-Api-Key.';

/** Which of the two a caller should be told, given the service's actual state. */
export function apiKeyMessage(apiKeyRequired: boolean): string {
  return apiKeyRequired ? API_KEY_NOT_RETRIEVABLE_MESSAGE : NO_API_KEY_MESSAGE;
}

/** Moonraker's JSON-RPC error code for an unavailable method. */
export const MOONRAKER_NO_API_KEY_CODE = -32601;

/**
 * Returned in place of a fabricated JWT / refresh token / created user (ELEG-53).
 *
 * ELEG-26 withdrew the fake **API key** and deliberately left the session-credential
 * surface alone, because the breakage risk was different and unassessed. This is that
 * follow-up: `access.login`, `access.refresh_jwt` and `access.post_user` were handing
 * back `elegoo-compat-jwt-token` / `elegoo-compat-refresh-token` and, for `post_user`, a
 * "created" user that is stored nowhere. Nothing was ever issued, stored or checked.
 *
 * `post_user` was the worst of them: inventing a user implies a user store, and there is
 * no user store.
 *
 * These are safe to withdraw because `access.info` reports `login_required: false`, which
 * is how a well-behaved client learns not to log in, so a client reaching these was
 * already off the documented path. `oneshot_token` is the exception and is kept; see
 * `ONESHOT_TOKEN` below.
 */
export const NO_SESSIONS_MESSAGE =
  'This service has no authentication and issues no tokens or user accounts. ' +
  'See access.info: login_required is false. ' +
  'Access is controlled by the network it is reachable from.';

/**
 * The same surface when a key is required.
 *
 * Still no user store and still no JWTs: single-user auth has one password and one key,
 * and inventing a session here would imply a user store that does not exist. What changes
 * is that the client is pointed at the mechanism that does work.
 */
export const API_KEY_ONLY_MESSAGE =
  'This service has no user accounts or session tokens. ' +
  'Authenticate with the API key instead, sent as X-Api-Key or Authorization: Bearer.';

export function sessionsMessage(apiKeyRequired: boolean): string {
  return apiKeyRequired ? API_KEY_ONLY_MESSAGE : NO_SESSIONS_MESSAGE;
}

/**
 * The one credential-shaped answer that is deliberately **kept**.
 *
 * In real Moonraker `oneshot_token` exists so a browser can open a WebSocket or a camera
 * stream where an `Authorization` header cannot be set: the token goes in the query
 * string instead. A client may fetch one **before** it reads `access.info`, so refusing
 * it risks breaking the WebSocket connection outright. That is a regression, not a
 * security improvement, and this service checks nothing either way: withdrawing it would
 * remove no protection whatsoever, because there is none to remove.
 *
 * So it keeps answering, but with a string that tells the truth when it turns up in a
 * URL, a proxy log or a browser's network tab, instead of one that reads like a
 * credential. Any value works, since nothing validates it on the way back in.
 *
 * If a future change ever adds real authentication, this is one of the places that has
 * to stop being a no-op.
 */
export const ONESHOT_TOKEN = 'no-auth-required';

/**
 * A oneshot token, or `null` when the caller must be refused.
 *
 * With a key configured this has to refuse. The token's whole purpose is to authenticate
 * a URL that cannot carry a header, so returning a fixed string would be a bypass of the
 * gate: any caller could mint it and use it. Refusing costs a browser client its
 * query-string path to the camera and socket; the API key still works everywhere a header
 * can be set, and the alternative is auth that can be walked around.
 */
export function oneshotToken(apiKeyRequired: boolean): string | null {
  return apiKeyRequired ? null : ONESHOT_TOKEN;
}

/**
 * OctoPrint's `api` block in `GET /api/settings`.
 *
 * `enabled` reports whether this server does API-key authentication, which is exactly
 * what the field means to an OctoPrint client. The original bug was `enabled: true` plus
 * a fabricated key; the fix was a hardcoded `false`, which became its own lie the moment
 * AUTH_API_KEY existed. It is now neither: it is read from the configuration.
 */
export function octoprintApiSettings(apiKeyRequired: boolean): { enabled: boolean; key: null } {
  // `key` stays null in both states. `enabled` is what the client acts on; the key is
  // what its operator pastes in, and this endpoint is reachable without one.
  return { enabled: apiKeyRequired, key: null };
}

/**
 * OctoPrint's `POST /api/login` body.
 *
 * `admin`/`user` stay true in both states, and that is not a lie: this service has one
 * user, and anyone who gets this far (past an open door or past the gate) genuinely has
 * full control. Understating it would be its own kind of dishonesty. `apikey` is never
 * emitted; only `_login_mechanism` changes, to name how the caller actually got in.
 */
export function octoprintLoginPayload(apiKeyRequired: boolean): Record<string, unknown> {
  return {
    _is_external_client: false,
    // Named honestly when there is one. A caller that reached this route past the gate
    // authenticated with the key, so saying so is a description, not a claim.
    _login_mechanism: apiKeyRequired ? 'apikey' : null,
    active: true,
    admin: true,
    groups: ['admins', 'users'],
    name: 'elegoo',
    needs: { group: ['admins'], role: [] },
    permissions: [],
    roles: ['admin', 'user'],
    user: true,
  };
}

/**
 * Whether this service actually checks an API key right now.
 *
 * Both halves matter: auth switched off, or switched on with no key configured, means a
 * machine client has nothing to present, and telling it otherwise sends its operator
 * looking for a key that does not exist. Takes the two fields rather than the whole
 * config, so this module keeps its "no dependencies" property.
 */
export function apiKeyRequired(auth: { enabled: boolean; apiKey: string }): boolean {
  return auth.enabled && auth.apiKey.length > 0;
}
