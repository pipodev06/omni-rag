import { useState, type FormEvent } from "react";
import { api } from "../api";

export function AccountPage() {
  const [currentPassword, setCurrent] = useState("");
  const [newPassword, setNew] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.post("/auth/change-password", { currentPassword, newPassword });
      setMsg({ ok: true, text: "Contraseña actualizada" });
      setCurrent("");
      setNew("");
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : "Error" });
    }
  };

  return (
    <div className="page">
      <h1>Mi cuenta</h1>
      <form className="card narrow" onSubmit={submit}>
        <h2>Cambiar contraseña</h2>
        <label>
          Contraseña actual
          <input type="password" value={currentPassword} onChange={(e) => setCurrent(e.target.value)} required />
        </label>
        <label>
          Nueva contraseña (mín. 10 caracteres)
          <input type="password" value={newPassword} onChange={(e) => setNew(e.target.value)} minLength={10} required />
        </label>
        {msg && <div className={msg.ok ? "success" : "error"}>{msg.text}</div>}
        <button className="primary">Guardar</button>
      </form>
    </div>
  );
}
