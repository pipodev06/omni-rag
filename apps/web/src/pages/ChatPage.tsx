import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { History, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { api, errorMessage, streamChat, type Collection, type Message } from "@/api";
import { useCurrentUser } from "@/hooks/useSession";
import { useChatSuggestions } from "@/hooks/useChatSuggestions";
import { SidebarSlot } from "@/components/AppLayout";
import { AssistantMessage, UserMessage } from "@/components/chat/ChatMessage";
import { messageKey } from "@/lib/messages";
import { loadHistory, mergeHistory, rememberPrompt } from "@/lib/promptHistory";
import { ChatWelcome } from "@/components/chat/ChatWelcome";
import { Composer } from "@/components/chat/Composer";
import { QuotaBanner } from "@/components/chat/QuotaBanner";
import { useQuota } from "@/hooks/useQuota";
import { ConversationList } from "@/components/chat/ConversationList";
import { useOpenDocument } from "@/components/documents/DocumentViewer";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

/** Historial accesible en móvil (en escritorio está en la barra lateral). */
function MobileHistory({ activeId }: { activeId?: string }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  return (
    <>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="left" className="flex w-80 flex-col bg-sidebar p-4">
          <SheetHeader className="p-0">
            <SheetTitle>Conversaciones</SheetTitle>
          </SheetHeader>
          <ConversationList activeId={activeId} onSelect={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
      <div className="flex items-center justify-between border-b px-3 py-2 md:hidden">
        <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
          <History /> Historial
        </Button>
        <Button variant="ghost" size="sm" onClick={() => navigate("/chat")}>
          <Plus /> Nueva
        </Button>
      </div>
    </>
  );
}

/** Carga los mensajes de la conversación de la URL (salvo la que se acaba de crear aquí). */
function useConversationMessages(conversationId: string | undefined, onReset: () => void) {
  const navigate = useNavigate();
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const createdHereRef = useRef<string | null>(null);
  const reset = useEffectEvent(onReset);

  useEffect(() => {
    // La URL cambió porque acabamos de crear esta conversación: seguir con la respuesta en curso.
    if (conversationId && conversationId === createdHereRef.current) {
      createdHereRef.current = null;
      return;
    }
    reset();
    if (!conversationId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .get<{ messages: Message[] }>(`/conversations/${conversationId}`)
      .then((d) => !cancelled && setMessages(d.messages))
      .catch((err) => {
        if (cancelled) return;
        toast.error(errorMessage(err));
        navigate("/chat", { replace: true });
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [conversationId, navigate]);

  return { messages, setMessages, loading, createdHereRef };
}

export function ChatPage() {
  const { conversationId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user } = useCurrentUser();
  const openDocument = useOpenDocument();
  const [searchParams, setSearchParams] = useSearchParams();

  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectedCollections, setSelectedCollections] = useState<string[]>([]);
  const [activeSource, setActiveSource] = useState<Record<string, number | null>>({});
  const [docFilter, setDocFilter] = useState<string | null>(null);
  // «Buscar también en internet»: apagado al entrar; solo aparece si el plan lo permite y hay buscador en el servidor.
  const [webSearch, setWebSearch] = useState(false);
  const webAvailable = useQuota().data?.webSearch === true;

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const { messages, setMessages, loading, createdHereRef } = useConversationMessages(conversationId, () => {
    abortRef.current?.abort();
    setActiveSource({});
    if (!conversationId) setDocFilter(null);
  });

  // Preguntas anteriores para ↑ ↓: las guardadas en este navegador más los mensajes de la conversación abierta.
  const history = useMemo(
    () => mergeHistory(loadHistory(user.id), messages.filter((m) => m.role === "user").map((m) => m.content)),
    [messages, user.id],
  );

  const { data: collectionsData } = useQuery({
    queryKey: ["collections"],
    queryFn: () => api.get<{ collections: Collection[] }>("/collections"),
  });
  const { filterDoc, hasDocuments, suggestions } = useChatSuggestions(docFilter);

  // Enlaces del tipo /chat?documento=<id>&q=<pregunta> (desde el visor o la lista de documentos).
  useEffect(() => {
    const doc = searchParams.get("documento");
    const q = searchParams.get("q");
    if (!doc && !q) return;
    if (doc) setDocFilter(doc);
    if (q) setInput(q);
    setSearchParams({}, { replace: true });
    textareaRef.current?.focus();
  }, [searchParams, setSearchParams]);

  // Mantener la vista al final mientras llega la respuesta.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: busy ? "auto" : "smooth" });
  }, [messages, busy]);

  const updateLast = (fn: (m: Message) => Message) =>
    setMessages((prev) => (prev.length ? [...prev.slice(0, -1), fn(prev[prev.length - 1]!)] : prev));

  const send = async (text?: string) => {
    const question = (text ?? input).trim();
    if (!question || busy) return;
    rememberPrompt(user.id, question);
    setInput("");
    setBusy(true);
    setMessages((prev) => [
      ...prev,
      { localId: crypto.randomUUID(), role: "user", content: question, sources: [] },
      { localId: crypto.randomUUID(), role: "assistant", content: "", sources: [] },
    ]);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await streamChat(
        {
          question,
          conversationId,
          collectionIds: selectedCollections.length ? selectedCollections : undefined,
          documentIds: docFilter ? [docFilter] : undefined,
          webSearch: webAvailable && webSearch ? true : undefined,
        },
        {
          onMeta: (meta) => {
            if (!conversationId) {
              createdHereRef.current = meta.conversationId;
              navigate(`/chat/${meta.conversationId}`, { replace: true });
            }
            updateLast((m) => ({ ...m, sources: meta.sources }));
            if (meta.web?.failed) toast.warning("No se pudo buscar en internet", { description: "La respuesta usa solo tus documentos." });
          },
          onToken: (t) => updateLast((m) => ({ ...m, content: m.content + t })),
          onDone: (d) => updateLast((m) => ({ ...m, id: d.messageId, model: d.model, sources: d.sources, fromCache: d.fromCache })),
          onError: (msg) => updateLast((m) => ({ ...m, error: msg })),
        },
        controller.signal,
      );
    } catch (err) {
      if (!controller.signal.aborted) updateLast((m) => ({ ...m, error: errorMessage(err) }));
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: ["conversations"] });
      void qc.invalidateQueries({ queryKey: ["quota"] });
      textareaRef.current?.focus();
    }
  };

  const cite = (key: string, n: number) => {
    setActiveSource((prev) => ({ ...prev, [key]: prev[key] === n ? null : n }));
    requestAnimationFrame(() =>
      document.getElementById(`msg-${key}`)?.querySelector(`#source-${n}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }),
    );
  };

  const firstName = user.name.split(" ")[0];
  const lastIndex = messages.length - 1;

  return (
    <div className="flex h-full flex-col">
      <SidebarSlot>
        <ConversationList activeId={conversationId} />
      </SidebarSlot>
      <MobileHistory activeId={conversationId} />

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
          {loading && (
            <div className="grid place-items-center py-20 text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
            </div>
          )}
          {!loading && messages.length === 0 && (
            <ChatWelcome
              title={filterDoc ? `¿Qué quieres saber de «${filterDoc.title}»?` : `Hola, ${firstName}. ¿Qué quieres saber?`}
              hasDocuments={hasDocuments}
              suggestions={suggestions}
              onPick={(t) => void send(t)}
            />
          )}
          {!loading && messages.length > 0 && (
            <div className="space-y-8">
              {messages.map((m, i) => {
                const key = messageKey(m, i);
                return m.role === "user" ? (
                  <UserMessage key={key} content={m.content} />
                ) : (
                  <AssistantMessage
                    key={key}
                    message={m}
                    domId={`msg-${key}`}
                    streaming={busy && i === lastIndex}
                    activeSource={activeSource[key] ?? null}
                    onCite={(n) => cite(key, n)}
                    onOpenSource={(s) => openDocument({ documentId: s.documentId, page: s.pageStart, highlight: s.excerpt })}
                    onFeedback={(v) => setMessages((prev) => prev.map((x) => (x === m ? { ...x, feedback: v } : x)))}
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>

      <QuotaBanner />
      <Composer
        textareaRef={textareaRef}
        value={input}
        onChange={setInput}
        onSend={() => void send()}
        onStop={() => abortRef.current?.abort()}
        busy={busy}
        collections={collectionsData?.collections ?? []}
        selectedCollections={selectedCollections}
        onSelectedCollections={setSelectedCollections}
        documentFilter={docFilter ? { title: filterDoc?.title, filename: filterDoc?.filename } : null}
        onOpenDocument={() => docFilter && openDocument({ documentId: docFilter })}
        onClearDocument={() => setDocFilter(null)}
        history={history}
        webSearch={webAvailable ? { on: webSearch, onChange: setWebSearch } : null}
      />
    </div>
  );
}
