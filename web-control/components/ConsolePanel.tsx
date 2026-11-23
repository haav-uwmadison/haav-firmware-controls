import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Slider } from "@/components/ui/slider";
import { BipolarGauge } from "@/components/BipolarGauge";
import { toneBadge, type Tone } from "@/components/StatusBar";
import { MAX_MOTOR_SPAN, MIN_MOTOR_SPAN, PWM_NEUTRAL, type BoatPwm, type MotorReverse } from "@/lib/boat-control";
import { cn } from "@/lib/utils";

import type { OutputPhase } from "@/lib/mission-controller";
export type { OutputPhase };

type Props = {
  phase: OutputPhase;
  pwm: BoatPwm;
  overridesSent: number;
  heartbeatsSent: number;
  /** message shown when something made the page act on its own (controller lost, write error) */
  banner: string | null;
  /** max PWM deviation from 1500 for the motors, in µs */
  motorSpan: number;
  onMotorSpanChange: (span: number) => void;
  /** which motors have their PWM direction flipped */
  motorReverse: MotorReverse;
  onMotorReverseChange: (motor: keyof MotorReverse, reverse: boolean) => void;
  format: (n: number) => string;
};

const phaseBadge: Record<OutputPhase, { tone: Tone; text: string }> = {
  idle: { tone: "idle", text: "Idle" },
  sending: { tone: "ok", text: "● Sending RC override · 20 Hz" },
  stopped: { tone: "warn", text: "Stopped · failsafe in 1 s" },
  error: { tone: "danger", text: "Write error" },
};

/** Flips one motor's PWM so stick forward sends it below 1500 µs. Takes effect on the next override, even while sending. */
function ReverseToggle({ id, checked, onChange }: { id: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label htmlFor={id} className={cn(
    "flex cursor-pointer items-center justify-between gap-3 rounded-md border px-3 py-2 transition-colors select-none",
    checked ? "border-warn/50 bg-warn/10" : "border-border bg-panel-2 hover:border-zinc-600",
  )}>
    <span className="flex min-w-0 items-center gap-2.5">
      <Checkbox id={id} checked={checked} onCheckedChange={v => onChange(v === true)} aria-label="Reverse this motor's PWM direction"
        className="size-[18px] rounded-[5px] border-zinc-600 data-checked:border-warn data-checked:bg-warn data-checked:text-zinc-950" />
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground">Reverse PWM</span>
        <span className="truncate text-[11px] text-muted-foreground">{checked ? "Stick forward sends below 1500 µs" : "Stick forward sends above 1500 µs"}</span>
      </span>
    </span>
    <Badge className={cn("shrink-0 text-[10px] font-bold tracking-[0.06em]", toneBadge[checked ? "warn" : "idle"])}>{checked ? "Reversed" : "Normal"}</Badge>
  </label>;
}

/** Centre panel: the three outputs the Pixhawk is being told to drive, plus arming. */
export function ConsolePanel({ phase, pwm, overridesSent, heartbeatsSent, banner, motorSpan, onMotorSpanChange, motorReverse, onMotorReverseChange, format }: Props) {
  const badge = phaseBadge[phase];

  return <Card className="gap-0 py-0">
    <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 border-b border-border px-4 py-2.5">
      <CardTitle className="text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">Control output</CardTitle>
      <Badge className={cn("text-[11px] font-bold tracking-[0.06em]", toneBadge[badge.tone])} role="status">{badge.text}</Badge>
    </CardHeader>
    <CardContent className="px-4 py-4">
      {banner && <div className="mb-4 rounded-md border border-warn/50 bg-warn/10 px-3 py-2 text-sm text-warn-foreground" role="alert">{banner}</div>}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-3 md:gap-0 md:divide-x md:divide-border lg:grid-cols-2 xl:grid-cols-3 lg:[&>*:last-child]:col-span-2 xl:[&>*:last-child]:col-span-1 [&>*]:md:px-5 [&>*:first-child]:md:pl-0 [&>*:last-child]:md:pr-0">
        <div className="flex min-w-0 flex-col gap-3">
          <BipolarGauge label="Left motor · RC1" value={pwm.left} color="var(--series-left)" leftLabel="1000 reverse" rightLabel="forward 2000" limit={motorSpan} />
          <ReverseToggle id="reverse-left" checked={motorReverse.left} onChange={v => onMotorReverseChange("left", v)} />
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <BipolarGauge label="Right motor · RC3" value={pwm.right} color="var(--series-right)" leftLabel="1000 reverse" rightLabel="forward 2000" limit={motorSpan} />
          <ReverseToggle id="reverse-right" checked={motorReverse.right} onChange={v => onMotorReverseChange("right", v)} />
        </div>
        <BipolarGauge label="Rudder · RC6" value={pwm.rudder} color="var(--series-rudder)" leftLabel="left 1000" rightLabel="right 2000" />
      </div>
      <div className="mt-5 flex flex-col gap-1.5 rounded-md border border-border bg-panel-2 px-4 py-3">
        <div className="flex items-baseline justify-between gap-3">
          <label htmlFor="motor-span" className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Motor power limit</label>
          <span className="tabular font-mono text-sm font-semibold">{PWM_NEUTRAL - motorSpan} – {PWM_NEUTRAL + motorSpan} µs <span className="text-muted-foreground">(±{motorSpan})</span></span>
        </div>
        <Slider id="motor-span" min={MIN_MOTOR_SPAN} max={MAX_MOTOR_SPAN} step={10} value={[motorSpan]} onValueChange={([v]) => onMotorSpanChange(v)} aria-label="Motor power limit in microseconds from neutral" />
        <span className="text-xs text-muted-foreground">Full stick sends this PWM. Applies to both motors immediately, even while sending. The rudder is not limited.</span>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2.5">
        <span className="tabular font-mono text-xs text-muted-foreground">Overrides sent {format(overridesSent)} · Heartbeats {format(heartbeatsSent)}</span>
      </div>
    </CardContent>
  </Card>;
}
