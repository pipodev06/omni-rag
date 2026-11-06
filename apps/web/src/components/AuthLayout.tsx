import type { ComponentProps, ReactNode } from "react";
import { FileSearch, Quote, ShieldCheck, type LucideIcon } from "lucide-react";
import { Logo } from "@/components/common";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const FEATURES = [
  { icon: FileSearch, title: "Pregunta a tus documentos", text: "PDF, Word, Excel, presentaciones e imágenes escaneadas." },
  { icon: Quote, title: "Respuestas con fuentes", text: "Cada respuesta cita el documento y la página de donde sale." },
  { icon: ShieldCheck, title: "Acceso controlado", text: "Cada persona solo ve los documentos que le corresponden." },
];

/** Diseño de las pantallas sin sesión (login y configuración inicial): formulario a la izquierda, panel azul tinta a la derecha. */
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-full lg:grid-cols-2">
      <div className="flex flex-col p-6 sm:p-10">
        <Logo />
        <div className="flex flex-1 items-center justify-center py-10">{children}</div>
      </div>

      <div className="hidden bg-[oklch(0.25_0.06_258)] p-10 text-white lg:flex lg:flex-col lg:justify-center">
        <div className="mx-auto max-w-md space-y-8">
          <h2 className="text-3xl font-semibold tracking-tight">
            El conocimiento de tu organización, a{" "}
            <span className="rounded-sm bg-gradient-to-t from-highlight from-15% to-transparent to-15% px-0.5 box-decoration-clone">una pregunta</span>{" "}
            de distancia.
          </h2>
          <ul className="space-y-5">
            {FEATURES.map((f) => (
              <li key={f.title} className="flex gap-4">
                <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-white/10">
                  <f.icon className="size-5 text-[oklch(0.82_0.08_250)]" />
                </div>
                <div>
                  <p className="font-medium">{f.title}</p>
                  <p className="text-sm text-white/70">{f.text}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

/** Campo con icono a la izquierda de las pantallas sin sesión. */
export function IconInput({ icon: Icon, className, ...props }: ComponentProps<typeof Input> & { icon: LucideIcon }) {
  return (
    <div className="relative">
      <Icon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input className={cn("pl-9", className)} {...props} />
    </div>
  );
}

/** Mensaje de error de un formulario sin sesión. */
export function FormError({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      {children}
    </p>
  );
}
