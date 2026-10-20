# Revisión forense del proyecto

## Estado actual

- Código Node sin dependencias externas para reducir instalación y superficie de actualización.
- Entrada Passenger: `app.js`.
- Lógica HTTP: `server.js`.
- Logs técnicos diarios, rotados a 10 días.
- Caché solo en memoria; no guarda consultas ni códigos de barra.
- Estado persistente mínimo: cuota diaria, bloqueo por `Retry-After` y último resultado técnico de CLAMI.
- Cerradura exclusiva de proceso: evita que un segundo worker Passenger duplique cuotas, caché o cooldown de forma silenciosa.
- Estado privado: `GET /dev/status` con token separado.
- Logs privados: `GET /dev/logs?limit=50` con el mismo token, sin contenido de consultas.

## Controles incluidos

| Riesgo | Control |
|---|---|
| Credencial CLAMI expuesta | Solo variable de entorno; no se devuelve ni registra. |
| Uso no autorizado desde Internet | Secreto de ManyChat en cabecera y comparación de tiempo constante. |
| Acceso de desarrollo por bots | Token separado, tres fallos del mismo valor erróneo bloquean 40 segundos; no hay frontend ni datos en errores. |
| Respuesta CLAMI malformada | Validación antes de formato; nunca se envía `$ NaN`, `undefined` ni un `ref` vacío a ManyChat. |
| Campo receta desconocido | Muestra aviso neutro de consultar condiciones de venta; no se trata como `false`. |
| URL arbitraria / SSRF | El host CLAMI queda fijo en el código. |
| Body malicioso o grande | Solo JSON, límite de 8 KB y campos permitidos. |
| Saturación / cuota CLAMI | Timeout, límite local global después de autenticar ManyChat, caché breve y bloqueo al recibir `429` con `Retry-After`. |
| Passenger multiproceso | `single-instance.lock` rechaza un segundo worker antes de atender tráfico. Redis sigue siendo requisito para escalar a varios workers. |
| Precio/stock antiguo | `Cache-Control: no-store`; NGINX Cache debe excluir el subdominio. |
| Logs sensibles | No registra tokens, cabeceras, búsquedas, códigos de barra ni datos cliente. |
| Logs sin control | Retención automática de 10 días. |
| Error Node oculto por Apache | Guía de `.htaccess` solo para raíz del subdominio Node. |
| Passenger/Node Selector | `app.js`, compatibilidad `NODE_PATH` y plantilla de despliegue sin `npm ci`. |
| Deploy en WordPress | Script opcional aborta si la app cae dentro de `public_html`. |

## Pendiente de validar en producción

1. iHosting confirma IP HTTPS de salida de Passenger/Node y que es estable.
2. Setup Node.js App permite Node 24.21.0 y `app.js` como startup file.
3. El Document Root real del subdominio no hereda reglas WordPress; solo si falla se agrega el template `.htaccess` ahí.
4. NGINX Cache excluye `catalogo.ejemplo.cl`.
5. External Request está disponible en el plan ManyChat.
6. Prueba real: ManyChat → puente → CLAMI, usando una credencial asociada solo a la IP productiva.
7. Confirmar que Passenger levanta una sola instancia. Si intenta levantar otra, debe aparecer el mensaje de cerradura en el log Passenger y la primera sigue atendiendo.

## Límites honestos

- El cron de `/health` comprueba disponibilidad, pero no puede reparar una caída completa del hosting.
- Ninguna URL pública es secreta; la seguridad de rutas ManyChat depende de sus cabeceras privadas.
- `ADMIN_STATUS_TOKEN` permite revisar estado, no reemplaza una plataforma centralizada de monitoreo.
- No se ha ejecutado una consulta real a CLAMI para evitar bloquear la credencial con una IP incorrecta.
- La cuota diaria y cooldown se persisten en archivo. La cerradura evita que varios workers corran hoy, pero Redis o un almacén con bloqueo distribuido sigue siendo obligatorio antes de escalar a varios procesos.
