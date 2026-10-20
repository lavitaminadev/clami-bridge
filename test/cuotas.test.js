'use strict';

// Los topes propios contra la cuota de CLAMI. Son el control que evita que nos
// corten la credencial: si fallan, el sintoma es un 429 real y un bot mudo.
// En su propio archivo porque agotar un tope deja el estado inservible para los
// demas casos.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cuotas-'));
process.env.DATA_DIR = path.join(DIR, 'data');
process.env.LOG_DIR = path.join(DIR, 'logs');
process.env.CLAMI_API_KEY = 'clami_cat_credencial_de_prueba_0001';
process.env.MANYCHAT_SECRET = 'secreto-de-prueba-para-manychat';

const test = require('node:test');
const assert = require('node:assert/strict');
const { clamiGet, loadState, adminStatus, persistState } = require('../server');
const { ERROR_CODES } = require('../src/error-catalog');

const ESTADO = path.join(process.env.DATA_DIR, 'runtime-state.json');
const fetchReal = globalThis.fetch;

function hoy() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date());
}

function estado(parcial) {
  fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
  fs.writeFileSync(ESTADO, JSON.stringify({
    date: hoy(), upstreamCalls: 0, cooldownUntil: 0, lastClami: null,
    productRefs: [], minuteCounters: [], ...parcial
  }));
}

globalThis.fetch = async () => ({
  status: 200, ok: true, headers: { get: () => null }, json: async () => ({ resultados: [] })
});

test.after(() => {
  globalThis.fetch = fetchReal;
  fs.rmSync(DIR, { recursive: true, force: true });
});

test('alcanzado el tope diario no se llama al catalogo', async () => {
  const { quota } = adminStatus();
  estado({ upstreamCalls: quota.maxPerDay });
  await loadState();

  let salio = false;
  globalThis.fetch = async () => { salio = true; throw new Error('no deberia'); };
  await assert.rejects(clamiGet('/buscar/?q=x'), (e) => {
    assert.equal(e.errorCode, ERROR_CODES.CLAMI_DAILY_BUDGET);
    return true;
  });
  assert.equal(salio, false, 'se consulto CLAMI con el tope diario agotado');
});

test('alcanzado el tope del minuto no se llama al catalogo', async () => {
  const minuto = Math.floor(Date.now() / 60_000);
  // 55 es el tope propio, por debajo de las 60 que publica CLAMI.
  estado({ minuteCounters: [[minuto, 55]] });
  await loadState();

  let salio = false;
  globalThis.fetch = async () => { salio = true; throw new Error('no deberia'); };
  await assert.rejects(clamiGet('/buscar/?q=x'), (e) => {
    assert.equal(e.errorCode, ERROR_CODES.CLAMI_MINUTE_BUDGET);
    return true;
  });
  assert.equal(salio, false, 'se consulto CLAMI con el tope del minuto agotado');
});

test('el contador del minuto sobrevive a un reinicio', async () => {
  // Passenger levanta la aplicacion varias veces al dia. Con el contador solo en
  // memoria, cada arranque devolvia el tope de 55 a cero y dejaba de aplicarse.
  estado({ minuteCounters: [[Math.floor(Date.now() / 60_000), 54]] });
  await loadState();

  globalThis.fetch = async () => ({ status: 200, ok: true, headers: { get: () => null }, json: async () => ({ resultados: [] }) });
  await clamiGet('/buscar/?q=x');

  // Las escrituras se encolan: hay que esperar a que la cola drene antes de leer.
  await persistState();
  const guardado = JSON.parse(fs.readFileSync(ESTADO, 'utf8'));
  assert.ok(Array.isArray(guardado.minuteCounters), 'el contador del minuto no se persistio');

  // Se suma en vez de buscar un minuto concreto: si la llamada cae justo en el
  // cambio de minuto, el incremento aparece en la entrada siguiente y una
  // asercion sobre un minuto fijo fallaria sin que nada este mal.
  const total = guardado.minuteCounters.reduce((suma, [, cuenta]) => suma + cuenta, 0);
  assert.equal(total, 55);
});

test('un contador de un minuto viejo no bloquea el minuto actual', async () => {
  const viejo = Math.floor(Date.now() / 60_000) - 10;
  estado({ minuteCounters: [[viejo, 999]] });
  await loadState();

  globalThis.fetch = async () => ({ status: 200, ok: true, headers: { get: () => null }, json: async () => ({ resultados: [] }) });
  await clamiGet('/buscar/?q=x');
});

test('los topes propios quedan por debajo de los que publica CLAMI', () => {
  const { quota } = adminStatus();
  assert.ok(quota.maxPerDay < 3000, 'el margen contra las 3.000 diarias desaparecio');
  assert.ok(quota.maxDistinctProductsPerDay < 1500, 'el margen contra los 1.500 productos desaparecio');
});
