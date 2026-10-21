/**
 * Prueba de integración de Row Level Security contra PostgreSQL real.
 * Se ejecuta solo si hay base de datos de prueba:
 *   RUN_DB_TESTS=1 DATABASE_URL=... APP_DATABASE_URL=... APP_DB_PASSWORD=... pnpm test
 * (ver docs/desarrollo.md). Simula "bugs" en el código: consultas sin filtro
 * de organización, inserciones en colecciones ajenas, etc.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "./env.js";

const enabled = process.env.RUN_DB_TESTS === "1";

describe.skipIf(!enabled)("Row Level Security", async () => {
  const { migrate } = await import("../src/db/migrate.js");
  const { sqlOwner, withTenant, closeDb, toPgVector } = await import("../src/db/client.js");
  const { config } = await import("../src/config.js");
  const tag = Date.now().toString(36);
  const ids: Record<string, string> = {};
  const vec = toPgVector(Array.from({ length: config.EMBEDDING_DIM }, (_, i) => (i === 0 ? 1 : 0)));

  beforeAll(async () => {
    await migrate();
    for (const t of ["a", "b"]) {
      const [tenant] = await sqlOwner`INSERT INTO tenants (name, slug) VALUES (${t}, ${`rls-${t}-${tag}`}) RETURNING id`;
      ids[`tenant_${t}`] = tenant!.id;
      for (const role of ["admin", "viewer"]) {
        const [u] = await sqlOwner`
          INSERT INTO users (tenant_id, email, name, password_hash, role)
          VALUES (${tenant!.id}, ${`${role}-${t}-${tag}@rls.test`}, ${role}, 'x', ${role}) RETURNING id`;
        ids[`${role}_${t}`] = u!.id;
      }
      const [col] = await sqlOwner`INSERT INTO collections (tenant_id, name) VALUES (${tenant!.id}, 'c') RETURNING id`;
      ids[`col_${t}`] = col!.id;
      const [doc] = await sqlOwner`
        INSERT INTO documents (tenant_id, collection_id, title, filename, mime_type, size_bytes, sha256, storage_key, status)
        VALUES (${tenant!.id}, ${col!.id}, ${`doc ${t}`}, 'f.txt', 'text/plain', 1, ${`sha-${t}-${tag}`}, 'k', 'ready')
        RETURNING id`;
      ids[`doc_${t}`] = doc!.id;
      await sqlOwner`
        INSERT INTO chunks (tenant_id, collection_id, document_id, chunk_index, content, embedding)
        VALUES (${tenant!.id}, ${col!.id}, ${doc!.id}, 0, ${`secreto ${t}`}, ${vec}::vector)`;
    }
  });

  afterAll(async () => {
    await sqlOwner`DELETE FROM tenants WHERE slug LIKE ${`rls-%-${tag}`}`;
    await closeDb();
  });

  const as = (t: "a" | "b", role: "admin" | "viewer") => ({
    tenantId: ids[`tenant_${t}`]!,
    userId: ids[`${role}_${t}`]!,
    role,
  });

  it("una consulta SIN filtro solo devuelve datos de la propia organización", async () => {
    const rows = await withTenant(as("a", "admin"), (tx) => tx`SELECT content FROM chunks WHERE content LIKE 'secreto%'`);
    expect(rows.map((r) => r.content)).toEqual(["secreto a"]);
    const tenants = await withTenant(as("a", "admin"), (tx) => tx`SELECT id FROM tenants`);
    expect(tenants.map((r) => r.id)).toEqual([ids.tenant_a]);
  });

  it("un lector sin membresía no ve la colección; con membresía sí", async () => {
    const before = await withTenant(as("a", "viewer"), (tx) => tx`SELECT id FROM documents`);
    expect(before).toHaveLength(0);
    await sqlOwner`INSERT INTO collection_members (tenant_id, collection_id, user_id) VALUES (${ids.tenant_a!}, ${ids.col_a!}, ${ids.viewer_a!})`;
    const after = await withTenant(as("a", "viewer"), (tx) => tx`SELECT id FROM documents`);
    expect(after.map((r) => r.id)).toEqual([ids.doc_a]);
  });

  it("un lector no puede borrar documentos aunque tenga acceso", async () => {
    const deleted = await withTenant(as("a", "viewer"), (tx) => tx`DELETE FROM documents RETURNING id`);
    expect(deleted).toHaveLength(0);
  });

  it("no se puede insertar un documento en la colección de otra organización", async () => {
    await expect(
      withTenant(as("a", "admin"), (tx) => tx`
        INSERT INTO documents (tenant_id, collection_id, title, filename, mime_type, size_bytes, sha256, storage_key)
        VALUES (${ids.tenant_a!}, ${ids.col_b!}, 'x', 'x', 'x', 1, 'x', 'x')`),
    ).rejects.toThrow();
    await expect(
      withTenant(as("a", "admin"), (tx) => tx`
        INSERT INTO documents (tenant_id, collection_id, title, filename, mime_type, size_bytes, sha256, storage_key)
        VALUES (${ids.tenant_b!}, ${ids.col_b!}, 'x', 'x', 'x', 1, 'x2', 'x')`),
    ).rejects.toThrow(/row-level security/);
  });

  it("no se puede añadir un usuario de otra organización como miembro", async () => {
    await expect(
      withTenant(as("a", "admin"), (tx) => tx`
        INSERT INTO collection_members (tenant_id, collection_id, user_id) VALUES (${ids.tenant_a!}, ${ids.col_a!}, ${ids.viewer_b!})`),
    ).rejects.toThrow();
  });

  it("un admin no puede convertir a nadie en superadministrador", async () => {
    await expect(
      withTenant(as("a", "admin"), (tx) => tx`UPDATE users SET is_superadmin = true WHERE id = ${ids.viewer_a!}`),
    ).rejects.toThrow(/row-level security/);
  });

  it("la caché de respuestas está aislada por organización", async () => {
    await withTenant(as("b", "admin"), (tx) => tx`
      INSERT INTO answer_cache (tenant_id, scope_key, collection_ids, question, question_norm, embedding, answer, sources)
      VALUES (${ids.tenant_b!}, 'k', ${[ids.col_b!]}::uuid[], 'q', 'q', ${vec}::vector, 'respuesta secreta de b', '[]')`);
    const fromA = await withTenant(as("a", "admin"), (tx) => tx`SELECT answer FROM answer_cache`);
    expect(fromA).toHaveLength(0);
    await expect(
      withTenant(as("a", "admin"), (tx) => tx`
        INSERT INTO answer_cache (tenant_id, scope_key, collection_ids, question, question_norm, embedding, answer, sources)
        VALUES (${ids.tenant_b!}, 'k', '{}', 'q', 'q', ${vec}::vector, 'x', '[]')`),
    ).rejects.toThrow(/row-level security/);
  });

  it("las valoraciones: cada usuario solo sobre sus mensajes; el admin las lee", async () => {
    const [conv] = await sqlOwner`
      INSERT INTO conversations (tenant_id, user_id) VALUES (${ids.tenant_a!}, ${ids.admin_a!}) RETURNING id`;
    const [msg] = await sqlOwner`
      INSERT INTO messages (tenant_id, user_id, conversation_id, role, content)
      VALUES (${ids.tenant_a!}, ${ids.admin_a!}, ${conv!.id}, 'assistant', 'respuesta') RETURNING id`;
    // El lector no puede valorar un mensaje del admin.
    await expect(
      withTenant(as("a", "viewer"), (tx) => tx`
        INSERT INTO message_feedback (tenant_id, user_id, message_id, rating, question, answer)
        VALUES (${ids.tenant_a!}, ${ids.viewer_a!}, ${msg!.id}, -1, 'q', 'a')`),
    ).rejects.toThrow(/row-level security/);
    // Su dueño sí.
    await withTenant(as("a", "admin"), (tx) => tx`
      INSERT INTO message_feedback (tenant_id, user_id, message_id, rating, question, answer)
      VALUES (${ids.tenant_a!}, ${ids.admin_a!}, ${msg!.id}, 1, 'q', 'a')`);
    const viewerSees = await withTenant(as("a", "viewer"), (tx) => tx`SELECT id FROM message_feedback`);
    expect(viewerSees).toHaveLength(0);
    const otherTenant = await withTenant(as("b", "admin"), (tx) => tx`SELECT id FROM message_feedback`);
    expect(otherTenant).toHaveLength(0);
  });

  it("sin contexto de organización no se ve nada", async () => {
    const { sqlApp } = await import("../src/db/client.js");
    const rows = await sqlApp`SELECT id FROM chunks`;
    expect(rows).toHaveLength(0);
  });
});
