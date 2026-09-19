/**
 * HTTP for scheduled prints. Its own small router rather than a branch in
 * `workshop-router.ts` (this is not a workshop tool) but the exact same shape:
 * table-driven routes so a path that exists but was asked for with the wrong method
 * answers 405 with an `Allow` header, not 404. Sits in `nodeRouter`'s chain after the
 * auth gate exactly the same way, so it is protected by existing, not by remembering
 * (see `index.ts`).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { getLogger } from './logger.js';
import type { ScheduleService } from './schedule.js';

const log = getLogger('Schedule');

const PREFIX = '/api/schedule/';

/** A schedule's own body is a few short fields; anything near this size is not one. */
const MAX_BODY_BYTES = 8 * 1024;

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

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: string[];
}

interface Route {
  method: 'GET' | 'POST' | 'DELETE';
  path: RegExp;
  run: (ctx: Ctx) => void | Promise<void>;
}

export function createScheduleRouter(scheduler: ScheduleService) {
  const routes: Route[] = [
    {
      method: 'GET',
      path: /^$/,
      run: ({ res }) => ok(res, { schedules: scheduler.list() }),
    },
    {
      method: 'POST',
      path: /^$/,
      run: async ({ req, res }) => {
        const body = await readJsonBody(req, res);
        if (body === undefined) return;
        const entry = await scheduler.add(body);
        if (!entry) {
          fail(
            res,
            422,
            'VALIDATION_ERROR',
            'A schedule needs a filename and a time in the future, no more than a year out',
          );
          return;
        }
        send(res, 201, { success: true, data: entry });
      },
    },
    {
      method: 'DELETE',
      path: /^([^/]+)$/,
      run: async ({ res, params }) => {
        if (!(await scheduler.cancel(params[0]))) {
          fail(res, 404, 'NOT_FOUND', 'No such pending schedule');
          return;
        }
        ok(res, { schedules: scheduler.list() });
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
      fail(res, 404, 'NOT_FOUND', `No schedule route for ${url.pathname}`);
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

    let params: string[];
    try {
      params = (path.match(route.path) ?? []).slice(1).map((p) => decodeURIComponent(p));
    } catch {
      fail(res, 400, 'INVALID_FORMAT', 'Malformed id in the path');
      return true;
    }
    void Promise.resolve(route.run({ req, res, params })).catch((err: Error) => {
      log.error(`${req.method} ${url.pathname}: ${err.message}`);
      if (!res.headersSent) fail(res, 500, 'INTERNAL_ERROR', 'The schedule could not do that');
    });
    return true;
  };
}
