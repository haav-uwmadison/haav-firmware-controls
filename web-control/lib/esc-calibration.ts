// ESC throttle-range calibration, driven from the dashboard over whichever backend is active.
//
// A hobby ESC learns its throttle range when it powers up seeing full throttle, then sees minimum:
// two beeps at max, one beep once min is stored. Rover has no built-in routine for this, so we
// borrow the motor outputs: set SERVOn_FUNCTION to Disabled (0) for each motor channel, which lets
// MAV_CMD_DO_SET_SERVO drive the raw PWM, hold 2000 µs while the ESC battery goes in, drop to
// 1000 µs, then put the functions back. Every write is checked against the echoed parameter or
// the COMMAND_ACK before the next step.

import { MAV_CMD } from "./mavlink";
import type { MissionApi } from "./mission-api";
import type { MissionState } from "./mission-controller";

export const ESC_CAL_MAX_PWM = 2000;
export const ESC_CAL_MIN_PWM = 1000;
const SERVO_FUNCTION_DISABLED = 0;
/** SERVOn_FUNCTION values that mean "a motor": Throttle, ThrottleLeft, ThrottleRight. */
export const MOTOR_FUNCTIONS: Record<number, string> = { 70: "Throttle", 73: "ThrottleLeft", 74: "ThrottleRight" };
const STORAGE_KEY = "mission.escCalibration";
const PARAM_ECHO_MS = 2500, ACK_MS = 3000, ATTEMPTS = 3, POLL_MS = 50;

export type MotorOutput = { channel: number; func: number; name: string };
export type EscCalStep = "idle" | "preparing" | "max" | "min" | "restoring" | "done" | "error";
export type EscCalState = {
  step: EscCalStep;
  /** what the user should do or what just happened */
  message: string;
  /** outputs being calibrated, fixed when a run starts */
  outputs: MotorOutput[];
  /** SERVOn_FUNCTION values to put back, by channel; kept in localStorage so a reload can still restore */
  originals: Record<number, number>;
  busy: boolean;
};

export class EscCalibrationError extends Error {}

/** Motor channels from the parameter table, in channel order. */
export function motorOutputs(state: MissionState): MotorOutput[] {
  const out: MotorOutput[] = [];
  for (const [name, param] of Object.entries(state.params.byName)) {
    const m = /^SERVO(\d+)_FUNCTION$/.exec(name);
    if (m && MOTOR_FUNCTIONS[param.value]) out.push({ channel: Number(m[1]), func: param.value, name: MOTOR_FUNCTIONS[param.value] });
  }
  return out.sort((a, b) => a.channel - b.channel);
}

/** Why a calibration cannot start right now, or null when it can. */
export function escCalBlockedReason(state: MissionState): string | null {
  if (!state.connected) return "Connect to the Pixhawk first";
  if (state.linkPhase !== "heartbeat") return "Waiting for the Pixhawk heartbeat";
  if (state.telemetry.armed !== false) return "Disarm first";
  if (state.sending) return "Stop control output first";
  if (state.params.loading) return "Parameters are still loading";
  if (state.params.received === 0) return "Parameters have not loaded";
  if (motorOutputs(state).length === 0) return "No motor outputs found (no SERVOn_FUNCTION is Throttle, ThrottleLeft or ThrottleRight)";
  return null;
}

/** Channels whose function is Disabled but which a previous run says were motors: the boat cannot drive until they are restored. */
export function escCalNeedsRestore(state: MissionState, originals: Record<number, number>): number[] {
  return Object.keys(originals).map(Number).filter(ch => state.params.byName[`SERVO${ch}_FUNCTION`]?.value === SERVO_FUNCTION_DISABLED);
}

export const initialEscCalState: EscCalState = { step: "idle", message: "", outputs: [], originals: {}, busy: false };

export class EscCalibration {
  private state: EscCalState;
  private readonly listeners = new Set<() => void>();
  private guard: ReturnType<typeof setInterval> | undefined;
  private disposed = false;

  constructor(private readonly api: MissionApi, private readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null = typeof window === "undefined" ? null : window.localStorage) {
    this.state = { ...initialEscCalState };
  }

  /** Load any unfinished originals persisted before a page reload. Call from a client effect to avoid SSR hydration mismatches. */
  hydrate(): void {
    this.disposed = false;
    const originals = this.loadOriginals();
    if (Object.keys(originals).length > 0 && Object.keys(this.state.originals).length === 0) this.set({ originals });
  }

  getState = (): EscCalState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  dispose(): void { this.disposed = true; this.stopGuard(); }

  /** Take the motor outputs off their functions and hold them at max. */
  async start(): Promise<void> {
    if (this.state.busy || !["idle", "done", "error"].includes(this.state.step)) return;
    const mission = this.api.getState();
    const blocked = escCalBlockedReason(mission);
    if (blocked) { this.set({ step: "error", message: blocked }); return; }
    const outputs = motorOutputs(mission);
    const originals = Object.fromEntries(outputs.map(o => [o.channel, o.func]));
    this.saveOriginals(originals);
    this.set({ step: "preparing", outputs, originals, busy: true, message: "Taking the motor outputs off their functions…" });
    try {
      for (const o of outputs) await this.setParamChecked(`SERVO${o.channel}_FUNCTION`, SERVO_FUNCTION_DISABLED);
      this.set({ message: `Holding ${this.channelList()} at ${ESC_CAL_MAX_PWM} µs…` });
      for (const o of outputs) await this.setServoChecked(o.channel, ESC_CAL_MAX_PWM);
      this.set({ step: "max", busy: false, message: `${this.channelList()} at ${ESC_CAL_MAX_PWM} µs. Plug the ESC battery in. Two beeps mean the ESCs saw full throttle, then press Next.` });
      this.startGuard();
    } catch (error) { await this.fail(error); }
  }

  /** Drop to min so the ESC stores the range. */
  async next(): Promise<void> {
    if (this.state.busy || this.state.step !== "max") return;
    this.set({ busy: true, message: `Dropping ${this.channelList()} to ${ESC_CAL_MIN_PWM} µs…` });
    try {
      for (const o of this.state.outputs) await this.setServoChecked(o.channel, ESC_CAL_MIN_PWM);
      this.set({ step: "min", busy: false, message: `${this.channelList()} at ${ESC_CAL_MIN_PWM} µs. One beep means the range is stored. Press Finish to hand the outputs back to the motor functions.` });
    } catch (error) { await this.fail(error); }
  }

  /** Put the functions back. Outputs return to SERVOn_TRIM. */
  async finish(): Promise<void> {
    if (this.state.busy || this.state.step !== "min") return;
    this.stopGuard();
    this.set({ step: "restoring", busy: true, message: "Restoring the motor functions…" });
    try {
      await this.restoreFunctions();
      this.set({ step: "done", busy: false, message: `Done. ${this.channelList()} are back on ${this.state.outputs.map(o => o.name).join(" and ")}. Both ESCs now treat ${ESC_CAL_MIN_PWM}–${ESC_CAL_MAX_PWM} µs as their range.` });
    } catch (error) { await this.fail(error); }
  }

  /** Stop wherever we are and put the functions back. */
  async abort(): Promise<void> {
    if (this.state.busy || !["max", "min"].includes(this.state.step)) return;
    this.stopGuard();
    this.set({ step: "restoring", busy: true, message: "Aborting: restoring the motor functions…" });
    try {
      await this.restoreFunctions();
      this.set({ step: "idle", busy: false, message: "Calibration aborted. The motor outputs are back on their functions." });
    } catch (error) { await this.fail(error); }
  }

  /** Recovery after an error or a reload: write the remembered functions back. */
  async restore(): Promise<void> {
    if (this.state.busy) return;
    this.stopGuard();
    this.set({ step: "restoring", busy: true, message: "Restoring the motor functions…" });
    try {
      await this.restoreFunctions();
      this.set({ step: "idle", busy: false, message: "Motor outputs restored." });
    } catch (error) { await this.fail(error); }
  }

  // ---- steps -------------------------------------------------------------------------------------
  private async restoreFunctions(): Promise<void> {
    const entries = Object.entries(this.state.originals);
    for (const [channel, func] of entries) await this.setParamChecked(`SERVO${channel}_FUNCTION`, func, true);
    this.saveOriginals({});
    if (!this.disposed) this.set({ originals: {} });
  }

  /** PARAM_SET, then wait for the echoed PARAM_VALUE to show the new value. */
  private async setParamChecked(name: string, value: number, allowWhenDisposed = false): Promise<void> {
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      if (this.disposed && !allowWhenDisposed) throw new EscCalibrationError("Calibration cancelled");
      await this.api.setParam(name, value);
      if (await this.waitFor(s => s.params.byName[name]?.value === value, PARAM_ECHO_MS, allowWhenDisposed)) return;
      if (this.disposed && !allowWhenDisposed) throw new EscCalibrationError("Calibration cancelled");
    }
    throw new EscCalibrationError(`The Pixhawk did not confirm ${name} = ${value}`);
  }

  /** DO_SET_SERVO, then wait for its ACK. */
  private async setServoChecked(channel: number, pwm: number): Promise<void> {
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      if (this.disposed) throw new EscCalibrationError("Calibration cancelled");
      const before = this.api.getState().lastAck?.seq ?? 0;
      await this.api.sendCommand(MAV_CMD.DO_SET_SERVO, [channel, pwm]);
      const acked = await this.waitFor(s => !!s.lastAck && s.lastAck.seq > before && s.lastAck.command === MAV_CMD.DO_SET_SERVO, ACK_MS);
      if (this.disposed) throw new EscCalibrationError("Calibration cancelled");
      if (!acked) continue;
      const ack = this.api.getState().lastAck!;
      if (ack.result === 0) return;
      throw new EscCalibrationError(`The Pixhawk refused to set output ${channel} to ${pwm} µs (result ${ack.result}). Its SERVO${channel}_FUNCTION must be Disabled for DO_SET_SERVO to work.`);
    }
    throw new EscCalibrationError(`No ACK for setting output ${channel} to ${pwm} µs`);
  }

  private waitFor(predicate: (s: MissionState) => boolean, timeoutMs: number, allowWhenDisposed = false): Promise<boolean> {
    return new Promise(resolve => {
      const deadline = Date.now() + timeoutMs;
      const tick = () => {
        if (this.disposed && !allowWhenDisposed) { resolve(false); return; }
        if (predicate(this.api.getState())) { resolve(true); return; }
        if (Date.now() >= deadline) { resolve(false); return; }
        setTimeout(tick, POLL_MS);
      };
      tick();
    });
  }

  /** While outputs are held, bail out if the link drops or the boat gets armed. */
  private startGuard(): void {
    this.stopGuard();
    this.guard = setInterval(() => {
      const s = this.api.getState();
      if (!s.connected || s.linkPhase === "lost") {
        this.stopGuard();
        this.set({ step: "error", busy: false, message: `Link lost while ${this.channelList()} were held. Reconnect, then press Restore outputs before driving.` });
      } else if (s.telemetry.armed === true) {
        void this.abort();
      }
    }, 250);
  }
  private stopGuard(): void { clearInterval(this.guard); this.guard = undefined; }

  private async fail(error: unknown): Promise<void> {
    this.stopGuard();
    if (this.disposed) return;
    const text = error instanceof Error ? error.message : String(error);
    const pending = Object.keys(this.state.originals).length > 0;
    this.set({ step: "error", busy: false, message: pending ? `${text}. Press Restore outputs to put the motor functions back.` : text });
  }

  // ---- helpers -----------------------------------------------------------------------------------
  private channelList(): string {
    const chans = this.state.outputs.map(o => o.channel);
    return chans.length === 1 ? `Output ${chans[0]}` : `Outputs ${chans.join(" and ")}`;
  }
  private set(patch: Partial<EscCalState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private loadOriginals(): Record<number, number> {
    try {
      const saved = JSON.parse(this.storage?.getItem(STORAGE_KEY) ?? "null") as Record<string, unknown> | null;
      if (!saved || typeof saved !== "object") return {};
      return Object.fromEntries(Object.entries(saved).filter(([k, v]) => /^\d+$/.test(k) && typeof v === "number").map(([k, v]) => [Number(k), v as number]));
    } catch { return {}; }
  }
  private saveOriginals(originals: Record<number, number>): void {
    try {
      if (Object.keys(originals).length === 0) this.storage?.removeItem(STORAGE_KEY);
      else this.storage?.setItem(STORAGE_KEY, JSON.stringify(originals));
    } catch { /* storage unavailable */ }
  }
}
