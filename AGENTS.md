# Omni RAG

Plataforma RAG multiusuario (API Hono + worker + frontend React/Vite). Detalle técnico en `docs/`.

## Criterios de interfaz (congelados)

Cambiarlos solo si el usuario lo pide de forma explícita.

- **Nombre:** «Omni RAG» (marca visible: logotipo, título de la pestaña, correos vía `APP_NAME`, documentación). Los identificadores internos conservan «rag» a propósito (proyecto de Docker `rag` y sus volúmenes, base y roles `rag*`, paquetes `@rag/*`, emisor de las sesiones): cambiarlos rompería datos o sesiones. La sal del cifrado del 2FA es `rag`; cambiarla dejaría inservibles los secretos ya guardados. El repositorio de GitHub se llama `Omni-RAG`.
- **Stack de UI:** shadcn/ui + Tailwind CSS + iconos Lucide. Componentes base en `apps/web/src/components/ui/`.
- **Ancho de página:** `Page` (`components/common.tsx`) ocupa todo el ancho disponible; no hay `max-w` global. Solo `Cuenta` se limita a `max-w-3xl`.
- **Lista de documentos:** las columnas ordenan al pulsarlas, hay filtros por estado y tipo (`lib/documentView.ts`, todo en el navegador) y las acciones en lote (mover, reprocesar, borrar) salen de la barra de selección, con los botones a la derecha. El botón destructivo es rojo sólido (`red-600`) en ambos temas.
- **Tablas:** una sola pieza compartida, `TableCard` (`components/common.tsx`). Alto dinámico: la tabla ocupa el alto libre de la pantalla, hace scroll interno con la cabecera fija y la página no scrollea. Se usa dentro de `<Page fill>`. No reimplementar el borde/scroll inline.
- **Scroll y paginación:** el scroll interno sirve hasta cientos de filas (la API limita a 1000). Más allá hay que paginar en el servidor.
- **Paginación:** Auditoría usa «Cargar más» (50 por carga, debajo de la tabla). Documentos no pagina: la API devuelve hasta 1000 por colección y la tabla hace scroll.
- **Banner de soporte:** franja delgada (texto pequeño) arriba; no se quita porque indica en qué organización estás y permite volver.
- **Cabecera de página:** `PageHeader` muestra solo el título y las acciones. La explicación de la página va en `description`, que se ve en un modal al pulsar el icono (i) junto al título. Texto formal, sin párrafos bajo el título.
- **Desplegables (`Select`):** se abren **debajo** del selector (`position="popper"`, el valor por defecto de `ui/select.tsx`); nunca encima, porque tapan el título de la página.
- **Tema claro/oscuro:** se aplica antes del primer pintado con `apps/web/public/theme-init.js` (archivo aparte: la CSP no permite scripts en línea). Su lógica debe ser la misma que la de `src/lib/theme.tsx`; si una cambia, cambia la otra.
- **Cargas de datos:** el componente `Skeleton` es gris neutro (`bg-muted`, nunca `accent`, que en esta paleta es índigo) y no se ve hasta pasados 250 ms, para que las cargas rápidas no parpadeen. Al cambiar un filtro de una lista, `keepPreviousData` mantiene la tabla anterior atenuada en vez de sustituirla por esqueletos.
- **Números centrados** en la tabla de Organizaciones: Usuarios, Documentos y Límite diario.
- **Límite diario:** se muestra siempre el valor efectivo (`200 / día` o `Sin límite`), nunca «Global». Sale de la excepción de la organización o, si no hay, de su plan (`planDailyQuestionLimit`).
- **Antivirus:** ClamAV opcional (perfil `antivirus`, `CLAMAV_HOST`); escanea en la subida y falla cerrado. Los tests usan un clamd falso; el archivo EICAR de pruebas nunca se escribe en disco ni en el repositorio.
- **Borrar organización:** solo desactivada y escribiendo su identificador; borra todo (incluidos archivos). Las copias de seguridad la conservan hasta caducar.
- **Aviso de cuota:** `QuotaBanner` en el chat avisa a todos los usuarios al llegar al 80 % del límite diario (`QUOTA_WARN_PERCENT`) y al agotarlo. Con SMTP, además, un correo a los administradores de la organización una vez al día en cada nivel (80 % y agotado).
- **Proveedores de LLM:** configurables (OpenRouter por defecto, Groq, Google, OpenAI, DeepSeek, servidor propio). Cada modelo de un plan puede llevar el prefijo `proveedor:`; sin prefijo es OpenRouter. El respaldo cruza proveedores. Añadir uno compatible con OpenAI = una línea en `lib/llmProviders.ts`.
- **Planes:** pestaña «Planes» dentro de Organizaciones. Una sola clave de OpenRouter (la del dueño); el plan fija modelos, preguntas por día (y, opcional, por usuario) y topes de usuarios y documentos. Los admins ven su uso en Consumo.
- **Superadministrador:** al iniciar sesión aterriza en Organizaciones (selector); desde ahí «Entrar como soporte». El banner de soporte tiene «Volver a mi organización».

## Acceso

- Se inicia sesión con **usuario o correo** y contraseña. El `username` es único en toda la plataforma. El email es opcional.
- **Verificación en dos pasos (TOTP):** opcional por usuario, recomendada para el superadministrador. Se configura en Mi cuenta; funciona en local sin dominio. Un administrador puede quitarla a un usuario normal; la del superadmin solo se quita en la base de datos.
- **Sesiones:** se revocan al cambiar o restablecer la contraseña, al quitar el 2FA y con «Cerrar todas las sesiones» (`users.sessions_valid_after`). Con un dominio real el superadmin debe tener 2FA; en local no se exige (`REQUIRE_SUPERADMIN_2FA`: auto/true/false).
- **Contraseña del superadmin perdida:** `docker compose exec api node dist/scripts/reset-password.js <usuario> [--generar] [--quitar-2fa]` (solo desde el servidor).
- Sin email no hay invitaciones ni recuperación por correo: el administrador define o restablece la contraseña.
