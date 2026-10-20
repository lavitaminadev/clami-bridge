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
