import type { ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type Tone = "ok" | "warn" | "danger" | "idle" | "neutral";
export type ReadoutAction = { onClick: () => void; /** action shown in the label */ hint: string; shortcut?: string; disabled?: boolean; title?: string };
export type Readout = { label: string; value: string; tone?: Tone; badge?: boolean; live?: boolean; /** when set, the readout is the control: it shows the state and clicking changes it */ action?: ReadoutAction };

export const toneText: Record<Tone, string> = {
  ok: "text-ok-foreground", warn: "text-warn-foreground", danger: "text-danger-foreground", idle: "text-muted-foreground", neutral: "text-foreground",
};
export const toneBadge: Record<Tone, string> = {
  ok: "border-ok/40 bg-ok/15 text-ok-foreground",
  warn: "border-warn/50 bg-warn/15 text-warn-foreground",
  danger: "border-danger/60 bg-danger/20 text-danger-foreground",
  idle: "border-border bg-panel-2 text-muted-foreground",
  neutral: "border-border bg-panel-2 text-foreground",
};

type Props = { primary: Readout[]; secondary: Readout[]; actions: ReactNode };

/** Two-tier status bar (plan decision 1A): operator-critical readouts on top, link counters below. */
export function StatusBar({ primary, secondary, actions }: Props) {
  return <header className="border-b border-border bg-panel">
    <div className="flex h-14 items-stretch">
      <div className="flex items-center border-r border-border px-4 text-[15px] font-semibold">Mission</div>
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
        {primary.map(item => {
          const valueNode = item.badge
            ? <Badge className={cn("mt-0.5 w-fit text-xs font-bold tracking-[0.06em]", toneBadge[item.tone ?? "idle"])} role={item.live ? "status" : undefined} aria-live={item.live ? "polite" : undefined}>{item.value}</Badge>
            : <span className={cn("tabular truncate text-xl font-semibold leading-tight", toneText[item.tone ?? "neutral"])} role={item.live ? "status" : undefined} aria-live={item.live ? "polite" : undefined}>{item.value}</span>;
          const body = <>
            <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
              {item.label}{item.action && !item.action.disabled && <span className="text-live/80"> · {item.action.hint}</span>}
              {item.action?.shortcut && <kbd className="rounded border border-border bg-panel-2 px-1 py-0.5 font-mono text-[9px] leading-none text-muted-foreground">{item.action.shortcut}</kbd>}
            </span>
            {valueNode}
          </>;
          const slot = "flex min-w-0 flex-col justify-center border-r border-border px-4 text-left";
          return item.action
            ? <button key={item.label} type="button" onClick={item.action.onClick} disabled={item.action.disabled} title={item.action.title ?? item.action.hint}
                className={cn(slot, "cursor-pointer transition-colors hover:bg-panel-2 focus-visible:bg-panel-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent")}>{body}</button>
            : <div key={item.label} className={slot}>{body}</div>;
        })}
      </div>
      <div className="flex shrink-0 items-center gap-2 px-4">
        {actions}
        <Button asChild variant="outline" size="sm">
          <a href="https://grafana.haav.build/" target="_blank" rel="noreferrer" aria-label="Open Grafana in a new tab">
            Grafana <ExternalLink aria-hidden="true" />
          </a>
        </Button>
      </div>
    </div>
    <div className="tabular flex min-h-7 flex-wrap items-center gap-x-6 gap-y-1 bg-[#0d0d0f] px-4 py-1 font-mono text-xs text-muted-foreground">
      {secondary.map(item => <span key={item.label} className="whitespace-nowrap">{item.label} <b className={cn("font-semibold", item.tone ? toneText[item.tone] : "text-foreground")}>{item.value}</b></span>)}
    </div>
  </header>;
}
