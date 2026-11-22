"use client";

// View only. All boat logic lives in lib/mission-controller.ts; this file maps its state to panels
// and forwards clicks and keys back to it.

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConsolePanel } from "@/components/ConsolePanel";
import { ControllerPanel } from "@/components/ControllerPanel";
import { GpsMapPanel } from "@/components/GpsMap";
import { LogPanel } from "@/components/LogPanel";
import { PfdPanel } from "@/components/Pfd";
import { StatusBar, type Readout, type Tone } from "@/components/StatusBar";
import { controllerToCommand } from "@/lib/boat-control";
import { bauds, type LinkPhase, type OutputPhase } from "@/lib/mission-controller";
import { useMission } from "@/lib/use-mission";

const format = (n: number) => n.toLocaleString("en-US").replace(/,/g, " ");

const outputReadout: Record<OutputPhase, { value: string; tone: Tone }> = {
  idle: { value: "Idle", tone: "idle" }, sending: { value: "Sending · 20 Hz", tone: "ok" }, stopped: { value: "Stopped", tone: "warn" }, error: { value: "Write error", tone: "danger" },
};

function linkReadout(phase: LinkPhase, lostSeconds: number): { value: string; tone: Tone } {
  switch (phase) {
    case "disconnected": return { value: "—", tone: "idle" };
    case "opening": return { value: "Opening port…", tone: "idle" };
    case "no-data": return { value: "No data", tone: "warn" };
    case "no-frames": return { value: "No frames, check baud", tone: "warn" };
    case "waiting": return { value: "Waiting", tone: "idle" };
    case "heartbeat": return { value: "Received", tone: "ok" };
    case "lost": return { value: `LOST ${lostSeconds} s`, tone: "danger" };
    case "failed": return { value: "Failed", tone: "danger" };
    case "port-lost": return { value: "Port lost", tone: "danger" };
  }
}

export default function Home() {
  const { mission, state, backend, daemonVersion } = useMission();
  const { connected, connecting, telemetry, controller, sending, armPending, linkPhase, startBlockedReason } = state;
  const [followBoat, setFollowBoat] = useState(true);

  // The status bar stays pinned while the page scrolls; the controller column sticks just below it.
  const barRef = useRef<HTMLDivElement>(null);
  const [barHeight, setBarHeight] = useState(88);
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setBarHeight(el.offsetHeight));
    observer.observe(el); setBarHeight(el.offsetHeight);
    return () => observer.disconnect();
  }, []);

  // Keep keystroke handling in the controller; ignore shortcuts while typing in a control.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.repeat) return;
      const key = event.key.toLowerCase();
      if (!["escape", "a", "b", "l", "o"].includes(key)) return;
      event.preventDefault(); mission.handleShortcut(key);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mission]);

  // Each status slot is also its control (one thing per state): Armed arms/disarms, Output starts/stops, Link connects/disconnects.
  const armedState = armPending === "arm" ? { value: "ARMING…", tone: "warn" as const }
    : armPending === "disarm" ? { value: "DISARMING…", tone: "warn" as const }
    : linkPhase === "lost" && telemetry.armed !== null ? { value: "UNKNOWN", tone: "warn" as const }
    : telemetry.armed === null ? { value: "—", tone: "idle" as const }
    : telemetry.armed ? { value: "● ARMED", tone: "danger" as const } : { value: "DISARMED", tone: "idle" as const };
  const primary: Readout[] = [
    {
      label: "Armed", ...armedState, badge: true, live: true,
      action: telemetry.armed
        ? { onClick: () => void mission.disarm(), hint: "disarm", shortcut: "B", disabled: !connected || !!armPending, title: "Disarm (B)" }
        : { onClick: () => void mission.arm(), hint: "arm", shortcut: "A", disabled: !connected || !!armPending || telemetry.armed === null, title: "Set MANUAL mode and arm (A)" },
    },
    {
      label: "Output", ...outputReadout[state.outputPhase], live: true,
      action: sending
        ? { onClick: () => void mission.stopOutput("stopped by user"), hint: "stop", shortcut: "O", title: "Stop control output (O)" }
        : { onClick: () => mission.startOutput(), hint: "start", shortcut: "O", disabled: !!startBlockedReason, title: startBlockedReason ?? "Start RC override at 20 Hz (O)" },
    },
    { label: "Mode", value: telemetry.mode },
    {
      label: "Link", ...linkReadout(linkPhase, state.lostSeconds), live: true,
      action: connected
        ? { onClick: () => void mission.disconnect(), hint: "disconnect", shortcut: "L" }
        : { onClick: () => void mission.connect(), hint: "connect", shortcut: "L", disabled: connecting, title: `Open the serial port at ${state.baud} baud (L)` },
    },
    { label: "Controller", value: controller.connected ? "Connected" : state.controllerLost ? "Lost" : "—", tone: controller.connected ? "ok" : state.controllerLost ? "danger" : "idle" },
    { label: "Battery", value: telemetry.battery },
  ];
  const secondary: Readout[] = [
    { label: "Vehicle", value: telemetry.vehicle },
    { label: "GPS", value: telemetry.gps },
    { label: "Speed", value: telemetry.speed },
    { label: "Heading", value: telemetry.heading },
    { label: "Bytes / frames", value: `${format(state.bytesIn)} / ${format(state.frames)}` },
    { label: "Last msg", value: telemetry.last },
    { label: "Read errors", value: String(state.recovered), tone: state.recovered ? "warn" : undefined },
    { label: "Bad CRC", value: String(state.badCrc), tone: state.badCrc ? "warn" : undefined },
    { label: "Port", value: connected ? state.portLabel : "—" },
    { label: "Backend", value: backend === "daemon" ? `mission_daemon ${daemonVersion}`.trim() : backend === "browser" ? "in-browser (Web Serial)" : "looking for daemon…", tone: backend === "daemon" ? "ok" : undefined },
  ];

  const actions = connected ? null
    : <Select value={state.baud} onValueChange={baud => mission.setBaud(baud)}>
      <SelectTrigger size="sm" className="tabular w-[104px] font-mono" aria-label="Baud rate"><SelectValue /></SelectTrigger>
      <SelectContent>{bauds.map(b => <SelectItem key={b} value={b} className="font-mono">{b}</SelectItem>)}</SelectContent>
    </Select>;

  return <TooltipProvider>
    <div className="p-6 text-sm text-muted-foreground md:hidden">Mission needs a desktop Chrome window at least 768px wide.</div>
    <div className="hidden min-h-screen flex-col md:flex" style={{ "--bar-h": `${barHeight}px` } as CSSProperties}>
      <div ref={barRef} className="sticky top-0 z-[1100]"><StatusBar primary={primary} secondary={secondary} actions={actions} /></div>
      <div className="grid flex-1 grid-cols-1 lg:grid-cols-[300px_1fr] xl:grid-cols-[360px_1fr]">
        <div className="order-2 bg-panel lg:order-1">
          <div className="lg:sticky lg:top-[var(--bar-h)] lg:h-[calc(100vh-var(--bar-h))]"><ControllerPanel controller={controller} command={controllerToCommand(controller)} lost={state.controllerLost} /></div>
        </div>
        <main className="order-1 mx-0 flex w-full max-w-none flex-col gap-4 p-4 lg:order-2">
          <ConsolePanel phase={state.outputPhase} pwm={state.pwm} overridesSent={state.overridesSent} heartbeatsSent={state.heartbeatsSent} banner={state.banner}
            motorSpan={state.motorSpan} onMotorSpanChange={span => mission.setMotorSpan(span)} format={format} />
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2 2xl:grid-cols-3">
            <PfdPanel pfd={state.pfd} telemetry={telemetry} connected={connected} className="h-[440px]" />
            <GpsMapPanel position={state.position} trail={state.trail} follow={followBoat} onFollowChange={setFollowBoat} onClearTrail={() => mission.clearTrail()} className="h-[440px]" />
            <LogPanel lines={state.logs} className="h-[440px] xl:col-span-2 2xl:col-span-1" />
          </div>
        </main>
      </div>
    </div>
  </TooltipProvider>;
}
