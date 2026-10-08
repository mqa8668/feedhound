import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useAddSource, usePreviewFeed, type FeedPreviewDto } from "@/api/queries";
import { useToast } from "@/components/ui/toast";
import { ApiError } from "@/api/client";

const FEED_URL_RE = /^https?:\/\/[^\s/]+/i;

function formatDate(iso: string | null): string {
  if (!iso) return "no date";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "no date" : d.toLocaleDateString();
}

export function AddSourceDialog() {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [preview, setPreview] = useState<FeedPreviewDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const addSource = useAddSource();
  const previewFeed = usePreviewFeed();
  const { toast } = useToast();

  const reset = () => {
    setUrl("");
    setName("");
    setPreview(null);
    setError(null);
  };

  const urlValid = FEED_URL_RE.test(url.trim());

  const onPreview = async () => {
    setError(null);
    setPreview(null);
    if (!urlValid) {
      setError("Feed URL must start with http:// or https://");
      return;
    }
    try {
      setPreview(await previewFeed.mutateAsync({ url: url.trim() }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not preview this feed");
    }
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!urlValid) {
      setError("Feed URL must start with http:// or https://");
      return;
    }
    try {
      await addSource.mutateAsync({ url: url.trim(), name: name.trim() || undefined });
      toast({ title: "Feed source added" });
      setOpen(false);
      reset();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to add feed source");
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button>Add feed source</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add feed source</DialogTitle>
          <DialogDescription>Paste an RSS, Atom or JSON Feed URL. Preview it before saving.</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={onSubmit}>
          <div className="space-y-1">
            <Label htmlFor="feed-url">Feed URL</Label>
            <div className="flex gap-2">
              <Input
                id="feed-url"
                placeholder="https://example.com/feed.xml"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setPreview(null);
                  setError(null);
                }}
                required
              />
              <Button type="button" variant="outline" onClick={onPreview} disabled={previewFeed.isPending || !url.trim()}>
                {previewFeed.isPending ? "Checking…" : "Preview"}
              </Button>
            </div>
          </div>
          {preview ? (
            <div className="space-y-2 rounded-md border p-3" data-testid="feed-preview">
              <p className="text-sm font-medium">{preview.title || preview.url}</p>
              {preview.items.length === 0 ? (
                <p className="text-sm text-muted-foreground">This feed has no items yet.</p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {preview.items.slice(0, 5).map((it) => (
                    <li key={it.url} className="flex items-baseline justify-between gap-2">
                      <a className="truncate underline-offset-2 hover:underline" href={it.url} target="_blank" rel="noreferrer">
                        {it.title}
                      </a>
                      <span className="shrink-0 text-xs text-muted-foreground">{formatDate(it.postedAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
          <div className="space-y-1">
            <Label htmlFor="feed-name">Name (optional)</Label>
            <Input id="feed-name" placeholder={preview?.title || "Defaults to the feed title"} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={addSource.isPending || !url.trim()}>
              {addSource.isPending ? "Adding…" : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
