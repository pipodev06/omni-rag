import { withTenant, type TenantContext } from "../db/client.js";
import type { RetrievalScope } from "./retrieve.js";

/** «¿Te refieres a…?»: códigos de los documentos parecidos a un término de la pregunta. */
export interface CodeSuggestion {
  /** Término de la pregunta tal como lo escribió el usuario. */
  term: string;
  /** Códigos propuestos y la pregunta lista para enviar con cada uno. */
  options: { code: string; question: string }[];
  /** Cuántos códigos más coinciden y no se muestran. */
  more: number;
}

interface Probe {
  term: string;
  /** Con dígitos: se busca dentro del código y con erratas. Sin dígitos: solo como inicio del código («inc»). */
  hasDigit: boolean;
}

const MAX_OPTIONS = 5;
const escapeLike = (t: string) => t.replace(/[\\%_]/g, "\\$&");

/**
 * Términos que pueden ser un trozo de código: con dígitos (INC50263, 502635) o, en preguntas cortas, palabras de 3 a 6
 * letras («inc», «ord»), que es como se suele pedir «todos los INC». Como mucho 3.
 */
export function suggestionProbes(question: string): Probe[] {
  const words = question.match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) ?? [];
  const short = words.length <= 6;
  const probes: Probe[] = [];
  for (const w of words.map((t) => t.replace(/-+$/, ""))) {
    const digits = w.replace(/\D/g, "").length;
    const hasDigit = digits > 0;
    // Solo números cortos (años, cantidades) saldrían en todas partes: con letras basta 2 dígitos; sin letras, 5.
    const codeLike = /\p{L}/u.test(w) ? digits >= 2 && w.length >= 4 : digits >= 5;
    if (hasDigit ? codeLike : short && /^\p{L}{3,6}$/u.test(w)) {
      if (!probes.some((p) => p.term.toLowerCase() === w.toLowerCase())) probes.push({ term: w, hasDigit });
    }
  }
  return probes.slice(0, 3);
}

/** Cambia la primera aparición del término (palabra completa, sin distinguir mayúsculas) por el código. */
export function replaceTerm(question: string, term: string, code: string): string {
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "iu");
  return question.replace(re, code);
}

/**
 * Busca en los fragmentos que el usuario puede ver (RLS + colecciones del ámbito) los códigos —palabras con algún
 * dígito— que empiezan por el término, lo contienen o se le parecen (trigramas, para las erratas). Solo propone algo si
 * el término no aparece tal cual como código o si coinciden varios: no se gasta cuota del modelo.
 */
export async function codeSuggestions(ctx: TenantContext, question: string, scope: RetrievalScope): Promise<CodeSuggestion[]> {
  const probes = suggestionProbes(question);
  if (probes.length === 0 || scope.collectionIds.length === 0) return [];
  const collections = scope.collectionIds;
  const documents = scope.documentIds.length ? scope.documentIds : null;

  return withTenant(ctx, async (tx) => {
    const result: CodeSuggestion[] = [];
    for (const p of probes) {
      const like = `%${escapeLike(p.term)}%`;
      const tokenLike = p.hasDigit ? `%${escapeLike(p.term)}%` : `${escapeLike(p.term)}%`;
      // Erratas solo con dígitos: «INC502365» encuentra INC502635 (similitud de trigramas ≥ 0.6 dentro del texto).
      const fuzzy = p.hasDigit ? tx`OR ${p.term} <% c.content` : tx``;
      const rows = await tx<{ code: string; n: number }[]>`
        WITH cand AS (
          SELECT c.content
            FROM chunks c
           WHERE (c.content ILIKE ${like} ${fuzzy})
             AND c.tenant_id = app_tenant_id()
             AND c.collection_id = ANY(${collections}::uuid[])
             AND (${documents}::uuid[] IS NULL OR c.document_id = ANY(${documents}::uuid[]))
             AND NOT EXISTS (SELECT 1 FROM documents x WHERE x.id = c.document_id AND x.deleted_at IS NOT NULL)
           LIMIT 300
        ),
        codes AS (
          SELECT upper(rtrim(m[1], '-')) AS code, count(*)::int AS n
            FROM cand, regexp_matches(cand.content, '([[:alpha:]]*[0-9][[:alnum:]-]*)', 'g') m
           GROUP BY 1
        )
        SELECT code, n FROM codes
         WHERE length(code) BETWEEN 4 AND 40
           AND (code ILIKE ${tokenLike} ${p.hasDigit ? tx`OR similarity(code, ${p.term.toUpperCase()}) >= 0.45` : tx``})
         ORDER BY (code ILIKE ${tokenLike}) DESC, similarity(code, ${p.term.toUpperCase()}) DESC, n DESC, code
         LIMIT 200`;
      const codes = rows.map((r) => r.code);
      const exact = codes.includes(p.term.toUpperCase());
      // Un código escrito completo y que existe no necesita sugerencias.
      if (codes.length === 0 || (exact && (p.hasDigit || codes.length === 1))) continue;
      const shown = codes.filter((c) => c !== p.term.toUpperCase()).slice(0, MAX_OPTIONS);
      result.push({
        term: p.term,
        options: shown.map((code) => ({ code, question: replaceTerm(question, p.term, code) })),
        more: codes.length - (exact ? 1 : 0) - shown.length,
      });
    }
    return result;
  });
}
