import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Scope } from "@/components/Scope";
import { toneBadge } from "@/components/StatusBar";
import type { BoatCommand } from "@/lib/boat-control";
import type { ControllerState } from "@/lib/gamepad";
import { cn } from "@/lib/utils";

type Props = { controller: ControllerState; command: BoatCommand; lost: boolean };

const series = { left: "var(--series-left)", right: "var(--series-right)", lt: "var(--series-lt)", rt: "var(--series-rt)", rudder: "var(--series-rudder)" };

/** Left column: controller status and the four live graphs. One flat surface, scopes separated by rules (decision 7A). */
export function ControllerPanel({ controller, command, lost }: Props) {
  const overlay = controller.connected ? undefined : "Press any button on the Xbox controller";
  const badge = controller.connected
    ? { tone: "ok" as const, text: "● Xbox · connected" }
    : lost ? { tone: "danger" as const, text: "● Controller lost" } : { tone: "idle" as const, text: "Not detected" };
  return <aside className="flex min-h-0 flex-col border-border bg-panel lg:border-r">
    <div className="flex items-center justify-between gap-3 px-4 pt-3.5 pb-2">
      <h2 className="m-0 text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">Controller</h2>
      <Badge className={cn("text-[11px] font-bold tracking-[0.04em]", toneBadge[badge.tone])} title={controller.id || undefined}>{badge.text}</Badge>
    </div>
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-x-4 px-4 pb-3 md:grid-cols-2 lg:grid-cols-1">
      <Scope title="Left stick · forward = +1" overlay={overlay} series={[{ name: "Y", color: series.left, value: controller.ly }]} />
      <Separator className="my-3 hidden lg:block" />
      <Scope title="Right stick · forward = +1" overlay={overlay} series={[{ name: "Y", color: series.right, value: controller.ry }]} />
      <Separator className="my-3 hidden lg:block" />
      <Scope title="Triggers" range={[0, 1]} overlay={overlay} series={[{ name: "LT", color: series.lt, value: controller.lt }, { name: "RT", color: series.rt, value: controller.rt }]} />
      <Separator className="my-3 hidden lg:block" />
      <Scope title="Boat command" overlay={overlay} series={[{ name: "L", color: series.left, value: command.left }, { name: "R", color: series.right, value: command.right }, { name: "Rud", color: series.rudder, value: command.rudder }]} />
    </div>
    <div className="mt-auto border-t border-border px-4 py-2 font-mono text-[11px] text-muted-foreground">A arm · B disarm · Esc stop + disarm</div>
  </aside>;
}
