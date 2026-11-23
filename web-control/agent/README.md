# Laptop MAVLink agent

The agent runs the controller and serial loops outside Chrome, so the link continues while Mission Control is in a background tab. It reads the Xbox controller with pygame-ce, talks MAVLink to ArduPilot with pymavlink, and exposes a token-protected WebSocket on loopback for the website.

## Install

Use Python 3.14 on macOS (MAVProxy's readline dependency has issues on newer Python builds):

```sh
brew install python@3.14
cd /path/to/haav-firmware-controls
$(brew --prefix python@3.14)/bin/python3.14 -m venv .venv-mavproxy314
source .venv-mavproxy314/bin/activate
python -m pip install -r web-control/agent/requirements.txt
```

## Start

Pair the Xbox controller first, then list serial ports:

```sh
source .venv-mavproxy314/bin/activate
python web-control/agent/boat_agent.py --list-ports
```

Start the agent with the Pixhawk serial port and its configured baud rate:

```sh
python web-control/agent/boat_agent.py --port /dev/cu.usbserial-D30H6SNY --baud 57600
```

Leave the terminal open. Copy the generated local token into <https://mission.haav.build/agent>, connect the agent, and start control. The website can be backgrounded; the laptop agent keeps sampling the controller and sending overrides. Closing the website connection or stopping the agent sends neutral and disarms. If the laptop loses power, ArduPilot's RC override timeout/failsafe takes over.

## Controls and mapping

- Left stick vertical → RC1 / left thruster
- Right stick vertical → RC3 / right thruster
- LT minus RT → RC6 / rudder (verify trigger direction in the live UI before enabling output)
- A → MANUAL mode and arm; B → stop output, center all RC overrides, and disarm

Every disarm path stops the override loop and centers the rudder first. While the laptop agent remains connected to a healthy Pixhawk and it is disarmed, the agent keeps RC6 at neutral; this is needed because `SERVO3_FUNCTION=RCIN6Scaled` follows RC6 even while disarmed. Stopping the agent lets ArduPilot's RC override timeout hand control back to the receiver.

The agent only accepts browser WebSocket connections from Mission Control and local development origins. The token is generated for each process start; do not share it.
