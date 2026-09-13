/**
 * Which storage the file card is showing, and which folder within it.
 *
 * Two variables, in their own module, because four others need them and the alternative
 * was a cycle: `files.ts` imports `requestPrintDialog` from `print-dialog.ts`, which
 * imported `currentFileSource` straight back out of `files.ts`. That is the circular
 * dependency CLAUDE.md forbids, and it had been there long enough to look deliberate.
 *
 * Anything that reads this state imports it from here. Nothing here imports anything,
 * so nothing downstream can close a loop through it.
 */

export type FileSource = 'local' | 'u-disk';

let source: FileSource = 'local';
let dir = '/';

export function currentFileSource(): FileSource {
  return source;
}

export function currentFileDir(): string {
  return dir;
}

/** Switching storage always lands at that storage's root; the old path is meaningless. */
export function setFileSource(next: FileSource): void {
  source = next;
  dir = '/';
}

export function setFileDir(next: string): void {
  dir = next;
}

/** The path `1044` listed a file under, which is what `1045`, `1046` and `1047` want. */
export function filePathFor(filename: string, inDir: string = dir): string {
  return inDir === '/' ? filename : `${inDir.replace(/^\//, '')}/${filename}`;
}
