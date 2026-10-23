import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ArrowLeft, ArchiveRestore, Trash2, X } from "lucide-react";
import { formatBytes, timeAgo, type TrashedDocument } from "@/api";
import { useTrash, useTrashActions } from "@/hooks/useTrash";
import { useCurrentUser } from "@/hooks/useSession";
import { EmptyState, FileTypeIcon, Page, PageHeader, TableCard } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/** Cuánto falta para que el documento se elimine solo. */
function remaining(purgeAt: string): string {
  const days = Math.ceil((new Date(purgeAt).getTime() - Date.now()) / 86_400_000);
  return days <= 0 ? "Hoy" : days === 1 ? "1 día" : `${days} días`;
}

export function TrashPage() {
  const { user } = useCurrentUser();
  const isAdmin = user.role === "admin";
  const { documents, retentionDays, loading } = useTrash();
  const { restore, purge, emptyTrash } = useTrashActions();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // La selección solo conserva lo que sigue en la papelera.
  const key = documents.map((d) => d.id).join(",");
  useEffect(() => {
    setSelected((prev) => {
      const present = new Set(key.split(","));
      const next = new Set([...prev].filter((id) => present.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [key]);

  const picked = documents.filter((d) => selected.has(d.id));
  const toggle = (id: string, checked: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  const restoreAndClear = async (ds: TrashedDocument[]) => {
    if (await restore(ds)) setSelected(new Set());
  };
  const purgeAndClear = async (ds: TrashedDocument[]) => {
    if (await purge(ds)) setSelected(new Set());
  };

  return (
    <Page fill>
      <PageHeader
        title="Papelera"
        description={
          retentionDays > 0 ? (
            <>
              <p>Los documentos borrados permanecen aquí {retentionDays} días. Durante ese plazo no aparecen en las colecciones ni en las respuestas del chat, y no cuentan para el límite de documentos del plan.</p>
              <p>Al restaurar un documento, vuelve a su colección tal como estaba, sin necesidad de procesarlo de nuevo. Transcurrido el plazo se elimina definitivamente junto con su archivo.</p>
            </>
          ) : (
            <p>La papelera está desactivada: los documentos borrados se eliminan de inmediato.</p>
          )
        }
        actions={
          <>
            {isAdmin && documents.length > 0 && (
              <Button variant="destructive" onClick={() => void emptyTrash(documents.length)}>
                <Trash2 /> Vaciar papelera
              </Button>
            )}
            <Button variant="outline" asChild>
              <Link to="/documentos">
                <ArrowLeft /> Documentos
              </Link>
            </Button>
          </>
        }
      />

      {picked.length > 0 && (
        <div className="mb-5 flex shrink-0 flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
          <span className="font-medium">
            {picked.length} seleccionado{picked.length === 1 ? "" : "s"}
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              <X /> Quitar selección
            </Button>
            <Button size="sm" variant="outline" onClick={() => void restoreAndClear(picked)}>
              <ArchiveRestore /> Restaurar
            </Button>
            {isAdmin && (
              <Button size="sm" variant="destructive" onClick={() => void purgeAndClear(picked)}>
                <Trash2 /> Eliminar definitivamente
              </Button>
            )}
          </div>
        </div>
      )}

      {loading ? (
        <Skeleton className="h-48 w-full" />
      ) : documents.length === 0 ? (
        <EmptyState icon={Trash2} title="La papelera está vacía" description="Los documentos que borres aparecerán aquí para poder restaurarlos." />
      ) : (
        <TableCard>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-10 pl-4">
                  <Checkbox
                    aria-label="Seleccionar todos los documentos"
                    checked={picked.length === 0 ? false : picked.length === documents.length ? true : "indeterminate"}
                    onCheckedChange={(v) => setSelected(v === true ? new Set(documents.map((d) => d.id)) : new Set())}
                  />
                </TableHead>
                <TableHead>Documento</TableHead>
                <TableHead className="hidden md:table-cell">Colección</TableHead>
                <TableHead className="hidden sm:table-cell">Borrado</TableHead>
                <TableHead className="text-center">Se elimina en</TableHead>
                <TableHead className="hidden md:table-cell">Tamaño</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {documents.map((d) => (
                <TableRow key={d.id} data-state={selected.has(d.id) ? "selected" : undefined}>
                  <TableCell className="w-10 pl-4">
                    <Checkbox aria-label={`Seleccionar «${d.title}»`} checked={selected.has(d.id)} onCheckedChange={(v) => toggle(d.id, v === true)} />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <FileTypeIcon filename={d.filename} />
                      <div className="min-w-0">
                        <p className="max-w-[16rem] truncate font-medium lg:max-w-sm">{d.title}</p>
                        <p className="max-w-[16rem] truncate text-xs text-muted-foreground lg:max-w-sm">{d.filename}</p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">{d.collectionName}</TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <p className="text-sm">{timeAgo(d.deletedAt)}</p>
                    {d.deletedBy && <p className="text-xs text-muted-foreground">{d.deletedBy}</p>}
                  </TableCell>
                  <TableCell className="text-center text-sm tabular-nums">{remaining(d.purgeAt)}</TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">{formatBytes(d.sizeBytes)}</TableCell>
                  <TableCell className="pr-3 text-right">
                    <Button size="sm" variant="outline" onClick={() => void restoreAndClear([d])}>
                      <ArchiveRestore /> Restaurar
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableCard>
      )}
    </Page>
  );
}
