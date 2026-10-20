'use strict';

// La cache guarda resultados del catalogo y tiene un tope de entradas. El contador
// del limite por minuto vivio dentro de este mismo mapa: al llenarse, el desalojo
// podia llevarselo y el limite se reiniciaba solo. Hoy vive aparte, y estos tests
// fijan que el desalojo siga afectando unicamente a resultados cacheados.

const test = require('node:test');
const assert = require('node:assert/strict');
const { cacheGet, cacheSet, MAX_CACHE_ENTRIES } = require('../server');

test('una entrada vigente se devuelve tal cual', () => {
  cacheSet('prueba:vigente', { nombre: 'Producto' }, 60_000);
  assert.deepEqual(cacheGet('prueba:vigente'), { nombre: 'Producto' });
});

test('una entrada vencida no se devuelve', () => {
  cacheSet('prueba:vencida', 'valor', -1);
  assert.equal(cacheGet('prueba:vencida'), null);
});

test('una clave que nunca se guardo devuelve null, no undefined', () => {
  assert.equal(cacheGet('prueba:inexistente'), null);
});

test('el desalojo respeta el tope y conserva lo mas reciente', () => {
  for (let i = 0; i < MAX_CACHE_ENTRIES + 50; i += 1) {
    cacheSet(`desalojo:${i}`, i, 60_000);
  }
  // Las primeras salen por antiguedad; las ultimas tienen que seguir ahi.
  assert.equal(cacheGet('desalojo:0'), null);
  assert.equal(cacheGet(`desalojo:${MAX_CACHE_ENTRIES + 49}`), MAX_CACHE_ENTRIES + 49);
});

test('guardar un valor falso no se confunde con ausencia', () => {
  cacheSet('prueba:cero', 0, 60_000);
  assert.equal(cacheGet('prueba:cero'), 0);
});
