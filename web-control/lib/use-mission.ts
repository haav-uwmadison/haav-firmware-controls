"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { GamepadSource } from "./gamepad";
import { initialMissionState, MissionController, type MissionState } from "./mission-controller";

/**
 * The only bridge between the control logic and React. Creates one MissionController for the page,
 * starts it in the browser, and re-renders on every state snapshot.
 */
export function useMission(): { mission: MissionController; state: MissionState } {
  const [mission] = useState(() => new MissionController({ input: new GamepadSource() }));
  useEffect(() => { mission.start(); return () => mission.dispose(); }, [mission]);
  const state = useSyncExternalStore(mission.subscribe, mission.getState, () => initialMissionState);
  return { mission, state };
}
