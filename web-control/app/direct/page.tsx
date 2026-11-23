"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Scope } from "../../components/Scope";
import { commandToPwm, controllerToCommand, pwmToChannels, rudderNeutralChannels, ReversePause, type BoatPwm } from "../../lib/boat-control";
import { useGamepad } from "../../lib/gamepad";
import { ackResults, build, decodeCommandAck, decodeGpsRawInt, decodeHeartbeat, decodeStatusText, decodeSysStatus, MAV_CMD, MAV_MODE_FLAG_CUSTOM_MODE_ENABLED, MavlinkEncoder, MavlinkParser, messageNames, MSG, ROVER_MODE_MANUAL, type Frame } from "../../lib/mavlink";
import { SerialLink } from "../../lib/serial-link";

type VehicleStatus = { heartbeat: string; vehicle: string; mode: string; armed: string; gps: string; battery: string; last: string };

const blankStatus: VehicleStatus = { heartbeat: "Waiting", vehicle: "—", mode: "—", armed: "—", gps: "—", battery: "—", last: "—" };
const modeNames: Record<number, string> = { 0: "MANUAL", 1: "ACRO", 2: "STEERING", 3: "HOLD", 4: "LOITER", 5: "FOLLOW", 6: "GUIDED", 10: "AUTO", 11: "RTL", 12: "SMART_RTL", 15: "GUIDED_NOGPS", 16: "INITIALISING" };
const vehicleTypes: Record<number, string> = { 1: "Fixed wing", 2: "Quadrotor", 6: "Ground station", 10: "Ground rover", 11: "Surface boat", 12: "Submarine", 13: "Hexarotor", 14: "Octorotor", 29: "Ground rover" };

const TARGET_SYSTEM = 1, TARGET_COMPONENT = 1;   // the Pixhawk autopilot
const GCS_SYSTEM = 255, GCS_COMPONENT = 190;      // must match MAV_GCS_SYSID on the Pixhawk
const OVERRIDE_INTERVAL_MS = 50;                  // 20 Hz, same as the ESP32 firmware
const HEARTBEAT_INTERVAL_MS = 1000;
const neutralPwm: BoatPwm = { left: 1500, right: 1500, rudder: 1500 };

export default function Home() {
  const [connection, setConnection] = useState("Disconnected");
  const [connectionKind, setConnectionKind] = useState("");
  const [connected, setConnected] = useState(false);
  const [baud, setBaud] = useState("57600"); // telemetry radio rate; the Pixhawk's own USB port ignores baud
  const [status, setStatus] = useState(blankStatus);
  const [frames, setFrames] = useState(0);
  const [recovered, setRecovered] = useState(0);
  const [badCrc, setBadCrc] = useState(0);
  const [bytesIn, setBytesIn] = useState(0);
  const bytesInRef = useRef(0);
  const [logs, setLogs] = useState(["Ready. Choose Connect to Pixhawk and select its USB serial port."]);
  const [sending, setSending] = useState(false);
  const [pwm, setPwm] = useState<BoatPwm>(neutralPwm);
  const [overridesSent, setOverridesSent] = useState(0);

  const linkRef = useRef<SerialLink | null>(null);
  const parserRef = useRef(new MavlinkParser());
  const encoderRef = useRef(new MavlinkEncoder(GCS_SYSTEM, GCS_COMPONENT));
  const heartbeatRef = useRef(0);
  const gpsCandidateRef = useRef("");
  const gpsCandidateSinceRef = useRef(0);
  const sendingRef = useRef(false);
  const seenErrorsRef = useRef(new Set<string>());

  const { state: controller, latest: controllerRef } = useGamepad();

  const log = useCallback((message: string) => setLogs(old => [`${new Date().toLocaleTimeString()}  ${message}`, ...old].slice(0, 80)), []);

  // ---- incoming telemetry -------------------------------------------------------------------
  const handleFrame = useCallback((frame: Frame) => {
    setFrames(count => count + 1);
    setStatus(old => ({ ...old, last: `${messageNames[frame.id] ?? `MSG ${frame.id}`} · ${frame.sysId}/${frame.compId}` }));
    if (frame.sysId !== TARGET_SYSTEM) return;
    if (frame.id === MSG.HEARTBEAT && frame.compId === TARGET_COMPONENT) {
      const hb = decodeHeartbeat(frame.payload);
      heartbeatRef.current = Date.now();
      setStatus(old => ({ ...old, heartbeat: "Received", vehicle: vehicleTypes[hb.type] ?? `MAV_TYPE ${hb.type}`, mode: modeNames[hb.customMode] ?? `Custom ${hb.customMode}`, armed: hb.armed ? "ARMED" : "Disarmed" }));
      setConnection("Pixhawk heartbeat received"); setConnectionKind("ok");
    } else if (frame.id === MSG.GPS_RAW_INT) {
      const gps = decodeGpsRawInt(frame.payload);
      const fixState = gps.fixType >= 3 ? "3d" : "none";
      const now = Date.now();
      if (fixState !== gpsCandidateRef.current) {
        gpsCandidateRef.current = fixState;
        gpsCandidateSinceRef.current = now;
      } else if (now - gpsCandidateSinceRef.current >= 1500) {
        const nextGps = fixState === "3d" ? `Fix ${gps.fixType} · ${gps.satellites} sats` : `No 3D fix · ${gps.satellites} sats`;
        setStatus(old => old.gps === nextGps ? old : { ...old, gps: nextGps });
      }
    } else if (frame.id === MSG.SYS_STATUS) {
      const sys = decodeSysStatus(frame.payload);
      setStatus(old => ({ ...old, battery: sys.voltageMv === 65535 ? "Voltage n/a" : `${(sys.voltageMv / 1000).toFixed(2)} V${sys.batteryRemaining >= 0 ? ` · ${sys.batteryRemaining}%` : ""}` }));
    } else if (frame.id === MSG.STATUSTEXT) {
      const { text } = decodeStatusText(frame.payload);
      if (text) log(`Pixhawk: ${text}`);
    } else if (frame.id === MSG.COMMAND_ACK) {
      const ack = decodeCommandAck(frame.payload);
      const commandName = ack.command === MAV_CMD.COMPONENT_ARM_DISARM ? "arm/disarm" : ack.command === MAV_CMD.DO_SET_MODE ? "set mode" : `command ${ack.command}`;
      log(`ACK ${commandName}: ${ackResults[ack.result] ?? ack.result}`);
    }
  }, [log]);

  // ---- outgoing commands --------------------------------------------------------------------
  const send = useCallback(async (id: number, payload: Uint8Array) => {
    const link = linkRef.current;
    if (!link?.connected) throw new Error("Serial link is not connected");
    await link.write(encoderRef.current.encode(id, payload));
  }, []);

  const sendOverride = useCallback((p: BoatPwm) => send(MSG.RC_CHANNELS_OVERRIDE, build.rcChannelsOverride(TARGET_SYSTEM, TARGET_COMPONENT, pwmToChannels(p))), [send]);

  // RCIN6Scaled keeps following RC6 while disarmed. Keep the rudder centered
  // while this browser link is healthy and the operator has stopped output.
  useEffect(() => {
    if (!connected || sending || status.armed !== "Disarmed") return;
    const timer = window.setInterval(() => {
      if (Date.now() - heartbeatRef.current > 3000) return;
      void send(MSG.RC_CHANNELS_OVERRIDE, build.rcChannelsOverride(TARGET_SYSTEM, TARGET_COMPONENT, rudderNeutralChannels())).catch(() => {});
    }, OVERRIDE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [connected, sending, status.armed, send]);

  const armManual = useCallback(async () => {
    try {
      await send(MSG.COMMAND_LONG, build.commandLong(TARGET_SYSTEM, TARGET_COMPONENT, MAV_CMD.DO_SET_MODE, [MAV_MODE_FLAG_CUSTOM_MODE_ENABLED, ROVER_MODE_MANUAL]));
      await send(MSG.COMMAND_LONG, build.commandLong(TARGET_SYSTEM, TARGET_COMPONENT, MAV_CMD.COMPONENT_ARM_DISARM, [1]));
      log("Sent: set MANUAL mode + arm");
    } catch (error) { log(`Arm failed: ${String(error)}`); }
  }, [send, log]);

  const disarm = useCallback(async () => {
    if (sendingRef.current) { sendingRef.current = false; setSending(false); setPwm(neutralPwm); log("Control output stopped for disarm"); }
    try {
      await sendOverride(neutralPwm);
      await send(MSG.COMMAND_LONG, build.commandLong(TARGET_SYSTEM, TARGET_COMPONENT, MAV_CMD.COMPONENT_ARM_DISARM, [0]));
      log("Sent neutral RC override + disarm");
    }
    catch (error) { log(`Disarm failed: ${String(error)}`); }
  }, [send, sendOverride, log]);

  /** Stops the override stream. Sends one neutral frame so nothing stays latched; disarms when the controller was lost. */
  const stopSending = useCallback(async (reason: string, options: { disarm?: boolean; write?: boolean } = {}) => {
    if (!sendingRef.current) return;
    sendingRef.current = false; setSending(false); setPwm(neutralPwm);
    log(`Control output stopped: ${reason}`);
    if (options.write === false) return;
    try {
      await sendOverride(neutralPwm);
      if (options.disarm) await disarm();
    } catch (error) { log(`Neutral/disarm on stop failed: ${String(error)}`); }
  }, [log, sendOverride, disarm]);

  const startSending = useCallback(() => {
    if (!linkRef.current?.connected) { log("Connect to the Pixhawk before enabling control output."); return; }
    if (!controllerRef.current.connected) { log("Controller not detected. Press any button on it first."); return; }
    sendingRef.current = true; setSending(true); setOverridesSent(0);
    log("Control output started: RC override at 20 Hz, GCS heartbeat at 1 Hz. Overrides lapse 1 s after the stream stops (RC_OVERRIDE_TIME).");
  }, [controllerRef, log]);

  useEffect(() => {
    if (!sending) return;
    const reverse = { left: new ReversePause(), right: new ReversePause() };
    let lastHeartbeat = 0, busy = false, prevA = false, prevB = false;
    const timer = window.setInterval(async () => {
      if (!sendingRef.current || busy) return;
      const c = controllerRef.current;
      if (!linkRef.current?.connected) { void stopSending("serial link closed", { write: false }); return; }
      if (!c.connected) { void stopSending("controller disconnected", { disarm: true }); return; }
      busy = true;
      try {
        const now = performance.now();
        const command = controllerToCommand(c);
        const p = commandToPwm({ left: reverse.left.apply(command.left, now), right: reverse.right.apply(command.right, now), rudder: command.rudder });
        setPwm(p);
        await sendOverride(p);
        setOverridesSent(count => count + 1);
        if (now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) { lastHeartbeat = now; await send(MSG.HEARTBEAT, build.gcsHeartbeat()); }
        if (c.a && !prevA) await armManual();
        if (c.b && !prevB) await disarm();
        prevA = c.a; prevB = c.b;
      } catch (error) {
        log(`Write failed: ${String(error)}`);
        void stopSending("write error", { write: false });
      } finally { busy = false; }
    }, OVERRIDE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [sending, controllerRef, send, sendOverride, armManual, disarm, stopSending, log]);

  // ---- serial link --------------------------------------------------------------------------
  const connect = async () => {
    if (!SerialLink.available) { setConnection("Web Serial unavailable"); setConnectionKind("bad"); log("Use Chrome or Edge on localhost/HTTPS to access Web Serial."); return; }
    const link = new SerialLink({
      data: bytes => {
        if (bytesInRef.current === 0) log(`First bytes from the port (${bytes.length}). If frames stay at 0 the baud rate is probably wrong.`);
        bytesInRef.current += bytes.length; setBytesIn(bytesInRef.current);
        for (const frame of parserRef.current.push(bytes)) handleFrame(frame);
        setBadCrc(parserRef.current.badCrc);
      },
      log,
      recovered: (name, message) => {
        setRecovered(count => count + 1);
        if (!seenErrorsRef.current.has(name)) { seenErrorsRef.current.add(name); log(`Read error "${message}" (${name}); port still open, resuming. Further ${name}s are counted, not logged.`); }
      },
      closed: reason => {
        void stopSending(reason ? "serial link lost" : "disconnected", { write: false });
        linkRef.current = null; heartbeatRef.current = 0; setConnected(false);
        if (reason) { setConnection("Connection failed"); setConnectionKind("bad"); log(`Serial link lost: ${reason}`); }
        else { setConnection("Disconnected"); setConnectionKind(""); log("Disconnected"); }
      },
    });
    try {
      await link.connect(Number(baud));
      linkRef.current = link; parserRef.current = new MavlinkParser(); heartbeatRef.current = 0;
      gpsCandidateRef.current = ""; gpsCandidateSinceRef.current = 0;
      setConnected(true); setStatus(blankStatus); setFrames(0); setRecovered(0); setBadCrc(0); setBytesIn(0); bytesInRef.current = 0;
      setConnection("Serial connected; waiting for heartbeat"); setConnectionKind(""); log(`Serial port opened at ${baud} baud. Listening for MAVLink.`);
    } catch (error) {
      setConnection("Connection failed"); setConnectionKind("bad"); log(`Connect failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const disconnect = async () => { await stopSending("disconnecting"); await linkRef.current?.disconnect(); };

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (heartbeatRef.current && Date.now() - heartbeatRef.current > 3000) {
        setConnection("Heartbeat lost"); setConnectionKind("bad"); setStatus(old => ({ ...old, heartbeat: "Timed out" }));
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, []);

  const command = controllerToCommand(controller);

  return <main>
    <div className="top"><div><h1>Boat Link</h1><p>Xbox controller → Mac → Pixhawk over MAVLink</p></div><span className={`state ${connectionKind}`}>{connection}</span></div>
    <div className="controls">
      <button className="primary" onClick={connect} disabled={connected}>Connect to Pixhawk</button>
      <button onClick={disconnect} disabled={!connected}>Disconnect</button>
      <label htmlFor="baud">Baud</label>
      <select id="baud" value={baud} onChange={event => setBaud(event.target.value)} disabled={connected}><option>57600</option><option>115200</option><option>921600</option></select>
      <span className="muted">57600 for the telemetry radio; direct USB works at any rate</span>
    </div>
    <section className="grid">
      <Card label="Heartbeat" value={status.heartbeat}/><Card label="Vehicle" value={status.vehicle}/><Card label="Mode" value={status.mode}/><Card label="Armed" value={status.armed}/>
      <Card label="GPS" value={status.gps}/><Card label="Battery" value={status.battery}/><Card label="Bytes in / frames" value={`${bytesIn} / ${frames}`}/><Card label="Last message" value={status.last}/>
      <Card label="Read errors recovered" value={String(recovered)}/><Card label="Rejected frames (bad CRC)" value={String(badCrc)}/>
    </section>

    <div className="section-head">
      <h2>Controller</h2>
      <span className={`state ${controller.connected ? "ok" : ""}`}>{controller.connected ? controller.id : "Not detected · press any button on the controller"}</span>
    </div>
    <section className="scopes">
      <Scope title="Left stick (forward = +1)" series={[{ name: "Y", color: "#8ee0b4", value: controller.ly }]}/>
      <Scope title="Right stick (forward = +1)" series={[{ name: "Y", color: "#5ec8f2", value: controller.ry }]}/>
      <Scope title="Triggers" range={[0, 1]} series={[{ name: "LT", color: "#f2a65e", value: controller.lt }, { name: "RT", color: "#e36bd0", value: controller.rt }]}/>
      <Scope title="Boat command (after deadzone)" series={[{ name: "Left motor", color: "#8ee0b4", value: command.left }, { name: "Right motor", color: "#5ec8f2", value: command.right }, { name: "Rudder", color: "#f2a65e", value: command.rudder }]}/>
    </section>

    <div className="section-head">
      <h2>Control output</h2>
      <span className={`state ${sending ? "ok" : ""}`}>{sending ? "Sending RC override · 20 Hz" : "Idle"}</span>
    </div>
    <div className="notice"><b>Props off for bench tests.</b> Start output sends RC1/RC3/RC6 overrides from the sticks and triggers, plus a ground-station heartbeat. A on the controller sets MANUAL and arms, B disarms. Losing the controller or hiding this tab sends neutral and disarms; return to this tab and restart output to drive again.</div>
    <div className="controls">
      {sending
        ? <button className="warn" onClick={() => stopSending("stopped by user")}>Stop control output</button>
        : <button className="primary" onClick={startSending} disabled={!connected || !controller.connected}>Start control output</button>}
      <button onClick={armManual} disabled={!connected}>MANUAL + arm</button>
      <button className="danger" onClick={disarm} disabled={!connected}>Disarm</button>
    </div>
    <section className="grid">
      <Card label="Left motor (RC1)" value={`${pwm.left} µs`}/><Card label="Right motor (RC3)" value={`${pwm.right} µs`}/><Card label="Rudder (RC6)" value={`${pwm.rudder} µs`}/>
      <Card label="Overrides sent" value={String(overridesSent)}/><Card label="A / B" value={`${controller.a ? "A" : "–"} / ${controller.b ? "B" : "–"}`}/>
    </section>

    <h2>Connection log</h2><div id="log" aria-live="polite">{logs.join("\n")}</div>
  </main>;
}

function Card({ label, value }: { label: string; value: string }) {
  return <div className="card"><div className="label">{label}</div><div className="value">{value}</div></div>;
}
