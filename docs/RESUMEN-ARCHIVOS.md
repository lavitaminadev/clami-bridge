# Resumen breve del bridge

Esta es una mini app Node: ManyChat no toca CLAMI directamente. Solo llama al bridge con un secreto; el bridge consulta la API oficial de CLAMI con la credencial guardada en variables de entorno.

## Archivos principales

| Archivo | Para qué existe |
|---|---|
| `app.js` | Entrada que espera Passenger/cPanel y compatibilidad con Node Selector. |
| `server.js` | Rutas HTTP, autenticación, límite de llamadas, caché corta, llamada a CLAMI, logs y bloqueo de una sola instancia. |
| `src/input-validation.js` | Rechaza JSON grande, inválido o campos no esperados antes de consultar CLAMI. |
| `src/clami-response.js` | Valida la respuesta de CLAMI; evita enviar precio inválido, stock inválido o `ref` vacío a ManyChat. |
| `src/product-presentation.js` | Convierte un producto válido en el texto que recibe el cliente. Si receta es desconocida, usa aviso neutro. |
| `src/error-catalog.js` | Nombres internos de cada falla para los logs, sin mostrarlos al cliente. |
| `scripts/generate-admin-token.js` | Genera el token privado del desarrollador; no lo guarda. |
| `scripts/cpanel-healthcheck.sh` | Consulta `/health` desde Cron Jobs para detectar app caída. |
| `scripts/deploy-check.sh` | Detiene un deploy si la app queda en `public_html`, faltan archivos o se agregan dependencias sin preparar Node Selector. |
| `deployment/htaccess-node-root.template` | Solo se copia al Document Root del subdominio si WordPress hereda reglas y Apache da 500 antes de Node. |
| `.env.example` | Ejemplo sin secretos. El `.env` real no se sube a Git ni se expone. |

## Rutas y quién puede verlas

| Ruta | Uso | Qué devuelve |
|---|---|---|
| `GET /health` | Monitor/cPanel | Solo `{ "ok": true }` si la app tiene variables configuradas. No prueba CLAMI para no gastar cuota. |
| `POST /manychat/buscar` | ManyChat | Busca texto o código de barras. Requiere `X-ManyChat-Secret`. Devuelve texto, opciones y `ref`; no guarda ni registra la búsqueda/código. |
| `POST /manychat/producto` | ManyChat | Consulta un `ref` ya obtenido y devuelve precio/stock actual. Requiere el mismo secreto. |
| `GET /dev/status` | Solo desarrollador | Requiere `Authorization: Bearer ADMIN_STATUS_TOKEN`. Muestra cuota técnica, cooldown, caché y último estado de CLAMI; nunca claves ni consultas. |
| `GET /dev/logs` | Solo desarrollador | Requiere el mismo token. Muestra eventos técnicos sanitizados de hasta 10 días. |

No hay panel web, buscador público, listado de productos ni URL con token. Los datos privados van en cabeceras HTTPS.

## Qué protege esta versión

- La clave CLAMI solo vive en cPanel como `CLAMI_API_KEY`; no llega a ManyChat ni al navegador.
- La URL CLAMI está fija en código, por lo que nadie puede convertir el bridge en un proxy hacia otra URL.
- Cuerpos mayores a 8 KB, JSON inválido y campos extra se rechazan.
- La respuesta CLAMI se valida antes de formatearla. Ante una respuesta incompleta falla seguro en vez de mostrar `$ NaN`.
- Un `429` de CLAMI detiene nuevas llamadas temporalmente y devuelve `Retry-After`.
- La caché dura segundos, no conserva conversaciones y se borra al reiniciar.
- `single-instance.lock` impide que dos procesos Passenger consuman la misma cuota en paralelo. Para escalar a varios procesos se debe implementar Redis/estado compartido.
- Logs técnicos JSONL se eliminan automáticamente después de 10 días. No contienen tokens, cabeceras, búsquedas, códigos de barra ni datos de clientes.

## Errores que verá cada parte

ManyChat o el cliente reciben solo mensajes seguros en español:

| Situación | HTTP | Mensaje/resultado visible |
|---|---:|---|
| Secreto ManyChat inválido | `401` | `No autorizado.` |
| Solicitud JSON inválida | `400` / `413` / `415` | Indica el problema sin exponer datos internos. |
| Límite local temporal | `200` | `Demasiadas solicitudes.` con `codigo: LOCAL_RATE_LIMIT`. |
| CLAMI ocupado (`429`) | `200` | Catálogo temporalmente ocupado, `codigo: CLAMI_RATE_LIMITED`. |
| CLAMI credencial/IP no autorizada | `200` | Catálogo no disponible temporalmente, `codigo: CLAMI_CREDENTIAL_OR_ORIGIN`. El motivo real queda solo en el registro privado. |
| Timeout o red CLAMI | `200` | `codigo: CLAMI_TIMEOUT` o `CLAMI_NETWORK_ERROR`. |

**Las rutas de ManyChat devuelven `200` ante un fallo de operación** porque ManyChat
descarta el cuerpo de cualquier otra respuesta y el aviso no llegaría al cliente. El
estado real va en `codigo`. Un error de configuración —secreto, `Content-Type`, ruta—
conserva su código real. El detalle está en `docs/FALLAS-Y-OPERACION.md`.
| CLAMI devuelve datos incompletos | `502` | Catálogo devolvió datos incompletos. |
| Sin coincidencias | `200` | `No encontré productos para esa búsqueda.` |

El desarrollador ve en `/dev/logs` el código técnico, ruta, estado y duración. Después de tres intentos con el mismo token de desarrollador incorrecto, ese valor queda bloqueado 40 segundos; no bloquea al token correcto.

## Qué falta comprobar antes de producción

1. iHosting debe confirmar una sola instancia Passenger y la IP HTTPS de salida.
2. El subdominio debe tener AutoSSL y quedar excluido de NGINX Cache.
3. Probar una solicitud real desde ManyChat contra CLAMI solo cuando la credencial esté asignada a la IP productiva.

