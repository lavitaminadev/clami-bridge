# CLAMI ManyChat Bridge

Servidor Node 24 que conecta un bot de ManyChat con el catálogo CLAMI de una farmacia.
ManyChat llama a este servidor; este servidor consulta CLAMI y devuelve texto listo para
mostrarle al cliente. **La credencial de CLAMI nunca sale del servidor.**

Sin dependencias externas. Pensado para cPanel/Passenger sobre CloudLinux.

---

## Por qué existe

ManyChat puede llamar a una API por sí solo. El puente existe porque hay cuatro cosas que
ManyChat no puede hacer y que, sin ellas, el bot sería un riesgo en vez de una ayuda:

1. **Guardar un secreto.** La credencial de CLAMI tendría que ir escrita en la
   configuración de ManyChat, visible para cualquiera con acceso a esa cuenta. CLAMI
   permite **un solo origen por credencial**: filtrada, hay que rotarla y reconfigurar.
2. **Respetar una cuota.** CLAMI limita a 60 consultas por minuto, 3.000 al día y 1.500
   productos distintos diarios. ManyChat no cuenta nada: dispararía hasta chocar con el
   `429` y el bot quedaría mudo sin que nadie supiera por qué.
3. **Decidir qué se le dice a un cliente de farmacia.** Un medicamento de receta retenida
   no puede ofrecerse igual que un jabón. Esa regla vive en código, con tests, no en la
   configuración de un bot.
4. **Proteger al cliente de un error del catálogo.** Si CLAMI devuelve un producto a
   medias, sin el puente el cliente leería `$NaN` o un stock vacío. El puente lo rechaza
   antes de que llegue a la conversación.

---

## Marcadores de este repositorio

Este repositorio es **público**. Los ejemplos usan `usuario-cpanel` y
`catalogo.ejemplo.cl` en lugar del usuario de cPanel y del dominio reales: son datos de
reconocimiento sobre un servidor en producción. Reemplazarlos por los propios antes de
copiar cualquier comando.

---

## El flujo completo

```
Cliente: "tienen paracetamol?"
   |
   v
ManyChat  --POST /manychat/buscar  {"q":"paracetamol","canal":"whatsapp"}-->  Puente
                                        X-ManyChat-Secret: ...                  |
                                                                                |
                                   GET /buscar/?q=paracetamol  ---------------->|
                                   Authorization: Bearer clami_cat_...          v
                                                                             CLAMI
   <--200 {"ok":true,"texto":...,"opciones":[{numero,ref,texto},...]}  <--------|
   |
   | ManyChat guarda $.texto y los $.opciones[n].ref en campos personalizados
   v
Cliente lee las opciones y responde "2"
   |
   v
ManyChat  --POST /manychat/producto  {"ref":"<el ref de la posicion 2>"}-->  Puente
                                                                                |
                                   GET /producto/<ref>/  --------------------->|
                                                                                v
                                                                             CLAMI
   <--200 {"ok":true,"texto":"... $2.990. Disponible: 3 unidades ...","ref":...} |
   |
   v
Cliente lee precio y stock al dia
```

**Por qué dos llamadas y no una.** Entre que el cliente ve la lista y elige, el precio o
el stock pueden haber cambiado. `/manychat/producto` vuelve a consultar en vez de
reutilizar lo que trajo la búsqueda. Es una consulta más de cuota a cambio de no
decirle a alguien un precio que ya no existe.

El detalle del JSON de cada respuesta, los JSONPath a mapear y la correspondencia entre
cada campo de CLAMI y lo que ve el cliente están en
[docs/RUTAS-Y-FLUJO.md](docs/RUTAS-Y-FLUJO.md).

---

## Rutas

| Ruta | Método | Quién la usa | Protección |
|---|---|---|---|
| `/manychat/buscar` | POST | ManyChat | `X-ManyChat-Secret` |
| `/manychat/producto` | POST | ManyChat | `X-ManyChat-Secret` |
| `/health` | GET | Cron y monitores | ninguna; no revela nada |
| `/dev/status` | GET | Desarrollador | `Authorization: Bearer` |
| `/dev/logs` | GET | Desarrollador | `Authorization: Bearer` |

Las URL son alcanzables desde Internet porque ManyChat tiene que llamarlas. **Ninguna URL
es secreta**: la seguridad está en las cabeceras, no en que nadie conozca la dirección.

---

## Los controles, y por qué está cada uno

### Entrada

| Control | Qué hace | Por qué |
|---|---|---|
| Secreto de ManyChat | Cabecera comparada en tiempo constante | La URL es pública; sin esto cualquiera consume la cuota de CLAMI |
| Comparación en tiempo constante | `crypto.timingSafeEqual` | Una comparación normal filtra el secreto carácter a carácter por diferencia de tiempo |
| Solo `application/json` | Rechaza otros `Content-Type` | Cierra la superficie a envíos de formulario y a confusión de tipos |
| Cuerpo máximo de 8 KB | Corta la lectura al superarlo | Un cuerpo enorme ocuparía memoria del proceso antes de poder rechazarlo |
| Lista blanca de campos | `q` y `canal`, o solo `ref` | Un campo extra es señal de que el llamador no es el flujo esperado |
| `q` de 3 a 120 caracteres | Validado | Es el rango que define la especificación de CLAMI |
| `ref` de 22 caracteres exactos | Expresión regular | La especificación lo fija así; también cierra el recorrido de rutas (`../../etc/passwd`) |

### Salida de CLAMI

| Control | Qué hace | Por qué |
|---|---|---|
| Normalización del producto | Verifica tipo y rango de cada campo | Sin esto, un `precio_venta` ausente llega al cliente como `$NaN` |
| Rechazo total, no parcial | Si un producto de la búsqueda viene mal, falla toda la respuesta | Descartar en silencio un candidato oculta un cambio de contrato y puede hacer que ManyChat guarde un `ref` inconsistente |
| Tres estados de `receta_retenida` | `true` avisa · `false` calla · ausente deriva al local | Es una regla de farmacia, no de software: el silencio ante un dato que falta es la opción peligrosa |

### Cuota de CLAMI

| Control | Valor | Límite real | Por qué el margen |
|---|---|---|---|
| Consultas por minuto | 55 | 60 | Deja aire para que otra integración de la cuenta no dispare el `429` |
| Consultas por día | 2.700 | 3.000 | Igual |
| Productos distintos por día | 1.400 | 1.500 | Igual |
| Bloqueo tras `429` | Respeta `Retry-After`, tope de 1 hora | — | La especificación pide no reintentar en bucle |
| Caché de búsqueda | 45 segundos | — | Varias personas preguntan lo mismo seguido; el precio no cambia en ese lapso |
| Caché de producto | 20 segundos | — | Más corta: es el dato que el cliente va a usar para decidir |
| Peticiones por minuto al puente | 120 | — | Techo propio, común a las dos rutas de ManyChat. Se aplica **después** de autenticar, para que nadie sin credenciales pueda agotarlo |

### Privacidad

| Control | Por qué |
|---|---|
| Los códigos de barra no se cachean | La clave de caché sería el código mismo, guardado en memoria |
| Los códigos de barra no se registran | Identifican lo que una persona concreta consultó |
| Los registros pasan por una lista blanca de campos | Lo que no está en la lista no se escribe, aunque alguien lo agregue al evento por error |
| Retención de 10 días | Suficiente para diagnosticar, no para acumular |
| El estado persistido guarda contadores y los `ref` consultados hoy | Para no gastar dos veces el cupo por el mismo producto. Son identificadores de catálogo: ni conversaciones, ni términos buscados, ni códigos de barra, ni datos del cliente |

### Operación

| Control | Por qué |
|---|---|
| Timeout de 7 s hacia CLAMI | ManyChat corta a los 10 s; ver la sección de decisiones |
| Candado de instancia única | Un segundo proceso duplicaría la cuota en silencio |
| Retención de registros en el arranque y cada 24 h | No depende de que Passenger reinicie |
| Host de CLAMI fijo en el código | Cierra el SSRF por construcción: ninguna entrada puede cambiar el destino |
| `redirect: 'error'` | Una redirección del upstream no puede llevar la credencial a otro servidor |
| Escritura atómica del estado | Archivo temporal y `rename`; un corte no deja medio archivo |
| Permisos `0700` / `0600` | Registros y estado no legibles por otros usuarios del hosting |

---

## Las decisiones, y qué costaron

### 1. Las rutas de ManyChat devuelven `200` cuando el fallo es de operación

La documentación de ManyChat dice: *«It's not possible to map an error message if the
returned code is not 200 OK»*. Con cualquier otro código descarta el cuerpo y entrega su
contenido de *fallback*.

El puente devolvía `503`, `504`, `404` con mensajes redactados en español. **Ninguno podía
llegar al cliente.**

Hoy se separan dos situaciones:

- **Operación** — el catálogo no respondió, se agotó un cupo, el producto no existe.
  Devuelven `200` con `ok: false`, el aviso en `texto` y el código interno en `codigo`.
- **Configuración** — secreto equivocado, `Content-Type` incorrecto, ruta inexistente.
  Conservan su código real: ahí el *fallback* es la respuesta correcta y el código es lo
  que permite encontrar la falla.

**Lo que cuesta:** un monitor que mire solo códigos HTTP no verá los fallos de CLAMI en
esas dos rutas. Por eso el cuerpo lleva `codigo` y el registro sigue marcando el evento
como `request_error`. **Un `200` con `ok: false` no significa que todo salió bien.**

### 2. Timeout de 7 segundos hacia CLAMI

ManyChat corta a los 10 s y el valor no es configurable. El techo se reparte: 7 s para que
CLAMI responda y ~3 s para TLS, Passenger y el armado de la respuesta.

**Lo que cuesta:** una consulta legítimamente lenta se descarta a los 7 s aunque CLAMI
fuera a responder al octavo. Se prefiere perder esa consulta antes que terminar después
del corte, cuando ya no hay a quién responder y el cliente ve el *fallback*.

### 3. Candado de instancia única en vez de estado compartido

La cuota, la caché, el bloqueo por `429` y los bloqueos administrativos viven en memoria
del proceso. Con dos procesos de Passenger, cada uno cuenta su propia cuota: el tope de 55
por minuto se vuelve 110 y el bloqueo tras un `429` solo frena a uno.

El arranque toma `data/single-instance.lock` de forma exclusiva. Una segunda instancia se
niega a arrancar antes de atender tráfico.

**Lo que cuesta:** es una barrera, no una solución. Para varios procesos de verdad hace
falta estado compartido —Redis o equivalente— para cuota, caché, cooldown y bloqueos. **No
habilitar múltiples instancias hasta agregarlo.** Y hay riesgos propios del candado, en la
sección de límites.

### 4. Sin dependencias externas

Node 24 trae `fetch`, `crypto`, servidor HTTP y ejecutor de tests. No hace falta nada más.

**Lo que gana:** no hay `npm ci` que pueda romper el enlace `node_modules` de CloudLinux,
no hay vulnerabilidades transitivas que parchar, no hay inodos consumidos por miles de
archivos, y el despliegue no ejecuta npm.

**Lo que cuesta:** hay que escribir a mano cosas que una biblioteca daría hechas —el
limitador, la caché, la validación. Son ~700 líneas propias en vez de 40.000 ajenas.

### 5. `npm install`, nunca `npm ci`

En CloudLinux el `node_modules` de la raíz es un **enlace simbólico** al entorno del Node
Selector. `npm ci` lo borra antes de instalar y lo reemplaza por una carpeta normal: desde
ahí la resolución de módulos deja de pasar por el entorno y el arranque falla en un
`require` distinto cada vez.

`scripts/deploy-check.sh` ni siquiera llama a npm, porque no hay dependencias, y **aborta
el despliegue** si alguna vez se agregan, antes de tocar nada.

### 6. El bloqueo administrativo usa la huella del valor fallido, no la IP

Detrás de Passenger, la dirección que ve el proceso es la del proxy interno, no la del
visitante. Un bloqueo por IP habría sido un bloqueo global: un bot probando tokens dejaría
fuera al desarrollador con el token correcto.

Se agrupa por el `sha256` de la cabecera recibida. Tres intentos del **mismo** valor
inválido bloquean ese valor 40 segundos.

**Lo que cuesta:** un atacante que cambie el token en cada intento nunca acumula tres
fallos. El bloqueo es una defensa adicional; **el control principal es que el token tenga
32 bytes aleatorios.**

### 7. El límite local se aplica después de autenticar

Si se aplicara antes, cualquiera que conozca la URL —y no es secreta— podría agotar el
cupo del minuto con peticiones sin credenciales y dejar a ManyChat sin servicio.

**Lo que cuesta:** el tráfico sin autenticar no tiene límite propio y cada rechazo escribe
una línea de registro. Ver la sección de límites.

### 8. El código de barras entra pero no vuelve

La especificación de CLAMI dice que un código de barras sirve solo como entrada y nunca
aparece en las respuestas. El puente va más lejos: tampoco lo cachea ni lo registra.

**Lo que cuesta:** dos clientes que escaneen el mismo producto seguido generan dos
consultas a CLAMI en vez de una. Se paga cuota a cambio de no guardar qué consultó cada
persona.

---

## Instalación en cPanel

La guía detallada, con cada campo del panel, está en
[docs/CPANEL-GUIA.md](docs/CPANEL-GUIA.md). El orden importa:

1. **Subdominio**, con Document Root **fuera de `public_html`** y HTTPS forzado.
   Excluirlo de NGINX Cache: una respuesta cacheada muestra precios y stock viejos, que es
   justo lo que este puente existe para evitar.
2. **Git Version Control → Clone a Repository**, a una ruta fuera de `public_html`.
   Va antes que la aplicación Node: el clon exige un directorio vacío, y el Node Selector
   deja ahí su enlace `node_modules`.
3. **Setup Node.js App**: Node 24.21.0, modo `Production`, raíz la del clon, archivo de
   inicio `app.js`. **No fijar `PORT`**: lo entrega Passenger.
4. **Variables de entorno** (ver abajo).
5. **Restart** y comprobar `https://catalogo.ejemplo.cl/health` → `{"ok":true}`.
6. **Deploy**, que instala la tarea de salud en el crontab.

### Variables de entorno

| Variable | Obligatoria | Qué es |
|---|---|---|
| `CLAMI_API_KEY` | sí | `clami_cat_…`, la entrega el administrador de CLAMI |
| `MANYCHAT_SECRET` | sí | Se genera; el mismo valor va en la cabecera de ManyChat |
| `ADMIN_STATUS_TOKEN` | no | Se genera; sin él, `/dev/*` queda cerrado y el bot funciona igual |
| `LOG_DIR` | no | Por defecto `logs/` dentro de la aplicación |
| `DATA_DIR` | no | Por defecto `data/` dentro de la aplicación |

`PORT` y `NODE_PATH` los entrega Passenger: **no definirlos**. El modo `Production` del
panel ya fija `NODE_ENV`.

Para generar los dos secretos, en una máquina local:

```bash
npm run generate:admin-token
```

Una vez por cada uno. **Los tres valores son distintos entre sí**: si ManyChat se
compromete, su secreto no puede dar acceso a CLAMI.

Conviene apuntar `LOG_DIR` y `DATA_DIR` fuera del repositorio, para que una operación de
git no se lleve por delante el estado en ejecución:

```text
LOG_DIR=/home/usuario-cpanel/clami-bridge-datos/logs
DATA_DIR=/home/usuario-cpanel/clami-bridge-datos/data
```

---

## Despliegue continuo

Con `.cpanel.yml` versionado, el botón **Deploy** de cPanel queda disponible y cada
despliegue:

1. Aborta si la aplicación quedó dentro de `public_html`.
2. Comprueba que estén `app.js`, `server.js`, `package.json` y `scripts/check-project-files.sh`.
3. Cuenta los archivos del proyecto contra el tope de inodos.
4. Aborta si aparecieron dependencias, antes de tocar el enlace `node_modules`.
5. Toca `tmp/restart.txt`, de modo que el código nuevo queda corriendo sin pasar por
   Setup Node.js App.
6. Instala la tarea de salud en el crontab.

### La tarea de salud

`scripts/setup-crontab.sh` se ejecuta con el despliegue y **no a mano**. Reemplaza
solamente sus propias líneas, reconocidas por un marcador, y conserva las demás; correrlo
sin cambios deja el crontab igual.

La URL va en `.cpanel.yml`, de modo que el despliegue no depende de ningún paso
manual. El dominio es público desde que AutoSSL emitió el certificado y quedó en los
registros de Certificate Transparency; el usuario de la cuenta, que sí es media
credencial, no aparece en ninguna parte del repositorio.

Quien prefiera no tenerlo ahí puede quitar la URL de esa línea y dejarla en
`~/.clami-bridge-health-url`, que el script sigue aceptando:

```bash
echo "https://catalogo.ejemplo.cl/health" > ~/.clami-bridge-health-url
```

Sin ese archivo no instala nada y lo dice. **No detiene el despliegue si falla**: una
aplicación publicada sin su recordatorio de salud funciona; una que no se publicó porque
el crontab dio error, no.

La tarea comprueba `/health` cada 5 minutos y **no imprime nada mientras el servicio esté
sano**, de modo que cPanel solo envía correo cuando hay algo que mirar. Además mantiene la
aplicación despierta: Passenger la duerme por inactividad, y el primer cliente después de
un silencio esperaba alrededor de un segundo en vez de una décima.

**No reemplaza un monitor externo**: si el hosting entero cae, el cron cae con él.

---

## Configuración en ManyChat

Requiere un plan con **External Request**. En cada petición: HTTPS, método `POST`, y las
cabeceras

```text
Content-Type: application/json
X-ManyChat-Secret: el-mismo-MANYCHAT_SECRET
```

| Acción | URL | Cuerpo |
|---|---|---|
| Buscar | `https://catalogo.ejemplo.cl/manychat/buscar` | `{ "q": "{{busqueda}}", "canal": "whatsapp" }` |
| Producto | `https://catalogo.ejemplo.cl/manychat/producto` | `{ "ref": "{{ref_elegido}}" }` |

Mapear `$.texto` a un campo de texto y los `$.opciones[n].ref` a campos internos. **No
mostrar el `ref` al cliente**: es el identificador del catálogo; el cliente elige por
número.

**Al probar desde el panel los campos quedan vacíos, y es lo esperado.** La documentación
de ManyChat dice que el mapeo *«is only successful when you trigger the DevTool as a
contact or preview the automation»*. Hay que probar como contacto o con la vista previa.

Conviene configurar un *fallback* con un mensaje neutro: es lo que verá el cliente si el
secreto o la External Request quedan mal configurados.

---

## Operación

### Estado y registros

```bash
curl --fail --silent --show-error https://catalogo.ejemplo.cl/dev/status \
  -H "Authorization: Bearer TU_ADMIN_STATUS_TOKEN"

curl --fail --silent --show-error "https://catalogo.ejemplo.cl/dev/logs?limit=50" \
  -H "Authorization: Bearer TU_ADMIN_STATUS_TOKEN"
```

**Nunca poner el token en la URL**: quedaría en los registros de acceso del servidor.

- Registros: `logs/bridge-AAAA-MM-DD.jsonl`, borrados al superar 10 días.
- Estado de cuota y bloqueo: `data/runtime-state.json`.
- Candado de proceso: `data/single-instance.lock`.
- La caché vive solo en memoria y se pierde al reiniciar, a propósito.

### Qué hacer cuando algo falla

La tabla completa de códigos y respuestas está en
[docs/FALLAS-Y-OPERACION.md](docs/FALLAS-Y-OPERACION.md). Los tres más frecuentes:

- **`/health` devuelve `{"ok":false}`** — falta `CLAMI_API_KEY` o `MANYCHAT_SECRET`.
  Revisar variables y reiniciar.
- **`500` sin una sola línea en el registro de Passenger** — el error es de Apache, no de
  Node. Revisar el `.htaccess` del Document Root del subdominio antes que nada: si hereda
  reglas de WordPress, usar `deployment/htaccess-node-root.template`.
- **`codigo: CLAMI_CREDENTIAL_OR_ORIGIN`** — la credencial es inválida o la IP de salida
  no es la registrada. CLAMI permite **un solo origen por credencial**.

### Pruebas

```bash
node --test
```

No sale ninguna petición de la máquina y no se consume cuota: `fetch` se sustituye por un
doble dentro del proceso de prueba. El destino de `clamiGet` sigue clavado en el código y
no hay variable que lo mueva.

| Archivo | Qué fija |
|---|---|
| `test/http.test.js` | Autenticación, orden de las comprobaciones, cabeceras, códigos, bloqueo administrativo, que ningún secreto salga en una respuesta |
| `test/clami.test.js` | La credencial viaja en `Authorization`, cada error del catálogo da su código, el `Retry-After` se respeta, ningún mensaje menciona la credencial |
| `test/clami-bloqueo.test.js` | Un `Retry-After` desmedido se acota a una hora |
| `test/candado.test.js` | Toma, libera y recuperación de un candado huérfano |
| `test/registros.test.js` | La lista blanca de los registros |
| `test/cache.test.js` | Vencimiento y desalojo |
| `test/bordes.test.js` | Límite de 8 KB, rangos de precio y stock, `ref`, comparación del secreto |
| `test/server.test.js` | Validación, formato y clasificación de errores |

**Lo que estas pruebas no pueden decir** es si CLAMI cambió su contrato: el doble responde
lo que el proyecto cree que CLAMI responde. Para eso está la prueba real contra el
servidor desplegado, y por eso `src/clami-response.js` rechaza toda respuesta que no
encaje con la especificación en vez de confiar en ella.

**No probar la credencial de CLAMI desde un PC** una vez que quede registrada para la IP
del servidor: la consulta vendría de otro origen y CLAMI la rechazaría.

---

## Límites conocidos

Lo que este servicio **no** resuelve, dicho antes de que lo descubra alguien en
producción:

- **El candado de instancia única tiene dos riesgos propios.** Si Passenger levanta el
  proceso nuevo antes de matar el viejo, el nuevo no puede tomar el candado y muere. Y si
  el proceso muere por `SIGKILL`, el candado queda; al reiniciar, un PID reutilizado por
  otro proceso del hosting lo haría parecer activo y la aplicación no arrancaría sin
  intervención manual.
- **El tráfico sin autenticar no tiene límite propio**, y cada rechazo escribe una línea.
  Una inundación sostenida engorda el registro del día. El tope de 120 por minuto se
  aplica después de autenticar, a propósito: antes, cualquiera podía agotarlo sin
  credenciales y dejar a ManyChat sin servicio.
- **El desalojo de la caché es por antigüedad, no por uso.** Trescientas búsquedas
  distintas desalojan el término más consultado aunque siga siendo el más pedido.
  Degrada el ahorro de cuota, no la corrección.
- **Un bloqueo administrativo ya activo no deja registro propio.** A partir del cuarto
  intento solo queda el `request_error`, así que `/dev/logs` subrepresenta la intensidad
  de un intento sostenido.
- **El nombre de los registros depende de ICU completo.** La fecha que nombra cada
  archivo sale de `Intl.DateTimeFormat` con zona horaria. En un Node compilado sin ICU
  completo el formato cambiaría y la escritura fallaría en silencio. Los binarios
  oficiales de Node 24 lo traen, pero el arranque no comprueba la suposición.
- **`/health` no consulta CLAMI.** Responde `200` con el catálogo caído: solo confirma que
  Node está vivo y configurado.
- **El tope de productos distintos es una interpretación.** La especificación no dice si
  un producto devuelto por `/buscar/` cuenta para el límite de 1.500 diarios. El puente
  toma la lectura estrecha y cuenta solo los pedidos por `/producto/<ref>/`. **Queda por
  confirmar con CLAMI**; si las búsquedas también cuentan, el tope se consume hasta diez
  veces más rápido.
- **Ninguna URL pública es secreta.** La seguridad de las rutas de ManyChat depende de la
  cabecera, no de que nadie conozca la dirección.
- **El `ADMIN_STATUS_TOKEN` permite revisar estado, no es una plataforma de monitoreo.**

---

## Documentación

| Documento | Qué contiene |
|---|---|
| [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md) | División de responsabilidades entre módulos |
| [docs/RUTAS-Y-FLUJO.md](docs/RUTAS-Y-FLUJO.md) | JSON de cada respuesta, JSONPath a mapear, flujo completo |
| [docs/FALLAS-Y-OPERACION.md](docs/FALLAS-Y-OPERACION.md) | Códigos de error, diagnóstico, presupuesto de tiempo |
| [docs/CPANEL-GUIA.md](docs/CPANEL-GUIA.md) | Cada campo del panel, paso a paso |
| [docs/REVISION-FORENSE.md](docs/REVISION-FORENSE.md) | Riesgos y el control que responde a cada uno |
| [docs/RESUMEN-ARCHIVOS.md](docs/RESUMEN-ARCHIVOS.md) | Qué hace cada archivo |
| [docs/FUENTES.md](docs/FUENTES.md) | Fuentes oficiales y qué se verificó contra cada una |
