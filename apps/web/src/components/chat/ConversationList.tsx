import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage, timeAgo, type Conversation } from "@/api";
import { cn } from "@/lib/utils";
import { useConfirm } from "@/components/ConfirmProvider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";

// ---------------------------------------------------------------------------
// Historial de conversaciones
// ---------------------------------------------------------------------------

export function ConversationList({ activeId, onSelect }: { activeId?: string; onSelect?: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const confirm = useConfirm();
  // Búsqueda en el título y en el texto de los mensajes (con una pequeña espera mientras se escribe).
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setTerm(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);
  const { data, isLoading } = useQuery({
    queryKey: ["conversations", term],
    queryFn: () => api.get<{ conversations: Conversation[] }>(`/conversations${term ? `?q=${encodeURIComponent(term)}` : ""}`),
    placeholderData: (prev) => prev,
  });

  // Renombrar en el sitio: Enter guarda, Escape cancela.
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);
  const rename = async () => {
    if (!editing) return;
    const title = editing.title.trim();
    setEditing(null);
    if (!title) return;
    try {
      await api.patch(`/conversations/${editing.id}`, { title });
      await qc.invalidateQueries({ queryKey: ["conversations"] });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const remove = async (c: Conversation) => {
    const ok = await confirm({
      title: "¿Borrar esta conversación?",
      description: `«${c.title}» se eliminará de forma permanente.`,
      confirmText: "Borrar",
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.del(`/conversations/${c.id}`);
      await qc.invalidateQueries({ queryKey: ["conversations"] });
      if (c.id === activeId) navigate("/chat");
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <Button
        variant="outline"
        className="justify-start"
        onClick={() => {
          navigate("/chat");
          onSelect?.();
        }}
      >
        <Plus /> Nueva conversación
      </Button>
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar conversaciones…" className="h-8 pl-8 text-sm" aria-label="Buscar conversaciones" />
      </div>
      <p className="px-2 pt-1 text-xs font-medium text-muted-foreground">{term ? "Resultados" : "Recientes"}</p>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-0.5 pr-2">
          {isLoading && <Loader2 className="mx-auto my-4 size-4 animate-spin text-muted-foreground" />}
          {data?.conversations.length === 0 && (
            <p className="px-2 py-1 text-xs text-muted-foreground">{term ? `Nada coincide con «${term}».` : "Aún no hay conversaciones."}</p>
          )}
          {data?.conversations.map((c) => (
            <div
              key={c.id}
              className={cn(
                "group flex items-center rounded-lg text-sm transition-colors hover:bg-sidebar-accent",
                c.id === activeId && "bg-sidebar-accent",
              )}
            >
              {editing?.id === c.id ? (
                <form
                  className="flex min-w-0 flex-1 items-center gap-1 p-1"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void rename();
                  }}
                >
                  <Input
                    value={editing.title}
                    onChange={(e) => setEditing({ id: c.id, title: e.target.value })}
                    onKeyDown={(e) => e.key === "Escape" && setEditing(null)}
                    maxLength={120}
                    className="h-7 min-w-0 flex-1 text-sm"
                    aria-label="Nuevo título"
                    autoFocus
                  />
                  <Button type="submit" variant="ghost" size="icon" className="size-7" aria-label="Guardar título">
                    <Check />
                  </Button>
                  <Button type="button" variant="ghost" size="icon" className="size-7" onClick={() => setEditing(null)} aria-label="Cancelar">
                    <X />
                  </Button>
                </form>
              ) : (
                <>
                  <button
                    className="min-w-0 flex-1 px-2.5 py-1.5 text-left"
                    onClick={() => {
                      navigate(`/chat/${c.id}`);
                      onSelect?.();
                    }}
                    title={c.title}
                  >
                    <p className="truncate">{c.title}</p>
                    <p className="text-[11px] text-muted-foreground">{timeAgo(c.updatedAt)}</p>
                  </button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    onClick={() => setEditing({ id: c.id, title: c.title })}
                    aria-label="Renombrar conversación"
                  >
                    <Pencil />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="mr-1 size-7 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100"
                    onClick={() => void remove(c)}
                    aria-label="Borrar conversación"
                  >
                    <Trash2 />
                  </Button>
                </>
              )}
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
