-- boat_manual.lua  (ArduPilot Rover 4.7, boat frame)
--
-- Independent joystick control from QGroundControl in MANUAL mode.
--
-- Rover only turns two QGC joystick axes into RC inputs (steering and
-- throttle), so this script reads QGC's MANUAL_CONTROL messages directly
-- to get all four axes:
--
--   QGC axis   MAVLink field   Gamepad input          Drives
--   Throttle   z               left stick vertical    left motor  (SERVO1)
--   Pitch      x               right stick vertical   right motor (SERVO2)
--   Roll       y               right trigger          rudder right (SERVO3)
--   Yaw        r               left trigger           rudder left  (SERVO3)
--
-- Only active while ARMED and in MANUAL. In any other mode (Hold, Auto,
-- RTL...) or when disarmed, ArduPilot drives the outputs normally.
-- Output range and direction come from SERVOx_MIN / TRIM / MAX / REVERSED,
-- so you can tune them in QGC's parameter editor without editing this file.

---------------------------------------------------------------------------
-- Configuration
---------------------------------------------------------------------------
local MANUAL_MODE      = 0       -- Rover MANUAL mode number

-- Output channels (1-indexed here, like SERVOx numbering)
local LEFT_OUT         = 1
local RIGHT_OUT        = 2
local RUDDER_OUT       = 3

-- Input direction fixes (flip if a stick or trigger reads backwards in DEBUG)
local INVERT_LEFT      = false   -- left stick
local INVERT_RIGHT     = false   -- right stick
local INVERT_RT        = false   -- right trigger
local INVERT_LT        = false   -- left trigger

local STICK_DEADBAND   = 0.05    -- fraction of stick travel treated as center
local TRIGGER_DEADBAND = 0.05    -- fraction of trigger travel ignored

local INPUT_TIMEOUT_MS = 500     -- no joystick data this long -> stop motors
local UPDATE_MS        = 20      -- 50 Hz
local OVERRIDE_MS      = 100     -- each override expires after this

local DEBUG            = false   -- true: print raw joystick values once per second

---------------------------------------------------------------------------
-- MAVLink setup
---------------------------------------------------------------------------
local MSGID_MANUAL_CONTROL = 69
mavlink:init(8, 1)
mavlink:register_rx_msgid(MSGID_MANUAL_CONTROL)

local PAYLOAD = 13   -- payload starts at byte 13 of the received message

local function field(msg, plen, off, fmt, size)
  -- MAVLink2 trims trailing zero bytes, so fields past the length are 0
  if off + size <= plen then
    return (string.unpack(fmt, msg, PAYLOAD + off))
  end
  return 0
end

---------------------------------------------------------------------------
-- State
---------------------------------------------------------------------------
local js = { x = 0, y = 0, z = 0, r = 0, t_ms = -100000 }
local rt_rest, lt_rest = 0, 0           -- learned trigger rest positions
local out = {}                          -- cached SERVOx_MIN/TRIM/MAX/REVERSED
local was_active = false
local last_param_ms, last_debug_ms = -100000, 0

local function now_ms() return millis():toint() end

local function load_outputs()
  for _, ch in ipairs({ LEFT_OUT, RIGHT_OUT, RUDDER_OUT }) do
    local p = "SERVO" .. ch .. "_"
    out[ch] = {
      min  = param:get(p .. "MIN")  or 1100,
      trim = param:get(p .. "TRIM") or 1500,
      max  = param:get(p .. "MAX")  or 1900,
      rev  = (param:get(p .. "REVERSED") or 0) ~= 0,
    }
  end
end

local function read_joystick()
  local sysid   = param:get("MAV_SYSID") or 1
  local gcs_id  = param:get("MAV_GCS_SYSID") or 255
  while true do
    local msg = mavlink:receive_chan()
    if not msg then break end
    local plen   = string.unpack("<B", msg, 4)
    local sender = string.unpack("<B", msg, 8)
    local msgid  = string.unpack("<I3", msg, 10)
    if msgid == MSGID_MANUAL_CONTROL and sender == gcs_id then
      local target = field(msg, plen, 10, "<B", 1)
      if target == sysid then
        js.x = field(msg, plen, 0, "<h", 2)
        js.y = field(msg, plen, 2, "<h", 2)
        js.z = field(msg, plen, 4, "<h", 2)
        js.r = field(msg, plen, 6, "<h", 2)
        js.t_ms = now_ms()
      end
    end
  end
end

---------------------------------------------------------------------------
-- Conversions
---------------------------------------------------------------------------
local function clamp(v, lo, hi)
  if v < lo then return lo elseif v > hi then return hi end
  return v
end

local function stick(v, invert)        -- -1000..1000 -> -1..1
  local s = clamp(v / 1000, -1, 1)
  if invert then s = -s end
  if math.abs(s) < STICK_DEADBAND then return 0 end
  return s
end

-- Triggers rest at either -1000 or 0 depending on QGC calibration.
-- Track the lowest value seen as the rest point and scale from there.
local function trigger(v, invert, rest)  -- returns 0..1, new rest
  if invert then v = -v end
  v = clamp(v, -1000, 1000)
  if v < rest then rest = v end
  local a = (v - rest) / (1000 - rest)
  if a < TRIGGER_DEADBAND then a = 0 end
  return clamp(a, 0, 1), rest
end

local function to_pwm(ch, cmd)         -- cmd -1..1 -> PWM within SERVOx limits
  local o = out[ch]
  if o.rev then cmd = -cmd end
  local pwm
  if cmd >= 0 then
    pwm = o.trim + cmd * (o.max - o.trim)
  else
    pwm = o.trim + cmd * (o.trim - o.min)
  end
  return math.floor(pwm + 0.5)
end

local function set_out(ch, cmd)
  SRV_Channels:set_output_pwm_chan_timeout(ch - 1, to_pwm(ch, cmd), OVERRIDE_MS)
end

---------------------------------------------------------------------------
-- Main loop
---------------------------------------------------------------------------
function update()
  local now = now_ms()

  if now - last_param_ms > 2000 then   -- pick up QGC parameter edits live
    load_outputs()
    last_param_ms = now
  end

  read_joystick()
  local fresh = (now - js.t_ms) < INPUT_TIMEOUT_MS

  local active = arming:is_armed() and vehicle:get_mode() == MANUAL_MODE

  if active then
    if fresh then
      local left  = stick(js.z, INVERT_LEFT)
      local right = stick(js.x, INVERT_RIGHT)
      local rt, lt
      rt, rt_rest = trigger(js.y, INVERT_RT, rt_rest)
      lt, lt_rest = trigger(js.r, INVERT_LT, lt_rest)
      set_out(LEFT_OUT,   left)
      set_out(RIGHT_OUT,  right)
      set_out(RUDDER_OUT, rt - lt)
    else
      -- joystick data stopped: motors to neutral, rudder centered
      set_out(LEFT_OUT, 0)
      set_out(RIGHT_OUT, 0)
      set_out(RUDDER_OUT, 0)
    end
  end

  if active ~= was_active then
    gcs:send_text(6, active and "Boat: stick control ON" or "Boat: stick control OFF")
    was_active = active
  end

  if DEBUG and now - last_debug_ms > 1000 then
    gcs:send_text(6, string.format("JS z=%d x=%d y=%d r=%d %s",
      js.z, js.x, js.y, js.r, fresh and "" or "(stale)"))
    last_debug_ms = now
  end

  return update, UPDATE_MS
end

load_outputs()
gcs:send_text(6, "Boat manual control script loaded")
return update, 1000
