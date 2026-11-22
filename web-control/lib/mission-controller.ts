// The boat's ground-station logic with no React in it: serial link, MAVLink telemetry, the 20 Hz
// control loop, arming, watchdogs and GPS tracking. The UI subscribes to an immutable state snapshot
// and calls the public methods. Everything time- or browser-dependent is injected or started lazily so
// this class can be constructed during server rendering and unit tested in Node.

import { commandToPwm, controllerToCommand, DEFAULT_MOTOR_SPAN, MAX_MOTOR_SPAN, MIN_MOTOR_SPAN, pwmToChannels, rudderNeutralChannels, ReversePause, type BoatPwm } from "./boat-control";
import { noController, type ControllerState } from "./gamepad";
import { ackResults, build, decodeAttitude, decodeCommandAck, decodeGlobalPositionInt, decodeGpsRawInt, decodeHeartbeat, decodeParamValue, decodeStatusText, decodeSysStatus, MAV_CMD, MAV_MODE_FLAG_CUSTOM_MODE_ENABLED, MavlinkEncoder, MavlinkParser, messageNames, MSG, ROVER_MODE_MANUAL, type Frame } from "./mavlink";
import { SerialLink } from "./serial-link";

// ---- types shared with the UI -----------------------------------------------------------------

export type LogKind = "info" | "pixhawk" | "ack" | "warn" | "error";
export type LogLine = { id: number; time: string; kind: LogKind; text: string };
export type OutputPhase = "idle" | "sending" | "stopped" | "error";
export type LinkPhase = "disconnected" | "opening" | "no-data" | "no-frames" | "waiting" | "heartbeat" | "lost" | "failed" | "port-lost";
export type ArmPending = false | "arm" | "disarm";
export type Telemetry = { vehicle: string; mode: string; armed: boolean | null; gps: string; battery: string; speed: string; heading: string; last: string };
export type BoatPosition = { lat: number; lon: number; /** degrees 0..360, null when unknown */ heading: number | null; fixType: number; satellites: number; time: number };
export type TrailPoint = [number, number];
/** One Pixhawk parameter. `type` is MAV_PARAM_TYPE (1 UINT8 … 9 REAL32). */
export type Param = { name: string; value: number; type: number; index: number };
export type ParamTable = { byName: Record<string, Param>; count: number; received: number; loading: boolean; updatedAt: number };
/** Numbers behind the primary flight display; null until the Pixhawk has sent them. */
export type Pfd = { rollDeg: number | null; pitchDeg: number | null; yawRateDps: number | null; speedMps: number | null; headingDeg: number | null };

export type MissionState = {
  // link
  connected: boolean; connecting: boolean; linkPhase: LinkPhase; lostSeconds: number; baud: string; portLabel: string;
  telemetry: Telemetry; frames: number; bytesIn: number; recovered: number; badCrc: number;
  logs: LogLine[]; position: BoatPosition | null; trail: TrailPoint[]; pfd: Pfd; params: ParamTable;
  // input
  controller: ControllerState; controllerLost: boolean;
  // output
  sending: boolean; outputPhase: OutputPhase; pwm: BoatPwm; overridesSent: number; heartbeatsSent: number; banner: string | null;
  armPending: ArmPending; motorSpan: number;
  /** why output cannot start right now, or null when it can */
  startBlockedReason: string | null;
};

/** Where controller samples come from. `GamepadSource` in lib/gamepad.ts is the browser implementation. */
export type InputSource = { latest(): ControllerState; subscribe(listener: (c: ControllerState) => void): () => void };

export type MissionOptions = {
  input: InputSource;
  /** persists the motor power limit; defaults to window.localStorage when available */
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  /** lets tests inject a fake link; defaults to Web Serial */
  createLink?: (events: ConstructorParameters<typeof SerialLink>[0]) => SerialLink;
  serialAvailable?: () => boolean;
};

// ---- constants ----------------------------------------------------------------------------------

export const TARGET_SYSTEM = 1, TARGET_COMPONENT = 1;   // the Pixhawk autopilot
export const GCS_SYSTEM = 255, GCS_COMPONENT = 190;      // must match MAV_GCS_SYSID on the Pixhawk
export const OVERRIDE_INTERVAL_MS = 50;                  // 20 Hz, same as the ESP32 firmware
export const HEARTBEAT_INTERVAL_MS = 1000;
export const HEARTBEAT_TIMEOUT_MS = 3000;
const LINK_SETTLE_MS = 3000;                             // how long to wait before calling a silent port "No data"
const ACK_TIMEOUT_MS = 2000;
const LAST_MESSAGE_REFRESH_MS = 3000;
const STOPPED_BADGE_MS = 3000;
const LOG_LIMIT = 200;
const TRAIL_LIMIT = 1200;                                // about 40 minutes at one point per 2 s
const PARAM_FLUSH_MS = 100;                              // batch PARAM_VALUEs into state updates
const PARAM_GAP_MS = 1500;                               // silence before asking for missing parameters
const PARAM_RETRY_BATCH = 40, PARAM_RETRY_LIMIT = 6;
const STORAGE_KEY_MOTOR_SPAN = "mission.motorSpan";

export const neutralPwm: BoatPwm = { left: 1500, right: 1500, rudder: 1500 };
export const bauds = ["57600", "115200", "921600"];
/** Message rates to ask the Pixhawk for once its heartbeat arrives: [message id, Hz]. */
export const streamRates: [number, number][] = [[MSG.ATTITUDE, 10], [MSG.GLOBAL_POSITION_INT, 5], [MSG.GPS_RAW_INT, 2], [MSG.SYS_STATUS, 2]];
export const blankParams: ParamTable = { byName: {}, count: 0, received: 0, loading: false, updatedAt: 0 };
export const blankPfd: Pfd = { rollDeg: null, pitchDeg: null, yawRateDps: null, speedMps: null, headingDeg: null };
const blankTelemetry: Telemetry = { vehicle: "—", mode: "—", armed: null, gps: "—", battery: "—", speed: "—", heading: "—", last: "—" };
const modeNames: Record<number, string> = { 0: "MANUAL", 1: "ACRO", 2: "STEERING", 3: "HOLD", 4: "LOITER", 5: "FOLLOW", 6: "GUIDED", 10: "AUTO", 11: "RTL", 12: "SMART_RTL", 15: "GUIDED_NOGPS", 16: "INITIALISING" };
const vehicleTypes: Record<number, string> = { 1: "Fixed wing", 2: "Quadrotor", 6: "Ground station", 10: "Ground rover", 11: "Surface boat", 12: "Submarine", 13: "Hexarotor", 14: "Octorotor", 29: "Ground rover" };
const usbVendors: Record<number, string> = { 0x0403: "FTDI", 0x10c4: "Silicon Labs", 0x1209: "Pixhawk", 0x2dae: "Holybro", 0x26ac: "3DR", 0x3162: "Holybro" };

export const initialMissionState: MissionState = {
  connected: false, connecting: false, linkPhase: "disconnected", lostSeconds: 0, baud: "57600", portLabel: "—",
  telemetry: blankTelemetry, frames: 0, bytesIn: 0, recovered: 0, badCrc: 0, logs: [], position: null, trail: [], pfd: blankPfd, params: blankParams,
  controller: noController, controllerLost: false,
  sending: false, outputPhase: "idle", pwm: neutralPwm, overridesSent: 0, heartbeatsSent: 0, banner: null,
  armPending: false, motorSpan: DEFAULT_MOTOR_SPAN, startBlockedReason: "Connect to the Pixhawk first",
};

// ---- controller ---------------------------------------------------------------------------------

export class MissionController {
  private state: MissionState = initialMissionState;
  private readonly listeners = new Set<() => void>();

  private link: SerialLink | null = null;
  private parser = new MavlinkParser();
  private readonly encoder = new MavlinkEncoder(GCS_SYSTEM, GCS_COMPONENT);
  private heartbeatAt = 0;
  private lostSince = 0;
  private streamsRequested = false;
  private paramBuffer = new Map<string, Param>();
  private paramCount = 0;
  private lastParamAt = 0;
  private paramRetries = 0;
  private paramFlush?: ReturnType<typeof setTimeout>;
  private connectedAt = 0;
  private lastMessage = "—";
  private seenErrors = new Set<string>();
  private logId = 0;
  private gps = { fixType: 0, satellites: 0 };
  private lastTrail: { lat: number; lon: number; time: number } | null = null;
  private prevButtons = { a: false, b: false };
  private started = false;
  private unsubscribeInput: (() => void) | null = null;
  private timers: { loop?: ReturnType<typeof setInterval>; rudder?: ReturnType<typeof setInterval>; watchdog?: ReturnType<typeof setInterval>; lastMessage?: ReturnType<typeof setInterval>; stopped?: ReturnType<typeof setTimeout>; ack?: ReturnType<typeof setTimeout> } = {};

  constructor(private readonly options: MissionOptions) {}

  // ---- store interface (useSyncExternalStore-compatible) -------------------------------------
  getState = (): MissionState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

  private set(patch: Partial<MissionState>): void {
    const next = { ...this.state, ...patch };
    next.startBlockedReason = !next.connected ? "Connect to the Pixhawk first" : !next.controller.connected ? "Press any button on the Xbox controller first" : null;
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  // ---- lifecycle -------------------------------------------------------------------------------
  /** Starts timers and controller sampling. Call once from the browser; safe to call again after dispose(). */
  start(): void {
    if (this.started) return;
    this.started = true;
    const storage = this.options.storage === undefined ? (typeof window !== "undefined" ? window.localStorage : null) : this.options.storage;
    try { const saved = Number(storage?.getItem(STORAGE_KEY_MOTOR_SPAN)); if (Number.isFinite(saved) && saved > 0) this.setMotorSpan(saved); } catch { /* storage unavailable */ }
    this.unsubscribeInput = this.options.input.subscribe(c => this.onInput(c));
    this.timers.watchdog = setInterval(() => this.watchdog(), 500);
    this.timers.lastMessage = setInterval(() => { if (this.state.telemetry.last !== this.lastMessage) this.set({ telemetry: { ...this.state.telemetry, last: this.lastMessage } }); }, LAST_MESSAGE_REFRESH_MS);
    // RCIN6Scaled follows RC6 even while disarmed, so hold only the rudder centred while the link is healthy and output is idle.
    this.timers.rudder = setInterval(() => {
      const s = this.state;
      if (!s.connected || s.sending || s.telemetry.armed !== false || Date.now() - this.heartbeatAt > HEARTBEAT_TIMEOUT_MS) return;
      void this.send(MSG.RC_CHANNELS_OVERRIDE, build.rcChannelsOverride(TARGET_SYSTEM, TARGET_COMPONENT, rudderNeutralChannels())).catch(() => undefined);
    }, OVERRIDE_INTERVAL_MS);
  }

  dispose(): void {
    if (!this.started) return;
    this.started = false;
    this.unsubscribeInput?.(); this.unsubscribeInput = null;
    for (const key of Object.keys(this.timers) as (keyof typeof this.timers)[]) { clearInterval(this.timers[key]); clearTimeout(this.timers[key]); }
    this.timers = {};
    void this.link?.disconnect();
  }

  // ---- public commands -------------------------------------------------------------------------
  setBaud(baud: string): void { if (!this.state.connected) this.set({ baud }); }

  /** Max PWM deviation from neutral for the motors, in µs. Applies to the next loop tick. */
  setMotorSpan(span: number): void {
    const clamped = Math.round(Math.min(MAX_MOTOR_SPAN, Math.max(MIN_MOTOR_SPAN, span)));
    this.set({ motorSpan: clamped });
    const storage = this.options.storage === undefined ? (typeof window !== "undefined" ? window.localStorage : null) : this.options.storage;
    try { storage?.setItem(STORAGE_KEY_MOTOR_SPAN, String(clamped)); } catch { /* storage unavailable */ }
  }

  clearTrail(): void { this.lastTrail = null; this.set({ trail: [] }); }

  async connect(): Promise<void> {
    if (this.state.connected || this.state.connecting) return;
    const available = this.options.serialAvailable ? this.options.serialAvailable() : SerialLink.available;
    if (!available) { this.set({ linkPhase: "failed" }); this.log("Web Serial is unavailable. Use Chrome or Edge on localhost or HTTPS.", "error"); return; }
    const events: ConstructorParameters<typeof SerialLink>[0] = {
      data: bytes => {
        if (this.state.bytesIn === 0) this.log(`First bytes from the port (${bytes.length}). If frames stay at 0 the baud rate is probably wrong.`);
        const bytesIn = this.state.bytesIn + bytes.length;
        for (const frame of this.parser.push(bytes)) this.handleFrame(frame);
        this.set({ bytesIn, badCrc: this.parser.badCrc });
      },
      log: message => this.log(message, "warn"),
      recovered: (name, message) => {
        this.set({ recovered: this.state.recovered + 1 });
        if (!this.seenErrors.has(name)) { this.seenErrors.add(name); this.log(`Read error "${message}" (${name}); port still open, resuming. Further ${name}s are counted, not logged.`, "warn"); }
      },
      closed: reason => {
        void this.stopOutput(reason ? "serial link lost" : "disconnected", { write: false });
        this.link = null; this.clearAckWait();
        this.set({ connected: false, linkPhase: reason ? "port-lost" : "disconnected" });
        if (reason) this.log(`Serial link lost: ${reason}`, "error"); else this.log("Disconnected");
      },
    };
    const link = this.options.createLink ? this.options.createLink(events) : new SerialLink(events);
    const baud = this.state.baud;
    this.set({ connecting: true, linkPhase: "opening" });
    try {
      await link.connect(Number(baud));
      this.link = link; this.parser = new MavlinkParser(); this.seenErrors = new Set();
      this.resetLinkState(); this.connectedAt = Date.now();
      const info = link.info;
      const portLabel = info?.usbVendorId ? `${usbVendors[info.usbVendorId] ?? `USB ${info.usbVendorId.toString(16)}`} ${info.usbProductId?.toString(16) ?? ""} · ${baud}`.trim() : `Serial · ${baud}`;
      this.set({ connected: true, connecting: false, linkPhase: "waiting", portLabel });
      this.log(`Serial port opened at ${baud} baud. Listening for MAVLink.`);
    } catch (error) {
      this.set({ connecting: false, linkPhase: "failed" });
      this.log(`Connect failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }

  async disconnect(): Promise<void> {
    await this.stopOutput("disconnecting");
    await this.link?.disconnect();
  }

  startOutput(): void {
    if (!this.link?.connected) { this.log("Connect to the Pixhawk before enabling control output.", "warn"); return; }
    if (!this.options.input.latest().connected) { this.log("Controller not detected. Press any button on it first.", "warn"); return; }
    if (this.state.sending) return;
    clearTimeout(this.timers.stopped);
    this.set({ sending: true, outputPhase: "sending", overridesSent: 0, heartbeatsSent: 0, banner: null, controllerLost: false });
    this.log("Control output started: RC override at 20 Hz, GCS heartbeat at 1 Hz. Overrides lapse 1 s after the stream stops (RC_OVERRIDE_TIME).");
    this.runLoop();
  }

  /** Stops the override stream. Sends one neutral frame so nothing stays latched; disarms when asked. */
  async stopOutput(reason: string, options: { disarm?: boolean; write?: boolean; phase?: OutputPhase } = {}): Promise<void> {
    if (!this.state.sending) return;
    clearInterval(this.timers.loop); this.timers.loop = undefined;
    const phase = options.phase ?? "stopped";
    this.set({ sending: false, pwm: neutralPwm, outputPhase: phase });
    clearTimeout(this.timers.stopped);
    if (phase === "stopped") this.timers.stopped = setTimeout(() => { if (this.state.outputPhase === "stopped") this.set({ outputPhase: "idle" }); }, STOPPED_BADGE_MS);
    this.log(`Control output stopped: ${reason}`, phase === "error" ? "error" : "warn");
    if (options.write === false) return;
    try {
      await this.sendOverride(neutralPwm);
      if (options.disarm) await this.disarm();
    } catch (error) { this.log(`Neutral/disarm on stop failed: ${String(error)}`, "error"); }
  }

  /** Sets MANUAL mode and arms. */
  async arm(): Promise<void> {
    try {
      await this.send(MSG.COMMAND_LONG, build.commandLong(TARGET_SYSTEM, TARGET_COMPONENT, MAV_CMD.DO_SET_MODE, [MAV_MODE_FLAG_CUSTOM_MODE_ENABLED, ROVER_MODE_MANUAL]));
      await this.send(MSG.COMMAND_LONG, build.commandLong(TARGET_SYSTEM, TARGET_COMPONENT, MAV_CMD.COMPONENT_ARM_DISARM, [1]));
      this.log("Sent: set MANUAL mode + arm"); this.waitForAck("arm");
    } catch (error) { this.log(`Arm failed: ${String(error)}`, "error"); }
  }

  /** Stops output if running, sends neutral, then disarms. */
  async disarm(): Promise<void> {
    if (this.state.sending) {
      clearInterval(this.timers.loop); this.timers.loop = undefined;
      this.set({ sending: false, pwm: neutralPwm, outputPhase: "stopped" });
      this.log("Control output stopped for disarm", "warn");
    }
    try {
      await this.sendOverride(neutralPwm);
      await this.send(MSG.COMMAND_LONG, build.commandLong(TARGET_SYSTEM, TARGET_COMPONENT, MAV_CMD.COMPONENT_ARM_DISARM, [0]));
      this.log("Sent neutral RC override + disarm"); this.waitForAck("disarm");
    } catch (error) { this.log(`Disarm failed: ${String(error)}`, "error"); }
  }

  /** Panic action (Esc): stop output and disarm; disarm alone when idle. */
  panic(): void {
    if (this.state.sending) void this.stopOutput("Esc pressed", { disarm: true });
    else if (this.link?.connected) void this.disarm();
  }

  /** Keyboard controls for the dashboard. The page filters editable fields and key repeats. */
  handleShortcut(key: string): void {
    switch (key.toLowerCase()) {
      case "escape": this.panic(); break;
      case "a":
        if (this.state.connected && this.state.telemetry.armed === false && !this.state.armPending) void this.arm();
        break;
      case "b":
        if (this.state.connected && this.state.telemetry.armed !== false && !this.state.armPending) void this.disarm();
        break;
      case "l":
        if (!this.state.connecting) void (this.state.connected ? this.disconnect() : this.connect());
        break;
      case "o":
        if (this.state.sending) void this.stopOutput("O pressed");
        else this.startOutput();
        break;
    }
  }

  // ---- control loop ----------------------------------------------------------------------------
  private runLoop(): void {
    const reverse = { left: new ReversePause(), right: new ReversePause() };
    let lastHeartbeat = 0, busy = false;
    this.timers.loop = setInterval(async () => {
      if (!this.state.sending || busy) return;
      const c = this.options.input.latest();
      if (!this.link?.connected) { void this.stopOutput("serial link closed", { write: false }); return; }
      if (!c.connected) {
        this.set({ controllerLost: true, banner: "Controller lost: outputs set to neutral and disarm sent." });
        void this.stopOutput("controller disconnected", { disarm: true });
        return;
      }
      busy = true;
      try {
        const now = performance.now();
        const command = controllerToCommand(c);
        const pwm = commandToPwm({ left: reverse.left.apply(command.left, now), right: reverse.right.apply(command.right, now), rudder: command.rudder }, this.state.motorSpan);
        this.set({ pwm });
        await this.sendOverride(pwm);
        this.set({ overridesSent: this.state.overridesSent + 1 });
        if (now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) { lastHeartbeat = now; await this.send(MSG.HEARTBEAT, build.gcsHeartbeat()); this.set({ heartbeatsSent: this.state.heartbeatsSent + 1 }); }
      } catch (error) {
        this.log(`Write failed: ${String(error)}`, "error");
        this.set({ banner: "Serial write failed: output stopped. Check the radio and reconnect." });
        void this.stopOutput("write error", { write: false, phase: "error" });
      } finally { busy = false; }
    }, OVERRIDE_INTERVAL_MS);
  }

  // ---- input -------------------------------------------------------------------------------------
  private onInput(c: ControllerState): void {
    const pressedA = c.a && !this.prevButtons.a, pressedB = c.b && !this.prevButtons.b;
    this.prevButtons = { a: c.a, b: c.b };
    this.set({ controller: c, controllerLost: c.connected ? false : this.state.controllerLost });
    // A = MANUAL + arm, B = disarm, whenever the link is up (not only while sending). Edge-triggered.
    if (!this.state.connected || this.state.armPending) return;
    if (pressedA) void this.arm();
    else if (pressedB) void this.disarm();
  }

  // ---- telemetry ---------------------------------------------------------------------------------
  private handleFrame(frame: Frame): void {
    this.set({ frames: this.state.frames + 1 });
    this.lastMessage = `${messageNames[frame.id] ?? `MSG ${frame.id}`} · ${frame.sysId}/${frame.compId}`;
    if (frame.sysId !== TARGET_SYSTEM) return;
    const t = this.state.telemetry;
    if (frame.id === MSG.HEARTBEAT && frame.compId === TARGET_COMPONENT) {
      const hb = decodeHeartbeat(frame.payload);
      if (this.lostSince) { this.log(`Heartbeat back after ${Math.round((Date.now() - this.lostSince) / 1000)} s`); this.lostSince = 0; }
      this.heartbeatAt = Date.now();
      if (!this.streamsRequested) { this.streamsRequested = true; void this.requestStreams().then(() => this.refreshParams()); }
      this.set({ telemetry: { ...t, vehicle: vehicleTypes[hb.type] ?? `MAV_TYPE ${hb.type}`, mode: modeNames[hb.customMode] ?? `Custom ${hb.customMode}`, armed: hb.armed } });
    } else if (frame.id === MSG.GPS_RAW_INT) {
      const gps = decodeGpsRawInt(frame.payload);
      this.gps = { fixType: gps.fixType, satellites: gps.satellites };
      const patch: Partial<MissionState> = { telemetry: { ...t, gps: gps.fixType >= 3 ? `Fix ${gps.fixType} · ${gps.satellites} sats` : `No 3D fix · ${gps.satellites} sats` } };
      // No fused position yet (EKF not ready): show the raw GPS fix so the map still works.
      if (gps.fixType >= 2 && !this.lastTrail) patch.position = { lat: gps.lat, lon: gps.lon, heading: null, ...this.gps, time: Date.now() };
      else if (gps.fixType < 2) patch.position = this.state.position ? { ...this.state.position, ...this.gps } : { lat: 0, lon: 0, heading: null, ...this.gps, time: Date.now() };
      this.set(patch);
    } else if (frame.id === MSG.GLOBAL_POSITION_INT) {
      const pos = decodeGlobalPositionInt(frame.payload);
      const patch: Partial<MissionState> = {
        telemetry: { ...t, speed: `${(pos.speedMps * 1.94384).toFixed(1)} kn`, heading: pos.headingDeg === null ? "—" : `${Math.round(pos.headingDeg) % 360}°` },
        // ATTITUDE's yaw is the better heading source (higher rate); keep the EKF heading only until it shows up.
        pfd: { ...this.state.pfd, speedMps: pos.speedMps, headingDeg: this.state.pfd.rollDeg === null ? pos.headingDeg : this.state.pfd.headingDeg },
      };
      if (pos.lat === 0 && pos.lon === 0) { this.set(patch); return; }
      const now = Date.now();
      patch.position = { lat: pos.lat, lon: pos.lon, heading: pos.headingDeg, ...this.gps, time: now };
      // Trail: keep a point every ~1 m or every 2 s.
      const last = this.lastTrail;
      const movedM = last ? Math.hypot((pos.lat - last.lat) * 111_320, (pos.lon - last.lon) * 111_320 * Math.cos((pos.lat * Math.PI) / 180)) : Infinity;
      if (!last || movedM > 1 || now - last.time > 2000) {
        this.lastTrail = { lat: pos.lat, lon: pos.lon, time: now };
        patch.trail = [...this.state.trail, [pos.lat, pos.lon] as TrailPoint].slice(-TRAIL_LIMIT);
      }
      this.set(patch);
    } else if (frame.id === MSG.PARAM_VALUE) {
      const p = decodeParamValue(frame.payload);
      this.paramBuffer.set(p.name, { name: p.name, value: p.value, type: p.type, index: p.index });
      this.paramCount = p.count; this.lastParamAt = Date.now();
      if (!this.paramFlush) this.paramFlush = setTimeout(() => this.flushParams(), PARAM_FLUSH_MS);
    } else if (frame.id === MSG.ATTITUDE) {
      const att = decodeAttitude(frame.payload);
      this.set({ pfd: { ...this.state.pfd, rollDeg: att.rollDeg, pitchDeg: att.pitchDeg, yawRateDps: att.yawRateDps, headingDeg: att.yawDeg } });
    } else if (frame.id === MSG.SYS_STATUS) {
      const sys = decodeSysStatus(frame.payload);
      this.set({ telemetry: { ...t, battery: sys.voltageMv === 65535 ? "n/a" : `${(sys.voltageMv / 1000).toFixed(2)} V${sys.batteryRemaining >= 0 ? ` · ${sys.batteryRemaining}%` : ""}` } });
    } else if (frame.id === MSG.STATUSTEXT) {
      const { severity, text } = decodeStatusText(frame.payload);
      if (text) this.log(`Pixhawk: ${text}`, severity <= 3 ? "error" : severity === 4 ? "warn" : "pixhawk");
    } else if (frame.id === MSG.COMMAND_ACK) {
      const ack = decodeCommandAck(frame.payload);
      if (ack.command === MAV_CMD.SET_MESSAGE_INTERVAL && ack.result === 0) return;   // four of these per connect; only failures are interesting
      const name = ack.command === MAV_CMD.COMPONENT_ARM_DISARM ? "arm/disarm" : ack.command === MAV_CMD.DO_SET_MODE ? "set mode" : ack.command === MAV_CMD.SET_MESSAGE_INTERVAL ? "message interval" : `command ${ack.command}`;
      this.log(`ACK ${name}: ${ackResults[ack.result] ?? ack.result}`, ack.result === 0 ? "ack" : "error");
      if (ack.command === MAV_CMD.COMPONENT_ARM_DISARM) this.clearAckWait();
    }
  }

  /** Link watchdog: turns byte/frame/heartbeat timing into the phase shown in the status bar. */
  private watchdog(): void {
    if (!this.link?.connected) return;
    const now = Date.now();
    void this.paramWatchdog(now);
    if (this.heartbeatAt) {
      const age = now - this.heartbeatAt;
      if (age > HEARTBEAT_TIMEOUT_MS) {
        if (!this.lostSince) { this.lostSince = this.heartbeatAt; this.log("Heartbeat lost. The Pixhawk's own failsafes now own the boat.", "warn"); }
        this.set({ lostSeconds: Math.floor(age / 1000), linkPhase: "lost" });
      } else if (this.state.linkPhase !== "heartbeat") this.set({ linkPhase: "heartbeat" });
      return;
    }
    const settled = now - this.connectedAt > LINK_SETTLE_MS;
    const phase: LinkPhase = this.state.frames > 0 ? "waiting" : this.state.bytesIn > 0 ? (settled ? "no-frames" : "waiting") : settled ? "no-data" : "waiting";
    if (phase !== this.state.linkPhase) this.set({ linkPhase: phase });
  }

  // ---- helpers -----------------------------------------------------------------------------------
  private log(text: string, kind: LogKind = "info"): void {
    const line: LogLine = { id: ++this.logId, time: new Date().toLocaleTimeString(), kind, text };
    this.set({ logs: [...this.state.logs, line].slice(-LOG_LIMIT) });
  }

  private async send(id: number, payload: Uint8Array): Promise<void> {
    if (!this.link?.connected) throw new Error("Serial link is not connected");
    await this.link.write(this.encoder.encode(id, payload));
  }

  private sendOverride(p: BoatPwm): Promise<void> {
    return this.send(MSG.RC_CHANNELS_OVERRIDE, build.rcChannelsOverride(TARGET_SYSTEM, TARGET_COMPONENT, pwmToChannels(p)));
  }

  private waitForAck(what: "arm" | "disarm"): void {
    clearTimeout(this.timers.ack);
    this.set({ armPending: what });
    this.timers.ack = setTimeout(() => { this.set({ armPending: false }); this.log(`No ACK for ${what} within ${ACK_TIMEOUT_MS / 1000} s`, "warn"); }, ACK_TIMEOUT_MS);
  }

  // ---- parameters --------------------------------------------------------------------------------
  /** Ask the Pixhawk for its whole parameter table. Runs on every connect; the panel's Refresh re-runs it. */
  async refreshParams(): Promise<void> {
    if (!this.state.connected) return;
    this.paramBuffer.clear(); this.paramCount = 0; this.paramRetries = 0; this.lastParamAt = Date.now();
    this.set({ params: { ...blankParams, loading: true } });
    await this.send(MSG.PARAM_REQUEST_LIST, build.paramRequestList(TARGET_SYSTEM, TARGET_COMPONENT));
    this.log("Requested the parameter list");
  }

  private flushParams(): void {
    this.paramFlush = undefined;
    const byName = { ...this.state.params.byName };
    for (const p of this.paramBuffer.values()) byName[p.name] = p;
    this.paramBuffer.clear();
    const received = Object.keys(byName).length, count = Math.max(this.paramCount, received);
    const done = received >= count;
    if (done && this.state.params.loading) this.log(`${count} parameters loaded`);
    this.set({ params: { byName, count, received, loading: !done, updatedAt: Date.now() } });
  }

  /** The list stream drops frames on a radio link; ask for the gaps one index at a time. */
  private async paramWatchdog(now: number): Promise<void> {
    const t = this.state.params;
    if (!t.loading || !t.count || now - this.lastParamAt < PARAM_GAP_MS) return;
    if (this.paramRetries >= PARAM_RETRY_LIMIT) {
      this.log(`${t.count - t.received} parameters never arrived; press Refresh to try again`, "warn");
      this.set({ params: { ...t, loading: false } });
      return;
    }
    const have = new Set(Object.values(t.byName).map(p => p.index));
    const missing: number[] = [];
    for (let i = 0; i < t.count && missing.length < PARAM_RETRY_BATCH; i++) if (!have.has(i)) missing.push(i);
    this.paramRetries++; this.lastParamAt = now;
    for (const index of missing) await this.send(MSG.PARAM_REQUEST_READ, build.paramRequestRead(TARGET_SYSTEM, TARGET_COMPONENT, index));
  }

  /**
   * ArduPilot only streams what the ground station asks for, and the telemetry-port defaults are a
   * few hertz at best. Ask for the messages behind the PFD and the map at useful rates.
   */
  private async requestStreams(): Promise<void> {
    for (const [id, hz] of streamRates) {
      await this.send(MSG.COMMAND_LONG, build.commandLong(TARGET_SYSTEM, TARGET_COMPONENT, MAV_CMD.SET_MESSAGE_INTERVAL, [id, 1_000_000 / hz]));
    }
    this.log(`Requested ${streamRates.map(([id, hz]) => `${messageNames[id]} ${hz} Hz`).join(", ")}`);
  }

  private clearAckWait(): void { clearTimeout(this.timers.ack); if (this.state.armPending) this.set({ armPending: false }); }

  private resetLinkState(): void {
    this.heartbeatAt = 0; this.lostSince = 0; this.streamsRequested = false; this.lastMessage = "—";
    clearTimeout(this.paramFlush); this.paramFlush = undefined; this.paramBuffer.clear(); this.paramCount = 0; this.gps = { fixType: 0, satellites: 0 }; this.lastTrail = null;
    this.set({ telemetry: blankTelemetry, frames: 0, bytesIn: 0, recovered: 0, badCrc: 0, lostSeconds: 0, position: null, pfd: blankPfd, params: blankParams });
  }
}
