import { useCallback, useEffect, useState } from "react";
import { api, ROLE_LABELS, type Tenant, type User } from "./api";
import { LoginPage } from "./pages/LoginPage";
import { ChatPage } from "./pages/ChatPage";
import { DocumentsPage } from "./pages/DocumentsPage";
import { UsersPage } from "./pages/UsersPage";
import { UsagePage } from "./pages/UsagePage";
import { PlatformPage } from "./pages/PlatformPage";
import { AccountPage } from "./pages/AccountPage";

type Page = "chat" | "documents" | "users" | "usage" | "platform" | "account";

const readHash = (): Page => {
  const h = window.location.hash.replace("#/", "") as Page;
  return ["chat", "documents", "users", "usage", "platform", "account"].includes(h) ? h : "chat";
};

export function App() {
  const [session, setSession] = useState<{ user: User; tenant: Tenant } | null | undefined>(undefined);
  const [page, setPage] = useState<Page>(readHash);

  const loadSession = useCallback(async () => {
    try {
      setSession(await api.get<{ user: User; tenant: Tenant }>("/auth/me"));
    } catch {
      setSession(null);
    }
  }, []);

  useEffect(() => {
    void loadSession();
    const onHash = () => setPage(readHash());
    const onUnauthorized = () => setSession(null);
    window.addEventListener("hashchange", onHash);
    window.addEventListener("rag:unauthorized", onUnauthorized);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("rag:unauthorized", onUnauthorized);
    };
  }, [loadSession]);

  if (session === undefined) return <div className="center muted">Cargando…</div>;
  if (session === null) return <LoginPage onLogin={loadSession} />;

  const { user, tenant } = session;
  const nav: { id: Page; label: string; show: boolean }[] = [
    { id: "chat", label: "💬 Chat", show: true },
    { id: "documents", label: "📄 Documentos", show: true },
    { id: "users", label: "👥 Usuarios", show: user.role === "admin" },
    { id: "usage", label: "📊 Consumo", show: user.role === "admin" },
    { id: "platform", label: "🏢 Organizaciones", show: user.isSuperadmin },
    { id: "account", label: "⚙️ Mi cuenta", show: true },
  ];
  const current = nav.find((n) => n.id === page && n.show) ? page : "chat";

  const logout = async () => {
    await api.post("/auth/logout").catch(() => {});
    setSession(null);
  };

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <span className="logo">R</span>
          <div>
            <div className="brand-name">RAG Project</div>
            <div className="muted small">{tenant.name}</div>
          </div>
        </div>
        <nav>
          {nav
            .filter((n) => n.show)
            .map((n) => (
              <a key={n.id} href={`#/${n.id}`} className={current === n.id ? "active" : ""}>
                {n.label}
              </a>
            ))}
        </nav>
        <div className="sidebar-footer">
          <div className="small">{user.name}</div>
          <div className="muted small">
            {user.email} · {ROLE_LABELS[user.role]}
          </div>
          <button className="link" onClick={logout}>
            Cerrar sesión
          </button>
        </div>
      </aside>
      <main className="content">
        {current === "chat" && <ChatPage />}
        {current === "documents" && <DocumentsPage user={user} />}
        {current === "users" && <UsersPage me={user} />}
        {current === "usage" && <UsagePage />}
        {current === "platform" && <PlatformPage />}
        {current === "account" && <AccountPage />}
      </main>
    </div>
  );
}
