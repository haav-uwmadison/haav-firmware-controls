# mission_daemon

The laptop side of the boat. One small C++ program owns the Xbox controller and the Pixhawk serial
link, runs the 20 Hz control loop, and serves the dashboard at <https://mission.haav.build> over a
loopback WebSocket. The browser only visualises and sends commands. The core (`src/core/`) has no OS
dependencies and uses the same MAVLink library as the ESP32 firmware in `../haav-model`, so it can move
onto a microcontroller later.

```
Xbox controller ──Bluetooth──> mission_daemon ──USB radio──> Pixhawk
                                     │ ws://127.0.0.1:8765
                               mission.haav.build (Chrome/Edge/Firefox/Safari)
```

## Quick start for teammates

1. Pair the Xbox controller with your laptop over Bluetooth (hold the pair button until the logo flashes).
2. Plug in the ground telemetry radio. Nothing else to install for it on macOS or Windows 10+.
3. Build and run the daemon (first build takes a few minutes while it fetches dependencies):

   **macOS / Linux**
   ```sh
   ./daemon/run.sh
   ```
   Needs CMake and a C++ compiler: `xcode-select --install && brew install cmake ninja sdl2` on a Mac,
   `sudo apt install cmake ninja-build g++ libsdl2-dev` on Debian/Ubuntu.

   **Windows**
   ```powershell
   .\daemon\run.ps1
   ```
   Needs [CMake](https://cmake.org/download/) and the "Desktop development with C++" workload from
   [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/). SDL2 is
   fetched and built automatically.

4. Open <https://mission.haav.build>. The page finds the daemon on localhost by itself and the Backend
   readout in the status bar turns green. Click Link to open the radio, press a controller button,
   click Output to start sending, A to arm, B to disarm, Esc to stop and disarm.

Without a boat, try `./daemon/run.sh --sim` (or `.\daemon\run.ps1 --sim`): a simulated boat that
answers arming, moves on the map when you push the sticks, and drains its battery.

## Options

```
--port <path|COMx|auto>   serial port (default auto: first USB serial adapter, radios before the Pixhawk's own USB)
--baud <n>                serial baud (default 57600, the telemetry radio rate)
--ws <n>                  WebSocket port on 127.0.0.1 (default 8765)
--sim                     simulated boat, no serial port
--no-autoconnect          wait for the dashboard to click Link instead of opening the port at start
--list-ports              list serial candidates and exit
```

## Layout

| Path | Role |
|---|---|
| `src/core/boat_control.*` | Controller → command → PWM: deadzone, reversal dwell, motor power limit, channel map (portable) |
| `src/core/mission.*` | Link phases, telemetry decoding, 20 Hz loop, arming with ACK tracking, watchdogs, GPS trail (portable) |
| `src/platform/serial.*` | Non-blocking serial for macOS, Linux and Windows, plus port enumeration |
| `src/platform/gamepad_sdl.cpp` | Xbox controller via SDL2 GameController (Bluetooth and USB) |
| `src/platform/ws_server.*` | Loopback WebSocket server (IXWebSocket), origin-checked |
| `src/platform/sim_vehicle.*` | The `--sim` boat |
| `src/main.cpp` | CLI, main loop, JSON state for the dashboard |

The state JSON uses the same field names as `web-control/lib/mission-controller.ts`; the dashboard
client is `web-control/lib/daemon-client.ts`.

## Safety behaviour

Same as the in-browser controller and the ESP32 firmware: losing the controller sends neutral and a
disarm; stopping output sends one neutral frame and the Pixhawk's RC failsafe takes over after
`RC_OVERRIDE_TIME` (1 s); Esc in the dashboard stops output and disarms; the daemon only listens on
127.0.0.1 and only accepts browser connections from mission.haav.build or localhost.
