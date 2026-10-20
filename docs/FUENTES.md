# Fuentes usadas

## CLAMI — oficial

- https://www.clami.cl/devs/acceso
- https://www.clami.cl/devs/farmacia/
- https://www.clami.cl/devs/farmacia/openapi.yaml

Se usaron para endpoints, autenticación, límites, `ref`, códigos de barra y `receta_retenida`.

El portal exige RUT de empresa y clave de acceso, así que la especificación no se puede
consultar desde fuera. El contraste se hizo sobre el OpenAPI 3.0.3 entregado por el
portal. Lo verificado contra esa especificación:

| Punto | Especificación | En el puente |
|---|---|---|
| Base | `https://www.clami.cl/api/catalogo` | fija en código |
| Autenticación | `Authorization: Bearer` o `X-Api-Key` | Bearer |
| `q` | 3 a 120 caracteres | validado |
| `ref` | 22 caracteres exactos | validado a la entrada y en la respuesta |
| `precio_venta` | entero | validado |
| `stock` | número, admite decimales, `null` en servicios | validado |
| `locales[].stock` | número, no nulo | validado |
| `receta_retenida` | `true` / `false` / `null` | los tres casos distinguidos |
| Resultados por búsqueda | 10, sin paginación | recortado a 10 |
| Código de barras | solo entrada, nunca vuelve | no se cachea ni se registra |
| Consultas por minuto | 60 | tope propio en 55 |
| Consultas por día | 3.000 | tope propio en 2.700 |
| Productos distintos por día | 1.500 | tope propio en 1.400 |
| Orígenes por credencial | 1 | pendiente de confirmar la IP con iHosting |
| `429` | respetar `Retry-After`, no reintentar en bucle | bloqueo hasta que venza |
| `401` / `403` | avisar al operador, no al cliente | mensaje genérico al cliente, código en los logs |

Queda una lectura por confirmar con CLAMI: si un producto devuelto por `/buscar/` cuenta
para el tope de productos distintos del día. El puente toma la lectura estrecha y cuenta
solo los que llegan a pedirse por `/producto/<ref>/`.

## ManyChat — documentación pública oficial

- https://help.manychat.com/hc/es/articles/14281285374364-Herramientas-de-desarrollo-Solicitud-externa
- https://help.manychat.com/hc/en-us/articles/14281252007580-Dev-Tools-Basics
- https://help.manychat.com/hc/en-us/articles/14281268533788-Dev-Tools-Dynamic-block

Se usaron para External Request, HTTPS, cabeceras, JSON y mapeo de respuesta.

## cPanel — documentación oficial pública

- https://support.cpanel.net/hc/en-us/articles/360063461753-Node-js-applications-won-t-start-in-cPanel-403-Forbidden-AH01276-Cannot-serve-directory-No-matching-DirectoryIndex
- https://support.cpanel.net/hc/en-us/articles/1500002443862-How-to-restart-an-application-that-s-using-cPanel-s-Application-Manager
- https://support.cpanel.net/hc/en-us/articles/1500000004602-How-to-create-a-NodeJS-application-via-CloudLinux
- https://docs.cpanel.net/cpanel/security/ssl-tls-status/92/

Se usaron para el archivo `app.js`, Passenger, reinicio mediante `tmp/restart.txt`, Setup Node.js App y AutoSSL.

## iHosting/cPanel — evidencia privada aportada

Origen: `https://cpanel.ejemplo.cl`.

Datos vistos: cuenta, dominio, home, servidor, SSL, NGINX Cache, recursos y subdominios. La IP de salida real de Node/Passenger no está confirmada por esa pantalla y debe ser validada con iHosting.
