import { useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage, timeAgo, type Conversation } from "@/api";
import { cn } from "@/lib/utils";
import { useConfirm } from "@/components/ConfirmProvider";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";

// ---------------------------------------------------------------------------
// Historial de conversaciones
// ---------------------------------------------------------------------------

export function ConversationList({ activeId, onSelect }: { activeId?: string; onSelect?: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data, isLoading } = useQuery({
    queryKey: ["conversations"],
    queryFn: () => api.get<{ conversations: Conversation[] }>("/conversations"),
  });

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
      <p className="px-2 pt-2 text-xs font-medium text-muted-foreground">Recientes</p>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-0.5 pr-2">
          {isLoading && <Loader2 className="mx-auto my-4 size-4 animate-spin text-muted-foreground" />}
          {data?.conversations.length === 0 && <p className="px-2 py-1 text-xs text-muted-foreground">Aún no hay conversaciones.</p>}
          {data?.conversations.map((c) => (
            <div
              key={c.id}
              className={cn(
                "group flex items-center rounded-lg text-sm transition-colors hover:bg-sidebar-accent",
                c.id === activeId && "bg-sidebar-accent",
              )}
            >
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
                className="mr-1 size-7 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100"
                onClick={() => void remove(c)}
                aria-label="Borrar conversación"
              >
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
