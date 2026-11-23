"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { DaemonClient, probeDaemon } from "./daemon-client";
import { GamepadSource } from "./gamepad";
import type { Backend, MissionApi } from "./mission-api";
import { initialMissionState, MissionController, type MissionState } from "./mission-controller";

const REPROBE_MS = 5000;

/**
 * The only bridge between the boat logic and React. On load it looks for mission_daemon on
 * localhost; if found, the page becomes a thin client of it, otherwise the in-browser controller
 * (Web Serial + Gamepad API) takes over. While the browser backend sits disconnected it keeps
 * probing, so starting the daemon later switches the page over without a reload.
 */
export function useMission(): { mission: MissionApi; state: MissionState; backend: Backend; daemonVersion: string } {
  const [backend, setBackend] = useState<Backend>("probing");
  const [api, setApi] = useState<MissionApi | null>(null);
  const apiRef = useRef<MissionApi | null>(null);
  const [daemonVersion, setDaemonVersion] = useState("");

  useEffect(() => {
    let cancelled = false;
    let timer = 0;

    const attachBrowser = () => {
      const controller = new MissionController({ input: new GamepadSource() });
      controller.start();
      apiRef.current = controller; setApi(controller); setBackend("browser"); setDaemonVersion("");
      // keep looking for the daemon while nothing is connected in the browser
      const reprobe = async () => {
        if (cancelled) return;
        const canSwitch = () => !cancelled && !controller.getState().connected && !controller.getState().connecting;
        if (canSwitch() && await probeDaemon(800) && canSwitch()) { controller.dispose(); attachDaemon(); return; }
        if (!cancelled) timer = window.setTimeout(reprobe, REPROBE_MS);
      };
      timer = window.setTimeout(reprobe, REPROBE_MS);
    };

    const attachDaemon = () => {
      const client: DaemonClient = new DaemonClient(undefined, () => { if (!cancelled) { client.dispose(); attachBrowser(); } });
      client.start();
      apiRef.current = client; setApi(client); setBackend("daemon");
      const unsub = client.subscribe(() => { if (client.version && client.version !== daemonVersion) setDaemonVersion(client.version); unsub(); });
    };

    void probeDaemon().then(found => { if (cancelled) return; if (found) attachDaemon(); else attachBrowser(); });

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      apiRef.current?.dispose(); apiRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const subscribe = api ? api.subscribe : noopSubscribe;
  const getState = api ? api.getState : getInitial;
  const state = useSyncExternalStore(subscribe, getState, getInitial);
  return { mission: api ?? idle, state, backend, daemonVersion };
}

const getInitial = () => initialMissionState;
const noopSubscribe = () => () => undefined;

/** Placeholder while probing so the page can render before a backend is chosen. */
const idle: MissionApi = {
  getState: getInitial, subscribe: noopSubscribe, start() {}, dispose() {},
  setBaud() {}, setMotorSpan() {}, setMotorReverse() {}, clearTrail() {}, refreshParams() {}, setParam() {}, sendCommand() {}, connect() {}, disconnect() {}, startOutput() {}, stopOutput() {}, arm() {}, disarm() {}, panic() {}, handleShortcut() {},
};
