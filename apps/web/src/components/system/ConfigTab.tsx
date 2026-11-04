import { SettingsGroups } from "@/components/system/SettingsForm";

/** Pestaña «Configuración»: ajustes editables del sistema (los grupos de copias viven en la pestaña «Copias»). */
export function ConfigTab() {
  return (
    // `relative`: los campos ocultos que Radix añade a Checkbox y Select dentro de un form son `absolute`; sin un
    // ancestro posicionado escapan de este scroll, alargan el documento y la página entera se desplaza.
    <div className="relative min-h-0 flex-1 overflow-y-auto">
      <SettingsGroups ids={["alerts", "email", "limits", "llm", "web", "search"]} />
    </div>
  );
}
