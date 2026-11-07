import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { formatDate } from "@/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export type RestoreCopy = { stamp: string; at: string; hasUploads: boolean };

/** Los mismos pasos de docs/operacion.md («Restaurar una copia»), con la fecha de esta copia. */
function commands({ stamp, hasUploads }: RestoreCopy): string {
  return [
    "docker compose stop api worker web backup backup-b2",
    `docker compose exec -T db pg_restore -U rag_owner -d rag --clean --if-exists < backups/db_${stamp}.dump`,
    ...(hasUploads ? [`docker run --rm -v "$PWD/data/uploads":/data -v "$PWD/backups":/backup alpine sh -c "rm -rf /data/* && tar xzf /backup/uploads_${stamp}.tgz -C /data"`] : []),
    "docker compose up -d",
  ].join("\n");
}

/**
 * Cómo restaurar una copia: solo muestra los comandos para copiarlos. Restaurar sobrescribe la base entera, así que no
 * se hace desde la web (y la API no ve las copias).
 */
export function RestoreDialog({ copy, onClose }: { copy: RestoreCopy | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const text = copy ? commands(copy) : "";
  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("No se pudo copiar; selecciona los comandos y cópialos a mano");
    }
  };
  return (
    <Dialog open={copy !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Restaurar la copia del {copy ? formatDate(copy.at) : ""}</DialogTitle>
          <DialogDescription>
            Ejecútalos en el servidor, en la carpeta del docker-compose.yml. La base vuelve a ese momento: se pierde todo lo hecho después (documentos, usuarios, conversaciones). Omni RAG queda parado unos minutos.
          </DialogDescription>
        </DialogHeader>
        <pre className="max-h-64 overflow-auto rounded-md border bg-muted p-3 font-mono text-xs whitespace-pre-wrap break-all">{text}</pre>
        <div className="space-y-1 text-xs text-muted-foreground">
          {copy && !copy.hasUploads && <p>Esta copia no incluye los archivos subidos: solo se restaura la base.</p>}
          <p>
            Con volúmenes de Docker (desarrollo en Windows), cambia <span className="font-mono">"$PWD/data/uploads"</span> por <span className="font-mono">rag_uploads</span>. Antes, si quieres poder volver atrás, pulsa «Hacer copia ahora».
          </p>
        </div>
        <div className="flex justify-end">
          <Button type="button" size="sm" onClick={copyText}>
            {copied ? <Check /> : <Copy />} {copied ? "Copiado" : "Copiar comandos"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
