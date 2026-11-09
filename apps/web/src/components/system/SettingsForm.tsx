import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound, Loader2, Lock, RotateCcw, Send, Plug, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage } from "@/api";
import { InfoHint } from "@/components/common";
import { useConfirm } from "@/components/ConfirmProvider";
import { ReauthDialog, type Confirm } from "@/components/system/ReauthDialog";
import { Tag } from "@/components/system/shared";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

type Scalar = string | number | boolean;

export interface SettingField {
  key: string;
  label: string;
  help: string;
  type: "string" | "number" | "boolean" | "email" | "url" | "time" | "enum" | "secret";
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  value: Scalar | null;
  default: Scalar | null;
  lockedByEnv: boolean;
  configured: boolean;
  /** Secreto guardado que ya no se puede descifrar (cambió JWT_SECRET). */
  undecryptable?: boolean;
  restartNote?: string;
}

export interface SettingsGroup {
  id: string;
  title: string;
  description: string;
  fields: SettingField[];
}

interface SettingsResponse {
  groups: SettingsGroup[];
  /** El usuario tiene 2FA: la reconfirmación pide también el código. */
  reauth?: { totp: boolean };
  /** El correo saliente funciona (hay servidor) y las alertas tienen destinatarios con los que llegar. */
  mail?: { enabled: boolean; alerts: boolean };
}

const KEY = ["system", "settings"] as const;
// Ajustes numéricos de retención: junto al mínimo permitido se avisa de que se conservará muy poco.
const RETENTION_KEYS = new Set(["BACKUP_KEEP_DAYS", "B2_KEEP_DAYS", "AUDIT_RETENTION_DAYS", "TRASH_RETENTION_DAYS", "METRICS_RETENTION_DAYS"]);
const LOCKED_TEXT = "Fijado en el .env del servidor; quítalo de ahí para editarlo aquí";
// Un SelectItem no admite valor vacío: la opción «sin valor» se representa con este centinela.
const NONE = "__none__";

/** Los grupos de la API cuyos ids se piden, en el orden pedido. */
export function useSettingsGroups(ids: string[]) {
  const query = useQuery({ queryKey: KEY, queryFn: () => api.get<SettingsResponse>("/system/settings") });
  const groups = query.data ? ids.map((id) => query.data.groups.find((g) => g.id === id)).filter((g): g is SettingsGroup => g !== undefined) : [];
  return { ...query, groups, totp: query.data?.reauth?.totp ?? false, mail: query.data?.mail };
}

/** ¿Pide la reconfirmación el código de dos pasos? (el usuario lo tiene activo). */
export function useReauthTotp(): boolean {
  return useQuery({ queryKey: KEY, queryFn: () => api.get<SettingsResponse>("/system/settings") }).data?.reauth?.totp ?? false;
}

/** PUT /system/settings con la reconfirmación: guarda las claves indicadas (null = valor por defecto o quitar el secreto) y refresca la lista. */
function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ values, confirm }: { values: Record<string, Scalar | null>; confirm: Confirm }) =>
      api.put<SettingsResponse & { cleared?: string[] }>("/system/settings", { values, confirm }),
    onSuccess: (res) => {
      // Cambiar el servidor o el proveedor borra el secreto que iba con él: se dice cuál.
      const fields = qc.getQueryData<SettingsResponse>(KEY)?.groups.flatMap((g) => g.fields) ?? [];
      for (const key of res.cleared ?? []) {
        const label = fields.find((f) => f.key === key)?.label ?? key;
        toast.warning(`Se quitó «${label}» porque cambiaste el servidor o el proveedor; vuelve a escribirla.`);
      }
      return qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

/** Pide guardar `values`; abre la reconfirmación y, al salir bien, ejecuta `done`. */
type Ask = (values: Record<string, Scalar | null>, done: () => void) => void;

const effective = (f: SettingField): Scalar => f.value ?? f.default ?? (f.type === "boolean" ? false : "");
const asDraft = (f: SettingField): string | boolean => {
  const v = effective(f);
  return f.type === "boolean" ? v === true : String(v);
};

/** Valor del formulario → lo que espera la API; vacío = volver al valor por defecto. */
function toApi(f: SettingField, v: string | boolean): Scalar | null {
  if (f.type === "boolean") return v === true;
  const text = String(v).trim();
  if (text === "") return null;
  return f.type === "number" ? Number(text) : text;
}

/** Cambiar el valor de un secreto: se escribe aquí y nunca se vuelve a mostrar. */
function SecretDialog({ field, onClose, ask }: { field: SettingField | null; onClose: () => void; ask: Ask }) {
  return (
    <Dialog open={field !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">{field && <SecretForm field={field} onClose={onClose} ask={ask} />}</DialogContent>
    </Dialog>
  );
}

function SecretForm({ field, onClose, ask }: { field: SettingField; onClose: () => void; ask: Ask }) {
  const [value, setValue] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    ask({ [field.key]: value }, () => {
      toast.success("Guardado");
      onClose();
    });
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      <DialogHeader>
        <DialogTitle>{field.label}</DialogTitle>
        <DialogDescription>El valor se guarda cifrado y no se vuelve a mostrar.</DialogDescription>
      </DialogHeader>
      <Input type="password" autoComplete="new-password" autoFocus value={value} onChange={(e) => setValue(e.target.value)} aria-label={field.label} />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancelar
        </Button>
        <Button type="submit" disabled={value === ""}>
          Guardar
        </Button>
      </DialogFooter>
    </form>
  );
}

function FieldLabel({ field }: { field: SettingField }) {
  const note = [field.help, field.restartNote].filter(Boolean);
  return (
    <div className="flex min-h-7 items-center gap-1">
      <Label htmlFor={field.key}>{field.label}</Label>
      {note.length > 0 && (
        <InfoHint title={field.label}>
          {note.map((t) => (
            <p key={t}>{t}</p>
          ))}
        </InfoHint>
      )}
    </div>
  );
}

function SecretField({ field, onChange, ask, busy }: { field: SettingField; onChange: () => void; ask: Ask; busy: boolean }) {
  const confirm = useConfirm();
  const remove = async () => {
    if (!(await confirm({ title: `¿Quitar «${field.label}»?`, description: "Se borrará el valor guardado.", confirmText: "Quitar", destructive: true }))) return;
    ask({ [field.key]: null }, () => toast.success("Quitado"));
  };
  return (
    <div className="space-y-1.5">
      <FieldLabel field={field} />
      <div className="flex flex-wrap items-center gap-2">
        {field.undecryptable ? (
          <Tag tone="warn">No se puede leer (cambió JWT_SECRET): vuelve a escribirla</Tag>
        ) : (
          <Tag tone={field.configured ? "ok" : "muted"}>{field.configured ? "Configurada" : "Sin configurar"}</Tag>
        )}
        {field.lockedByEnv ? (
          <LockedNote />
        ) : (
          <>
            <Button type="button" variant="outline" size="sm" onClick={onChange}>
              <KeyRound /> Cambiar
            </Button>
            {field.configured && (
              <Button type="button" variant="ghost" size="sm" onClick={remove} disabled={busy}>
                Quitar
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function LockedNote() {
  return (
    <p className="flex items-center gap-1 text-xs text-muted-foreground">
      <Lock className="size-3 shrink-0" /> {LOCKED_TEXT}
    </p>
  );
}

function ScalarField({ field, draft, onDraft, onReset, busy }: { field: SettingField; draft: string | boolean; onDraft: (v: string | boolean) => void; onReset: () => void; busy: boolean }) {
  const locked = field.lockedByEnv;
  const reset = !locked && field.value !== null && (
    <Button type="button" variant="ghost" size="icon" className="size-7 text-muted-foreground" aria-label={`Restablecer ${field.label}`} title="Restablecer al valor por defecto" onClick={onReset} disabled={busy}>
      <RotateCcw />
    </Button>
  );

  if (field.type === "boolean") {
    return (
      // Misma altura que un campo con título + caja (la fila de arriba queda vacía): la casilla cae a la altura de las cajas
      // de los campos vecinos en vez de a la de sus títulos.
      <div className="space-y-1.5">
        <div aria-hidden className="hidden min-h-7 md:block" />
        <div className="flex min-h-9 items-center gap-2">
          <Checkbox id={field.key} checked={draft === true} disabled={locked} onCheckedChange={(c) => onDraft(c === true)} />
          <Label htmlFor={field.key}>{field.label}</Label>
          {(field.help || field.restartNote) && (
            <InfoHint title={field.label}>
              {[field.help, field.restartNote].filter(Boolean).map((t) => (
                <p key={t}>{t}</p>
              ))}
            </InfoHint>
          )}
          {reset}
        </div>
        {locked && <LockedNote />}
      </div>
    );
  }

  const text = String(draft);
  const num = text.trim() === "" ? null : Number(text);
  const warning =
    field.key === "IP_RATE_LIMIT_PER_MIN" && num === 0
      ? "Sin freno por IP para peticiones sin sesión."
      : RETENTION_KEYS.has(field.key) && num !== null && field.min !== undefined && num === field.min
        ? "Valor mínimo permitido: se conservará muy poco tiempo."
        : null;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-1">
        <FieldLabel field={field} />
        {reset}
      </div>
      {field.type === "enum" ? (
        <Select value={text === "" ? NONE : text} onValueChange={(v) => onDraft(v === NONE ? "" : v)} disabled={locked}>
          <SelectTrigger id={field.key} className="w-full" aria-label={field.label}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(field.options ?? []).map((o) => (
              <SelectItem key={o.value} value={o.value === "" ? NONE : o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <div className="relative">
          <Input
            id={field.key}
            type={field.type === "number" ? "number" : field.type === "time" ? "time" : field.type === "email" ? "email" : field.type === "url" ? "url" : "text"}
            inputMode={field.type === "number" ? "decimal" : undefined}
            min={field.min}
            max={field.max}
            step={field.step}
            disabled={locked}
            value={text}
            onChange={(e) => onDraft(e.target.value)}
            className={field.unit ? "pr-16" : undefined}
          />
          {field.unit && <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">{field.unit}</span>}
        </div>
      )}
      {locked && <LockedNote />}
      {warning && <p className="text-xs text-warning">{warning}</p>}
    </div>
  );
}

const APPLY_NOTE: Record<string, string> = { backup: "Guardado. El servicio de copias lo aplica en unos minutos.", b2: "Guardado. El servicio de B2 lo aplica en unos minutos." };

function GroupForm({ group, totp, extra, status }: { group: SettingsGroup; totp: boolean; extra?: React.ReactNode; status?: React.ReactNode }) {
  const [edited, setEdited] = useState<Record<string, string | boolean>>({});
  const [secret, setSecret] = useState<SettingField | null>(null);
  // Guardado a la espera de la reconfirmación de identidad.
  const [request, setRequest] = useState<{ values: Record<string, Scalar | null>; done: () => void } | null>(null);
  const save = useSaveSettings();
  const dirty = group.fields.filter((f) => f.type !== "secret" && !f.lockedByEnv && f.key in edited && edited[f.key] !== asDraft(f));

  const ask: Ask = (values, done) => setRequest({ values, done });
  const confirmSave = async (confirm: Confirm) => {
    if (!request) return;
    await save.mutateAsync({ values: request.values, confirm });
    request.done();
    setRequest(null);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const values = Object.fromEntries(dirty.map((f) => [f.key, toApi(f, edited[f.key]!)]));
    ask(values, () => {
      setEdited({});
      toast.success(APPLY_NOTE[group.id] ?? "Guardado");
    });
  };
  const reset = (f: SettingField) => ask({ [f.key]: null }, () => setEdited(({ [f.key]: _, ...rest }) => rest));
  const busy = request !== null;

  return (
    <>
      <form id={`ajustes-${group.id}`} onSubmit={submit} className="scroll-mt-4 rounded-xl border bg-card p-4">
        <div className="mb-4 flex items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <div className="flex items-center gap-1">
              <h2 className="text-sm font-semibold">{group.title}</h2>
              {group.description && <InfoHint title={group.title}>{group.description}</InfoHint>}
            </div>
            {status}
          </div>
          <Button type="submit" size="sm" disabled={dirty.length === 0 || busy}>
            Guardar
          </Button>
        </div>
        <div className="grid items-start gap-x-4 gap-y-4 md:grid-cols-2 xl:grid-cols-3">
          {group.fields.map((f) =>
            f.type === "secret" ? (
              <SecretField key={f.key} field={f} onChange={() => setSecret(f)} ask={ask} busy={busy} />
            ) : (
              <ScalarField key={f.key} field={f} draft={f.key in edited ? edited[f.key]! : asDraft(f)} onDraft={(v) => setEdited((s) => ({ ...s, [f.key]: v }))} onReset={() => reset(f)} busy={busy} />
            ),
          )}
        </div>
        {extra && <div className="mt-4 flex flex-wrap items-center gap-2 border-t pt-4">{extra}</div>}
      </form>
      {/* Fuera del <form>: los eventos de React suben por los portales y un submit interno enviaría el formulario del grupo. */}
      <SecretDialog field={secret} onClose={() => setSecret(null)} ask={ask} />
      <ReauthDialog open={request !== null} onCancel={() => setRequest(null)} totp={totp} onConfirm={confirmSave} />
    </>
  );
}

/** Resultado de una prueba (correo o proveedor): el servidor responde { ok, message }. */
function useTest(path: string) {
  return useMutation({
    mutationFn: (body: object) => api.post<{ ok: boolean; message: string }>(path, body),
    onSuccess: (r) => (r.ok ? toast.success(r.message || "Correcto") : toast.error(r.message || "Falló la prueba")),
    onError: (err) => toast.error(errorMessage(err)),
  });
}

function EmailTest() {
  const test = useTest("/system/settings/test-email");
  return (
    <Button type="button" variant="outline" size="sm" onClick={() => test.mutate({})} disabled={test.isPending}>
      {test.isPending ? <Loader2 className="animate-spin" /> : <Send />} Enviar correo de prueba
    </Button>
  );
}

// Identificador de proveedor que espera /system/settings/test-llm para cada ajuste del grupo «llm».
const PROVIDERS: { id: string; label: string; keyVar: string }[] = [
  { id: "openrouter", label: "OpenRouter", keyVar: "OPENROUTER_API_KEY" },
  { id: "groq", label: "Groq", keyVar: "GROQ_API_KEY" },
  { id: "google", label: "Google", keyVar: "GOOGLE_API_KEY" },
  { id: "openai", label: "OpenAI", keyVar: "OPENAI_API_KEY" },
  { id: "deepseek", label: "DeepSeek", keyVar: "DEEPSEEK_API_KEY" },
  { id: "custom", label: "Servidor propio", keyVar: "LLM_CUSTOM_BASE_URL" },
];

function LlmTests({ group }: { group: SettingsGroup }) {
  const test = useTest("/system/settings/test-llm");
  const [running, setRunning] = useState<string | null>(null);
  const ready = PROVIDERS.filter((p) => {
    const f = group.fields.find((x) => x.key === p.keyVar);
    return f && (f.type === "secret" ? f.configured : Boolean(effective(f)));
  });
  if (ready.length === 0) return <p className="text-xs text-muted-foreground">Configura una clave para poder probar la conexión.</p>;
  return (
    <>
      {ready.map((p) => (
        <Button key={p.id} type="button" variant="outline" size="sm" disabled={test.isPending} onClick={() => { setRunning(p.id); test.mutate({ provider: p.id }, { onSettled: () => setRunning(null) }); }}>
          {running === p.id ? <Loader2 className="animate-spin" /> : <Plug />} Probar {p.label}
        </Button>
      ))}
    </>
  );
}

/** Formularios de ajustes de los grupos indicados (pestañas Configuración y Copias). */
const IMPORT_COMMAND = "docker compose exec api node dist/scripts/import-env-settings.js";

/** Aviso cuando hay ajustes fijados en el .env: la orden que los pasa a la base para poder editarlos aquí. */
function LockedBanner({ count }: { count: number }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(IMPORT_COMMAND);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("No se pudo copiar; selecciona la orden y cópiala a mano");
    }
  };
  return (
    <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
      <div className="min-w-0 space-y-2">
        <p className="text-muted-foreground">
          {count === 1 ? "1 ajuste está fijado" : `${count} ajustes están fijados`} en el archivo de entorno del servidor y no se pueden editar aquí (candado). Para pasarlos a esta pantalla sin perder su valor, ejecuta en el servidor esta orden y luego quita del archivo de entorno las líneas que te indique:
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <code className="rounded border bg-muted px-2 py-1 font-mono text-xs break-all">{IMPORT_COMMAND}</code>
          <Button type="button" size="sm" variant="outline" onClick={copy}>
            {copied ? <Check /> : <Copy />} {copied ? "Copiada" : "Copiar"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function SettingsGroups({ ids }: { ids: string[] }) {
  const { groups, totp, mail, isLoading, isError, error } = useSettingsGroups(ids);
  if (isLoading) return <Skeleton className="h-48 w-full" />;
  if (isError) return <p className="text-sm text-destructive">{errorMessage(error)}</p>;
  const locked = groups.reduce((n, g) => n + g.fields.filter((f) => f.lockedByEnv).length, 0);
  // Estado al lado del título: sin servidor SMTP no sale ningún correo; sin destinatarios, las alertas solo se ven en Sistema.
  const status = (id: string) => {
    if (!mail) return undefined;
    if (id === "email") return mail.enabled ? <Tag tone="ok">Activo</Tag> : <Tag tone="warn">Desactivado: falta el servidor</Tag>;
    if (id === "alerts" && !mail.alerts) return <Tag tone="warn">{`${mail.enabled ? "Sin destinatarios" : "Sin correo saliente"}: solo en Sistema → Alertas`}</Tag>;
    return undefined;
  };
  return (
    <div className="space-y-4">
      {locked > 0 && <LockedBanner count={locked} />}
      {groups.map((g) => (
        <GroupForm key={g.id} group={g} totp={totp} status={status(g.id)} extra={g.id === "email" ? <EmailTest /> : g.id === "llm" ? <LlmTests group={g} /> : undefined} />
      ))}
    </div>
  );
}
