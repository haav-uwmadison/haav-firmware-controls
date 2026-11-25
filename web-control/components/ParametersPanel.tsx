"use client";

// Read-only view of the Pixhawk's parameter table, filled by the MAVLink parameter protocol
// (PARAM_REQUEST_LIST → PARAM_VALUE stream) in whichever backend is active.

import { memo, useDeferredValue, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toneBadge } from "@/components/StatusBar";
import type { Param, ParamTable } from "@/lib/mission-controller";
import { cn } from "@/lib/utils";

type Props = { params: ParamTable; connected: boolean; vehicle: string; onRefresh: () => void; className?: string };

const typeNames: Record<number, string> = { 1: "UINT8", 2: "INT8", 3: "UINT16", 4: "INT16", 5: "UINT32", 6: "INT32", 7: "UINT64", 8: "INT64", 9: "REAL32", 10: "REAL64" };
const isInteger = (type: number) => type >= 1 && type <= 8;

export function formatParam(p: Param): string {
  if (isInteger(p.type)) return String(Math.round(p.value));
  const v = Number(p.value.toPrecision(7));   // float32 has ~7 significant digits; drop the noise
  return Number.isInteger(v) ? v.toFixed(1) : String(v);
}

/** Same layout as the repo's .params files (QGC / Mission Planner): sysid, compid, name, value, type. */
function toParamsFile(params: ParamTable, vehicle: string): string {
  const rows = Object.values(params.byName).sort((a, b) => a.name.localeCompare(b.name));
  const header = `# ${vehicle} parameters read by Mission on ${new Date().toISOString()} (${rows.length} of ${params.count})\n`;
  return header + rows.map(p => `1\t1\t${p.name}\t${formatParam(p)}\t${p.type}`).join("\n") + "\n";
}

export const ParametersPanel = memo(function ParametersPanel({ params, connected, vehicle, onRefresh, className }: Props) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const rows = useMemo(() => {
    const q = deferredQuery.trim().toUpperCase();
    const all = Object.values(params.byName);
    return (q ? all.filter(p => p.name.includes(q)) : all).sort((a, b) => a.name.localeCompare(b.name));
  }, [params.byName, deferredQuery]);

  const badge = !connected ? { tone: "idle" as const, text: "No link" }
    : params.loading ? { tone: "warn" as const, text: `Loading ${params.received} / ${params.count || "?"}` }
    : params.received === 0 ? { tone: "idle" as const, text: "No parameters" }
    : params.received < params.count ? { tone: "warn" as const, text: `${params.received} / ${params.count} · incomplete` }
    : { tone: "ok" as const, text: `${params.received} parameters` };

  const download = () => {
    const blob = new Blob([toParamsFile(params, vehicle)], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), { href: url, download: `pixhawk-${new Date().toISOString().slice(0, 10)}.params` });
    a.click(); URL.revokeObjectURL(url);
  };

  return <Card className={cn("flex min-h-0 flex-col gap-0 py-0", className)}>
    <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 border-b border-border px-4 py-2.5">
      <CardTitle className="text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">Pixhawk parameters</CardTitle>
      <div className="flex items-center gap-2">
        <Input value={query} onChange={e => setQuery(e.target.value)} placeholder="Filter, e.g. SERVO or RC_" aria-label="Filter parameters" className="h-7 w-[220px] font-mono text-xs" />
        <Badge className={cn("text-[11px] font-bold tracking-[0.04em]", toneBadge[badge.tone])} role="status">{badge.text}</Badge>
        <Button variant="outline" size="sm" className="h-6 px-2 text-[11px]" onClick={onRefresh} disabled={!connected || params.loading}>Refresh</Button>
        <Button variant="outline" size="sm" className="h-6 px-2 text-[11px]" onClick={download} disabled={params.received === 0}>Download .params</Button>
      </div>
    </CardHeader>
    {params.loading && params.count > 0 && <Progress value={(100 * params.received) / params.count} className="h-1 rounded-none" aria-label="Parameters received" />}
    <CardContent className="relative min-h-0 flex-1 p-0">
      <ScrollArea className="h-full">
        <Table className="font-mono text-xs">
          <TableHeader className="sticky top-0 z-10 bg-card">
            <TableRow>
              <TableHead className="h-8 px-4">Name</TableHead>
              <TableHead className="h-8 px-4 text-right">Value</TableHead>
              <TableHead className="h-8 px-4 text-muted-foreground">Type</TableHead>
              <TableHead className="h-8 px-4 text-right text-muted-foreground">#</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(p => <TableRow key={p.name} className="hover:bg-muted/40">
              <TableCell className="px-4 py-1">{p.name}</TableCell>
              <TableCell className="tabular px-4 py-1 text-right">{formatParam(p)}</TableCell>
              <TableCell className="px-4 py-1 text-muted-foreground">{typeNames[p.type] ?? p.type}</TableCell>
              <TableCell className="tabular px-4 py-1 text-right text-muted-foreground">{p.index}</TableCell>
            </TableRow>)}
          </TableBody>
        </Table>
      </ScrollArea>
      {params.received === 0 && <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
        {!connected ? "Connect to the Pixhawk to read its parameters." : params.loading ? "Waiting for the first PARAM_VALUE…" : "No parameters received. Press Refresh."}
      </div>}
      {params.received > 0 && rows.length === 0 && <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">No parameter matches “{query}”.</div>}
    </CardContent>
  </Card>;
});
