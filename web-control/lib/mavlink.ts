// Minimal MAVLink v1/v2 framing for the boat: parse frames from the Pixhawk and build the few
// messages the ground station sends (heartbeat, RC override, arm/disarm, mode).
// Keep this file free of browser or React code so it can be unit tested in Node.

export const MSG = {
  HEARTBEAT: 0, SYS_STATUS: 1, PARAM_REQUEST_READ: 20, PARAM_REQUEST_LIST: 21, PARAM_VALUE: 22, PARAM_SET: 23, GPS_RAW_INT: 24, ATTITUDE: 30, GLOBAL_POSITION_INT: 33, MANUAL_CONTROL: 69,
  RC_CHANNELS_OVERRIDE: 70, VFR_HUD: 74, COMMAND_LONG: 76, COMMAND_ACK: 77, STATUSTEXT: 253,
} as const;

export const messageNames: Record<number, string> = Object.fromEntries(Object.entries(MSG).map(([name, id]) => [id, name]));

import { crcExtra } from "./mavlink-crc";

export const MAV_CMD = { DO_SET_MODE: 176, COMPONENT_ARM_DISARM: 400, DO_SET_SERVO: 183, SET_MESSAGE_INTERVAL: 511 } as const;
export const MAV_MODE_FLAG_CUSTOM_MODE_ENABLED = 1;
export const MAV_MODE_FLAG_SAFETY_ARMED = 128;
export const ROVER_MODE_MANUAL = 0;
export const RC_CHANNEL_IGNORE = 0xffff; // leave this channel untouched
export const RC_CHANNEL_RELEASE = 0;     // give the channel back to the receiver

export const ackResults: Record<number, string> = { 0: "ACCEPTED", 1: "TEMPORARILY_REJECTED", 2: "DENIED", 3: "UNSUPPORTED", 4: "FAILED", 5: "IN_PROGRESS", 6: "CANCELLED" };

export type Frame = {
  id: number;
  sysId: number;
  compId: number;
  seq: number;
  payload: Uint8Array;
};

function crcAccumulate(byte: number, crc: number): number {
  let tmp = (byte ^ (crc & 0xff)) & 0xff;
  tmp = (tmp ^ (tmp << 4)) & 0xff;
  return ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff;
}

/** CRC-16/MCRF4XX (X.25) as used by MAVLink. Check value for "123456789" is 0x6f91. */
export function crc16(bytes: Iterable<number>, seed = 0xffff): number {
  let crc = seed;
  for (const byte of bytes) crc = crcAccumulate(byte, crc);
  return crc;
}

/**
 * Accumulates raw bytes and yields complete, CRC-verified frames. A frame whose CRC fails, or whose message id
 * is not in the dialect table, is treated as a false sync: one byte is dropped and parsing resumes.
 */
export class MavlinkParser {
  private buffer: number[] = [];
  /** frames rejected for a bad CRC or unknown message id */
  badCrc = 0;

  push(chunk: Uint8Array): Frame[] {
    for (const byte of chunk) this.buffer.push(byte);
    const frames: Frame[] = [];
    const buffer = this.buffer;
    for (;;) {
      const start = buffer.findIndex(byte => byte === 0xfe || byte === 0xfd);
      if (start < 0) { buffer.length = 0; break; }
      if (start) buffer.splice(0, start);
      if (buffer.length < 3) break;
      const v2 = buffer[0] === 0xfd;
      const payloadLength = buffer[1];
      const headerLength = v2 ? 10 : 6;
      const signed = v2 && (buffer[2] & 1) !== 0;
      const frameLength = headerLength + payloadLength + 2 + (signed ? 13 : 0);
      if (buffer.length < frameLength) break;
      const id = v2 ? buffer[7] | (buffer[8] << 8) | (buffer[9] << 16) : buffer[5];
      const extra = crcExtra[id];
      let crc = 0xffff;
      for (let i = 1; i < headerLength + payloadLength; i++) crc = crcAccumulate(buffer[i], crc);
      if (extra !== undefined) crc = crcAccumulate(extra, crc);
      const received = buffer[headerLength + payloadLength] | (buffer[headerLength + payloadLength + 1] << 8);
      if (extra === undefined || crc !== received) { this.badCrc++; buffer.splice(0, 1); continue; }
      frames.push({
        id,
        seq: buffer[v2 ? 4 : 2],
        sysId: buffer[v2 ? 5 : 3],
        compId: buffer[v2 ? 6 : 4],
        payload: Uint8Array.from(buffer.slice(headerLength, headerLength + payloadLength)),
      });
      buffer.splice(0, frameLength);
    }
    return frames;
  }
}

/** Builds MAVLink v2 frames with a running sequence number. */
export class MavlinkEncoder {
  private seq = 0;
  readonly sysId: number;
  readonly compId: number;
  constructor(sysId = 255, compId = 190 /* MAV_COMP_ID_MISSIONPLANNER */) { this.sysId = sysId; this.compId = compId; }

  encode(id: number, payload: Uint8Array): Uint8Array {
    const extra = crcExtra[id];
    if (extra === undefined) throw new Error(`No CRC_EXTRA known for message ${id}`);
    let length = payload.length;
    while (length > 1 && payload[length - 1] === 0) length--; // v2 drops trailing zero bytes
    const frame = new Uint8Array(10 + length + 2);
    frame.set([0xfd, length, 0, 0, this.seq, this.sysId, this.compId, id & 0xff, (id >> 8) & 0xff, (id >> 16) & 0xff]);
    frame.set(payload.subarray(0, length), 10);
    this.seq = (this.seq + 1) & 0xff;
    let crc = 0xffff;
    for (let i = 1; i < 10 + length; i++) crc = crcAccumulate(frame[i], crc);
    crc = crcAccumulate(extra, crc);
    frame[10 + length] = crc & 0xff;
    frame[11 + length] = crc >> 8;
    return frame;
  }
}

// v2 payloads arrive with trailing zeros removed, so decode through a zero-padded view.
function view(payload: Uint8Array, minLength: number): DataView {
  const padded = new Uint8Array(Math.max(payload.length, minLength));
  padded.set(payload);
  return new DataView(padded.buffer);
}

export type Heartbeat = { customMode: number; type: number; autopilot: number; baseMode: number; systemStatus: number; armed: boolean };
export function decodeHeartbeat(payload: Uint8Array): Heartbeat {
  const v = view(payload, 9);
  const baseMode = v.getUint8(6);
  return { customMode: v.getUint32(0, true), type: v.getUint8(4), autopilot: v.getUint8(5), baseMode, systemStatus: v.getUint8(7), armed: (baseMode & MAV_MODE_FLAG_SAFETY_ARMED) !== 0 };
}

export function decodeSysStatus(payload: Uint8Array): { voltageMv: number; currentCa: number; batteryRemaining: number } {
  const v = view(payload, 31);
  return { voltageMv: v.getUint16(14, true), currentCa: v.getInt16(16, true), batteryRemaining: v.getInt8(30) };
}

export function decodeGpsRawInt(payload: Uint8Array): { fixType: number; satellites: number; lat: number; lon: number } {
  const v = view(payload, 30);
  return { fixType: v.getUint8(28), satellites: v.getUint8(29), lat: v.getInt32(8, true) / 1e7, lon: v.getInt32(12, true) / 1e7 };
}

/** Fused position from the EKF; hdg is 0..359.99 degrees or null when unknown. */
export function decodeGlobalPositionInt(payload: Uint8Array): { lat: number; lon: number; altM: number; speedMps: number; headingDeg: number | null } {
  const v = view(payload, 28);
  const hdg = v.getUint16(26, true);
  const vx = v.getInt16(20, true), vy = v.getInt16(22, true); // north/east velocity in cm/s
  return { lat: v.getInt32(4, true) / 1e7, lon: v.getInt32(8, true) / 1e7, altM: v.getInt32(12, true) / 1000, speedMps: Math.hypot(vx, vy) / 100, headingDeg: hdg === 65535 ? null : hdg / 100 };
}

/** Vehicle attitude from the EKF, converted from radians to degrees. Yaw is 0..360 (north = 0). */
export function decodeAttitude(payload: Uint8Array): { rollDeg: number; pitchDeg: number; yawDeg: number; yawRateDps: number } {
  const v = view(payload, 28);
  const deg = 180 / Math.PI;
  return { rollDeg: v.getFloat32(4, true) * deg, pitchDeg: v.getFloat32(8, true) * deg, yawDeg: ((v.getFloat32(12, true) * deg) % 360 + 360) % 360, yawRateDps: v.getFloat32(24, true) * deg };
}

export type ParamValue = { name: string; value: number; type: number; count: number; index: number };
/** One parameter from the Pixhawk (parameter protocol). ArduPilot sends integer types by value in the float. */
export function decodeParamValue(payload: Uint8Array): ParamValue {
  const v = view(payload, 25);
  const bytes = new Uint8Array(v.buffer, 8, 16);
  const end = bytes.indexOf(0);
  return { value: v.getFloat32(0, true), count: v.getUint16(4, true), index: v.getUint16(6, true), name: new TextDecoder().decode(end < 0 ? bytes : bytes.subarray(0, end)), type: v.getUint8(24) };
}

export function decodeStatusText(payload: Uint8Array): { severity: number; text: string } {
  const v = view(payload, 51);
  const bytes = new Uint8Array(v.buffer, 1, 50);
  const end = bytes.indexOf(0);
  return { severity: v.getUint8(0), text: new TextDecoder().decode(end < 0 ? bytes : bytes.subarray(0, end)) };
}

export function decodeCommandAck(payload: Uint8Array): { command: number; result: number } {
  const v = view(payload, 3);
  return { command: v.getUint16(0, true), result: v.getUint8(2) };
}

export const build = {
  /** Ground-station heartbeat: MAV_TYPE_GCS, MAV_AUTOPILOT_INVALID, MAV_STATE_ACTIVE. */
  gcsHeartbeat(): Uint8Array {
    return Uint8Array.from([0, 0, 0, 0, 6, 8, 0, 4, 3]);
  },

  /** Ask for every parameter; the Pixhawk answers with a stream of PARAM_VALUE. */
  paramRequestList(targetSys: number, targetComp: number): Uint8Array {
    return Uint8Array.from([targetSys, targetComp]);
  },
  /** Ask for one parameter by index (used to fill gaps after the list). */
  paramRequestRead(targetSys: number, targetComp: number, index: number): Uint8Array {
    const out = new Uint8Array(20);
    new DataView(out.buffer).setInt16(0, index, true);
    out[2] = targetSys; out[3] = targetComp;
    return out;
  },
  /** Write one parameter. ArduPilot answers with PARAM_VALUE carrying the stored value. */
  paramSet(targetSys: number, targetComp: number, name: string, value: number, type: number): Uint8Array {
    const out = new Uint8Array(23);
    new DataView(out.buffer).setFloat32(0, value, true);
    out[4] = targetSys; out[5] = targetComp;
    out.set(new TextEncoder().encode(name).subarray(0, 16), 6);
    out[22] = type;
    return out;
  },
  commandLong(targetSys: number, targetComp: number, command: number, params: number[] = []): Uint8Array {
    const payload = new Uint8Array(33);
    const v = new DataView(payload.buffer);
    for (let i = 0; i < 7; i++) v.setFloat32(i * 4, params[i] ?? 0, true);
    v.setUint16(28, command, true);
    payload[30] = targetSys; payload[31] = targetComp; payload[32] = 0;
    return payload;
  },

  /** channels: PWM values for RC1..RC8. Use RC_CHANNEL_IGNORE to leave a channel alone. */
  rcChannelsOverride(targetSys: number, targetComp: number, channels: number[]): Uint8Array {
    const payload = new Uint8Array(18);
    const v = new DataView(payload.buffer);
    for (let i = 0; i < 8; i++) v.setUint16(i * 2, channels[i] ?? RC_CHANNEL_IGNORE, true);
    payload[16] = targetSys; payload[17] = targetComp;
    return payload;
  },
};
