import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { api, formatBytes, formatDate, type Collection, type DocumentInfo, type TenantUser, type User } from "../api";

const STATUS: Record<DocumentInfo["status"], { label: string; cls: string }> = {
  pending: { label: "En cola", cls: "pending" },
  processing: { label: "Procesando", cls: "processing" },
  ready: { label: "Listo", cls: "ready" },
  failed: { label: "Error", cls: "failed" },
};

interface UploadResult {
  filename: string;
  status: "queued" | "duplicate" | "rejected";
  reason?: string;
}

export function DocumentsPage({ user }: { user: User }) {
  const canEdit = user.role === "admin" || user.role === "editor";
  const isAdmin = user.role === "admin";
  const [collections, setCollections] = useState<Collection[]>([]);
  const [collectionId, setCollectionId] = useState<string>("");
  const [documents, setDocuments] = useState<DocumentInfo[]>([]);
  const [extensions, setExtensions] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [results, setResults] = useState<UploadResult[]>([]);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const loadCollections = useCallback(async () => {
    const d = await api.get<{ collections: Collection[] }>("/collections");
    setCollections(d.collections);
    setCollectionId((cur) => (cur && d.collections.some((c) => c.id === cur) ? cur : (d.collections[0]?.id ?? "")));
  }, []);

  const loadDocuments = useCallback(async () => {
    if (!collectionId) return setDocuments([]);
    const d = await api.get<{ documents: DocumentInfo[]; supportedExtensions: string[] }>(
      `/documents?collectionId=${collectionId}`,
    );
    setDocuments(d.documents);
    setExtensions(d.supportedExtensions);
  }, [collectionId]);

  useEffect(() => void loadCollections(), [loadCollections]);
  useEffect(() => void loadDocuments(), [loadDocuments]);

  // Mientras haya documentos procesándose, refrescar cada 3 segundos.
  const inProgress = documents.some((d) => d.status === "pending" || d.status === "processing");
  useEffect(() => {
    if (!inProgress) return;
    const t = setInterval(() => void loadDocuments(), 3000);
    return () => clearInterval(t);
  }, [inProgress, loadDocuments]);

  const upload = async (files: FileList | File[]) => {
    if (!collectionId || files.length === 0) return;
    setUploading(true);
    setError("");
    setResults([]);
    try {
      const form = new FormData();
      form.append("collectionId", collectionId);
      for (const f of Array.from(files)) form.append("file", f);
      const r = await api.post<{ results: UploadResult[] }>("/documents", form);
      setResults(r.results);
      await loadDocuments();
      void loadCollections();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error subiendo archivos");
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (canEdit) void upload(e.dataTransfer.files);
  };

  const remove = async (d: DocumentInfo) => {
    if (!confirm(`¿Borrar "${d.filename}"? Se eliminará también del índice de búsqueda.`)) return;
    await api.del(`/documents/${d.id}`);
    void loadDocuments();
    void loadCollections();
  };

  const reprocess = async (d: DocumentInfo) => {
    await api.post(`/documents/${d.id}/reprocess`);
    void loadDocuments();
  };

  const createCollection = async () => {
    const name = prompt("Nombre de la nueva colección:");
    if (!name?.trim()) return;
    try {
      const r = await api.post<{ id: string }>("/collections", { name: name.trim() });
      await loadCollections();
      setCollectionId(r.id);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Error");
    }
  };

  const renameCollection = async (c: Collection) => {
    const name = prompt("Nuevo nombre:", c.name);
    if (!name?.trim() || name === c.name) return;
    await api.patch(`/collections/${c.id}`, { name: name.trim() }).catch((e: Error) => alert(e.message));
    void loadCollections();
  };

  const deleteCollection = async (c: Collection) => {
    if (!confirm(`¿Borrar la colección "${c.name}" y sus ${c.documentCount} documentos? No se puede deshacer.`)) return;
    await api.del(`/collections/${c.id}`);
    setCollectionId("");
    void loadCollections();
  };

  const current = collections.find((c) => c.id === collectionId);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Documentos</h1>
        {isAdmin && (
          <button className="primary" onClick={createCollection}>
            + Nueva colección
          </button>
        )}
      </div>

      {collections.length === 0 ? (
        <div className="card muted">
          {isAdmin ? "Crea una colección para empezar a subir documentos." : "Aún no tienes acceso a ninguna colección. Pide acceso a un administrador."}
        </div>
      ) : (
        <>
          <div className="tabs">
            {collections.map((c) => (
              <button key={c.id} className={c.id === collectionId ? "tab active" : "tab"} onClick={() => setCollectionId(c.id)}>
                {c.name} <span className="muted">({c.documentCount})</span>
              </button>
            ))}
          </div>

          {current && isAdmin && (
            <div className="row gap small">
              <button className="link" onClick={() => setShowMembers(true)}>
                Gestionar acceso ({current.memberIds.length} miembros)
              </button>
              <button className="link" onClick={() => void renameCollection(current)}>
                Renombrar
              </button>
              <button className="link danger" onClick={() => void deleteCollection(current)}>
                Borrar colección
              </button>
            </div>
          )}

          {canEdit && (
            <div
              className={`dropzone ${dragging ? "dragging" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              onClick={() => fileInput.current?.click()}
            >
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                accept={extensions.join(",")}
                onChange={(e) => e.target.files && void upload(e.target.files)}
              />
              {uploading ? "Subiendo…" : "Arrastra archivos aquí o haz clic para elegirlos"}
              <div className="muted tiny">{extensions.join(" ")}</div>
            </div>
          )}

          {error && <div className="error">{error}</div>}
          {results.length > 0 && (
            <ul className="results">
              {results.map((r, i) => (
                <li key={i} className={r.status === "queued" ? "success" : "warn"}>
                  {r.filename}: {r.status === "queued" ? "en cola para procesar" : r.reason}
                </li>
              ))}
            </ul>
          )}

          <table className="table">
            <thead>
              <tr>
                <th>Documento</th>
                <th>Estado</th>
                <th>Tamaño</th>
                <th>Páginas</th>
                <th>Trozos</th>
                <th>Subido</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {documents.map((d) => (
                <tr key={d.id}>
                  <td>
                    <div>{d.title}</div>
                    <div className="muted tiny">{d.filename}</div>
                  </td>
                  <td>
                    <span className={`status ${STATUS[d.status].cls}`}>{STATUS[d.status].label}</span>
                    {d.error && <div className="error tiny">{d.error}</div>}
                  </td>
                  <td>{formatBytes(d.sizeBytes)}</td>
                  <td>{d.pageCount ?? "—"}</td>
                  <td>{d.chunkCount}</td>
                  <td className="small">
                    {formatDate(d.createdAt)}
                    {d.createdBy && <div className="muted tiny">{d.createdBy}</div>}
                  </td>
                  <td className="actions">
                    <a href={`/api/documents/${d.id}/file`} title="Descargar original">
                      ⬇
                    </a>
                    {canEdit && (
                      <>
                        <button className="icon" title="Reprocesar" onClick={() => void reprocess(d)}>
                          ↻
                        </button>
                        <button className="icon danger" title="Borrar" onClick={() => void remove(d)}>
                          ✕
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {documents.length === 0 && (
                <tr>
                  <td colSpan={7} className="muted center-text">
                    No hay documentos en esta colección.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      )}

      {showMembers && current && (
        <MembersDialog
          collection={current}
          onClose={() => {
            setShowMembers(false);
            void loadCollections();
          }}
        />
      )}
    </div>
  );
}

function MembersDialog({ collection, onClose }: { collection: Collection; onClose: () => void }) {
  const [users, setUsers] = useState<TenantUser[]>([]);
  const [selected, setSelected] = useState<string[]>(collection.memberIds);
  const [error, setError] = useState("");

  useEffect(() => {
    void api.get<{ users: TenantUser[] }>("/users").then((d) => setUsers(d.users));
  }, []);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.put(`/collections/${collection.id}/members`, { userIds: selected });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error");
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="card modal" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <h2>Acceso a «{collection.name}»</h2>
        <p className="muted small">Los administradores siempre tienen acceso a todas las colecciones.</p>
        <div className="checklist">
          {users
            .filter((u) => u.role !== "admin")
            .map((u) => (
              <label key={u.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(u.id)}
                  onChange={() => setSelected((s) => (s.includes(u.id) ? s.filter((x) => x !== u.id) : [...s, u.id]))}
                />
                {u.name} <span className="muted small">({u.email})</span>
              </label>
            ))}
          {users.filter((u) => u.role !== "admin").length === 0 && <div className="muted">No hay editores ni lectores.</div>}
        </div>
        {error && <div className="error">{error}</div>}
        <div className="row gap end">
          <button type="button" onClick={onClose}>
            Cancelar
          </button>
          <button className="primary">Guardar</button>
        </div>
      </form>
    </div>
  );
}
