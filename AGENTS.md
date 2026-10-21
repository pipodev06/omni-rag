# RAG Project

Plataforma RAG multiusuario (API Hono + worker + frontend React/Vite). Detalle técnico en `docs/`.

## Criterios de interfaz (congelados)

Cambiarlos solo si el usuario lo pide de forma explícita.

- **Stack de UI:** shadcn/ui + Tailwind CSS + iconos Lucide. Componentes base en `apps/web/src/components/ui/`.
- **Ancho de página:** `Page` (`components/common.tsx`) ocupa todo el ancho disponible; no hay `max-w` global. Solo `Cuenta` se limita a `max-w-3xl`.
- **Tablas:** una sola pieza compartida, `TableCard` (`components/common.tsx`). Alto dinámico: la tabla ocupa el alto libre de la pantalla, hace scroll interno con la cabecera fija y la página no scrollea. Se usa dentro de `<Page fill>`. No reimplementar el borde/scroll inline.
- **Scroll y paginación:** el scroll interno sirve hasta cientos de filas (la API limita a 1000). Más allá hay que paginar en el servidor.
- **Paginación:** Auditoría usa «Cargar más» (50 por carga, debajo de la tabla). Documentos no pagina: la API devuelve hasta 1000 por colección y la tabla hace scroll.
- **Banner de soporte:** franja delgada (texto pequeño) arriba; no se quita porque indica en qué organización estás y permite volver.
- **Cabecera de página:** `PageHeader` muestra solo el título y las acciones. La explicación de la página va en `description`, que se ve en un modal al pulsar el icono (i) junto al título. Texto formal, sin párrafos bajo el título.
- **Números centrados** en la tabla de Organizaciones: Usuarios, Documentos y Límite diario.
- **Límite diario:** se muestra siempre el valor efectivo (`200 / día` o `Sin límite`), nunca «Global». Sale de la excepción de la organización o, si no hay, de su plan (`planDailyQuestionLimit`).
- **Borrar organización:** solo desactivada y escribiendo su identificador; borra todo (incluidos archivos). Las copias de seguridad la conservan hasta caducar.
- **Planes:** pestaña «Planes» dentro de Organizaciones. Una sola clave de OpenRouter (la del dueño); el plan fija modelos, preguntas por día y topes de usuarios y documentos. Los admins ven su uso en Consumo.
- **Superadministrador:** al iniciar sesión aterriza en Organizaciones (selector); desde ahí «Entrar como soporte». El banner de soporte tiene «Volver a mi organización».

## Acceso

- Se inicia sesión con **usuario o correo** y contraseña. El `username` es único en toda la plataforma. El email es opcional.
- **Verificación en dos pasos (TOTP):** opcional por usuario, recomendada para el superadministrador. Se configura en Mi cuenta; funciona en local sin dominio. Un administrador puede quitarla a un usuario normal; la del superadmin solo se quita en la base de datos.
- **Sesiones:** se revocan al cambiar o restablecer la contraseña, al quitar el 2FA y con «Cerrar todas las sesiones» (`users.sessions_valid_after`). Con un dominio real el superadmin debe tener 2FA; en local no se exige (`REQUIRE_SUPERADMIN_2FA`: auto/true/false).
- Sin email no hay invitaciones ni recuperación por correo: el administrador define o restablece la contraseña.
