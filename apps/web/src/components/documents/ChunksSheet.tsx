import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { api, type DocumentInfo } from "@/api";
import { ExcerptMarkdown, pagesLabel } from "@/components/chat/Answer";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";

interface Chunk {
  index: number;
  heading: string;
  content: string;
  pageStart: number | null;
  pageEnd: number | null;
}

/** Panel lateral con los fragmentos en que se dividió un documento. */
export function ChunksSheet({ document, onOpenChange }: { document: DocumentInfo | null; onOpenChange: (open: boolean) => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ["chunks", document?.id],
    queryFn: () => api.get<{ chunks: Chunk[] }>(`/documents/${document!.id}/chunks`),
    enabled: document !== null,
  });

  return (
    <Sheet open={document !== null} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
        <SheetHeader className="border-b">
          <SheetTitle className="truncate pr-6">{document?.title}</SheetTitle>
          <SheetDescription>
            {document?.chunkCount} fragmentos indexados. Así es como el sistema "lee" el documento al buscar.
          </SheetDescription>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-3 p-4">
            {isLoading && <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />}
            {data?.chunks.map((c) => (
              <div key={c.index} className="rounded-lg border bg-card p-3">
                <div className="mb-2 flex flex-wrap items-center gap-1.5">
                  <Badge variant="secondary">#{c.index + 1}</Badge>
                  {pagesLabel(c) && <Badge variant="outline">{pagesLabel(c)}</Badge>}
                  {c.heading && <span className="truncate text-xs text-muted-foreground">{c.heading}</span>}
                </div>
                <ExcerptMarkdown text={c.content} />
              </div>
            ))}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
