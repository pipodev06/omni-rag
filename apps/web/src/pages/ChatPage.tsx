import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, streamChat, type Collection, type Conversation, type Message, type Source } from "../api";

const pages = (s: Source) =>
  s.pageStart === null ? "" : s.pageEnd !== null && s.pageEnd !== s.pageStart ? `págs. ${s.pageStart}-${s.pageEnd}` : `pág. ${s.pageStart}`;

function Sources({ sources }: { sources: Source[] }) {
  const [open, setOpen] = useState<number | null>(null);
  if (sources.length === 0) return null;
  const cited = sources.filter((s) => s.cited);
  const shown = cited.length > 0 ? cited : sources;
  return (
    <div className="sources">
      <div className="muted small">Fuentes{cited.length > 0 ? " citadas" : ""}:</div>
      {shown.map((s) => (
        <div key={s.n} className="source">
          <button className="source-head" onClick={() => setOpen(open === s.n ? null : s.n)}>
            <span className="badge">{s.n}</span> {s.documentTitle}
            {pages(s) && <span className="muted"> · {pages(s)}</span>}
            {s.heading && <span className="muted"> · {s.heading}</span>}
            <a
              className="download"
              href={`/api/documents/${s.documentId}/file`}
              onClick={(e) => e.stopPropagation()}
              title="Descargar el documento original"
            >
              ⬇
            </a>
          </button>
          {open === s.n && <pre className="excerpt">{s.excerpt}</pre>}
        </div>
      ))}
    </div>
  );
}

export function ChatPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [selectedCollections, setSelectedCollections] = useState<string[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const loadConversations = useCallback(async () => {
    const data = await api.get<{ conversations: Conversation[] }>("/conversations");
    setConversations(data.conversations);
  }, []);

  useEffect(() => {
    void loadConversations();
    void api.get<{ collections: Collection[] }>("/collections").then((d) => setCollections(d.collections));
  }, [loadConversations]);

  useEffect(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), [messages]);

  const openConversation = async (id: string) => {
    abortRef.current?.abort();
    const data = await api.get<{ messages: Message[] }>(`/conversations/${id}`);
    setConversationId(id);
    setMessages(data.messages);
  };

  const newConversation = () => {
    abortRef.current?.abort();
    setConversationId(undefined);
    setMessages([]);
  };

  const deleteConversation = async (id: string) => {
    if (!confirm("¿Borrar esta conversación?")) return;
    await api.del(`/conversations/${id}`);
    if (id === conversationId) newConversation();
    void loadConversations();
  };

  const updateLast = (fn: (m: Message) => Message) =>
    setMessages((prev) => [...prev.slice(0, -1), fn(prev[prev.length - 1]!)]);

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    const question = input.trim();
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
            setConversationId(meta.conversationId);
            updateLast((m) => ({ ...m, sources: meta.sources }));
          },
          onToken: (t) => updateLast((m) => ({ ...m, content: m.content + t })),
          onDone: (d) => updateLast((m) => ({ ...m, id: d.messageId, model: d.model, sources: d.sources })),
          onError: (msg) => updateLast((m) => ({ ...m, error: msg })),
        },
        controller.signal,
      );
    } catch (err) {
      if (!controller.signal.aborted) updateLast((m) => ({ ...m, error: err instanceof Error ? err.message : "Error" }));
    } finally {
      setBusy(false);
      void loadConversations();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const toggleCollection = (id: string) =>
    setSelectedCollections((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]));

  return (
    <div className="chat">
      <div className="chat-list">
        <button className="primary full" onClick={newConversation}>
          + Nueva conversación
        </button>
        {conversations.map((c) => (
          <div key={c.id} className={`chat-item ${c.id === conversationId ? "active" : ""}`}>
            <button className="link-item" onClick={() => void openConversation(c.id)} title={c.title}>
              {c.title}
            </button>
            <button className="icon" title="Borrar" onClick={() => void deleteConversation(c.id)}>
              ✕
            </button>
          </div>
        ))}
      </div>

      <div className="chat-main">
        {collections.length > 1 && (
          <div className="filters">
            <span className="muted small">Buscar en:</span>
            {collections.map((c) => (
              <label key={c.id} className="chip">
                <input type="checkbox" checked={selectedCollections.includes(c.id)} onChange={() => toggleCollection(c.id)} />
                {c.name}
              </label>
            ))}
            {selectedCollections.length === 0 && <span className="muted small">(todas)</span>}
          </div>
        )}

        <div className="messages">
          {messages.length === 0 && (
            <div className="empty">
              <h2>¿Qué quieres saber?</h2>
              <p className="muted">
                Las respuestas se basan solo en los documentos a los que tienes acceso e incluyen las fuentes citadas.
              </p>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={m.id ?? i} className={`message ${m.role}`}>
              {m.role === "assistant" ? (
                <>
                  {m.content ? (
                    <div className="markdown">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                    </div>
                  ) : (
                    !m.error && <div className="muted typing">Buscando en los documentos…</div>
                  )}
                  {m.error && <div className="error">{m.error}</div>}
                  <Sources sources={m.sources} />
                  {m.model && <div className="muted tiny">Modelo: {m.model}</div>}
                </>
              ) : (
                <div className="bubble">{m.content}</div>
              )}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        <form className="composer" onSubmit={send}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Escribe tu pregunta… (Enter para enviar, Shift+Enter para nueva línea)"
            rows={2}
            maxLength={4000}
          />
          {busy ? (
            <button type="button" onClick={() => abortRef.current?.abort()}>
              Detener
            </button>
          ) : (
            <button className="primary" disabled={!input.trim()}>
              Enviar
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
