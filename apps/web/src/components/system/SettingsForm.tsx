import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Loader2, Lock, RotateCcw, Send, Plug } from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage } from "@/api";
import { InfoHint } from "@/components/common";
import { useConfirm } from "@/components/ConfirmProvider";
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
  restartNote?: string;
}

export interface SettingsGroup {
  id: string;
  title: string;
  description: string;
  fields: SettingField[];
}

const KEY = ["system", "settings"] as const;
const LOCKED_TEXT = "Fijado en el .env del servidor; quítalo de ahí para editarlo aquí";
// Un SelectItem no admite valor vacío: la opción «sin valor» se representa con este centinela.
const NONE = "__none__";

/** Los grupos de la API cuyos ids se piden, en el orden pedido. */
export function useSettingsGroups(ids: string[]) {
  const query = useQuery({ queryKey: KEY, queryFn: () => api.get<{ groups: SettingsGroup[] }>("/system/settings") });
  const groups = query.data ? ids.map((id) => query.data.groups.find((g) => g.id === id)).filter((g): g is SettingsGroup => g !== undefined) : [];
  return { ...query, groups };
}

/** PUT /system/settings: guarda las claves indicadas (null = valor por defecto o quitar el secreto) y refresca la lista. */
function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (values: Record<string, Scalar | null>) => api.put<{ groups: SettingsGroup[] }>("/system/settings", { values }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
    onError: (err) => toast.error(errorMessage(err)),
  });
}

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
function SecretDialog({ field, onClose }: { field: SettingField | null; onClose: () => void }) {
  return (
    <Dialog open={field !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">{field && <SecretForm field={field} onClose={onClose} />}</DialogContent>
    </Dialog>
  );
}

function SecretForm({ field, onClose }: { field: SettingField; onClose: () => void }) {
  const [value, setValue] = useState("");
  const save = useSaveSettings();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ [field.key]: value }, { onSuccess: () => { toast.success("Guardado"); onClose(); } });
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
        <Button type="submit" disabled={value === "" || save.isPending}>
          {save.isPending && <Loader2 className="animate-spin" />} Guardar
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

function SecretField({ field, onChange }: { field: SettingField; onChange: () => void }) {
  const save = useSaveSettings();
  const confirm = useConfirm();
  const remove = async () => {
    if (!(await confirm({ title: `¿Quitar «${field.label}»?`, description: "Se borrará el valor guardado.", confirmText: "Quitar", destructive: true }))) return;
    save.mutate({ [field.key]: null }, { onSuccess: () => toast.success("Quitado") });
  };
  return (
    <div className="space-y-1.5">
      <FieldLabel field={field} />
      <div className="flex flex-wrap items-center gap-2">
        <Tag tone={field.configured ? "ok" : "muted"}>{field.configured ? "Configurada" : "Sin configurar"}</Tag>
        {field.lockedByEnv ? (
          <LockedNote />
        ) : (
          <>
            <Button type="button" variant="outline" size="sm" onClick={onChange}>
              <KeyRound /> Cambiar
            </Button>
            {field.configured && (
              <Button type="button" variant="ghost" size="sm" onClick={remove} disabled={save.isPending}>
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
      <div className="space-y-1.5">
        <div className="flex min-h-7 items-center gap-2">
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
    </div>
  );
}

const APPLY_NOTE: Record<string, string> = { backup: "Guardado. El servicio de copias lo aplica en unos minutos.", b2: "Guardado. El servicio de B2 lo aplica en unos minutos." };

function GroupForm({ group, extra }: { group: SettingsGroup; extra?: React.ReactNode }) {
  const [edited, setEdited] = useState<Record<string, string | boolean>>({});
  const [secret, setSecret] = useState<SettingField | null>(null);
  const save = useSaveSettings();
  const dirty = group.fields.filter((f) => f.type !== "secret" && !f.lockedByEnv && f.key in edited && edited[f.key] !== asDraft(f));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const values = Object.fromEntries(dirty.map((f) => [f.key, toApi(f, edited[f.key]!)]));
    save.mutate(values, {
      onSuccess: () => {
        setEdited({});
        toast.success(APPLY_NOTE[group.id] ?? "Guardado");
      },
    });
  };
  const reset = (f: SettingField) =>
    save.mutate({ [f.key]: null }, { onSuccess: () => setEdited(({ [f.key]: _, ...rest }) => rest) });

  return (
    <form onSubmit={submit} className="rounded-xl border bg-card p-4">
      <div className="mb-4 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <h2 className="text-sm font-semibold">{group.title}</h2>
          {group.description && <InfoHint title={group.title}>{group.description}</InfoHint>}
        </div>
        <Button type="submit" size="sm" disabled={dirty.length === 0 || save.isPending}>
          {save.isPending && <Loader2 className="animate-spin" />} Guardar
        </Button>
      </div>
      <div className="grid items-start gap-x-4 gap-y-4 md:grid-cols-2 xl:grid-cols-3">
        {group.fields.map((f) =>
          f.type === "secret" ? (
            <SecretField key={f.key} field={f} onChange={() => setSecret(f)} />
          ) : (
            <ScalarField key={f.key} field={f} draft={f.key in edited ? edited[f.key]! : asDraft(f)} onDraft={(v) => setEdited((s) => ({ ...s, [f.key]: v }))} onReset={() => reset(f)} busy={save.isPending} />
          ),
        )}
      </div>
      {extra && <div className="mt-4 flex flex-wrap items-center gap-2 border-t pt-4">{extra}</div>}
      <SecretDialog field={secret} onClose={() => setSecret(null)} />
    </form>
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
export function SettingsGroups({ ids }: { ids: string[] }) {
  const { groups, isLoading, isError, error } = useSettingsGroups(ids);
  if (isLoading) return <Skeleton className="h-48 w-full" />;
  if (isError) return <p className="text-sm text-destructive">{errorMessage(error)}</p>;
  return (
    <div className="space-y-4">
      {groups.map((g) => (
        <GroupForm key={g.id} group={g} extra={g.id === "email" ? <EmailTest /> : g.id === "llm" ? <LlmTests group={g} /> : undefined} />
      ))}
    </div>
  );
}
