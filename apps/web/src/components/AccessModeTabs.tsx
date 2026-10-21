import { KeyRound, Send } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export type AccessMode = "invite" | "password";

/**
 * Elegir cómo obtiene acceso un usuario nuevo: invitación por enlace o contraseña inicial.
 * La invitación necesita email, así que sin él solo queda la contraseña inicial.
 */
export function AccessModeTabs({ value, onChange, inviteDisabled }: { value: AccessMode; onChange: (v: AccessMode) => void; inviteDisabled?: boolean }) {
  return (
    <Tabs value={value} onValueChange={(v) => onChange(v as AccessMode)}>
      <TabsList className="w-full">
        <TabsTrigger value="invite" className="flex-1" disabled={inviteDisabled}>
          <Send /> Enviar invitación
        </TabsTrigger>
        <TabsTrigger value="password" className="flex-1">
          <KeyRound /> Definir contraseña
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}
