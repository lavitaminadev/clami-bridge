# CLAMI + ManyChat: guía breve para el equipo

Esta guía resume el puente Node que conecta ManyChat con CLAMI. No contiene
credenciales ni datos de clientes.

## 1. Qué se instaló

```text
Cliente -> ManyChat -> puente Node -> API CLAMI -> puente Node -> ManyChat
```

ManyChat no usa la clave CLAMI. El puente la conserva en cPanel, valida las
peticiones, limita consultas y prepara la respuesta para el chat.

| Variable privada de cPanel | Uso |
|---|---|
| `CLAMI_API_KEY` | Autoriza al servidor frente a CLAMI. |
| `MANYCHAT_SECRET` | Autoriza las rutas que llama ManyChat. |
| `ADMIN_STATUS_TOKEN` | Autoriza las rutas privadas `/dev/*`. |

Nunca poner valores de estas variables en Git, URLs, capturas, tickets o chats.

## 2. Dos contratos JSON, dos fuentes

### Datos oficiales de CLAMI

Fuente oficial: https://www.clami.cl/devs/farmacia/ y
https://www.clami.cl/devs/farmacia/openapi.yaml.

El puente consulta:

```text
GET /api/catalogo/buscar/?q=<texto o código de barras>
GET /api/catalogo/producto/<ref>/
```

CLAMI devuelve `resultados` con `ref`, `nombre`, `tipo`, `marca`, `stock`,
`locales`, `precio_venta` y, cuando está informado, `receta_retenida`. El
`ref` lo entrega CLAMI; nunca se inventa ni se modifica.

```json
{
  "consulta": "paracetamol",
  "resultados": [
    {
      "ref": "Qm9uZGlhc0NsYW1pMjAyNg",
      "nombre": "Paracetamol 500 mg x 16 comprimidos",
      "stock": 34,
      "locales": [{"nombre_local": "Casa matriz", "stock": 22}],
      "precio_venta": 1990,
      "receta_retenida": false
    }
  ]
}
```

El ejemplo anterior es de la documentación oficial CLAMI.

### Respuesta propia del puente

Fuente: `server.js` y `README.md` de este repositorio. No es una respuesta que
CLAMI entregue directamente.

Las rutas simples transforman los datos validados a texto y opciones:

```json
{
  "ok": true,
  "texto": "<texto generado por el puente>",
  "opciones": [
    {
      "numero": 1,
      "ref": "<ref real de CLAMI>",
      "texto": "<nombre, precio, stock y aviso aplicable>"
    }
  ],
  "canal": "whatsapp"
}
```

Los valores entre `< >` son marcadores, no datos reales ni inventados.

## 3. Rutas disponibles

| Ruta | Método | Protección | Uso |
|---|---|---|---|
| `/health` | GET | Ninguna | Confirma que Node responde. No consulta CLAMI. |
| `/manychat/buscar` | POST | `X-Manychat-Secret` | Flujo simple: texto y opciones preparadas. |
| `/manychat/producto` | POST | `X-Manychat-Secret` | Flujo simple: texto actualizado por `ref`. |
| `/manychat/buscar-detalle` | POST | `X-Manychat-Secret` | Flujo avanzado: lista de productos normalizados. |
| `/manychat/producto-detalle` | POST | `X-Manychat-Secret` | Flujo avanzado: producto normalizado por `ref`. |
| `/dev/status` | GET | `Authorization: Bearer` | Estado técnico privado. |
| `/dev/logs` | GET | `Authorization: Bearer` | Eventos técnicos privados de hasta 10 días. |

Las dos rutas `-detalle` son opcionales y no cambian las rutas simples existentes.

## 4. Flujo simple: recomendado para la farmacia

ManyChat agrega estas cabeceras en External Request:

```text
X-Manychat-Secret: valor de MANYCHAT_SECRET
Content-Type: application/json
```

Buscar:

```http
POST https://catalogo.farmaciavittae.cl/manychat/buscar
```

```json
{"q":"{{busqueda}}","canal":"whatsapp"}
```

Después ManyChat muestra `$.texto`, guarda `$.opciones[n].ref` como campo
interno y consulta el producto elegido:

```http
POST https://catalogo.farmaciavittae.cl/manychat/producto
```

```json
{"ref":"{{ref_elegido}}"}
```

No mostrar el `ref` al cliente. Si `receta_retenida` es `true`, la ruta simple
ya incorpora el aviso; si llega `null` o no informado, no afirma que sea libre
de receta.

## 5. Flujo avanzado: detalle normalizado

Usar solo si el automatizador necesita decidir formato, filtros o menú propio.
No entrega una respuesta HTTP cruda de CLAMI: entrega el mismo subconjunto de
campos oficiales después de validarlo. Así un cambio o respuesta incompleta de
CLAMI no llega directamente a ManyChat.

Buscar detalle:

```http
POST https://catalogo.farmaciavittae.cl/manychat/buscar-detalle
```

```json
{"q":"{{busqueda}}","canal":"whatsapp"}
```

Respuesta:

```json
{
  "ok": true,
  "consulta": "<texto normalizado; null si fue código de barras>",
  "resultados": [
    {
      "ref": "<ref real de CLAMI>",
      "nombre": "<nombre>",
      "tipo": "<tipo o null>",
      "marca": "<marca o null>",
      "stock": 0,
      "locales": [],
      "precio_venta": 0,
      "receta_retenida": null
    }
  ],
  "canal": "whatsapp"
}
```

Producto detalle:

```http
POST https://catalogo.farmaciavittae.cl/manychat/producto-detalle
```

```json
{"ref":"{{ref_elegido}}"}
```

Respuesta: `{"ok":true,"producto":{...campos normalizados CLAMI...}}`.

En este flujo, el automatizador debe mostrar precio y disponibilidad, y debe
avisar receta retenida cuando `receta_retenida` sea `true`.

## 6. Errores y auditoría

Las cuatro rutas ManyChat comparten secreto, límite local, cuota CLAMI, caché,
validación y registros. Si CLAMI, su red o sus límites fallan, responden HTTP
`200` con esta forma para que ManyChat pueda leerla:

```json
{
  "ok": false,
  "texto": "<mensaje seguro para el cliente>",
  "codigo": "<código técnico del puente>",
  "requestId": "<identificador técnico>"
}
```

Un secreto inválido, JSON inválido o `Content-Type` incorrecto conserva su
código HTTP real (`401`, `400`, `413` o `415`). Configurar fallback en ManyChat
para esos casos.

Los logs no guardan búsquedas, códigos de barras, cuerpos, cabeceras, tokens,
IP ni datos del cliente. Solo guardan datos técnicos como `ts`, `event`,
`requestId`, `route`, `status`, `durationMs`, `errorCode` y `clamiStatus`.

## 7. Panel privado de desarrollo

```cmd
set /p "ADMIN_TOKEN=Pega ADMIN_STATUS_TOKEN: "
curl.exe -i -sS "https://catalogo.farmaciavittae.cl/dev/status" -H "Authorization: Bearer %ADMIN_TOKEN%"
curl.exe -i -sS "https://catalogo.farmaciavittae.cl/dev/logs?limit=100" -H "Authorization: Bearer %ADMIN_TOKEN%"
set "ADMIN_TOKEN="
```

`/dev/status` entrega `commit`, `uptimeSeconds`, `quota`,
`cooldownSeconds`, `cacheEntries`, `lastClami` y `logRetentionDays`.

Para revisar un día anterior dentro de la ventana de 10 días:

```cmd
curl.exe -i -sS "https://catalogo.farmaciavittae.cl/dev/logs?date=AAAA-MM-DD&limit=100" -H "Authorization: Bearer %ADMIN_TOKEN%"
```

## 8. Estado confirmado el 22 de octubre de 2026

- cPanel desplegó `2efa50f301cad2692980ef8534cd9757def8dbde`.
- `/health` y `/dev/status` respondieron HTTP 200.
- La retención de eventos estaba configurada en 10 días.
- El cron dejó llamadas correctas a `/health` cada cinco minutos.

Una ruta externa desconocida, como `/403.shtml`, recibe `404 ROUTE_NOT_FOUND`
sin consultar CLAMI ni gastar cuota. Si se repite, revisar `ErrorDocument` y
`.htaccess` del Document Root del subdominio.
