import { useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/Icon";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useParseWatch } from "@/api/queries";
import { ApiError } from "@/api/client";
import type { WatchParseResponseDto } from "@/api/types";

export const NL_MIN = 3;
export const NL_MAX = 300;

function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "llm_unavailable" || err.code === "llm_budget") return "Automatic parsing is unavailable right now. You can still fill the form in below.";
    if (err.code === "rate_limited") return "You are trying too fast. Wait a moment and try again.";
    if (err.code === "parse_failed") return "Could not understand this description. Try rephrasing or fill the form in manually.";
  }
  return "Could not parse this. You can still fill the form in below.";
}

export interface NlInputProps {
  onParsed: (res: WatchParseResponseDto) => void;
}

/** "Describe what you're hunting" -> parse (never saves). Failures are non-blocking. */
export function NlInput({ onParsed }: NlInputProps) {
  const [text, setText] = useState("");
  const parse = useParseWatch();
  const trimmed = text.trim();
  const submit = () => {
    if (trimmed.length < NL_MIN || parse.isPending) return;
    parse.mutate(trimmed, { onSuccess: onParsed });
  };
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="watch-nl">Describe what you are hunting</Label>
      <Textarea
        id="watch-nl"
        value={text}
        maxLength={NL_MAX}
        rows={2}
        placeholder="macbook air or pro, m2 chip or newer, under 25M, selling"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" onClick={submit} disabled={trimmed.length < NL_MIN || parse.isPending}>
          <Icon icon={Sparkles} className="text-current" />
          {parse.isPending ? "Parsing…" : "Parse"}
        </Button>
        <span className="text-xs text-muted-foreground">Only fills the form; nothing is saved.</span>
      </div>
      {parse.isError ? (
        <p role="alert" className="text-sm text-warn">
          {errorText(parse.error)}
        </p>
      ) : null}
    </div>
  );
}
