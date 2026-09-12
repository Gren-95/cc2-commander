// @vitest-environment jsdom
/**
 * The About panel — "which build is actually running".
 *
 * Worth testing rather than eyeballing because the interesting case is the one that is
 * invisible in development: an UNSTAMPED deploy. Production runs from /opt/elegooweb,
 * which is not a git checkout, so this panel is the only answer to "which commit is
 * this?" — and the failure mode to avoid is it confidently showing something wrong.
 * ELEG-48: a version you cannot trust is worse than none.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { renderAbout } from '../ui/about';

function mount() {
  document.body.innerHTML = '<div id="about-card"></div>';
  return document.getElementById('about-card') as HTMLElement;
}

const rowsOf = (host: HTMLElement) =>
  Object.fromEntries(
    [...host.querySelectorAll('.about-row')].map((el) => [
      el.querySelector('.about-label')?.textContent ?? '',
      el.querySelector('.about-value')?.textContent ?? '',
    ]),
  );

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('renderAbout', () => {
  it('shows the formatted version, the short commit and the install time', () => {
    const host = mount();
    renderAbout({
      describe: 'v0.2.1-97-gd867b1b',
      version: '0.2.1',
      commit: 'd867b1bc7dbcbc4582a6549d4f74348468664f63',
      shortCommit: 'd867b1b',
      installedAt: '2026-09-12T17:45:48.951Z',
    });

    const rows = rowsOf(host);
    expect(rows.Version).toBe('0.2.1+97');
    expect(rows.Commit).toBe('d867b1b');
    expect(rows.Installed).toBeTruthy();
    expect(host.querySelector('.about-build-unstamped')).toBeNull();
  });

  it('keeps the full sha and the raw describe reachable without showing them', () => {
    // The short forms are what a human reads; the long forms are what they paste into
    // an issue. `title` carries them rather than a second row of noise.
    const host = mount();
    renderAbout({
      describe: 'v0.2.1-97-gd867b1b-dirty',
      version: '0.2.1',
      commit: 'd867b1bc7dbcbc4582a6549d4f74348468664f63',
      shortCommit: 'd867b1b',
    });

    const values = [...host.querySelectorAll('.about-value')].map((el) => el.getAttribute('title'));
    expect(values).toContain('d867b1bc7dbcbc4582a6549d4f74348468664f63');
    expect(values).toContain('v0.2.1-97-gd867b1b-dirty');
  });

  it('says so plainly when the deploy is unstamped, rather than inventing a version', () => {
    const host = mount();
    renderAbout({ describe: null, version: null, commit: null, shortCommit: null });

    expect(rowsOf(host).Version).toContain('unknown');
    expect(host.querySelector('.about-build-unstamped')).not.toBeNull();
    // No commit row at all — an empty one would imply the field exists and is blank.
    expect(rowsOf(host).Commit).toBeUndefined();
  });

  it('handles no stamp at all, which is the state before the first broadcast', () => {
    const host = mount();
    renderAbout(null);

    expect(rowsOf(host).Version).toContain('unknown');
    expect(host.querySelector('.about-build-unstamped')).not.toBeNull();
  });

  it('ignores an unparseable installedAt instead of rendering "Invalid Date"', () => {
    const host = mount();
    renderAbout({ version: '0.2.1', installedAt: 'not-a-date' });

    expect(rowsOf(host).Installed).toBeUndefined();
  });

  it('does nothing when the host element is absent', () => {
    // The panel only exists on the About page; `updateServiceStatus` fires regardless.
    document.body.innerHTML = '';
    expect(() => renderAbout({ version: '0.2.1' })).not.toThrow();
  });
});
