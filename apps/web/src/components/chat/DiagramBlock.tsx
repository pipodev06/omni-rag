import { useEffect, useId, useState } from "react";
import { Code2, Download, Workflow } from "lucide-react";
import { useTheme } from "@/lib/theme";
import { Button } from "@/components/ui/button";

/*
 * Diagrama de una respuesta (bloque ```mermaid). Mermaid pesa: se descarga solo al mostrar el primer diagrama.
 * `securityLevel: "strict"` limpia el SVG (sin scripts, sin enlaces ni clics) porque el texto viene del modelo y, de
 * rebote, de documentos ajenos. Si el diagrama no es válido se muestra el código, sin romper la respuesta.
 */
const MAX_SOURCE = 4000;

type State = { status: "loading" } | { status: "ok"; svg: string } | { status: "error" };

// Del tema elegido, no de la clase `dark` del documento: el efecto del hijo corre antes que el del ThemeProvider.
const isDark = (theme: string) => theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);

export function DiagramBlock({ source, streaming }: { source: string; streaming?: boolean }) {
  const { theme } = useTheme();
  const id = `diagram-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [state, setState] = useState<State>({ status: "loading" });
  const [showCode, setShowCode] = useState(false);

  useEffect(() => {
    if (streaming) return; // el bloque aún está llegando: se dibuja una sola vez, al final
    let cancelled = false;
    (async () => {
      if (source.length > MAX_SOURCE) return setState({ status: "error" });
      try {
        const { default: mermaid } = await import("mermaid");
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: isDark(theme) ?"dark" : "neutral", maxTextSize: MAX_SOURCE, fontFamily: "inherit" });
        if (!(await mermaid.parse(source, { suppressErrors: true }))) throw new Error("diagrama no válido");
        const { svg } = await mermaid.render(id, source);
        if (!cancelled) setState({ status: "ok", svg });
      } catch {
        document.getElementById(id)?.remove(); // mermaid deja su nodo temporal si falla
        if (!cancelled) setState({ status: "error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [source, streaming, theme, id]);

  if (streaming || state.status === "loading") {
    return (
      <p className="my-3 flex items-center gap-2 text-sm text-muted-foreground">
        <Workflow className="size-4" /> Preparando el diagrama…
      </p>
    );
  }

  const code = <pre className="my-0! mt-2 max-h-60 overflow-auto rounded-md p-3! text-xs whitespace-pre-wrap">{source}</pre>;
  if (state.status === "error") {
    return (
      <div className="my-3 rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
        <p className="font-medium">No se pudo dibujar el diagrama.</p>
        {code}
      </div>
    );
  }

  const download = () => {
    const url = URL.createObjectURL(new Blob([state.svg], { type: "image/svg+xml" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "diagrama.svg";
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <figure className="not-prose my-4 rounded-lg border bg-card p-3">
      {/* SVG ya saneado por mermaid (securityLevel strict). */}
      <div className="flex justify-center overflow-x-auto [&_svg]:h-auto [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: state.svg }} />
      {showCode && code}
      <div className="mt-1 flex justify-end gap-1">
        <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs text-muted-foreground" onClick={() => setShowCode(!showCode)}>
          <Code2 /> {showCode ? "Ocultar código" : "Ver código"}
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs text-muted-foreground" onClick={download}>
          <Download /> Descargar SVG
        </Button>
      </div>
    </figure>
  );
}
