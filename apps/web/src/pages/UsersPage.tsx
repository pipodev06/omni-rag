import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, formatDate, ROLE_LABELS, type Collection, type Role, type TenantUser, type User } from "../api";

export function UsersPage({ me }: { me: User }) {
  const [users, setUsers] = useState<TenantUser[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [showNew, setShowNew] = useState(false);

  const load = useCallback(async () => {
    const [u, c] = await Promise.all([
      api.get<{ users: TenantUser[] }>("/users"),
      api.get<{ collections: Collection[] }>("/collections"),
    ]);
    setUsers(u.users);
    setCollections(c.collections);
  }, []);
  useEffect(() => void load(), [load]);

  const update = async (u: TenantUser, patch: Partial<{ role: Role; isActive: boolean; password: string }>) => {
    try {
      await api.patch(`/users/${u.id}`, patch);
      void load();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Error");
    }
  };

  const resetPassword = (u: TenantUser) => {
    const password = prompt(`Nueva contraseña para ${u.email} (mín. 10 caracteres):`);
    if (password) void update(u, { password });
  };

  const colName = (id: string) => collections.find((c) => c.id === id)?.name ?? "?";

  return (
    <div className="page">
      <div className="page-head">
        <h1>Usuarios</h1>
        <button className="primary" onClick={() => setShowNew(true)}>
          + Nuevo usuario
        </button>
      </div>
      <div className="card small muted">
        <b>Administrador</b>: gestiona usuarios, colecciones y todos los documentos. <b>Editor</b>: sube y borra documentos en
        sus colecciones. <b>Lector</b>: solo pregunta sobre sus colecciones.
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Usuario</th>
            <th>Rol</th>
            <th>Colecciones</th>
            <th>Último acceso</th>
            <th>Estado</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className={u.isActive ? "" : "inactive"}>
              <td>
                {u.name}
                <div className="muted tiny">{u.email}</div>
              </td>
              <td>
                <select
                  value={u.role}
                  disabled={u.id === me.id}
                  onChange={(e) => void update(u, { role: e.target.value as Role })}
                >
                  {Object.entries(ROLE_LABELS).map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </td>
              <td className="small">{u.role === "admin" ? <span className="muted">Todas</span> : u.collectionIds.map(colName).join(", ") || "—"}</td>
              <td className="small">{formatDate(u.lastLoginAt)}</td>
              <td>{u.isActive ? "Activo" : "Desactivado"}</td>
              <td className="actions">
                <button className="link" onClick={() => resetPassword(u)}>
                  Contraseña
                </button>
                {u.id !== me.id && (
                  <button className="link" onClick={() => void update(u, { isActive: !u.isActive })}>
                    {u.isActive ? "Desactivar" : "Activar"}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">El acceso a cada colección se gestiona desde la página Documentos → «Gestionar acceso».</p>
      {showNew && (
        <NewUserDialog
          collections={collections}
          onClose={(changed) => {
            setShowNew(false);
            if (changed) void load();
          }}
        />
      )}
    </div>
  );
}

function NewUserDialog({ collections, onClose }: { collections: Collection[]; onClose: (changed: boolean) => void }) {
  const [form, setForm] = useState({ email: "", name: "", password: "", role: "viewer" as Role });
  const [collectionIds, setCollectionIds] = useState<string[]>([]);
  const [error, setError] = useState("");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.post("/users", { ...form, collectionIds });
      onClose(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error");
    }
  };

  return (
    <div className="modal-backdrop" onClick={() => onClose(false)}>
      <form className="card modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>Nuevo usuario</h2>
        <label>
          Nombre
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        </label>
        <label>
          Email
          <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
        </label>
        <label>
          Contraseña inicial (mín. 10 caracteres)
          <input
            type="text"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            minLength={10}
            required
          />
        </label>
        <label>
          Rol
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
            {Object.entries(ROLE_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        {form.role !== "admin" && (
          <div>
            <div className="small">Colecciones a las que tendrá acceso</div>
            <div className="checklist">
              {collections.map((c) => (
                <label key={c.id}>
                  <input
                    type="checkbox"
                    checked={collectionIds.includes(c.id)}
                    onChange={() =>
                      setCollectionIds((s) => (s.includes(c.id) ? s.filter((x) => x !== c.id) : [...s, c.id]))
                    }
                  />
                  {c.name}
                </label>
              ))}
            </div>
          </div>
        )}
        {error && <div className="error">{error}</div>}
        <div className="row gap end">
          <button type="button" onClick={() => onClose(false)}>
            Cancelar
          </button>
          <button className="primary">Crear</button>
        </div>
      </form>
    </div>
  );
}
