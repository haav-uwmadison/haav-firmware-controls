# haav-model: Xbox controller → model boat

Drive the model boat with an Xbox controller. An ESP32 on shore reads the controller over
Bluetooth and sends MAVLink commands through a telemetry radio to the Pixhawk on the boat.
The Pixhawk (ArduPilot Rover 4.7, boat frame) drives the two motors and the rudder.

```
Xbox controller ──BLE──> XIAO ESP32-C6 ──UART──> ground radio ~~~~> boat radio ──TELEM1──> Pixhawk ──> ESCs + rudder servo
```

## How it works

- `src/main.cpp` runs on the ESP32. It acts like a ground station: it sends a heartbeat once a
  second, and RC override messages (`RC_CHANNELS_OVERRIDE`) 20 times a second:
  - RC1 = left stick → left motor
  - RC3 = right stick → right motor
  - RC6 = right trigger minus left trigger → rudder
- `PILOT_STEER_TYPE = 1` ("two paddles") makes the Pixhawk drive the left motor (OUT 1) from RC1
  and the right motor (OUT 2) from RC3. `SERVO3_FUNCTION = RCIN6Scaled` copies RC6 straight to
  the rudder (OUT 3).
- The ESCs only reverse after sitting at neutral, so the ESP32 holds a motor at neutral for
  `REVERSE_PAUSE_MS` (500 ms) whenever its stick changes direction.
- Safety: if the controller disconnects, the ESP32 zeroes everything and sends disarm. If the radio
  link drops, the Pixhawk's failsafe stops the motors within about 1 s and then switches to Hold.

| Input | Action |
|---|---|
| Left stick up/down | Left motor forward/reverse |
| Right stick up/down | Right motor forward/reverse |
| Right / left trigger | Rudder right / left |
| A | Switch to MANUAL and arm |
| B | Disarm |

## Files

| Path | What it is |
|---|---|
| `src/main.cpp` | ESP32 firmware |
| `platformio.ini` | Board (Seeed XIAO ESP32-C6) and libraries |
| `pixhawk/haav-esp32.params` | Pixhawk parameters for this ESP32 setup. **Use this one.** |
| `pixhawk/haav-qgc.params`, `pixhawk/control-qgc.lua` | Older setup that drove the boat from QGroundControl instead (not used) |

The param files are full dumps of our Pixhawk, including its sensor calibration. Don't load them
onto a different Pixhawk.

## Wiring

- **Boat:** boat radio → Pixhawk TELEM1 (57600 baud). OUT 1 = left ESC, OUT 2 = right ESC,
  OUT 3 = rudder servo.
- **Shore:** ground radio TX → ESP32 **D6**, ground radio RX → ESP32 **D7**, plus 5V and GND.
  The board's printed labels show these pins the other way round; the firmware swaps them in code.

## Running it

**One-time: Pixhawk parameters**
1. Connect the Pixhawk over USB and open QGroundControl.
2. Vehicle Configuration → Parameters → Tools → **Load from file…** → `pixhawk/haav-esp32.params`.
3. Tools → **Reboot Vehicle**. Then close QGroundControl.

**One-time: flash the ESP32** (and again after any code change)

4. **Close QGroundControl first.** It grabs the ESP32's COM port, and the upload fails with
   "port busy".
5. Open this folder in VS Code with the PlatformIO extension, plug in the ESP32, and click
   **Upload**. If the port isn't found, hold BOOT, tap RESET, release BOOT, and try again.
6. Open the PlatformIO **Serial Monitor** (115200 baud).

**Each session**

7. Power the boat with the props clear, then power the ESP32 and ground radio. Wait for the radio
   LEDs to go solid. The monitor should show `link ok`, with the `rx` counts climbing.
8. Turn on the Xbox controller. The first time, hold its pair button until the logo flashes fast.
   The firmware only connects to the controller whose MAC is set at the top of `main.cpp`. The
   monitor shows `ctrl ok` after you touch any input.
9. With sticks centered and triggers released, press **A**. The monitor shows two
   `ACK ... result 0` lines and then `ARMED`. If arming fails, the `PIXHAWK: PreArm: ...` lines
   say why.
10. Drive. Press **B** to disarm when done.

The monitor prints a status line 5 times a second:
```
ctrl ok  | link ok  | rx 48213 B 912 pkt | ARMED    | left 1500 right 1500 rudder 1500
```

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Upload says COM port busy | QGroundControl (or a serial monitor) has the port open. Close it. |
| `link --`, `rx 0 B` | D6/D7 swapped, or the radios aren't linked |
| `rx` climbing but `link --` | Baud mismatch. Both radio ports must be 57600. |
| Pressing A gets no ACK | ESP32 D7 → radio RX wire not working |
| A motor or the rudder goes the wrong way | Set `SERVO1/2/3_REVERSED` to 1 in the Pixhawk params |
| A motor creeps with the sticks centered | ESC neutral isn't at 1500. Recalibrate the ESC or adjust `SERVOx_TRIM`. |
| Rudder output shows 0 in QGroundControl | Normal until the ESP32 starts sending; it jumps to 1500 once linked |

## Tuning

- Motor and rudder travel is limited to 1250–1750 µs by `SERVO1/2/3_MIN` and `SERVO1/2/3_MAX`.
  Widen these for more speed or rudder throw.
- `REVERSE_PAUSE_MS` and `DEADZONE` are at the top of `main.cpp`.
- Don't use `MANUAL_STR_EXPO` or `MOT_SLEWRATE` to smooth steering. In two-paddle mode they mix
  the two sticks together. Do any smoothing on the ESP32 instead.
