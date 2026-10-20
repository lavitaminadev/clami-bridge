# Fallas y operación

## Respuestas esperadas

| Caso | Respuesta del puente | Acción |
|---|---|---|
| CLAMI `429` | `503` genérico al bot y cabecera `Retry-After` | Esperar esos segundos; el puente bloquea llamadas temporalmente |
| CLAMI `401` / `403` | `503` genérico | Revisar credencial e IP de salida con iHosting/CLAMI |
| Timeout / red | `504` o `502` genérico | Revisar logs y disponibilidad CLAMI |
| Secreto ManyChat incorrecto | `401` | Revisar cabecera `X-ManyChat-Secret` |
| JSON/campos inválidos | `400`/`415` | Corregir External Request |
| Sin producto | Texto sin resultados o `404` | Pedir otra búsqueda |

## Logs

Los logs se guardan en:

```text
logs/bridge-AAAA-MM-DD.jsonl
```

Incluyen fecha, ruta, estado, duración, caché y estado CLAMI. No incluyen clave CLAMI, secreto ManyChat, Authorization, consulta, código de barras ni datos del cliente.

La aplicación borra automáticamente logs de más de 10 días al iniciar y cada 24 horas. La caché está solo en memoria y vence sola; no se guarda entre reinicios.

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
