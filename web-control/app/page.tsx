"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ConsolePanel, type OutputPhase } from "@/components/ConsolePanel";
import { ControllerPanel } from "@/components/ControllerPanel";
import { LogPanel, type LogKind, type LogLine } from "@/components/LogPanel";
import { StatusBar, type Readout, type Tone } from "@/components/StatusBar";
import { commandToPwm, controllerToCommand, DEFAULT_MOTOR_SPAN, MAX_MOTOR_SPAN, MIN_MOTOR_SPAN, pwmToChannels, rudderNeutralChannels, ReversePause, type BoatPwm } from "@/lib/boat-control";
import { useGamepad } from "@/lib/gamepad";
import { GpsMapPanel, type BoatPosition, type TrailPoint } from "@/components/GpsMap";
import { ackResults, build, decodeCommandAck, decodeGlobalPositionInt, decodeGpsRawInt, decodeHeartbeat, decodeStatusText, decodeSysStatus, MAV_CMD, MAV_MODE_FLAG_CUSTOM_MODE_ENABLED, MavlinkEncoder, MavlinkParser, messageNames, MSG, ROVER_MODE_MANUAL, type Frame } from "@/lib/mavlink";
import { SerialLink } from "@/lib/serial-link";

type Telemetry = { vehicle: string; mode: string; armed: boolean | null; gps: string; battery: string; last: string };
type LinkPhase = "disconnected" | "opening" | "no-data" | "no-frames" | "waiting" | "heartbeat" | "lost" | "failed" | "port-lost";

const blankTelemetry: Telemetry = { vehicle: "—", mode: "—", armed: null, gps: "—", battery: "—", last: "—" };
const modeNames: Record<number, string> = { 0: "MANUAL", 1: "ACRO", 2: "STEERING", 3: "HOLD", 4: "LOITER", 5: "FOLLOW", 6: "GUIDED", 10: "AUTO", 11: "RTL", 12: "SMART_RTL", 15: "GUIDED_NOGPS", 16: "INITIALISING" };
const vehicleTypes: Record<number, string> = { 1: "Fixed wing", 2: "Quadrotor", 6: "Ground station", 10: "Ground rover", 11: "Surface boat", 12: "Submarine", 13: "Hexarotor", 14: "Octorotor", 29: "Ground rover" };
const usbVendors: Record<number, string> = { 0x0403: "FTDI", 0x10c4: "Silicon Labs", 0x1209: "Pixhawk", 0x2dae: "Holybro", 0x26ac: "3DR", 0x3162: "Holybro" };

const TARGET_SYSTEM = 1, TARGET_COMPONENT = 1;   // the Pixhawk autopilot
const GCS_SYSTEM = 255, GCS_COMPONENT = 190;      // must match MAV_GCS_SYSID on the Pixhawk
const OVERRIDE_INTERVAL_MS = 50;                  // 20 Hz, same as the ESP32 firmware
const HEARTBEAT_INTERVAL_MS = 1000;
const HEARTBEAT_TIMEOUT_MS = 3000;
const LINK_SETTLE_MS = 3000;                      // how long to wait before calling a silent port "No data"
const ACK_TIMEOUT_MS = 2000;
const LAST_MESSAGE_REFRESH_MS = 3000;
const neutralPwm: BoatPwm = { left: 1500, right: 1500, rudder: 1500 };
const bauds = ["57600", "115200", "921600"];

const format = (n: number) => n.toLocaleString("en-US").replace(/,/g, " ");

export default function Home() {
  // ---- link + telemetry ---------------------------------------------------------------------
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [linkPhase, setLinkPhase] = useState<LinkPhase>("disconnected");
  const [lostSeconds, setLostSeconds] = useState(0);
  const [baud, setBaud] = useState("57600"); // telemetry radio rate; the Pixhawk's own USB port ignores baud
  const [telemetry, setTelemetry] = useState(blankTelemetry);
  const [frames, setFrames] = useState(0);
  const [bytesIn, setBytesIn] = useState(0);
  const [recovered, setRecovered] = useState(0);
  const [badCrc, setBadCrc] = useState(0);
  const [portLabel, setPortLabel] = useState("—");
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [position, setPosition] = useState<BoatPosition | null>(null);
  const [trail, setTrail] = useState<TrailPoint[]>([]);
  const [followBoat, setFollowBoat] = useState(true);
  const gpsRef = useRef({ fixType: 0, satellites: 0 });
  const lastTrailRef = useRef<{ lat: number; lon: number; time: number } | null>(null);

  // ---- control output -----------------------------------------------------------------------
  const [sending, setSending] = useState(false);
  const [outputPhase, setOutputPhase] = useState<OutputPhase>("idle");
  const [pwm, setPwm] = useState<BoatPwm>(neutralPwm);
  const [overridesSent, setOverridesSent] = useState(0);
  const [heartbeatsSent, setHeartbeatsSent] = useState(0);
  const [banner, setBanner] = useState<string | null>(null);
  const [controllerLost, setControllerLost] = useState(false);
  const [armPending, setArmPending] = useState<false | "arm" | "disarm">(false);
  const [motorSpan, setMotorSpanState] = useState(DEFAULT_MOTOR_SPAN);
  const motorSpanRef = useRef(DEFAULT_MOTOR_SPAN);

  const linkRef = useRef<SerialLink | null>(null);
  const parserRef = useRef(new MavlinkParser());
  const encoderRef = useRef(new MavlinkEncoder(GCS_SYSTEM, GCS_COMPONENT));
  const heartbeatRef = useRef(0);
  const lostSinceRef = useRef(0);
  const connectedAtRef = useRef(0);
  const bytesInRef = useRef(0);
  const framesRef = useRef(0);
  const sendingRef = useRef(false);
  const seenErrorsRef = useRef(new Set<string>());
  const logIdRef = useRef(0);
  const lastMessageRef = useRef("—");
  const stoppedTimerRef = useRef(0);
  const ackTimerRef = useRef(0);

  const { state: controller, latest: controllerRef } = useGamepad();

  // Motor power limit: remembered across reloads, read from a ref inside the 20 Hz loop.
  const setMotorSpan = useCallback((span: number) => {
    const clamped = Math.round(Math.min(MAX_MOTOR_SPAN, Math.max(MIN_MOTOR_SPAN, span)));
    motorSpanRef.current = clamped; setMotorSpanState(clamped);
    try { window.localStorage.setItem("mission.motorSpan", String(clamped)); } catch { /* storage unavailable */ }
  }, []);
  useEffect(() => {
    const saved = Number(window.localStorage.getItem("mission.motorSpan"));
    if (Number.isFinite(saved) && saved > 0) setMotorSpan(saved);
  }, [setMotorSpan]);

  const log = useCallback((text: string, kind: LogKind = "info") => {
    const line: LogLine = { id: ++logIdRef.current, time: new Date().toLocaleTimeString(), kind, text };
    setLogs(old => [...old, line].slice(-200));
  }, []);

  const clearAckWait = useCallback(() => { window.clearTimeout(ackTimerRef.current); setArmPending(false); }, []);

  // ---- incoming telemetry -------------------------------------------------------------------
  const handleFrame = useCallback((frame: Frame) => {
    framesRef.current += 1; setFrames(framesRef.current);
    lastMessageRef.current = `${messageNames[frame.id] ?? `MSG ${frame.id}`} · ${frame.sysId}/${frame.compId}`;
    if (frame.sysId !== TARGET_SYSTEM) return;
    if (frame.id === MSG.HEARTBEAT && frame.compId === TARGET_COMPONENT) {
      const hb = decodeHeartbeat(frame.payload);
      if (lostSinceRef.current) { log(`Heartbeat back after ${Math.round((Date.now() - lostSinceRef.current) / 1000)} s`); lostSinceRef.current = 0; }
      heartbeatRef.current = Date.now();
      setTelemetry(old => ({ ...old, vehicle: vehicleTypes[hb.type] ?? `MAV_TYPE ${hb.type}`, mode: modeNames[hb.customMode] ?? `Custom ${hb.customMode}`, armed: hb.armed }));
    } else if (frame.id === MSG.GPS_RAW_INT) {
      const gps = decodeGpsRawInt(frame.payload);
      gpsRef.current = { fixType: gps.fixType, satellites: gps.satellites };
      setTelemetry(old => ({ ...old, gps: gps.fixType >= 3 ? `Fix ${gps.fixType} · ${gps.satellites} sats` : `No 3D fix · ${gps.satellites} sats` }));
      // No fused position yet (EKF not ready): show the raw GPS fix so the map still works.
      if (gps.fixType >= 2 && !lastTrailRef.current) setPosition({ lat: gps.lat, lon: gps.lon, heading: null, ...gpsRef.current, time: Date.now() });
      else if (gps.fixType < 2) setPosition(old => old ? { ...old, ...gpsRef.current } : { lat: 0, lon: 0, heading: null, ...gpsRef.current, time: Date.now() });
    } else if (frame.id === MSG.GLOBAL_POSITION_INT) {
      const pos = decodeGlobalPositionInt(frame.payload);
      if (pos.lat === 0 && pos.lon === 0) return;
      const now = Date.now();
      setPosition({ lat: pos.lat, lon: pos.lon, heading: pos.headingDeg, ...gpsRef.current, time: now });
      // Trail: keep a point every ~1 m or every 2 s, capped at 1200 points (about 40 minutes at 2 s).
      const last = lastTrailRef.current;
      const movedM = last ? Math.hypot((pos.lat - last.lat) * 111_320, (pos.lon - last.lon) * 111_320 * Math.cos((pos.lat * Math.PI) / 180)) : Infinity;
      if (!last || movedM > 1 || now - last.time > 2000) {
        lastTrailRef.current = { lat: pos.lat, lon: pos.lon, time: now };
        setTrail(old => [...old, [pos.lat, pos.lon] as TrailPoint].slice(-1200));
      }
    } else if (frame.id === MSG.SYS_STATUS) {
      const sys = decodeSysStatus(frame.payload);
      setTelemetry(old => ({ ...old, battery: sys.voltageMv === 65535 ? "n/a" : `${(sys.voltageMv / 1000).toFixed(2)} V${sys.batteryRemaining >= 0 ? ` · ${sys.batteryRemaining}%` : ""}` }));
    } else if (frame.id === MSG.STATUSTEXT) {
      const { severity, text } = decodeStatusText(frame.payload);
      if (text) log(`Pixhawk: ${text}`, severity <= 3 ? "error" : severity === 4 ? "warn" : "pixhawk");
    } else if (frame.id === MSG.COMMAND_ACK) {
      const ack = decodeCommandAck(frame.payload);
      const name = ack.command === MAV_CMD.COMPONENT_ARM_DISARM ? "arm/disarm" : ack.command === MAV_CMD.DO_SET_MODE ? "set mode" : `command ${ack.command}`;
      log(`ACK ${name}: ${ackResults[ack.result] ?? ack.result}`, ack.result === 0 ? "ack" : "error");
      if (ack.command === MAV_CMD.COMPONENT_ARM_DISARM) clearAckWait();
    }
  }, [log, clearAckWait]);

  // ---- outgoing commands --------------------------------------------------------------------
  const send = useCallback(async (id: number, payload: Uint8Array) => {
    const link = linkRef.current;
    if (!link?.connected) throw new Error("Serial link is not connected");
    await link.write(encoderRef.current.encode(id, payload));
  }, []);

  const sendOverride = useCallback((p: BoatPwm) => send(MSG.RC_CHANNELS_OVERRIDE, build.rcChannelsOverride(TARGET_SYSTEM, TARGET_COMPONENT, pwmToChannels(p))), [send]);

  // RCIN6Scaled follows RC6 even while disarmed. Hold only the rudder centered
  // while this browser link is healthy and normal control output is stopped.
  useEffect(() => {
    if (!connected || sending || telemetry.armed !== false) return;
    const timer = window.setInterval(() => {
      if (Date.now() - heartbeatRef.current > HEARTBEAT_TIMEOUT_MS) return;
      void send(MSG.RC_CHANNELS_OVERRIDE, build.rcChannelsOverride(TARGET_SYSTEM, TARGET_COMPONENT, rudderNeutralChannels())).catch(() => {});
    }, OVERRIDE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [connected, sending, telemetry.armed, send]);

  const waitForAck = useCallback((what: string) => {
    window.clearTimeout(ackTimerRef.current);
    setArmPending(what === "arm" ? "arm" : "disarm");
    ackTimerRef.current = window.setTimeout(() => { setArmPending(false); log(`No ACK for ${what} within ${ACK_TIMEOUT_MS / 1000} s`, "warn"); }, ACK_TIMEOUT_MS);
  }, [log]);

  const armManual = useCallback(async () => {
    try {
      await send(MSG.COMMAND_LONG, build.commandLong(TARGET_SYSTEM, TARGET_COMPONENT, MAV_CMD.DO_SET_MODE, [MAV_MODE_FLAG_CUSTOM_MODE_ENABLED, ROVER_MODE_MANUAL]));
      await send(MSG.COMMAND_LONG, build.commandLong(TARGET_SYSTEM, TARGET_COMPONENT, MAV_CMD.COMPONENT_ARM_DISARM, [1]));
      log("Sent: set MANUAL mode + arm"); waitForAck("arm");
    } catch (error) { log(`Arm failed: ${String(error)}`, "error"); }
  }, [send, log, waitForAck]);

  const disarm = useCallback(async () => {
    if (sendingRef.current) {
      sendingRef.current = false; setSending(false); setPwm(neutralPwm); setOutputPhase("stopped");
      log("Control output stopped for disarm", "warn");
    }
    try {
      await sendOverride(neutralPwm);
      await send(MSG.COMMAND_LONG, build.commandLong(TARGET_SYSTEM, TARGET_COMPONENT, MAV_CMD.COMPONENT_ARM_DISARM, [0]));
      log("Sent neutral RC override + disarm"); waitForAck("disarm");
    }
    catch (error) { log(`Disarm failed: ${String(error)}`, "error"); }
  }, [send, sendOverride, log, waitForAck]);

  /** Stops the override stream. Sends one neutral frame so nothing stays latched; disarms when asked. */
  const stopSending = useCallback(async (reason: string, options: { disarm?: boolean; write?: boolean; phase?: OutputPhase } = {}) => {
    if (!sendingRef.current) return;
    sendingRef.current = false; setSending(false); setPwm(neutralPwm);
    const phase = options.phase ?? "stopped";
    setOutputPhase(phase);
    window.clearTimeout(stoppedTimerRef.current);
    if (phase === "stopped") stoppedTimerRef.current = window.setTimeout(() => setOutputPhase("idle"), 3000);
    log(`Control output stopped: ${reason}`, phase === "error" ? "error" : "warn");
    if (options.write === false) return;
    try {
      await sendOverride(neutralPwm);
      if (options.disarm) await disarm();
    } catch (error) { log(`Neutral/disarm on stop failed: ${String(error)}`, "error"); }
  }, [log, sendOverride, disarm]);

  const startBlockedReason = !connected ? "Connect to the Pixhawk first" : !controller.connected ? "Press any button on the Xbox controller first" : null;

  const startSending = useCallback(() => {
    if (!linkRef.current?.connected) { log("Connect to the Pixhawk before enabling control output.", "warn"); return; }
    if (!controllerRef.current.connected) { log("Controller not detected. Press any button on it first.", "warn"); return; }
    window.clearTimeout(stoppedTimerRef.current);
    sendingRef.current = true; setSending(true); setOutputPhase("sending"); setOverridesSent(0); setHeartbeatsSent(0); setBanner(null); setControllerLost(false);
    log("Control output started: RC override at 20 Hz, GCS heartbeat at 1 Hz. Overrides lapse 1 s after the stream stops (RC_OVERRIDE_TIME).");
  }, [controllerRef, log]);

  useEffect(() => {
    if (!sending) return;
    const reverse = { left: new ReversePause(), right: new ReversePause() };
    let lastHeartbeat = 0, busy = false;
    const timer = window.setInterval(async () => {
      if (!sendingRef.current || busy) return;
      const c = controllerRef.current;
      if (!linkRef.current?.connected) { void stopSending("serial link closed", { write: false }); return; }
      if (!c.connected) {
        setControllerLost(true); setBanner("Controller lost: outputs set to neutral and disarm sent.");
        void stopSending("controller disconnected", { disarm: true });
        return;
      }
      busy = true;
      try {
        const now = performance.now();
        const command = controllerToCommand(c);
        const p = commandToPwm({ left: reverse.left.apply(command.left, now), right: reverse.right.apply(command.right, now), rudder: command.rudder }, motorSpanRef.current);
        setPwm(p);
        await sendOverride(p);
        setOverridesSent(count => count + 1);
        if (now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) { lastHeartbeat = now; await send(MSG.HEARTBEAT, build.gcsHeartbeat()); setHeartbeatsSent(count => count + 1); }
      } catch (error) {
        log(`Write failed: ${String(error)}`, "error");
        setBanner("Serial write failed: output stopped. Check the radio and reconnect.");
        void stopSending("write error", { write: false, phase: "error" });
      } finally { busy = false; }
    }, OVERRIDE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [sending, controllerRef, send, sendOverride, stopSending, log]);

  // A = MANUAL + arm, B = disarm, whenever the Pixhawk link is up (not only while sending). Edge-triggered.
  const prevButtonsRef = useRef({ a: false, b: false });
  useEffect(() => {
    const prev = prevButtonsRef.current;
    const pressedA = controller.a && !prev.a, pressedB = controller.b && !prev.b;
    prevButtonsRef.current = { a: controller.a, b: controller.b };
    if (!connected || armPending) return;
    if (pressedA) void armManual();
    else if (pressedB) void disarm();
  }, [controller.a, controller.b, connected, armPending, armManual, disarm]);

  // Controller came back: clear the "lost" marker (the banner stays until the next start).
  useEffect(() => { if (controller.connected) setControllerLost(false); }, [controller.connected]);

  // ---- serial link --------------------------------------------------------------------------
  const resetLinkState = useCallback(() => {
    heartbeatRef.current = 0; lostSinceRef.current = 0; bytesInRef.current = 0; framesRef.current = 0; lastMessageRef.current = "—";
    setTelemetry(blankTelemetry); setFrames(0); setBytesIn(0); setRecovered(0); setBadCrc(0); setLostSeconds(0);
    setPosition(null); gpsRef.current = { fixType: 0, satellites: 0 }; lastTrailRef.current = null;
  }, []);

  const connect = async () => {
    if (!SerialLink.available) { setLinkPhase("failed"); log("Web Serial is unavailable. Use Chrome or Edge on localhost or HTTPS.", "error"); return; }
    const link = new SerialLink({
      data: bytes => {
        if (bytesInRef.current === 0) log(`First bytes from the port (${bytes.length}). If frames stay at 0 the baud rate is probably wrong.`);
        bytesInRef.current += bytes.length; setBytesIn(bytesInRef.current);
        for (const frame of parserRef.current.push(bytes)) handleFrame(frame);
        setBadCrc(parserRef.current.badCrc);
      },
      log: message => log(message, "warn"),
      recovered: (name, message) => {
        setRecovered(count => count + 1);
        if (!seenErrorsRef.current.has(name)) { seenErrorsRef.current.add(name); log(`Read error "${message}" (${name}); port still open, resuming. Further ${name}s are counted, not logged.`, "warn"); }
      },
      closed: reason => {
        void stopSending(reason ? "serial link lost" : "disconnected", { write: false });
        linkRef.current = null; setConnected(false); clearAckWait();
        if (reason) { setLinkPhase("port-lost"); log(`Serial link lost: ${reason}`, "error"); }
        else { setLinkPhase("disconnected"); log("Disconnected"); }
      },
    });
    setConnecting(true); setLinkPhase("opening");
    try {
      await link.connect(Number(baud));
      linkRef.current = link; parserRef.current = new MavlinkParser(); seenErrorsRef.current = new Set();
      resetLinkState(); connectedAtRef.current = Date.now();
      const info = link.info;
      setPortLabel(info?.usbVendorId ? `${usbVendors[info.usbVendorId] ?? `USB ${info.usbVendorId.toString(16)}`} ${info.usbProductId?.toString(16) ?? ""} · ${baud}`.trim() : `Serial · ${baud}`);
      setConnected(true); setLinkPhase("waiting");
      log(`Serial port opened at ${baud} baud. Listening for MAVLink.`);
    } catch (error) {
      setLinkPhase("failed"); log(`Connect failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    } finally { setConnecting(false); }
  };

  const disconnect = async () => { await stopSending("disconnecting"); await linkRef.current?.disconnect(); };

  // Link watchdog: turns byte/frame/heartbeat timing into the phase shown in the status bar.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!linkRef.current?.connected) return;
      const now = Date.now();
      if (heartbeatRef.current) {
        const age = now - heartbeatRef.current;
        if (age > HEARTBEAT_TIMEOUT_MS) {
          if (!lostSinceRef.current) { lostSinceRef.current = heartbeatRef.current; log("Heartbeat lost. The Pixhawk's own failsafes now own the boat.", "warn"); }
          setLostSeconds(Math.floor(age / 1000)); setLinkPhase("lost");
        } else setLinkPhase("heartbeat");
        return;
      }
      const settled = now - connectedAtRef.current > LINK_SETTLE_MS;
      if (framesRef.current > 0) setLinkPhase("waiting");
      else if (bytesInRef.current > 0) setLinkPhase(settled ? "no-frames" : "waiting");
      else setLinkPhase(settled ? "no-data" : "waiting");
    }, 500);
    return () => window.clearInterval(timer);
  }, [log]);

  // "Last msg" would flicker at frame rate, so the readout only refreshes every few seconds.
  useEffect(() => {
    const timer = window.setInterval(() => setTelemetry(old => old.last === lastMessageRef.current ? old : { ...old, last: lastMessageRef.current }), LAST_MESSAGE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  // Esc is the panic key (decision 11A): stop output and disarm; disarm alone when idle.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (sendingRef.current) { event.preventDefault(); void stopSending("Esc pressed", { disarm: true }); }
      else if (linkRef.current?.connected) { event.preventDefault(); void disarm(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stopSending, disarm]);

  // ---- readouts -----------------------------------------------------------------------------
  const heartbeatReadout: Record<LinkPhase, { value: string; tone: Tone }> = {
    disconnected: { value: "—", tone: "idle" }, opening: { value: "Opening port…", tone: "idle" }, "no-data": { value: "No data", tone: "warn" },
    "no-frames": { value: "No frames, check baud", tone: "warn" }, waiting: { value: "Waiting", tone: "idle" }, heartbeat: { value: "Received", tone: "ok" },
    lost: { value: `LOST ${lostSeconds} s`, tone: "danger" }, failed: { value: "Failed", tone: "danger" }, "port-lost": { value: "Port lost", tone: "danger" },
  };
  const outputReadout: Record<OutputPhase, { value: string; tone: Tone }> = {
    idle: { value: "Idle", tone: "idle" }, sending: { value: "Sending · 20 Hz", tone: "ok" }, stopped: { value: "Stopped", tone: "warn" }, error: { value: "Write error", tone: "danger" },
  };
  // Each status slot is also its control (one thing per state): Armed arms/disarms, Output starts/stops, Link connects/disconnects.
  const armedState = armPending === "arm" ? { value: "ARMING…", tone: "warn" as const }
    : armPending === "disarm" ? { value: "DISARMING…", tone: "warn" as const }
    : linkPhase === "lost" && telemetry.armed !== null ? { value: "UNKNOWN", tone: "warn" as const }
    : telemetry.armed === null ? { value: "—", tone: "idle" as const }
    : telemetry.armed ? { value: "● ARMED", tone: "danger" as const } : { value: "DISARMED", tone: "idle" as const };
  const armed: Readout = {
    label: "Armed", ...armedState, badge: true, live: true,
    action: telemetry.armed
      ? { onClick: () => void disarm(), hint: "click to disarm", disabled: !connected || !!armPending, title: "Disarm (Esc also disarms)" }
      : { onClick: () => void armManual(), hint: "click to arm", disabled: !connected || !!armPending || telemetry.armed === null, title: "Set MANUAL mode and arm" },
  };
  const output: Readout = {
    label: "Output", ...outputReadout[outputPhase], live: true,
    action: sending
      ? { onClick: () => void stopSending("stopped by user"), hint: "click to stop", title: "Stop control output (Esc also stops and disarms)" }
      : { onClick: startSending, hint: "click to start", disabled: !!startBlockedReason, title: startBlockedReason ?? "Start RC override at 20 Hz" },
  };
  const link: Readout = {
    label: "Link", ...heartbeatReadout[linkPhase], live: true,
    action: connected
      ? { onClick: () => void disconnect(), hint: "click to disconnect" }
      : { onClick: () => void connect(), hint: "click to connect", disabled: connecting, title: `Open the serial port at ${baud} baud` },
  };
  const primary: Readout[] = [
    armed,
    output,
    { label: "Mode", value: telemetry.mode },
    link,
    { label: "Controller", value: controller.connected ? "Connected" : controllerLost ? "Lost" : "—", tone: controller.connected ? "ok" : controllerLost ? "danger" : "idle" },
    { label: "Battery", value: telemetry.battery },
  ];
  const secondary: Readout[] = [
    { label: "Vehicle", value: telemetry.vehicle },
    { label: "GPS", value: telemetry.gps },
    { label: "Bytes / frames", value: `${format(bytesIn)} / ${format(frames)}` },
    { label: "Last msg", value: telemetry.last },
    { label: "Read errors", value: String(recovered), tone: recovered ? "warn" : undefined },
    { label: "Bad CRC", value: String(badCrc), tone: badCrc ? "warn" : undefined },
    { label: "Port", value: connected ? portLabel : "—" },
  ];

  const actions = connected ? null
    : <Select value={baud} onValueChange={setBaud}>
      <SelectTrigger size="sm" className="tabular w-[104px] font-mono" aria-label="Baud rate"><SelectValue /></SelectTrigger>
      <SelectContent>{bauds.map(b => <SelectItem key={b} value={b} className="font-mono">{b}</SelectItem>)}</SelectContent>
    </Select>;

  const command = controllerToCommand(controller);

  return <TooltipProvider>
    <div className="p-6 text-sm text-muted-foreground md:hidden">Mission needs a desktop Chrome window at least 768px wide.</div>
    <div className="hidden min-h-0 flex-col md:flex lg:h-screen lg:overflow-hidden">
      <StatusBar primary={primary} secondary={secondary} actions={actions} />
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[300px_1fr] xl:grid-cols-[360px_1fr]">
        <div className="order-2 min-h-0 lg:order-1"><ControllerPanel controller={controller} command={command} lost={controllerLost} /></div>
        <main className="order-1 mx-0 flex w-full max-w-none min-h-0 flex-col gap-4 p-4 lg:order-2">
          <ConsolePanel phase={outputPhase} pwm={pwm} overridesSent={overridesSent} heartbeatsSent={heartbeatsSent} banner={banner}
            motorSpan={motorSpan} onMotorSpanChange={setMotorSpan}
            format={format} />
          <div className="grid min-h-[260px] flex-1 grid-cols-1 gap-4 xl:grid-cols-2">
            <GpsMapPanel position={position} trail={trail} follow={followBoat} onFollowChange={setFollowBoat} onClearTrail={() => { setTrail([]); lastTrailRef.current = null; }} className="min-h-[260px]" />
            <LogPanel lines={logs} className="min-h-[220px]" />
          </div>
        </main>
      </div>
    </div>
  </TooltipProvider>;
}
