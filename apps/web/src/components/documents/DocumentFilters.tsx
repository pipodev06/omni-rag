import { FilterX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DEFAULT_VIEW, isFiltered, type DocumentView, type StatusFilter } from "@/lib/documentView";

const STATUS_LABELS: Record<StatusFilter, string> = { all: "Todos los estados", ready: "Listos", busy: "En proceso", failed: "Con error" };

/** Filtros por estado y por tipo de archivo de la lista de documentos. */
export function DocumentFilters({ view, types, onChange }: { view: DocumentView; types: string[]; onChange: (v: DocumentView) => void }) {
  return (
    <div className="flex items-center gap-2">
      <Select value={view.status} onValueChange={(status) => onChange({ ...view, status: status as StatusFilter })}>
        <SelectTrigger className="w-44" aria-label="Filtrar por estado">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(STATUS_LABELS) as StatusFilter[]).map((s) => (
            <SelectItem key={s} value={s}>
              {STATUS_LABELS[s]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={view.type} onValueChange={(type) => onChange({ ...view, type })} disabled={types.length === 0}>
        <SelectTrigger className="w-40" aria-label="Filtrar por tipo">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Todos los tipos</SelectItem>
          {types.map((t) => (
            <SelectItem key={t} value={t}>
              {t.toUpperCase()}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {isFiltered(view) && (
        <Button
          variant="ghost"
          size="icon"
          title="Quitar filtros"
          aria-label="Quitar filtros"
          onClick={() => onChange({ ...DEFAULT_VIEW, sort: view.sort })}
        >
          <FilterX />
        </Button>
      )}
    </div>
  );
}
