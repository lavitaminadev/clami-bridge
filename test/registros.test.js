'use strict';

// La lista blanca de los registros es un control de privacidad: lo que no esta en
// ella no se escribe, aunque alguien lo agregue al evento mas adelante. Sin un test
// que lo fije, ese agregado pasa sin que nadie lo note.

const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeAuditEntry } = require('../server');

test('el registro conserva solo los campos tecnicos de la lista blanca', () => {
  const salida = sanitizeAuditEntry({
    ts: '2026-10-20T17:00:00.000Z',
    event: 'request_ok',
    requestId: 'abc',
    route: '/manychat/buscar',
    method: 'POST',
    status: 200,
    durationMs: 12,
    cacheHit: false,
    queryType: 'text',
    errorCode: 'X',
    reason: 'handled',
    clamiStatus: 200,
    retentionDays: 10
  });
  assert.deepEqual(Object.keys(salida).sort(), [
    'cacheHit', 'clamiStatus', 'durationMs', 'errorCode', 'event', 'method',
    'queryType', 'reason', 'requestId', 'retentionDays', 'route', 'status', 'ts'
  ]);
});

test('descarta cualquier campo con contenido del cliente o credenciales', () => {
  const salida = sanitizeAuditEntry({
    ts: '2026-10-20T17:00:00.000Z',
    event: 'request_ok',
    status: 200,
    q: 'paracetamol',
    ref: 'hG44NhfYg4wCk1KiEbls6w',
    codigoBarra: '7801234567890',
    authorization: 'Bearer secreto',
    'x-manychat-secret': 'secreto',
    ip: '203.0.113.9',
    body: { q: 'ibuprofeno' },
    texto: 'PARACETAMOL — $600.'
  });
  for (const prohibido of ['q', 'ref', 'codigoBarra', 'authorization', 'x-manychat-secret', 'ip', 'body', 'texto']) {
    assert.equal(Object.hasOwn(salida, prohibido), false, `se filtro ${prohibido}`);
  }
  assert.deepEqual(Object.keys(salida).sort(), ['event', 'status', 'ts']);
});

test('un campo permitido con valor nulo o falso se conserva', () => {
  // `cacheHit: false` y `status: 0` son datos, no ausencias: filtrarlos por
  // falsedad dejaria huecos en la auditoria.
  const salida = sanitizeAuditEntry({ event: 'x', cacheHit: false, durationMs: 0, reason: null });
  assert.equal(salida.cacheHit, false);
  assert.equal(salida.durationMs, 0);
  assert.equal(salida.reason, null);
});

test('una entrada vacia no inventa campos', () => {
  assert.deepEqual(sanitizeAuditEntry({}), {});
});

const { sourceTag } = require('../server');

function pet(headers = {}, remoteAddress = '203.0.113.9') {
  return { headers, socket: { remoteAddress } };
}

test('la marca de origen agrupa la misma fuente y separa fuentes distintas', () => {
  // Permite responder "fue uno repitiendo o fueron muchos" sin guardar la direccion.
  const a = sourceTag(pet({}, '203.0.113.9'));
  const b = sourceTag(pet({}, '203.0.113.9'));
  const c = sourceTag(pet({}, '198.51.100.4'));
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('la marca no permite recuperar la direccion', () => {
  const marca = sourceTag(pet({}, '203.0.113.9'));
  assert.match(marca, /^[0-9a-f]{8}$/);
  assert.equal(marca.includes('203'), false);
  assert.equal(marca.includes('113'), false);
});

test('se usa el primer salto de X-Forwarded-For, no la direccion del proxy', () => {
  // Detras de Passenger la direccion del socket es siempre la del proxy interno:
  // sin esto todas las peticiones compartirian marca y el dato no diria nada.
  const cliente = sourceTag(pet({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }, '127.0.0.1'));
  const directo = sourceTag(pet({}, '203.0.113.9'));
  assert.equal(cliente, directo);
});

test('sin origen conocido la marca es nula, no una cadena inventada', () => {
  assert.equal(sourceTag(pet({}, '')), null);
  assert.equal(sourceTag(pet({ 'x-forwarded-for': '   ' }, '')), null);
});

test('la marca de origen y el commit sobreviven a la sanitizacion', () => {
  const salida = sanitizeAuditEntry({ event: 'server_started', commit: 'a'.repeat(40), source: 'deadbeef', ip: '203.0.113.9' });
  assert.equal(salida.commit, 'a'.repeat(40));
  assert.equal(salida.source, 'deadbeef');
  assert.equal(Object.hasOwn(salida, 'ip'), false);
});

test('un campo fuera de la lista blanca no llega al disco', async () => {
  // La garantia escrita es que no se escribe, no que no se muestre: filtrar solo al
  // leer dejaba el dato en el archivo para siempre.
  const os = require('node:os'); const path = require('node:path'); const fsr = require('node:fs');
  const dir = fsr.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
  process.env.LOG_DIR = dir;
  delete require.cache[require.resolve('../server')];
  const { audit } = require('../server');

  await audit('prueba', { route: '/x', q: 'paracetamol', ref: 'a'.repeat(22), authorization: 'Bearer secreto' });

  const archivo = fsr.readdirSync(dir).find((n) => n.startsWith('bridge-'));
  const escrito = fsr.readFileSync(path.join(dir, archivo), 'utf8');
  assert.match(escrito, /"route":"\/x"/);
  for (const prohibido of ['paracetamol', 'aaaaaaaaaaaaaaaaaaaaaa', 'secreto', 'authorization']) {
    assert.equal(escrito.includes(prohibido), false, `se escribio ${prohibido} en el archivo`);
  }
  fsr.rmSync(dir, { recursive: true, force: true });
});
