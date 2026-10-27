# Política de seguridad

Omni RAG maneja documentos de varias organizaciones y credenciales de acceso, así que se toman en serio los fallos de seguridad.

## Cómo reportar una vulnerabilidad

**No abras un issue público.** Usa el aviso privado de GitHub: pestaña **Security → Report a vulnerability** de este repositorio. Incluye:

- qué se puede hacer (por ejemplo, leer documentos de otra organización),
- los pasos para reproducirlo,
- la versión o el commit en el que lo viste.

Se responde en unos días. Cuando haya corrección, se publica y se te menciona si lo deseas.

## Qué se considera vulnerabilidad

- Acceso a datos de otra organización o a documentos sin permiso (el aislamiento descansa en Row Level Security de PostgreSQL).
- Saltarse el inicio de sesión, el 2FA, los roles o la revocación de sesiones.
- Inyección (SQL, comandos, prompt que filtre datos de otros usuarios), XSS, CSRF o SSRF.
- Subida de archivos que ejecute código o evite el antivirus.
- Secretos expuestos en registros, respuestas o exportaciones.

## Versiones con soporte

Solo la última versión de la rama `main`.

## Si instalas Omni RAG

Sigue [docs/produccion.md](docs/produccion.md): cambia todas las contraseñas de `.env.example`, usa HTTPS con `WEB_BIND=127.0.0.1` y activa el 2FA del superadministrador.
