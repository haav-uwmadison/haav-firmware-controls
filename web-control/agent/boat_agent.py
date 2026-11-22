#!/usr/bin/env python3
"""Laptop-side Xbox/MAVLink bridge for HAAV Mission Control.

The process owns the gamepad and Pixhawk serial port. The web page is only a
UI client; its background-tab timer throttling cannot interrupt this loop.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import secrets
import signal
import sys
import time
from pathlib import Path

import pygame
from pymavlink import mavutil
import serial.tools.list_ports
import websockets

GCS_SYSID = 255
GCS_COMPID = 190
TARGET_SYSID = 1
TARGET_COMPID = 1
TICK_SECONDS = 0.05
OVERRIDE_TTL_SECONDS = 1.0
DEADZONE = 0.10
REVERSE_PAUSE_SECONDS = 0.5
MODE_NAMES = {0: "MANUAL", 1: "ACRO", 2: "STEERING", 3: "HOLD", 4: "LOITER", 6: "GUIDED", 10: "AUTO", 11: "RTL"}
ALLOWED_ORIGINS = {"https://mission.haav.build", "http://localhost:3000", "http://127.0.0.1:3000"}


def list_ports() -> None:
    for port in serial.tools.list_ports.comports():
        print(f"{port.device}\t{port.description}")


def deadzone(value: float) -> float:
    if abs(value) < DEADZONE:
        return 0.0
    return (value - (1 if value > 0 else -1) * DEADZONE) / (1 - DEADZONE)


class ReversePause:
    def __init__(self) -> None:
        self.direction = 0
        self.neutral_since: float | None = None

    def apply(self, command: float, now: float) -> float:
        direction = (command > 0) - (command < 0)
        reversing = direction != 0 and self.direction != 0 and direction != self.direction
        if direction == 0 or reversing:
            if self.neutral_since is None:
                self.neutral_since = now
            if direction == 0 or now - self.neutral_since < REVERSE_PAUSE_SECONDS:
                return 0.0
        self.neutral_since = None
        self.direction = direction
        return command


class BoatAgent:
    def __init__(self, port: str, baud: int, password: str) -> None:
        self.port = port
        self.baud = baud
        self.password = password
        self.vehicle = None
        self.clients: set[websockets.ServerConnection] = set()
        self.controller: pygame.joystick.Joystick | None = None
        self.running = False
        self.armed = False
        self.mode = "—"
        self.vehicle_name = "—"
        self.gps = "—"
        self.battery = "—"
        self.last_message = "—"
        self.frames = 0
        self.overrides_sent = 0
        self.sending = False
        self.errors: list[str] = []
        self._reverse_left = ReversePause()
        self._reverse_right = ReversePause()
        self._last_heartbeat = 0.0
        self._last_browser = time.monotonic()

    def connect_vehicle(self) -> None:
        print(f"Opening {self.port} at {self.baud} baud…")
        self.vehicle = mavutil.mavlink_connection(
            self.port,
            baud=self.baud,
            source_system=GCS_SYSID,
            source_component=GCS_COMPID,
            autoreconnect=True,
        )
        print("Waiting for Pixhawk heartbeat…")
        hb = self.vehicle.wait_heartbeat(timeout=30)
        if hb is None:
            raise TimeoutError("No Pixhawk heartbeat within 30 seconds; check UART, baud rate, and TX/RX wiring")
        print(f"Heartbeat from system {self.vehicle.target_system}, component {self.vehicle.target_component}")

    def find_controller(self) -> None:
        pygame.init()
        pygame.joystick.init()
        for index in range(pygame.joystick.get_count()):
            pad = pygame.joystick.Joystick(index)
            pad.init()
            self.controller = pad
            print(f"Xbox/gamepad: {pad.get_name()} (axes={pad.get_numaxes()}, buttons={pad.get_numbuttons()})")
            return
        print("No controller found yet. Connect/pair it, then press a button.")

    def poll_controller(self) -> None:
        for event in pygame.event.get():
            if event.type == pygame.JOYDEVICEREMOVED and self.controller is not None:
                if event.instance_id == self.controller.get_instance_id():
                    self.controller = None
                    if self.sending:
                        self.stop("Xbox controller disconnected", disarm=True)
            elif event.type == pygame.JOYDEVICEADDED and self.controller is None:
                self.find_controller()
        if self.controller is None or not self.controller.get_init():
            if self.controller is not None:
                self.controller = None
                if self.sending:
                    self.stop("Xbox controller disconnected", disarm=True)
            if pygame.joystick.get_count():
                self.find_controller()

    def axes(self) -> tuple[float, float, float, float, bool, bool]:
        pad = self.controller
        if pad is None or not pad.get_init():
            return (0.0, 0.0, 0.0, 0.0, False, False)
        # SDL standard game-controller mapping: left Y=1, right Y=3;
        # trigger axes=4/5. On some Bluetooth mappings triggers share axis 2.
        left = -pad.get_axis(1) if pad.get_numaxes() > 1 else 0.0
        right = -pad.get_axis(3) if pad.get_numaxes() > 3 else 0.0
        if pad.get_numaxes() > 5:
            lt = (pad.get_axis(4) + 1.0) / 2.0
            rt = (pad.get_axis(5) + 1.0) / 2.0
        elif pad.get_numaxes() > 2:
            combined = pad.get_axis(2)
            lt, rt = max(0.0, combined), max(0.0, -combined)
        else:
            lt = rt = 0.0
        a = bool(pad.get_numbuttons() > 0 and pad.get_button(0))
        b = bool(pad.get_numbuttons() > 1 and pad.get_button(1))
        return deadzone(left), deadzone(right), max(0.0, min(1.0, lt)), max(0.0, min(1.0, rt)), a, b

    def _send_override(self, left: int = 1500, right: int = 1500, rudder: int = 1500) -> None:
        if self.vehicle is None:
            return
        ignore = 65535
        self.vehicle.mav.rc_channels_override_send(
            TARGET_SYSID, TARGET_COMPID,
            left, ignore, right, ignore, ignore, rudder, ignore, ignore,
        )
        self.overrides_sent += 1

    def _send_rudder_neutral(self) -> None:
        """Hold RC6 at trim while disarmed; RCIN6Scaled otherwise follows the receiver."""
        if self.vehicle is None:
            return
        ignore = 65535
        self.vehicle.mav.rc_channels_override_send(
            TARGET_SYSID, TARGET_COMPID,
            ignore, ignore, ignore, ignore, ignore, 1500, ignore, ignore,
        )
        self.overrides_sent += 1

    def _command(self, command: int, params: list[float]) -> None:
        if self.vehicle is None:
            raise RuntimeError("Pixhawk serial link is not connected")
        values = (params + [0.0] * 7)[:7]
        self.vehicle.mav.command_long_send(TARGET_SYSID, TARGET_COMPID, command, 0, *values)

    def arm_manual(self) -> None:
        self._command(mavutil.mavlink.MAV_CMD_DO_SET_MODE, [1, 0])
        self._command(mavutil.mavlink.MAV_CMD_COMPONENT_ARM_DISARM, [1])

    def disarm(self) -> None:
        self.sending = False
        self._send_override()
        self._command(mavutil.mavlink.MAV_CMD_COMPONENT_ARM_DISARM, [0])

    def stop(self, reason: str, disarm: bool = True) -> None:
        if not self.sending and not disarm:
            return
        self.sending = False
        self._send_override()
        if disarm:
            try:
                self._command(mavutil.mavlink.MAV_CMD_COMPONENT_ARM_DISARM, [0])
            except Exception as exc:
                self.errors.append(f"Stop/disarm failed: {exc}")
        print(f"Control stopped: {reason}")

    def telemetry(self) -> dict:
        left, right, lt, rt, a, b = self.axes()
        return {
            "type": "state", "connected": self.vehicle is not None,
            "sending": self.sending, "armed": self.armed, "mode": self.mode,
            "rudderHold": bool(self.vehicle and not self.sending and not self.armed and self._last_heartbeat and time.monotonic() - self._last_heartbeat <= 3),
            "vehicle": self.vehicle_name, "gps": self.gps, "battery": self.battery,
            "lastMessage": self.last_message, "frames": self.frames,
            "overridesSent": self.overrides_sent, "controller": self.controller.get_name() if self.controller else None,
            "axes": {"left": left, "right": right, "lt": lt, "rt": rt, "a": a, "b": b},
            "pwm": {"left": round(1500 + left * 500), "right": round(1500 + right * 500), "rudder": round(1500 + (rt - lt) * 500)},
            "errors": self.errors[-5:],
        }

    def drain_telemetry(self) -> None:
        if self.vehicle is None:
            return
        while True:
            msg = self.vehicle.recv_match(blocking=False)
            if msg is None:
                break
            self.frames += 1
            name = msg.get_type()
            self.last_message = name
            if name == "HEARTBEAT" and msg.get_srcSystem() == TARGET_SYSID:
                self._last_heartbeat = time.monotonic()
                self.armed = bool(msg.base_mode & mavutil.mavlink.MAV_MODE_FLAG_SAFETY_ARMED)
                self.vehicle_name = mavutil.mavlink.enums["MAV_TYPE"].get(msg.type, "—").name
                self.mode = MODE_NAMES.get(msg.custom_mode, f"Custom {msg.custom_mode}")
            elif name == "GPS_RAW_INT":
                fix = "3D fix" if msg.fix_type >= 3 else "No 3D fix"
                self.gps = f"{fix} · {msg.satellites_visible} sats"
            elif name == "SYS_STATUS" and msg.voltage_battery != 65535:
                self.battery = f"{msg.voltage_battery / 1000:.2f} V · {msg.battery_remaining}%"

    async def broadcast(self) -> None:
        if not self.clients:
            return
        message = json.dumps(self.telemetry())
        await asyncio.gather(*(client.send(message) for client in tuple(self.clients)), return_exceptions=True)

    async def websocket_handler(self, socket: websockets.ServerConnection) -> None:
        origin = socket.request.headers.get("Origin", "")
        if origin not in ALLOWED_ORIGINS:
            await socket.close(code=1008, reason="Origin not allowed")
            return
        if self.clients:
            await socket.close(code=1013, reason="Mission Control is already connected")
            return
        try:
            auth = json.loads(await asyncio.wait_for(socket.recv(), timeout=10))
        except Exception:
            await socket.close(code=1008, reason="Local bridge authentication required")
            return
        if auth.get("token") != self.password:
            await socket.close(code=1008, reason="Bad local token")
            return
        self.clients.add(socket)
        self._last_browser = time.monotonic()
        print(f"Mission Control connected from {origin}")
        await socket.send(json.dumps({**self.telemetry(), "type": "hello"}))
        try:
            async for raw in socket:
                self._last_browser = time.monotonic()
                try:
                    request = json.loads(raw)
                    action = request.get("action")
                    if action == "start":
                        if self.controller is None:
                            raise RuntimeError("Connect an Xbox controller before starting output")
                        self.sending = True
                        self._reverse_left, self._reverse_right = ReversePause(), ReversePause()
                    elif action == "stop":
                        self.stop("stopped from Mission Control")
                    elif action == "arm":
                        self.arm_manual()
                    elif action == "disarm":
                        self.stop("disarm requested", disarm=False)
                        self.disarm()
                    elif action == "ping":
                        pass
                    else:
                        raise ValueError(f"Unknown action: {action}")
                    await socket.send(json.dumps({"type": "ack", "action": action, **self.telemetry()}))
                except Exception as exc:
                    await socket.send(json.dumps({"type": "error", "message": str(exc)}))
        finally:
            self.clients.discard(socket)
            if self.sending:
                self.stop("Mission Control disconnected")
            print("Mission Control disconnected")

    async def run(self) -> None:
        self.connect_vehicle()
        self.find_controller()
        self.running = True
        async with websockets.serve(self.websocket_handler, "127.0.0.1", 8765, origins=ALLOWED_ORIGINS, max_size=4096):
            print("Mission Control bridge listening on ws://127.0.0.1:8765")
            print("Paste the one-time token shown here into Mission Control → Connect local agent.")
            last_ui = 0.0
            previous_a = previous_b = False
            while self.running:
                self.poll_controller()
                self.drain_telemetry()
                now = time.monotonic()
                if self.vehicle and now - last_ui >= 1:
                    self.vehicle.mav.heartbeat_send(mavutil.mavlink.MAV_TYPE_GCS, mavutil.mavlink.MAV_AUTOPILOT_INVALID, 0, 0, mavutil.mavlink.MAV_STATE_ACTIVE)
                    last_ui = now
                if self.sending:
                    if not self._last_heartbeat or now - self._last_heartbeat > 3:
                        self.stop("Pixhawk heartbeat lost", disarm=True)
                        await self.broadcast()
                        await asyncio.sleep(TICK_SECONDS)
                        continue
                    left, right, lt, rt, a, b = self.axes()
                    left = self._reverse_left.apply(left, now)
                    right = self._reverse_right.apply(right, now)
                    self._send_override(round(1500 + left * 500), round(1500 + right * 500), round(1500 + (rt - lt) * 500))
                    if a and not previous_a:
                        self.arm_manual()
                    if b and not previous_b:
                        self.stop("B pressed", disarm=True)
                    previous_a, previous_b = self.axes()[4:]
                elif self.vehicle and not self.armed and self._last_heartbeat and now - self._last_heartbeat <= 3:
                    # A single neutral frame expires after RC_OVERRIDE_TIME. Keep RC6
                    # centered while disarmed so RCIN6Scaled cannot follow a live trigger.
                    self._send_rudder_neutral()
                await self.broadcast()
                await asyncio.sleep(TICK_SECONDS)


def main() -> None:
    parser = argparse.ArgumentParser(description="HAAV Mission Control local MAVLink/gamepad bridge")
    parser.add_argument("--list-ports", action="store_true", help="list serial ports and exit")
    parser.add_argument("--port", help="Pixhawk UART serial device, e.g. /dev/cu.usbserial-D30H6SNY")
    parser.add_argument("--baud", type=int, default=57600)
    args = parser.parse_args()
    if args.list_ports:
        list_ports()
        return
    if not args.port:
        parser.error("--port is required (or use --list-ports)")
    token = secrets.token_urlsafe(24)
    print("\nLocal bridge token (paste into Mission Control; keep private):")
    print(token)
    agent = BoatAgent(args.port, args.baud, token)
    try:
        asyncio.run(agent.run())
    except KeyboardInterrupt:
        agent.stop("terminal interrupted")
        print("\nBridge stopped.")
    except Exception as exc:
        print(f"Bridge failed: {exc}", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
