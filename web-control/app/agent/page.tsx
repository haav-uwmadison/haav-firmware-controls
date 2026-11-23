"use client";

import { useEffect, useRef, useState } from "react";
import { Scope } from "@/components/Scope";
import { Button } from "@/components/ui/button";

type Bridge = {
  connected?: boolean; sending?: boolean; armed?: boolean; rudderHold?: boolean; mode?: string; vehicle?: string;
  gps?: string; battery?: string; lastMessage?: string; frames?: number; overridesSent?: number;
  controller?: string | null;
  axes?: { left: number; right: number; lt: number; rt: number; a: boolean; b: boolean };
  pwm?: { left: number; right: number; rudder: number };
  errors?: string[];
};
const blank: Bridge = { axes: { left: 0, right: 0, lt: 0, rt: 0, a: false, b: false }, pwm: { left: 1500, right: 1500, rudder: 1500 } };

export default function BackgroundAgentPage() {
  const [token, setToken] = useState("");
  const [bridge, setBridge] = useState<Bridge>(blank);
  const [connected, setConnected] = useState(false);
  const [message, setMessage] = useState("Local laptop agent disconnected");
  const [logs, setLogs] = useState<string[]>(["Start boat_agent.py in Terminal, then paste its one-time token here."]);
  const socket = useRef<WebSocket | null>(null);

  useEffect(() => {
    setToken(localStorage.getItem("haav-local-agent-token") ?? "");
    return () => socket.current?.close();
  }, []);

  const log = (line: string) => setLogs(old => [`${new Date().toLocaleTimeString()}  ${line}`, ...old].slice(0, 40));
  const connect = () => {
    if (!token.trim()) { log("Paste the token printed in the agent terminal first."); return; }
    localStorage.setItem("haav-local-agent-token", token.trim());
    setMessage("Connecting to laptop agent…");
    const ws = new WebSocket("ws://127.0.0.1:8765");
    socket.current = ws;
    ws.onopen = () => ws.send(JSON.stringify({ token: token.trim() }));
    ws.onmessage = event => {
      const data = JSON.parse(event.data);
      if (data.type === "error") { log(data.message); return; }
      setBridge(data);
      setConnected(true);
      setMessage(data.connected ? "Pixhawk + laptop agent connected" : "Laptop agent connected; waiting for Pixhawk");
      if (data.type === "ack") log(`Agent accepted: ${data.action}`);
    };
    ws.onerror = () => { setConnected(false); setMessage("Cannot reach laptop agent"); log("Could not reach ws://127.0.0.1:8765. Check the terminal agent and browser local-network permission."); };
    ws.onclose = () => { setConnected(false); setBridge(blank); setMessage("Local laptop agent disconnected"); };
  };
  const disconnect = () => { socket.current?.close(); socket.current = null; };
  const send = (action: string) => {
    if (!socket.current || socket.current.readyState !== WebSocket.OPEN) { log("Connect to the laptop agent first."); return; }
    socket.current.send(JSON.stringify({ action }));
  };

  const axes = bridge.axes ?? blank.axes!;
  const pwm = bridge.pwm ?? blank.pwm!;

  return <main className="mx-auto flex h-screen max-w-[1440px] flex-col gap-4 overflow-auto p-4 text-sm md:p-6">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div><p className="text-[11px] uppercase tracking-[.16em] text-muted-foreground">HAAV / Background control</p><h1 className="text-2xl font-semibold">Laptop MAVLink agent</h1></div>
      <span className={`rounded-full border px-3 py-1.5 text-xs ${connected ? "border-ok/50 text-ok-foreground" : "border-border text-muted-foreground"}`}>{message}</span>
    </header>
    <div className="rounded-lg border border-warn/50 bg-warn/10 p-3 text-sm"><b>Props off for bench tests.</b> The laptop agent owns the Xbox controller, serial port, and control loop; it continues when this page is backgrounded. Chrome may ask to allow Mission Control to access the laptop local network.</div>

    <section className="flex flex-wrap items-end gap-2 rounded-lg border border-border bg-card p-3">
      <label className="flex min-w-[260px] flex-1 flex-col gap-1 text-xs text-muted-foreground" htmlFor="local-token">One-time token from Terminal
        <input id="local-token" type="password" autoComplete="off" spellCheck={false} value={token} onChange={e => setToken(e.target.value)} disabled={connected} placeholder="Paste token from boat_agent.py" className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground" />
      </label>
      <Button onClick={connect} disabled={connected}>Connect agent</Button>
      <Button variant="outline" onClick={disconnect} disabled={!connected}>Disconnect</Button>
    </section>

    <section className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-8">
      <Readout label="Vehicle" value={bridge.vehicle ?? "—"}/><Readout label="Mode" value={bridge.mode ?? "—"}/><Readout label="Armed" value={bridge.armed ? "ARMED" : "Disarmed"}/><Readout label="GPS" value={bridge.gps ?? "—"}/>
      <Readout label="Battery" value={bridge.battery ?? "—"}/><Readout label="Last message" value={bridge.lastMessage ?? "—"}/><Readout label="Frames" value={String(bridge.frames ?? 0)}/><Readout label="Overrides" value={String(bridge.overridesSent ?? 0)}/>
    </section>

    <section className="grid grid-cols-1 gap-4 rounded-lg border border-border bg-card p-4 lg:grid-cols-2">
      <Scope title="Left stick → left thruster" series={[{ name: "Left", color: "#86efac", value: axes.left }]}/>
      <Scope title="Right stick → right thruster" series={[{ name: "Right", color: "#7dd3fc", value: axes.right }]}/>
      <Scope title="Triggers → rudder" range={[0, 1]} series={[{ name: "LT", color: "#fdba74", value: axes.lt }, { name: "RT", color: "#f0abfc", value: axes.rt }]}/>
      <Scope title="PWM preview" series={[{ name: "Left", color: "#86efac", value: (pwm.left - 1500) / 500 }, { name: "Right", color: "#7dd3fc", value: (pwm.right - 1500) / 500 }, { name: "Rudder", color: "#fdba74", value: (pwm.rudder - 1500) / 500 }]}/>
    </section>

    <section className="flex flex-wrap items-center gap-2">
      {bridge.sending ? <Button variant="destructive" onClick={() => send("stop")}>Stop output</Button> : <Button onClick={() => send("start")} disabled={!connected || !bridge.connected || !bridge.controller}>Start output</Button>}
      <Button variant="outline" onClick={() => send("arm")} disabled={!connected || !bridge.connected}>MANUAL + arm</Button>
      <Button variant="destructive" onClick={() => send("disarm")} disabled={!connected || !bridge.connected}>Disarm</Button>
      <span className="ml-auto text-xs text-muted-foreground">A = arm / B = disarm · LT/RT steer rudder · ESC in Terminal stops the agent</span>
    </section>
    {bridge.rudderHold && <div role="status" className="rounded-md border border-ok/40 bg-ok/10 px-3 py-2 text-xs text-ok-foreground">Disarmed: the laptop agent is holding the rudder centered.</div>}
    <div className="grid grid-cols-3 gap-2"><Readout label="Left motor PWM" value={String(pwm.left)}/><Readout label="Right motor PWM" value={String(pwm.right)}/><Readout label="Rudder PWM" value={String(pwm.rudder)}/></div>
    <pre className="min-h-[100px] overflow-auto rounded-lg border border-border bg-background p-3 text-xs text-muted-foreground">{[...logs, ...(bridge.errors ?? [])].join("\n")}</pre>
  </main>;
}

function Readout({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0 rounded-lg border border-border bg-card px-3 py-2"><div className="truncate text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div><div className="truncate pt-1 font-mono text-sm text-foreground">{value}</div></div>;
}
