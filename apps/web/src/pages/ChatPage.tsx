import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useNavigate, useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUp,
  History,
  ListFilter,
  Loader2,
  MessageSquareText,
  Plus,
  Sparkles,
  Square,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import {
  api,
  errorMessage,
  streamChat,
  timeAgo,
  type Collection,
  type Conversation,
  type DocumentInfo,
  type Message,
} from "@/api";
import { useCurrentUser } from "@/hooks/useSession";
import { cn } from "@/lib/utils";
import { SidebarSlot } from "@/components/AppLayout";
import { useConfirm } from "@/components/ConfirmProvider";
import { AnswerMarkdown, CopyButton, SourcesList } from "@/components/chat/Answer";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";

// ---------------------------------------------------------------------------
// Historial de conversaciones
// ---------------------------------------------------------------------------

function ConversationList({ activeId, onSelect }: { activeId?: string; onSelect?: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data, isLoading } = useQuery({
    queryKey: ["conversations"],
    queryFn: () => api.get<{ conversations: Conversation[] }>("/conversations"),
  });

  const remove = async (c: Conversation) => {
    const ok = await confirm({
      title: "¿Borrar esta conversación?",
      description: `«${c.title}» se eliminará de forma permanente.`,
      confirmText: "Borrar",
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.del(`/conversations/${c.id}`);
      await qc.invalidateQueries({ queryKey: ["conversations"] });
      if (c.id === activeId) navigate("/chat");
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <Button
        variant="outline"
        className="justify-start"
        onClick={() => {
          navigate("/chat");
          onSelect?.();
        }}
      >
        <Plus /> Nueva conversación
      </Button>
      <p className="px-2 pt-2 text-xs font-medium text-muted-foreground">Recientes</p>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-0.5 pr-2">
          {isLoading && <Loader2 className="mx-auto my-4 size-4 animate-spin text-muted-foreground" />}
          {data?.conversations.length === 0 && <p className="px-2 py-1 text-xs text-muted-foreground">Aún no hay conversaciones.</p>}
          {data?.conversations.map((c) => (
            <div
              key={c.id}
              className={cn(
                "group flex items-center rounded-lg text-sm transition-colors hover:bg-sidebar-accent",
                c.id === activeId && "bg-sidebar-accent",
              )}
            >
              <button
                className="min-w-0 flex-1 px-2.5 py-1.5 text-left"
                onClick={() => {
                  navigate(`/chat/${c.id}`);
                  onSelect?.();
                }}
                title={c.title}
              >
                <p className="truncate">{c.title}</p>
                <p className="text-[11px] text-muted-foreground">{timeAgo(c.updatedAt)}</p>
              </button>
              <Button
                variant="ghost"
                size="icon"
                className="mr-1 size-7 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100"
                onClick={() => void remove(c)}
                aria-label="Borrar conversación"
              >
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------

export function ChatPage() {
  const { conversationId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user } = useCurrentUser();

  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectedCollections, setSelectedCollections] = useState<string[]>([]);
  const [activeSource, setActiveSource] = useState<Record<number, number | null>>({});
  const [historyOpen, setHistoryOpen] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const createdHereRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { data: collectionsData } = useQuery({
    queryKey: ["collections"],
    queryFn: () => api.get<{ collections: Collection[] }>("/collections"),
  });
  const collections = collectionsData?.collections ?? [];

  const { data: docsData } = useQuery({
    queryKey: ["documents", "all"],
    queryFn: () => api.get<{ documents: DocumentInfo[] }>("/documents"),
  });
  const readyDocs = (docsData?.documents ?? []).filter((d) => d.status === "ready");

  // Cargar la conversación al cambiar de URL (salvo si la acabamos de crear aquí).
  useEffect(() => {
    // La URL cambió porque acabamos de crear esta conversación: seguir con la respuesta en curso.
    if (conversationId && conversationId === createdHereRef.current) {
      createdHereRef.current = null;
      return;
    }
    abortRef.current?.abort();
    setActiveSource({});
    if (!conversationId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    setLoadingMessages(true);
    api
      .get<{ messages: Message[] }>(`/conversations/${conversationId}`)
      .then((d) => !cancelled && setMessages(d.messages))
      .catch((err) => {
        if (cancelled) return;
        toast.error(errorMessage(err));
        navigate("/chat", { replace: true });
      })
      .finally(() => !cancelled && setLoadingMessages(false));
    return () => {
      cancelled = true;
    };
  }, [conversationId, navigate]);

  // Mantener la vista al final mientras llega la respuesta.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: busy ? "auto" : "smooth" });
  }, [messages, busy]);

  // Altura automática del cuadro de texto.
  useEffect(() => {
    const t = textareaRef.current;
    if (!t) return;
    t.style.height = "auto";
    t.style.height = `${Math.min(t.scrollHeight, 200)}px`;
  }, [input]);

  const updateLast = (fn: (m: Message) => Message) =>
    setMessages((prev) => (prev.length ? [...prev.slice(0, -1), fn(prev[prev.length - 1]!)] : prev));

  const send = async (text?: string) => {
    const question = (text ?? input).trim();
    if (!question || busy) return;
    setInput("");
    setBusy(true);
    setMessages((prev) => [
      ...prev,
      { role: "user", content: question, sources: [] },
      { role: "assistant", content: "", sources: [] },
    ]);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await streamChat(
        { question, conversationId, collectionIds: selectedCollections.length ? selectedCollections : undefined },
        {
          onMeta: (meta) => {
            if (!conversationId) {
              createdHereRef.current = meta.conversationId;
              navigate(`/chat/${meta.conversationId}`, { replace: true });
            }
            updateLast((m) => ({ ...m, sources: meta.sources }));
          },
          onToken: (t) => updateLast((m) => ({ ...m, content: m.content + t })),
          onDone: (d) => updateLast((m) => ({ ...m, id: d.messageId, model: d.model, sources: d.sources })),
          onError: (msg) => updateLast((m) => ({ ...m, error: msg })),
        },
        controller.signal,
      );
    } catch (err) {
      if (!controller.signal.aborted) updateLast((m) => ({ ...m, error: errorMessage(err) }));
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: ["conversations"] });
      textareaRef.current?.focus();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  const toggleCollection = (id: string) =>
    setSelectedCollections((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]));

  const cite = (messageIndex: number, n: number) => {
    setActiveSource((prev) => ({ ...prev, [messageIndex]: prev[messageIndex] === n ? null : n }));
    requestAnimationFrame(() =>
      document.getElementById(`msg-${messageIndex}`)?.querySelector(`#source-${n}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }),
    );
  };

  const suggestions = [
    ...readyDocs.slice(0, 2).map((d) => `Resume los puntos principales de «${d.title}»`),
    "¿Qué plazos o fechas importantes aparecen en los documentos?",
    "¿Qué obligaciones o requisitos se mencionan?",
  ].slice(0, 4);

  const filterLabel =
    selectedCollections.length === 0
      ? "Todas las colecciones"
      : selectedCollections.length === 1
        ? (collections.find((c) => c.id === selectedCollections[0])?.name ?? "1 colección")
        : `${selectedCollections.length} colecciones`;

  const firstName = user.name.split(" ")[0];

  return (
    <div className="flex h-full flex-col">
      <SidebarSlot>
        <ConversationList activeId={conversationId} />
      </SidebarSlot>

      {/* Acceso al historial en móvil */}
      <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
        <SheetContent side="left" className="flex w-80 flex-col bg-sidebar p-4">
          <SheetHeader className="p-0">
            <SheetTitle>Conversaciones</SheetTitle>
          </SheetHeader>
          <ConversationList activeId={conversationId} onSelect={() => setHistoryOpen(false)} />
        </SheetContent>
      </Sheet>
      <div className="flex items-center justify-between border-b px-3 py-2 md:hidden">
        <Button variant="ghost" size="sm" onClick={() => setHistoryOpen(true)}>
          <History /> Historial
        </Button>
        <Button variant="ghost" size="sm" onClick={() => navigate("/chat")}>
          <Plus /> Nueva
        </Button>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
          {loadingMessages ? (
            <div className="grid place-items-center py-20 text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : messages.length === 0 ? (
            <div className="flex flex-col items-center pt-[12vh] text-center">
              <div className="mb-5 grid size-12 place-items-center rounded-2xl bg-primary/10 text-primary">
                <Sparkles className="size-6" />
              </div>
              <h1 className="text-2xl font-semibold tracking-tight">Hola, {firstName}. ¿Qué quieres saber?</h1>
              <p className="mt-2 max-w-md text-sm text-muted-foreground">
                Respondo usando solo los documentos a los que tienes acceso y te indico de dónde sale cada dato.
              </p>
              {readyDocs.length > 0 ? (
                <div className="mt-8 grid w-full gap-2 sm:grid-cols-2">
                  {suggestions.map((s) => (
                    <button
                      key={s}
                      onClick={() => void send(s)}
                      className="rounded-xl border bg-card p-3.5 text-left text-sm transition-colors hover:border-primary/40 hover:bg-accent"
                    >
                      <MessageSquareText className="mb-2 size-4 text-primary" />
                      {s}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="mt-8 rounded-lg border border-dashed px-4 py-3 text-sm text-muted-foreground">
                  Todavía no hay documentos listos. Súbelos en la sección <b>Documentos</b>.
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-8">
              {messages.map((m, i) =>
                m.role === "user" ? (
                  <div key={m.id ?? i} className="flex justify-end">
                    <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-[15px] whitespace-pre-wrap text-primary-foreground">
                      {m.content}
                    </div>
                  </div>
                ) : (
                  <div key={m.id ?? i} id={`msg-${i}`} className="flex gap-3">
                    <div className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                      <Sparkles className="size-4" />
                    </div>
                    <div className="min-w-0 flex-1 space-y-4">
                      {m.content ? (
                        <AnswerMarkdown content={m.content} sources={m.sources} onCite={(n) => cite(i, n)} />
                      ) : (
                        !m.error && (
                          <div className="flex items-center gap-2 pt-1 text-sm text-muted-foreground">
                            <Loader2 className="size-4 animate-spin" />
                            {m.sources.length ? "Redactando la respuesta…" : "Buscando en los documentos…"}
                          </div>
                        )
                      )}
                      {m.error && (
                        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                          {m.error}
                        </div>
                      )}
                      <SourcesList sources={m.sources} active={activeSource[i] ?? null} onToggle={(n) => cite(i, n)} />
                      {m.content && !(busy && i === messages.length - 1) && (
                        <div className="flex items-center gap-1 text-xs text-muted-foreground">
                          <CopyButton text={m.content} />
                          {m.model && <span className="ml-1">{m.model}</span>}
                        </div>
                      )}
                    </div>
                  </div>
                ),
              )}
            </div>
          )}
        </div>
      </div>

      {/* Caja de texto */}
      <div className="shrink-0 px-4 pb-4 sm:px-6">
        <div className="mx-auto w-full max-w-3xl">
          <div className="rounded-2xl border bg-card shadow-sm transition-colors focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-ring/20">
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Escribe tu pregunta…"
              rows={1}
              maxLength={4000}
              className="max-h-[200px] min-h-[52px] resize-none border-0 bg-transparent px-4 py-3.5 text-[15px] shadow-none focus-visible:ring-0 dark:bg-transparent"
            />
            <div className="flex items-center justify-between gap-2 px-2 pb-2">
              {collections.length > 1 ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="sm" className="h-8 max-w-[60%] text-xs text-muted-foreground">
                      <ListFilter />
                      <span className="truncate">{filterLabel}</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-64">
                    <DropdownMenuLabel>Buscar en</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {collections.map((c) => (
                      <DropdownMenuCheckboxItem
                        key={c.id}
                        checked={selectedCollections.includes(c.id)}
                        onCheckedChange={() => toggleCollection(c.id)}
                        onSelect={(e) => e.preventDefault()}
                      >
                        <span className="truncate">{c.name}</span>
                        <span className="ml-auto text-xs text-muted-foreground">{c.documentCount}</span>
                      </DropdownMenuCheckboxItem>
                    ))}
                    {selectedCollections.length > 0 && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={() => setSelectedCollections([])}>Todas las colecciones</DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <span />
              )}
              {busy ? (
                <Button size="icon" variant="secondary" className="size-8 rounded-full" onClick={() => abortRef.current?.abort()} aria-label="Detener">
                  <Square className="size-3.5 fill-current" />
                </Button>
              ) : (
                <Button size="icon" className="size-8 rounded-full" disabled={!input.trim()} onClick={() => void send()} aria-label="Enviar">
                  <ArrowUp />
                </Button>
              )}
            </div>
          </div>
          <p className="mt-2 text-center text-[11px] text-muted-foreground">
            Las respuestas pueden contener errores. Comprueba las fuentes citadas. · Enter para enviar, Shift+Enter para nueva línea
          </p>
        </div>
      </div>
    </div>
  );
}
