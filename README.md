# CLAMI ManyChat Bridge

Servidor Node 24 para cPanel/Passenger. ManyChat llama a este servidor; este servidor consulta CLAMI. No expone la credencial CLAMI.

Para desplegar, seguir [docs/CPANEL-GUIA.md](docs/CPANEL-GUIA.md). Las rutas están en [docs/RUTAS-Y-FLUJO.md](docs/RUTAS-Y-FLUJO.md) y la operación en [docs/FALLAS-Y-OPERACION.md](docs/FALLAS-Y-OPERACION.md).

La división de responsabilidades está en [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md).
El resumen de archivos, rutas, seguridad y errores está en [docs/RESUMEN-ARCHIVOS.md](docs/RESUMEN-ARCHIVOS.md).

## Marcadores de este repositorio

Los ejemplos usan `usuario-cpanel` y `catalogo.ejemplo.cl` en lugar del usuario de cPanel y del dominio reales. Reemplazarlos por los propios antes de copiar cualquier comando.

## Incluye

- `POST /manychat/buscar`
- `POST /manychat/producto`
- `GET /health`
- `GET /dev/status` y `GET /dev/logs` protegidos con token de desarrollador.
- Validación de entrada y salida, secreto de ManyChat, timeout, límites locales y manejo de `429` con `Retry-After`.
- Caché corta en memoria. Las búsquedas por código de barra no se cachean ni se registran.
- Logs JSONL diarios con retención automática de 10 días.
- Persistencia mínima de contador diario y bloqueo `Retry-After` en `data/runtime-state.json`; no guarda conversaciones, consultas ni códigos de barra.
- Cerradura de instancia única: si Passenger intenta iniciar otra instancia, esta se niega a arrancar para no multiplicar la cuota CLAMI.

## Antes de instalar

1. Confirmar con iHosting la IP de salida fija de Passenger/Node.
2. Crear `catalogo.ejemplo.cl` y excluirlo de NGINX Cache.
3. Crear la aplicación con cPanel → Setup Node.js App y apuntarla fuera de `public_html`.
4. Configurar las variables de entorno desde cPanel:

```text
CLAMI_API_KEY=clami_cat_...
MANYCHAT_SECRET=un-secreto-largo-aleatorio
ADMIN_STATUS_TOKEN=otro-secreto-largo-solo-para-desarrollador
NODE_ENV=production
```

No subir `.env` real, `logs/` ni `data/` a un repositorio.

## Instalación en cPanel

1. Subir y extraer esta carpeta en `/home/usuario-cpanel/repositories/clami-bridge`.
2. En **Setup Node.js App**, crear la app con Node 24.21.0.
3. Asociar la URL al subdominio `catalogo.ejemplo.cl`.
4. Configurar `app.js` como **Application startup file**.
5. Agregar las variables de entorno anteriores.
6. No ejecutar **Run NPM Install**: el proyecto no tiene dependencias externas y evitarlo previene consumo innecesario de inodos.
7. Reiniciar la aplicación.
8. Abrir `https://catalogo.ejemplo.cl/health`; debe devolver `{"ok":true}`.

## Estado privado para desarrollo

```bash
curl --fail --silent --show-error https://catalogo.ejemplo.cl/dev/status \
  -H "Authorization: Bearer TU_ADMIN_STATUS_TOKEN"
```

Para logs técnicos sanitizados:

```bash
curl --fail --silent --show-error "https://catalogo.ejemplo.cl/dev/logs?limit=50" \
  -H "Authorization: Bearer TU_ADMIN_STATUS_TOKEN"
```

No usar el token en la URL. Los endpoints no tienen interfaz web ni devuelven consultas/códigos de barra. Tres fallos del mismo token incorrecto quedan bloqueados 40 segundos; un token inválido no puede bloquear el token real del desarrollador.

## Configuración en ManyChat

En cada External Request usar HTTPS, método `POST`, cabeceras:

```text
Content-Type: application/json
X-ManyChat-Secret: el-mismo-MANYCHAT_SECRET
```

Buscar:

```json
{ "q": "{{busqueda}}", "canal": "whatsapp" }
```

URL:

```text
https://catalogo.ejemplo.cl/manychat/buscar
```

Producto:

```json
{ "ref": "{{ref_elegido}}" }
```

URL:

```text
https://catalogo.ejemplo.cl/manychat/producto
```

Mapear `$.texto` a un campo de texto y, si hay varias opciones, mapear `$.opciones[n].ref` a campos internos para la elección del usuario. No mostrar `ref` al cliente.

## Logs, estado y limpieza

- Logs: `logs/bridge-AAAA-MM-DD.jsonl`.
- Se eliminan automáticamente al superar 10 días, al iniciar el proceso y cada 24 horas.
- Estado de cuota/bloqueo: `data/runtime-state.json`; protección de proceso: `data/single-instance.lock`.
- La caché está solo en memoria y expira sola; al reiniciar se borra.

Los logs guardan estado técnico, duración, ruta, resultado y código CLAMI. No guardan token, cabeceras, búsquedas ni códigos de barra.

## Monitoreo con curl

Crear un Cron Job cada 5 minutos en cPanel:

```bash
/usr/bin/curl --fail --silent --show-error --max-time 10 https://catalogo.ejemplo.cl/health >/dev/null
```

Esto detecta una caída y puede despertar una app Passenger inactiva, pero no reemplaza un monitor externo ni reinicia el hosting. Para recibir alertas reales, configurar un monitor externo contra `/health`.

## Pruebas locales

```bash
node --test
```

No probar la credencial CLAMI desde el PC una vez que quede registrada para la IP del servidor.

## Despliegue Git opcional

Para Git Deployment de cPanel existe `.cpanel.yml.example`. Copiarlo manualmente a `.cpanel.yml` solo después de confirmar la ruta real de la aplicación. Como esta versión no tiene dependencias, el despliegue no ejecuta npm. Si se agregan dependencias, el script aborta hasta que se configure de forma explícita la ruta real del Node Selector; nunca usar `npm ci` en este hosting.
