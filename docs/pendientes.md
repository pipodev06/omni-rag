# Pendientes

Lo que está en curso o decidido. Lo que se termina se tacha y baja a «Hecho». Las ideas que pueden o no agregarse están en [posibles_mejoras.md](posibles_mejoras.md). La numeración es la de la lista original (1-47).

## Abiertos

| # | Qué | Tipo |
|---|---|---|
| 37 | Prueba de carga: cuántos usuarios y documentos aguanta el servidor | Hacer |
| — | Optimización de frontend y backend y mejoras de experiencia de usuario, según lo medido en la prueba de carga | Hacer |
| 46 | Revisar los PR de Dependabot cuando vuelva a abrirlos (se borraron sus ramas el 23/10) | Tú |

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
- ~~39 Pantallas sin ver en el navegador~~ (revisadas el 23/10)
- ~~40 Barra lateral con 2FA obligatorio~~ (se corrigió que los avisos en vivo recibían 403)
- ~~41 Despliegue real con dominio~~ (en producción con túnel de Cloudflare)
- ~~42 Banner de cuota~~ (se ve bien al 80 % y al agotarse el límite)
- ~~43 Copia fuera del servidor~~ (cifrada, a Backblaze B2)
- ~~47 Subir los commits pendientes~~

También se hicieron, sin estar en la lista: capa de proveedores de LLM (OpenRouter, Groq, Google, OpenAI, DeepSeek, servidor propio), planes por organización, inicio de sesión con usuario o correo, 2FA opcional (TOTP), papelera de documentos, copias de seguridad a hora fija e incrementales de los archivos, script para probar el SMTP (`test-email.js`), script para listar y probar modelos (`models.js`) y renombrar el proyecto a Omni RAG.
