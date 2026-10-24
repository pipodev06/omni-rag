import { useRef, useState, type ReactNode } from "react";
import { Check, Copy, Download } from "lucide-react";
import { toast } from "sonner";
import { tableToRows, toCsv, toTsv } from "@/lib/tableExport";
import { Button } from "@/components/ui/button";

/** Tabla con desplazamiento horizontal: en pantallas estrechas no se sale de la burbuja ni se corta. */
export function ScrollTable({ children }: { children?: ReactNode }) {
  return (
    <div className="my-4 overflow-x-auto rounded-lg border">
      <table className="my-0! w-full">{children}</table>
    </div>
  );
}

/** Tabla de una respuesta, con botones para copiarla (se pega en Excel o Sheets) y descargarla como CSV. */
export function AnswerTable({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLTableElement>(null);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!ref.current) return;
    try {
      await navigator.clipboard.writeText(toTsv(tableToRows(ref.current)));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error("No se pudo copiar la tabla");
    }
  };

  const download = () => {
    if (!ref.current) return;
    const url = URL.createObjectURL(new Blob([toCsv(tableToRows(ref.current))], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `tabla-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="my-4">
      <div className="overflow-x-auto rounded-lg border">
        <table ref={ref} className="my-0! w-full">
          {children}
        </table>
      </div>
      <div className="mt-1 flex justify-end gap-1">
        <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs text-muted-foreground" onClick={() => void copy()}>
          {copied ? <Check /> : <Copy />} {copied ? "Copiada" : "Copiar tabla"}
        </Button>
        <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs text-muted-foreground" onClick={download}>
          <Download /> Descargar CSV
        </Button>
      </div>
    </div>
  );
}
