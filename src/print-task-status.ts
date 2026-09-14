/**
 * What `task_status` in a print-history entry (`1036`) means.
 *
 * Shared by the browser's history card and the service's statistics, so there is one
 * answer rather than two that can drift — which is how the previous one got to be wrong.
 *
 * ## Verified, not assumed
 *
 * The mapping this replaced read `1 → printing, 2 → completed`, and it was inverted.
 * Measured against all 49 tasks on a CC2 (firmware 02.01.00.00) by comparing how long
 * each ran with the slicer's estimate, which Elegoo's slicer writes into the filename:
 *
 *     task_status 1   ran 0.96–1.35 × the estimate, every time   → finished
 *     task_status 2   ran 0.00–0.35 × the estimate, every time   → stopped early
 *
 * The history corroborates it on its own terms: nearly every `2` is followed by a `1` of
 * the same file — a first layer that went wrong, a cancel, a restart that succeeded.
 *
 * So under the old mapping every successful print was shown as still *printing*, and
 * every abandoned one as *completed*.
 *
 * `2` covers a print that did not finish, whoever stopped it. The data cannot separate a
 * user's cancel from a fault, and "stopped" claims neither.
 *
 * `0`, `3` and `4` never appeared in 49 tasks, so nothing here is known about them.
 * They map to `unknown` rather than to a guess: a guessed `failed` would be counted as a
 * failure in the statistics, and a wrong failure rate is worse than an honest gap.
 */

export type TaskOutcome = 'completed' | 'stopped' | 'unknown';

export function mapTaskStatus(status: number | string | undefined): TaskOutcome | string {
  // A string is already a word (some firmware, and the tests), so pass it through.
  if (typeof status === 'string') return status;
  switch (status) {
    case 1:
      return 'completed';
    case 2:
      return 'stopped';
    default:
      return 'unknown';
  }
}
