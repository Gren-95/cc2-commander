/**
 * Web `Request`/`Response` ⇄ Node `(req, res)` adapter.
 *
 * The front door is `Bun.serve` (src/server/index.ts), which speaks the Web fetch
 * types. The SPA and the WebSocket transport are native Bun and never come through
 * here: this file exists for the ~11k lines of compatibility surface that are not:
 * `rest-api.ts`, `octoprint-compat.ts`, `moonraker-compat.ts`, `moonraker-server.ts`
 * all of which are written against `IncomingMessage` /
 * `ServerResponse`.
 *
 * Rewriting those to the fetch types would be an 11k-line change to routes that no
 * test exercises (see docs/gates.md), so they keep their signature and pay one
 * object allocation per request instead. Static assets (the hot path for a browser
 * loading the SPA) are served by Bun's own static route table and allocate nothing.
 *
 * Two response shapes come out of here:
 *
 *   buffered   `writeHead()` then `end(body)` with no intervening `write()`. The body
 *              is handed to Bun whole, so it gets a Content-Length and no chunking.
 *              Every JSON route takes this path.
 *   streaming  any `write()` before `end()`: `createReadStream().pipe(res)`, the
 *              MJPEG multipart camera stream, the gcode proxy. The `Response` resolves
 *              as soon as the first chunk lands so bytes start moving immediately, and
 *              writer backpressure is wired to the ReadableStream's `pull`.
 */

import { Readable, Writable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** A handler written against Node's HTTP types. */
export type NodeHandler = (req: IncomingMessage, res: ServerResponse) => void;

function toBytes(chunk: unknown): Uint8Array {
  if (chunk == null) return new Uint8Array(0);
  if (chunk instanceof Uint8Array) return chunk;
  if (typeof chunk === 'string') return new TextEncoder().encode(chunk);
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  return new TextEncoder().encode(String(chunk));
}

/**
 * Statuses the fetch spec forbids a body on. `new Response(body, { status: 204 })`
 * throws rather than ignoring the body, and 204 is what every OPTIONS preflight and
 * several control routes answer with, so the body has to be dropped here instead.
 */
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0];
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * A `ServerResponse` that produces a `Response` instead of writing to a socket.
 *
 * Extends `Writable` rather than faking `write`/`end`, because `stream.pipe(res)` is
 * how three routes send their body and pipe needs the real thing: `_write`, `_final`
 * and a `drain` that means something.
 */
class BunServerResponse extends Writable {
  statusCode = 200;
  statusMessage = '';
  headersSent = false;

  private readonly outHeaders = new Headers();
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private pendingPull: (() => void) | null = null;
  private buffered: Uint8Array[] = [];
  private settled = false;
  /**
   * Set by `end()` before the stream machinery writes the final chunk, which is what
   * tells `_write` that no more is coming and the body can be buffered whole.
   *
   * NOT `writableEnded`: Node sets that synchronously inside `end()` (so it reads true
   * during the final `_write`), Bun does not, measured on 1.4.2, where it is still
   * false there. Relying on it silently sent every JSON response chunked.
   */
  private endCalled = false;

  /** Resolves once the status line and headers are known. */
  readonly response: Promise<Response>;
  private resolveResponse!: (res: Response) => void;

  constructor() {
    super();
    this.response = new Promise<Response>((resolve) => {
      this.resolveResponse = resolve;
    });
  }

  setHeader(name: string, value: number | string | readonly string[]): this {
    if (Array.isArray(value)) {
      this.outHeaders.delete(name);
      for (const v of value) this.outHeaders.append(name, String(v));
    } else {
      this.outHeaders.set(name, String(value));
    }
    return this;
  }

  getHeader(name: string): string | undefined {
    return this.outHeaders.get(name) ?? undefined;
  }

  removeHeader(name: string): void {
    this.outHeaders.delete(name);
  }

  hasHeader(name: string): boolean {
    return this.outHeaders.has(name);
  }

  writeHead(
    statusCode: number,
    statusMessageOrHeaders?: string | Record<string, number | string | string[]>,
    maybeHeaders?: Record<string, number | string | string[]>,
  ): this {
    this.statusCode = statusCode;
    const headers =
      typeof statusMessageOrHeaders === 'string' ? maybeHeaders : statusMessageOrHeaders;
    if (typeof statusMessageOrHeaders === 'string') this.statusMessage = statusMessageOrHeaders;
    if (headers) {
      for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    }
    this.headersSent = true;
    return this;
  }

  /** Mid-body write: switch to a streamed body and hand Bun the `Response` now. */
  private startStreaming(): void {
    if (this.controller) return;
    const self = this;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        self.controller = controller;
        for (const chunk of self.buffered) controller.enqueue(chunk);
        self.buffered = [];
      },
      pull() {
        const resume = self.pendingPull;
        self.pendingPull = null;
        resume?.();
      },
      cancel() {
        // The client went away. `close` is what the MJPEG stream registry listens for.
        self.destroy();
      },
    });
    this.settle(
      new Response(NULL_BODY_STATUS.has(this.statusCode) ? null : body, {
        status: this.statusCode,
        headers: this.outHeaders,
      }),
    );
  }

  private settle(response: Response): void {
    if (this.settled) return;
    this.settled = true;
    this.headersSent = true;
    this.resolveResponse(response);
  }

  // Overloaded in the base type; `end()`, `end(chunk)` and `end(chunk, enc, cb)` all
  // land here, and all that matters is recording that no further write follows.
  override end(chunk?: unknown, encoding?: unknown, callback?: unknown): this {
    this.endCalled = true;
    return (super.end as (...args: unknown[]) => this)(chunk, encoding, callback);
  }

  override _write(
    chunk: unknown,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const bytes = toBytes(chunk);

    // A plain `end(body)` is buffered and gets a Content-Length; any `write()` before
    // `end()` means more is coming and the body has to stream.
    if (!this.controller && this.endCalled) {
      this.buffered.push(bytes);
      callback();
      return;
    }

    this.startStreaming();
    const controller = this.controller;
    if (!controller) {
      callback();
      return;
    }
    try {
      controller.enqueue(bytes);
    } catch {
      // Stream already closed or cancelled: drop the chunk rather than throw into
      // the caller's `pipe`.
      callback();
      return;
    }
    if ((controller.desiredSize ?? 1) <= 0) {
      this.pendingPull = () => callback();
    } else {
      callback();
    }
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (this.controller) {
      try {
        this.controller.close();
      } catch {
        // already closed
      }
    } else {
      this.settle(
        new Response(NULL_BODY_STATUS.has(this.statusCode) ? null : concat(this.buffered), {
          status: this.statusCode,
          headers: this.outHeaders,
        }),
      );
    }
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.pendingPull = null;
    if (this.controller) {
      try {
        this.controller.close();
      } catch {
        // already closed
      }
    }
    // A destroy before anything was sent still owes Bun a response.
    this.settle(new Response(null, { status: this.statusCode, headers: this.outHeaders }));
    callback(error);
  }
}

/** Build an `IncomingMessage`-shaped view over a fetch `Request`. */
function toNodeRequest(request: Request, remoteAddress: string | undefined): IncomingMessage {
  const url = new URL(request.url);
  const body =
    request.body && request.method !== 'GET' && request.method !== 'HEAD'
      ? Readable.fromWeb(request.body as Parameters<typeof Readable.fromWeb>[0])
      : Readable.from([]);

  const headers: Record<string, string> = {};
  // `rawHeaders` is the flat [name, value, name, value, …] array Node exposes. It looks
  // redundant next to `headers`, but a Node-style body parser reads it directly and
  // throws `undefined is not an object (evaluating 'rawHeaders.length')` without it.
  const rawHeaders: string[] = [];
  for (const [name, value] of request.headers) {
    headers[name] = value;
    rawHeaders.push(name, value);
  }

  return Object.assign(body, {
    method: request.method,
    // Node hands routers a path, not an absolute URL, and every route here parses it
    // that way.
    url: url.pathname + url.search,
    headers,
    rawHeaders,
    rawTrailers: [] as string[],
    trailers: {} as Record<string, string>,
    complete: false,
    httpVersion: '1.1',
    httpVersionMajor: 1,
    httpVersionMinor: 1,
    socket: { remoteAddress, setTimeout: () => {} },
  }) as unknown as IncomingMessage;
}

/**
 * Run a Node-style handler and await the `Response` it writes.
 *
 * `signal` is the request's abort signal: aborting destroys the response object, which
 * is what makes `res.on('close')` fire for the long-lived MJPEG clients.
 */
export function runNodeHandler(
  handler: NodeHandler,
  request: Request,
  remoteAddress?: string,
): Promise<Response> {
  const req = toNodeRequest(request, remoteAddress);
  const res = new BunServerResponse();

  const onAbort = () => res.destroy();
  request.signal.addEventListener('abort', onAbort, { once: true });
  res.once('close', () => request.signal.removeEventListener('abort', onAbort));

  handler(req, res as unknown as ServerResponse);
  return res.response;
}
