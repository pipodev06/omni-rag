# Permisos y aislamiento entre clientes

## Conceptos

| Concepto | Qué es |
|---|---|
| **Organización** (*tenant*) | Un cliente. Sus usuarios, colecciones, documentos y conversaciones están completamente separados de los de otras organizaciones. |
| **Colección** | Carpeta de documentos dentro de una organización. Sirve para dar acceso a grupos de documentos. |
| **Superadministrador** | El dueño de la plataforma (tú). Crea organizaciones y puede desactivarlas. Se crea al primer arranque con `SEED_ADMIN_EMAIL`. |

## Roles dentro de una organización

| Acción | Lector (`viewer`) | Editor (`editor`) | Administrador (`admin`) |
|---|:-:|:-:|:-:|
| Preguntar en el chat | ✅ sus colecciones | ✅ sus colecciones | ✅ todas |
| Ver y descargar documentos | ✅ sus colecciones | ✅ sus colecciones | ✅ todas |
| Subir, reprocesar y borrar documentos | ❌ | ✅ sus colecciones | ✅ todas |
| Crear, renombrar y borrar colecciones | ❌ | ❌ | ✅ |
| Dar acceso a colecciones | ❌ | ❌ | ✅ |
| Crear usuarios, cambiar roles, desactivar | ❌ | ❌ | ✅ |
| Ver consumo de la organización | ❌ | ❌ | ✅ |
| Ver conversaciones de otros usuarios | ❌ | ❌ | ❌ (son privadas) |
| Ver valoraciones 👍/👎 (página Calidad) | solo las suyas | solo las suyas | ✅ todas |

"Sus colecciones" = las colecciones de las que el usuario es miembro (*Documentos → Gestionar acceso*).

## Cómo se garantiza: dos capas

### Capa 1 — El código de la API

Cada ruta exige sesión (`requireAuth`) y, si corresponde, un rol (`requireRole("admin")`). Así se obtienen errores claros (`403 No tienes permiso…`).

### Capa 2 — La base de datos (Row Level Security)

Aunque el código tuviera un error (por ejemplo, una consulta sin `WHERE tenant_id = …`), **PostgreSQL no devolvería ni modificaría filas de otra organización**.

1. La API usa dos usuarios de base de datos:
   - `rag_owner` (dueño de las tablas): solo para login, migraciones y crear organizaciones.
   - `rag_app`: **todo lo demás**. Está sujeto a RLS y no puede saltárselo (`NOBYPASSRLS`).
2. Toda operación de datos pasa por `withTenant()` (`apps/api/src/db/client.ts`), que abre una transacción y fija:
   ```sql
   SELECT set_config('app.tenant_id', '<organización>', true),
          set_config('app.user_id',   '<usuario>',      true),
          set_config('app.role',      '<rol>',          true);
   ```
   (el `true` hace que valga solo para esa transacción).
3. Las políticas de `apps/api/src/db/migrations/001_init.sql` usan esos valores. Por ejemplo:
   ```sql
   CREATE POLICY chunks_read ON chunks FOR SELECT
     USING (tenant_id = app_tenant_id() AND app_can_access_collection(collection_id));
   ```
   `app_can_access_collection()` comprueba que la colección es de la organización actual y que el usuario es admin o miembro.
4. **Claves foráneas compuestas** `(id, tenant_id)`: es imposible, incluso para el dueño de las tablas, crear un documento en una colección de otra organización o añadir como miembro a un usuario ajeno.
5. Sin contexto (`app.tenant_id` vacío) `rag_app` no ve **nada**.

### Por qué importa en un RAG

El filtro de permisos se aplica **dentro** de la búsqueda vectorial, no después. El LLM nunca recibe un fragmento que el usuario no pueda ver, así que no puede "filtrarlo" en una respuesta.

## Caché de respuestas y valoraciones

- **Caché:** una respuesta guardada solo se reutiliza para usuarios de la **misma organización** que consultan **exactamente el mismo conjunto de colecciones**. Un usuario con menos acceso tiene otro conjunto, así que nunca recibe una respuesta construida con documentos que no puede ver. Al cambiar un documento de una colección se borran las respuestas que dependían de ella.
- **Valoraciones:** las conversaciones son privadas, pero al marcar una respuesta con 👍 o 👎 se guarda una copia de la pregunta, la respuesta y las fuentes **visible para los administradores** de la organización (página Calidad). La interfaz lo avisa antes de enviar un 👎.

## Avisos en tiempo real y resúmenes

- Cada usuario solo recibe avisos de documentos de **su organización** y de **las colecciones a las que tiene acceso** (los administradores, de todas las de su organización).
- El resumen de un documento lo puede generar cualquiera que pueda verlo (lectores incluidos); la API comprueba el acceso con RLS antes de guardarlo.
- El filtro "preguntar sobre este documento" solo acepta documentos visibles para el usuario: un identificador ajeno se ignora y no devuelve nada.

## Cómo está probado

- `apps/api/test/rls.integration.test.ts` ataca directamente la base de datos simulando errores del código: consultas sin filtro, inserciones en colecciones ajenas, lectores intentando borrar, un admin intentando hacerse superadministrador, etc.
- `scripts/smoke-test.mjs` crea dos organizaciones reales, sube un secreto a una y comprueba por la API que la otra no lo encuentra.

## Límites conocidos

- RLS protege frente a **errores del código**. Si alguien pudiera ejecutar SQL arbitrario como `rag_app` (inyección SQL), podría cambiar `app.tenant_id`. Por eso todo el SQL usa parámetros (`postgres` con *tagged templates*) y nunca concatena texto del usuario.
- El superadministrador usa la conexión `rag_owner` solo en las rutas `/api/platform/*` y en el login.
- Los **administradores de una organización** ven todos sus documentos. Si un cliente necesita documentos que ni su administrador vea, crea otra organización.
