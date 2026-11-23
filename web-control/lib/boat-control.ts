// Controller -> boat command mapping. Mirrors the ESP32 firmware (haav-model/src/main.cpp) so the
// Pixhawk parameters in haav-model/pixhawk/haav-esp32.params work unchanged:
//   RC1 = left stick vertical  -> left motor  (OUT 1)
//   RC3 = right stick vertical -> right motor (OUT 2)
//   RC6 = right trigger minus left trigger -> rudder (OUT 3)

import type { ControllerState } from "./gamepad";
import { RC_CHANNEL_IGNORE } from "./mavlink";

export const DEADZONE = 0.1;
export const REVERSE_PAUSE_MS = 500;
export const PWM_NEUTRAL = 1500;
export const PWM_SPAN = 500;

export type BoatCommand = { left: number; right: number; rudder: number }; // each -1..1
export type BoatPwm = { left: number; right: number; rudder: number };     // microseconds

export const neutralCommand: BoatCommand = { left: 0, right: 0, rudder: 0 };

/** Per-motor direction flip, for when a thruster is wired or mounted the other way round. */
export type MotorReverse = { left: boolean; right: boolean };
export const noMotorReverse: MotorReverse = { left: false, right: false };

/** Flips the sign of each reversed motor so stick forward still sends that motor's PWM below neutral. */
export function applyMotorReverse(c: BoatCommand, reverse: MotorReverse): BoatCommand {
  return { left: reverse.left ? -c.left : c.left, right: reverse.right ? -c.right : c.right, rudder: c.rudder };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Ignores small stick offsets and rescales so output ramps from 0 at the deadzone edge. */
export function applyDeadzone(value: number): number {
  if (Math.abs(value) < DEADZONE) return 0;
  return (value - Math.sign(value) * DEADZONE) / (1 - DEADZONE);
}

/** Stick forward (+1 from useGamepad) drives its motor forward. */
export function controllerToCommand(c: ControllerState): BoatCommand {
  if (!c.connected) return neutralCommand;
  return { left: applyDeadzone(c.ly), right: applyDeadzone(c.ry), rudder: clamp(c.rt - c.lt, -1, 1) };
}

/** The ESCs only change direction after sitting at neutral, so hold 0 for REVERSE_PAUSE_MS on a reversal. */
export class ReversePause {
  private lastDirection = 0;
  private neutralSince = 0;

  apply(command: number, now: number): number {
    const direction = Math.sign(command);
    const reversing = direction !== 0 && this.lastDirection !== 0 && direction !== this.lastDirection;
    if (direction === 0 || reversing) {
      if (this.neutralSince === 0) this.neutralSince = now;
      if (direction === 0 || now - this.neutralSince < REVERSE_PAUSE_MS) return 0;
    }
    this.neutralSince = 0;
    this.lastDirection = direction;
    return command;
  }
}

export function toPwm(value: number, span: number = PWM_SPAN): number {
  return Math.round(PWM_NEUTRAL + clamp(value, -1, 1) * span);
}

/** Default motor limit: ±250 µs (1250..1750), the same travel as SERVO1/2_MIN/MAX in haav-esp32.params. */
export const DEFAULT_MOTOR_SPAN = 250;
export const MIN_MOTOR_SPAN = 0;
export const MAX_MOTOR_SPAN = PWM_SPAN;

/**
 * Motors get a configurable PWM span so full stick maps to 1500 ± motorSpan µs; the rudder always
 * uses the full range. Scaling (rather than clipping) keeps the whole stick travel usable.
 */
export function commandToPwm(c: BoatCommand, motorSpan: number = PWM_SPAN): BoatPwm {
  const span = clamp(motorSpan, MIN_MOTOR_SPAN, MAX_MOTOR_SPAN);
  return { left: toPwm(c.left, span), right: toPwm(c.right, span), rudder: toPwm(c.rudder) };
}

/** RC1..RC8 for RC_CHANNELS_OVERRIDE; channels we do not drive are left alone. */
export function pwmToChannels(p: BoatPwm): number[] {
  const skip = RC_CHANNEL_IGNORE;
  return [p.left, skip, p.right, skip, skip, p.rudder, skip, skip];
}

/** Hold only the rudder at center while disarmed; leave all other RC inputs alone. */
export function rudderNeutralChannels(): number[] {
  const skip = RC_CHANNEL_IGNORE;
  return [skip, skip, skip, skip, skip, PWM_NEUTRAL, skip, skip];
}
