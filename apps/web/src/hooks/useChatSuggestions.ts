import { useQuery } from "@tanstack/react-query";
import { api, type DocumentInfo } from "@/api";
import type { DocumentDetail } from "@/components/documents/DocumentViewer";
import type { Suggestion } from "@/components/chat/ChatWelcome";

/**
 * Datos para la pantalla inicial del chat: documento filtrado (si lo hay),
 * si existen documentos listos y las preguntas sugeridas (de los resúmenes
 * generados, o genéricas si aún no hay ninguno).
 */
export function useChatSuggestions(documentId: string | null) {
  const { data: docsData } = useQuery({
    queryKey: ["documents", "all"],
    queryFn: () => api.get<{ documents: DocumentInfo[] }>("/documents"),
  });
  const readyDocs = (docsData?.documents ?? []).filter((d) => d.status === "ready");

  const { data: filterData } = useQuery({
    queryKey: ["document", documentId],
    queryFn: () => api.get<{ document: DocumentDetail }>(`/documents/${documentId}`),
    enabled: !!documentId,
  });
  const filterDoc = filterData?.document;

  const { data: suggestionsData } = useQuery({
    queryKey: ["suggestions", documentId],
    queryFn: () =>
      api.get<{ suggestions: { documentId: string; documentTitle: string; question: string }[] }>(
        `/documents/suggestions${documentId ? `?documentId=${documentId}` : ""}`,
      ),
    staleTime: 5 * 60_000,
  });

  const generated: Suggestion[] = (suggestionsData?.suggestions ?? [])
    .slice(0, 4)
    .map((s) => ({ text: s.question, from: documentId ? "" : s.documentTitle }));

  let suggestions = generated;
  if (generated.length === 0 && filterDoc) {
    suggestions = [
      { text: `Resume los puntos principales de «${filterDoc.title}»`, from: "" },
      { text: "¿Qué plazos, fechas o importes aparecen?", from: "" },
    ];
  } else if (generated.length === 0) {
    suggestions = [
      ...readyDocs.slice(0, 2).map((d) => ({ text: `Resume los puntos principales de «${d.title}»`, from: "" })),
      { text: "¿Qué plazos o fechas importantes aparecen en los documentos?", from: "" },
      { text: "¿Qué obligaciones o requisitos se mencionan?", from: "" },
    ].slice(0, 4);
  }

  return { filterDoc, hasDocuments: readyDocs.length > 0, suggestions };
}
