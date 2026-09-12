// @vitest-environment jsdom
/**
 * The About panel — which build is running, and what it is talking to.
 *
 * Worth testing rather than eyeballing because the interesting case is the one that is
 * invisible in development: an UNSTAMPED deploy. Production runs from /opt/elegooweb,
 * which is not a git checkout, so this panel is the only answer to "which commit is
 * this?" — and the failure mode to avoid is it confidently showing something wrong.
 * ELEG-48: a version you cannot trust is worse than none.
 *
 * `diagnosticsText` gets the same attention: it is what a bug report will be pasted
 * from, so it has to stay readable when every field is missing.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { type AboutStatus, diagnosticsText, setAboutStatus } from '../ui/about';

function mount() {
  document.body.innerHTML = '<div id="about-card"></div>';
  return document.getElementById('about-card') as HTMLElement;
}

/** The panel renders label/value pairs; read them back as a map. */
const factsOf = (host: HTMLElement) =>
  Object.fromEntries(
    [...host.querySelectorAll('.font-mono')].map((el) => [
      el.previousElementSibling?.textContent?.trim() ?? '',
      el.textContent?.trim() ?? '',
    ]),
  );

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('the running build', () => {
  it('shows the formatted version, the short commit and the install time', () => {
    const host = mount();
    setAboutStatus({
      build: {
        describe: 'v0.2.1-97-gd867b1b',
        version: '0.2.1',
        commit: 'd867b1bc7dbcbc4582a6549d4f74348468664f63',
        shortCommit: 'd867b1b',
        installedAt: '2026-09-12T17:45:48.951Z',
      },
    });

    const facts = factsOf(host);
    expect(facts.Version).toBe('0.2.1+97');
    expect(facts.Commit).toBe('d867b1b');
    expect(facts.Installed).toBeTruthy();
  });

  it('keeps the full sha and the raw describe reachable without showing them', () => {
    // The short forms are what a human reads; the long forms are what they paste.
    const host = mount();
    setAboutStatus({
      build: {
        describe: 'v0.2.1-97-gd867b1b-dirty',
        version: '0.2.1',
        commit: 'd867b1bc7dbcbc4582a6549d4f74348468664f63',
        shortCommit: 'd867b1b',
      },
    });

    const titles = [...host.querySelectorAll('.font-mono')].map((el) => el.getAttribute('title'));
    expect(titles).toContain('d867b1bc7dbcbc4582a6549d4f74348468664f63');
    expect(titles).toContain('v0.2.1-97-gd867b1b-dirty');
  });

  it('says so plainly when the deploy is unstamped, rather than inventing a version', () => {
    const host = mount();
    setAboutStatus({ build: { describe: null, version: null } });

    expect(factsOf(host).Version).toBe('unstamped');
    // No commit row at all — an empty one would imply the field exists and is blank.
    expect(factsOf(host).Commit).toBeUndefined();
  });

  it('handles no status at all, which is the state before the first broadcast', () => {
    const host = mount();
    setAboutStatus(null);
    expect(factsOf(host).Version).toBe('unstamped');
  });

  it('ignores an unparseable installedAt instead of rendering "Invalid Date"', () => {
    const host = mount();
    setAboutStatus({ build: { version: '0.2.1', installedAt: 'not-a-date' } });
    expect(factsOf(host).Installed).toBeUndefined();
  });

  it('does nothing when the host element is absent', () => {
    // The panel only exists on the About sub-tab; the broadcast fires regardless.
    document.body.innerHTML = '';
    expect(() => setAboutStatus({ build: { version: '0.2.1' } })).not.toThrow();
  });
});

describe('printer and service facts', () => {
  it('reports what the service says it is connected to', () => {
    const host = mount();
    setAboutStatus({
      printerSn: 'CC2-123',
      printerIp: '192.0.2.10',
      mqtt: 'connected',
      uptime: 3723,
      wsClients: 2,
      camera: 'available',
    });

    const facts = factsOf(host);
    expect(facts.Serial).toBe('CC2-123');
    expect(facts.Address).toBe('192.0.2.10');
    expect(facts.MQTT).toBe('connected');
    expect(facts.Uptime).toBe('1h 2m');
    expect(facts.Browsers).toBe('2');
  });

  it('says "not registered" rather than blank when the printer has not spoken', () => {
    // `printerSn` is null until the printer identifies itself — a real state, and a
    // blank value would read as a bug in the panel rather than a fact about the setup.
    const host = mount();
    setAboutStatus({ printerSn: null, printerIp: '192.0.2.10' });
    expect(factsOf(host).Serial).toBe('not registered');
  });
});

describe('diagnosticsText', () => {
  const status: AboutStatus = {
    build: {
      version: '0.2.1',
      describe: 'v0.2.1-97-gd867b1b',
      commit: 'd867b1bc',
      installedAt: '2026-09-12T17:45:48.951Z',
    },
    printerSn: 'CC2-123',
    printerIp: '192.0.2.10',
    mqtt: 'connected',
    uptime: 3723,
    wsClients: 2,
    camera: 'available',
  };

  it('carries the full commit, not the short one — it is going into an issue', () => {
    const text = diagnosticsText(status, 'TestBrowser/1.0');
    expect(text).toContain('d867b1bc');
    expect(text).toContain('0.2.1+97');
    expect(text).toContain('CC2-123');
    expect(text).toContain('TestBrowser/1.0');
  });

  it('stays readable when everything is missing', () => {
    const text = diagnosticsText(null, 'TestBrowser/1.0');
    expect(text).toContain('unknown');
    expect(text.split('\n').length).toBeGreaterThan(5);
    // No stray "undefined" or "null" for a reader to puzzle over.
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('null');
  });
});
