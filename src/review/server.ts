/**
 * Local HTTP boundary for the single-operator review workspace.
 *
 * Only an explicit asset allowlist is served. API requests require a launch-local
 * token, and mutations also validate browser origin. The launcher binds loopback;
 * this is not an authenticated multi-user server or a public deployment target.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ReviewService } from './service.ts';

/** Server setup including an optional exact origin for a trusted preview proxy. */
export type ReviewServerOptions = {
  service: ReviewService;
  previewOrigin?: string;
};

/** The only browser assets available; database files and .env are never served. */
const ASSETS: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/assets/chevron.svg': ['assets/chevron.svg', 'image/svg+xml'],
  '/assets/demo-report.svg': ['assets/demo-report.svg', 'image/svg+xml'],
  '/assets/demo-listing.svg': ['assets/demo-listing.svg', 'image/svg+xml'],
};

/** An expected HTTP failure that is safe to present as an operator-facing message. */
class HttpError extends Error {
  readonly status: number;

  /** Associates an expected request failure with its safe HTTP response status. */
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Builds a server without listening, allowing tests to select an ephemeral port.
 * @returns A Node server whose lifetime belongs to the caller.
 * No endpoint sends notifications or fetches manually pasted candidate URLs.
 */
export function createReviewServer({ service, previewOrigin }: ReviewServerOptions) {
  const token = randomBytes(32).toString('hex');
  let lastPurge = Date.now();

  return createServer(async (request, response) => {
    // Prevent caching evidence or credentials and prevent embedding the workspace.
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: http:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );

    try {
      validateOrigin(request, previewOrigin);
      const url = new URL(request.url ?? '/', 'http://localhost');
      const path = url.pathname;
      const method = request.method ?? 'GET';

      if (method === 'GET' && ASSETS[path]) {
        const [filename, contentType] = ASSETS[path];
        response.setHeader('Content-Type', contentType);
        response.end(await readFile(new URL(`../../web/${filename}`, import.meta.url)));
        return;
      }

      if (path === '/api/session' && method === 'GET') {
        sendJson(response, 200, { token, practice: service.practice });
        return;
      }

      if (!path.startsWith('/api/')) {
        throw new HttpError(404, 'Page not found.');
      }
      validateToken(request, token);

      // Long-running sessions enforce retention on active API use at most hourly.
      // There is no interval that mutates the database while the tool is idle.
      if (Date.now() - lastPurge >= 3_600_000) {
        service.store.purge(Number(process.env.RETENTION_DAYS || 30));
        lastPurge = Date.now();
      }

      const result = await routeApi(service, method, path, request);
      sendJson(response, method === 'POST' ? 201 : 200, result);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 400;
      const message = error instanceof Error ? error.message : 'The operation failed.';
      sendJson(response, status, { error: message });
    }
  });
}

/**
 * Rejects cross-site requests and unrecognized Host values, including DNS rebinding.
 * An optional preview origin must be configured explicitly, never read from a
 * forwarded host supplied by a request. This is a local-tool boundary, not login.
 */
function validateOrigin(request: IncomingMessage, previewOrigin?: string) {
  const host = request.headers.host ?? '';
  const allowedHosts = /^(127\.0\.0\.1|localhost)(:\d+)?$/;
  const configuredOrigin = previewOrigin ? new URL(previewOrigin).origin : null;
  const origins = [`http://${host}`];
  if (configuredOrigin) {
    origins.push(configuredOrigin);
  }

  if (
    !allowedHosts.test(host) &&
    host !== (configuredOrigin && new URL(configuredOrigin).host)
  ) {
    throw new HttpError(403, 'Unrecognized workspace host.');
  }
  if (request.headers.origin && !origins.includes(request.headers.origin)) {
    throw new HttpError(403, 'Open the workspace directly to make this request.');
  }
  if (request.headers['sec-fetch-site'] === 'cross-site') {
    throw new HttpError(403, 'Cross-site workspace requests are blocked.');
  }
  // Browsers send Origin on our JSON mutations. Non-browser API clients must
  // provide the same explicit origin as well as the launch-local token.
  if (request.method === 'POST' && !request.headers.origin) {
    throw new HttpError(403, 'Workspace origin is required.');
  }
}

/** Requires the session token before reading evidence or mutating the shared store. */
function validateToken(request: IncomingMessage, token: string) {
  const supplied = request.headers['x-traces-token'];
  if (
    typeof supplied !== 'string' ||
    supplied.length !== token.length ||
    !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
  ) {
    throw new HttpError(403, 'Reload the workspace to establish a local session.');
  }
}

/**
 * Reads bounded JSON input. Listing forms do not upload photographs or files.
 * The body cap prevents a local browser request from consuming unbounded memory.
 */
async function readBody(request: IncomingMessage): Promise<any> {
  if (!request.headers['content-type']?.startsWith('application/json')) {
    throw new HttpError(415, 'Send form data as JSON.');
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    length += Buffer.byteLength(chunk);
    if (length > 131_072) {
      throw new HttpError(413, 'Form data is too large.');
    }
    chunks.push(Buffer.from(chunk));
  }
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('Expected an object');
    }
    return input;
  } catch {
    throw new HttpError(400, 'Form data must be a JSON object.');
  }
}

/** Dispatches a small explicit set of case-led operations to the application layer. */
async function routeApi(
  service: ReviewService,
  method: string,
  path: string,
  request: IncomingMessage,
): Promise<unknown> {
  if (path === '/api/cases' && method === 'GET') {
    return service.cases();
  }
  if (path === '/api/cases/ingest' && method === 'POST') {
    return service.ingest(await readBody(request));
  }

  const caseRoute = path.match(/^\/api\/cases\/([^/]+)(?:\/(candidates|time|refresh))?$/);
  if (caseRoute) {
    const caseId = decodeURIComponent(caseRoute[1]);
    const action = caseRoute[2];
    if (method === 'GET' && !action) {
      return service.caseDetail(caseId);
    }
    if (method === 'POST' && action === 'candidates') {
      return service.addCandidate(caseId, await readBody(request));
    }
    if (method === 'POST' && action === 'time') {
      return service.recordTime(caseId, await readBody(request));
    }
    if (method === 'POST' && action === 'refresh') {
      await readBody(request);
      return service.refresh(caseId);
    }
  }

  const observationRoute = path.match(
    /^\/api\/observations\/([1-9]\d*)(?:\/(reviews))?$/,
  );
  if (observationRoute) {
    const id = Number(observationRoute[1]);
    if (method === 'GET' && !observationRoute[2]) {
      return service.observationDetail(id);
    }
    if (method === 'POST' && observationRoute[2] === 'reviews') {
      return service.review(id, await readBody(request));
    }
  }

  throw new HttpError(404, 'Workspace operation not found.');
}

/** Writes JSON rather than injecting provider/user strings into HTML templates. */
function sendJson(response: ServerResponse, status: number, value: unknown) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(value));
}
