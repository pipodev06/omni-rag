# Configuración inicial y valores recomendados

Omni RAG arranca con `docker compose up -d`, sin archivo `.env`: las contraseñas internas se generan solas y todo lo demás tiene un valor por defecto que funciona. Esta guía dice qué no puede faltar, qué conviene configurar y por qué cada ajuste importante tiene el valor que tiene.

Casi todo se cambia en la web, en **Sistema → Configuración** y **Sistema → Copias** (solo el superadministrador). Lo que esté escrito en el `.env` manda y sale bloqueado en la pantalla; para volver a editarlo allí: `docker compose exec api node dist/scripts/import-env-settings.js` (ver [variables.md](variables.md)).

## 1. Primer arranque

1. `docker compose up -d`.
2. `docker compose logs api` muestra un **código de un solo uso** («CONFIGURACIÓN INICIAL»).
3. Abre la web (por defecto <http://localhost:8000>): sale la **Configuración inicial**. Escribe el código y crea el superadministrador (contraseña de **15 caracteres** o más; los demás usuarios necesitan 10). El código impide que otra persona que llegue antes a la web se quede con el servidor. No cambia aunque alguien pruebe códigos malos, y se vuelve a escribir cada 10 minutos mientras falte configurar: `docker compose logs --since 10m api`.
4. Entras en **Organizaciones**, donde la lista **Primeros pasos** marca lo que falta.

## 2. Lo que no puede faltar

| Qué | Dónde | Por qué |
|---|---|---|
| **Clave de un proveedor de modelos de lenguaje** | *Sistema → Configuración → Modelos de lenguaje* | Sin ella no hay respuestas: el chat busca en los documentos, pero no puede redactar. Groq y Google (AI Studio) tienen capa gratuita; también OpenRouter, OpenAI, DeepSeek o un servidor propio compatible con OpenAI (Ollama, vLLM). |
| **Modelos de los planes con ese proveedor** | *Organizaciones → Planes* | Cada organización pregunta con los modelos de su plan. El plan inicial «Estándar» trae modelos gratuitos de OpenRouter. Si tu clave es de otro proveedor, escribe sus modelos con prefijo (`groq:…`, `google:…`; al guardar se comprueba que existan) o cambia el *Proveedor por defecto*. El primero de la lista es el principal; los siguientes, respaldos si falla o se satura. |
| **Guardar los secretos generados** | `./data/secretos` | Ahí están las contraseñas de la base, `JWT_SECRET` y la frase de cifrado de las copias. No van en las copias de seguridad. Sin `JWT_SECRET` no se pueden leer las claves de API guardadas en la pantalla ni el 2FA de los usuarios: guárdalos en un gestor de contraseñas. |
| **Con dominio público: `DOMAIN` y 2FA** | `.env` (`DOMAIN=rag.tuempresa.com`) y *Mi cuenta* | `DOMAIN` activa las protecciones de producción (cookie segura, enlaces `https://`, secretos fuertes). Con un dominio real el superadministrador debe activar la verificación en dos pasos. Ver [produccion.md](produccion.md). |

## 3. Lo recomendado

| Qué | Dónde | Por qué |
|---|---|---|
| **Correo saliente (SMTP)** | *Sistema → Configuración → Correo* | Invitaciones, recuperación de contraseña y avisos. Sin correo todo funciona, pero el administrador copia los enlaces a mano. Con «Enviar prueba» se comprueba al momento. |
| **Correo de alertas** | *Sistema → Configuración → Alertas* | El monitor revisa cada 5 minutos disco, cola, copias y modelos; sin destinatario solo se ve en *Sistema → Alertas*. |
| **Copia fuera del servidor** | *Sistema → Copias* | La copia diaria ya se hace en el servidor (`./backups`), pero si se pierde el disco se pierde con él. Activa la *Copia externa* (otro disco con `BACKUP_TARGETS_DIR`) y/o **Backblaze B2**. Ambas cifran con `BACKUP_ENCRYPTION_PASSPHRASE`, que va en el `.env` (si estuviera en la base, la llave viajaría dentro de la copia que protege). |
| **Guardar `./data/secretos` aparte** | Gestor de contraseñas o disco externo | Los datos ya viven en `./data` (ningún `docker prune` los borra), pero los secretos no van en las copias. Ver [operacion.md](operacion.md#dónde-viven-los-datos). |

## 4. Valores por defecto, qué hacen y cuándo cambiarlos

### Búsqueda y respuestas

| Ajuste | Por defecto | Qué hace | Por qué ese valor / cuándo cambiarlo |
|---|---|---|---|
| Fragmentos por pregunta (`RETRIEVAL_TOP_K`) | **6** | Cuántos fragmentos de los documentos recibe el modelo para responder. | Cada fragmento tiene unos 1.200 caracteres: 6 son unos 7.000 caracteres (≈ 2.000 tokens), suficiente para casi cualquier pregunta sin hacer lenta ni cara la respuesta. Súbelo a 8–10 si las preguntas comparan muchos documentos o la respuesta queda incompleta; bájalo a 3–4 con modelos de contexto pequeño. Más fragmentos también traen más ruido. |
| Puntuación mínima del re-ranker (`RERANK_MIN_SCORE`) | **0,02** | El re-ranker puntúa de 0 a 1 cuánto responde cada fragmento a la pregunta. Lo que queda por debajo no se envía; si nada llega, se contesta «no encontré información» sin gastar cupo. | Lo irrelevante puntúa alrededor de 0,003 y lo relevante 0,1 o más: 0,02 descarta la basura con margen. Si salen demasiados «no encontré» con preguntas que sí tienen respuesta, bájalo (0,01); si se cuelan fragmentos sin relación, súbelo (0,05). Se calibra con `POST /api/search` (ver [operacion.md](operacion.md#calibrar-la-búsqueda)). |
| Mensajes de contexto (`HISTORY_MESSAGES`) | **6** | Mensajes anteriores de la conversación que se envían con la pregunta. | Seis son tres idas y vueltas: permite preguntas de seguimiento («¿y el del año anterior?») sin que cada pregunta gaste muchos tokens. 0 = cada pregunta es independiente. |
| Temperatura (`LLM_TEMPERATURE`) | **0,2** | Cuánto varía el modelo al redactar. | En un RAG importa ser fiel a los documentos: un valor bajo reduce las invenciones. Por encima de 0,5 las respuestas son más creativas y menos fiables. |
| Longitud máxima de la respuesta (`LLM_MAX_TOKENS`) | **2.048** | Tope de tokens que escribe el modelo. | Unas 1.500 palabras: alcanza para tablas y gráficos. Súbelo si las respuestas largas se cortan. |
| Proveedor por defecto (`LLM_DEFAULT_PROVIDER`) | **openrouter** | Proveedor de los modelos de un plan escritos sin prefijo. | Cámbialo al proveedor que uses para no tener que escribir prefijos. |
| Caché de respuestas (`CACHE_ENABLED`) | **activada** | Si la primera pregunta de una conversación ya se respondió igual, reutiliza la respuesta. | Ahorra cupo y tiempo con preguntas repetidas (manuales, políticas). Se vacía sola al subir, reprocesar o borrar documentos de la colección. Con búsqueda en internet no se usa. |
| Vigencia de la caché (`CACHE_TTL_HOURS`) | **168 h** (7 días) | Cuánto dura una respuesta guardada. | Una semana: los documentos cambian poco y, cuando cambian, la caché se vacía igual. |
| Buscador de internet (`WEB_SEARCH_PROVIDER`) | **desactivado** | Modo híbrido: documentos + internet. | Opcional. Tavily o Brave (con clave) o SearXNG propio. Cada plan decide si lo permite y el usuario lo activa con «Internet». Solo se envía la pregunta, nunca fragmentos. |
| Resultados por búsqueda (`WEB_SEARCH_MAX_RESULTS`) | **5** | Resultados de internet que recibe el modelo. | Cinco dan contexto sin tapar a los documentos, que tienen prioridad. |

### Límites, retención y alertas

| Ajuste | Por defecto | Por qué |
|---|---|---|
| Aviso de cuota (`QUOTA_WARN_PERCENT`) | 80 % | Avisa en el chat (y por correo a los administradores) antes de quedarse sin preguntas. |
| Peticiones por minuto sin sesión (`IP_RATE_LIMIT_PER_MIN`) | 120 | Frena ataques de fuerza bruta sin molestar a nadie: con sesión iniciada no cuenta. |
| Caducidad de invitaciones / recuperación | 72 h / 60 min | Una invitación da tiempo a aceptarla; un enlace de recuperación debe durar poco. |
| Papelera (`TRASH_RETENTION_DAYS`) | 30 días | Margen para recuperar un borrado por error. |
| Auditoría (`AUDIT_RETENTION_DAYS`) | 365 días | Un año de historial para revisar quién hizo qué. |
| Métricas (`METRICS_RETENTION_DAYS`) | 14 días | Basta para ver tendencias de consumo; una muestra por minuto ocupa espacio. |
| Espacio libre mínimo en disco | 15 % | Deja tiempo de reacción antes de que fallen subidas y copias. |
| Antigüedad máxima de la última copia | 36 h | Una copia diaria más 12 h de margen. Al encender el servidor tras días apagado hay una hora de gracia mientras se hace la copia pendiente. |
| Documentos atascados en la cola | 30 min | Un PDF escaneado largo puede tardar varios minutos; más de media hora indica un problema. |
| Memoria de un contenedor | 90 % de su tope | Al llegar al tope Docker lo reinicia: se avisa antes. |

### Copias de seguridad

| Ajuste | Por defecto | Por qué |
|---|---|---|
| Hora de la copia (`BACKUP_AT`) | 03:00 | Una hora tranquila. Si el servidor estaba apagado a esa hora, la copia se hace al encenderlo. Con un intervalo distinto de 24 h se copia cada N horas y la hora no se usa. |
| Retención (`BACKUP_KEEP_DAYS`) | 7 días | Una semana de copias diarias en el servidor. Las más antiguas se pueden borrar a mano en *Sistema → Copias*. |
| Zona horaria (`BACKUP_TZ`) | `<-05>5` (Lima) | Formato POSIX: `<-05>5` es UTC−5. |
| Comprimir los archivos subidos | sí | Sin los archivos originales, la base sola no basta para restaurar. |
| Copia externa | no | Necesita un destino (`BACKUP_TARGETS_DIR` en el `.env`) y la frase de cifrado. |
| Backblaze B2 | no configurado | Opcional pero recomendado. Sube cada 6 h y guarda 30 días; por defecto solo la base (los archivos subidos, con «Subir también los archivos»). |

### Solo en el `.env` (no están en la pantalla)

| Variable | Por defecto | Por qué no está en la pantalla |
|---|---|---|
| `DOMAIN`, `WEB_PORT`, `WEB_BIND` | vacío, 8000, 0.0.0.0 | Los usa Docker al crear los contenedores. |
| `EMBEDDING_MODEL` | `intfloat/multilingual-e5-base` | Cambiarlo obliga a reprocesar todos los documentos. Es multilingüe, gratis y corre en el servidor: los documentos nunca salen de él. |
| `CHUNK_SIZE_CHARS` / `CHUNK_OVERLAP_CHARS` | 1.200 / 200 | Tamaño de los fragmentos y solapamiento entre ellos. Más grande da más contexto por fragmento pero búsquedas menos precisas; el solapamiento evita cortar una idea a la mitad. Cambiarlos obliga a reprocesar. |
| `MAX_UPLOAD_MB` | 50 | Tamaño máximo por archivo; también lo limita el proxy (Cloudflare corta a 100 MB). |
| `BACKUP_ENCRYPTION_PASSPHRASE` | generada | No vive en la base (viajaría dentro de la copia que cifra): la genera el primer arranque en `./data/secretos/backup_passphrase` (se ve en *Sistema → Copias → Ver frase*). **Guárdala aparte**: sin ella las copias externas y las de B2 no se pueden abrir. |
| `BACKUP_TARGETS_DIR` | vacía | Carpeta del servidor con los discos permitidos para la copia externa; Docker la monta al arrancar. |
| Recursos (`*_CPUS`, `*_MEM_LIMIT`) | sin límite | Los calcula `deploy/autotune.sh` según el hardware ([operacion.md](operacion.md)). |
