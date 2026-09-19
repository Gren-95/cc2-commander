/**
 * The wire format of the Moonraker-compatible :7125 server: JSON and JSON-RPC responses,
 * request body and query parsing, and multipart uploads. Moved out of moonraker-server.ts.
 */

import { type IncomingMessage, type ServerResponse } from 'http';
import type { FanInfo } from '../types.js';

// ── Helpers ──────────────────────────────────────────────────────

export function jsonResult(res: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify({ result: data });
  res.writeHead(status, {
    'Content-Type': 'application/json',
  });
  res.end(body);
}

export function jsonError(res: ServerResponse, message: string, code = 400): void {
  res.writeHead(code, {
    'Content-Type': 'application/json',
  });
  res.end(JSON.stringify({ error: { code, message } }));
}

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

export function readBodyRaw(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new Error('Body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function parseQuery(url: string): Record<string, string> {
  const idx = url.indexOf('?');
  if (idx < 0) return {};
  const params: Record<string, string> = {};
  for (const pair of url.slice(idx + 1).split('&')) {
    const [k, v] = pair.split('=');
    if (k) params[decodeURIComponent(k)] = v ? decodeURIComponent(v) : '';
  }
  return params;
}

const _fanPct = (f?: FanInfo) => (f ? f.speed / 255 : 0);

// ── JSON-RPC types ───────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
  id?: number | string | null;
}

export function rpcResult(id: number | string | null | undefined, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', result, id: id ?? null });
}

export function rpcError(
  id: number | string | null | undefined,
  code: number,
  message: string,
): string {
  return JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: id ?? null });
}

export function rpcNotify(method: string, params: unknown[]): string {
  return JSON.stringify({ jsonrpc: '2.0', method, params });
}

/* ── Multipart parsing ────────────────────────────────────────────── */

export interface MultipartPart {
  name: string;
  filename?: string;
  data: Buffer;
}

export function parseMultipartParts(body: Buffer, boundary: string): MultipartPart[] {
  const sep = Buffer.from(`--${boundary}`);
  const parts: MultipartPart[] = [];
  let start = body.indexOf(sep);
  if (start === -1) return parts;

  while (start !== -1) {
    start += sep.length;
    // Skip \r\n after boundary
    if (body[start] === 0x0d && body[start + 1] === 0x0a) start += 2;
    // Check for closing boundary (--)
    if (body[start] === 0x2d && body[start + 1] === 0x2d) break;

    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), start);
    if (headerEnd === -1) break;

    const headers = body.subarray(start, headerEnd).toString('utf-8');
    const nameMatch = headers.match(/name="([^"]+)"/);
    const filenameMatch = headers.match(/filename="([^"]+)"/);

    if (nameMatch) {
      const dataStart = headerEnd + 4;
      const nextBoundary = body.indexOf(sep, dataStart);
      // -2 for \r\n before the next boundary
      const dataEnd = nextBoundary !== -1 ? nextBoundary - 2 : body.length;
      parts.push({
        name: nameMatch[1],
        filename: filenameMatch?.[1],
        data: body.subarray(dataStart, dataEnd),
      });
    }

    start = body.indexOf(sep, headerEnd);
  }
  return parts;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
