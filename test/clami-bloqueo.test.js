'use strict';

// Un solo caso, en su propio archivo: cualquier 429 deja el bloqueo activo durante
// el resto del proceso, asi que no puede convivir con los demas casos de 429.
// `node --test` da un proceso por archivo.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bloqueo-'));
process.env.DATA_DIR = path.join(DIR, 'data');
process.env.LOG_DIR = path.join(DIR, 'logs');
process.env.CLAMI_API_KEY = 'clami_cat_credencial_de_prueba_0001';
process.env.MANYCHAT_SECRET = 'secreto-de-prueba-para-manychat';

const test = require('node:test');
const assert = require('node:assert/strict');
const { clamiGet } = require('../server');
const { ERROR_CODES } = require('../src/error-catalog');

const fetchReal = globalThis.fetch;
test.after(() => {
  globalThis.fetch = fetchReal;
  fs.rmSync(DIR, { recursive: true, force: true });
});

test('un Retry-After desmedido se acota a una hora', async () => {
  // Sin tope, un valor equivocado del upstream dejaria el catalogo inalcanzable
  // durante dias sin que nadie pudiera revertirlo salvo reiniciando.
  globalThis.fetch = async () => ({
    status: 429,
    ok: false,
    headers: { get: (n) => (n.toLowerCase() === 'retry-after' ? '999999' : null) },
    json: async () => ({ detail: 'Límite alcanzado.' })
  });
  await assert.rejects(clamiGet('/buscar/?q=x'), (e) => {
    assert.equal(e.errorCode, ERROR_CODES.CLAMI_RATE_LIMITED);
    assert.equal(e.details.retryAfter, 3600);
    return true;
  });
});
