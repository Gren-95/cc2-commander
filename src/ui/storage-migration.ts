/**
 * One-time rename of the localStorage keys, carrying the data across.
 *
 * The project was `elegoo-web` and is now `cc2-commander`, and three keys carried the
 * old name: the UI settings, the dashboard card layout and the spool calculator. Those
 * keys are the only handle on state a person arranged by hand: theme, which cards are
 * visible and how wide, list sorts, alert volume, spool figures.
 *
 * **Renaming a key is not a rename, it is a delete.** `localStorage` has no concept of
 * moving one; the new name simply reads empty, every module falls back to its defaults,
 * and the user opens a factory-fresh dashboard with nothing to explain where their
 * layout went. That is why this exists rather than a find-and-replace.
 *
 * The migration runs on read, not at startup, so a module that is never loaded never
 * pays for it, and it is idempotent: once the value is under the new key the old one is
 * gone and the check costs one miss.
 */

/**
 * Return the value at `key`, adopting `legacyKey`'s value first if it is the only one
 * present.
 *
 * The old key is removed once copied. Leaving it would mean a second migration on a
 * later rename silently resurrecting stale state that the user had since changed.
 */
export function readMigrated(key: string, legacyKey: string): string | null {
  try {
    const current = localStorage.getItem(key);
    if (current !== null) return current;

    const legacy = localStorage.getItem(legacyKey);
    if (legacy === null) return null;

    localStorage.setItem(key, legacy);
    localStorage.removeItem(legacyKey);
    return legacy;
  } catch {
    // Private windows, blocked site data, and the storage-disabled case. Callers already
    // handle a null by using their defaults, which is the right answer here too.
    return null;
  }
}
