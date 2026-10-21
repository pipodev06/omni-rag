import { createContext, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { NavLink, Outlet, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  Building2,
  ChartColumn,
  ChevronsUpDown,
  Files,
  LogOut,
  Menu,
  MessagesSquare,
  Monitor,
  Moon,
  Settings,
  Sun,
  ThumbsUp,
  Users,
  type LucideIcon,
} from "lucide-react";
import { api, initials, ROLE_LABELS } from "@/api";
import { useCurrentUser } from "@/hooks/useSession";
import { useTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { Logo } from "@/components/common";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { DocumentViewerProvider } from "@/components/documents/DocumentViewer";
import { useDocumentEvents } from "@/hooks/useDocumentEvents";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  show: boolean;
}

function useNavItems(): NavItem[] {
  const { user } = useCurrentUser();
  return [
    { to: "/chat", label: "Chat", icon: MessagesSquare, show: true },
    { to: "/documentos", label: "Documentos", icon: Files, show: true },
    { to: "/usuarios", label: "Usuarios", icon: Users, show: user.role === "admin" },
    { to: "/calidad", label: "Calidad", icon: ThumbsUp, show: user.role === "admin" },
    { to: "/consumo", label: "Consumo", icon: ChartColumn, show: user.role === "admin" },
    { to: "/organizaciones", label: "Organizaciones", icon: Building2, show: user.isSuperadmin },
  ].filter((i) => i.show);
}

const THEMES: { value: Theme; label: string; icon: LucideIcon }[] = [
  { value: "light", label: "Claro", icon: Sun },
  { value: "dark", label: "Oscuro", icon: Moon },
  { value: "system", label: "Automático", icon: Monitor },
];

function UserMenu() {
  const { user, tenant } = useCurrentUser();
  const { theme, setTheme } = useTheme();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const logout = async () => {
    await api.post("/auth/logout").catch(() => {});
    qc.clear();
    qc.setQueryData(["session"], null);
    navigate("/login");
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex w-full items-center gap-3 rounded-lg p-2 text-left transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          <Avatar className="size-8">
            <AvatarFallback className="bg-primary/10 text-xs font-medium text-primary">{initials(user.name)}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{user.name}</p>
            <p className="truncate text-xs text-muted-foreground">{tenant.name}</p>
          </div>
          <ChevronsUpDown className="size-4 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-60">
        <DropdownMenuLabel className="font-normal">
          <p className="text-sm font-medium">{user.name}</p>
          <p className="truncate text-xs text-muted-foreground">{user.email}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {ROLE_LABELS[user.role]} · {tenant.name}
          </p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate("/cuenta")}>
          <Settings /> Mi cuenta
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            {theme === "dark" ? <Moon /> : theme === "light" ? <Sun /> : <Monitor />}
            <span className="ml-2">Tema</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as Theme)}>
              {THEMES.map((t) => (
                <DropdownMenuRadioItem key={t.value} value={t.value}>
                  <t.icon /> {t.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={logout} variant="destructive">
          <LogOut /> Cerrar sesión
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SidebarContent({ onNavigate, slotRef }: { onNavigate?: () => void; slotRef?: (el: HTMLDivElement | null) => void }) {
  const items = useNavItems();
  return (
    <div className="flex h-full flex-col gap-4 p-3">
      <div className="px-2 pt-1">
        <Logo />
      </div>
      <nav className="flex flex-col gap-0.5">
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground",
                isActive && "bg-sidebar-accent text-foreground",
              )
            }
          >
            <item.icon className="size-4" />
            {item.label}
          </NavLink>
        ))}
      </nav>
      <div ref={slotRef} className="flex min-h-0 flex-1 flex-col" />
      <UserMenu />
    </div>
  );
}

/**
 * Estructura principal: barra lateral fija en escritorio y menú desplegable en móvil.
 * Las páginas pueden añadir contenido a la barra lateral con `<SidebarSlot>`.
 */
export function AppLayout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [slotEl, setSlotEl] = useState<HTMLElement | null>(null);
  useDocumentEvents();

  return (
    <SidebarSlotContext.Provider value={slotEl}>
      <DocumentViewerProvider>
      <div className="flex h-full">
        <aside className="hidden w-64 shrink-0 border-r border-sidebar-border bg-sidebar md:block">
          <SidebarContent slotRef={setSlotEl} />
        </aside>

        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetContent side="left" className="w-72 bg-sidebar p-0">
            <SheetTitle className="sr-only">Menú</SheetTitle>
            <SidebarContent onNavigate={() => setMobileOpen(false)} />
          </SheetContent>
        </Sheet>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3 md:hidden">
            <Button variant="ghost" size="icon" onClick={() => setMobileOpen(true)} aria-label="Abrir menú">
              <Menu />
            </Button>
            <Logo />
          </header>
          <main className="min-h-0 flex-1 overflow-y-auto">
            <Outlet />
          </main>
        </div>
      </div>
      </DocumentViewerProvider>
    </SidebarSlotContext.Provider>
  );
}

const SidebarSlotContext = createContext<HTMLElement | null>(null);

/**
 * Muestra `children` en la barra lateral de escritorio mientras la página esté
 * montada (p. ej. el historial del chat). En móvil no se muestra: la página
 * debe ofrecer su propio acceso.
 */
export function SidebarSlot({ children }: { children: ReactNode }) {
  const el = useContext(SidebarSlotContext);
  return el ? createPortal(children, el) : null;
}
