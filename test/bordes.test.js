'use strict';

// Casos borde de la lectura del cuerpo, de la validacion de entrada y de la
// normalizacion de lo que devuelve CLAMI.

const test = require('node:test');
const assert = require('node:assert/strict');
const { readJsonBody, validateSearchBody, validateProductBody } = require('../src/input-validation');
const { requireProduct, requireSearchResults } = require('../src/clami-response');
const { productText, constantTimeMatch } = require('../server');
const { ERROR_CODES } = require('../src/error-catalog');

// `readJsonBody` consume la peticion como iterable asincrono: alcanza con uno.
function cuerpo(...trozos) {
  return (async function* () {
    for (const trozo of trozos) yield Buffer.from(trozo, 'utf8');
  })();
}

test('el cuerpo se corta al superar 8 KB, sin leerlo entero', async () => {
  await assert.rejects(readJsonBody(cuerpo('{"q":"' + 'a'.repeat(9000) + '"}')), (e) => e.status === 413);
});

test('8 KB repartidos en varios trozos tambien se cortan', async () => {
  // El limite se acumula trozo a trozo: enviarlo partido no debe esquivarlo.
  const trozos = Array.from({ length: 10 }, () => 'a'.repeat(1000));
  await assert.rejects(readJsonBody(cuerpo('{"q":"', ...trozos, '"}')), (e) => e.status === 413);
});

test('un cuerpo vacio se distingue de un JSON invalido', async () => {
  await assert.rejects(readJsonBody(cuerpo('')), (e) => e.errorCode === ERROR_CODES.REQUEST_BODY_MISSING);
  await assert.rejects(readJsonBody(cuerpo('{roto')), (e) => e.errorCode === ERROR_CODES.REQUEST_JSON_INVALID);
});

test('un JSON valido que no sea objeto se rechaza', async () => {
  // Un arreglo o un numero son JSON validos pero no son la peticion esperada.
  for (const valor of ['[]', '"texto"', '42', 'null', 'true']) {
    await assert.rejects(readJsonBody(cuerpo(valor)), (e) => e.status === 400, `acepto ${valor}`);
  }
});

test('un objeto vacio llega a la validacion, que es quien decide', async () => {
  assert.deepEqual(await readJsonBody(cuerpo('{}')), {});
  assert.throws(() => validateSearchBody({}));
});

test('sin canal se asume desconocido, no se rechaza', () => {
  assert.equal(validateSearchBody({ q: 'paracetamol' }).channel, 'desconocido');
  assert.equal(validateSearchBody({ q: 'paracetamol', canal: 'WhatsApp' }).channel, 'whatsapp');
});

test('q se recorta antes de medirla', () => {
  assert.equal(validateSearchBody({ q: '  paracetamol  ' }).q, 'paracetamol');
  assert.throws(() => validateSearchBody({ q: '   a   ' }));
  assert.throws(() => validateSearchBody({ q: 'a'.repeat(121) }));
  assert.equal(validateSearchBody({ q: 'a'.repeat(120) }).q.length, 120);
});

test('solo digitos es codigo de barras; mezclado no', () => {
  assert.equal(validateSearchBody({ q: '7801234567890' }).isBarcode, true);
  assert.equal(validateSearchBody({ q: '780abc' }).isBarcode, false);
  assert.equal(validateSearchBody({ q: '780 123' }).isBarcode, false);
});

test('un ref con caracteres fuera del alfabeto se rechaza aunque mida 22', () => {
  assert.throws(() => validateProductBody({ ref: '../../../../../../etc/pas' }));
  assert.throws(() => validateProductBody({ ref: 'a'.repeat(21) + '/' }));
  assert.throws(() => validateProductBody({ ref: 'a'.repeat(21) + '.' }));
  assert.equal(validateProductBody({ ref: 'a'.repeat(22) }), 'a'.repeat(22));
});

test('un precio que no sea entero no nulo se rechaza', () => {
  const base = { ref: 'a'.repeat(22), nombre: 'X', stock: 1, locales: [] };
  for (const precio of [undefined, null, '600', 600.5, -1, NaN, Infinity]) {
    assert.throws(() => requireProduct({ ...base, precio_venta: precio }), `acepto ${precio}`);
  }
  assert.equal(requireProduct({ ...base, precio_venta: 0 }).precio_venta, 0);
});

test('un stock negativo o no numerico se rechaza; null es un servicio', () => {
  const base = { ref: 'a'.repeat(22), nombre: 'X', precio_venta: 100, locales: [] };
  for (const stock of [-1, '3', NaN, Infinity, undefined]) {
    assert.throws(() => requireProduct({ ...base, stock }), `acepto ${stock}`);
  }
  assert.equal(requireProduct({ ...base, stock: null }).stock, null);
});

test('un local sin nombre o con stock nulo invalida el producto', () => {
  const base = { ref: 'a'.repeat(22), nombre: 'X', precio_venta: 100, stock: 1 };
  assert.throws(() => requireProduct({ ...base, locales: [{ stock: 1 }] }));
  assert.throws(() => requireProduct({ ...base, locales: [{ nombre_local: '   ', stock: 1 }] }));
  assert.throws(() => requireProduct({ ...base, locales: [{ nombre_local: 'Casa', stock: null }] }));
  assert.throws(() => requireProduct({ ...base, locales: 'Casa matriz' }));
});

test('un receta_retenida que no sea booleano ni nulo invalida el producto', () => {
  const base = { ref: 'a'.repeat(22), nombre: 'X', precio_venta: 100, stock: 1, locales: [] };
  assert.throws(() => requireProduct({ ...base, receta_retenida: 'si' }));
  assert.throws(() => requireProduct({ ...base, receta_retenida: 1 }));
  assert.equal(requireProduct({ ...base, receta_retenida: null }).receta_retenida, null);
});

test('una busqueda sin resultados es valida, no un error', () => {
  assert.deepEqual(requireSearchResults({ resultados: [] }), []);
});

test('una busqueda con mas de 10 resultados se recorta a 10', () => {
  const uno = (i) => ({ ref: String(i).padStart(22, '0'), nombre: 'X', precio_venta: 1, stock: 1, locales: [] });
  const resultados = Array.from({ length: 25 }, (_, i) => uno(i));
  assert.equal(requireSearchResults({ resultados }).length, 10);
});

test('una respuesta sin el arreglo de resultados se rechaza', () => {
  for (const valor of [{}, { resultados: null }, { resultados: 'x' }, null, 'x', []]) {
    assert.throws(() => requireSearchResults(valor), `acepto ${JSON.stringify(valor)}`);
  }
});

test('el texto distingue sin unidades, servicio y singular', () => {
  const base = { nombre: 'X', precio_venta: 1000, locales: [], receta_retenida: false };
  assert.match(productText({ ...base, stock: 0 }), /Sin unidades disponibles/);
  assert.match(productText({ ...base, stock: null }), /Servicio sin inventario/);
  assert.match(productText({ ...base, stock: 1 }), /1 unidad\./);
  assert.match(productText({ ...base, stock: 2 }), /2 unidades\./);
});

test('varios locales se separan con punto medio', () => {
  const texto = productText({
    nombre: 'X', precio_venta: 1000, stock: 5, receta_retenida: false,
    locales: [{ nombre_local: 'Casa', stock: 3 }, { nombre_local: 'Centro', stock: 2 }]
  });
  assert.match(texto, /Casa: 3 · Centro: 2\./);
});

test('la comparacion del secreto no acepta tipos ni largos distintos', () => {
  assert.equal(constantTimeMatch('igual', 'igual'), true);
  assert.equal(constantTimeMatch('abcde', 'abcdf'), false);
  assert.equal(constantTimeMatch('corto', 'mas-largo'), false);
  assert.equal(constantTimeMatch('', ''), true);
  for (const valor of [undefined, null, 0, {}, []]) {
    assert.equal(constantTimeMatch(valor, 'secreto'), false);
    assert.equal(constantTimeMatch('secreto', valor), false);
  }
});
