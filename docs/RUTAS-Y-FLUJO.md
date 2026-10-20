# Rutas y flujo

## Públicas para el funcionamiento

| Ruta | Método | Quién la usa | Protección |
|---|---|---|---|
| `/health` | GET | Monitor/Cron | No devuelve detalles ni secretos |
| `/manychat/buscar` | POST | ManyChat | `X-ManyChat-Secret` |
| `/manychat/producto` | POST | ManyChat | `X-ManyChat-Secret` |

## Privada para desarrollo

| Ruta | Método | Protección | Qué devuelve |
|---|---|---|---|
| `/dev/status` | GET | `Authorization: Bearer ADMIN_STATUS_TOKEN` | Tiempo activo, cuota, bloqueo, caché y último resultado CLAMI |
| `/dev/logs?limit=50` | GET | `Authorization: Bearer ADMIN_STATUS_TOKEN` | Últimos eventos técnicos sanitizados |
| `/dev/logs?date=AAAA-MM-DD&limit=100` | GET | `Authorization: Bearer ADMIN_STATUS_TOKEN` | Historial técnico de un día dentro de los últimos 10 días |

No hay sitio web ni panel visible para clientes. Las URL son alcanzables por Internet porque ManyChat debe llamarlas, pero no funcionan sin la cabecera correcta. No poner secretos como parámetros de URL.

Las rutas `/dev/*` no muestran términos buscados, códigos de barra, cabeceras, tokens, IPs de clientes ni cuerpos JSON. Tras tres intentos fallidos desde la misma conexión de red, bloquean nuevos intentos durante 40 segundos. Ese bloqueo es una defensa adicional; el token sigue siendo el control principal.

Los logs pertenecen exclusivamente a esta aplicación y se conservan durante 10 días. La caché no se conserva diez días: vence en segundos para no entregar precio o stock antiguo.

## ManyChat → buscar

```text
POST https://catalogo.ejemplo.cl/manychat/buscar
Content-Type: application/json
X-ManyChat-Secret: valor-de-MANYCHAT_SECRET
```

```json
{ "q": "{{busqueda}}", "canal": "whatsapp" }
```

Mapear `$.texto` a un campo de texto. Cuando haya varias opciones, mapear los `ref` de `$.opciones` a campos internos de ManyChat; no mostrarlos al cliente.

## ManyChat → producto

```text
POST https://catalogo.ejemplo.cl/manychat/producto
Content-Type: application/json
X-ManyChat-Secret: valor-de-MANYCHAT_SECRET
```

```json
{ "ref": "{{ref_elegido}}" }
```

El servidor vuelve a CLAMI para precio y stock actualizados.

## Lo que impone ManyChat

Verificado en la documentación oficial de Dev Tools:

| Regla | Cómo responde el puente |
|---|---|
| Solo acepta enlaces HTTPS | El subdominio exige HTTPS |
| Métodos POST, GET, PUT, DELETE | Ambas rutas usan `POST` |
| La URL admite hasta 2.000 caracteres | Las rutas son fijas y breves |
| El corte es de 10 s y no se puede cambiar | CLAMI tiene 7 s; el resto queda de margen |
| Solo se puede mapear JSON | Toda respuesta es JSON |
| No se puede mapear el cuerpo si el código no es `200` | Las condiciones de operación devuelven `200` con `ok: false` |
| Un campo de usuario guarda 4.000 caracteres | `texto` se mantiene en una línea por producto, con tope de 10 opciones |

**Al probar desde el panel no se mapean los valores.** La documentación lo dice: el mapeo
«is only successful when you trigger the DevTool as a contact or preview the automation».
Una prueba que devuelve `200` y deja los campos vacíos es el comportamiento esperado, no
una falla del puente: hay que probar como contacto o con la vista previa.

Si el puente responde con un código distinto de `200`, ManyChat entrega el contenido de
*fallback* de la automatización. Conviene configurar uno con un mensaje neutro: es lo que
verá el cliente cuando el secreto o la External Request estén mal configurados.
