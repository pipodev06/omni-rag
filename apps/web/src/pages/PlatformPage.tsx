import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, formatDate } from "../api";

interface TenantRow {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
  dailyQuestionLimit: number | null;
  createdAt: string;
  users: number;
  documents: number;
}

export function PlatformPage() {
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [form, setForm] = useState({ name: "", slug: "", adminName: "", adminEmail: "", adminPassword: "" });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    setTenants((await api.get<{ tenants: TenantRow[] }>("/platform/tenants")).tenants);
  }, []);
  useEffect(() => void load(), [load]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.post("/platform/tenants", {
        name: form.name,
        slug: form.slug,
        admin: { name: form.adminName, email: form.adminEmail, password: form.adminPassword },
      });
      setMsg({ ok: true, text: `Organización «${form.name}» creada. Comparte las credenciales con su administrador.` });
      setForm({ name: "", slug: "", adminName: "", adminEmail: "", adminPassword: "" });
      void load();
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : "Error" });
    }
  };

  const patch = async (t: TenantRow, body: object) => {
    try {
      await api.patch(`/platform/tenants/${t.id}`, body);
      void load();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Error");
    }
  };

  const editLimit = (t: TenantRow) => {
    const v = prompt("Preguntas por día (vacío = valor global, 0 = sin límite):", t.dailyQuestionLimit?.toString() ?? "");
    if (v === null) return;
    void patch(t, { dailyQuestionLimit: v.trim() === "" ? null : Number(v) });
  };

  const slugify = (s: string) =>
    s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

  return (
    <div className="page">
      <h1>Organizaciones (clientes)</h1>
      <table className="table">
        <thead>
          <tr>
            <th>Organización</th>
            <th>Usuarios</th>
            <th>Documentos</th>
            <th>Límite diario</th>
            <th>Creada</th>
            <th>Estado</th>
          </tr>
        </thead>
        <tbody>
          {tenants.map((t) => (
            <tr key={t.id} className={t.isActive ? "" : "inactive"}>
              <td>
                {t.name}
                <div className="muted tiny">{t.slug}</div>
              </td>
              <td>{t.users}</td>
              <td>{t.documents}</td>
              <td>
                <button className="link" onClick={() => editLimit(t)}>
                  {t.dailyQuestionLimit ?? "global"}
                </button>
              </td>
              <td className="small">{formatDate(t.createdAt)}</td>
              <td>
                <button className="link" onClick={() => void patch(t, { isActive: !t.isActive })}>
                  {t.isActive ? "Activa (desactivar)" : "Inactiva (activar)"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <form className="card narrow" onSubmit={create}>
        <h2>Nueva organización</h2>
        <label>
          Nombre
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value, slug: slugify(e.target.value) })}
            required
          />
        </label>
        <label>
          Identificador (slug)
          <input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} pattern="[a-z0-9][a-z0-9-]{1,62}" required />
        </label>
        <label>
          Nombre del administrador
          <input value={form.adminName} onChange={(e) => setForm({ ...form, adminName: e.target.value })} required />
        </label>
        <label>
          Email del administrador
          <input type="email" value={form.adminEmail} onChange={(e) => setForm({ ...form, adminEmail: e.target.value })} required />
        </label>
        <label>
          Contraseña inicial
          <input value={form.adminPassword} onChange={(e) => setForm({ ...form, adminPassword: e.target.value })} minLength={10} required />
        </label>
        {msg && <div className={msg.ok ? "success" : "error"}>{msg.text}</div>}
        <button className="primary">Crear organización</button>
      </form>
    </div>
  );
}
