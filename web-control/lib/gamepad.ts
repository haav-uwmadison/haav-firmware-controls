"use client";

import { useEffect, useRef, useState } from "react";

// Xbox controller through the browser Gamepad API ("standard" mapping):
// axes 0/1 = left stick X/Y, axes 2/3 = right stick X/Y, buttons 6/7 = LT/RT (analog 0..1),
// buttons 0/1 = A/B. The raw API reads stick up as -1; this module flips Y so up/forward = +1.
// Chrome only lists a gamepad after a button press.

export type ControllerState = {
  connected: boolean;
  id: string;
  /** sticks -1..1; ly/ry are +1 when pushed forward (away from you) */
  lx: number; ly: number; rx: number; ry: number;
  lt: number; rt: number;
  a: boolean; b: boolean;
  /** performance.now() of the sample */
  time: number;
};

export const noController: ControllerState = { connected: false, id: "", lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0, a: false, b: false, time: 0 };

export function readGamepad(pad: Gamepad, time: number): ControllerState {
  const axis = (i: number) => pad.axes[i] ?? 0;
  const button = (i: number) => pad.buttons[i]?.value ?? 0;
  return {
    connected: true, id: pad.id, time,
    lx: axis(0), ly: -axis(1), rx: axis(2), ry: -axis(3),
    lt: button(6), rt: button(7),
    a: (pad.buttons[0]?.pressed) ?? false, b: (pad.buttons[1]?.pressed) ?? false,
  };
}

/**
 * Framework-free controller input: samples the first connected gamepad every animation frame and
 * pushes each sample to subscribers. The loop runs only while someone is subscribed, so constructing
 * one during server rendering is safe. This is what the mission controller consumes.
 */
export class GamepadSource {
  private current: ControllerState = noController;
  private listeners = new Set<(c: ControllerState) => void>();
  private frame = 0;

  latest(): ControllerState { return this.current; }

  subscribe(listener: (c: ControllerState) => void): () => void {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.loop();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) { cancelAnimationFrame(this.frame); this.frame = 0; }
    };
  }

  private loop = () => {
    const pad = navigator.getGamepads?.().find(p => p && p.connected) ?? null;
    this.current = pad ? readGamepad(pad, performance.now()) : { ...noController, time: performance.now() };
    for (const listener of this.listeners) listener(this.current);
    this.frame = requestAnimationFrame(this.loop);
  };
}

/** React hook form of the same sampling, used by the /direct page. `latest` is a ref for code that must not wait on renders. */
export function useGamepad(): { state: ControllerState; latest: React.RefObject<ControllerState> } {
  const [state, setState] = useState<ControllerState>(noController);
  const latest = useRef<ControllerState>(noController);

  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const pad = navigator.getGamepads?.().find(p => p && p.connected) ?? null;
      const next = pad ? readGamepad(pad, performance.now()) : { ...noController, time: performance.now() };
      latest.current = next;
      setState(next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  return { state, latest };
}
