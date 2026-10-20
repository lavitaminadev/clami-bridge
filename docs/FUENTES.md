# Fuentes usadas

## CLAMI — oficial

- https://www.clami.cl/devs/acceso
- https://www.clami.cl/devs/farmacia/
- https://www.clami.cl/devs/farmacia/openapi.yaml

Se usaron para endpoints, autenticación, límites, `ref`, códigos de barra y `receta_retenida`.

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

Origen: `https://cpanel.farmaciavittae.cl`.

Datos vistos: cuenta, dominio, home, servidor, SSL, NGINX Cache, recursos y subdominios. La IP de salida real de Node/Passenger no está confirmada por esa pantalla y debe ser validada con iHosting.
