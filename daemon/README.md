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

## Run the daemon

The daemon runs in a Terminal window on the laptop. Keep that window open while using the dashboard.
It owns the Xbox controller and the Pixhawk serial port. Do **not** run MAVProxy or the Python agent at
the same time if either one is using that serial port. You do not need to activate a Python virtual
environment; this is the separate C++ daemon.

From the repository root on macOS/Linux, use the root Makefile:

```sh
make run        # build and run the daemon; use the hosted dashboard at mission.haav.build
make sim        # build and run the simulated boat, without a serial port
make build-daemon
make list-ports
make help
```

Pass daemon options through `DAEMON_ARGS`, for example `make run DAEMON_ARGS="--port /dev/cu.usbserial-1234 --baud 115200"`.
You do not need `make web` when using the hosted dashboard. For local frontend development only, run
`make web` in another terminal; it starts Next.js at <http://localhost:3000>.

### macOS

1. Open Terminal and change to the repository folder (the folder containing `daemon/`):

   ```sh
   cd /path/to/haav-firmware-controls
   ```

2. Install the build tools once, if needed:

   ```sh
   xcode-select --install
   brew install cmake ninja sdl2
   ```

3. Pair/connect the Xbox controller and plug in the ground telemetry radio. For a real boat, make sure
   the Pixhawk is powered and the radio is attached to the laptop.
4. Start the daemon:

   ```sh
   ./daemon/run.sh
   ```

   On its first run, the script configures and builds the C++ program and downloads its dependencies;
   this can take a few minutes. Later runs reuse the build. Leave this Terminal window open.
5. In Chrome, open <https://mission.haav.build>. The dashboard should detect the local daemon and show
   the Backend readout as connected. Use the dashboard's Link control to connect the radio, then verify
   the controller and telemetry before enabling Output. Press **A** to arm, **B** to disarm, and **Esc**
   to stop output and disarm.
6. To stop the daemon, return to its Terminal window and press **Control-C**.

### Windows

1. Open PowerShell in the repository folder (the folder containing `daemon/`).
2. Install [CMake](https://cmake.org/download/) and the **Desktop development with C++** workload from
   [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/). SDL2 and
   other project dependencies are fetched and built automatically.
3. Pair/connect the Xbox controller and plug in the ground telemetry radio.
4. Start the daemon:

   ```powershell
   .\daemon\run.ps1
   ```

   The first run builds the program and can take a few minutes. Keep PowerShell open while using the
   dashboard. Open <https://mission.haav.build> in Chrome. Confirm the Backend readout shows connected,
   use Link to connect the radio, and verify telemetry and controller input before enabling Output.
   Press **A** to arm, **B** to disarm, and **Esc** to stop output and disarm.
5. To stop the daemon, return to PowerShell and press **Ctrl-C**.

### Try it without the boat

From the repository folder, run the simulator instead of opening a real serial port:

```sh
# macOS / Linux
./daemon/run.sh --sim
```

```powershell
# Windows
.\daemon\run.ps1 --sim
```

Then open <https://mission.haav.build>. The simulated vehicle responds to arming, moves on the map
when you move the sticks, and drains its simulated battery. Stop it with Control-C / Ctrl-C.

### If the daemon says port 8765 is already in use

Only one daemon can use `127.0.0.1:8765` at a time. Usually another `mission_daemon` is already running:
find its Terminal window and stop it with Control-C, then start the daemon once. On macOS, identify the
listener with:

```sh
lsof -nP -iTCP:8765 -sTCP:LISTEN
```

If the old Terminal is gone, stop that specific daemon process with `kill <PID>` (replace `<PID>` with
the number shown by `lsof`), then run the start command again. Do not kill a process unless its name is
`mission_daemon`. If another program owns the port, either close that program or choose another port
with `--ws <port>`; the dashboard must use the same port.

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
