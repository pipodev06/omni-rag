#!/usr/bin/env node
// =====================================================================
// Prueba de carga sin dependencias (Node 18+). Mide cuántas peticiones por segundo aguanta la aplicación y cuánto
// tarda el 50 %, el 95 % y el 99 % de ellas, con varios usuarios a la vez.
//
//   LOADTEST_PASSWORD=... node deploy/loadtest.mjs --url http://localhost:8000 --users usuario1,usuario2,usuario3 \
//        --scenario lectura --concurrency 20 --duration 20
//
// Escenarios:
//   web       página principal y recursos estáticos (sin sesión)
//   lectura   lo que hace la interfaz al navegar: sesión, colecciones, documentos, conversaciones y cuota
//   busqueda  búsqueda híbrida con embeddings y re-ranking (sin llamar al LLM, no gasta cupo)
//
// Usa varios usuarios porque la API limita cada uno (60 búsquedas por minuto). Crea usuarios de prueba para esto y bórralos
// después. La contraseña va en la variable LOADTEST_PASSWORD, nunca en la línea de comandos. No lo apuntes a producción en
// horas de uso: las búsquedas consumen CPU del servidor de embeddings.
// =====================================================================

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, all) => (a.startsWith("--") ? [[a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "true"]] : [])),
);
const base = (args.url ?? "http://localhost:8000").replace(/\/$/, "");
const users = (args.users ?? "").split(",").filter(Boolean);
const scenario = args.scenario ?? "lectura";
const concurrency = Number(args.concurrency ?? 10);
const duration = Number(args.duration ?? 15);
const password = process.env.LOADTEST_PASSWORD;

if (scenario !== "web" && (users.length === 0 || !password)) {
  console.error("Indica --users usuario1,usuario2 y la variable LOADTEST_PASSWORD (los usuarios de prueba).");
  process.exit(2);
}

const QUESTIONS = [
  "¿Cuáles son los requisitos de la evaluación final?",
  "resumen de las obligaciones principales",
  "¿Qué plazos o fechas importantes aparecen?",
  "configuración de la red mesh",
  "experiencia laboral y estudios",
  "arquitectura empresarial TOGAF",
  "tarea semanal de la unidad 4",
  "almacén y logística",
];

async function login(user) {
  const res = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: user, password }) });
  if (!res.ok) throw new Error(`No se pudo iniciar sesión como ${user} (HTTP ${res.status}). ¿Existe el usuario y es esa la contraseña?`);
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  if (!cookie) throw new Error(`El usuario ${user} tiene verificación en dos pasos o no devolvió cookie.`);
  return cookie;
}

const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0);

async function main() {
  const sessions = scenario === "web" ? [""] : await Promise.all(users.map(login));
  let collectionId = "";
  if (scenario === "lectura") {
    const res = await fetch(`${base}/api/collections`, { headers: { cookie: sessions[0] } });
    const list = (await res.json()).collections ?? [];
    collectionId = (list.find((c) => c.documentCount > 0) ?? list[0])?.id ?? "";
  }
  let asset = "";
  if (scenario === "web") {
    const html = await (await fetch(`${base}/`)).text();
    asset = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1] ?? "";
  }

  // Cada «paso» devuelve [ruta, opciones]. Una iteración de un trabajador hace todos los pasos del escenario.
  const steps = {
    web: () => [[`${base}/`, {}], ...(asset ? [[`${base}${asset}`, {}]] : [])],
    lectura: (cookie) => [
      [`${base}/api/auth/me`, { headers: { cookie } }],
      [`${base}/api/collections`, { headers: { cookie } }],
      [`${base}/api/documents?collectionId=${collectionId}`, { headers: { cookie } }],
      [`${base}/api/conversations`, { headers: { cookie } }],
      [`${base}/api/quota`, { headers: { cookie } }],
    ],
    busqueda: (cookie) => [
      [`${base}/api/search`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ query: QUESTIONS[Math.floor(Math.random() * QUESTIONS.length)] }) }],
    ],
  }[scenario];
  if (!steps) {
    console.error(`Escenario desconocido: ${scenario} (usa web, lectura o busqueda)`);
    process.exit(2);
  }

  const latencies = [];
  const statuses = new Map();
  let errors = 0;
  const deadline = Date.now() + duration * 1000;
  let turn = 0;

  async function worker(id) {
    while (Date.now() < deadline) {
      const cookie = sessions[(id + turn++) % sessions.length];
      for (const [url, opts] of steps(cookie)) {
        const t0 = performance.now();
        try {
          const res = await fetch(url, opts);
          await res.arrayBuffer();
          latencies.push(performance.now() - t0);
          statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
          if (res.status >= 400) errors++;
        } catch {
          errors++;
          statuses.set("fallo de red", (statuses.get("fallo de red") ?? 0) + 1);
        }
      }
    }
  }

  const started = Date.now();
  await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));
  const seconds = (Date.now() - started) / 1000;
  const sorted = latencies.sort((a, b) => a - b);
  const ms = (n) => `${n.toFixed(0)} ms`;
  console.log(`Escenario «${scenario}» · ${concurrency} en paralelo · ${users.length || 0} usuarios · ${seconds.toFixed(0)} s`);
  console.log(`  peticiones: ${sorted.length} (${(sorted.length / seconds).toFixed(1)} por segundo) · errores: ${errors} (${((errors / Math.max(sorted.length, 1)) * 100).toFixed(1)} %)`);
  console.log(`  latencia: mediana ${ms(percentile(sorted, 50))} · p95 ${ms(percentile(sorted, 95))} · p99 ${ms(percentile(sorted, 99))} · máx ${ms(sorted.at(-1) ?? 0)}`);
  console.log(`  respuestas: ${[...statuses].map(([s, n]) => `${s}×${n}`).join("  ")}`);
  process.exit(errors / Math.max(sorted.length, 1) > 0.01 ? 1 : 0);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(2);
});
