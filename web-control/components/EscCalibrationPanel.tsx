"use client";

// Guided ESC throttle-range calibration: hold the motor outputs at max while the ESC battery goes
// in, drop to min, then hand the outputs back. The sequencing lives in lib/esc-calibration.ts.

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { CheckIcon, CircleAlertIcon, LoaderCircleIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { toneBadge, type Tone } from "@/components/StatusBar";
import { ESC_CAL_MAX_PWM, ESC_CAL_MIN_PWM, EscCalibration, escCalBlockedReason, escCalNeedsRestore, initialEscCalState, motorOutputs, type EscCalStep } from "@/lib/esc-calibration";
import type { MissionApi } from "@/lib/mission-api";
import type { MissionState } from "@/lib/mission-controller";
import { cn } from "@/lib/utils";

type Props = { mission: MissionApi; state: MissionState; className?: string };

const stepBadge: Record<EscCalStep, { tone: Tone; text: string }> = {
  idle: { tone: "idle", text: "Idle" },
  preparing: { tone: "warn", text: "Preparing" },
  max: { tone: "warn", text: `Holding ${ESC_CAL_MAX_PWM} µs` },
  min: { tone: "warn", text: `Holding ${ESC_CAL_MIN_PWM} µs` },
  restoring: { tone: "warn", text: "Restoring" },
  done: { tone: "ok", text: "Calibrated" },
  error: { tone: "danger", text: "Needs attention" },
};

/** Which of the three on-screen steps each state belongs to. */
const stepIndex: Record<EscCalStep, number> = { idle: 0, preparing: 1, max: 1, min: 2, restoring: 3, done: 3, error: 0 };

const getServerEscCalState = () => initialEscCalState;

export function EscCalibrationPanel({ mission, state, className }: Props) {
  // one calibration runner per backend instance
  const runner = useMemo(() => new EscCalibration(mission), [mission]);
  useEffect(() => {
    runner.hydrate();
    return () => runner.dispose();
  }, [runner]);
  const cal = useSyncExternalStore(runner.subscribe, runner.getState, getServerEscCalState);
  const [confirmed, setConfirmed] = useState(false);

  const blocked = escCalBlockedReason(state);
  const outputs = cal.step === "idle" || cal.step === "error" || cal.step === "done" ? motorOutputs(state) : cal.outputs;
  const needsRestore = escCalNeedsRestore(state, cal.originals);
  const running = cal.step === "max" || cal.step === "min";
  const badge = stepBadge[cal.step];
  const current = stepIndex[cal.step];
  const outputText = outputs.length ? outputs.map(o => `${o.channel} (${o.name})`).join(" and ") : "none found";

  const checks: { ok: boolean; text: string; wide?: boolean }[] = [
    { ok: state.connected && state.linkPhase === "heartbeat", text: "Pixhawk link up" },
    { ok: state.telemetry.armed === false, text: "Disarmed" },
    { ok: !state.sending, text: "Control output idle" },
    { ok: state.params.received > 0 && !state.params.loading, text: "Parameters loaded" },
    { ok: outputs.length > 0, text: `Motor outputs: ${outputText}`, wide: true },
  ];

  const steps = [
    { title: "Get ready", body: `Props off or the boat out of the water. ESC battery unplugged. Keep the Pixhawk powered over USB so the link stays up.` },
    { title: `Hold full throttle (${ESC_CAL_MAX_PWM} µs)`, body: "Press Start. When the badge shows the outputs are held, plug the ESC battery in. Two beeps mean the ESCs saw full throttle. Then press Next." },
    { title: `Drop to minimum (${ESC_CAL_MIN_PWM} µs)`, body: "One beep means each ESC stored the range. Then press Finish." },
    { title: "Hand the outputs back", body: "The outputs return to their motor functions and sit at SERVOn_TRIM. A one-way ESC treats anything above its minimum as throttle, so keep the props off until you have checked the trims." },
  ];

  return <Card className={cn("flex min-h-0 flex-col gap-0 py-0", className)}>
    <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 border-b border-border px-4 py-2.5">
      <CardTitle className="text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">ESC calibration</CardTitle>
      <Badge className={cn("text-[11px] font-bold tracking-[0.06em]", toneBadge[badge.tone])} role="status">{badge.text}</Badge>
    </CardHeader>
    <CardContent className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
      {needsRestore.length > 0 && !running && cal.step !== "restoring" &&
        <div className="flex items-start gap-2 rounded-md border border-danger/60 bg-danger/15 px-3 py-2 text-sm text-danger-foreground" role="alert">
          <CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>Output{needsRestore.length > 1 ? "s" : ""} {needsRestore.join(" and ")} {needsRestore.length > 1 ? "are" : "is"} still Disabled from an earlier calibration. The boat cannot drive until they are restored.</span>
        </div>}

      <ul className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2" aria-label="Preconditions">
        {checks.map(c => <li key={c.text} className={cn("flex items-center gap-2", c.ok ? "text-foreground" : "text-muted-foreground", c.wide && "sm:col-span-2")}>
          <span className={cn("flex size-4 shrink-0 items-center justify-center rounded-full border", c.ok ? "border-ok/60 bg-ok/20 text-ok-foreground" : "border-border")} aria-hidden>
            {c.ok && <CheckIcon className="size-3" />}
          </span>
          <span className={cn(!c.wide && "truncate")}>{c.text}</span>
        </li>)}
      </ul>

      <ol className="flex flex-col gap-2.5">
        {steps.map((s, i) => {
          const active = running || cal.step === "preparing" || cal.step === "restoring" ? current === i : false;
          const complete = (running || cal.step === "restoring" || cal.step === "done") && i < current;
          return <li key={s.title} className={cn("flex gap-3", active ? "text-foreground" : "text-muted-foreground")}>
            <span className={cn("mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border font-mono text-[11px] font-semibold",
              active ? "border-warn bg-warn/15 text-warn-foreground" : complete ? "border-ok/60 bg-ok/15 text-ok-foreground" : "border-border")}>
              {complete ? <CheckIcon className="size-3" /> : i + 1}
            </span>
            <span className="flex min-w-0 flex-col">
              <span className={cn("text-sm font-medium", active && "text-foreground")}>{s.title}</span>
              <span className="text-xs">{s.body}</span>
            </span>
          </li>;
        })}
      </ol>

      {cal.message && <p className={cn("rounded-md border px-3 py-2 text-sm", cal.step === "error" ? "border-danger/60 bg-danger/15 text-danger-foreground" : cal.step === "done" ? "border-ok/40 bg-ok/15 text-ok-foreground" : "border-border bg-panel-2 text-foreground")} role="status" aria-live="polite">
        {cal.busy && <LoaderCircleIcon className="mr-2 inline size-3.5 animate-spin align-[-2px]" aria-hidden />}{cal.message}
      </p>}

      <div className="mt-auto flex flex-wrap items-center gap-2">
        {!running && cal.step !== "preparing" && cal.step !== "restoring" && <>
          <div className="flex items-center gap-2">
            <Checkbox id="esc-cal-ready" className="relative top-[1.5px]" checked={confirmed} onCheckedChange={v => setConfirmed(v === true)} />
            <Label htmlFor="esc-cal-ready" className="text-xs font-normal text-muted-foreground">Props are off and the ESC battery is unplugged</Label>
          </div>
          <Button size="sm" className="ml-auto" onClick={() => void runner.start()} disabled={!!blocked || !confirmed || cal.busy || needsRestore.length > 0} title={blocked ?? undefined}>Start</Button>
        </>}
        {cal.step === "max" && <Button size="sm" className="ml-auto" onClick={() => void runner.next()} disabled={cal.busy}>Next: drop to {ESC_CAL_MIN_PWM} µs</Button>}
        {cal.step === "min" && <Button size="sm" className="ml-auto" onClick={() => void runner.finish()} disabled={cal.busy}>Finish</Button>}
        {running && <Button size="sm" variant="outline" onClick={() => void runner.abort()} disabled={cal.busy}>Abort</Button>}
        {needsRestore.length > 0 && !running && <Button size="sm" variant="destructive" onClick={() => void runner.restore()} disabled={cal.busy || !state.connected}>Restore outputs</Button>}
      </div>
      {blocked && !running && <p className="text-xs text-muted-foreground">{blocked}.</p>}
    </CardContent>
  </Card>;
}
