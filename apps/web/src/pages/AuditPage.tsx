import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Building2, FileText, FolderOpen, KeyRound, Loader2, ScrollText, ThumbsUp, Users, type LucideIcon } from "lucide-react";
import { api, formatDate, ROLE_LABELS } from "@/api";
import { EmptyState, Page, PageHeader } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface AuditItem {
  id: number;
  action: string;
  userId: string | null;
  userEmail: string | null;
  targetType: string | null;
  targetId: string | null;
  details: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
}

const CATEGORIES: { value: string; label: string; icon: LucideIcon }[] = [
  { value: "auth", label: "Accesos", icon: KeyRound },
  { value: "user", label: "Usuarios", icon: Users },
  { value: "collection", label: "Colecciones", icon: FolderOpen },
  { value: "document", label: "Documentos", icon: FileText },
  { value: "quality", label: "Calidad", icon: ThumbsUp },
  { value: "tenant", label: "Organizaciones", icon: Building2 },
];

const ACTIONS: Record<string, string> = {
  "auth.login": "Inició sesión",
  "auth.login_failed": "Intento de acceso fallido",
  "auth.password_changed": "Cambió su contraseña",
  "auth.reset_requested": "Pidió restablecer la contraseña",
  "auth.link_used": "Usó un enlace de acceso",
  "user.created": "Creó un usuario",
  "user.invited": "Invitó a un usuario",
  "user.updated": "Modificó un usuario",
  "user.link_created": "Generó un enlace de acceso",
  "collection.created": "Creó una colección",
  "collection.updated": "Modificó una colección",
  "collection.deleted": "Borró una colección",
  "collection.members_updated": "Cambió el acceso a una colección",
  "document.uploaded": "Subió un documento",
  "document.deleted": "Borró un documento",
  "document.reprocessed": "Reprocesó un documento",
  "document.summary": "Generó un resumen",
  "quality.cache_cleared": "Vació la caché de respuestas",
  "quality.feedback_resolved": "Revisó una valoración",
  "tenant.created": "Creó una organización",
  "tenant.updated": "Modificó una organización",
};

const DETAIL_LABELS: Record<string, string> = {
  email: "email",
  role: "rol",
  name: "nombre",
  filename: "archivo",
  title: "documento",
  kind: "tipo",
  emailSent: "correo enviado",
  isActive: "activo",
  passwordReset: "contraseña restablecida",
  members: "miembros",
  deletedDocuments: "documentos borrados",
  deleted: "respuestas borradas",
  resolved: "revisada",
  size: "tamaño",
  admin: "administrador",
  slug: "identificador",
  invited: "invitado",
  dailyQuestionLimit: "límite diario",
  description: "descripción",
};

const VALUE_LABELS: Record<string, string> = {
  ...ROLE_LABELS,
  invite: "invitación",
  reset: "restablecer",
};

const formatValue = (v: unknown) => (typeof v === "boolean" ? (v ? "sí" : "no") : (VALUE_LABELS[String(v)] ?? String(v)));

function Details({ details }: { details: Record<string, unknown> }) {
  const entries = Object.entries(details).filter(([k, v]) => v !== null && v !== undefined && k !== "collectionId");
  if (entries.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex max-w-md flex-wrap gap-1">
      {entries.map(([k, v]) => (
        <Badge key={k} variant="outline" className="font-normal">
          <span className="text-muted-foreground">{DETAIL_LABELS[k] ?? k}:</span> {formatValue(v)}
        </Badge>
      ))}
    </div>
  );
}

export function AuditPage() {
  const [category, setCategory] = useState("all");
  const query = useInfiniteQuery({
    queryKey: ["audit", category],
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: "50" });
      if (category !== "all") params.set("category", category);
      if (pageParam) params.set("before", String(pageParam));
      return api.get<{ items: AuditItem[]; nextBefore: number | null }>(`/audit?${params}`);
    },
    getNextPageParam: (last) => last.nextBefore,
  });
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <Page>
      <PageHeader
        title="Auditoría"
        description="Registro de las acciones importantes de tu organización: accesos, cambios de usuarios y permisos, documentos subidos o borrados…"
        actions={
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger className="w-52" aria-label="Filtrar por tipo">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas las acciones</SelectItem>
              {CATEGORIES.map((c) => (
                <SelectItem key={c.value} value={c.value}>
                  <c.icon /> {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />

      {query.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : items.length === 0 ? (
        <EmptyState icon={ScrollText} title="Sin actividad registrada" description="Las acciones aparecerán aquí a medida que se usen las funciones del sistema." />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">Fecha</TableHead>
                <TableHead>Usuario</TableHead>
                <TableHead>Acción</TableHead>
                <TableHead className="hidden lg:table-cell">Detalles</TableHead>
                <TableHead className="hidden md:table-cell">IP</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((it) => {
                const cat = CATEGORIES.find((c) => it.action.startsWith(`${c.value}.`));
                const Icon = cat?.icon ?? ScrollText;
                return (
                  <TableRow key={it.id}>
                    <TableCell className="pl-4 text-sm whitespace-nowrap text-muted-foreground">{formatDate(it.createdAt)}</TableCell>
                    <TableCell className="text-sm">{it.userEmail ?? "Sistema"}</TableCell>
                    <TableCell>
                      <span className="flex items-center gap-2 text-sm">
                        <Icon className={it.action === "auth.login_failed" ? "size-4 text-destructive" : "size-4 text-muted-foreground"} />
                        {ACTIONS[it.action] ?? it.action}
                      </span>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      <Details details={it.details} />
                    </TableCell>
                    <TableCell className="hidden font-mono text-xs text-muted-foreground md:table-cell">{it.ip ?? "—"}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {query.hasNextPage && (
        <div className="mt-4 flex justify-center">
          <Button variant="outline" onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>
            {query.isFetchingNextPage && <Loader2 className="animate-spin" />}
            Cargar más
          </Button>
        </div>
      )}
    </Page>
  );
}
