# Rutas y flujo

## Públicas para el funcionamiento

| Ruta | Método | Quién la usa | Protección |
|---|---|---|---|
| `/health` | GET | Monitor/Cron | No devuelve detalles ni secretos |
| `/manychat/buscar` | POST | ManyChat | `X-ManyChat-Secret` |
| `/manychat/producto` | POST | ManyChat | `X-ManyChat-Secret` |
| `/manychat/buscar-detalle` | POST | ManyChat avanzado | `X-ManyChat-Secret` |
| `/manychat/producto-detalle` | POST | ManyChat avanzado | `X-ManyChat-Secret` |

## Privada para desarrollo

| Ruta | Método | Protección | Qué devuelve |
|---|---|---|---|
| `/dev/status` | GET | `Authorization: Bearer ADMIN_STATUS_TOKEN` | Tiempo activo, cuota, bloqueo, caché y último resultado CLAMI |
| `/dev/logs?limit=50` | GET | `Authorization: Bearer ADMIN_STATUS_TOKEN` | Últimos eventos técnicos sanitizados |
| `/dev/logs?date=AAAA-MM-DD&limit=100` | GET | `Authorization: Bearer ADMIN_STATUS_TOKEN` | Historial técnico de un día dentro de los últimos 10 días |

No hay sitio web ni panel visible para clientes. Las URL son alcanzables por Internet porque ManyChat debe llamarlas, pero no funcionan sin la cabecera correcta. No poner secretos como parámetros de URL.

Las rutas `/dev/*` no muestran términos buscados, códigos de barra, cabeceras, tokens, IPs de clientes ni cuerpos JSON. Tras tres intentos fallidos del mismo valor incorrecto, ese valor queda bloqueado 40 segundos. No se agrupa por dirección, que detrás de Passenger es siempre la del proxy interno: así un bot probando valores no deja fuera al token real. Un atacante que cambie el token en cada intento nunca acumula tres fallos. Ese bloqueo es una defensa adicional; el token sigue siendo el control principal.

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

## ManyChat → detalle opcional

Las rutas de detalle no cambian las rutas anteriores. Se reservan para una
automatización que necesite decidir su propio formato o menú, pero no devuelven
la respuesta HTTP cruda de CLAMI: entregan únicamente los campos oficiales que
el puente ya validó.

```text
POST https://catalogo.ejemplo.cl/manychat/buscar-detalle
Content-Type: application/json
X-ManyChat-Secret: valor-de-MANYCHAT_SECRET
```

```json
{ "q": "{{busqueda}}", "canal": "whatsapp" }
```

La respuesta contiene `ok`, `consulta`, `resultados` y `canal`. Cada elemento
de `resultados` trae `ref`, `nombre`, `tipo`, `marca`, `stock`, `locales`,
`precio_venta` y `receta_retenida`.

```text
POST https://catalogo.ejemplo.cl/manychat/producto-detalle
Content-Type: application/json
X-ManyChat-Secret: valor-de-MANYCHAT_SECRET
```

```json
{ "ref": "{{ref_elegido}}" }
```

La respuesta contiene `ok` y `producto` con los mismos campos normalizados.
El automatizador debe mostrar precio y disponibilidad, y avisar receta retenida
cuando `receta_retenida` sea `true`.

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

## Lo que recibe ManyChat

Respuestas reales del servicio, capturadas contra el catálogo. Los `ref` y los
productos cambian; la forma no.

### `/manychat/buscar` — varias coincidencias

```json
{
  "ok": true,
  "texto": "Encontré 10 opciones. Responde con el número que corresponde.",
  "opciones": [
    {
      "numero": 1,
      "ref": "hG44NhfYg4wCk1KiEbls6w",
      "texto": "PARACETAMOL — $600. Disponible: 2 unidades. AVDA VALPARAISO 1057: 2."
    },
    {
      "numero": 2,
      "ref": "eZkj8bvhJrI6aCVr6yURDA",
      "texto": "TRAMADOL/PARACETAMOL 37.5MG/325MG 30 COMP — $2.990. Disponible: 3 unidades. AVDA VALPARAISO 1057: 3. Requiere receta retenida para su venta."
    }
  ],
  "canal": "whatsapp"
}
```

### `/manychat/buscar` — una sola coincidencia

`texto` trae directamente el producto, no el recuento. `opciones` igual viene con ese
único elemento.

```json
{
  "ok": true,
  "texto": "PARACETAMOL COM. 500MG. 16 (BE) — $600. Disponible: 54 unidades. AVDA VALPARAISO 1057: 54.",
  "opciones": [
    { "numero": 1, "ref": "0LSQ5URqcWoagJM050EUEw", "texto": "PARACETAMOL COM. 500MG. 16 (BE) — $600. Disponible: 54 unidades. AVDA VALPARAISO 1057: 54." }
  ],
  "canal": "whatsapp"
}
```

### `/manychat/buscar` — sin coincidencias

```json
{ "ok": true, "texto": "No encontré productos para esa búsqueda.", "opciones": [] }
```

`ok` sigue siendo `true`: la consulta funcionó, el catálogo no tiene ese producto.
Para ramificar en ManyChat, condicionar sobre el texto o sobre el primer `ref` vacío.

### `/manychat/producto`

```json
{
  "ok": true,
  "texto": "PARACETAMOL — $600. Disponible: 2 unidades. AVDA VALPARAISO 1057: 2.",
  "ref": "hG44NhfYg4wCk1KiEbls6w"
}
```

### Cualquier fallo

```json
{
  "ok": false,
  "texto": "Producto no encontrado.",
  "codigo": "CLAMI_PRODUCT_NOT_FOUND",
  "requestId": "d1879931-5d04-4ff6-b1db-8d4cb6c78e8a"
}
```

`texto` está redactado para mostrarse al cliente tal cual. `codigo` y `requestId` son
para quien revisa los registros; no mostrarlos en la conversación. Los códigos posibles
están en `docs/FALLAS-Y-OPERACION.md`.

## Qué mapear en ManyChat

| JSONPath | Guardar en | Para qué |
|---|---|---|
| `$.texto` | campo de texto | Es lo único que se muestra al cliente |
| `$.opciones[0].ref` | campo interno | El `ref` de la opción 1 |
| `$.opciones[1].ref` | campo interno | El `ref` de la opción 2 |
| `$.opciones[0].texto` | campo de texto | Si se arma el menú opción por opción |
| `$.ok` | campo numérico o de texto | Para ramificar entre resultado y aviso |

Hay que crear un campo por cada posición que se vaya a ofrecer. Una búsqueda devuelve
hasta 10, pero ofrecer tres o cuatro suele bastar en una conversación.

**No mostrar el `ref` al cliente.** Es el identificador interno del catálogo: se guarda
en un campo, el cliente elige por número, y ese `ref` se envía a `/manychat/producto`.

## El flujo completo

```
Cliente: "tienen paracetamol?"
   |
   v
ManyChat  --- POST /manychat/buscar  {"q":"paracetamol","canal":"whatsapp"} --->  Puente
                                                                                    |
                                          GET /buscar/?q=paracetamol  ------------->|
                                                               Authorization: Bearer |
                                                                                    v
                                                                                 CLAMI
                                                                                    |
   <--- 200 {"ok":true,"texto":...,"opciones":[{numero,ref,texto}...]}  <------------|
   |
   | ManyChat guarda $.texto y los $.opciones[n].ref en campos
   v
Cliente lee las opciones y responde "2"
   |
   v
ManyChat  --- POST /manychat/producto  {"ref":"<el ref guardado en la posicion 2>"}  --->  Puente
                                                                                            |
                                                 GET /producto/<ref>/  -------------------->|
                                                                                            v
                                                                                         CLAMI
   <--- 200 {"ok":true,"texto":"... $2.990. Disponible: 3 unidades ...","ref":"..."}  <------|
   |
   v
Cliente lee precio y stock al dia
```

La segunda llamada no es redundante: entre que el cliente ve la lista y elige, el precio
o el stock pueden haber cambiado. Por eso `/manychat/producto` vuelve a consultar en vez
de reutilizar lo que trajo la búsqueda.

## Lo que el puente recibe de CLAMI

Para entender de dónde sale cada parte del `texto`:

```json
{
  "consulta": "paracetamol",
  "resultados": [
    {
      "ref": "hG44NhfYg4wCk1KiEbls6w",
      "nombre": "PARACETAMOL",
      "tipo": "MEDICAMENTOS",
      "marca": "GENÉRICO",
      "stock": 2,
      "locales": [{ "nombre_local": "AVDA VALPARAISO 1057", "stock": 2 }],
      "precio_venta": 600,
      "receta_retenida": false
    }
  ]
}
```

| Campo de CLAMI | Dónde aparece |
|---|---|
| `nombre` | al principio del `texto` |
| `precio_venta` | formateado como `$600`, pesos chilenos sin decimales |
| `stock` | `Disponible: N unidades` · `0` da «Sin unidades disponibles» · `null` da «Servicio sin inventario» |
| `locales[]` | `nombre_local: stock`, separados por ` · ` |
| `receta_retenida` | `true` avisa · `false` calla · ausente o `null` deriva al local |
| `ref` | va en `opciones[].ref`, nunca dentro del `texto` |
| `tipo`, `marca` | se validan pero hoy no se muestran |
| `consulta` | se ignora; vuelve `null` cuando se buscó un código de barras |

Un código de barras entra por `q` y **nunca vuelve** en la respuesta de CLAMI ni en la
del puente. No se guarda en la caché ni en los registros.
