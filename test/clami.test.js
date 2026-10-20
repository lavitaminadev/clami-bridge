'use strict';

// Pruebas de la conversacion con CLAMI. `fetch` se sustituye por un doble dentro
// de este proceso: no sale ninguna peticion de la maquina, no se consume cuota y
// no interviene la credencial real. El destino de `clamiGet` sigue clavado en el
// codigo; aqui no se redirige a ningun servidor, se intercepta la llamada.
//
// Lo que un doble no puede decir es si CLAMI cambio su contrato. Para eso esta la
// prueba real contra el servidor, descrita en docs/FALLAS-Y-OPERACION.md.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clami-'));
process.env.DATA_DIR = path.join(DIR, 'data');
process.env.LOG_DIR = path.join(DIR, 'logs');
process.env.CLAMI_API_KEY = 'clami_cat_credencial_de_prueba_0001';
process.env.MANYCHAT_SECRET = 'secreto-de-prueba-para-manychat';

const test = require('node:test');
const assert = require('node:assert/strict');
const { clamiGet } = require('../server');
const { ERROR_CODES } = require('../src/error-catalog');

const fetchReal = globalThis.fetch;
let llamadas = [];

function responder({ status = 200, body = {}, headers = {} } = {}) {
  llamadas = [];
  globalThis.fetch = async (url, opciones) => {
    llamadas.push({ url: String(url), opciones });
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: { get: (n) => headers[n.toLowerCase()] ?? null },
      json: async () => body
    };
  };
}

function fallar(error) {
  llamadas = [];
  globalThis.fetch = async (url, opciones) => {
    llamadas.push({ url: String(url), opciones });
    throw error;
  };
}

test.after(() => {
  globalThis.fetch = fetchReal;
  fs.rmSync(DIR, { recursive: true, force: true });
});

test('la credencial viaja en Authorization y el destino es el de CLAMI', async () => {
  responder({ body: { resultados: [] } });
  await clamiGet('/buscar/?q=paracetamol');
  const [{ url, opciones }] = llamadas;
  assert.equal(url, 'https://www.clami.cl/api/catalogo/buscar/?q=paracetamol');
  assert.equal(opciones.headers.Authorization, 'Bearer clami_cat_credencial_de_prueba_0001');
  assert.equal(opciones.headers.Accept, 'application/json');
  assert.equal(opciones.method, 'GET');
});

test('una redireccion del upstream no se sigue', () => {
  // Seguirla llevaria la cabecera Authorization a otro servidor.
  assert.equal(llamadas[0].opciones.redirect, 'error');
});

test('la peticion se aborta sola: lleva una senal', () => {
  assert.ok(llamadas[0].opciones.signal, 'falta la senal de aborto');
});

test('un 404 del catalogo es producto no encontrado, no ruta inexistente', async () => {
  responder({ status: 404, body: { detail: 'Producto no encontrado.' } });
  await assert.rejects(clamiGet('/producto/aaaaaaaaaaaaaaaaaaaaaa/'), (e) => {
    assert.equal(e.status, 404);
    assert.equal(e.errorCode, ERROR_CODES.CLAMI_PRODUCT_NOT_FOUND);
    return true;
  });
});

test('un 401 y un 403 dan el mismo codigo de credencial u origen', async () => {
  for (const status of [401, 403]) {
    responder({ status, body: { detail: 'Credencial inválida o revocada.' } });
    await assert.rejects(clamiGet('/buscar/?q=x'), (e) => {
      assert.equal(e.errorCode, ERROR_CODES.CLAMI_CREDENTIAL_OR_ORIGIN);
      // El cliente final no se entera de que el problema es la credencial.
      assert.match(e.message, /no está disponible temporalmente/);
      return true;
    });
  }
});

test('ningun error menciona la credencial', async () => {
  const clave = process.env.CLAMI_API_KEY;
  for (const caso of [
    { status: 401, body: { detail: `clave ${clave} revocada` } },
    { status: 500, body: { detail: 'error interno' } }
  ]) {
    responder(caso);
    await assert.rejects(clamiGet('/buscar/?q=x'), (e) => {
      assert.equal(e.message.includes(clave), false, 'el mensaje filtra la credencial');
      assert.equal(JSON.stringify(e.details).includes(clave), false, 'los detalles filtran la credencial');
      return true;
    });
  }
});

test('un 500 del catalogo es un fallo de upstream', async () => {
  responder({ status: 500, body: {} });
  await assert.rejects(clamiGet('/buscar/?q=x'), (e) => {
    assert.equal(e.status, 502);
    assert.equal(e.errorCode, ERROR_CODES.CLAMI_UPSTREAM_ERROR);
    return true;
  });
});

test('un corte de red se distingue de un timeout', async () => {
  fallar(Object.assign(new Error('socket colgado'), { name: 'TypeError' }));
  await assert.rejects(clamiGet('/buscar/?q=x'), (e) => {
    assert.equal(e.errorCode, ERROR_CODES.CLAMI_NETWORK_ERROR);
    return true;
  });

  fallar(Object.assign(new Error('abortado'), { name: 'AbortError' }));
  await assert.rejects(clamiGet('/buscar/?q=x'), (e) => {
    assert.equal(e.status, 504);
    assert.equal(e.errorCode, ERROR_CODES.CLAMI_TIMEOUT);
    return true;
  });
});

test('un Retry-After ilegible usa el valor por defecto de 60 segundos', async () => {
  responder({ status: 429, body: {}, headers: { 'retry-after': 'manana' } });
  await assert.rejects(clamiGet('/buscar/?q=x'), (e) => {
    assert.equal(e.errorCode, ERROR_CODES.CLAMI_RATE_LIMITED);
    assert.equal(e.details.retryAfter, 60);
    return true;
  });
});

test('mientras dura el bloqueo no se vuelve a llamar al catalogo', async () => {
  // El 429 anterior dejo el bloqueo activo. La especificacion pide esperar el
  // Retry-After y no reintentar en bucle: la llamada ni siquiera sale.
  responder({ body: { resultados: [] } });
  await assert.rejects(clamiGet('/buscar/?q=x'), (e) => {
    assert.equal(e.errorCode, ERROR_CODES.CLAMI_COOLDOWN);
    assert.ok(e.details.retryAfter > 0 && e.details.retryAfter <= 60);
    return true;
  });
  assert.equal(llamadas.length, 0, 'se llamo a CLAMI estando en bloqueo');
});
