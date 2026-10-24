# Pendientes

Lo que está en curso o decidido. Lo que se termina se tacha y baja a «Hecho». Las ideas que pueden o no agregarse están en [posibles_mejoras.md](posibles_mejoras.md). La numeración es la de la lista original (1-47).

## Abiertos

| # | Qué | Tipo |
|---|---|---|
| 46 | Revisar los PR de Dependabot cuando vuelva a abrirlos (se borraron sus ramas el 23/10) | Tú |
| 48 | **Búsqueda en internet (modo híbrido: documentos + web).** Diseño recomendado: buscador propio (Tavily, Brave Search API o SearXNG) en vez de la búsqueda de cada proveedor, para que funcione igual con cualquier modelo; **desactivado por defecto**, con un interruptor «Buscar también en internet» en el chat y un permiso por plan; fuentes siempre diferenciadas («Documento» frente a «Web», con enlace). Cuidados: enviar solo la pregunta (nunca fragmentos de los documentos) y avisarlo; tratar el texto de las páginas como no confiable (inyección de instrucciones); que la respuesta diga cuándo la web contradice a los documentos; cupo y costo del servicio de búsqueda | Hacer |

## Hecho

- ~~1 Mover documentos en lote~~ (`POST /documents/move`, barra de selección)
- ~~2 Reprocesar en lote~~ (`POST /documents/reprocess`)
- ~~3 Ordenar y filtrar la tabla de documentos~~ (`lib/documentView.ts`)
- ~~10 Renombrar y buscar conversaciones~~ (el renombrado, ahora con un modal compartido)
- ~~11 Exportar una conversación~~ (menú «⋮» del historial → Exportar (Markdown); `GET /conversations/:id/export`, con las fuentes citadas)
- ~~13 Cuota por usuario~~ (límite por usuario en el plan)
- ~~16 Aviso por correo al 80 % del límite diario~~
- ~~18 Validar el nombre del modelo contra el catálogo al guardar un plan~~ (OpenRouter, Groq, Google…)
- ~~28 Antivirus ClamAV~~ (opcional, perfil `antivirus`)
- ~~29 2FA obligatorio para administradores~~ (ajuste opcional `REQUIRE_ADMIN_2FA`, desactivado por defecto: a nadie se le obliga salvo al superadministrador con dominio real)
- ~~30 Límite global por IP para peticiones sin sesión~~ (`IP_RATE_LIMIT_PER_MIN`, 120 por minuto por IP; quien tiene sesión no cuenta)
- ~~31 Pruebas con documentos maliciosos~~ (`apps/api/test/injection.test.ts`; neutralización de etiquetas en todas sus variantes, marcas de plantillas, cabeceras falsas y caracteres invisibles; en pantalla, sin imágenes remotas y con el dominio de cada enlace)
- ~~32 Rotación automática de la contraseña de la base de datos~~ (`sh deploy/rotate-db-password.sh`, con respaldo del `.env` y reversión si falla)
- ~~34 Sesiones activas visibles~~ (Mi cuenta: dispositivos, IP, última actividad y «Cerrar» por sesión)
- ~~36 Monitorización y alertas~~ (el worker revisa cada 5 minutos disco, cola, copias de seguridad y errores del modelo; avisa por correo con `ALERT_EMAIL`)
- ~~38 Registros estructurados~~ (JSON con `requestId` en cada línea y cabecera `X-Request-Id`)
- ~~37 Prueba de carga~~ (`deploy/loadtest.mjs`; mediciones y conclusiones en docs/operacion.md → «Prueba de carga»)
- ~~Optimización de frontend y backend~~ (Markdown perezoso: paquete principal -30 % comprimido; archivos precomprimidos con `gzip_static`: -70 % de bytes y ~50 % más peticiones por segundo; re-ranking en fila: sin pérdidas de re-ranking con carga; modal para renombrar conversaciones)
- ~~39 Pantallas sin ver en el navegador~~ (revisadas el 23/10)
- ~~40 Barra lateral con 2FA obligatorio~~ (se corrigió que los avisos en vivo recibían 403)
- ~~41 Despliegue real con dominio~~ (en producción con túnel de Cloudflare)
- ~~42 Banner de cuota~~ (se ve bien al 80 % y al agotarse el límite)
- ~~23 Organización «Plataforma»~~ (el superadmin vive en una organización interna, excluida de totales y facturación; todas las organizaciones de clientes se pueden borrar; `move-superadmin.js` para instalaciones anteriores)
- ~~43 Copia fuera del servidor~~ (cifrada, a Backblaze B2)
- ~~47 Subir los commits pendientes~~

También se hicieron, sin estar en la lista: capa de proveedores de LLM (OpenRouter, Groq, Google, OpenAI, DeepSeek, servidor propio), planes por organización, inicio de sesión con usuario o correo, 2FA opcional (TOTP), papelera de documentos, copias de seguridad a hora fija e incrementales de los archivos, script para probar el SMTP (`test-email.js`), script para listar y probar modelos (`models.js`) y renombrar el proyecto a Omni RAG.
