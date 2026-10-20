'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSearchBody, validateProductBody, productText, constantTimeMatch, responseStatusFor } = require('../server');
const { requireProduct, requireSearchResults } = require('../src/clami-response');

test('valida búsqueda y detecta código de barras', () => {
  assert.deepEqual(validateSearchBody({ q: '7801234567890', canal: 'whatsapp' }), { q: '7801234567890', channel: 'whatsapp', isBarcode: true });
  assert.throws(() => validateSearchBody({ q: 'aa' }));
});

test('no inventa aviso de receta y formatea producto', () => {
  const text = productText({ nombre: 'Producto', precio_venta: 1990, stock: 0, locales: [], receta_retenida: true });
  assert.match(text, /Sin unidades disponibles/);
  assert.match(text, /Requiere receta retenida/);
});

test('advierte una condición de venta cuando receta_retenida no viene', () => {
  const text = productText({ nombre: 'Producto', precio_venta: 1990, stock: 1, locales: [] });
  assert.match(text, /Consulta las condiciones de venta/);
});

test('rechaza respuestas CLAMI incompletas antes de enviarlas a ManyChat', () => {
  assert.throws(() => requireProduct({ nombre: 'Producto', precio_venta: undefined }));
  assert.throws(() => requireSearchResults({ resultados: [{ ref: 'incompleto' }] }));
  assert.throws(() => requireSearchResults({ resultados: [
    { ref: 'correcto', nombre: 'Producto', precio_venta: 1000, stock: 1, locales: [] },
    { ref: 'incompleto' }
  ] }));
});

test('secreto requiere igualdad exacta', () => {
  assert.equal(constantTimeMatch('secreto', 'secreto'), true);
  assert.equal(constantTimeMatch('secreto', 'otro'), false);
});

test('las rutas ManyChat devuelven 200 cuando la causa es de operacion', () => {
  const { ERROR_CODES, HttpError } = require('../src/error-catalog');
  const timeout = new HttpError(504, 'El catálogo tardó demasiado en responder.', { reason: 'timeout' });
  const notFound = new HttpError(404, 'Producto no encontrado.', { clamiStatus: 404 }, ERROR_CODES.CLAMI_PRODUCT_NOT_FOUND);
  // ManyChat descarta el cuerpo de cualquier respuesta que no sea 200, asi que el
  // aviso redactado para el cliente solo llega con ese codigo.
  assert.equal(responseStatusFor('/manychat/buscar', timeout), 200);
  assert.equal(responseStatusFor('/manychat/producto', notFound), 200);
});

test('un error de configuracion conserva su codigo real', () => {
  const { ERROR_CODES, HttpError } = require('../src/error-catalog');
  const badSecret = new HttpError(401, 'No autorizado.', { reason: 'invalid_manychat_secret' });
  const badType = new HttpError(415, 'Se requiere application/json.', {}, ERROR_CODES.REQUEST_CONTENT_TYPE_INVALID);
  assert.equal(responseStatusFor('/manychat/buscar', badSecret), 401);
  assert.equal(responseStatusFor('/manychat/buscar', badType), 415);
});

test('health y dev conservan siempre su codigo', () => {
  const { HttpError } = require('../src/error-catalog');
  const timeout = new HttpError(504, 'El catálogo tardó demasiado en responder.', { reason: 'timeout' });
  assert.equal(responseStatusFor('/health', timeout), 504);
  assert.equal(responseStatusFor('/dev/status', timeout), 504);
});

test('el ref es de 22 caracteres exactos, como define el OpenAPI de CLAMI', () => {
  assert.equal(validateProductBody({ ref: 'Qm9uZGlhc0NsYW1pMjAyNg' }), 'Qm9uZGlhc0NsYW1pMjAyNg');
  assert.throws(() => validateProductBody({ ref: 'ref_corta-1' }));
  assert.throws(() => validateProductBody({ ref: 'Qm9uZGlhc0NsYW1pMjAyNgX' }));
  assert.throws(() => validateProductBody({ ref: '../etc/passwd' }));
});

test('un producto con ref fuera de especificacion no llega a ManyChat', () => {
  assert.throws(() => requireSearchResults({ resultados: [
    { ref: 'corto', nombre: 'Producto', precio_venta: 1000, stock: 1, locales: [] }
  ] }));
});

test('acepta stock decimal y locales como los define el esquema', () => {
  const text = productText({ nombre: 'Jamón', precio_venta: 8990, stock: 2.5, locales: [{ nombre_local: 'Casa matriz', stock: 2.5 }], receta_retenida: false });
  assert.match(text, /Casa matriz: 2\.5/);
});
