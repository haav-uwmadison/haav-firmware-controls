# HAAV Mission Control

Production UI: <https://mission.haav.build>

Mission Control is a Next.js static website. The current main page (`/`) is the direct Web Serial controller. The background-agent interface is at `/agent`; it connects to a laptop helper that owns the Xbox controller and Pixhawk serial connection so Chrome background-tab throttling cannot interrupt the MAVLink control loop. Use only one page/process to control the Pixhawk at a time; the agent needs exclusive ownership of its serial port.

```text
Xbox --Bluetooth--> laptop agent --MAVLink/USB UART--> Pixhawk 6C / ArduPilot --> thrusters + rudder
                               ^
                               | loopback WebSocket
                               v
                mission.haav.build/agent (UI + telemetry)
```

## Start the laptop agent

See [agent/README.md](agent/README.md) for venv setup. With the Xbox paired and Pixhawk adapter plugged in:

```sh
source .venv-mavproxy314/bin/activate
python web-control/agent/boat_agent.py --list-ports
python web-control/agent/boat_agent.py --port /dev/cu.usbserial-D30H6SNY --baud 57600
```

The agent waits for the Pixhawk heartbeat, detects the controller, prints a fresh token, and listens on `127.0.0.1:8765`. Keep the terminal open. At <https://mission.haav.build/agent>, paste the token and choose **Connect agent**. Start control from the page; you can then switch tabs while the laptop process keeps running.

If the Pixhawk heartbeat does not arrive, verify the serial adapter is on a MAVLink UART, TX/RX are crossed, ground is shared, and the baud matches that UART. Project TELEM1/TELEM2 settings use 57600 baud.

## Control and safety behavior

| Input | MAVLink output |
| --- | --- |
| Left stick vertical | RC1 / left thruster |
| Right stick vertical | RC3 / right thruster |
| RT minus LT | RC6 / rudder |
| Controller A | Set MANUAL mode and arm |
| Controller B | Disarm |

The laptop sends RC overrides at 20 Hz and a ground-station heartbeat at 1 Hz. Sticks have a 10% deadzone; motor direction reversals pause at neutral for 500 ms. Losing the Xbox controller, Pixhawk heartbeat, web socket, or stopping the agent sends neutral and requests disarm. If the laptop loses power, the Pixhawk's configured RC override timeout/failsafe is responsible for stopping propulsion.

Keep props off while checking input directions and PWM. The existing direct-Web-Serial interface remains at `/`; it runs its control loop in Chrome and should not be used for background operation. Use only one control interface at a time because the serial port is exclusive.

## Local website development

```sh
npm install
npm run dev
```

Open <http://localhost:3000> in Chrome or Edge. Add the local origin to the agent allowlist only if developing from another host or port. The token is generated each agent start and grants local control; keep it private.

## Deploy to Cloudflare Pages

The app is a static export in `.next-export/`. Deploy the production branch with:

```sh
npm run deploy:pages
```

This builds into a separate `.next-export` directory so it does not interfere with `npm run dev`, then uploads that directory to the `main` production branch. Cloudflare Pages project: `haav-mission-control`; custom hostname: `mission.haav.build`.

## Backends

The dashboard drives the boat one of two ways and picks automatically on load:

- **mission_daemon** (preferred): the C++ program in `../daemon` owns the controller and the serial port and serves
  `ws://127.0.0.1:8765`. When it is running, the Backend readout turns green and the page is a thin client.
  See `../daemon/README.md` for the one-command build and run on macOS, Windows and Linux.
- **In-browser**: without the daemon the page falls back to Web Serial and the Gamepad API (Chrome/Edge only).

Both expose the same `MissionApi` (`lib/mission-api.ts`); the page never knows which one it is talking to.

## Dashboard UI (`/`)

Tailwind v4 + shadcn/ui (`components/ui`, generated with `npx shadcn add ...`), IBM Plex Sans/Mono via
`next/font`. Design tokens are at the bottom of `app/globals.css`; the reviewed design plan with every
layout decision is `../.context/dashboard-redesign-plan.md`.

| Path | Role |
|---|---|
| `components/StatusBar.tsx` | Two-tier status bar: operator-critical readouts on top, link counters below |
| `components/ControllerPanel.tsx` | Sidebar with the four live controller graphs |
| `components/ConsolePanel.tsx` | Output gauges, start/arm controls, first-run checklist |
| `components/LogPanel.tsx` | Filtered connection log, newest at the bottom |
| `components/Scope.tsx`, `components/BipolarGauge.tsx` | The only custom components: a 60 Hz canvas chart and a centre-zero PWM bar |

Esc stops control output and sends disarm. Page CSS for other routes must stay inside the
`@layer base { }` block in `globals.css`, otherwise generic selectors override the dashboard's utilities.

Run the dev server with its own build directory so a concurrent `next build` cannot break it:

```
NEXT_DIST_DIR=.next-dev npm run dev
```
