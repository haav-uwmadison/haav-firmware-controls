// What the dashboard needs from whichever backend drives the boat: the in-browser MissionController
// (Web Serial + Gamepad API) or the DaemonClient talking to mission_daemon over a loopback WebSocket.
// Both expose the same immutable state snapshot and the same commands, so the page does not care.

import type { MissionState } from "./mission-controller";

export type Backend = "probing" | "daemon" | "browser";

export interface MissionApi {
  getState(): MissionState;
  subscribe(listener: () => void): () => void;
  start(): void;
  dispose(): void;
  setBaud(baud: string): void;
  setMotorSpan(span: number): void;
  clearTrail(): void;
  /** Re-read the Pixhawk's parameter table. */
  refreshParams(): Promise<void> | void;
  connect(): Promise<void> | void;
  disconnect(): Promise<void> | void;
  startOutput(): void;
  stopOutput(reason: string): Promise<void> | void;
  arm(): Promise<void> | void;
  disarm(): Promise<void> | void;
  panic(): void;
  /** Keyboard shortcut from the page: escape, a, b, l or o. */
  handleShortcut(key: string): void;
}
