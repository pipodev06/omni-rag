import { CornerDownRight } from "lucide-react";
import type { CodeSuggestion } from "@/api";
import { Button } from "@/components/ui/button";

/**
 * «¿Te refieres a…?»: códigos de los documentos parecidos a lo que escribió el usuario («inc» → INC502635). Pulsar uno
 * vuelve a preguntar con ese código. Los calcula la API buscando en los documentos, sin el modelo de lenguaje.
 */
export function CodeSuggestions({ suggestions, onAsk }: { suggestions: CodeSuggestion[]; onAsk: (question: string) => void }) {
  return (
    <div className="space-y-2">
      {suggestions.map((s) => (
        <div key={s.term} className="flex flex-wrap items-center gap-1.5 text-sm">
          <span className="text-muted-foreground">
            ¿Te refieres a{suggestions.length > 1 && <> (por «{s.term}»)</>}:
          </span>
          {s.options.map((o) => (
            <Button key={o.code} variant="outline" size="sm" className="h-7 font-mono text-xs" title={o.question} onClick={() => onAsk(o.question)}>
              <CornerDownRight />
              {o.code}
            </Button>
          ))}
          {s.more > 0 && <span className="text-xs text-muted-foreground">y {s.more} más</span>}
        </div>
      ))}
    </div>
  );
}
