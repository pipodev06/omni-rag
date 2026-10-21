import { MessageSquareText, Sparkles } from "lucide-react";

export interface Suggestion {
  text: string;
  /** Documento del que sale la pregunta sugerida (vacío si es genérica). */
  from: string;
}

/** Pantalla inicial de una conversación nueva, con preguntas sugeridas. */
export function ChatWelcome({ title, hasDocuments, suggestions, onPick }: {
  title: string;
  hasDocuments: boolean;
  suggestions: Suggestion[];
  onPick: (text: string) => void;
}) {
  return (
    <div className="flex flex-col items-center pt-[12vh] text-center">
      <div className="mb-5 grid size-12 place-items-center rounded-2xl bg-primary/10 text-primary">
        <Sparkles className="size-6" />
      </div>
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">
        Respondo usando solo los documentos a los que tienes acceso y te indico de dónde sale cada dato.
      </p>
      {hasDocuments ? (
        <div className="mt-8 grid w-full gap-2 sm:grid-cols-2">
          {suggestions.map((s) => (
            <button
              key={s.text}
              onClick={() => onPick(s.text)}
              className="flex flex-col rounded-xl border bg-card p-3.5 text-left text-sm transition-colors hover:border-primary/40 hover:bg-accent"
            >
              <MessageSquareText className="mb-2 size-4 text-primary" />
              {s.text}
              {s.from && <span className="mt-1.5 truncate text-xs text-muted-foreground">{s.from}</span>}
            </button>
          ))}
        </div>
      ) : (
        <p className="mt-8 rounded-lg border border-dashed px-4 py-3 text-sm text-muted-foreground">
          Todavía no hay documentos listos. Súbelos en la sección <b>Documentos</b>.
        </p>
      )}
    </div>
  );
}
