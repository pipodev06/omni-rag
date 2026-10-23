import { useNavigate } from "react-router";
import { ArrowDown, ArrowUp, ArrowUpDown, Download, EllipsisVertical, Eye, FolderInput, Layers, MessageSquareText, Pencil, RotateCw, Sparkles, Trash2 } from "lucide-react";
import { formatBytes, timeAgo, type DocumentInfo } from "@/api";
import { FileTypeIcon, StatusBadge } from "@/components/common";
import { useOpenDocument } from "@/components/documents/DocumentViewer";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { DocumentView, SortKey } from "@/lib/documentView";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TableCard } from "@/components/common";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface RowActions {
  canEdit: boolean;
  onRename: (d: DocumentInfo) => void;
  onMove: (d: DocumentInfo) => void;
  onReprocess: (d: DocumentInfo) => void;
  onDelete: (d: DocumentInfo) => void;
}

function DocumentActions({ doc: d, canEdit, onRename, onMove, onReprocess, onDelete }: RowActions & { doc: DocumentInfo }) {
  const openDocument = useOpenDocument();
  const navigate = useNavigate();
  const ready = d.status === "ready";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8" aria-label="Acciones">
          <EllipsisVertical />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem asChild>
          <a href={`/api/documents/${d.id}/file`}>
            <Download /> Descargar original
          </a>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openDocument({ documentId: d.id })}>
          <Eye /> Abrir
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!ready} onSelect={() => openDocument({ documentId: d.id, tab: "summary" })}>
          <Sparkles /> Resumen y preguntas
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!ready} onSelect={() => navigate(`/chat?documento=${d.id}`)}>
          <MessageSquareText /> Preguntar sobre este documento
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!ready} onSelect={() => openDocument({ documentId: d.id, tab: "chunks" })}>
          <Layers /> Ver fragmentos
        </DropdownMenuItem>
        {canEdit && (
          <>
            <DropdownMenuItem onSelect={() => onRename(d)}>
              <Pencil /> Renombrar
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!ready} onSelect={() => onMove(d)}>
              <FolderInput /> Mover a otra colección
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onReprocess(d)}>
              <RotateCw /> Reprocesar
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => onDelete(d)}>
              <Trash2 /> Enviar a la papelera
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DocumentStatus({ doc: d }: { doc: DocumentInfo }) {
  if (!d.error) return <StatusBadge status={d.status} />;
  return (
    <Tooltip>
      <TooltipTrigger>
        <StatusBadge status={d.status} />
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{d.error}</TooltipContent>
    </Tooltip>
  );
}

function DocumentRow({ doc: d, checked, onCheck, ...actions }: RowActions & { doc: DocumentInfo; checked?: boolean; onCheck?: (v: boolean) => void }) {
  const openDocument = useOpenDocument();
  return (
    <TableRow data-state={checked ? "selected" : undefined}>
      {onCheck && (
        <TableCell className="w-10 pl-4">
          <Checkbox aria-label={`Seleccionar «${d.title}»`} checked={checked === true} onCheckedChange={(v) => onCheck(v === true)} />
        </TableCell>
      )}
      <TableCell className={onCheck ? "" : "pl-4"}>
        <div className="flex items-center gap-3">
          <FileTypeIcon filename={d.filename} />
          <div className="min-w-0">
            <button
              className="flex max-w-[16rem] items-center gap-1.5 text-left font-medium hover:text-primary hover:underline lg:max-w-sm"
              onClick={() => openDocument({ documentId: d.id })}
            >
              <span className="truncate">{d.title}</span>
              {d.hasSummary && <Sparkles className="size-3.5 shrink-0 text-primary" aria-label="Tiene resumen" />}
            </button>
            <p className="max-w-[16rem] truncate text-xs text-muted-foreground lg:max-w-sm">{d.filename}</p>
          </div>
        </div>
      </TableCell>
      <TableCell>
        <DocumentStatus doc={d} />
      </TableCell>
      <TableCell className="hidden text-muted-foreground md:table-cell">{formatBytes(d.sizeBytes)}</TableCell>
      <TableCell className="hidden text-muted-foreground md:table-cell">{d.pageCount ?? "—"}</TableCell>
      <TableCell className="hidden text-muted-foreground lg:table-cell">{d.chunkCount}</TableCell>
      <TableCell className="hidden sm:table-cell">
        <p className="text-sm">{timeAgo(d.createdAt)}</p>
        {d.createdBy && <p className="text-xs text-muted-foreground">{d.createdBy}</p>}
      </TableCell>
      <TableCell className="pr-3">
        <DocumentActions doc={d} {...actions} />
      </TableCell>
    </TableRow>
  );
}

/** Encabezado de columna que ordena la tabla al pulsarlo. */
function SortHead({ label, sortKey, sort, onSort, className }: {
  label: string;
  sortKey: SortKey;
  sort?: DocumentView["sort"];
  onSort?: (k: SortKey) => void;
  className?: string;
}) {
  const active = sort?.key === sortKey;
  const Icon = !active ? ArrowUpDown : sort.dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <TableHead className={className} aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button
        type="button"
        className={cn("-ml-1 inline-flex items-center gap-1 rounded px-1 py-0.5 hover:text-foreground", !active && "text-muted-foreground")}
        onClick={() => onSort?.(sortKey)}
      >
        {label}
        <Icon className={cn("size-3.5", !active && "opacity-50")} />
      </button>
    </TableHead>
  );
}

/** Selección de documentos para acciones en lote (solo quien puede editar). */
export interface DocumentSelection {
  selected: Set<string>;
  onToggle: (id: string, checked: boolean) => void;
  onToggleAll: (checked: boolean) => void;
}

/** Tabla de documentos de una colección con su menú de acciones y, si hay `selection`, casillas para elegir varios. */
export function DocumentsTable({ documents, selection, sort, onSort, ...actions }: RowActions & {
  documents: DocumentInfo[];
  selection?: DocumentSelection;
  sort?: DocumentView["sort"];
  onSort?: (k: SortKey) => void;
}) {
  const picked = selection ? documents.filter((d) => selection.selected.has(d.id)).length : 0;
  return (
    <TableCard>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {selection && (
              <TableHead className="w-10 pl-4">
                <Checkbox
                  aria-label="Seleccionar todos los documentos"
                  checked={picked === 0 ? false : picked === documents.length ? true : "indeterminate"}
                  onCheckedChange={(v) => selection.onToggleAll(v === true)}
                />
              </TableHead>
            )}
            <SortHead label="Documento" sortKey="title" sort={sort} onSort={onSort} className={selection ? "" : "pl-4"} />
            <SortHead label="Estado" sortKey="status" sort={sort} onSort={onSort} />
            <SortHead label="Tamaño" sortKey="size" sort={sort} onSort={onSort} className="hidden md:table-cell" />
            <SortHead label="Páginas" sortKey="pages" sort={sort} onSort={onSort} className="hidden md:table-cell" />
            <SortHead label="Fragmentos" sortKey="chunks" sort={sort} onSort={onSort} className="hidden lg:table-cell" />
            <SortHead label="Subido" sortKey="created" sort={sort} onSort={onSort} className="hidden sm:table-cell" />
            <TableHead className="w-12" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {documents.map((d) => (
            <DocumentRow
              key={d.id}
              doc={d}
              checked={selection ? selection.selected.has(d.id) : undefined}
              onCheck={selection ? (v) => selection.onToggle(d.id, v) : undefined}
              {...actions}
            />
          ))}
        </TableBody>
      </Table>
    </TableCard>
  );
}
