'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { ERROR_CODES, HttpError } = require('./src/error-catalog');
const { requireProduct, requireSearchResults } = require('./src/clami-response');
const { readJsonBody, validateSearchBody, validateProductBody } = require('./src/input-validation');
const { productText } = require('./src/product-presentation');

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const CLAMI_BASE_URL = 'https://www.clami.cl/api/catalogo';
const LOG_DIR = path.resolve(process.env.LOG_DIR || path.join(__dirname, 'logs'));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const STATE_FILE = path.join(DATA_DIR, 'runtime-state.json');
const INSTANCE_LOCK_FILE = path.join(DATA_DIR, 'single-instance.lock');
const LOG_RETENTION_DAYS = 10;
const CLAMI_TIMEOUT_MS = 10_000;
const MAX_UPSTREAM_PER_MINUTE = 55;
const MAX_UPSTREAM_PER_DAY = 2_700;
const SEARCH_CACHE_TTL_MS = 45_000;
const PRODUCT_CACHE_TTL_MS = 20_000;
const MAX_CACHE_ENTRIES = 300;
const ADMIN_MAX_FAILURES = 3;
const ADMIN_LOCK_MS = 40_000;
const MAX_ADMIN_LOG_ENTRIES = 100;
const MAX_LOG_TAIL_BYTES = 64 * 1024;

let writeQueue = Promise.resolve();
let runtimeState = { date: currentDate(), upstreamCalls: 0, cooldownUntil: 0, lastClami: null };
const cache = new Map();
let requestWindow = { start: Date.now(), count: 0 };
const adminFailures = new Map();
const upstreamMinuteCounters = new Map();
const startedAt = Date.now();
let instanceLockHeld = false;

function currentDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date());
}

function safeError(error) {
  return error instanceof Error ? error.message.replace(/[\r\n]/g, ' ').slice(0, 200) : 'unknown_error';
}

function isConfigured() {
  return Boolean(process.env.CLAMI_API_KEY && process.env.MANYCHAT_SECRET && Number.isInteger(PORT) && PORT > 0);
}

function constantTimeMatch(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const actualBuffer = Buffer.from(actual, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function logFileName() {
  return `bridge-${currentDate()}.jsonl`;
}

function audit(event, fields = {}) {
  const entry = JSON.stringify({ ts: new Date().toISOString(), event, ...fields }) + '\n';
  writeQueue = writeQueue
    .then(() => fs.mkdir(LOG_DIR, { recursive: true, mode: 0o700 }))
    .then(() => fs.appendFile(path.join(LOG_DIR, logFileName()), entry, { encoding: 'utf8', mode: 0o600 }))
    .catch(() => { process.stderr.write('audit_write_failed\n'); });
  return writeQueue;
}

async function purgeOldLogs() {
  const files = await fs.readdir(LOG_DIR, { withFileTypes: true }).catch(() => []);
  const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  await Promise.all(files.map(async (file) => {
    if (!file.isFile() || !/^bridge-\d{4}-\d{2}-\d{2}\.jsonl$/.test(file.name)) return;
    const fullPath = path.join(LOG_DIR, file.name);
    const stats = await fs.stat(fullPath).catch(() => null);
    if (stats && stats.mtimeMs < cutoff) await fs.unlink(fullPath).catch(() => undefined);
  }));
}

async function loadState() {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  try {
    const parsed = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
    if (typeof parsed === 'object' && parsed && typeof parsed.date === 'string' && Number.isFinite(parsed.upstreamCalls) && Number.isFinite(parsed.cooldownUntil)) {
      runtimeState = parsed;
    }
  } catch { /* First boot or unusable state: use secure defaults. */ }
  resetDailyStateIfNeeded();
}

function resetDailyStateIfNeeded() {
  if (runtimeState.date !== currentDate()) {
    runtimeState = { date: currentDate(), upstreamCalls: 0, cooldownUntil: 0, lastClami: runtimeState.lastClami || null };
  }
}

function persistState() {
  const content = JSON.stringify(runtimeState) + '\n';
  writeQueue = writeQueue
    .then(() => fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 }))
    .then(async () => {
      const temporary = `${STATE_FILE}.${process.pid}.tmp`;
      await fs.writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporary, STATE_FILE);
    })
    .catch(() => undefined);
  return writeQueue;
}

async function lockOwnerIsRunning() {
  try {
    const owner = JSON.parse(await fs.readFile(INSTANCE_LOCK_FILE, 'utf8'));
    // A partially-written or malformed lock is treated as active. Removing it
    // optimistically could let two Passenger workers run at the same time.
    if (!Number.isInteger(owner.pid) || owner.pid <= 0) return true;
    try {
      process.kill(owner.pid, 0);
      return true;
    } catch (error) {
      // EPERM still means the PID exists; only ESRCH proves a stale lock.
      return error && error.code !== 'ESRCH';
    }
  } catch {
    return true;
  }
}

async function acquireSingleInstanceLock() {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(INSTANCE_LOCK_FILE, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n', 'utf8');
      await handle.close();
      instanceLockHeld = true;
      return;
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      if (attempt === 0 && !(await lockOwnerIsRunning())) {
        await fs.unlink(INSTANCE_LOCK_FILE).catch(() => undefined);
        continue;
      }
      throw new HttpError(503, 'Ya existe una instancia activa.', { reason: 'state_lock_unavailable' }, ERROR_CODES.STATE_LOCK_UNAVAILABLE);
    }
  }
}

async function releaseSingleInstanceLock() {
  if (!instanceLockHeld) return;
  instanceLockHeld = false;
  await fs.unlink(INSTANCE_LOCK_FILE).catch(() => undefined);
}

function cacheGet(key) {
  const value = cache.get(key);
  if (!value) return null;
  if (value.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return value.value;
}

function cacheSet(key, value, ttlMs) {
  while (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function clientAllowed() {
  const now = Date.now();
  if (now - requestWindow.start >= 60_000) {
    requestWindow = { start: now, count: 0 };
  }
  requestWindow.count += 1;
  return requestWindow.count <= 120;
}

async function clamiGet(relativePath) {
  resetDailyStateIfNeeded();
  if (Date.now() < runtimeState.cooldownUntil) {
    throw new HttpError(503, 'El catálogo está temporalmente en espera. Intenta nuevamente en unos minutos.', {
      reason: 'cooldown',
      retryAfter: Math.max(1, Math.ceil((runtimeState.cooldownUntil - Date.now()) / 1000))
    });
  }
  if (runtimeState.upstreamCalls >= MAX_UPSTREAM_PER_DAY) {
    throw new HttpError(503, 'El catálogo alcanzó el límite interno diario. Intenta mañana.', { reason: 'daily_budget' });
  }
  const minuteKey = Math.floor(Date.now() / 60_000);
  for (const key of upstreamMinuteCounters.keys()) if (key < minuteKey - 1) upstreamMinuteCounters.delete(key);
  const count = upstreamMinuteCounters.get(minuteKey) || 0;
  if (count >= MAX_UPSTREAM_PER_MINUTE) throw new HttpError(503, 'El catálogo está temporalmente ocupado. Intenta nuevamente en un minuto.', { reason: 'minute_budget' });
  upstreamMinuteCounters.set(minuteKey, count + 1);
  runtimeState.upstreamCalls += 1;
  void persistState();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLAMI_TIMEOUT_MS);
  try {
    const response = await fetch(`${CLAMI_BASE_URL}${relativePath}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${process.env.CLAMI_API_KEY}`, Accept: 'application/json' },
      signal: controller.signal,
      redirect: 'error'
    });
    if (response.status === 429) {
      const retryAfter = Number.parseInt(response.headers.get('retry-after') || '60', 10);
      const cooldownSeconds = Math.max(1, Math.min(Number.isFinite(retryAfter) ? retryAfter : 60, 3600));
      runtimeState.cooldownUntil = Date.now() + cooldownSeconds * 1000;
      runtimeState.lastClami = { at: new Date().toISOString(), status: 429, outcome: 'rate_limited' };
      void persistState();
      throw new HttpError(503, 'El catálogo está temporalmente ocupado. Intenta nuevamente más tarde.', { clamiStatus: 429, reason: 'rate_limited', retryAfter: cooldownSeconds });
    }
    if (response.status === 401 || response.status === 403) {
      runtimeState.lastClami = { at: new Date().toISOString(), status: response.status, outcome: 'credential_or_origin' };
      void persistState();
      throw new HttpError(503, 'El catálogo no está disponible temporalmente.', { clamiStatus: response.status, reason: 'credential_or_origin' });
    }
    if (response.status === 404) {
      runtimeState.lastClami = { at: new Date().toISOString(), status: 404, outcome: 'not_found' };
      void persistState();
      throw new HttpError(404, 'Producto no encontrado.', { clamiStatus: 404 });
    }
    if (!response.ok) {
      runtimeState.lastClami = { at: new Date().toISOString(), status: response.status, outcome: 'upstream_error' };
      void persistState();
      throw new HttpError(502, 'El catálogo no respondió correctamente.', { clamiStatus: response.status });
    }
    const data = await response.json();
    runtimeState.lastClami = { at: new Date().toISOString(), status: response.status, outcome: 'ok' };
    void persistState();
    return data;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error.name === 'AbortError') {
      runtimeState.lastClami = { at: new Date().toISOString(), status: 504, outcome: 'timeout' };
      void persistState();
      throw new HttpError(504, 'El catálogo tardó demasiado en responder.', { reason: 'timeout' });
    }
    runtimeState.lastClami = { at: new Date().toISOString(), status: 502, outcome: 'network' };
    void persistState();
    throw new HttpError(502, 'No fue posible consultar el catálogo.', { reason: 'network' });
  } finally {
    clearTimeout(timer);
  }
}

function respond(response, status, payload, extraHeaders = {}) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    ...extraHeaders
  });
  response.end(JSON.stringify(payload));
}

function ensureManyChat(request) {
  if (!constantTimeMatch(request.headers['x-manychat-secret'], process.env.MANYCHAT_SECRET)) {
    throw new HttpError(401, 'No autorizado.', { reason: 'invalid_manychat_secret' });
  }
}

function ensureAdmin(request) {
  const header = typeof request.headers.authorization === 'string' ? request.headers.authorization : '';
  const expected = process.env.ADMIN_STATUS_TOKEN;
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const now = Date.now();
  if (expected && constantTimeMatch(token, expected)) {
    return;
  }
  // Passenger usually exposes its proxy address, not the browser IP. Fingerprinting
  // only the failed credential prevents an invalid token from locking out the real one.
  const fingerprint = crypto.createHash('sha256').update(header || 'missing').digest('hex').slice(0, 32);
  const failure = adminFailures.get(fingerprint);
  if (failure?.lockedUntil > now) throw new HttpError(429, 'No autorizado.', { reason: 'admin_locked', retryAfter: Math.max(1, Math.ceil((failure.lockedUntil - now) / 1000)) });
  const attempts = (failure?.attempts || 0) + 1;
  const lockedUntil = attempts >= ADMIN_MAX_FAILURES ? now + ADMIN_LOCK_MS : 0;
  adminFailures.set(fingerprint, { attempts: lockedUntil ? 0 : attempts, lockedUntil, updatedAt: now });
  void audit('admin_auth_failed', { route: new URL(request.url, 'http://localhost').pathname, reason: lockedUntil ? 'admin_locked' : 'invalid_admin_token' });
  throw new HttpError(lockedUntil ? 429 : 401, 'No autorizado.', lockedUntil
    ? { reason: 'admin_locked', retryAfter: Math.ceil(ADMIN_LOCK_MS / 1000) }
    : { reason: 'invalid_admin_token' });
}

function purgeEphemeralState(now = Date.now()) {
  for (const [fingerprint, failure] of adminFailures) {
    const expiry = Math.max(failure.updatedAt || 0, failure.lockedUntil || 0) + 120_000;
    if (expiry < now) adminFailures.delete(fingerprint);
  }
}

function adminStatus() {
  resetDailyStateIfNeeded();
  return {
    ok: isConfigured(),
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    quota: { upstreamCallsToday: runtimeState.upstreamCalls, maxPerDay: MAX_UPSTREAM_PER_DAY },
    cooldownSeconds: Math.max(0, Math.ceil((runtimeState.cooldownUntil - Date.now()) / 1000)),
    cacheEntries: cache.size,
    lastClami: runtimeState.lastClami || null,
    logRetentionDays: LOG_RETENTION_DAYS
  };
}

function sanitizeAuditEntry(entry) {
  const allowed = ['ts', 'event', 'requestId', 'route', 'method', 'status', 'durationMs', 'cacheHit', 'queryType', 'errorCode', 'reason', 'clamiStatus', 'retentionDays'];
  const output = {};
  for (const key of allowed) if (Object.hasOwn(entry, key)) output[key] = entry[key];
  return output;
}

async function readLogTail(filePath, limit) {
  const handle = await fs.open(filePath, 'r');
  try {
    const stats = await handle.stat();
    const length = Math.min(stats.size, MAX_LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, Math.max(0, stats.size - length));
    const lines = buffer.toString('utf8').split('\n');
    if (stats.size > length) lines.shift();
    return lines
      .filter(Boolean)
      .map((line) => { try { return sanitizeAuditEntry(JSON.parse(line)); } catch { return null; } })
      .filter(Boolean)
      .slice(-limit);
  } finally {
    await handle.close();
  }
}

async function recentAuditEntries(limit, date) {
  const files = await fs.readdir(LOG_DIR, { withFileTypes: true }).catch(() => []);
  let logNames = files
    .filter((file) => file.isFile() && /^bridge-\d{4}-\d{2}-\d{2}\.jsonl$/.test(file.name))
    .map((file) => file.name)
    .sort()
    .reverse();
  if (date) logNames = logNames.filter((name) => name === `bridge-${date}.jsonl`);
  const entries = [];
  for (const name of logNames) {
    const remaining = limit - entries.length;
    if (remaining <= 0) break;
    const tail = await readLogTail(path.join(LOG_DIR, name), remaining).catch(() => []);
    entries.unshift(...tail);
  }
  return entries.slice(-limit);
}

async function handleSearch(body) {
  const { q, channel, isBarcode } = validateSearchBody(body);
  const cacheKey = `search:${q.toLocaleLowerCase('es-CL')}`;
  let result = isBarcode ? null : cacheGet(cacheKey);
  const cacheHit = Boolean(result);
  if (!result) {
    result = await clamiGet(`/buscar/?q=${encodeURIComponent(q)}`);
    if (!isBarcode) cacheSet(cacheKey, result, SEARCH_CACHE_TTL_MS);
  }
  const results = requireSearchResults(result);
  if (!results.length) return { payload: { ok: true, texto: 'No encontré productos para esa búsqueda.', opciones: [] }, cacheHit, queryType: isBarcode ? 'barcode' : 'text' };
  const options = results.map((product, index) => ({ numero: index + 1, ref: product.ref, texto: productText(product) }));
  const texto = options.length === 1 ? options[0].texto : `Encontré ${options.length} opciones. Responde con el número que corresponde.`;
  return { payload: { ok: true, texto, opciones: options, canal: channel }, cacheHit, queryType: isBarcode ? 'barcode' : 'text' };
}

async function handleProduct(body) {
  const ref = validateProductBody(body);
  const cacheKey = `product:${ref}`;
  let product = cacheGet(cacheKey);
  const cacheHit = Boolean(product);
  if (!product) {
    product = requireProduct(await clamiGet(`/producto/${encodeURIComponent(ref)}/`));
    cacheSet(cacheKey, product, PRODUCT_CACHE_TTL_MS);
  }
  return { payload: { ok: true, texto: productText(product), ref: product.ref }, cacheHit };
}

async function requestHandler(request, response) {
  const startedAt = Date.now();
  const requestId = crypto.randomUUID();
  const route = new URL(request.url, 'http://localhost').pathname;
  const baseLog = { requestId, route, method: request.method };
  try {
    if (route === '/health' && request.method === 'GET') {
      const status = isConfigured() ? 200 : 503;
      respond(response, status, { ok: status === 200 });
      await audit('health', { ...baseLog, status, durationMs: Date.now() - startedAt });
      return;
    }
    if (route === '/dev/status' && request.method === 'GET') {
      ensureAdmin(request);
      respond(response, 200, adminStatus());
      await audit('admin_status', { ...baseLog, status: 200, durationMs: Date.now() - startedAt });
      return;
    }
    if (route === '/dev/logs' && request.method === 'GET') {
      ensureAdmin(request);
      const query = new URL(request.url, 'http://localhost').searchParams;
      const rawLimit = query.get('limit');
      const date = query.get('date');
      const limit = rawLimit === null ? 50 : Number.parseInt(rawLimit, 10);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ADMIN_LOG_ENTRIES) throw new HttpError(400, 'Parámetro inválido.');
      if (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'Parámetro inválido.');
      const entries = await recentAuditEntries(limit, date);
      respond(response, 200, { entries });
      await audit('admin_logs', { ...baseLog, status: 200, durationMs: Date.now() - startedAt });
      return;
    }
    if (!isConfigured()) throw new HttpError(503, 'Servicio no configurado.', { reason: 'missing_configuration' });
    if (request.method !== 'POST' || !['/manychat/buscar', '/manychat/producto'].includes(route)) throw new HttpError(404, 'No encontrado.');
    if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Se requiere application/json.');
    ensureManyChat(request);
    // El límite local se aplica solo después de autenticar ManyChat: una URL pública
    // no puede ser usada por bots anónimos para agotar el cupo del flujo real.
    if (!clientAllowed()) throw new HttpError(429, 'Demasiadas solicitudes.', { reason: 'local_rate_limit', retryAfter: 60 });
    const body = await readJsonBody(request);
    const result = route === '/manychat/buscar' ? await handleSearch(body) : await handleProduct(body);
    respond(response, 200, result.payload);
    await audit('request_ok', { ...baseLog, status: 200, durationMs: Date.now() - startedAt, cacheHit: result.cacheHit, queryType: result.queryType });
  } catch (error) {
    const known = error instanceof HttpError
      ? error
      : new HttpError(500, 'Error interno.', { reason: 'unexpected' }, ERROR_CODES.INTERNAL_UNEXPECTED);
    const retryAfter = Number.isInteger(known.details.retryAfter) && known.details.retryAfter > 0
      ? { 'retry-after': String(known.details.retryAfter) }
      : {};
    respond(response, known.status, { ok: false, texto: known.message, requestId }, retryAfter);
    await audit('request_error', { ...baseLog, status: known.status, durationMs: Date.now() - startedAt, errorCode: known.errorCode, reason: known.details.reason || 'handled', clamiStatus: known.details.clamiStatus });
  }
}

async function start() {
  await fs.mkdir(LOG_DIR, { recursive: true, mode: 0o700 });
  await acquireSingleInstanceLock();
  await loadState();
  await purgeOldLogs();
  // Retención continua: no depende de que Passenger reinicie la aplicación.
  const cleanupTimer = setInterval(() => {
    purgeEphemeralState();
  }, 60_000);
  cleanupTimer.unref();
  const logCleanupTimer = setInterval(() => {
    void purgeOldLogs().then(() => audit('log_retention_completed', { retentionDays: LOG_RETENTION_DAYS }));
  }, 24 * 60 * 60 * 1000);
  logCleanupTimer.unref();
  const server = http.createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, requestHandler);
  server.keepAliveTimeout = 5_000;
  server.on('clientError', () => undefined);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(PORT, resolve);
    });
  } catch (error) {
    await releaseSingleInstanceLock();
    throw error;
  }
  void audit('server_started', { port: PORT, configured: isConfigured() });
  const shutdown = () => server.close(() => {
    void releaseSingleInstanceLock().finally(() => process.exit(0));
  });
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

if (require.main === module) start().catch(async (error) => {
  await releaseSingleInstanceLock();
  console.error('Startup failed:', safeError(error));
  process.exit(1);
});

module.exports = { start, validateSearchBody, validateProductBody, productText, constantTimeMatch };
