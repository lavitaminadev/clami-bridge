# Entrega del puente CLAMI / ManyChat

## Código

| Archivo | Uso |
|---|---|
| `app.js` | Entrada para Passenger/cPanel. |
| `server.js` | API segura, CLAMI, caché, logs, límites y rutas privadas. |
| `scripts/generate-admin-token.js` | Genera el token privado del desarrollador. |
| `scripts/cpanel-healthcheck.sh` | Health check para Cron Jobs de cPanel. |
| `scripts/deploy-check.sh` | Guardas opcionales para Git Deployment. |

## Rutas HTTP

| Ruta | Uso |
|---|---|
| `GET /health` | Salud mínima para Cron/monitor. |
| `POST /manychat/buscar` | ManyChat busca en CLAMI. |
| `POST /manychat/producto` | ManyChat consulta producto seleccionado. |
| `GET /dev/status` | Estado privado con token. |
| `GET /dev/logs?limit=50` | Logs técnicos privados y sanitizados con token. |
| `GET /dev/logs?date=AAAA-MM-DD&limit=100` | Historial técnico de un día, disponible 10 días. |

## Antes de producción

1. Seguir `docs/CPANEL-GUIA.md`.
2. Crear `catalogo.farmaciavittae.cl` y certificado HTTPS.
3. Configurar `CLAMI_API_KEY`, `MANYCHAT_SECRET`, `ADMIN_STATUS_TOKEN` y `NODE_ENV=production` en cPanel.
4. Confirmar la IP de salida de Passenger con iHosting antes de usar la credencial CLAMI.
5. Excluir el subdominio de NGINX Cache.
6. Probar `/health`, luego ManyChat y finalmente CLAMI real.

## Token privado

```bash
npm run generate:admin-token
```

El token solo va en `ADMIN_STATUS_TOKEN` de cPanel y en la cabecera `Authorization: Bearer ...` del desarrollador. No se usa en URLs, Git, logs ni chats.
