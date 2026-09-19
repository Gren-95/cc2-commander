import { describe, it, expect } from 'bun:test';
import {
  octoprintApiSettings,
  octoprintLoginPayload,
  NO_API_KEY_MESSAGE,
  NO_SESSIONS_MESSAGE,
  ONESHOT_TOKEN,
  MOONRAKER_NO_API_KEY_CODE,
  apiKeyMessage,
  apiKeyRequired,
  oneshotToken,
  sessionsMessage,
} from '../compat-auth.js';

/** The two states every function here has to describe correctly. */
const OPEN = false;
const GATED = true;

/**
 * The compat layers are pure state→JSON translation, and a client breaks silently when
 * a field's shape drifts. These assert the emitted shape directly (no printer, no
 * network) which is what ELEG-26 asked for.
 */

describe('octoprintApiSettings', () => {
  it('reports API-key auth as disabled when nothing is checked', () => {
    expect(octoprintApiSettings(OPEN)).toEqual({ enabled: false, key: null });
  });

  it('reports it as enabled when a key IS required', () => {
    // The second lie this module has now told: a hardcoded `false` was honest until
    // AUTH_API_KEY existed, after which it sent a Mainsail user looking for a setting
    // they were told not to configure, and then refused them with a 401.
    expect(octoprintApiSettings(GATED)).toEqual({ enabled: true, key: null });
  });

  it('never emits a key, in either state', () => {
    // The original regression: a fixed string that made clients show themselves as
    // authenticated against a service that checked nothing. The real key must not leak
    // here either: this endpoint is reachable without one.
    expect(octoprintApiSettings(OPEN).key).toBeNull();
    expect(octoprintApiSettings(GATED).key).toBeNull();
  });
});

describe('octoprintLoginPayload', () => {
  it('names the mechanism the caller actually used', () => {
    // A caller that got this far past an armed gate authenticated with the key; saying
    // so is a description, not a claim. `apikey` itself is never emitted either way.
    expect(octoprintLoginPayload(OPEN)._login_mechanism).toBeNull();
    expect(octoprintLoginPayload(GATED)._login_mechanism).toBe('apikey');
    expect('apikey' in octoprintLoginPayload(GATED)).toBe(false);
  });

  it('still reports full control in both states', () => {
    // One user, and anyone past the door has all of it. Understating that would be its
    // own kind of dishonesty.
    for (const state of [OPEN, GATED]) {
      expect(octoprintLoginPayload(state).admin).toBe(true);
    }
  });
});

describe('apiKeyRequired', () => {
  it('needs auth on AND a key configured', () => {
    // Auth on with no key means a machine client has nothing to present. Saying a key
    // is required would send its operator hunting for one that does not exist.
    expect(apiKeyRequired({ enabled: true, apiKey: 'k' })).toBe(true);
    expect(apiKeyRequired({ enabled: true, apiKey: '' })).toBe(false);
    expect(apiKeyRequired({ enabled: false, apiKey: 'k' })).toBe(false);
    expect(apiKeyRequired({ enabled: false, apiKey: '' })).toBe(false);
  });
});

describe('oneshotToken', () => {
  it('answers when nothing is checked', () => {
    // Refusing would break a browser client's WebSocket for no gain: nothing validates
    // the token on the way back in.
    expect(oneshotToken(OPEN)).toBe(ONESHOT_TOKEN);
  });

  it('refuses when a key is required', () => {
    // This token exists to authenticate a URL that cannot carry a header. Handing out a
    // fixed one with the gate armed would let any caller mint it: a bypass, not a
    // compatibility shim.
    expect(oneshotToken(GATED)).toBeNull();
  });
});

describe('messages', () => {
  it('say there is no auth only when that is true', () => {
    expect(apiKeyMessage(OPEN)).toBe(NO_API_KEY_MESSAGE);
    expect(sessionsMessage(OPEN)).toBe(NO_SESSIONS_MESSAGE);
  });

  it('point at the key when there is one', () => {
    expect(apiKeyMessage(GATED)).not.toBe(NO_API_KEY_MESSAGE);
    expect(apiKeyMessage(GATED)).toMatch(/AUTH_API_KEY|X-Api-Key/);
    expect(sessionsMessage(GATED)).toMatch(/API key/i);
  });

  it('never claim "no authentication" while the gate is armed', () => {
    // The one sentence that must never reach a user of a gated service.
    for (const message of [apiKeyMessage(GATED), sessionsMessage(GATED)]) {
      expect(message).not.toMatch(/has no authentication/i);
    }
  });
});

describe('octoprintLoginPayload', () => {
  const payload = octoprintLoginPayload(OPEN);

  it('carries no apikey field at all', () => {
    expect('apikey' in payload).toBe(false);
  });

  it('claims no login mechanism', () => {
    expect(payload._login_mechanism).toBeNull();
  });

  it('still reports full control, because that is true', () => {
    // With no authentication every caller does have admin capability. Understating it
    // would be its own dishonesty: the exposure is the point of ELEG-2.
    expect(payload.admin).toBe(true);
    expect(payload.user).toBe(true);
    expect(payload.active).toBe(true);
  });

  it('keeps the fields OctoPrint clients read, so the shape stays usable', () => {
    for (const key of ['name', 'groups', 'roles', 'permissions', 'needs']) {
      expect(payload, `missing ${key}`).toHaveProperty(key);
    }
  });

  it('mentions no credential anywhere in the serialised body', () => {
    // Belt and braces: catches a credential reintroduced under a different field name.
    expect(JSON.stringify(payload)).not.toMatch(/elegoo-cc2-compat|apikey|api_key/i);
  });
});

describe('the no-API-key answer', () => {
  it('explains itself rather than returning an empty string', () => {
    expect(NO_API_KEY_MESSAGE).toMatch(/no authentication/i);
    expect(NO_API_KEY_MESSAGE.length).toBeGreaterThan(20);
  });

  it('uses a JSON-RPC error code, not a success code', () => {
    expect(MOONRAKER_NO_API_KEY_CODE).toBeLessThan(0);
  });
});

describe('the no-sessions answer (ELEG-53)', () => {
  it('explains itself, and points at the field that says login is unnecessary', () => {
    // A client's UI shows this string. "Unauthorized" would send someone hunting for a
    // password that does not exist; naming access.info tells them where to look instead.
    expect(NO_SESSIONS_MESSAGE).toMatch(/no authentication/i);
    expect(NO_SESSIONS_MESSAGE).toMatch(/login_required/);
    expect(NO_SESSIONS_MESSAGE.length).toBeGreaterThan(20);
  });

  it('mentions no credential and no user account', () => {
    // The regression this exists to catch, in the shape ELEG-26 used for the API key:
    // a token reintroduced under any name at all.
    expect(NO_SESSIONS_MESSAGE).not.toMatch(/elegoo-compat/i);
    expect(NO_SESSIONS_MESSAGE).toMatch(/issues no tokens/i);
  });
});

describe('the oneshot token, which is deliberately still issued', () => {
  it('is a non-empty string, because withdrawing it could break the WebSocket', () => {
    // Real Moonraker uses this where a header cannot be set (WebSocket, camera stream),
    // and a client may fetch one BEFORE reading access.info. Refusing it would be a
    // regression, not a security improvement: nothing validates it either way.
    expect(typeof ONESHOT_TOKEN).toBe('string');
    expect(ONESHOT_TOKEN.length).toBeGreaterThan(0);
  });

  it('does not read like a credential when it shows up in a URL or a log', () => {
    // It lands in query strings, proxy logs and browser network tabs. Anyone who sees it
    // should be able to tell at a glance that nothing is being authenticated.
    expect(ONESHOT_TOKEN).not.toMatch(/token|key|secret|jwt|auth[^-]/i);
    expect(ONESHOT_TOKEN).toBe('no-auth-required');
  });
});
