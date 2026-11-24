// Practice Coach server: static files for the browser app plus POST /api/coach, which streams the
// coach's reply as Server-Sent Events. Node built-ins only (no framework).
//
//   node server/index.js        start it (reads .env when present)
//   createApp({ coach, ... })   the same server, not listening yet, for tests
//
// The server holds a paid API key and listens on localhost, so every request is checked: the Host
// header must name this machine (blocks DNS rebinding), a POST must be JSON from the same origin,
// bodies are size-limited and validated, and coach requests are rate-limited as a spend guard.

import http from 'node:http';
import path from 'node:path';
import { promises as fs, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { validateExercise } from '../shared/exercises.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 5173;
export const BODY_LIMIT_BYTES = 512 * 1024;
export const MAX_MESSAGES = 200;
export const MAX_CONTENT_CHARS = 400000;
export const DEFAULT_MAX_PER_MINUTE = 20;
const PING_MS = 15000;
const DRAIN_LIMIT_BYTES = 8 * 1024 * 1024; // how much of an oversized upload is read before the socket is cut

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------- small helpers

/** "Example.com:8080" -> "example.com", "[::1]:5173" -> "[::1]". Returns null when malformed. */
export function hostnameOf(hostHeader) {
  if (typeof hostHeader !== 'string') return null;
  const host = hostHeader.trim().toLowerCase();
  const match = /^(\[[0-9a-f:.]+\]|[a-z0-9._-]+)(?::\d{1,5})?$/.exec(host);
  return match ? match[1] : null;
}

/** Parse ALLOWED_HOSTS ("pi.local, piano.lan") into lower-case host names. */
export function parseAllowedHosts(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(',');
  return list.map((name) => String(name).trim().toLowerCase()).filter(Boolean);
}

/**
 * Sliding-window counter: at most `max` hits in any `windowMs`.
 * @returns {{take(): boolean}} take() records a hit and returns false when over the limit
 */
export function createRateLimiter({ max, windowMs = 60000, now = Date.now }) {
  let hits = [];
  return {
    take() {
      const time = now();
      hits = hits.filter((at) => time - at < windowMs);
      if (hits.length >= max) return false;
      hits.push(time);
      return true;
    },
  };
}

/**
 * Check the body of POST /api/coach.
 * @param {unknown} body
 * @returns {{ok: true, messages: {role: string, content: string}[], exercise: object|null} | {ok: false, error: string}}
 */
export function validateCoachBody(body) {
  const fail = (error) => ({ ok: false, error });
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return fail('The request body must be a JSON object.');
  const { messages } = body;
  if (!Array.isArray(messages)) return fail('"messages" must be an array.');
  if (messages.length < 1 || messages.length > MAX_MESSAGES) return fail(`"messages" must hold 1 to ${MAX_MESSAGES} items.`);
  let total = 0;
  const clean = [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (typeof message !== 'object' || message === null || Array.isArray(message)) return fail(`messages[${i}] must be an object.`);
    if (message.role !== 'user' && message.role !== 'assistant') return fail(`messages[${i}].role must be "user" or "assistant".`);
    if (typeof message.content !== 'string') return fail(`messages[${i}].content must be a string.`);
    if (!message.content.trim()) return fail(`messages[${i}].content must not be empty.`);
    const expected = i % 2 === 0 ? 'user' : 'assistant';
    if (message.role !== expected) return fail(`"messages" must alternate user and assistant turns and start with a user turn (messages[${i}] is "${message.role}").`);
    total += message.content.length;
    clean.push({ role: message.role, content: message.content });
  }
  if (clean.at(-1).role !== 'user') return fail('The last message must be a user turn.');
  if (total > MAX_CONTENT_CHARS) return fail(`The transcript is too long (${total} characters, the limit is ${MAX_CONTENT_CHARS}).`);

  const exercise = body.exercise ?? null;
  if (exercise !== null) {
    if (typeof exercise !== 'object' || Array.isArray(exercise)) return fail('"exercise" must be an exercise object or null.');
    let problems;
    try {
      problems = validateExercise(exercise);
    } catch (err) {
      problems = [`it could not be checked (${err?.message ?? err})`];
    }
    if (!Array.isArray(problems)) problems = ['it could not be checked'];
    if (problems.length) return fail(`"exercise" is not a valid exercise: ${problems.slice(0, 3).join('; ')}`);
  }
  return { ok: true, messages: clean, exercise };
}

function sendJson(res, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(res.req?.method === 'HEAD' ? undefined : body);
}

function sendText(res, status, text, extraHeaders = {}) {
  const body = `${text}\n`;
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(res.req?.method === 'HEAD' ? undefined : body);
}

/**
 * Read a request body of at most `limit` bytes. An oversized body is drained (so the client can
 * still read the answer) and reported as a 413.
 * @returns {Promise<Buffer>}
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    let tooLarge = Number.isFinite(declared) && declared > limit;
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (!tooLarge && size > limit) {
        tooLarge = true;
        chunks.length = 0;
      }
      if (tooLarge) {
        if (size > DRAIN_LIMIT_BYTES) {
          // Far too much: stop listening to this client altogether.
          const error = new HttpError(413, 'The request body is too large.');
          error.closeConnection = true;
          reject(error);
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) reject(new HttpError(413, `The request body is too large (the limit is ${Math.round(limit / 1024)} KB).`));
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => reject(err));
    req.on('aborted', () => reject(new HttpError(400, 'The request was cut off.')));
  });
}

// ---------------------------------------------------------------- static files

/**
 * Map a request path to a file inside webRoot or sharedRoot.
 * @returns {{root: string, file: string} | null} null when the path is not servable
 */
export function resolveStaticPath(rawPath, webRoot, sharedRoot) {
  if (typeof rawPath !== 'string' || !rawPath.startsWith('/')) return null;
  let segments;
  try {
    segments = rawPath.slice(1).split('/').map((segment) => decodeURIComponent(segment));
  } catch {
    return null; // malformed percent-encoding
  }
  if (segments.length === 1 && segments[0] === '') segments = ['index.html'];
  for (const segment of segments) {
    // No empty segments, no dotfiles (this also rules out "." and ".."), and nothing that could
    // act as a separator or cut the name short after decoding.
    if (!segment || segment.startsWith('.') || /[/\\\0]/.test(segment)) return null;
  }
  let root = webRoot;
  if (segments[0] === 'shared') {
    root = sharedRoot;
    segments = segments.slice(1);
    if (!segments.length) return null;
  }
  const base = path.resolve(root);
  const file = path.resolve(base, ...segments);
  if (!file.startsWith(base + path.sep)) return null;
  return { root: base, file };
}

async function serveStatic(req, res, rawPath, { webRoot, sharedRoot }) {
  const notFound = () => sendText(res, 404, 'Not found');
  const target = resolveStaticPath(rawPath, webRoot, sharedRoot);
  if (!target) return notFound();
  let stat;
  try {
    // Follow symlinks, then make sure the real file is still inside the real root.
    const [realRoot, realFile] = await Promise.all([fs.realpath(target.root), fs.realpath(target.file)]);
    if (!realFile.startsWith(realRoot + path.sep)) return notFound();
    stat = await fs.stat(realFile);
    if (!stat.isFile()) return notFound();
    const type = MIME_TYPES[path.extname(realFile).toLowerCase()] ?? 'application/octet-stream';
    const headers = {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    };
    if (type.startsWith('text/html')) headers['Content-Security-Policy'] = CONTENT_SECURITY_POLICY;
    if (req.method === 'HEAD') {
      res.writeHead(200, headers);
      res.end();
      return undefined;
    }
    const data = await fs.readFile(realFile);
    headers['Content-Length'] = data.length;
    res.writeHead(200, headers);
    res.end(data);
    return undefined;
  } catch {
    // Missing file, unreadable file, a directory in the middle of the path: all a plain 404.
    if (!res.headersSent) return notFound();
    res.end();
    return undefined;
  }
}

// ---------------------------------------------------------------- the coach endpoint

function writeEvent(res, event, data) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
}

async function handleCoach(req, res, options) {
  const { coach, limiter, bodyLimit, pingMs, log } = options;

  const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    req.resume();
    return sendJson(res, 415, { error: 'Send the request as Content-Type: application/json.' });
  }
  const origin = req.headers.origin;
  if (origin !== undefined) {
    // A browser page on another site may not use this server (and with it the API key).
    let originHost = null;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      originHost = null;
    }
    if (!originHost || originHost !== String(req.headers.host ?? '').trim().toLowerCase()) {
      req.resume();
      return sendJson(res, 403, { error: 'Requests from another origin are not allowed.' });
    }
  }

  let raw;
  try {
    raw = await readBody(req, bodyLimit);
  } catch (err) {
    if (err?.closeConnection) {
      sendJson(res, 413, { error: err.message }, { Connection: 'close' });
      req.destroy();
      return undefined;
    }
    if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
    return sendJson(res, 400, { error: 'The request body could not be read.' });
  }

  let body;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return sendJson(res, 400, { error: 'The request body is not valid JSON.' });
  }
  const checked = validateCoachBody(body);
  if (!checked.ok) return sendJson(res, 400, { error: checked.error });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff',
  });
  res.flushHeaders();

  if (!limiter.take()) {
    writeEvent(res, 'error', {
      code: 'too_many_requests',
      message: 'Too many coach requests in the last minute. Wait a little, then try again.',
      retryable: true,
    });
    res.end();
    return undefined;
  }

  // If the browser goes away, stop the upstream request: nobody is listening, and it costs money.
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });
  const ping = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write(': ping\n\n');
  }, pingMs);
  ping.unref?.();

  let finished = false;
  try {
    for await (const item of coach({ messages: checked.messages, exercise: checked.exercise, signal: controller.signal })) {
      if (controller.signal.aborted) break;
      if (!item || typeof item.event !== 'string' || finished) continue;
      writeEvent(res, item.event, item.data);
      if (item.event === 'done' || item.event === 'error') finished = true;
    }
    if (!finished && !controller.signal.aborted) {
      writeEvent(res, 'error', { code: 'server', message: 'The coach stopped without finishing its reply. Try again.', retryable: true });
    }
  } catch (err) {
    if (!controller.signal.aborted) {
      log(`[server] The coach failed: ${err?.stack ?? err}`);
      if (!finished) writeEvent(res, 'error', { code: 'server', message: 'The coach hit an unexpected problem. Try again.', retryable: true });
    }
  } finally {
    clearInterval(ping);
    if (!res.writableEnded) res.end();
  }
  return undefined;
}

// ---------------------------------------------------------------- the app

/**
 * Build the HTTP server (not listening yet).
 * @param {Object} options
 * @param {Function} options.coach              coach({ messages, exercise, signal }) -> async iterable of
 *   { event, data }; carries .mode ('live'|'mock'), .model and .effort (see coach.js, mock-coach.js)
 * @param {string} [options.webRoot]            directory served at /
 * @param {string} [options.sharedRoot]         directory served at /shared/
 * @param {string[]|string} [options.allowedHosts]  extra Host names to answer to, besides localhost
 * @param {number} [options.maxPerMinute]       coach requests allowed per minute, process-wide
 * @param {number} [options.bodyLimit]          request body limit in bytes
 * @param {number} [options.pingMs]             SSE keep-alive interval
 * @param {() => number} [options.now]          clock for the rate limiter
 * @param {(line: string) => void} [options.log]
 * @returns {import('node:http').Server}
 */
export function createApp({
  coach,
  webRoot = path.join(ROOT, 'web'),
  sharedRoot = path.join(ROOT, 'shared'),
  allowedHosts = [],
  maxPerMinute = DEFAULT_MAX_PER_MINUTE,
  bodyLimit = BODY_LIMIT_BYTES,
  pingMs = PING_MS,
  now = Date.now,
  log = (line) => console.error(line),
} = {}) {
  if (typeof coach !== 'function') throw new TypeError('createApp needs a coach function');
  const allowed = new Set([...LOCAL_HOSTNAMES, ...parseAllowedHosts(allowedHosts)]);
  const limiter = createRateLimiter({ max: maxPerMinute, now });
  const coachOptions = { coach, limiter, bodyLimit, pingMs, log };
  const staticOptions = { webRoot, sharedRoot };

  async function handle(req, res) {
    // DNS rebinding guard: only answer when the browser thinks it is talking to this machine.
    const hostname = hostnameOf(req.headers.host);
    if (!hostname || !allowed.has(hostname)) {
      req.resume();
      return sendText(res, 403, 'Forbidden: this server only answers to localhost. Add other names to ALLOWED_HOSTS.');
    }

    const url = typeof req.url === 'string' ? req.url : '';
    if (!url.startsWith('/')) {
      req.resume();
      return sendText(res, 400, 'Bad request');
    }
    const queryAt = url.indexOf('?');
    const pathname = queryAt === -1 ? url : url.slice(0, queryAt);
    const method = req.method ?? 'GET';
    const readOnly = method === 'GET' || method === 'HEAD';

    if (pathname === '/api/coach') {
      if (method !== 'POST') {
        req.resume();
        return sendJson(res, 405, { error: 'Use POST for /api/coach.' }, { Allow: 'POST' });
      }
      return handleCoach(req, res, coachOptions);
    }
    if (!readOnly) {
      req.resume();
      return sendText(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
    }
    if (pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, mode: coach.mode === 'mock' ? 'mock' : 'live', model: coach.model ?? null, effort: coach.effort ?? null });
    }
    if (pathname === '/api' || pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'No such API endpoint.' });
    return serveStatic(req, res, pathname, staticOptions);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log(`[server] Request failed: ${err?.stack ?? err}`);
      try {
        if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error.' });
        else if (!res.writableEnded) res.end();
      } catch {
        res.destroy();
      }
    });
  });
  server.on('clientError', (err, socket) => {
    if (socket.writable && !socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });
  return server;
}

// ---------------------------------------------------------------- command line entry

const blank = (value) => value === undefined || value === null || String(value).trim() === '';

/**
 * Read the server settings from environment variables.
 * @param {Record<string, string|undefined>} env
 */
export function readConfig(env = process.env) {
  const warnings = [];
  const integer = (name, fallback, min, max) => {
    if (blank(env[name])) return fallback;
    const value = Number(env[name]);
    if (Number.isInteger(value) && value >= min && value <= max) return value;
    warnings.push(`${name}=${env[name]} is not a whole number from ${min} to ${max}: using ${fallback}.`);
    return fallback;
  };
  const efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
  let effort = blank(env.COACH_EFFORT) ? 'low' : String(env.COACH_EFFORT).trim().toLowerCase();
  if (!efforts.includes(effort)) {
    warnings.push(`COACH_EFFORT=${env.COACH_EFFORT} is not one of ${efforts.join(', ')}: using low.`);
    effort = 'low';
  }
  const hasKey = !blank(env.ANTHROPIC_API_KEY) || !blank(env.ANTHROPIC_AUTH_TOKEN);
  const mockFlag = blank(env.COACH_MOCK) ? '' : String(env.COACH_MOCK).trim();
  return {
    host: blank(env.HOST) ? DEFAULT_HOST : String(env.HOST).trim(),
    port: integer('PORT', DEFAULT_PORT, 0, 65535),
    model: blank(env.COACH_MODEL) ? 'claude-opus-5-5' : String(env.COACH_MODEL).trim(),
    effort,
    maxPerMinute: integer('COACH_MAX_PER_MIN', DEFAULT_MAX_PER_MINUTE, 1, 100000),
    allowedHosts: parseAllowedHosts(env.ALLOWED_HOSTS),
    // Offline coach when asked for, or when there is no key and it was not explicitly ruled out.
    mock: mockFlag === '1' || (!hasKey && mockFlag !== '0'),
    mockForced: mockFlag === '1',
    hasKey,
    warnings,
  };
}

async function main() {
  try {
    process.loadEnvFile(path.join(ROOT, '.env'));
  } catch {
    // No .env file (or an old Node without loadEnvFile): the environment is used as it is.
  }
  const config = readConfig(process.env);
  for (const warning of config.warnings) console.warn(`[config] ${warning}`);

  let coach;
  if (config.mock) {
    const { createMockCoach } = await import('./mock-coach.js');
    coach = createMockCoach();
  } else {
    const [{ default: Anthropic }, { createCoach }] = await Promise.all([import('@anthropic-ai/sdk'), import('./coach.js')]);
    let client;
    try {
      // Credentials come from the environment (ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN).
      client = new Anthropic({ maxRetries: 2, timeout: 60_000 });
    } catch (err) {
      console.error(`Cannot set up the Claude API client: ${err?.message ?? err}`);
      console.error('Put ANTHROPIC_API_KEY in .env, or set COACH_MOCK=1 to use the offline coach.');
      process.exit(1);
    }
    coach = createCoach({ client, model: config.model, effort: config.effort });
    if (!config.hasKey) {
      console.warn('[config] COACH_MOCK=0 but neither ANTHROPIC_API_KEY nor ANTHROPIC_AUTH_TOKEN is set: coach requests will fail unless the SDK finds credentials another way.');
    }
  }

  const server = createApp({ coach, allowedHosts: config.allowedHosts, maxPerMinute: config.maxPerMinute });
  server.on('error', (err) => {
    if (err?.code === 'EADDRINUSE') {
      console.error(`Port ${config.port} is already in use. Is Practice Coach already running? Stop it, or start this one with another port: PORT=${config.port + 1} npm start`);
    } else if (err?.code === 'EACCES') {
      console.error(`Not allowed to listen on ${config.host}:${config.port}. Pick a port above 1024, for example PORT=5173.`);
    } else {
      console.error(`The server could not start: ${err?.message ?? err}`);
    }
    process.exit(1);
  });
  server.listen(config.port, config.host, () => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : config.port;
    const local = ['127.0.0.1', 'localhost', '::1', '0.0.0.0', '::'].includes(config.host);
    console.log(`Practice Coach is running. Open http://${local ? 'localhost' : config.host}:${port} in Chrome or Edge.`);
    if (config.mock) {
      console.log(
        config.mockForced
          ? 'Coach: OFFLINE mock coach (COACH_MOCK=1). No API calls are made.'
          : 'Coach: OFFLINE mock coach, because no ANTHROPIC_API_KEY is set. No API calls are made. Put a key in .env for the real teacher.',
      );
    } else {
      console.log(`Coach: Claude, model ${config.model}, effort ${config.effort}.`);
    }
    if (config.host === '0.0.0.0' || config.host === '::') {
      console.warn('Warning: listening on every network interface. Anyone who can reach this port can spend your API key.');
    }
  });

  const stop = () => {
    server.close(() => process.exit(0));
    server.closeAllConnections?.();
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return pathToFileURL(process.argv[1]).href === import.meta.url;
  }
}

if (isMainModule()) {
  main().catch((err) => {
    console.error(`The server could not start: ${err?.stack ?? err}`);
    process.exit(1);
  });
}
