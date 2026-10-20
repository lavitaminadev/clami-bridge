'use strict';

// La capa HTTP: autenticacion, orden de las comprobaciones, cabeceras y codigos.
// Se invoca `requestHandler` con peticiones y respuestas simuladas, sin abrir un
// puerto, y `fetch` se sustituye por un doble para no salir de la maquina.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'http-'));
process.env.DATA_DIR = path.join(DIR, 'data');
process.env.LOG_DIR = path.join(DIR, 'logs');
process.env.CLAMI_API_KEY = 'clami_cat_credencial_de_prueba_0001';
process.env.MANYCHAT_SECRET = 'secreto-de-prueba-para-manychat';
process.env.ADMIN_STATUS_TOKEN = 'token-de-desarrollador-para-prueba';

const test = require('node:test');
const assert = require('node:assert/strict');
const { requestHandler } = require('../server');
const { ERROR_CODES } = require('../src/error-catalog');

const SECRETO = process.env.MANYCHAT_SECRET;
const TOKEN = process.env.ADMIN_STATUS_TOKEN;

const fetchReal = globalThis.fetch;
test.after(() => {
  globalThis.fetch = fetchReal;
  fs.rmSync(DIR, { recursive: true, force: true });
});

function upstream(body) {
  globalThis.fetch = async () => ({
    status: 200, ok: true, headers: { get: () => null }, json: async () => body
  });
}

// `requestHandler` consume la peticion como iterable asincrono y escribe la
// respuesta con writeHead/end: alcanza con reproducir esa superficie.
async function pedir({ method = 'GET', url = '/', headers = {}, body = null } = {}) {
  const peticion = {
    method,
    url,
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { if (body !== null) yield Buffer.from(body, 'utf8'); }
  };
  const capturado = {};
  const respuesta = {
    writeHead(status, cabeceras) { capturado.status = status; capturado.headers = cabeceras; },
    end(cuerpo) { capturado.body = cuerpo ? JSON.parse(cuerpo) : null; }
  };
  await requestHandler(peticion, respuesta);
  return capturado;
}

const json = { 'content-type': 'application/json' };
const conSecreto = { ...json, 'x-manychat-secret': SECRETO };

const PRODUCTO = { ref: 'hG44NhfYg4wCk1KiEbls6w', nombre: 'PARACETAMOL', tipo: 'MEDICAMENTOS', marca: 'GENERICO', stock: 2, locales: [{ nombre_local: 'Casa matriz', stock: 2 }], precio_venta: 600, receta_retenida: false };

test('/health responde sin credenciales y no revela nada mas', async () => {
  const r = await pedir({ url: '/health' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true });
});

test('toda respuesta lleva las cabeceras de seguridad', async () => {
  const r = await pedir({ url: '/health' });
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['x-frame-options'], 'DENY');
  assert.equal(r.headers['referrer-policy'], 'no-referrer');
  assert.match(r.headers['content-security-policy'], /default-src 'none'/);
});

test('sin el secreto de ManyChat no se llega a leer el cuerpo', async () => {
  let llamado = false;
  globalThis.fetch = async () => { llamado = true; throw new Error('no deberia'); };
  const r = await pedir({ method: 'POST', url: '/manychat/buscar', headers: json, body: '{"q":"paracetamol"}' });
  assert.equal(r.status, 401);
  assert.equal(r.body.codigo, ERROR_CODES.MANYCHAT_SECRET_INVALID);
  assert.equal(llamado, false, 'se consulto CLAMI sin autenticar');
});

test('un secreto equivocado no distingue su mensaje del secreto ausente', async () => {
  const sinSecreto = await pedir({ method: 'POST', url: '/manychat/buscar', headers: json, body: '{"q":"x"}' });
  const malSecreto = await pedir({ method: 'POST', url: '/manychat/buscar', headers: { ...json, 'x-manychat-secret': 'otro' }, body: '{"q":"x"}' });
  assert.equal(sinSecreto.body.texto, malSecreto.body.texto);
  assert.equal(sinSecreto.status, malSecreto.status);
});

test('el Content-Type se exige antes que el secreto', async () => {
  // Rechazar por tipo antes de comparar el secreto evita trabajo con una peticion
  // que de todas formas no es la esperada.
  const r = await pedir({ method: 'POST', url: '/manychat/buscar', headers: { 'content-type': 'text/plain' }, body: 'x' });
  assert.equal(r.status, 415);
  assert.equal(r.body.codigo, ERROR_CODES.REQUEST_CONTENT_TYPE_INVALID);
});

test('un application/json con charset se acepta', async () => {
  upstream({ resultados: [] });
  const r = await pedir({
    method: 'POST', url: '/manychat/buscar',
    headers: { ...conSecreto, 'content-type': 'application/json; charset=utf-8' },
    body: '{"q":"termino-charset"}'
  });
  assert.equal(r.status, 200);
});

test('los metodos que no son POST en rutas de ManyChat dan 404', async () => {
  for (const method of ['GET', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    const r = await pedir({ method, url: '/manychat/buscar', headers: conSecreto });
    assert.equal(r.status, 404, `${method} no dio 404`);
    assert.equal(r.body.codigo, ERROR_CODES.ROUTE_NOT_FOUND);
  }
});

test('una ruta inexistente no revela si existe algo detras', async () => {
  for (const url of ['/', '/admin', '/.env', '/server.js', '/data/runtime-state.json']) {
    const r = await pedir({ url });
    assert.equal(r.status, 404);
    // `texto` va siempre: es el unico campo que ManyChat muestra al cliente.
    assert.deepEqual(Object.keys(r.body).sort(), ['codigo', 'ok', 'requestId', 'texto']);
  }
});

test('una busqueda autenticada devuelve texto y opciones', async () => {
  // Cada prueba usa su propio termino: la cache de busqueda dura 45 s y uno
  // repetido devolveria el resultado de la prueba anterior sin consultar.
  upstream({ consulta: 'paracetamol', resultados: [PRODUCTO] });
  const r = await pedir({ method: 'POST', url: '/manychat/buscar', headers: conSecreto, body: '{"q":"termino-busqueda-ok","canal":"whatsapp"}' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.opciones[0].ref, PRODUCTO.ref);
  assert.match(r.body.opciones[0].texto, /PARACETAMOL — \$600/);
  assert.equal(r.body.canal, 'whatsapp');
});

test('la respuesta al bot nunca incluye la credencial ni el secreto', async () => {
  upstream({ resultados: [PRODUCTO] });
  const r = await pedir({ method: 'POST', url: '/manychat/buscar', headers: conSecreto, body: '{"q":"termino-sin-filtracion"}' });
  const texto = JSON.stringify(r.body);
  assert.equal(texto.includes(process.env.CLAMI_API_KEY), false);
  assert.equal(texto.includes(SECRETO), false);
});

test('un fallo del catalogo sale en 200 con su codigo, para que ManyChat lo lea', async () => {
  globalThis.fetch = async () => { throw Object.assign(new Error('caido'), { name: 'TypeError' }); };
  const r = await pedir({ method: 'POST', url: '/manychat/buscar', headers: conSecreto, body: '{"q":"termino-catalogo-caido"}' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.codigo, ERROR_CODES.CLAMI_NETWORK_ERROR);
  assert.ok(r.body.texto.length > 0);
});

test('un error de configuracion conserva su codigo y no se disfraza de 200', async () => {
  const r = await pedir({ method: 'POST', url: '/manychat/buscar', headers: { ...json, 'x-manychat-secret': 'malo' }, body: '{"q":"x"}' });
  assert.equal(r.status, 401);
});

test('/dev/status exige el token y no filtra por que fallo', async () => {
  const sin = await pedir({ url: '/dev/status' });
  assert.equal(sin.status, 401);
  assert.equal(sin.body.texto, 'No autorizado.');

  const con = await pedir({ url: '/dev/status', headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(con.status, 200);
  assert.equal(con.body.ok, true);
  assert.ok(Object.hasOwn(con.body.quota, 'maxDistinctProductsPerDay'));
});

test('/dev/status no devuelve ninguna credencial', async () => {
  const r = await pedir({ url: '/dev/status', headers: { authorization: `Bearer ${TOKEN}` } });
  const texto = JSON.stringify(r.body);
  for (const secreto of [process.env.CLAMI_API_KEY, SECRETO, TOKEN]) {
    assert.equal(texto.includes(secreto), false);
  }
});

test('/dev/logs valida sus parametros', async () => {
  const cabeceras = { authorization: `Bearer ${TOKEN}` };
  for (const url of ['/dev/logs?limit=0', '/dev/logs?limit=999', '/dev/logs?limit=abc', '/dev/logs?date=ayer']) {
    const r = await pedir({ url, headers: cabeceras });
    assert.equal(r.status, 400, `${url} no dio 400`);
  }
  const ok = await pedir({ url: '/dev/logs?limit=5', headers: cabeceras });
  assert.equal(ok.status, 200);
  assert.ok(Array.isArray(ok.body.entries));
});

test('los eventos registrados no contienen lo que el cliente busco', async () => {
  upstream({ resultados: [PRODUCTO] });
  await pedir({ method: 'POST', url: '/manychat/buscar', headers: conSecreto, body: '{"q":"ibuprofeno-marcador-unico"}' });
  // El escritor de registros encola las escrituras: esperar un turno basta.
  await new Promise((r) => setTimeout(r, 50));
  const r = await pedir({ url: '/dev/logs?limit=50', headers: { authorization: `Bearer ${TOKEN}` } });
  const texto = JSON.stringify(r.body);
  assert.equal(texto.includes('ibuprofeno-marcador-unico'), false, 'el registro guardo la busqueda');
  assert.equal(texto.includes(PRODUCTO.ref), false, 'el registro guardo el ref');
});

test('tres fallos del mismo token lo bloquean sin afectar a otro valor', async () => {
  const malo = { authorization: 'Bearer token-malo-repetido' };
  assert.equal((await pedir({ url: '/dev/status', headers: malo })).status, 401);
  assert.equal((await pedir({ url: '/dev/status', headers: malo })).status, 401);
  assert.equal((await pedir({ url: '/dev/status', headers: malo })).status, 429);

  // Otro valor erroneo empieza su propia cuenta: un bot no deja fuera al token real.
  const otro = await pedir({ url: '/dev/status', headers: { authorization: 'Bearer token-malo-distinto' } });
  assert.equal(otro.status, 401);

  const bueno = await pedir({ url: '/dev/status', headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(bueno.status, 200);
});

test('el bloqueo administrativo propaga Retry-After', async () => {
  const malo = { authorization: 'Bearer otro-token-para-bloquear' };
  await pedir({ url: '/dev/status', headers: malo });
  await pedir({ url: '/dev/status', headers: malo });
  const r = await pedir({ url: '/dev/status', headers: malo });
  assert.equal(r.status, 429);
  assert.equal(r.headers['retry-after'], '40');
});

test('un cuerpo de mas de 8 KB se rechaza despues de autenticar', async () => {
  const r = await pedir({ method: 'POST', url: '/manychat/buscar', headers: conSecreto, body: '{"q":"' + 'a'.repeat(9000) + '"}' });
  assert.equal(r.status, 413);
  assert.equal(r.body.codigo, ERROR_CODES.REQUEST_BODY_TOO_LARGE);
});

test('toda respuesta trae requestId para poder rastrearla', async () => {
  const r = await pedir({ method: 'POST', url: '/manychat/buscar', headers: json, body: '{"q":"x"}' });
  assert.match(r.body.requestId, /^[0-9a-f-]{36}$/);
});

test('un rechazo administrativo deja un registro cruzable con la peticion', () => {
  // Antes se registraba solo la ruta y el motivo: no habia requestId ni estado con
  // que cruzarlo contra el request_error de esa misma peticion.
  const { sanitizeAuditEntry } = require('../server');
  const entrada = sanitizeAuditEntry({
    ts: '2026-10-20T20:01:12.747Z', event: 'admin_auth_failed',
    requestId: 'c1caccf9-f4bb-4665-8b31-a59276df418c', route: '/dev/status',
    method: 'GET', status: 401, source: 'deadbeef', reason: 'invalid_admin_token'
  });
  for (const campo of ['requestId', 'route', 'method', 'status', 'source', 'reason']) {
    assert.ok(Object.hasOwn(entrada, campo), `falta ${campo}`);
  }
});
