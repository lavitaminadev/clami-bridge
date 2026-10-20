'use strict';

// El candado de instancia unica es lo que impide que dos procesos de Passenger
// dupliquen la cuota de CLAMI en silencio. Es tambien el mecanismo mas nuevo y el
// que mas depende del sistema de archivos, asi que se prueba contra uno real.
//
// DATA_DIR se fija antes de cargar el modulo: server.js resuelve esa ruta al
// importarse. `node --test` da un proceso por archivo, de modo que esto no afecta
// a los demas tests.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'candado-'));
process.env.DATA_DIR = DIR;

const test = require('node:test');
const assert = require('node:assert/strict');
const { acquireSingleInstanceLock, releaseSingleInstanceLock } = require('../server');

const ARCHIVO = path.join(DIR, 'single-instance.lock');

test('el primer arranque toma el candado y escribe su pid', async () => {
  await acquireSingleInstanceLock();
  const duenio = JSON.parse(fs.readFileSync(ARCHIVO, 'utf8'));
  assert.equal(duenio.pid, process.pid);
  assert.equal(typeof duenio.startedAt, 'string');
  await releaseSingleInstanceLock();
  assert.equal(fs.existsSync(ARCHIVO), false);
});

test('un candado de un proceso vivo impide arrancar', async () => {
  // El pid de este mismo proceso existe, asi que el candado cuenta como activo.
  fs.writeFileSync(ARCHIVO, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  await assert.rejects(acquireSingleInstanceLock({ timeoutMs: 300 }), (error) => error.status === 503);
  fs.unlinkSync(ARCHIVO);
});

test('un candado huerfano de un pid muerto se recupera solo', async () => {
  // Un pid que no existe: la aplicacion debe quedarse con el candado en vez de
  // negarse a arrancar para siempre.
  const pidMuerto = 2147483646;
  fs.writeFileSync(ARCHIVO, JSON.stringify({ pid: pidMuerto, startedAt: '2020-01-01T00:00:00.000Z' }));
  await acquireSingleInstanceLock();
  assert.equal(JSON.parse(fs.readFileSync(ARCHIVO, 'utf8')).pid, process.pid);
  await releaseSingleInstanceLock();
});

test('un candado ilegible se trata como activo', async () => {
  // Preferir el falso positivo: borrar un candado que no se pudo leer podria dejar
  // dos procesos consumiendo la misma cuota.
  fs.writeFileSync(ARCHIVO, 'esto no es json');
  await assert.rejects(acquireSingleInstanceLock({ timeoutMs: 300 }), (error) => error.status === 503);
  fs.unlinkSync(ARCHIVO);
});

test('liberar sin tener el candado no borra el de otro proceso', async () => {
  fs.writeFileSync(ARCHIVO, JSON.stringify({ pid: 999999, startedAt: '2020-01-01T00:00:00.000Z' }));
  await releaseSingleInstanceLock();
  assert.equal(fs.existsSync(ARCHIVO), true, 'se borro un candado ajeno');
  fs.unlinkSync(ARCHIVO);
});

test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
