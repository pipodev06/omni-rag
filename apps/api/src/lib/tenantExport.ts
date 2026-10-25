import { sqlOwner } from "../db/client.js";
import { readStoredFile } from "../storage/local.js";
import { uniqueZipName, type ZipEntry } from "./zipStream.js";

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const README = (name: string, slug: string, date: string) => `Exportación de datos de «${name}» (${slug})
Generada el ${date} por el administrador de la plataforma.

Contenido:
  organizacion.json      datos de la organización y su plan
  usuarios.json          usuarios (sin contraseñas ni secretos del 2FA)
  colecciones.json       colecciones y quién tiene acceso a cada una
  documentos.json        metadatos de los documentos (incluidos los que están en la papelera, marcados con "enPapelera")
  conversaciones.json    conversaciones del chat con sus mensajes y las fuentes citadas
  valoraciones.json      valoraciones (👍/👎) y comentarios de los usuarios
  uso.json               preguntas y resúmenes por día y por modelo (tokens)
  auditoria.json         registro de auditoría de la organización
  archivos/              los documentos originales, en una carpeta por colección

No incluye: contraseñas, secretos de la verificación en dos pasos, sesiones ni enlaces de acceso.
`;

/**
 * Todo lo de una organización en un ZIP (portabilidad): datos en JSON y los documentos originales. Los archivos se leen
 * uno a uno al enviarse (generador asíncrono), así que una organización con muchos GB no se carga entera en memoria.
 * Nunca incluye secretos: ni hashes de contraseñas ni secretos o códigos del 2FA, ni sesiones o enlaces.
 */
export async function* tenantExportEntries(tenantId: string): AsyncGenerator<ZipEntry> {
  const [tenant] = await sqlOwner<{ name: string; slug: string }[]>`SELECT name, slug FROM tenants WHERE id = ${tenantId}`;
  if (!tenant) return;
  const date = new Date().toISOString();
  yield { name: "LEEME.txt", data: async () => README(tenant.name, tenant.slug, date.slice(0, 10)), compress: true };

  yield {
    name: "organizacion.json",
    compress: true,
    data: async () => {
      const [org] = await sqlOwner`
        SELECT t.name, t.slug, t.is_active AS "activa", t.created_at AS "creada", t.daily_question_limit AS "limiteDiarioPropio",
               p.name AS "plan", p.llm_models AS "modelos", p.daily_question_limit AS "limiteDiarioDelPlan",
               p.user_daily_question_limit AS "limitePorUsuario", p.max_users AS "maxUsuarios", p.max_documents AS "maxDocumentos"
          FROM tenants t JOIN plans p ON p.id = coalesce(t.plan_id, (SELECT id FROM plans WHERE is_default))
         WHERE t.id = ${tenantId}`;
      return json({ ...org, exportada: date });
    },
  };

  yield {
    name: "usuarios.json",
    compress: true,
    data: async () =>
      json(
        await sqlOwner`
          SELECT id, username AS "usuario", email, name AS "nombre", role AS "rol", is_active AS "activo",
                 (totp_enabled_at IS NOT NULL) AS "verificacionEnDosPasos", last_login_at AS "ultimoAcceso", created_at AS "creado"
            FROM users WHERE tenant_id = ${tenantId} AND support_for IS NULL ORDER BY created_at`,
      ),
  };

  yield {
    name: "colecciones.json",
    compress: true,
    data: async () =>
      json(
        await sqlOwner`
          SELECT col.id, col.name AS "nombre", col.description AS "descripcion", col.created_at AS "creada",
                 coalesce((SELECT json_agg(u.username ORDER BY u.username) FROM collection_members m JOIN users u ON u.id = m.user_id
                            WHERE m.collection_id = col.id), '[]') AS "miembros"
            FROM collections col WHERE col.tenant_id = ${tenantId} ORDER BY col.name`,
      ),
  };

  const documents = await sqlOwner<{ id: string; collection: string; filename: string; storage_key: string; trashed: boolean }[]>`
    SELECT d.id, col.name AS collection, d.filename, d.storage_key, d.deleted_at IS NOT NULL AS trashed
      FROM documents d JOIN collections col ON col.id = d.collection_id
     WHERE d.tenant_id = ${tenantId} ORDER BY col.name, d.filename`;
  const used = new Set<string>();
  const paths = new Map(documents.map((d) => [d.id, uniqueZipName(used, ["archivos", `${d.collection}${d.trashed ? " (papelera)" : ""}`], d.filename)]));

  yield {
    name: "documentos.json",
    compress: true,
    data: async () => {
      const rows = await sqlOwner<Record<string, unknown>[]>`
        SELECT d.id, col.name AS "coleccion", d.title AS "titulo", d.filename AS "archivoOriginal", d.mime_type AS "tipo",
               d.size_bytes::float8 AS "bytes", d.sha256, d.status AS "estado", d.page_count AS "paginas", d.chunk_count AS "fragmentos",
               d.summary AS "resumen", d.suggested_questions AS "preguntasSugeridas", u.username AS "subidoPor", d.created_at AS "subido",
               d.deleted_at IS NOT NULL AS "enPapelera", d.deleted_at AS "borrado"
          FROM documents d JOIN collections col ON col.id = d.collection_id LEFT JOIN users u ON u.id = d.created_by
         WHERE d.tenant_id = ${tenantId} ORDER BY col.name, d.filename`;
      return json(rows.map((r) => ({ ...r, archivoEnEsteZip: paths.get(r.id as string) })));
    },
  };

  yield {
    name: "conversaciones.json",
    compress: true,
    data: async () =>
      json(
        await sqlOwner`
          SELECT c.id, u.username AS "usuario", c.title AS "titulo", c.created_at AS "creada",
                 coalesce((SELECT json_agg(json_build_object('rol', m.role, 'texto', m.content, 'fuentes', m.sources, 'modelo', m.model,
                                                             'fecha', m.created_at) ORDER BY m.created_at)
                             FROM messages m WHERE m.conversation_id = c.id), '[]') AS "mensajes"
            FROM conversations c JOIN users u ON u.id = c.user_id
           WHERE c.tenant_id = ${tenantId} ORDER BY c.created_at`,
      ),
  };

  yield {
    name: "valoraciones.json",
    compress: true,
    data: async () =>
      json(
        await sqlOwner`
          SELECT u.username AS "usuario", f.rating AS "valoracion", f.comment AS "comentario", f.question AS "pregunta",
                 f.answer AS "respuesta", f.model AS "modelo", f.resolved AS "revisada", f.created_at AS "fecha"
            FROM message_feedback f LEFT JOIN users u ON u.id = f.user_id
           WHERE f.tenant_id = ${tenantId} ORDER BY f.created_at`,
      ),
  };

  yield {
    name: "uso.json",
    compress: true,
    data: async () =>
      json(
        await sqlOwner`
          SELECT (created_at AT TIME ZONE 'UTC')::date AS "dia", kind AS "tipo", model AS "modelo", count(*)::int AS "llamadas",
                 coalesce(sum(prompt_tokens), 0)::int AS "tokensEntrada", coalesce(sum(completion_tokens), 0)::int AS "tokensSalida"
            FROM usage_events WHERE tenant_id = ${tenantId} GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
      ),
  };

  yield {
    name: "auditoria.json",
    compress: true,
    data: async () =>
      json(
        await sqlOwner`
          SELECT created_at AS "fecha", user_email AS "usuario", action AS "accion", target_type AS "tipoObjeto", target_id AS "objeto",
                 details AS "detalles", ip
            FROM audit_log WHERE tenant_id = ${tenantId} ORDER BY created_at`,
      ),
  };

  for (const d of documents) {
    yield { name: paths.get(d.id)!, data: () => readStoredFile(d.storage_key) };
  }
}
