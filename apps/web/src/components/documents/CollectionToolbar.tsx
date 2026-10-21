import { useNavigate } from "react-router";
import { EllipsisVertical, FolderOpen, Pencil, Search, Trash2, UserRoundCog } from "lucide-react";
import type { Collection } from "@/api";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** Selector de colección, acciones de administrador y buscador. */
export function CollectionToolbar({ collections, current, isAdmin, search, onSearch, onMembers, onRename, onDelete }: {
  collections: Collection[];
  current: Collection;
  isAdmin: boolean;
  search: string;
  onSearch: (v: string) => void;
  onMembers: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const navigate = useNavigate();
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <Select value={current.id} onValueChange={(id) => navigate(`/documentos/${id}`)}>
        <SelectTrigger className="w-full justify-start sm:w-72 [&>svg:last-child]:ml-auto" aria-label="Colección">
          <FolderOpen className="text-muted-foreground" />
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {collections.map((c) => (
            <SelectItem key={c.id} value={c.id}>
              {c.name} <span className="text-muted-foreground">({c.documentCount})</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {isAdmin && (
        <div className="flex gap-1">
          <Button variant="outline" size="sm" onClick={onMembers}>
            <UserRoundCog /> Acceso
            <span className="text-muted-foreground">({current.memberIds.length})</span>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" className="size-8" aria-label="Más acciones de la colección">
                <EllipsisVertical />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onRename}>
                <Pencil /> Renombrar
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                <Trash2 /> Borrar colección
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      <div className="relative sm:ml-auto sm:w-64">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={search} onChange={(e) => onSearch(e.target.value)} placeholder="Buscar por nombre…" className="pl-9" aria-label="Buscar documentos" />
      </div>
    </div>
  );
}
