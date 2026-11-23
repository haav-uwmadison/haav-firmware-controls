// Client for mission_daemon (daemon/ at the repo root). The daemon owns the controller and the serial
// port and streams the same MissionState shape the in-browser controller produces, so the page is
// unchanged. Protocol (JSON text frames):
//   daemon -> browser: {type:"hello", ...state, logs:[...], trail:[[lat,lon]...], version}
//                      {type:"state", ...state}            about 30 Hz
//                      {type:"log", line:{id,time,kind,text}}
//                      {type:"trail", point:[lat,lon]} | {type:"trailClear"}
//                      {type:"params", items:[{name,value,type,index}], count, loading} | {type:"paramsClear", loading}
//   browser -> daemon: {name:"connect"|"disconnect"|"startOutput"|"stopOutput"|"arm"|"disarm"|"panic"|"clearTrail"|"refreshParams"}
//                      {name:"setMotorSpan", span} | {name:"setMotorReverse", motor:"left"|"right", reverse} | {name:"setBaud", baud}
//                      {name:"setParam", param, value} | {name:"commandLong", command, params:[...]}

import type { MissionApi } from "./mission-api";
import { blankParams, initialMissionState, type LogLine, type MissionState, type Param, type TrailPoint } from "./mission-controller";

export const DAEMON_PORT = 8765;
/** `?ws=<port>` on the page picks a daemon started with `--ws <port>`; otherwise the default port. */
export function daemonUrl(): string {
  const port = typeof window === "undefined" ? null : Number(new URLSearchParams(window.location.search).get("ws"));
  return `ws://127.0.0.1:${port && port > 0 && port < 65536 ? port : DAEMON_PORT}`;
}
const LOG_LIMIT = 200;

type Hello = Partial<MissionState> & { type: "hello"; logs?: LogLine[]; trail?: TrailPoint[]; version?: string };

/** Opens a short-lived socket to see whether the daemon is running. Resolves within `timeoutMs`. */
export function probeDaemon(timeoutMs = 1500, url = daemonUrl()): Promise<boolean> {
  return new Promise(resolve => {
    let done = false;
    const finish = (ok: boolean) => { if (!done) { done = true; resolve(ok); } };
    try {
      const ws = new WebSocket(url);
      const timer = window.setTimeout(() => { finish(false); ws.close(); }, timeoutMs);
      ws.onopen = () => { window.clearTimeout(timer); finish(true); ws.close(); };
      ws.onerror = () => { window.clearTimeout(timer); finish(false); };
    } catch { finish(false); }
  });
}

export class DaemonClient implements MissionApi {
  private state: MissionState = initialMissionState;
  private readonly listeners = new Set<() => void>();
  private ws: WebSocket | null = null;
  private disposed = false;
  version = "";

  constructor(private readonly url = daemonUrl(), private readonly onClosed?: () => void) {}

  getState = (): MissionState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

  private set(patch: Partial<MissionState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  start(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onmessage = event => this.onMessage(String(event.data));
    ws.onclose = () => { this.ws = null; if (!this.disposed) this.onClosed?.(); };
    ws.onerror = () => ws.close();
  }

  dispose(): void {
    this.disposed = true;
    this.ws?.close(); this.ws = null;
  }

  private onMessage(text: string): void {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(text); } catch { return; }
    switch (msg.type) {
      case "hello": {
        const hello = msg as Hello;
        this.version = hello.version ?? "";
        const { type: _type, logs, trail, version: _version, ...rest } = hello;
        void _type; void _version;
        this.set({ ...rest, logs: logs ?? [], trail: trail ?? [] });
        break;
      }
      case "state": {
        const { type: _type, ...rest } = msg as Partial<MissionState> & { type: string };
        void _type;
        this.set(rest);
        break;
      }
      case "log": {
        const line = msg.line as LogLine;
        this.set({ logs: [...this.state.logs, line].slice(-LOG_LIMIT) });
        break;
      }
      case "trail": {
        const point = msg.point as TrailPoint;
        this.set({ trail: [...this.state.trail, point].slice(-1200) });
        break;
      }
      case "trailClear": this.set({ trail: [] }); break;
      case "params": {
        // Batched PARAM_VALUEs from the daemon; the full table also rides in hello.
        const { items, count, loading } = msg as { items: Param[]; count: number; loading: boolean };
        const byName = { ...this.state.params.byName };
        for (const p of items) byName[p.name] = p;
        this.set({ params: { byName, count, received: Object.keys(byName).length, loading, updatedAt: Date.now() } });
        break;
      }
      case "paramsClear": this.set({ params: { ...blankParams, loading: !!msg.loading } }); break;
    }
  }

  private send(command: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(command));
  }

  setBaud(baud: string): void { this.send({ name: "setBaud", baud }); }
  setMotorSpan(span: number): void { this.send({ name: "setMotorSpan", span: Math.round(span) }); }
  setMotorReverse(motor: "left" | "right", reverse: boolean): void { this.send({ name: "setMotorReverse", motor, reverse }); }
  clearTrail(): void { this.send({ name: "clearTrail" }); }
  refreshParams(): void { this.send({ name: "refreshParams" }); }
  setParam(name: string, value: number): void { this.send({ name: "setParam", param: name, value }); }
  sendCommand(command: number, params: number[] = []): void { this.send({ name: "commandLong", command, params }); }
  connect(): void { this.send({ name: "connect" }); }
  disconnect(): void { this.send({ name: "disconnect" }); }
  startOutput(): void { this.send({ name: "startOutput" }); }
  stopOutput(reason: string): void { this.send({ name: "stopOutput", reason }); }
  arm(): void { this.send({ name: "arm" }); }
  disarm(): void { this.send({ name: "disarm" }); }
  panic(): void { this.send({ name: "panic" }); }
  /** Same key map as MissionController.handleShortcut, decided from the daemon's last state. */
  handleShortcut(key: string): void {
    const s = this.state;
    switch (key.toLowerCase()) {
      case "escape": this.panic(); break;
      case "a": if (s.connected && s.telemetry.armed === false && !s.armPending) this.arm(); break;
      case "b": if (s.connected && s.telemetry.armed !== false && !s.armPending) this.disarm(); break;
      case "l": if (!s.connecting) { if (s.connected) this.disconnect(); else this.connect(); } break;
      case "o": if (s.sending) this.stopOutput("O pressed"); else this.startOutput(); break;
    }
  }
}
