import type { LucideIcon } from "lucide-react";
import {
  BookSearch,
  CircleAlert,
  CircleCheck,
  Clock,
  File,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  Info,
  Loader2,
  Presentation,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import type { DocumentInfo } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/** Logotipo de la aplicación. */
export function Logo({ className, withText = true }: { className?: string; withText?: boolean }) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <div className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground shadow-sm">
        <BookSearch className="size-4.5" />
      </div>
      {withText && <span className="text-[15px] font-semibold tracking-tight">Omni RAG</span>}
    </div>
  );
}

/** Icono (i) que abre un modal con la explicación de la página. */
export function InfoHint({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="ghost" size="icon" className="size-7 text-muted-foreground" aria-label={`Información sobre ${title}`} onClick={() => setOpen(true)}>
        <Info />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-3">{children}</div>
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Cabecera de página: título, acciones a la derecha y, si hay `description`, un icono (i) con su explicación. */
export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex shrink-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <InfoHint title={title}>{description}</InfoHint>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/**
 * Contenedor de una tabla: ocupa el alto disponible de la página y es la tabla
 * (no la página) la que hace scroll, con la cabecera fija. Usar dentro de `<Page fill>`.
 */
export function TableCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "min-h-24 overflow-auto rounded-xl border bg-card [&_[data-slot=table-container]]:overflow-visible [&_thead]:sticky [&_thead]:top-0 [&_thead]:z-10 [&_thead]:bg-card [&_thead]:shadow-[inset_0_-1px_0_var(--border)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Estado vacío con icono, texto y acción opcional. */
export function EmptyState({ icon: Icon, title, description, action, className }: {
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed px-6 py-14 text-center", className)}>
      <div className="grid size-11 place-items-center rounded-full bg-muted text-muted-foreground">
        <Icon className="size-5" />
      </div>
      <div className="space-y-1">
        <p className="font-medium">{title}</p>
        {description && <p className="mx-auto max-w-sm text-sm text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  );
}

/** Contenedor estándar de las páginas. */
export function Page({ children, className, fill }: { children: ReactNode; className?: string; fill?: boolean }) {
  // `fill`: la página ocupa el alto disponible y deja que su tabla (TableCard) haga el scroll.
  return <div className={cn("mx-auto w-full px-4 py-6 sm:px-6 lg:px-8 lg:py-8", fill && "flex h-full min-h-0 flex-col", className)}>{children}</div>;
}

const STATUS: Record<DocumentInfo["status"], { label: string; icon: LucideIcon; className: string; spin?: boolean }> = {
  pending: { label: "En cola", icon: Clock, className: "text-warning bg-warning/10 border-warning/20" },
  processing: { label: "Procesando", icon: Loader2, className: "text-primary bg-primary/10 border-primary/20", spin: true },
  ready: { label: "Listo", icon: CircleCheck, className: "text-success bg-success/10 border-success/20" },
  failed: { label: "Error", icon: CircleAlert, className: "text-destructive bg-destructive/10 border-destructive/20" },
};

export function StatusBadge({ status }: { status: DocumentInfo["status"] }) {
  const s = STATUS[status];
  return (
    <Badge variant="outline" className={cn("gap-1 font-medium", s.className)}>
      <s.icon className={cn("size-3", s.spin && "animate-spin")} />
      {s.label}
    </Badge>
  );
}

const ICONS: Record<string, { icon: LucideIcon; className: string }> = {
  pdf: { icon: FileText, className: "text-red-500 bg-red-500/10" },
  docx: { icon: FileText, className: "text-blue-500 bg-blue-500/10" },
  pptx: { icon: Presentation, className: "text-orange-500 bg-orange-500/10" },
  xlsx: { icon: FileSpreadsheet, className: "text-emerald-600 bg-emerald-500/10" },
  csv: { icon: FileSpreadsheet, className: "text-emerald-600 bg-emerald-500/10" },
  html: { icon: FileCode, className: "text-violet-500 bg-violet-500/10" },
  htm: { icon: FileCode, className: "text-violet-500 bg-violet-500/10" },
  json: { icon: FileCode, className: "text-violet-500 bg-violet-500/10" },
  md: { icon: FileText, className: "text-zinc-500 bg-zinc-500/10" },
  txt: { icon: FileText, className: "text-zinc-500 bg-zinc-500/10" },
};
const IMAGE = { icon: FileImage, className: "text-sky-500 bg-sky-500/10" };

/** Icono de color según la extensión del archivo. */
export function FileTypeIcon({ filename, className }: { filename: string; className?: string }) {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const { icon: Icon, className: color } =
    ICONS[ext] ?? (["png", "jpg", "jpeg", "tif", "tiff", "bmp", "webp"].includes(ext) ? IMAGE : { icon: File, className: "text-muted-foreground bg-muted" });
  return (
    <div className={cn("grid size-9 shrink-0 place-items-center rounded-lg", color, className)}>
      <Icon className="size-4.5" />
    </div>
  );
}
