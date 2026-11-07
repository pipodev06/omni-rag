import { SettingsGroups, useSettingsGroups } from "@/components/system/SettingsForm";

const IDS = ["alerts", "email", "limits", "llm", "web", "search"];

/** Pestaña «Configuración»: índice de grupos a la izquierda y los ajustes editables (los de copias viven en «Copias»). */
export function ConfigTab() {
  const { groups } = useSettingsGroups(IDS);
  const go = (id: string) => document.getElementById(`ajustes-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  return (
    // `relative`: los campos ocultos que Radix añade a Checkbox y Select dentro de un form son `absolute`; sin un
    // ancestro posicionado escapan de este scroll, alargan el documento y la página entera se desplaza.
    <div className="relative min-h-0 flex-1 overflow-y-auto">
      <div className="grid items-start gap-4 lg:grid-cols-[11rem_1fr]">
        <nav aria-label="Grupos de ajustes" className="sticky top-0 hidden lg:block">
          <ul className="space-y-0.5 text-sm">
            {groups.map((g) => (
              <li key={g.id}>
                <button type="button" onClick={() => go(g.id)} className="w-full rounded-md px-2 py-1.5 text-left text-muted-foreground hover:bg-accent hover:text-foreground">
                  {g.title}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <SettingsGroups ids={IDS} />
      </div>
    </div>
  );
}
