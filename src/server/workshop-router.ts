/**
 * HTTP for the workshop tools: statistics, cost, maintenance and inventory.
 *
 * Its own router rather than more branches in `rest-api.ts`, which is already the
 * longest file in the service. It sits in `nodeRouter`'s chain after the auth gate, so —
 * as `index.ts` says of every surface — it is protected by existing, not by remembering.
 *
 * A table of routes rather than a ladder of `if`s, so that a path which exists but was
 * asked for with the wrong method answers 405 with an `Allow` header, not 404: the
 * difference tells a caller whether they have the address wrong or the verb.
 *
 * Every response is `{ success: true, data }` or `{ error: { code, message } }`, the
 * same shape the rest of `/api` uses.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { computeStats } from '../workshop/stats-core.js';
import type { LedgerService } from './ledger.js';
import { getLogger } from './logger.js';
import type { StateStore } from './state-store.js';
import type { WorkshopService } from './workshop.js';

const log = getLogger('Workshop');

const PREFIX = '/api/workshop/';

/** Bodies here are a spool or a settings object; anything near this size is not one. */
const MAX_BODY_BYTES = 64 * 1024;

function send(res: ServerResponse, status: number, body: unknown, headers = {}): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function ok(res: ServerResponse, data: unknown): void {
  send(res, 200, { success: true, data });
}

function fail(res: ServerResponse, status: number, code: string, message: string): void {
  send(res, status, { error: { code, message } });
}

/** Read and parse a JSON body. `undefined` means it failed and has already been answered. */
function readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  return new Promise((resolve) => {
    let size = 0;
    let done = false;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES && !done) {
        done = true;
        fail(res, 413, 'TOO_LARGE', 'Request body is too large');
        req.destroy();
        resolve(undefined);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
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
 * Bounded to real offsets (UTC-12 to UTC+14) so a hand-typed value cannot push the month
 * buckets somewhere absurd.
 */
function tzFrom(url: URL): number {
  const n = Number(url.searchParams.get('tz'));
  return Number.isFinite(n) && n >= -840 && n <= 720 ? Math.round(n) : 0;
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: string[];
}

interface Route {
  method: 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE';
  path: RegExp;
  run: (ctx: Ctx) => void | Promise<void>;
}

export function createWorkshopRouter(
  ledger: LedgerService,
  workshop: WorkshopService,
  store: StateStore,
) {
  const routes: Route[] = [
    /* ── statistics ── */
    {
      method: 'GET',
      path: /^stats$/,
      run: ({ res, url }) =>
        ok(
          res,
          computeStats(ledger.getEntries(), {
            now: Date.now(),
            tzOffsetMinutes: tzFrom(url),
            costOf: workshop.costOfEntry,
          }),
        ),
    },

    /* ── cost ── */
    {
      method: 'GET',
      path: /^cost$/,
      run: ({ res }) =>
        ok(res, {
          settings: workshop.getCostSettings(),
          priced: workshop.hasAnyPrice(),
          files: workshop.costFiles(store.files),
        }),
    },
    {
      method: 'PUT',
      path: /^cost\/settings$/,
      run: async ({ req, res }) => {
        const body = await readJsonBody(req, res);
        if (body === undefined) return;
        ok(res, await workshop.setCostSettings(body));
      },
    },

    /* ── maintenance ── */
    {
      method: 'GET',
      path: /^maintenance$/,
      run: ({ res }) => ok(res, workshop.getMaintenance()),
    },
    {
      method: 'PUT',
      path: /^maintenance\/tasks$/,
      run: async ({ req, res }) => {
        const body = await readJsonBody(req, res);
        if (body === undefined) return;
        if (!Array.isArray(body)) {
          fail(res, 422, 'VALIDATION_ERROR', 'Expected a list of tasks');
          return;
        }
        await workshop.setTasks(body);
        ok(res, workshop.getMaintenance());
      },
    },
    {
      method: 'POST',
      path: /^maintenance\/tasks\/([^/]+)\/done$/,
      run: async ({ res, params }) => {
        if (!(await workshop.markDone(params[0]))) {
          fail(res, 404, 'NOT_FOUND', 'No such maintenance task');
          return;
        }
        ok(res, workshop.getMaintenance());
      },
    },

    /* ── inventory ── */
    {
      method: 'GET',
      path: /^inventory$/,
      run: ({ res }) => ok(res, workshop.getInventory()),
    },
    {
      method: 'POST',
      path: /^inventory\/spools$/,
      run: async ({ req, res }) => {
        const body = await readJsonBody(req, res);
        if (body === undefined) return;
        const spool = await workshop.addSpool(body);
        if (!spool) {
          fail(
            res,
            422,
            'VALIDATION_ERROR',
            'A spool needs a material, a #RRGGBB colour and a weight',
          );
          return;
        }
        send(res, 201, { success: true, data: spool });
      },
    },
    {
      method: 'PATCH',
      path: /^inventory\/spools\/([^/]+)$/,
      run: async ({ req, res, params }) => {
        const body = await readJsonBody(req, res);
        if (body === undefined) return;
        const spool = await workshop.updateSpool(params[0], body);
        if (!spool) {
          fail(res, 404, 'NOT_FOUND', 'No such spool, or the change would make it invalid');
          return;
        }
        ok(res, spool);
      },
    },
    {
      method: 'DELETE',
      path: /^inventory\/spools\/([^/]+)$/,
      run: async ({ res, params }) => {
        if (!(await workshop.deleteSpool(params[0]))) {
          fail(res, 404, 'NOT_FOUND', 'No such spool');
          return;
        }
        ok(res, workshop.getInventory());
      },
    },
    {
      method: 'POST',
      path: /^inventory\/pending\/([^/]+)\/assign$/,
      run: async ({ req, res, params }) => {
        const body = (await readJsonBody(req, res)) as { spoolId?: unknown } | undefined;
        if (body === undefined) return;
        const spoolId = typeof body?.spoolId === 'string' ? body.spoolId : '';
        if (!(await workshop.assign(params[0], spoolId))) {
          fail(res, 404, 'NOT_FOUND', 'No such queued print, or no such spool');
          return;
        }
        ok(res, workshop.getInventory());
      },
    },
    {
      method: 'DELETE',
      path: /^inventory\/pending\/([^/]+)$/,
      run: async ({ res, params }) => {
        if (!(await workshop.dismiss(params[0]))) {
          fail(res, 404, 'NOT_FOUND', 'No such queued print');
          return;
        }
        ok(res, workshop.getInventory());
      },
    },
  ];

  return (req: IncomingMessage, res: ServerResponse): boolean => {
    const raw = req.url ?? '';
    if (!raw.startsWith(PREFIX)) return false;
    const url = new URL(raw, 'http://localhost');
    const path = url.pathname.slice(PREFIX.length);

    const matching = routes.filter((r) => r.path.test(path));
    if (!matching.length) {
      fail(res, 404, 'NOT_FOUND', `No workshop route for ${url.pathname}`);
      return true;
    }
    const route = matching.find((r) => r.method === req.method);
    if (!route) {
      send(
        res,
        405,
        { error: { code: 'METHOD_NOT_ALLOWED', message: `${req.method} is not allowed here` } },
        { Allow: matching.map((r) => r.method).join(', ') },
      );
      return true;
    }

    // Path segments arrive percent-encoded. decodeURIComponent THROWS on a malformed
    // sequence such as `%E0`, which would escape this handler as an exception, so a bad
    // id is a 400 rather than a crash.
    let params: string[];
    try {
      params = (path.match(route.path) ?? []).slice(1).map((p) => decodeURIComponent(p));
    } catch {
      fail(res, 400, 'INVALID_FORMAT', 'Malformed id in the path');
      return true;
    }
    void Promise.resolve(route.run({ req, res, url, params })).catch((err: Error) => {
      log.error(`${req.method} ${url.pathname}: ${err.message}`);
      if (!res.headersSent) fail(res, 500, 'INTERNAL_ERROR', 'The workshop could not do that');
    });
    return true;
  };
}
