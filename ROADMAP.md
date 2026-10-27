# Hoja de ruta

Ideas que **pueden o no agregarse**: se hacen si el uso real o quien contribuye demuestra que hacen falta. ¿Quieres una? Abre un issue o un pull request (ver [CONTRIBUTING.md](CONTRIBUTING.md)).

## Documentos
- Reemplazar un archivo conservando título y colección (nueva versión).
- Copiar un documento a otra colección sin quitarlo de la original.
- Paginación en el servidor si una colección supera los 1000 documentos (hoy es el tope).
- Etiquetas o metadatos por documento para filtrar.

## Chat y calidad
- Conjunto de preguntas de prueba por organización, para medir si la calidad baja al cambiar de modelo o de documentos.
- Modelo distinto por colección (uno más potente para contratos, por ejemplo).
- Retención configurable de conversaciones (borrarlas pasados N días).
- `max_tokens` por plan, en vez del valor global `LLM_MAX_TOKENS`.
- Claude directo (Anthropic): hoy solo vía OpenRouter; requiere un adaptador propio en `lib/llmProviders.ts`.

## Planes y negocio
- Costo estimado por organización (tokens por precio del modelo).
- Clave de API propia por organización, cifrada, que prevalezca sobre la global.
- Cobro automático de planes.
- Alta de organizaciones por autoservicio (hoy solo las crea el superadministrador).

## Integraciones y acceso
- Claves de API por organización para integrar otras aplicaciones (hoy la API solo se usa con la sesión del navegador).
- Inicio de sesión con Google o Microsoft (SSO).
- Webhooks al terminar de procesar un documento.
- Interfaz en varios idiomas (hoy solo español).
