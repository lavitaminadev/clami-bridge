'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { ERROR_CODES, HttpError } = require('./src/error-catalog');
const { requireProduct, requireSearchResults } = require('./src/clami-response');
const { readJsonBody, validateSearchBody, validateProductBody } = require('./src/input-validation');
const { productText } = require('./src/product-presentation');

// Passenger entrega el puerto por el entorno. El 3000 es solo para ejecutar la
// aplicacion a mano fuera del hosting.
//
// Un valor que no sirva como numero cae al de reserva en vez de propagarse como
// NaN hasta `listen`, donde el fallo no diria nada del puerto. El aviso de que eso
// ocurrio lo da `portWarning()`.
const DEFAULT_PORT = 3000;
const PORT = (() => {
  const crudo = String(process.env.PORT ?? DEFAULT_PORT).trim();
  const numero = Number.parseInt(crudo, 10);
  return /^\d+$/.test(crudo) && Number.isInteger(numero) && numero >= 1 && numero <= 65535 ? numero : DEFAULT_PORT;
})();
const CLAMI_BASE_URL = 'https://www.clami.cl/api/catalogo';
const LOG_DIR = path.resolve(process.env.LOG_DIR || path.join(__dirname, 'logs'));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const STATE_FILE = path.join(DATA_DIR, 'runtime-state.json');
const INSTANCE_LOCK_FILE = path.join(DATA_DIR, 'single-instance.lock');
const LOG_RETENTION_DAYS = 10;
// ManyChat corta toda External Request a los 10 s y el valor no es configurable
// («Timeout is limited to 10 seconds. It cannot be changed», Dev Tools: Basics).
// Ese techo se reparte: CLAMI responde dentro de estos 7 s y quedan ~3 s para TLS,
// Passenger y el armado de la respuesta. Con 10 s para CLAMI, una consulta lenta
// terminaba después del corte y el cliente veía el fallback en vez del aviso propio.
const MANYCHAT_REQUEST_TIMEOUT_MS = 10_000;
const CLAMI_TIMEOUT_MS = 7_000;
const MAX_UPSTREAM_PER_MINUTE = 55;
const MAX_UPSTREAM_PER_DAY = 2_700;
// CLAMI limita a 1.500 productos distintos por dia, aparte del tope de consultas.
// Se deja margen por si el mismo ref se pide desde otra integracion de la cuenta.
const MAX_DISTINCT_PRODUCTS_PER_DAY = 1_400;
const SEARCH_CACHE_TTL_MS = 45_000;
const PRODUCT_CACHE_TTL_MS = 20_000;
const MAX_CACHE_ENTRIES = 300;
const ADMIN_MAX_FAILURES = 3;
const ADMIN_LOCK_MS = 40_000;
const MAX_ADMIN_LOG_ENTRIES = 100;
const MAX_LOG_TAIL_BYTES = 64 * 1024;
const MAX_LOG_FILE_BYTES = 8 * 1024 * 1024;
// Estas rutas mantienen el contrato resumido existente y suman un contrato de
// detalle normalizado. El detalle no es un proxy crudo: pasa por la misma
// validación que protege al flujo normal ante respuestas incompletas de CLAMI.
const MANYCHAT_ROUTES = new Set([
  '/manychat/buscar',
  '/manychat/producto',
  '/manychat/buscar-detalle',
  '/manychat/producto-detalle'
]);
// El dueño del candado actualiza su marca de tiempo cada 15 s. Un candado cuya
// marca lleva mas de 45 s sin moverse pertenece a un proceso que ya no esta, sin
// importar que el PID escrito exista: en un hosting compartido los PID se reciclan
// y confiar solo en ellos puede dejar la aplicacion sin arrancar para siempre.
const LOCK_HEARTBEAT_MS = 15_000;
const LOCK_STALE_MS = 45_000;
// Passenger puede levantar el proceso nuevo antes de que el viejo termine. Esperar
// evita que el nuevo muera en el intento y Passenger entre en un ciclo de fallos.
const LOCK_ACQUIRE_TIMEOUT_MS = Number.parseInt(process.env.CLAMI_BRIDGE_LOCK_TIMEOUT_MS || 30000, 10);
const LOCK_RETRY_MS = 1_000;

// Que version esta corriendo no se puede deducir desde fuera: entre dos despliegues
// pueden cambiar solo pruebas o documentacion, y un cambio de comportamiento puede
// necesitar condiciones que no se provocan a mano. Se lee del repositorio al cargar
// el modulo, de modo que el valor corresponde al codigo que esta en memoria y no al
// que hay en disco. Si la aplicacion se subio sin el repositorio, queda en null.
function deployedCommit() {
  const git = (...partes) => path.join(__dirname, '.git', ...partes);
  try {
    const head = fsSync.readFileSync(git('HEAD'), 'utf8').trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head;
    const ref = head.replace(/^ref:\s*/, '');
    if (!/^refs\/[A-Za-z0-9._/-]+$/.test(ref)) return null;
    try {
      return fsSync.readFileSync(git(...ref.split('/')), 'utf8').trim() || null;
    } catch {
      // Un clon puede traer las referencias empaquetadas en vez de sueltas.
      const empaquetadas = fsSync.readFileSync(git('packed-refs'), 'utf8');
      const linea = empaquetadas.split('\n').find((l) => l.endsWith(' ' + ref));
      return linea ? linea.split(' ')[0] : null;
    }
  } catch {
    return null;
  }
}

const COMMIT = deployedCommit();

// Los registros no guardan direcciones. Para poder responder "esto fue una fuente
// repitiendo o muchas distintas" se escribe una marca derivada de la direccion con
// una sal aleatoria que nace con el proceso y nunca se persiste: dentro de una misma
// vida del proceso dos peticiones de la misma fuente comparten marca, y al reiniciar
// la correspondencia se pierde para siempre.
const SOURCE_SALT = crypto.randomBytes(16);

function sourceTag(request) {
  const reenviado = request.headers['x-forwarded-for'];
  const origen = String((typeof reenviado === 'string' ? reenviado.split(',')[0] : '') || request.socket.remoteAddress || '').trim();
  if (!origen) return null;
  return crypto.createHash('sha256').update(SOURCE_SALT).update(origen).digest('hex').slice(0, 8);
}
let writeQueue = Promise.resolve();
let runtimeState = { date: currentDate(), upstreamCalls: 0, cooldownUntil: 0, lastClami: null, productRefs: [], minuteCounters: [] };
let distinctProductRefs = new Set();
const cache = new Map();
let requestWindow = { start: Date.now(), count: 0 };
const adminFailures = new Map();
// Se persiste junto al resto del estado: vive en memoria para no escribir en cada
// peticion, pero sobrevive a un reinicio. Sin esto, Passenger levantando la
// aplicacion varias veces por minuto anulaba el tope de 55.
const upstreamMinuteCounters = new Map();
const startedAt = Date.now();
let instanceLockHeld = false;
let lockHeartbeat = null;

function currentDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date());
}

function safeError(error) {
  return error instanceof Error ? error.message.replace(/[\r\n]/g, ' ').slice(0, 200) : 'unknown_error';
}

// Mide una sola cosa: si la aplicacion tiene con que atender a ManyChat y a CLAMI.
// El puerto se comprueba aparte, al arrancar. Mezclarlos hacia que un PORT mal
// escrito en el panel dejara /health en 503, y tanto el README como la guia de
// fallas mandan a revisar las credenciales ante ese 503: el operador habria
// buscado el problema donde no estaba.
function isConfigured() {
  return Boolean(process.env.CLAMI_API_KEY && process.env.MANYCHAT_SECRET);
}

// Un PORT presente pero inservible como numero se anota y se sigue con el de
// reserva. No detiene el arranque a proposito: Passenger decide como entrega el
// puerto y esa forma puede cambiar entre versiones, de modo que un diagnostico
// nunca debe poder dejar el servicio sin levantar. El aviso queda en el registro
// de arranque y en /dev/status.
function portWarning() {
  if (process.env.PORT === undefined) return null;
  // Se juzga el valor recibido, no el ya resuelto: `0` y `70000` caen al de
  // reserva, que si es valido, y mirando el resuelto no avisarian de nada.
  const crudo = String(process.env.PORT).trim();
  const numero = Number.parseInt(crudo, 10);
  if (/^\d+$/.test(crudo) && numero >= 1 && numero <= 65535) return null;
  return `PORT no utilizable como numero: "${process.env.PORT}". Se usa ${PORT}`;
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

// El trafico sin autenticar no tiene limite propio, asi que el archivo del dia
// podria crecer sin fin. Al llegar al tope se deja de escribir y se anota una sola
// vez: perder detalle es preferible a llenar el disco de la cuenta.
let logTruncatedAt = 0;

async function logFileWithinLimit() {
  const archivo = path.join(LOG_DIR, logFileName());
  const stats = await fs.stat(archivo).catch(() => null);
  if (!stats || stats.size < MAX_LOG_FILE_BYTES) {
    logTruncatedAt = 0;
    return true;
  }
  if (logTruncatedAt !== stats.size) {
    logTruncatedAt = stats.size;
    process.stderr.write('log_size_limit_reached\n');
  }
  return false;
}

function audit(event, fields = {}) {
  // Se filtra al escribir, no solo al leer: un campo agregado por error en una
  // llamada futura no debe llegar nunca al disco, porque desde ahi ya no hay
  // vuelta atras. /dev/logs vuelve a filtrar por si el archivo trae algo viejo.
  const entry = JSON.stringify(sanitizeAuditEntry({ ts: new Date().toISOString(), event, ...fields })) + '\n';
  writeQueue = writeQueue
    .then(() => fs.mkdir(LOG_DIR, { recursive: true, mode: 0o700 }))
    .then(async () => {
      if (!(await logFileWithinLimit())) return;
      await fs.appendFile(path.join(LOG_DIR, logFileName()), entry, { encoding: 'utf8', mode: 0o600 });
    })
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
  distinctProductRefs = new Set(Array.isArray(runtimeState.productRefs) ? runtimeState.productRefs : []);
  upstreamMinuteCounters.clear();
  for (const [minuto, cuenta] of Array.isArray(runtimeState.minuteCounters) ? runtimeState.minuteCounters : []) {
    if (Number.isInteger(minuto) && Number.isInteger(cuenta)) upstreamMinuteCounters.set(minuto, cuenta);
  }
}

function resetDailyStateIfNeeded() {
  if (runtimeState.date !== currentDate()) {
    runtimeState = { date: currentDate(), upstreamCalls: 0, cooldownUntil: 0, lastClami: runtimeState.lastClami || null, productRefs: [], minuteCounters: [] };
    distinctProductRefs = new Set();
    upstreamMinuteCounters.clear();
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
  // Sin latido reciente el dueño no esta vivo, aunque su PID exista: es la unica
  // forma de distinguir un proceso que sigue trabajando de un PID reciclado.
  const latido = await fs.stat(INSTANCE_LOCK_FILE).catch(() => null);
  if (latido && Date.now() - latido.mtimeMs > LOCK_STALE_MS) return false;

  try {
    const owner = JSON.parse(await fs.readFile(INSTANCE_LOCK_FILE, 'utf8'));
    // Un candado a medio escribir o ilegible se trata como activo: borrarlo por
    // optimismo podria dejar dos procesos consumiendo la misma cuota.
    if (!Number.isInteger(owner.pid) || owner.pid <= 0) return true;
    try {
      process.kill(owner.pid, 0);
      return true;
    } catch (error) {
      // EPERM significa que el PID existe; solo ESRCH prueba que no.
      return error && error.code !== 'ESRCH';
    }
  } catch {
    return true;
  }
}

function startLockHeartbeat() {
  lockHeartbeat = setInterval(() => {
    const ahora = new Date();
    void fs.utimes(INSTANCE_LOCK_FILE, ahora, ahora).catch(() => undefined);
  }, LOCK_HEARTBEAT_MS);
  lockHeartbeat.unref();
}

async function acquireSingleInstanceLock({ timeoutMs = LOCK_ACQUIRE_TIMEOUT_MS } = {}) {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  const limite = Date.now() + timeoutMs;

  for (;;) {
    try {
      const handle = await fs.open(INSTANCE_LOCK_FILE, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n', 'utf8');
      await handle.close();
      instanceLockHeld = true;
      startLockHeartbeat();
      return;
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;

      if (!(await lockOwnerIsRunning())) {
        await fs.unlink(INSTANCE_LOCK_FILE).catch(() => undefined);
        continue;
      }
      // El dueño sigue vivo. En un reinicio rodante termina en segundos, asi que
      // se espera antes de rendirse en vez de morir al primer intento.
      if (Date.now() >= limite) {
        throw new HttpError(503, 'Ya existe una instancia activa.', { reason: 'state_lock_unavailable' }, ERROR_CODES.STATE_LOCK_UNAVAILABLE);
      }
      await new Promise((listo) => setTimeout(listo, LOCK_RETRY_MS));
    }
  }
}

async function releaseSingleInstanceLock() {
  if (!instanceLockHeld) return;
  instanceLockHeld = false;
  if (lockHeartbeat) clearInterval(lockHeartbeat);
  await fs.unlink(INSTANCE_LOCK_FILE).catch(() => undefined);
}

// Red de seguridad para cualquier salida: una excepcion sin capturar, un exit(1)
// desde app.js o un cierre normal. No alcanza para una terminacion forzada, y para
// eso esta el latido.
process.on('exit', () => {
  if (!instanceLockHeld) return;
  try { fsSync.unlinkSync(INSTANCE_LOCK_FILE); } catch { /* ya no estaba */ }
});

function cacheGet(key) {
  const value = cache.get(key);
  if (!value) return null;
  if (value.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  // Reinsertar mueve la entrada al final del orden de iteracion, de modo que el
  // desalojo quita lo menos usado y no lo mas antiguo: sin esto, el termino mas
  // consultado era el primero en salir.
  cache.delete(key);
  cache.set(key, value);
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
  runtimeState.minuteCounters = [...upstreamMinuteCounters];
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
      throw new HttpError(404, 'Producto no encontrado.', { clamiStatus: 404, reason: 'product_not_found' });
    }
    if (!response.ok) {
      runtimeState.lastClami = { at: new Date().toISOString(), status: response.status, outcome: 'upstream_error' };
      void persistState();
      throw new HttpError(502, 'El catálogo no respondió correctamente.', { clamiStatus: response.status, reason: 'upstream_error' });
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

function ensureAdmin(request, baseLog = {}) {
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
  if (failure?.lockedUntil > now) {
    // Tambien se registra: sin esta linea, del cuarto intento en adelante no
    // quedaba rastro y los registros subrepresentaban un intento sostenido.
    void audit('admin_auth_failed', { ...baseLog, status: 429, reason: 'admin_locked' });
    throw new HttpError(429, 'No autorizado.', { reason: 'admin_locked', retryAfter: Math.max(1, Math.ceil((failure.lockedUntil - now) / 1000)) });
  }
  const attempts = (failure?.attempts || 0) + 1;
  const lockedUntil = attempts >= ADMIN_MAX_FAILURES ? now + ADMIN_LOCK_MS : 0;
  adminFailures.set(fingerprint, { attempts: lockedUntil ? 0 : attempts, lockedUntil, updatedAt: now });
  void audit('admin_auth_failed', { ...baseLog, status: lockedUntil ? 429 : 401, reason: lockedUntil ? 'admin_locked' : 'invalid_admin_token' });
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
    commit: COMMIT,
    portWarning: portWarning(),
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    quota: {
      upstreamCallsToday: runtimeState.upstreamCalls,
      maxPerDay: MAX_UPSTREAM_PER_DAY,
      distinctProductsToday: distinctProductRefs.size,
      maxDistinctProductsPerDay: MAX_DISTINCT_PRODUCTS_PER_DAY
    },
    cooldownSeconds: Math.max(0, Math.ceil((runtimeState.cooldownUntil - Date.now()) / 1000)),
    cacheEntries: cache.size,
    lastClami: runtimeState.lastClami || null,
    logRetentionDays: LOG_RETENTION_DAYS
  };
}

function sanitizeAuditEntry(entry) {
  const allowed = ['ts', 'event', 'requestId', 'route', 'method', 'status', 'durationMs', 'cacheHit', 'queryType', 'errorCode', 'reason', 'clamiStatus', 'retentionDays', 'commit', 'source'];
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

// CLAMI cuenta aparte los productos distintos consultados en el dia. Solo se registran
// los que llegan a pedirse por `/producto/<ref>/`: un acierto de cache no consulta nada.
// Que una busqueda devuelva un producto cuente o no para ese tope no esta dicho en la
// especificacion; se toma la lectura estrecha y queda por confirmar con CLAMI.
function assertDistinctProductBudget(ref) {
  resetDailyStateIfNeeded();
  if (distinctProductRefs.has(ref)) return;
  if (distinctProductRefs.size >= MAX_DISTINCT_PRODUCTS_PER_DAY) {
    throw new HttpError(503, "El catálogo alcanzó el límite interno diario. Intenta mañana.", { reason: "distinct_product_budget" });
  }
}

// Se registra despues de que el catalogo respondio. Contarlo antes hacia que un
// timeout o un error de red gastaran un cupo que CLAMI nunca llego a usar.
function registerDistinctProduct(ref) {
  if (distinctProductRefs.has(ref)) return;
  distinctProductRefs.add(ref);
  runtimeState.productRefs = [...distinctProductRefs];
  void persistState();
}

async function loadSearch(body) {
  const { q, channel, isBarcode } = validateSearchBody(body);
  const cacheKey = `search:${q.toLocaleLowerCase('es-CL')}`;
  let results = isBarcode ? null : cacheGet(cacheKey);
  const cacheHit = Boolean(results);
  if (!results) {
    // Validar antes de cachear: guardar la respuesta cruda hacia que una
    // malformada se sirviera durante todo el TTL sin volver a consultar.
    results = requireSearchResults(await clamiGet(`/buscar/?q=${encodeURIComponent(q)}`));
    if (!isBarcode) cacheSet(cacheKey, results, SEARCH_CACHE_TTL_MS);
  }
  return { q, channel, isBarcode, results, cacheHit, queryType: isBarcode ? 'barcode' : 'text' };
}

async function handleSearch(body) {
  const { channel, isBarcode, results, cacheHit, queryType } = await loadSearch(body);
  if (!results.length) return { payload: { ok: true, texto: 'No encontré productos para esa búsqueda.', opciones: [] }, cacheHit, queryType: isBarcode ? 'barcode' : 'text' };
  const options = results.map((product, index) => ({ numero: index + 1, ref: product.ref, texto: productText(product) }));
  const texto = options.length === 1 ? options[0].texto : `Encontré ${options.length} opciones. Responde con el número que corresponde.`;
  return { payload: { ok: true, texto, opciones: options, canal: channel }, cacheHit, queryType };
}

async function loadProduct(body) {
  const ref = validateProductBody(body);
  const cacheKey = `product:${ref}`;
  let product = cacheGet(cacheKey);
  const cacheHit = Boolean(product);
  if (!product) {
    assertDistinctProductBudget(ref);
    product = requireProduct(await clamiGet(`/producto/${encodeURIComponent(ref)}/`));
    registerDistinctProduct(ref);
    cacheSet(cacheKey, product, PRODUCT_CACHE_TTL_MS);
  }
  return { product, cacheHit };
}

async function handleProduct(body) {
  const { product, cacheHit } = await loadProduct(body);
  return { payload: { ok: true, texto: productText(product), ref: product.ref }, cacheHit };
}

// Contrato avanzado opcional. Se conservan solo los campos públicos y validados
// del esquema CLAMI; no se reenvía la respuesta HTTP cruda del upstream.
async function handleSearchDetail(body) {
  const { q, channel, isBarcode, results, cacheHit } = await loadSearch(body);
  return {
    payload: { ok: true, consulta: isBarcode ? null : q, resultados: results, canal: channel },
    cacheHit,
    queryType: isBarcode ? 'detail_barcode' : 'detail_text'
  };
}

async function handleProductDetail(body) {
  const { product, cacheHit } = await loadProduct(body);
  return { payload: { ok: true, producto: product }, cacheHit, queryType: 'detail_product' };
}

// Condiciones de operación: el catálogo no respondió, se agotó un cupo o el producto
// no existe. El cliente tiene que enterarse por el bot.
const OPERATIONAL_CODES = new Set([
  ERROR_CODES.CLAMI_COOLDOWN,
  ERROR_CODES.CLAMI_DAILY_BUDGET,
  ERROR_CODES.CLAMI_DISTINCT_PRODUCT_BUDGET,
  ERROR_CODES.CLAMI_MINUTE_BUDGET,
  ERROR_CODES.CLAMI_RATE_LIMITED,
  ERROR_CODES.CLAMI_CREDENTIAL_OR_ORIGIN,
  ERROR_CODES.CLAMI_PRODUCT_NOT_FOUND,
  ERROR_CODES.CLAMI_UPSTREAM_ERROR,
  ERROR_CODES.CLAMI_RESPONSE_INVALID,
  ERROR_CODES.CLAMI_TIMEOUT,
  ERROR_CODES.CLAMI_NETWORK_ERROR,
  ERROR_CODES.LOCAL_RATE_LIMIT
]);

// ManyChat solo sabe leer el cuerpo de una respuesta 200: «It's not possible to map an
// error message if the returned code is not 200 OK» (Dev Tools: Basics). Con cualquier
// otro código descarta el cuerpo y entrega su contenido de fallback, así que el aviso
// redactado aquí nunca llegaba al cliente.
//
// Las rutas de ManyChat devuelven 200 cuando la causa es de operación y el texto está
// pensado para el cliente. Un error de configuración —secreto equivocado, método o
// Content-Type incorrecto, ruta inexistente— conserva su código real: ahí el fallback
// es la respuesta correcta y el código es lo que permite encontrar la falla.
// `/health` y `/dev/*` no pasan por ManyChat y mantienen siempre su código.
function responseStatusFor(route, error) {
  const isManyChatRoute = MANYCHAT_ROUTES.has(route);
  return isManyChatRoute && OPERATIONAL_CODES.has(error.errorCode) ? 200 : error.status;
}

async function requestHandler(request, response) {
  const startedAt = Date.now();
  const requestId = crypto.randomUUID();
  const route = new URL(request.url, 'http://localhost').pathname;
  const baseLog = { requestId, route, method: request.method, source: sourceTag(request) };
  try {
    if (route === '/health' && request.method === 'GET') {
      const status = isConfigured() ? 200 : 503;
      respond(response, status, { ok: status === 200 });
      await audit('health', { ...baseLog, status, durationMs: Date.now() - startedAt });
      return;
    }
    if (route === '/dev/status' && request.method === 'GET') {
      ensureAdmin(request, baseLog);
      respond(response, 200, adminStatus());
      await audit('admin_status', { ...baseLog, status: 200, durationMs: Date.now() - startedAt });
      return;
    }
    if (route === '/dev/logs' && request.method === 'GET') {
      ensureAdmin(request, baseLog);
      const query = new URL(request.url, 'http://localhost').searchParams;
      const rawLimit = query.get('limit');
      const date = query.get('date');
      const limit = rawLimit === null ? 50 : Number.parseInt(rawLimit, 10);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ADMIN_LOG_ENTRIES) throw new HttpError(400, 'Parámetro inválido.', {}, ERROR_CODES.ADMIN_LOG_QUERY_INVALID);
      if (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'Parámetro inválido.', {}, ERROR_CODES.ADMIN_LOG_QUERY_INVALID);
      const entries = await recentAuditEntries(limit, date);
      respond(response, 200, { entries });
      await audit('admin_logs', { ...baseLog, status: 200, durationMs: Date.now() - startedAt });
      return;
    }
    if (!isConfigured()) throw new HttpError(503, 'Servicio no configurado.', { reason: 'missing_configuration' });
    if (request.method !== 'POST' || !MANYCHAT_ROUTES.has(route)) throw new HttpError(404, 'No encontrado.');
    if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Se requiere application/json.');
    ensureManyChat(request);
    // El límite local se aplica solo después de autenticar ManyChat: una URL pública
    // no puede ser usada por bots anónimos para agotar el cupo del flujo real.
    if (!clientAllowed()) throw new HttpError(429, 'Demasiadas solicitudes.', { reason: 'local_rate_limit', retryAfter: 60 });
    const body = await readJsonBody(request);
    const result = route === '/manychat/buscar'
      ? await handleSearch(body)
      : route === '/manychat/producto'
        ? await handleProduct(body)
        : route === '/manychat/buscar-detalle'
          ? await handleSearchDetail(body)
          : await handleProductDetail(body);
    respond(response, 200, result.payload);
    await audit('request_ok', { ...baseLog, status: 200, durationMs: Date.now() - startedAt, cacheHit: result.cacheHit, queryType: result.queryType });
  } catch (error) {
    const known = error instanceof HttpError
      ? error
      : new HttpError(500, 'Error interno.', { reason: 'unexpected' }, ERROR_CODES.INTERNAL_UNEXPECTED);
    const status = responseStatusFor(route, known);
    const retryAfter = status !== 200 && Number.isInteger(known.details.retryAfter) && known.details.retryAfter > 0
      ? { 'retry-after': String(known.details.retryAfter) }
      : {};
    respond(response, status, { ok: false, texto: known.message, codigo: known.errorCode, requestId }, retryAfter);
    await audit('request_error', { ...baseLog, status, durationMs: Date.now() - startedAt, errorCode: known.errorCode, reason: known.details.reason || 'handled', clamiStatus: known.details.clamiStatus });
  }
}

async function start() {
  // El nombre de cada archivo de registro sale de esta fecha. Un Node compilado sin
  // ICU completo daria otro formato, el nombre llevaria barras, la escritura
  // fallaria y la limpieza dejaria de reconocer los archivos. Mejor no arrancar.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(currentDate())) {
    throw new Error('Node sin soporte horario completo: la fecha no tiene formato AAAA-MM-DD');
  }
  const avisoPuerto = portWarning();
  if (avisoPuerto) process.stderr.write(`${avisoPuerto}\n`);
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
  // Por debajo del corte de ManyChat: una petición que siguiera abierta más allá de
  // esos 10 s ya no tiene a quién responder.
  // Sin estas dos guardas, un fallo imprevisto mata el proceso; al reiniciar entra
  // en juego el riesgo del candado y el servicio puede quedar caido. Se registra y
  // se sigue sirviendo: un worker vivo con un error anotado vale mas que uno muerto.
  process.on('unhandledRejection', (error) => { void audit('unhandled_rejection', { reason: safeError(error) }); });
  process.on('uncaughtException', (error) => { void audit('uncaught_exception', { reason: safeError(error) }); });

  const server = http.createServer({ requestTimeout: MANYCHAT_REQUEST_TIMEOUT_MS - 1_000, headersTimeout: 5_000 }, requestHandler);
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
  void audit('server_started', { port: PORT, configured: isConfigured(), commit: COMMIT });
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

// Se exportan tambien las piezas internas que sostienen garantias comprobables:
// la lista blanca de los registros, el vencimiento y desalojo de la cache, y el
// candado de proceso. Sin exportarlas no hay forma de fijarlas con un test.
module.exports = {
  start,
  validateSearchBody,
  validateProductBody,
  productText,
  constantTimeMatch,
  responseStatusFor,
  sanitizeAuditEntry,
  audit,
  persistState,
  cacheGet,
  cacheSet,
  acquireSingleInstanceLock,
  deployedCommit,
  isConfigured,
  portWarning,
  sourceTag,
  clamiGet,
  loadState,
  adminStatus,
  purgeOldLogs,
  purgeEphemeralState,
  lockOwnerIsRunning,
  registerDistinctProduct,
  assertDistinctProductBudget,
  LOG_RETENTION_DAYS,
  MAX_DISTINCT_PRODUCTS_PER_DAY,
  requestHandler,
  releaseSingleInstanceLock,
  MAX_CACHE_ENTRIES
};
