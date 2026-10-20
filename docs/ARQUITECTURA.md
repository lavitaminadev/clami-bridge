# Arquitectura modular

```text
app.js
  └─ server.js                  rutas HTTP y orquestación
       ├─ src/error-catalog.js  códigos internos de error
       ├─ src/input-validation.js
       ├─ src/clami-response.js validación de datos externos
       └─ src/product-presentation.js
```

`server.js` conserva la coordinación de HTTP, caché, cuota, estado, logs y llamadas a CLAMI. Los módulos separan validación de entrada, validación de salida, presentación y catálogo de errores para que cambios futuros no mezclen responsabilidades.

## Concurrencia

Una instancia Node atiende varias solicitudes asíncronas a la vez. La cuota CLAMI por minuto usa un contador separado de la caché, por lo que no puede ser desalojada al llenarse la caché de resultados.

La instalación actual debe ejecutarse con una sola instancia Passenger. Al iniciar, el proceso adquiere de forma exclusiva `data/single-instance.lock`; una segunda instancia falla antes de atender tráfico. Así no puede multiplicar las llamadas a CLAMI de forma silenciosa. Para varios procesos reales se requiere un almacén compartido, por ejemplo Redis, para cuota diaria/minuto, cooldown `429`, caché y bloqueos administrativos. No habilitar múltiples instancias hasta agregarlo y probarlo.
