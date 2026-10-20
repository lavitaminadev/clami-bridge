'use strict';

// Arranque real por `app.js`, que es la entrada que usa Passenger. Es la pieza
// especifica de CloudLinux —el ajuste de NODE_PATH para el Node Selector— y hasta
// ahora no la ejercitaba ningun test: un fallo ahi no se nota en desarrollo, se
// nota cuando la aplicacion no levanta en el hosting.
//
// Se lanza en un proceso aparte porque app.js arranca el servidor al cargarse.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const test = require('node:test');
const assert = require('node:assert/strict');

const RAIZ = path.join(__dirname, '..');

function esperar(ms) {
  return new Promise((listo) => setTimeout(listo, ms));
}

async function arrancar(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arranque-'));
  const env = {
    ...process.env,
    DATA_DIR: path.join(dir, 'data'),
    LOG_DIR: path.join(dir, 'logs'),
    PORT: String(30000 + Math.floor(Math.random() * 9000)),
    CLAMI_API_KEY: 'clami_cat_credencial_de_prueba_0001',
    MANYCHAT_SECRET: 'secreto-de-prueba-para-manychat',
    ...extra
  };
  const hijo = spawn(process.execPath, [path.join(RAIZ, 'app.js')], { env, cwd: RAIZ, stdio: ['ignore', 'pipe', 'pipe'] });
  let salida = '';
  hijo.stdout.on('data', (d) => { salida += d; });
  hijo.stderr.on('data', (d) => { salida += d; });
  return { dir, env, hijo, salida: () => salida };
}

function registros(dir) {
  const logs = path.join(dir, 'logs');
  if (!fs.existsSync(logs)) return '';
  return fs.readdirSync(logs).map((n) => fs.readFileSync(path.join(logs, n), 'utf8')).join('');
}

async function esperarArranque(dir, hijo) {
  for (let i = 0; i < 60; i += 1) {
    if (registros(dir).includes('server_started')) return true;
    if (hijo.exitCode !== null) return false;
    await esperar(100);
  }
  return false;
}

test('app.js arranca la aplicacion y toma el candado', async () => {
  const { dir, hijo, salida } = await arrancar();
  try {
    assert.ok(await esperarArranque(dir, hijo), `no arranco: ${salida()}`);
    assert.equal(fs.existsSync(path.join(dir, 'data', 'single-instance.lock')), true);
    assert.match(registros(dir), /"commit":/);
  } finally {
    hijo.kill('SIGTERM');
    await esperar(400);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('app.js honra NODE_PATH sin romper la resolucion de modulos', async () => {
  // El Node Selector de CloudLinux expone los modulos por NODE_PATH, y Passenger
  // carga app.js con su propio envoltorio. El ajuste antepone esa ruta; si lo
  // hiciera mal, el arranque fallaria en un `require` distinto cada vez.
  const falso = fs.mkdtempSync(path.join(os.tmpdir(), 'nodepath-'));
  const { dir, hijo, salida } = await arrancar({ NODE_PATH: falso });
  try {
    assert.ok(await esperarArranque(dir, hijo), `no arranco con NODE_PATH: ${salida()}`);
  } finally {
    hijo.kill('SIGTERM');
    await esperar(400);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(falso, { recursive: true, force: true });
  }
});

test('una segunda instancia se niega a arrancar y la primera sigue', async () => {
  const primera = await arrancar();
  try {
    assert.ok(await esperarArranque(primera.dir, primera.hijo), 'no arranco la primera');

    // Espera corta: que se rinda tras agotarla lo comprueba la prueba siguiente.
    const segunda = await arrancar({
      DATA_DIR: primera.env.DATA_DIR, LOG_DIR: primera.env.LOG_DIR,
      CLAMI_BRIDGE_LOCK_TIMEOUT_MS: "500"
    });
    const codigo = await new Promise((listo) => segunda.hijo.on('exit', listo));
    assert.equal(codigo, 1, 'la segunda instancia no fallo');
    assert.match(segunda.salida(), /instancia activa/);
    assert.equal(primera.hijo.exitCode, null, 'la primera murio');
    fs.rmSync(segunda.dir, { recursive: true, force: true });
  } finally {
    primera.hijo.kill('SIGTERM');
    await esperar(400);
    fs.rmSync(primera.dir, { recursive: true, force: true });
  }
});

// En Windows no existe SIGTERM: kill() termina el proceso de golpe y no corre
// ningun manejador. La salida limpia solo se puede comprobar donde la señal existe;
// el caso de la terminacion forzada lo cubre la prueba del latido.
test('al terminar se libera el candado', { skip: process.platform === 'win32' ? 'Windows no entrega SIGTERM al proceso' : false }, async () => {
  const { dir, hijo } = await arrancar();
  try {
    assert.ok(await esperarArranque(dir, hijo));
    const candado = path.join(dir, 'data', 'single-instance.lock');
    assert.equal(fs.existsSync(candado), true);

    hijo.kill('SIGTERM');
    await new Promise((listo) => hijo.on('exit', listo));
    assert.equal(fs.existsSync(candado), false, 'el candado quedo huerfano tras una salida limpia');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sin configuracion la aplicacion arranca igual y lo dice en /health', async () => {
  // Arrancar sin credenciales es util: deja ver /health y los registros para
  // diagnosticar, en vez de un proceso muerto sin explicacion.
  const { dir, env, hijo, salida } = await arrancar({ CLAMI_API_KEY: '', MANYCHAT_SECRET: '' });
  try {
    assert.ok(await esperarArranque(dir, hijo), `no arranco sin configuracion: ${salida()}`);
    const r = await fetch(`http://127.0.0.1:${env.PORT}/health`);
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { ok: false });
  } finally {
    hijo.kill('SIGTERM');
    await esperar(400);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('un candado sin latido reciente se recupera solo', async () => {
  // Es la proteccion que importa cuando el proceso muere de golpe y no alcanza a
  // soltarlo: sin ella, un PID reciclado por otro proceso del hosting haria que la
  // aplicacion no volviera a arrancar nunca sin intervencion manual.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'latido-'));
  const data = path.join(dir, 'data');
  fs.mkdirSync(data, { recursive: true });
  const candado = path.join(data, 'single-instance.lock');

  // Se escribe el PID de este mismo proceso: existe y esta vivo, de modo que solo
  // el latido vencido puede explicar que el candado se considere huerfano.
  fs.writeFileSync(candado, JSON.stringify({ pid: process.pid, startedAt: '2020-01-01T00:00:00.000Z' }));
  const viejo = new Date(Date.now() - 120_000);
  fs.utimesSync(candado, viejo, viejo);

  const { hijo, salida } = await arrancar({ DATA_DIR: data, LOG_DIR: path.join(dir, 'logs') });
  try {
    assert.ok(await esperarArranque(dir, hijo), `no se recupero del candado viejo: ${salida()}`);
    assert.equal(JSON.parse(fs.readFileSync(candado, 'utf8')).pid, hijo.pid);
  } finally {
    hijo.kill();
    await esperar(300);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('una segunda instancia espera antes de rendirse', async () => {
  // Passenger puede levantar el proceso nuevo antes de matar el viejo. Si el nuevo
  // muriera al primer intento, cada reinicio seria un ciclo de fallos.
  const primera = await arrancar();
  try {
    assert.ok(await esperarArranque(primera.dir, primera.hijo));
    const inicio = Date.now();
    const segunda = await arrancar({
      DATA_DIR: primera.env.DATA_DIR, LOG_DIR: primera.env.LOG_DIR,
      CLAMI_BRIDGE_LOCK_TIMEOUT_MS: '3000'
    });
    await new Promise((listo) => segunda.hijo.on('exit', listo));
    assert.ok(Date.now() - inicio >= 2_000, 'se rindio sin esperar al dueño vivo');
    fs.rmSync(segunda.dir, { recursive: true, force: true });
  } finally {
    primera.hijo.kill();
    await esperar(300);
    fs.rmSync(primera.dir, { recursive: true, force: true });
  }
});
