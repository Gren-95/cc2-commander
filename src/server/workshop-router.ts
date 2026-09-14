/**
 * HTTP for the workshop tools: statistics, cost, maintenance and inventory.
 *
 * Its own router rather than more branches in `rest-api.ts`, which is already the
 * longest file in the service. It sits in `nodeRouter`'s chain after the auth gate, so —
 * as `index.ts` says of every surface — it is protected by existing, not by remembering.
 *
 * Every response is `{ success: true, data }` or `{ error: { code, message } }`, the
 * same shape the rest of `/api` uses.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { computeStats } from '../workshop/stats-core.js';
import type { LedgerService } from './ledger.js';

const PREFIX = '/api/workshop/';

/** Bodies here are a spool or a settings object; anything near this size is not one. */
const MAX_BODY_BYTES = 64 * 1024;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

export function ok(res: ServerResponse, data: unknown): void {
  send(res, 200, { success: true, data });
}

export function fail(res: ServerResponse, status: number, code: string, message: string): void {
  send(res, status, { error: { code, message } });
}

/** Read and parse a JSON body, answering the request itself if it cannot. */
export function readJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<unknown | undefined> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        fail(res, 413, 'TOO_LARGE', 'Request body is too large');
        req.destroy();
        resolve(undefined);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8') || 'null'));
      } catch {
        fail(res, 400, 'INVALID_FORMAT', 'Body is not JSON');
        resolve(undefined);
      }
    });
  });
}

/**
 * The viewer's time-zone offset, from `?tz=`, as `Date#getTimezoneOffset` reports it.
 *
 * Bounded to real offsets (UTC-12 to UTC+14) so a hand-typed value cannot push the
 * month buckets somewhere absurd.
 */
function tzFrom(url: URL): number {
  const n = Number(url.searchParams.get('tz'));
  return Number.isFinite(n) && n >= -840 && n <= 720 ? Math.round(n) : 0;
}

export function createWorkshopRouter(ledger: LedgerService) {
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    const raw = req.url ?? '';
    if (!raw.startsWith(PREFIX)) return false;
    const url = new URL(raw, 'http://localhost');
    const path = url.pathname.slice(PREFIX.length);

    if (path === 'stats' && req.method === 'GET') {
      ok(res, computeStats(ledger.getEntries(), { now: Date.now(), tzOffsetMinutes: tzFrom(url) }));
      return true;
    }

    fail(res, 404, 'NOT_FOUND', `No workshop route for ${req.method} ${url.pathname}`);
    return true;
  };
}
