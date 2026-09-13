#!/usr/bin/env bun
/**
 * Generate the two credentials single-user auth needs, ready to paste into `.env`.
 *
 *   bun run auth:secret                 # prompt for a password, also mint an API key
 *   bun run auth:secret --api-key-only  # just a new API key, to rotate it
 *
 * This exists because the alternative is a README paragraph asking someone to work out
 * an argon2id hash by hand, and a security feature that takes a detour through "how do I
 * even produce this value" is a security feature that stays switched off.
 *
 * The password is read without echo and never written anywhere — not to a file, not to
 * the shell history, not to the terminal. Only the hash is printed.
 */

import { randomBytes } from 'node:crypto';
import { hashPassword } from '../src/server/auth.js';

/** 256 bits, base64url — safe in a header, a query string and a YAML file alike. */
function mintApiKey(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Read a line from the terminal with echo off.
 *
 * Falls back to a visible prompt when stdin is not a TTY (a pipe, or CI), because
 * refusing outright would make the script unusable in exactly the automated case where
 * someone is provisioning a host.
 */
let pipedLines: string[] | null = null;

async function readSecret(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  const stdin = process.stdin;

  if (!stdin.isTTY) {
    // Read the whole pipe once and hand out lines. Iterating the stream per call
    // destroys it, so the second prompt got an AbortError instead of the second line.
    pipedLines ??= (await new Response(stdin as unknown as ReadableStream).text()).split('\n');
    return pipedLines.shift() ?? '';
  }

  stdin.setRawMode(true);
  stdin.resume();
  let value = '';
  try {
    for await (const chunk of stdin) {
      const text = chunk.toString();
      // Ctrl-C and Ctrl-D: leave without printing anything.
      if (text === '' || text === '') {
        process.stdout.write('\n');
        process.exit(130);
      }
      if (text === '\r' || text === '\n') break;
      if (text === '' || text === '\b') {
        value = value.slice(0, -1);
        continue;
      }
      value += text;
    }
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
  }
  process.stdout.write('\n');
  return value;
}

const apiKeyOnly = process.argv.includes('--api-key-only');

if (apiKeyOnly) {
  console.log(`AUTH_API_KEY=${mintApiKey()}`);
  process.exit(0);
}

const password = await readSecret('Password for the dashboard: ');
if (password.length < 8) {
  // The floor from the org guideline. Enforced here rather than at login, because a weak
  // password chosen once is a weak password forever — there is no rotation prompt.
  console.error('\nRefusing: use at least 8 characters (a passphrase is easier and stronger).');
  process.exit(1);
}
const again = await readSecret('Again: ');
if (password !== again) {
  console.error('\nThose do not match.');
  process.exit(1);
}

const hash = await hashPassword(password);

console.log('\nAdd these to .env (which is gitignored — never commit them):\n');
console.log(`AUTH_PASSWORD_HASH=${hash.replaceAll('$', String.raw`\$`)}`);
console.log(`AUTH_API_KEY=${mintApiKey()}`);
console.log(`
Each '$' in the hash is BACKSLASH-ESCAPED, and it has to be. Bun loads .env itself and
expands $VAR inside single quotes and double quotes alike — verified: A=scrypt$65536$8$1$x,
'…' and "…" all arrive as "scrypt". Only \\$ survives. scrypt's format is
scrypt$N$r$p$salt$hash, so an unescaped hash always loses everything after "scrypt" and
every login answers 401 with nothing to say why.

Paste the line exactly as printed. Restart the service for either to take effect.`);
