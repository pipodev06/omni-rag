/** "pág. 3" o "págs. 3–5" (vacío si el formato no tiene páginas). */
export const pagesLabel = (s: { pageStart: number | null; pageEnd: number | null }) =>
  s.pageStart === null ? "" : s.pageEnd !== null && s.pageEnd !== s.pageStart ? `págs. ${s.pageStart}–${s.pageEnd}` : `pág. ${s.pageStart}`;
