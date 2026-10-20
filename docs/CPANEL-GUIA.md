# Guía cPanel — rutas y campos

Esta guía usa marcadores: `usuario-cpanel` representa el usuario real de la cuenta cPanel y
`catalogo.ejemplo.cl` el subdominio real. Reemplazar ambos antes de ejecutar cualquier comando.
No cambia WordPress.

## Rutas del servidor

```text
WordPress:        /home/usuario-cpanel/public_html
Aplicación Node:  /home/usuario-cpanel/repositories/clami-bridge
Logs de la app:   /home/usuario-cpanel/repositories/clami-bridge/logs
Estado técnico:   /home/usuario-cpanel/repositories/clami-bridge/data
```

No poner la aplicación, `data` ni `logs` dentro de `public_html`.

## Paso 1 — Subdominio y HTTPS

En **cPanel → Domains**, crear:

```text
catalogo.ejemplo.cl
```

Luego abrir **SSL/TLS Status**, incluir el subdominio en AutoSSL y usar **Run AutoSSL**. Confirmar que el certificado figura como activo antes de configurar ManyChat; ManyChat solo acepta HTTPS.

## Paso 2 — Subir proyecto

Subir el ZIP del contenido de `clami-manychat-bridge` al directorio home y extraerlo hasta que exista:

```text
/home/usuario-cpanel/repositories/clami-bridge/app.js
```

No subir `.env`, `logs`, `data`, `test-logs`, `test-data` ni credenciales.

El archivo `deployment/htaccess-node-root.template` no va en la raíz de la aplicación. Solo se usa si el Document Root del subdominio tiene herencia de reglas WordPress y Apache devuelve 500 antes de llegar a Node. En ese caso, copiarlo como `.htaccess` en el **Document Root del subdominio**, no en `public_html`.

## Paso 3 — Setup Node.js App

Abrir **cPanel → Software → Setup Node.js App → Create Application**.

Usar estos valores cuando aparezcan los campos:

| Campo | Valor |
|---|---|
| Node.js version | `24.21.0` |
| Application mode | `Production` |
| Application root | `clami-manychat-bridge` |
| Application URL | `catalogo.ejemplo.cl` y ruta vacía `/` |
| Application startup file | `app.js` |

No fijar `PORT`: Passenger entrega `process.env.PORT` a la app.

Solicitar a iHosting una sola instancia Passenger para este subdominio. Esta mini app acepta muchas consultas asíncronas en ese proceso; no se debe escalar a varios procesos sin Redis o un estado compartido para la cuota global de CLAMI. Además, el código crea `data/single-instance.lock`: una segunda instancia se niega a iniciar antes de hacer consultas. Es una barrera de seguridad, no reemplaza la confirmación de iHosting.

Si el panel no permite elegir `app.js`, no cambiar el código a ciegas. Abrir un ticket a iHosting indicando que Passenger debe iniciar `/home/usuario-cpanel/repositories/clami-bridge/app.js`.

## Paso 4 — Variables de entorno

En la misma aplicación, agregar estas variables desde **Environment Variables**:

```text
CLAMI_API_KEY=clami_cat_...
MANYCHAT_SECRET=secreto-aleatorio-largo-para-manychat
ADMIN_STATUS_TOKEN=otro-secreto-aleatorio-largo-solo-para-desarrollador
NODE_ENV=production
```

No copiar las claves al código, README, Git, URL ni campos visibles del bot. `ADMIN_STATUS_TOKEN` no es obligatorio para el bot, pero activa la consulta privada de estado.

Para generar el token antes de subir, ejecutar localmente `npm run generate:admin-token`. El resultado se copia en `ADMIN_STATUS_TOKEN` y no se guarda en el proyecto.

## Paso 5 — Crear/reiniciar

Crear la aplicación y usar **Restart** después de modificar código o variables. En instalaciones Passenger donde el botón no reinicia, crear o actualizar:

```text
/home/usuario-cpanel/repositories/clami-bridge/tmp/restart.txt
```

Esto es una alternativa documentada por cPanel; no es necesario si el botón Restart funciona.

## Paso 6 — Comprobaciones

Abrir en navegador:

```text
https://catalogo.ejemplo.cl/health
```

Respuesta esperada:

```json
{"ok":true}
```

La ruta de estado para el desarrollador es:

```text
GET https://catalogo.ejemplo.cl/dev/status
Authorization: Bearer ADMIN_STATUS_TOKEN
```

No abrir el token en la URL. Usar curl o Postman con la cabecera Authorization.

Para ver eventos técnicos sanitizados:

```text
GET https://catalogo.ejemplo.cl/dev/logs?limit=50
Authorization: Bearer ADMIN_STATUS_TOKEN
```

## Paso 7 — Cron de salud

En **cPanel → Cron Jobs**, ejecutar cada cinco minutos:

```bash
/bin/bash /home/usuario-cpanel/repositories/clami-bridge/scripts/cpanel-healthcheck.sh https://catalogo.ejemplo.cl/health >/dev/null 2>&1
```

El cron verifica disponibilidad y puede despertar Passenger después de inactividad. No reemplaza alertas externas ni garantiza que iHosting se recupere ante una caída total.

## Git Deployment opcional

`.cpanel.yml` ya viene versionado y listo: el botón **Deploy** de cPanel aparece en cuanto el repositorio está clonado y el árbol de trabajo limpio. **No hace falta copiar `.cpanel.yml.example` encima**; ese archivo es una copia de referencia y tiene una tarea menos, así que reemplazar el real con él dejaría el despliegue sin instalar la tarea de salud. Lo único que hay que ajustar en `.cpanel.yml` es la URL de `/health` del segundo paso. El pipeline hace guardas de ruta y artefactos, no ejecuta npm porque hoy no hay dependencias, verifica cantidad de archivos y solicita reinicio Passenger. Si se agregan dependencias, aborta hasta que el desarrollador configure y compruebe el `NODE_BIN_DIR` real del Node Selector. Nunca cambiarlo a `npm ci`.

No instala cron automáticamente: primero debe pasar la prueba real `/health`. Configurar el cron desde cPanel después de esa verificación evita que una configuración incompleta genere ruido o correos innecesarios.
