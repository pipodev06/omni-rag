import { SettingsGroups } from "@/components/system/SettingsForm";

/** Pestaña «Configuración»: ajustes editables del sistema (los grupos de copias viven en la pestaña «Copias»). */
export function ConfigTab() {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <SettingsGroups ids={["alerts", "email", "limits", "llm", "web", "search"]} />
    </div>
  );
}
