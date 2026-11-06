import type { ReactNode } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Circle, Plus } from "lucide-react";
import { api } from "@/api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface Onboarding {
  llm: boolean;
  /** Planes con modelos de un proveedor sin clave. */
  plansWithoutKey: string[];
  email: boolean;
  alertEmail: boolean;
  b2: boolean;
  tenants: number;
}

function Step({ done, title, children, action, optional }: { done: boolean; title: string; children: ReactNode; action?: ReactNode; optional?: boolean }) {
  const Icon = done ? CheckCircle2 : Circle;
  return (
    <li className="flex gap-3 border-b py-4 last:border-b-0">
      <Icon className={cn("mt-0.5 size-5 shrink-0", done ? "text-success" : "text-muted-foreground")} />
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          {title}
          {optional && <span className="ml-2 text-xs font-normal text-muted-foreground">Opcional</span>}
        </p>
        <p className="text-sm text-muted-foreground">{children}</p>
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </li>
  );
}

/**
 * Lo que queda por hacer después de la configuración inicial. Se muestra en Organizaciones mientras no haya ninguna:
 * primero lo imprescindible (un proveedor de modelos de lenguaje), luego lo recomendado y al final la primera organización.
 */
export function FirstSteps({ onCreateOrg, onOpenPlans }: { onCreateOrg: () => void; onOpenPlans: () => void }) {
  const { data } = useQuery({ queryKey: ["system", "onboarding"], queryFn: () => api.get<Onboarding>("/system/onboarding") });
  if (!data) return <Skeleton className="h-64 w-full" />;
  const go = (to: string, label: string) => (
    <Button asChild size="sm" variant="outline">
      <Link to={to}>{label}</Link>
    </Button>
  );

  return (
    <div className="relative min-h-0 flex-1 overflow-y-auto">
      <div className="rounded-xl border bg-card px-5">
        <div className="border-b py-4">
          <h2 className="font-semibold">Primeros pasos</h2>
          <p className="text-sm text-muted-foreground">Omni RAG ya funciona con valores por defecto. Completa esto antes de dar acceso a nadie (detalle en docs/configuracion-inicial.md).</p>
        </div>
        <ol>
          <Step done title="Cuenta de superadministrador">
            Creada. Activa la verificación en dos pasos en Mi cuenta: con un dominio público es obligatoria.
          </Step>
          <Step done={data.llm} title="Modelo de lenguaje" action={!data.llm && go("/sistema/configuracion", "Configurar")}>
            Imprescindible para responder: escribe la clave de al menos un proveedor (Groq y Google tienen capa gratuita; también OpenRouter, OpenAI, DeepSeek o un servidor propio). Los documentos se leen y se buscan en el propio servidor; al modelo solo van la pregunta y los fragmentos encontrados.
          </Step>
          <Step done={data.llm && data.plansWithoutKey.length === 0} title="Modelos de los planes" action={
              data.plansWithoutKey.length > 0 && (
                <Button size="sm" variant="outline" onClick={onOpenPlans}>
                  Revisar
                </Button>
              )
            }>
            {data.plansWithoutKey.length > 0
              ? `El plan ${data.plansWithoutKey.map((n) => `«${n}»`).join(", ")} usa modelos de un proveedor sin clave. En la pestaña Planes escribe modelos del proveedor que configuraste, con su prefijo («groq:…», «google:…»; al guardar se comprueba que existan), o escribe la clave que falta.`
              : "Cada plan usa modelos de un proveedor con clave. El primero de la lista es el principal; los demás, respaldos si falla."}
          </Step>
          <Step done={data.email} optional title="Correo saliente" action={!data.email && go("/sistema/configuracion", "Configurar")}>
            Para invitar usuarios, recuperar contraseñas y recibir alertas. Sin correo, el administrador copia los enlaces a mano.
          </Step>
          <Step done={data.alertEmail} optional title="Correo de alertas" action={!data.alertEmail && go("/sistema/configuracion", "Configurar")}>
            A quién avisar si falla una copia, se llena el disco o un modelo deja de responder.
          </Step>
          <Step done={data.b2} optional title="Copias fuera del servidor" action={!data.b2 && go("/sistema/copias", "Configurar")}>
            Las copias diarias ya se hacen en el servidor. Recomendado: una copia cifrada en Backblaze B2 o en otro disco, por si se pierde el servidor.
          </Step>
          <Step
            done={data.tenants > 0}
            title="Primera organización"
            action={
              <Button size="sm" onClick={onCreateOrg}>
                <Plus /> Nueva organización
              </Button>
            }
          >
            Cada cliente o área tiene su propia organización, con sus usuarios y documentos aislados. Tú entras en ellas con «Entrar como soporte».
          </Step>
        </ol>
      </div>
    </div>
  );
}
