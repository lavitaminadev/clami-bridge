'use strict';

// Retencion de registros, reinicio diario de los contadores y cupo de productos
// distintos. Las tres son promesas que el proyecto hace por escrito y que solo se
// notan cuando fallan: un disco que crece sin parar, un contador que nunca se
// reinicia, o un cupo de CLAMI que se agota sin aviso.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'retencion-'));
process.env.DATA_DIR = path.join(DIR, 'data');
process.env.LOG_DIR = path.join(DIR, 'logs');
process.env.CLAMI_API_KEY = 'clami_cat_credencial_de_prueba_0001';
process.env.MANYCHAT_SECRET = 'secreto-de-prueba-para-manychat';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadState, adminStatus, purgeOldLogs, registerDistinctProduct, assertDistinctProductBudget,
  LOG_RETENTION_DAYS, MAX_DISTINCT_PRODUCTS_PER_DAY
} = require('../server');
const { ERROR_CODES } = require('../src/error-catalog');

const LOGS = process.env.LOG_DIR;
const ESTADO = path.join(process.env.DATA_DIR, 'runtime-state.json');
const DIA = 24 * 60 * 60 * 1000;

function hoyEnSantiago(desplazamientoDias = 0) {
  const fecha = new Date(Date.now() + desplazamientoDias * DIA);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(fecha);
}

function registro(nombre, edadDias) {
  fs.mkdirSync(LOGS, { recursive: true });
  const ruta = path.join(LOGS, nombre);
  fs.writeFileSync(ruta, '{"event":"x"}\n');
  if (edadDias) {
    const cuando = new Date(Date.now() - edadDias * DIA);
    fs.utimesSync(ruta, cuando, cuando);
  }
  return ruta;
}

function escribirEstado(estado) {
  fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
  fs.writeFileSync(ESTADO, JSON.stringify(estado));
}

test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

test('un registro mas viejo que la retencion se borra', async () => {
  const viejo = registro('bridge-2020-01-01.jsonl', LOG_RETENTION_DAYS + 1);
  await purgeOldLogs();
  assert.equal(fs.existsSync(viejo), false);
});

test('un registro dentro de la retencion se conserva', async () => {
  const reciente = registro('bridge-2026-10-20.jsonl', LOG_RETENTION_DAYS - 1);
  await purgeOldLogs();
  assert.equal(fs.existsSync(reciente), true);
});

test('la limpieza no toca archivos ajenos, por viejos que sean', async () => {
  // Solo se borra lo que la aplicacion escribio: el patron del nombre es la frontera.
  const ajenos = [
    registro('runtime-state.json', 900),
    registro('bridge.jsonl', 900),
    registro('bridge-2020-1-1.jsonl', 900),
    registro('notas.txt', 900)
  ];
  await purgeOldLogs();
  for (const ruta of ajenos) assert.equal(fs.existsSync(ruta), true, `se borro ${path.basename(ruta)}`);
});

test('la limpieza no falla si el directorio no existe', async () => {
  fs.rmSync(LOGS, { recursive: true, force: true });
  await purgeOldLogs();
});

test('al arrancar en un dia nuevo los contadores vuelven a cero', async () => {
  // Es lo que ocurre de verdad: el proceso reinicia y lee un estado de ayer.
  escribirEstado({
    date: hoyEnSantiago(-1),
    upstreamCalls: 2500,
    cooldownUntil: Date.now() + 600_000,
    lastClami: { at: '2026-10-19T12:00:00.000Z', status: 200, outcome: 'ok' },
    productRefs: ['a'.repeat(22), 'b'.repeat(22)]
  });
  await loadState();
  const estado = adminStatus();
  assert.equal(estado.quota.upstreamCallsToday, 0);
  assert.equal(estado.quota.distinctProductsToday, 0);
  assert.equal(estado.cooldownSeconds, 0, 'el bloqueo de ayer sigue activo');
  // El ultimo resultado tecnico se conserva: sirve para diagnosticar.
  assert.equal(estado.lastClami.outcome, 'ok');
});

test('al arrancar el mismo dia los contadores se conservan', async () => {
  escribirEstado({
    date: hoyEnSantiago(),
    upstreamCalls: 120,
    cooldownUntil: 0,
    lastClami: null,
    productRefs: ['c'.repeat(22)]
  });
  await loadState();
  const estado = adminStatus();
  assert.equal(estado.quota.upstreamCallsToday, 120);
  assert.equal(estado.quota.distinctProductsToday, 1);
});

test('un estado corrupto no impide arrancar', async () => {
  // No se reinicia a cero: se conserva lo que haya en memoria. En un arranque real
  // eso es el estado inicial del modulo; aqui es lo que dejo la prueba anterior.
  // Lo que se fija es que leer basura no lance y deje la aplicacion utilizable.
  fs.writeFileSync(ESTADO, 'esto no es json');
  await loadState();
  assert.equal(typeof adminStatus().quota.upstreamCallsToday, 'number');
});

test('el mismo producto consultado dos veces cuenta una sola vez', async () => {
  escribirEstado({ date: hoyEnSantiago(), upstreamCalls: 0, cooldownUntil: 0, lastClami: null, productRefs: [] });
  await loadState();
  const ref = 'hG44NhfYg4wCk1KiEbls6w';
  registerDistinctProduct(ref);
  registerDistinctProduct(ref);
  registerDistinctProduct('eZkj8bvhJrI6aCVr6yURDA');
  assert.equal(adminStatus().quota.distinctProductsToday, 2);
});

test('alcanzado el cupo diario de productos se rechaza con su propio codigo', async () => {
  // CLAMI cuenta aparte los productos distintos del dia: agotarlos deja el catalogo
  // devolviendo 429 aunque queden consultas disponibles.
  const llenos = Array.from({ length: MAX_DISTINCT_PRODUCTS_PER_DAY }, (_, i) => String(i).padStart(22, '0'));
  escribirEstado({ date: hoyEnSantiago(), upstreamCalls: 0, cooldownUntil: 0, lastClami: null, productRefs: llenos });
  await loadState();
  assert.equal(adminStatus().quota.distinctProductsToday, MAX_DISTINCT_PRODUCTS_PER_DAY);

  assert.throws(() => assertDistinctProductBudget('zZzZzZzZzZzZzZzZzZzZzZ'), (e) => {
    assert.equal(e.errorCode, ERROR_CODES.CLAMI_DISTINCT_PRODUCT_BUDGET);
    return true;
  });

  // Uno ya contado sigue pasando: el cupo es de productos distintos, no de consultas.
  assertDistinctProductBudget(llenos[0]);
});

test('el cupo propio queda por debajo del limite que publica CLAMI', () => {
  assert.ok(MAX_DISTINCT_PRODUCTS_PER_DAY < 1500, 'el margen contra el limite de CLAMI desaparecio');
});

test('la version desplegada se lee del repositorio', () => {
  const { deployedCommit } = require('../server');
  const leido = deployedCommit();
  // Puede ser null si la aplicacion se subio sin el repositorio; lo que no puede
  // es devolver cualquier cosa.
  if (leido !== null) assert.match(leido, /^[0-9a-f]{40}$/);
});

test('/dev/status informa la version', () => {
  assert.ok(Object.hasOwn(adminStatus(), 'commit'));
});

