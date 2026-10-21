import { useState } from "react";
import { Check, Loader2, ThumbsDown, ThumbsUp } from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage } from "@/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const REASONS = ["Es incorrecta", "Está incompleta", "Las fuentes no la respaldan", "No responde a la pregunta"];

/** Botones 👍 / 👎. El 👎 pide un comentario opcional para los administradores. */
export function FeedbackButtons({ messageId, value, onChange }: { messageId: string; value: 1 | -1 | null | undefined; onChange: (v: 1 | -1 | null) => void }) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [reasons, setReasons] = useState<string[]>([]);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);

  const send = async (rating: 1 | -1, text = "") => {
    setBusy(true);
    try {
      await api.put(`/messages/${messageId}/feedback`, { rating, comment: text });
      onChange(rating);
      toast.success(rating === 1 ? "¡Gracias por tu valoración!" : "Gracias. Los administradores revisarán esta respuesta.");
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    try {
      await api.del(`/messages/${messageId}/feedback`);
      onChange(null);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const submitNegative = async () => {
    await send(-1, [...reasons, comment.trim()].filter(Boolean).join(". "));
    setDialogOpen(false);
    setReasons([]);
    setComment("");
  };

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={cn("size-7 text-muted-foreground", value === 1 && "text-success hover:text-success")}
            onClick={() => (value === 1 ? void clear() : void send(1))}
            disabled={busy}
            aria-label="Buena respuesta"
            aria-pressed={value === 1}
          >
            <ThumbsUp className={cn(value === 1 && "fill-current")} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Buena respuesta</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={cn("size-7 text-muted-foreground", value === -1 && "text-destructive hover:text-destructive")}
            onClick={() => (value === -1 ? void clear() : setDialogOpen(true))}
            disabled={busy}
            aria-label="Mala respuesta"
            aria-pressed={value === -1}
          >
            <ThumbsDown className={cn(value === -1 && "fill-current")} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Mala respuesta</TooltipContent>
      </Tooltip>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>¿Qué falló en esta respuesta?</DialogTitle>
            <DialogDescription>
              Tu valoración, la pregunta y la respuesta serán visibles para los administradores de tu organización, para mejorar el sistema.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap gap-2">
            {REASONS.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setReasons((s) => (s.includes(r) ? s.filter((x) => x !== r) : [...s, r]))}
                aria-pressed={reasons.includes(r)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition-colors",
                  reasons.includes(r)
                    ? "border-primary bg-primary text-primary-foreground"
                    : "hover:bg-muted",
                )}
              >
                {reasons.includes(r) && <Check className="size-3.5" />}
                {r}
              </button>
            ))}
          </div>
          <Textarea value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Comentario opcional: ¿cuál sería la respuesta correcta?" maxLength={1500} rows={3} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={() => void submitNegative()} disabled={busy}>
              {busy && <Loader2 className="animate-spin" />}
              Enviar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
