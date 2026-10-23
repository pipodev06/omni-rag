# Pendientes y mejoras

Lista de mejoras posibles, revisada contra el código el 23/10/2026. La numeración es la de la lista original (1-47) para no perder referencias. **Esfuerzo:** bajo (menos de una hora), medio (unas horas), alto (días o con decisiones previas). **Tipo:** *Hacer* es implementación directa, *Investigar* necesita decidir o estudiar antes, *Verificar* es comprobar algo ya hecho, *Tú* es una acción que no puede hacer el código.

Lo que se termina se tacha y pasa a «Hecho» al final.

## Abiertos

### A. Documentos
| # | Qué | Esfuerzo | Tipo |
|---|---|---|---|
| 4 | Subir una carpeta o un ZIP (hoy se arrastran archivos sueltos) | medio | Hacer |
| 5 | Descargar varios documentos en un ZIP | bajo-medio | Hacer |
| 6 | Reemplazar un archivo conservando título y colección (nueva versión) | medio | Hacer |
| 7 | Copiar un documento a otra colección sin quitarlo de la original (duplica fragmentos) | medio | Investigar |
| 8 | Paginación en el servidor si una colección supera los 1000 documentos (hoy es el tope) | medio | Investigar |
| 9 | Etiquetas o metadatos por documento para filtrar | medio | Investigar |

### B. Chat y calidad
| # | Qué | Esfuerzo | Tipo |
|---|---|---|---|
| 11 | Exportar una conversación (Markdown o PDF) con sus fuentes | bajo-medio | Hacer |
| 12 | Conjunto de preguntas de prueba por organización, para medir si la calidad baja al cambiar de modelo o de documentos | alto | Investigar |
| 14 | Modelo distinto por colección (uno más potente para contratos, por ejemplo) | medio | Investigar |
| 15 | Retención configurable de conversaciones (borrarlas pasados N días) | bajo-medio | Hacer |

### C. Planes, costos y negocio
| # | Qué | Esfuerzo | Tipo |
|---|---|---|---|
| 17 | Costo estimado por organización (tokens por precio del modelo) para facturar. En reposo: de momento no se considera | medio | Hacer |
| 19 | Clave de API propia por organización, cifrada, que prevalezca sobre la global | medio | Hacer |
| 20 | Botón «organización principal» para el superadministrador (hoy basta el selector de Organizaciones; opcional) | bajo | Hacer |
| 21 | Cobro automático de planes (Stripe u otro) | alto | Investigar |
| 22 | Alta de organizaciones por autoservicio (hoy solo las crea el superadministrador) | alto | Investigar |
| 23 | Marcar tu organización como «Plataforma», excluida de conteos de uso y facturación | bajo | Hacer |

### D. Integraciones y acceso
| # | Qué | Esfuerzo | Tipo |
|---|---|---|---|
| 24 | Claves de API por organización para integrar otras aplicaciones (hoy la API solo se usa con la sesión del navegador) | medio | Hacer |
| 25 | Inicio de sesión con Google o Microsoft (SSO) | alto | Investigar |
| 26 | Webhooks (aviso a un sistema externo al terminar de procesar un documento) | medio | Investigar |
| 27 | Interfaz en varios idiomas (hoy solo español) | alto | Investigar |

### E. Seguridad
| # | Qué | Esfuerzo | Tipo |
|---|---|---|---|
| 31 | Pruebas con documentos maliciosos contra la inyección de instrucciones (hoy solo se neutralizan los delimitadores del prompt) | medio | Investigar |
| 32 | Rotar la contraseña de la base de datos de forma automatizada. Ya hay un script que la sincroniza (`deploy/sync-db-password.sh`), pero cambiarla sigue siendo un procedimiento manual | bajo | Hacer |
| 33 | Exportar todos los datos de un cliente (portabilidad). El borrado completo de una organización ya existe | medio | Investigar |

### F. Calidad y operación
| # | Qué | Esfuerzo | Tipo |
|---|---|---|---|
| 35 | Pruebas de extremo a extremo (Playwright): login, subir, preguntar, borrar. Hoy ninguna recorre la interfaz | alto | Hacer |
| 37 | Prueba de carga (cuántos usuarios y documentos aguanta el servidor) | medio | Investigar |

### H. Acciones tuyas (las de después de producción están en [pendientes_post_produccion.md](pendientes_post_produccion.md))
| # | Qué | Tipo |
|---|---|---|
| 45 | Cargar saldo en OpenRouter si vas a depender de él (SMTP ya está hecho) | Tú |
| 46 | Revisar los PR de Dependabot cuando vuelva a abrirlos (se borraron sus ramas el 23/10) | Tú |

### Surgidas después de la lista
| Qué | Esfuerzo | Tipo |
|---|---|---|
| `max_tokens` por plan, en vez del valor global `LLM_MAX_TOKENS` (solo útil si se quiere diferenciar planes por largo de respuesta) | bajo | Hacer |
| Claude directo (Anthropic): hoy solo vía OpenRouter; requiere un adaptador propio | medio | Hacer |
| Filtrar el razonamiento (`<thought>`) de los modelos Gemma de Google, si algún día se usan | bajo | Hacer |
| El aviso de cuota dice «se renueva a las 00:00 UTC»: mostrar la hora local del usuario (en Perú son las 19:00) | bajo | Hacer |

## Hecho

- ~~1 Mover documentos en lote~~ (`POST /documents/move`, barra de selección)
- ~~2 Reprocesar en lote~~ (`POST /documents/reprocess`)
- ~~3 Ordenar y filtrar la tabla de documentos~~ (`lib/documentView.ts`)
- ~~10 Renombrar y buscar conversaciones~~
- ~~13 Cuota por usuario~~ (límite por usuario en el plan)
- ~~16 Aviso por correo al 80 % del límite diario~~
- ~~18 Validar el nombre del modelo contra el catálogo al guardar un plan~~ (OpenRouter, Groq, Google…)
- ~~28 Antivirus ClamAV~~ (opcional, perfil `antivirus`)
- ~~34 Sesiones activas visibles~~ (Mi cuenta: dispositivos, IP, última actividad y «Cerrar» por sesión)
- ~~39 Pantallas sin ver en el navegador~~ (revisadas el 23/10: tarjeta del 2FA con QR, paso del código en el login con error y acierto, Renombrar, Mover y el desplegable debajo del selector, Sesiones y Papelera)
- ~~40 Barra lateral con 2FA obligatorio~~ (sin errores visibles; se corrigió que los avisos en vivo se intentaban conectar y recibían 403)
- ~~41 Despliegue real con dominio~~ (en producción con túnel de Cloudflare)
- ~~42 Banner de cuota~~ (se ve bien al 80 % y al agotarse el límite)
- ~~43 Copia fuera del servidor~~ (cifrada, a Backblaze B2)
- ~~47 Subir los commits pendientes~~
- ~~29 2FA obligatorio para administradores~~ (ajuste opcional `REQUIRE_ADMIN_2FA`, desactivado por defecto: a nadie se le obliga salvo al superadministrador con dominio real)
- ~~30 Límite global por IP para peticiones sin sesión~~ (`IP_RATE_LIMIT_PER_MIN`, 120 por minuto por IP; quien tiene sesión no cuenta)
- ~~36 Monitorización y alertas~~ (el worker revisa cada 5 minutos disco, cola, copias de seguridad y errores del modelo; avisa por correo con `ALERT_EMAIL`)
- ~~38 Registros estructurados~~ (JSON con `requestId` en cada línea y cabecera `X-Request-Id`)

También se hicieron, sin estar en la lista: capa de proveedores de LLM (OpenRouter, Groq, Google, OpenAI, DeepSeek, servidor propio), planes por organización, inicio de sesión con usuario o correo, 2FA opcional (TOTP), papelera de documentos, copias de seguridad a hora fija e incrementales de los archivos, script para probar el SMTP (`test-email.js`), script para listar y probar modelos (`models.js`) y renombrar el proyecto a Omni RAG.
