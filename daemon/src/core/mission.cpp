#include "core/mission.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>

namespace boat {

namespace {
constexpr double PI = 3.14159265358979323846;
constexpr uint32_t LINK_SETTLE_MS = 3000;          // how long to wait before calling a silent port "No data"
constexpr uint32_t ACK_TIMEOUT_MS = 2000;
constexpr uint32_t LAST_MESSAGE_REFRESH_MS = 3000;  // "Last msg" would flicker at frame rate otherwise
constexpr uint32_t STOPPED_BADGE_MS = 3000;
constexpr uint32_t WATCHDOG_MS = 500;
constexpr size_t LOG_LIMIT = 200;
constexpr size_t TRAIL_LIMIT = 1200;                // about 40 minutes at one point per 2 s
constexpr uint8_t ROVER_MODE_MANUAL = 0;

const char* modeName(uint32_t mode) {
  switch (mode) {
    case 0: return "MANUAL"; case 1: return "ACRO"; case 2: return "STEERING"; case 3: return "HOLD"; case 4: return "LOITER";
    case 5: return "FOLLOW"; case 6: return "GUIDED"; case 10: return "AUTO"; case 11: return "RTL"; case 12: return "SMART_RTL";
    case 15: return "GUIDED_NOGPS"; case 16: return "INITIALISING"; default: return nullptr;
  }
}
const char* vehicleName(uint8_t type) {
  switch (type) {
    case 1: return "Fixed wing"; case 2: return "Quadrotor"; case 6: return "Ground station"; case 10: return "Ground rover";
    case 11: return "Surface boat"; case 12: return "Submarine"; case 13: return "Hexarotor"; case 14: return "Octorotor"; case 29: return "Ground rover";
    default: return nullptr;
  }
}
const char* ackName(uint8_t result) {
  switch (result) {
    case 0: return "ACCEPTED"; case 1: return "TEMPORARILY_REJECTED"; case 2: return "DENIED"; case 3: return "UNSUPPORTED";
    case 4: return "FAILED"; case 5: return "IN_PROGRESS"; case 6: return "CANCELLED"; default: return nullptr;
  }
}
std::string fmt(const char* f, double v) { char b[64]; std::snprintf(b, sizeof b, f, v); return b; }
std::string fmti(const char* f, long v) { char b[64]; std::snprintf(b, sizeof b, f, v); return b; }
}  // namespace

const char* name(LinkPhase p) {
  switch (p) {
    case LinkPhase::Disconnected: return "disconnected"; case LinkPhase::Opening: return "opening"; case LinkPhase::NoData: return "no-data";
    case LinkPhase::NoFrames: return "no-frames"; case LinkPhase::Waiting: return "waiting"; case LinkPhase::Heartbeat: return "heartbeat";
    case LinkPhase::Lost: return "lost"; case LinkPhase::Failed: return "failed"; case LinkPhase::PortLost: return "port-lost";
  }
  return "disconnected";
}
const char* name(OutputPhase p) {
  switch (p) { case OutputPhase::Idle: return "idle"; case OutputPhase::Sending: return "sending"; case OutputPhase::Stopped: return "stopped"; case OutputPhase::Error: return "error"; }
  return "idle";
}
const char* name(ArmPending p) {
  switch (p) { case ArmPending::None: return ""; case ArmPending::Arm: return "arm"; case ArmPending::Disarm: return "disarm"; }
  return "";
}
const char* name(LogKind k) {
  switch (k) { case LogKind::Info: return "info"; case LogKind::Pixhawk: return "pixhawk"; case LogKind::Ack: return "ack"; case LogKind::Warn: return "warn"; case LogKind::Error: return "error"; }
  return "info";
}

Mission::Mission(MissionIO io) : io_(std::move(io)) {}

// ---- link events ---------------------------------------------------------------------------------

void Mission::onLinkOpening() { s_.connecting = true; s_.linkPhase = LinkPhase::Opening; }

void Mission::onLinkOpened(const std::string& portLabel, int baud) {
  resetLinkState();
  connectedAt_ = io_.nowMs();
  s_.connected = true; s_.connecting = false; s_.linkPhase = LinkPhase::Waiting; s_.baud = baud;
  s_.portLabel = portLabel;
  log("Serial port opened at " + std::to_string(baud) + " baud. Listening for MAVLink.");
}

void Mission::onLinkFailed(const std::string& error) {
  s_.connecting = false; s_.linkPhase = LinkPhase::Failed;
  log("Connect failed: " + error, LogKind::Error);
}

void Mission::onLinkClosed(const std::string& reason) {
  stopOutput(reason.empty() ? "disconnected" : "serial link lost", false, false);
  clearAckWait();
  s_.connected = false; s_.connecting = false;
  s_.linkPhase = reason.empty() ? LinkPhase::Disconnected : LinkPhase::PortLost;
  if (reason.empty()) log("Disconnected"); else log("Serial link lost: " + reason, LogKind::Error);
}

void Mission::onBytes(const uint8_t* data, size_t len) {
  if (s_.bytesIn == 0 && len > 0) log("First bytes from the port (" + std::to_string(len) + "). If frames stay at 0 the baud rate is probably wrong.");
  s_.bytesIn += static_cast<uint32_t>(len);
  for (size_t i = 0; i < len; i++) {
    const uint16_t dropsBefore = rxStatus_.packet_rx_drop_count;
    if (mavlink_parse_char(MAVLINK_COMM_0, data[i], &rxMsg_, &rxStatus_)) handleFrame(rxMsg_);
    if (rxStatus_.packet_rx_drop_count != dropsBefore) s_.badCrc++;
  }
}

void Mission::onReadRecovered(const std::string& name, const std::string& message) {
  s_.recovered++;
  if (seenErrors_.find("[" + name + "]") == std::string::npos) {
    seenErrors_ += "[" + name + "]";
    log("Read error \"" + message + "\" (" + name + "); port still open, resuming. Further " + name + "s are counted, not logged.", LogKind::Warn);
  }
}

void Mission::onController(const Controller& c) {
  const bool pressedA = c.a && !prevA_, pressedB = c.b && !prevB_;
  prevA_ = c.a; prevB_ = c.b;
  s_.controller = c;
  if (c.connected) s_.controllerLost = false;
  // A = MANUAL + arm, B = disarm, whenever the link is up (not only while sending). Edge-triggered.
  if (!s_.connected || s_.armPending != ArmPending::None) return;
  if (pressedA) arm();
  else if (pressedB) disarm();
}

// ---- commands -----------------------------------------------------------------------------------

const char* Mission::startBlockedReason() const {
  if (!s_.connected) return "Connect to the Pixhawk first";
  if (!s_.controller.connected) return "Press any button on the Xbox controller first";
  return nullptr;
}

void Mission::startOutput() {
  if (!io_.linkConnected()) { log("Connect to the Pixhawk before enabling control output.", LogKind::Warn); return; }
  if (!s_.controller.connected) { log("Controller not detected. Press any button on it first.", LogKind::Warn); return; }
  if (s_.sending) return;
  stoppedUntil_ = 0;
  s_.sending = true; s_.outputPhase = OutputPhase::Sending; s_.overridesSent = 0; s_.heartbeatsSent = 0; s_.banner.clear(); s_.controllerLost = false;
  reverseLeft_ = ReversePause{}; reverseRight_ = ReversePause{};
  lastHeartbeatSentAt_ = 0; nextLoopAt_ = io_.nowMs();
  log("Control output started: RC override at 20 Hz, GCS heartbeat at 1 Hz. Overrides lapse 1 s after the stream stops (RC_OVERRIDE_TIME).");
}

void Mission::stopLoop() { s_.sending = false; s_.pwm = Pwm{}; }

void Mission::stopOutput(const std::string& reason, bool disarmToo, bool write, OutputPhase phase) {
  if (!s_.sending) return;
  stopLoop();
  s_.outputPhase = phase;
  stoppedUntil_ = phase == OutputPhase::Stopped ? io_.nowMs() + STOPPED_BADGE_MS : 0;
  log("Control output stopped: " + reason, phase == OutputPhase::Error ? LogKind::Error : LogKind::Warn);
  if (!write) return;
  if (!sendOverride(Pwm{})) { log("Neutral on stop failed: write error", LogKind::Error); return; }
  if (disarmToo) disarm();
}

void Mission::arm() {
  if (!sendCommand(MAV_CMD_DO_SET_MODE, MAV_MODE_FLAG_CUSTOM_MODE_ENABLED, ROVER_MODE_MANUAL) ||
      !sendCommand(MAV_CMD_COMPONENT_ARM_DISARM, 1)) { log("Arm failed: write error", LogKind::Error); return; }
  log("Sent: set MANUAL mode + arm");
  waitForAck(ArmPending::Arm);
}

void Mission::disarm() {
  if (s_.sending) { stopLoop(); s_.outputPhase = OutputPhase::Stopped; stoppedUntil_ = io_.nowMs() + STOPPED_BADGE_MS; log("Control output stopped for disarm", LogKind::Warn); }
  if (!sendOverride(Pwm{}) || !sendCommand(MAV_CMD_COMPONENT_ARM_DISARM, 0)) { log("Disarm failed: write error", LogKind::Error); return; }
  log("Sent neutral RC override + disarm");
  waitForAck(ArmPending::Disarm);
}

void Mission::panic() {
  if (s_.sending) stopOutput("Esc pressed", true);
  else if (io_.linkConnected()) disarm();
}

void Mission::setMotorSpan(int span) { s_.motorSpan = std::min(MAX_MOTOR_SPAN, std::max(MIN_MOTOR_SPAN, span)); }
void Mission::setBaud(int baud) { if (!s_.connected && !s_.connecting) s_.baud = baud; }
void Mission::clearTrail() { s_.trail.clear(); haveTrail_ = false; if (onTrailCleared) onTrailCleared(); }

// ---- timers and loop ----------------------------------------------------------------------------

void Mission::tick() {
  const uint32_t now = io_.nowMs();
  if (s_.sending && static_cast<int32_t>(now - nextLoopAt_) >= 0) { nextLoopAt_ = now + OVERRIDE_INTERVAL_MS; loopTick(now); }
  // RCIN6Scaled follows RC6 even while disarmed, so hold only the rudder centred while the link is healthy and output is idle.
  if (static_cast<int32_t>(now - nextRudderAt_) >= 0) {
    nextRudderAt_ = now + OVERRIDE_INTERVAL_MS;
    if (s_.connected && !s_.sending && s_.telemetry.armed == 0 && heartbeatAt_ && now - heartbeatAt_ <= HEARTBEAT_TIMEOUT_MS) sendRudderNeutral();
  }
  if (static_cast<int32_t>(now - nextWatchdogAt_) >= 0) { nextWatchdogAt_ = now + WATCHDOG_MS; watchdog(now); }
  if (static_cast<int32_t>(now - nextLastMessageAt_) >= 0) { nextLastMessageAt_ = now + LAST_MESSAGE_REFRESH_MS; s_.telemetry.last = lastMessage_; }
  if (stoppedUntil_ && static_cast<int32_t>(now - stoppedUntil_) >= 0) { stoppedUntil_ = 0; if (s_.outputPhase == OutputPhase::Stopped) s_.outputPhase = OutputPhase::Idle; }
  if (ackDeadline_ && static_cast<int32_t>(now - ackDeadline_) >= 0) {
    const std::string what = name(s_.armPending);
    ackDeadline_ = 0; s_.armPending = ArmPending::None;
    log("No ACK for " + what + " within " + std::to_string(ACK_TIMEOUT_MS / 1000) + " s", LogKind::Warn);
  }
}

void Mission::loopTick(uint32_t now) {
  if (!io_.linkConnected()) { stopOutput("serial link closed", false, false); return; }
  const Controller& c = s_.controller;
  if (!c.connected) {
    s_.controllerLost = true; s_.banner = "Controller lost: outputs set to neutral and disarm sent.";
    stopOutput("controller disconnected", true);
    return;
  }
  const Command cmd = controllerToCommand(c);
  Command paused = cmd;
  paused.left = reverseLeft_.apply(cmd.left, now);
  paused.right = reverseRight_.apply(cmd.right, now);
  s_.pwm = commandToPwm(paused, s_.motorSpan);
  if (!sendOverride(s_.pwm)) {
    log("Write failed", LogKind::Error);
    s_.banner = "Serial write failed: output stopped. Check the radio and reconnect.";
    stopOutput("write error", false, false, OutputPhase::Error);
    return;
  }
  s_.overridesSent++;
  if (now - lastHeartbeatSentAt_ >= HEARTBEAT_INTERVAL_MS) { lastHeartbeatSentAt_ = now; if (sendHeartbeat()) s_.heartbeatsSent++; }
}

void Mission::watchdog(uint32_t now) {
  if (!io_.linkConnected()) return;
  if (heartbeatAt_) {
    const uint32_t age = now - heartbeatAt_;
    if (age > HEARTBEAT_TIMEOUT_MS) {
      if (!lostSince_) { lostSince_ = heartbeatAt_; log("Heartbeat lost. The Pixhawk's own failsafes now own the boat.", LogKind::Warn); }
      s_.lostSeconds = static_cast<int>(age / 1000); s_.linkPhase = LinkPhase::Lost;
    } else s_.linkPhase = LinkPhase::Heartbeat;
    return;
  }
  const bool settled = now - connectedAt_ > LINK_SETTLE_MS;
  if (s_.frames > 0) s_.linkPhase = LinkPhase::Waiting;
  else if (s_.bytesIn > 0) s_.linkPhase = settled ? LinkPhase::NoFrames : LinkPhase::Waiting;
  else s_.linkPhase = settled ? LinkPhase::NoData : LinkPhase::Waiting;
}

// ---- telemetry ----------------------------------------------------------------------------------

void Mission::handleFrame(const mavlink_message_t& msg) {
  s_.frames++;
  const char* msgName = nullptr;
  switch (msg.msgid) {
    case MAVLINK_MSG_ID_HEARTBEAT: msgName = "HEARTBEAT"; break; case MAVLINK_MSG_ID_SYS_STATUS: msgName = "SYS_STATUS"; break;
    case MAVLINK_MSG_ID_GPS_RAW_INT: msgName = "GPS_RAW_INT"; break; case MAVLINK_MSG_ID_GLOBAL_POSITION_INT: msgName = "GLOBAL_POSITION_INT"; break;
    case MAVLINK_MSG_ID_ATTITUDE: msgName = "ATTITUDE"; break; case MAVLINK_MSG_ID_VFR_HUD: msgName = "VFR_HUD"; break; case MAVLINK_MSG_ID_COMMAND_ACK: msgName = "COMMAND_ACK"; break;
    case MAVLINK_MSG_ID_STATUSTEXT: msgName = "STATUSTEXT"; break; default: break;
  }
  lastMessage_ = (msgName ? std::string(msgName) : "MSG " + std::to_string(msg.msgid)) + " · " + std::to_string(msg.sysid) + "/" + std::to_string(msg.compid);
  if (msg.sysid != TARGET_SYSTEM) return;
  const uint32_t now = io_.nowMs();

  switch (msg.msgid) {
    case MAVLINK_MSG_ID_HEARTBEAT: {
      if (msg.compid != TARGET_COMPONENT) return;
      mavlink_heartbeat_t hb; mavlink_msg_heartbeat_decode(&msg, &hb);
      if (lostSince_) { log("Heartbeat back after " + std::to_string((now - lostSince_ + 500) / 1000) + " s"); lostSince_ = 0; }
      heartbeatAt_ = now;
      const char* v = vehicleName(hb.type); const char* m = modeName(hb.custom_mode);
      s_.telemetry.vehicle = v ? v : "MAV_TYPE " + std::to_string(hb.type);
      s_.telemetry.mode = m ? m : "Custom " + std::to_string(hb.custom_mode);
      s_.telemetry.armed = (hb.base_mode & MAV_MODE_FLAG_SAFETY_ARMED) ? 1 : 0;
      break;
    }
    case MAVLINK_MSG_ID_GPS_RAW_INT: {
      mavlink_gps_raw_int_t gps; mavlink_msg_gps_raw_int_decode(&msg, &gps);
      gpsFix_ = gps.fix_type; gpsSats_ = gps.satellites_visible;
      s_.telemetry.gps = (gps.fix_type >= 3 ? "Fix " + std::to_string(gps.fix_type) : std::string("No 3D fix")) + " · " + std::to_string(gps.satellites_visible) + " sats";
      // No fused position yet (EKF not ready): show the raw GPS fix so the map still works.
      if (gps.fix_type >= 2 && !haveTrail_) {
        s_.hasPosition = true; s_.position = Position{gps.lat / 1e7, gps.lon / 1e7, false, 0, gpsFix_, gpsSats_, now};
      } else if (gps.fix_type < 2) {
        if (!s_.hasPosition) { s_.hasPosition = true; s_.position = Position{}; }
        s_.position.fixType = gpsFix_; s_.position.satellites = gpsSats_;
      }
      break;
    }
    case MAVLINK_MSG_ID_GLOBAL_POSITION_INT: {
      mavlink_global_position_int_t p; mavlink_msg_global_position_int_decode(&msg, &p);
      const double speedMps = std::hypot(p.vx, p.vy) / 100.0;
      s_.telemetry.speed = fmt("%.1f kn", speedMps * 1.94384);
      s_.telemetry.heading = p.hdg == 65535 ? "—" : fmti("%ld°", std::lround(p.hdg / 100.0) % 360);
      s_.pfd.hasSpeed = true; s_.pfd.speedMps = speedMps;
      // ATTITUDE's yaw is the better heading source (higher rate); keep the EKF heading only until it shows up.
      if (!s_.pfd.hasAttitude && p.hdg != 65535) { s_.pfd.hasHeading = true; s_.pfd.headingDeg = p.hdg / 100.0; }
      if (p.lat == 0 && p.lon == 0) break;
      const double lat = p.lat / 1e7, lon = p.lon / 1e7;
      s_.hasPosition = true;
      s_.position = Position{lat, lon, p.hdg != 65535, p.hdg / 100.0, gpsFix_, gpsSats_, now};
      // Trail: keep a point every ~1 m or every 2 s.
      const double movedM = haveTrail_ ? std::hypot((lat - lastTrail_.lat) * 111320.0, (lon - lastTrail_.lon) * 111320.0 * std::cos(lat * PI / 180.0)) : 1e9;
      if (!haveTrail_ || movedM > 1.0 || now - lastTrailAt_ > 2000) {
        haveTrail_ = true; lastTrail_ = TrailPoint{lat, lon}; lastTrailAt_ = now;
        s_.trail.push_back(lastTrail_);
        if (s_.trail.size() > TRAIL_LIMIT) s_.trail.erase(s_.trail.begin(), s_.trail.begin() + (s_.trail.size() - TRAIL_LIMIT));
        if (onTrailPoint) onTrailPoint(lastTrail_);
      }
      break;
    }
    case MAVLINK_MSG_ID_ATTITUDE: {
      mavlink_attitude_t a; mavlink_msg_attitude_decode(&msg, &a);
      const double deg = 180.0 / PI;
      s_.pfd.hasAttitude = s_.pfd.hasHeading = true;
      s_.pfd.rollDeg = a.roll * deg; s_.pfd.pitchDeg = a.pitch * deg; s_.pfd.yawRateDps = a.yawspeed * deg;
      s_.pfd.headingDeg = std::fmod(std::fmod(a.yaw * deg, 360.0) + 360.0, 360.0);
      break;
    }
    case MAVLINK_MSG_ID_SYS_STATUS: {
      mavlink_sys_status_t sys; mavlink_msg_sys_status_decode(&msg, &sys);
      if (sys.voltage_battery == 65535) s_.telemetry.battery = "n/a";
      else {
        s_.telemetry.battery = fmt("%.2f V", sys.voltage_battery / 1000.0);
        if (sys.battery_remaining >= 0) s_.telemetry.battery += " · " + std::to_string(sys.battery_remaining) + "%";
      }
      break;
    }
    case MAVLINK_MSG_ID_STATUSTEXT: {
      mavlink_statustext_t st; mavlink_msg_statustext_decode(&msg, &st);
      char text[51]; std::memcpy(text, st.text, 50); text[50] = 0;
      if (text[0]) log(std::string("Pixhawk: ") + text, st.severity <= 3 ? LogKind::Error : st.severity == 4 ? LogKind::Warn : LogKind::Pixhawk);
      break;
    }
    case MAVLINK_MSG_ID_COMMAND_ACK: {
      mavlink_command_ack_t ack; mavlink_msg_command_ack_decode(&msg, &ack);
      const std::string cmdName = ack.command == MAV_CMD_COMPONENT_ARM_DISARM ? "arm/disarm" : ack.command == MAV_CMD_DO_SET_MODE ? "set mode" : "command " + std::to_string(ack.command);
      const char* r = ackName(ack.result);
      log("ACK " + cmdName + ": " + (r ? r : std::to_string(ack.result)), ack.result == 0 ? LogKind::Ack : LogKind::Error);
      if (ack.command == MAV_CMD_COMPONENT_ARM_DISARM) clearAckWait();
      break;
    }
    default: break;
  }
}

// ---- helpers ------------------------------------------------------------------------------------

void Mission::log(const std::string& text, LogKind kind) {
  LogLine line{++logId_, io_.clockString(), kind, text};
  logs_.push_back(line);
  if (logs_.size() > LOG_LIMIT) logs_.erase(logs_.begin(), logs_.begin() + (logs_.size() - LOG_LIMIT));
  if (onLog) onLog(line);
}

bool Mission::send(const mavlink_message_t& msg) {
  if (!io_.linkConnected()) return false;
  uint8_t buf[MAVLINK_MAX_PACKET_LEN];
  const uint16_t len = mavlink_msg_to_send_buffer(buf, &msg);
  return io_.write(buf, len);
}

bool Mission::sendOverride(const Pwm& p) {
  uint16_t ch[8]; pwmToChannels(p, ch);
  mavlink_message_t msg;
  mavlink_msg_rc_channels_override_pack(GCS_SYSTEM, GCS_COMPONENT, &msg, TARGET_SYSTEM, TARGET_COMPONENT,
                                        ch[0], ch[1], ch[2], ch[3], ch[4], ch[5], ch[6], ch[7], 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  return send(msg);
}

bool Mission::sendRudderNeutral() {
  uint16_t ch[8]; rudderNeutralChannels(ch);
  mavlink_message_t msg;
  mavlink_msg_rc_channels_override_pack(GCS_SYSTEM, GCS_COMPONENT, &msg, TARGET_SYSTEM, TARGET_COMPONENT,
                                        ch[0], ch[1], ch[2], ch[3], ch[4], ch[5], ch[6], ch[7], 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  return send(msg);
}

bool Mission::sendHeartbeat() {
  mavlink_message_t msg;
  mavlink_msg_heartbeat_pack(GCS_SYSTEM, GCS_COMPONENT, &msg, MAV_TYPE_GCS, MAV_AUTOPILOT_INVALID, 0, 0, MAV_STATE_ACTIVE);
  return send(msg);
}

bool Mission::sendCommand(uint16_t command, float p1, float p2) {
  mavlink_message_t msg;
  mavlink_msg_command_long_pack(GCS_SYSTEM, GCS_COMPONENT, &msg, TARGET_SYSTEM, TARGET_COMPONENT, command, 0, p1, p2, 0, 0, 0, 0, 0);
  return send(msg);
}

void Mission::waitForAck(ArmPending what) { s_.armPending = what; ackDeadline_ = io_.nowMs() + ACK_TIMEOUT_MS; }
void Mission::clearAckWait() { ackDeadline_ = 0; s_.armPending = ArmPending::None; }

void Mission::resetLinkState() {
  heartbeatAt_ = 0; lostSince_ = 0; lastMessage_ = "—"; seenErrors_.clear(); gpsFix_ = gpsSats_ = 0; haveTrail_ = false;
  rxStatus_ = mavlink_status_t{};
  s_.telemetry = Telemetry{}; s_.pfd = Pfd{}; s_.frames = s_.bytesIn = s_.recovered = s_.badCrc = 0; s_.lostSeconds = 0;
  s_.hasPosition = false; s_.position = Position{};
}

}  // namespace boat
