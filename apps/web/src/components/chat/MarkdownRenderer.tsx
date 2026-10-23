import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Único archivo que importa las librerías de Markdown (react-markdown, remark, micromark: ~100 KB comprimidos).
 * Se carga bajo demanda desde `Answer.tsx`, así la primera pantalla (login, historial, documentos) no las descarga.
 */
export default function MarkdownRenderer({ text, components }: { text: string; components: Components }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {text}
    </ReactMarkdown>
  );
}
