# Fallas y operación

## Respuestas esperadas

ManyChat solo lee el cuerpo de una respuesta `200`: «It's not possible to map an error
message if the returned code is not 200 OK» (Dev Tools: Basics). Con cualquier otro
código descarta el cuerpo y entrega el contenido de *fallback* configurado en la
automatización.

Por eso las rutas `/manychat/*` separan dos situaciones:

- **Operación** — el catálogo no respondió, se agotó un cupo o el producto no existe.
  Devuelven `200` con `ok: false`, el aviso en `texto` y el código interno en `codigo`.
  El cliente lee el aviso redactado aquí.
- **Configuración** — secreto equivocado, método o `Content-Type` incorrecto, ruta
  inexistente. Conservan su código real: el *fallback* es la respuesta correcta para el
  cliente y el código es lo que permite encontrar la falla.

`/health` y `/dev/*` no pasan por ManyChat y conservan siempre su código real.

| Caso | Respuesta del puente | Acción |
|---|---|---|
| CLAMI `429` | `200` · `CLAMI_RATE_LIMITED` | El puente bloquea llamadas durante el `Retry-After` recibido |
| CLAMI `401` / `403` | `200` · `CLAMI_CREDENTIAL_OR_ORIGIN` | Revisar credencial e IP de salida con iHosting/CLAMI |
| Timeout / red | `200` · `CLAMI_TIMEOUT` / `CLAMI_NETWORK_ERROR` | Revisar logs y disponibilidad CLAMI |
| Respuesta CLAMI incompleta | `200` · `CLAMI_RESPONSE_INVALID` | El contrato del catálogo cambió; revisar antes de reintentar |
| Cupo local agotado | `200` · `CLAMI_MINUTE_BUDGET` / `CLAMI_DAILY_BUDGET` | Esperar; revisar `/dev/status` |
| Productos distintos del día agotados | `200` · `CLAMI_DISTINCT_PRODUCT_BUDGET` | Tope de CLAMI, 1.500 al día; `/dev/status` muestra el consumo |
| Sin producto | `200` · texto sin resultados o `CLAMI_PRODUCT_NOT_FOUND` | Pedir otra búsqueda |
| Secreto ManyChat incorrecto | `401` | Revisar cabecera `X-ManyChat-Secret` |
| JSON / campos inválidos | `400` / `415` | Corregir la External Request |
| Servicio sin configurar | `503` | Faltan variables de entorno; revisar y reiniciar |

Un `200` con `ok: false` **no significa que todo salió bien**: el estado real está en
`codigo` y en los logs, donde el evento sigue siendo `request_error`.

## Presupuesto de tiempo

ManyChat corta la External Request a los 10 segundos y el valor no es configurable
(«Timeout is limited to 10 seconds. It cannot be changed»). El puente reparte ese techo:
7 segundos para que CLAMI responda y ~3 para TLS, Passenger y el armado de la respuesta.
No subir `CLAMI_TIMEOUT_MS` a 10: una consulta lenta terminaría después del corte y el
cliente vería el *fallback* en vez del aviso propio.

## Logs

Los logs se guardan en:

```text
logs/bridge-AAAA-MM-DD.jsonl
```

Incluyen fecha, ruta, estado, duración, caché y estado CLAMI. No incluyen clave CLAMI, secreto ManyChat, Authorization, consulta, código de barras ni datos del cliente.

La aplicación borra automáticamente logs de más de 10 días al iniciar y cada 24 horas. La caché está solo en memoria y vence sola; no se guarda entre reinicios.

## Que version esta corriendo

`GET /dev/status` informa el commit desplegado en el campo `commit`:

```json
{ "ok": true, "commit": "a37f3800861f7f742729efba9cf1515531945e40", ... }
```

Se lee del repositorio al cargar el modulo, asi que corresponde al codigo **que
esta en memoria**, no al que hay en disco. Si despues de un `Update from Remote`
el valor no cambia, la aplicacion todavia no se reinicio.

Vale `null` cuando la aplicacion se instalo sin el repositorio, por ejemplo
subiendo un ZIP.

No sale en `/health`, que es publico.

## Estado privado

Consultar con un cliente que permita cabeceras:

```bash
curl --fail --silent --show-error https://catalogo.ejemplo.cl/dev/status \
  -H "Authorization: Bearer TU_ADMIN_STATUS_TOKEN"
```

No pegar este comando con el token real en tickets, chats, Git ni capturas.

## Logs privados para desarrollo

```bash
curl --fail --silent --show-error "https://catalogo.ejemplo.cl/dev/logs?limit=50" \
  -H "Authorization: Bearer TU_ADMIN_STATUS_TOKEN"
```

Para ver un día anterior que no se revisó:

```bash
curl --fail --silent --show-error "https://catalogo.ejemplo.cl/dev/logs?date=2026-10-20&limit=100" \
  -H "Authorization: Bearer TU_ADMIN_STATUS_TOKEN"
```

Solo se devuelven eventos técnicos sanitizados: fecha, ruta, estado HTTP, duración, caché y estado CLAMI. No existen rutas que devuelvan búsquedas, códigos de barra, tokens, cabeceras, cuerpos o datos de clientes. El historial queda disponible por 10 días y luego se elimina automáticamente; no afecta WordPress ni otros directorios del hosting.

Si un bot intenta entrar a `/dev/status` o `/dev/logs` con un token incorrecto, recibe solo `No autorizado.`. Después de tres fallos del mismo valor inválido queda bloqueado por 40 segundos. No se usa la IP de Passenger porque suele ser un proxy interno: un bot con un token erróneo no puede bloquear al desarrollador que usa el token correcto. El bloqueo queda solo en memoria y se reinicia si Passenger reinicia la app; no se persisten IP ni intentos.

## Generar token de desarrollador

En una máquina local con Node 24, dentro del proyecto:

```bash
npm run generate:admin-token
```

El comando muestra un valor aleatorio de 32 bytes y no lo guarda en archivos. Copiarlo una sola vez a la variable `ADMIN_STATUS_TOKEN` de cPanel. No usar la credencial CLAMI ni el secreto ManyChat como token de desarrollador.

## Diagnóstico inicial

1. `/health` devuelve `false`: revisar variables y reiniciar la app.
2. `401` en ManyChat: comparar el secreto configurado en ManyChat con `MANYCHAT_SECRET`.
3. `503` después de configurar todo: revisar `/dev/status` y los logs; si indica `credential_or_origin`, confirmar la IP de salida de Passenger.
4. Precio/stock antiguo: confirmar exclusión de NGINX Cache para el subdominio.
5. Error 403 de Apache: confirmar que la entrada es `app.js`, según la guía cPanel.
6. Error 500 sin línea en logs Node: revisar el `.htaccess` del Document Root del subdominio. Si hereda reglas de WordPress, usar el template `deployment/htaccess-node-root.template` como `.htaccess` solo en esa raíz y volver a probar `/health`.
7. Módulo no encontrado después de un deploy Git: no ejecutar `npm ci`; revisar Node Selector, `NODE_PATH` y usar el pipeline `scripts/deploy-check.sh`.
8. La app no inicia y aparece `Ya existe una instancia activa`: comprobar si Passenger intentó levantar más de un proceso. Confirmar con iHosting una instancia para el subdominio; no borrar `data/single-instance.lock` sin confirmar que el PID escrito allí ya no existe.
9. Cuota CLAMI aparentemente inconsistente: confirmar que Passenger ejecuta una sola instancia. Si iHosting obliga varios procesos, no desplegar hasta añadir Redis/estado compartido.

## Consultar el servicio

Las rutas privadas piden una cabecera, y un navegador no la manda al escribir una URL:
abrir `/dev/status` en el navegador devuelve `401` siempre, y tres intentos seguidos
activan el bloqueo de 40 segundos. Hay que usar un cliente que permita cabeceras.

En PowerShell, `curl` es un alias de `Invoke-WebRequest` y se comporta distinto: hay que
escribir **`curl.exe`**.

```powershell
$seguro = Read-Host "token" -AsSecureString
$p = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($seguro)
$T = [Runtime.InteropServices.Marshal]::PtrToStringAuto($p)
curl.exe -s https://catalogo.ejemplo.cl/dev/status -H "Authorization: Bearer $T"
```

Pedir el token con `-AsSecureString` evita que quede en pantalla y en el historial.

| Quiero saber | Consulta |
|---|---|
| Si está vivo | `curl.exe -s $BASE/health` |
| Qué versión corre | `/dev/status` → campo `commit` |
| Cuánta cuota queda | `/dev/status` → `quota` |
| Si CLAMI nos frenó | `/dev/status` → `cooldownSeconds` mayor que cero |
| Qué pasó hoy | `/dev/logs?limit=100` |
| Qué pasó un día concreto | `/dev/logs?date=2026-10-20&limit=100` |

## Leer `/dev/status`

| Campo | Normal | Revisar si |
|---|---|---|
| `commit` | el último desplegado | no cambia tras un `Update from Remote`: la aplicación no se reinició |
| `uptimeSeconds` | cualquiera | siempre bajo: Passenger la está durmiendo o se reinicia sola |
| `quota.upstreamCallsToday` | holgado | pasa del 80 % del máximo |
| `quota.distinctProductsToday` | holgado | pasa del 80 %: se agota antes que las consultas |
| `cooldownSeconds` | `0` | mayor que cero: CLAMI nos frenó y el bot está dando avisos |
| `cacheEntries` | sube y baja | siempre `0` con tráfico: la caché no está sirviendo |
| `lastClami.outcome` | `ok`, `not_found` | ver la tabla siguiente |

`lastClami.outcome`:

| Valor | Qué significa |
|---|---|
| `ok` | El catálogo respondió bien |
| `not_found` | Se pidió un producto que no existe; normal |
| `credential_or_origin` | **La credencial es inválida o la IP de salida no es la registrada** |
| `rate_limited` | CLAMI nos limitó |
| `timeout` | El catálogo tardó más de 7 segundos |
| `network` | No se pudo alcanzar el catálogo |
| `upstream_error` | El catálogo devolvió un error propio |

## Leer `/dev/logs`

Cada evento trae `ts`, `event`, `requestId`, `route`, `method`, `status`, `durationMs`,
`source` y, según el caso, `cacheHit`, `queryType`, `errorCode`, `reason`, `clamiStatus`.

| Evento | Qué es | Revisar si |
|---|---|---|
| `server_started` | La aplicación arrancó; trae el `commit` | se repite seguido: la aplicación se reinicia sola |
| `health` | Alguien consultó `/health` | no aparece cada 5 minutos: el cron no está corriendo |
| `request_ok` | Una consulta atendida | `durationMs` cerca de 7.000: el catálogo está lento |
| `request_error` | Una consulta rechazada o fallida | `errorCode` que empiece con `CLAMI_` |
| `admin_auth_failed` | Alguien falló el token de `/dev` | viene de más de una `source` |
| `log_retention_completed` | Se limpiaron registros viejos | — |

Cruzar dos eventos de la misma petición se hace por `requestId`: un rechazo
administrativo deja un `admin_auth_failed` y un `request_error` con el mismo valor.

### La marca de origen

Los registros **no guardan direcciones**. Para poder distinguir una fuente repitiendo de
muchas distintas, cada evento lleva `source`: ocho caracteres derivados de la dirección
con una sal aleatoria que nace con el proceso y **nunca se persiste**.

- Dentro de una misma vida del proceso, dos peticiones de la misma fuente comparten marca.
- Tras un reinicio las marcas cambian y no se pueden correlacionar con las anteriores.
- No hay forma de recuperar la dirección desde la marca.

Sirve para responder preguntas como:

- *¿Las 52 visitas a la raíz son mías o hay rastreo automático?* → cuántas `source`
  distintas aparecen con `route` igual a `/`.
- *¿Los intentos fallidos contra `/dev` son míos desde el navegador?* → si todos comparten
  una sola marca, sí. Si son varias, alguien más está probando.
- *¿Una búsqueda lenta fue el catálogo o el cliente?* → `durationMs` del `request_ok`.

Detrás de Passenger se usa el primer salto de `X-Forwarded-For`, no la dirección del
socket, que siempre es la del proxy interno.

### Lo que los registros no pueden decir

- **Quién.** No hay direcciones, ni cabeceras, ni identificadores de contacto de ManyChat.
- **Qué se buscó.** Ni términos ni códigos de barra, por diseño.
- **Qué pasó hace más de diez días.** La retención los borra.
- **Qué pasó antes del último reinicio, por fuente.** Las marcas cambian con la sal.
