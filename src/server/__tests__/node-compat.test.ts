/**
 * The Web ⇄ Node adapter that every non-static route goes through.
 *
 * This is the one piece of the Bun migration with no upstream to trust: if it gets a
 * body, a header or a stream wrong, it does so for `/api/*`, the OctoPrint and
 * Moonraker compat surfaces and `/mcp` all at once. Nothing else in the suite touches
 * a route, so these are the tests standing between a shim bug and production.
 */

import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { runNodeHandler } from '../node-compat.js';

describe('runNodeHandler — buffered responses', () => {
  it('sends status, headers and body from writeHead + end', async () => {
    const res = await runNodeHandler((_req, res) => {
      res.writeHead(201, { 'Content-Type': 'application/json', 'X-Custom': 'yes' });
      res.end(JSON.stringify({ ok: true }));
    }, new Request('http://localhost/api/thing'));

    expect(res.status).toBe(201);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('x-custom')).toBe('yes');
    expect(await res.json()).toEqual({ ok: true });
  });

  it('holds the response back until end(), so the body goes out whole', async () => {
    // This is the buffered branch, and it is worth a test of its own: Bun gives a
    // whole-body Response a Content-Length and sends it unchunked, while a streamed
    // one goes out chunked. `writableEnded` — the obvious way to detect "no more
    // writes is coming" — reads true inside Node's final `_write` but false inside
    // Bun's, so the first version of this shim chunked every JSON route in production
    // while looking perfectly correct under the (Node-hosted) test runner.
    //
    // The framing itself is only observable over a socket. What is observable here is
    // the branch that decides it: a buffered response resolves at `end()`, a streamed
    // one resolves at the first `write()` (see the streaming suite below).
    let resolved = false;
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });

    const pending = runNodeHandler((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      void held.then(() => res.end('hello'));
    }, new Request('http://localhost/api/thing')).then((r) => {
      resolved = true;
      return r;
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(resolved).toBe(false);

    release();
    const res = await pending;
    expect(await res.text()).toBe('hello');
  });

  it('accepts headers set one at a time before writeHead', async () => {
    const res = await runNodeHandler((_req, res) => {
      res.setHeader('X-One', '1');
      res.setHeader('X-Two', '2');
      res.writeHead(200);
      res.end('body');
    }, new Request('http://localhost/api/thing'));

    expect(res.headers.get('x-one')).toBe('1');
    expect(res.headers.get('x-two')).toBe('2');
    expect(await res.text()).toBe('body');
  });

  it('defaults to 200 with an empty body when end() is called bare', async () => {
    const res = await runNodeHandler((_req, res) => {
      res.end();
    }, new Request('http://localhost/api/thing'));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('reports headersSent, which several error paths branch on', async () => {
    let before: boolean | null = null;
    let after: boolean | null = null;

    await runNodeHandler((_req, res) => {
      before = res.headersSent;
      res.writeHead(500);
      after = res.headersSent;
      res.end('x');
    }, new Request('http://localhost/api/thing'));

    expect(before).toBe(false);
    expect(after).toBe(true);
  });
});

describe('runNodeHandler — streamed responses', () => {
  it('assembles a body written in several chunks', async () => {
    const res = await runNodeHandler((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write('one ');
      res.write('two ');
      res.end('three');
    }, new Request('http://localhost/api/thing'));

    expect(await res.text()).toBe('one two three');
  });

  it('resolves before the body finishes, so bytes move as they are produced', async () => {
    // What the MJPEG camera stream depends on: the response has to reach Bun when the
    // first frame is written, not when the client finally disconnects.
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });

    const pending = runNodeHandler((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write('first');
      void blocked.then(() => res.end('last'));
    }, new Request('http://localhost/api/stream'));

    const res = await pending; // resolves although `end()` has not been called
    expect(res.status).toBe(200);

    finish();
    expect(await res.text()).toBe('firstlast');
  });

  it('carries a body piped in from a stream', async () => {
    // `createReadStream(file).pipe(res)` is how the gcode cache and the report PDFs
    // are sent, which is why the shim is a real Writable.
    const res = await runNodeHandler((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      Readable.from([Buffer.from('abc'), Buffer.from('def'), Buffer.from('ghi')]).pipe(res);
    }, new Request('http://localhost/api/file'));

    expect(await res.text()).toBe('abcdefghi');
  });
});

describe('runNodeHandler — the request side', () => {
  it('exposes method, a path-only url, and lower-cased headers', async () => {
    let seen: Pick<IncomingMessage, 'method' | 'url' | 'headers' | 'rawHeaders'> | null = null;

    await runNodeHandler(
      (req, res) => {
        seen = req;
        res.writeHead(204);
        res.end();
      },
      new Request('http://localhost:8088/api/files?sort=name&dir=up', {
        method: 'POST',
        headers: { 'X-Api-Key': 'secret' },
        body: '{}',
      }),
    );

    expect(seen!.method).toBe('POST');
    // Node hands routers a path, never an absolute URL — every route here slices it.
    expect(seen!.url).toBe('/api/files?sort=name&dir=up');
    expect(seen!.headers['x-api-key']).toBe('secret');
    // The MCP SDK's body parser reads the flat form.
    expect(seen!.rawHeaders).toContain('x-api-key');
    expect(seen!.rawHeaders).toContain('secret');
  });

  it('delivers a POST body through the data/end events', async () => {
    const res = await runNodeHandler(
      (req, res) => {
        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ echoed: JSON.parse(body) }));
        });
      },
      new Request('http://localhost/api/client-error', {
        method: 'POST',
        body: JSON.stringify({ message: 'boom' }),
      }),
    );

    expect(await res.json()).toEqual({ echoed: { message: 'boom' } });
  });

  it('ends the body stream immediately for a GET', async () => {
    const res = await runNodeHandler((req, res) => {
      req.on('end', () => {
        res.writeHead(200);
        res.end('done');
      });
      req.resume();
    }, new Request('http://localhost/api/health'));

    expect(await res.text()).toBe('done');
  });
});

describe('runNodeHandler — client disconnect', () => {
  it("fires res.on('close') when the request aborts", async () => {
    // The MJPEG client registry removes a viewer on `close`; without this the set
    // grows forever and frames are written into dead sockets.
    const controller = new AbortController();
    let closed = false;

    const pending = runNodeHandler(
      (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace' });
        res.write('frame');
        (res as ServerResponse).on('close', () => {
          closed = true;
        });
      },
      new Request('http://localhost/webcam/?action=stream', { signal: controller.signal }),
    );

    await pending;
    expect(closed).toBe(false);

    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closed).toBe(true);
  });
});
