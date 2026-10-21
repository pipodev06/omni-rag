import { useNavigate } from "react-router";
import { Download, EllipsisVertical, Eye, Layers, MessageSquareText, Pencil, RotateCw, Sparkles, Trash2 } from "lucide-react";
import { formatBytes, timeAgo, type DocumentInfo } from "@/api";
import { FileTypeIcon, StatusBadge } from "@/components/common";
import { useOpenDocument } from "@/components/documents/DocumentViewer";
import { Button } from "@/components/ui/button";
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
  onReprocess: (d: DocumentInfo) => void;
  onDelete: (d: DocumentInfo) => void;
}

function DocumentActions({ doc: d, canEdit, onRename, onReprocess, onDelete }: RowActions & { doc: DocumentInfo }) {
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
            <DropdownMenuItem onSelect={() => onReprocess(d)}>
              <RotateCw /> Reprocesar
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => onDelete(d)}>
              <Trash2 /> Borrar
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

function DocumentRow({ doc: d, ...actions }: RowActions & { doc: DocumentInfo }) {
  const openDocument = useOpenDocument();
  return (
    <TableRow>
      <TableCell className="pl-4">
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

/** Tabla de documentos de una colección con su menú de acciones. */
export function DocumentsTable({ documents, ...actions }: RowActions & { documents: DocumentInfo[] }) {
  return (
    <TableCard>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="pl-4">Documento</TableHead>
            <TableHead>Estado</TableHead>
            <TableHead className="hidden md:table-cell">Tamaño</TableHead>
            <TableHead className="hidden md:table-cell">Páginas</TableHead>
            <TableHead className="hidden lg:table-cell">Fragmentos</TableHead>
            <TableHead className="hidden sm:table-cell">Subido</TableHead>
            <TableHead className="w-12" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {documents.map((d) => (
            <DocumentRow key={d.id} doc={d} {...actions} />
          ))}
        </TableBody>
      </Table>
    </TableCard>
  );
}
