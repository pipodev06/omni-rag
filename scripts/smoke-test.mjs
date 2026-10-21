#!/usr/bin/env node
/**
 * Prueba de humo de punta a punta contra un sistema en marcha.
 *
 *   node scripts/smoke-test.mjs --url http://localhost:8000 \
 *        --email admin@example.com --password '...' --files a.pdf,b.docx
 *
 * Qué comprueba:
 *  1. Login del superadministrador.
 *  2. Crea dos organizaciones temporales (A y B) con su administrador.
 *  3. Sube los archivos a A y un archivo secreto a B; espera a que se indexen.
 *  4. Búsqueda en A: encuentra contenido de A y NUNCA el secreto de B.
 *  5. Un lector (viewer) de A sin acceso a la colección no ve documentos.
 *  6. Re-ranking activo (si el servicio está en marcha).
 *  7. Pregunta al chat (requiere OPENROUTER_API_KEY), caché de respuestas,
 *     respeto de permisos en la caché y valoraciones 👍/👎.
 * Las organizaciones de prueba quedan desactivadas al final.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const BASE = (args.url ?? "http://localhost:8000").replace(/\/$/, "");
const files = (args.files ?? "").split(",").filter(Boolean);
const question = args.question ?? "¿Cuál es el tiempo de respuesta para incidencias críticas?";
const skipChat = args["skip-chat"] === "true";
const stamp = Date.now().toString(36);

let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "✅" : "❌"} ${msg}`);
  if (!cond) failures++;
};

async function call(method, url, { token, json, form } = {}) {
  const res = await fetch(`${BASE}/api${url}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(json ? { "content-type": "application/json" } : {}) },
    body: json ? JSON.stringify(json) : form,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

const login = async (email, password) => {
  const r = await call("POST", "/auth/login", { json: { email, password } });
  if (r.status !== 200) throw new Error(`login ${email}: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data.token;
};

async function upload(token, collectionId, filePath, name) {
  const form = new FormData();
  form.append("collectionId", collectionId);
  form.append("file", new Blob([await readFile(filePath)]), name ?? path.basename(filePath));
  const r = await call("POST", "/documents", { token, form });
  if (r.status !== 201) throw new Error(`upload: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data.results[0];
}

async function waitReady(token, ids, timeoutMs = 600_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const { data } = await call("GET", "/documents", { token });
    const docs = data.documents.filter((d) => ids.includes(d.id));
    if (docs.every((d) => d.status === "ready" || d.status === "failed")) return docs;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("Tiempo de espera agotado indexando documentos");
}

const health = await call("GET", "/health");
console.log("Servicios:", JSON.stringify(health.data.services));

const root = await login(args.email, args.password);
ok(true, "login del superadministrador");

const pwd = `Prueba-${stamp}-segura`;
const mk = async (tag) => {
  const r = await call("POST", "/platform/tenants", {
    token: root,
    json: { name: `Smoke ${tag} ${stamp}`, slug: `smoke-${tag}-${stamp}`, admin: { email: `admin-${tag}-${stamp}@smoke.test`, name: `Admin ${tag}`, password: pwd } },
  });
  ok(r.status === 201, `crear organización ${tag}`);
  const token = await login(`admin-${tag}-${stamp}@smoke.test`, pwd);
  const cols = await call("GET", "/collections", { token });
  return { id: r.data.tenantId, token, collectionId: cols.data.collections[0].id };
};
const A = await mk("a");
const B = await mk("b");

const secretPath = path.join(process.env.TMPDIR ?? "/tmp", `secreto-${stamp}.txt`);
await (await import("node:fs/promises")).writeFile(secretPath, `Documento confidencial de B. Clave del almacén: ZETA-${stamp}.`);

const queuedA = [];
for (const f of files) queuedA.push((await upload(A.token, A.collectionId, f)).id);
const secret = await upload(B.token, B.collectionId, secretPath);
const docsA = await waitReady(A.token, queuedA);
await waitReady(B.token, [secret.id]);
for (const d of docsA) ok(d.status === "ready", `indexado ${d.filename}: ${d.status} (${d.chunkCount} trozos, ${d.pageCount ?? "-"} págs.) ${d.error ?? ""}`);

const dup = await upload(A.token, A.collectionId, files[0] ?? secretPath);
ok(!files[0] || dup.status === "duplicate", "detecta archivo duplicado");

const searchA = await call("POST", "/search", { token: A.token, json: { query: `clave del almacén ZETA-${stamp}` } });
ok(searchA.status === 200, "búsqueda en A responde");
ok(!JSON.stringify(searchA.data).includes(`ZETA-${stamp}`), "A NO ve el documento secreto de B (aislamiento entre organizaciones)");
const searchB = await call("POST", "/search", { token: B.token, json: { query: `clave del almacén ZETA-${stamp}` } });
ok(JSON.stringify(searchB.data).includes(`ZETA-${stamp}`), "B sí encuentra su propio documento");

if (files.length) {
  const s = await call("POST", "/search", { token: A.token, json: { query: question } });
  console.log("   Mejor resultado:", s.data.results?.[0]?.documentTitle, "→", s.data.results?.[0]?.content.slice(0, 120).replace(/\n/g, " "));
  ok((s.data.results?.length ?? 0) > 0, "búsqueda híbrida devuelve resultados en A");
}

// Lector sin acceso a ninguna colección
const viewer = await call("POST", "/users", { token: A.token, json: { email: `viewer-${stamp}@smoke.test`, name: "Lector", password: pwd, role: "viewer" } });
ok(viewer.status === 201, "admin de A crea un lector");
const vt = await login(`viewer-${stamp}@smoke.test`, pwd);
const vdocs = await call("GET", "/documents", { token: vt });
ok(vdocs.data.documents.length === 0, "lector sin colección asignada no ve documentos");
const vup = await call("POST", "/documents", { token: vt, form: new FormData() });
ok(vup.status === 403, "lector no puede subir documentos (403)");
await call("PUT", `/collections/${A.collectionId}/members`, { token: A.token, json: { userIds: [viewer.data.id] } });
const vdocs2 = await call("GET", "/documents", { token: vt });
ok(vdocs2.data.documents.length === docsA.length, "tras darle acceso, el lector ve los documentos de la colección");
const cross = await call("PUT", `/collections/${A.collectionId}/members`, { token: A.token, json: { userIds: [B.id] } });
ok(cross.status === 400, "no se puede añadir a una colección un id ajeno a la organización");

async function ask(token, q, extra = {}) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ question: q, ...extra }),
  });
  if (!res.ok) return { status: res.status, error: await res.text() };
  const raw = await res.text();
  const events = raw.split("\n\n").filter(Boolean).map((b) => ({
    event: /event: (.*)/.exec(b)?.[1],
    data: b.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n"),
  }));
  const answer = events.filter((e) => e.event === "token").map((e) => JSON.parse(e.data)).join("");
  const done = events.find((e) => e.event === "done");
  const error = events.find((e) => e.event === "error");
  return { status: 200, answer, done: done ? JSON.parse(done.data) : null, error: error?.data };
}

if (files.length) {
  const s = await call("POST", "/search", { token: A.token, json: { query: question } });
  const reranked = s.data.results?.[0]?.rerankScore;
  ok(health.data.services.reranker !== "ok" || typeof reranked === "number", `re-ranking aplicado (puntuación del mejor: ${reranked ?? "n/d"})`);
}

if (!skipChat && files.length) {
  const first = await ask(A.token, question);
  console.log(`   Pregunta: ${question}\n   Respuesta: ${first.answer?.trim()}`);
  if (first.error) console.log("   Error:", first.error);
  ok(!!first.done, `chat responde${first.done ? ` (modelo: ${first.done.model})` : ""}`);

  if (first.done?.model) {
    const usageBefore = (await call("GET", "/usage", { token: A.token })).data;
    const again = await ask(A.token, question.toUpperCase().replace(/\?/g, ""));
    ok(again.done?.fromCache === true && again.answer === first.answer, "la misma pregunta (con otro formato) se responde desde la caché");
    const usageAfter = (await call("GET", "/usage", { token: A.token })).data;
    const sum = (u, k) => u.daily.reduce((n, d) => n + d[k], 0);
    ok(sum(usageAfter, "questions") === sum(usageBefore, "questions"), "la respuesta desde caché no consume cupo del LLM");

    const otherQ = await ask(A.token, `${question} ¿Y en el año 2031?`);
    ok(otherQ.done?.fromCache !== true, "una pregunta con un número distinto NO usa la caché");

    // El lector (acceso solo a la colección de A) tiene el mismo alcance → caché compartida.
    const viewerAsk = await ask(vt, question);
    ok(viewerAsk.done?.fromCache === true, "otro usuario con el mismo acceso reutiliza la respuesta");
    // Si se le quita el acceso, ya no ve nada: no puede recibir la respuesta guardada.
    await call("PUT", `/collections/${A.collectionId}/members`, { token: A.token, json: { userIds: [] } });
    const viewerNoAccess = await ask(vt, question);
    ok(viewerNoAccess.done?.fromCache !== true && (viewerNoAccess.done?.sources ?? []).length === 0, "sin acceso a la colección no recibe la respuesta guardada");

    const fb = await call("PUT", `/messages/${again.done.messageId}/feedback`, { token: A.token, json: { rating: -1, comment: "prueba" } });
    ok(fb.status === 200, "valoración 👎 registrada");
    const afterBad = await ask(A.token, question);
    ok(afterBad.done?.fromCache !== true, "tras un 👎 la respuesta sale de la caché y se vuelve a generar");
    const quality = await call("GET", "/quality?rating=-1&status=pending", { token: A.token });
    ok(quality.data.items?.some((i) => i.comment === "prueba"), "el administrador ve la valoración en Calidad");
    const vq = await call("GET", "/quality", { token: vt });
    ok(vq.status === 403, "un lector no puede ver la página de Calidad");
  }
}

for (const t of [A, B]) await call("PATCH", `/platform/tenants/${t.id}`, { token: root, json: { isActive: false } });
console.log(failures ? `\n${failures} comprobación(es) fallaron` : "\nTodo correcto");
process.exit(failures ? 1 : 0);
