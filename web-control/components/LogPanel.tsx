"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

import type { LogKind, LogLine } from "@/lib/mission-controller";
export type { LogKind, LogLine };

type Filter = "all" | "pixhawk" | "ack" | "error";
const filterLabel: Record<Filter, string> = { all: "All", pixhawk: "Pixhawk", ack: "ACK", error: "Errors" };
const kindClass: Record<LogKind, string> = { info: "text-zinc-300", pixhawk: "text-indigo-300", ack: "text-ok-foreground", warn: "text-warn-foreground", error: "text-danger-foreground" };

function matches(filter: Filter, line: LogLine): boolean {
  if (filter === "all") return true;
  if (filter === "error") return line.kind === "error" || line.kind === "warn";
  if (filter === "pixhawk") return line.kind === "pixhawk" || line.text.startsWith("Pixhawk:");
  return line.kind === filter;
}

/** Connection log: newest at the bottom, auto-scroll that pauses when you scroll up, filter chips (decision 12A). */
export function LogPanel({ lines, className }: { lines: LogLine[]; className?: string }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [atBottom, setAtBottom] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);
  const visible = lines.filter(line => matches(filter, line));

  const viewport = () => rootRef.current?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]') ?? null;

  useEffect(() => {
    const el = viewport();
    if (!el) return;
    const onScroll = () => setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const el = viewport();
    if (el && atBottom) el.scrollTop = el.scrollHeight;
  }, [visible.length, filter, atBottom]);

  const jump = () => { const el = viewport(); if (el) { el.scrollTop = el.scrollHeight; setAtBottom(true); } };

  return <Card className={cn("flex min-h-0 flex-col gap-0 py-0", className)}>
    <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 border-b border-border px-4 py-2.5">
      <CardTitle className="text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">Connection log</CardTitle>
      <ToggleGroup type="single" size="sm" value={filter} onValueChange={value => { if (value) setFilter(value as Filter); }} aria-label="Filter log">
        {(Object.keys(filterLabel) as Filter[]).map(key => <ToggleGroupItem key={key} value={key} className="h-6 px-2.5 text-[11px]">{filterLabel[key]}</ToggleGroupItem>)}
      </ToggleGroup>
    </CardHeader>
    <CardContent className="relative min-h-0 flex-1 p-0">
      <div ref={rootRef} className="h-full">
        <ScrollArea className="h-full">
          <ol className="tabular px-4 py-2 font-mono text-xs leading-6" aria-live="polite" aria-relevant="additions">
            {visible.length === 0 && <li className="text-muted-foreground">{filter === "all" ? "Ready. Connect to the Pixhawk to begin." : `No ${filterLabel[filter]} lines yet`}</li>}
            {visible.map(line => <li key={line.id} className="flex gap-3 whitespace-pre-wrap"><span className="shrink-0 text-zinc-500">{line.time}</span><span className={kindClass[line.kind]}>{line.text}</span></li>)}
          </ol>
        </ScrollArea>
      </div>
      {!atBottom && <Button size="sm" variant="secondary" className="absolute right-4 bottom-3" onClick={jump}>Jump to latest</Button>}
    </CardContent>
  </Card>;
}
