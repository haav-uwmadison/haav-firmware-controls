#include "platform/sim_vehicle.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <string>

namespace platform {

namespace {
constexpr double PI = 3.14159265358979323846;
constexpr uint8_t SYS = 1, COMP = 1;
void statusText(std::vector<uint8_t>& out, uint8_t severity, const char* text) {
  mavlink_message_t msg;
  char buf[50] = {};
  std::strncpy(buf, text, sizeof buf);
  mavlink_msg_statustext_pack(SYS, COMP, &msg, severity, buf, 0, 0);
  uint8_t b[MAVLINK_MAX_PACKET_LEN];
  const uint16_t n = mavlink_msg_to_send_buffer(b, &msg);
  out.insert(out.end(), b, b + n);
}
}  // namespace

struct SimParam { const char* name; float value; uint8_t type; };
// From haav-model/pixhawk/haav-esp32.params (Rover-Boat 4.7.2), the entries that matter for this boat.
static const SimParam kParams[] = {
  {"AHRS_EKF_TYPE", 3, 2}, {"ARMING_CHECK", 1, 6}, {"BATT_MONITOR", 4, 2}, {"BATT_CAPACITY", 5000, 6}, {"CRUISE_SPEED", 2, 9}, {"CRUISE_THROTTLE", 50, 2},
  {"FRAME_CLASS", 2, 2}, {"FS_ACTION", 2, 2}, {"FS_TIMEOUT", 1.5f, 9}, {"FS_THR_ENABLE", 1, 2}, {"GPS1_TYPE", 1, 2}, {"MAV_GCS_SYSID", 255, 4},
  {"MOT_PWM_TYPE", 0, 2}, {"MOT_THR_MAX", 100, 2}, {"MOT_THR_MIN", 0, 2}, {"MOT_SLEWRATE", 0, 4}, {"PILOT_STEER_TYPE", 1, 2}, {"RC_OVERRIDE_TIME", 1, 9},
  {"RC1_MAX", 2000, 4}, {"RC1_MIN", 1000, 4}, {"RC1_TRIM", 1500, 4}, {"RC3_MAX", 2000, 4}, {"RC3_MIN", 1000, 4}, {"RC3_TRIM", 1500, 4},
  {"RC6_MAX", 2000, 4}, {"RC6_MIN", 1000, 4}, {"RC6_TRIM", 1500, 4}, {"SERIAL1_BAUD", 57, 6}, {"SERIAL1_PROTOCOL", 2, 2},
  {"SERVO1_FUNCTION", 73, 4}, {"SERVO1_MAX", 1750, 4}, {"SERVO1_MIN", 1250, 4}, {"SERVO1_REVERSED", 0, 2}, {"SERVO1_TRIM", 1500, 4},
  {"SERVO2_FUNCTION", 74, 4}, {"SERVO2_MAX", 1750, 4}, {"SERVO2_MIN", 1250, 4}, {"SERVO2_REVERSED", 0, 2}, {"SERVO2_TRIM", 1500, 4},
  {"SERVO3_FUNCTION", 145, 4}, {"SERVO3_MAX", 1750, 4}, {"SERVO3_MIN", 1250, 4}, {"SERVO3_REVERSED", 0, 2}, {"SERVO3_TRIM", 1500, 4},
  {"MAV_SYSID", 1, 4}, {"WP_SPEED", 2, 9},
};
constexpr int kParamCount = static_cast<int>(sizeof kParams / sizeof kParams[0]);

void SimVehicle::emitParam(int index, std::vector<uint8_t>& out) {
  if (index < 0 || index >= kParamCount) return;
  const SimParam& p = kParams[index];
  const auto ov = paramOverrides_.find(index);
  mavlink_message_t m;
  mavlink_msg_param_value_pack(SYS, COMP, &m, p.name, ov == paramOverrides_.end() ? p.value : ov->second, p.type, static_cast<uint16_t>(kParamCount), static_cast<uint16_t>(index));
  emit(m, out);
}

SimVehicle::SimVehicle(std::function<uint32_t()> nowMs) : nowMs_(std::move(nowMs)) {
  statusText(pending_, 6, "ArduPilot Ready (simulated)");
}

void SimVehicle::emit(const mavlink_message_t& msg, std::vector<uint8_t>& out) {
  uint8_t b[MAVLINK_MAX_PACKET_LEN];
  const uint16_t n = mavlink_msg_to_send_buffer(b, &msg);
  out.insert(out.end(), b, b + n);
}

void SimVehicle::onBytes(const uint8_t* data, size_t len) {
  for (size_t i = 0; i < len; i++) {
    if (!mavlink_parse_char(MAVLINK_COMM_1, data[i], &rx_, &rxStatus_)) continue;
    if (rx_.msgid == MAVLINK_MSG_ID_RC_CHANNELS_OVERRIDE) {
      mavlink_rc_channels_override_t o; mavlink_msg_rc_channels_override_decode(&rx_, &o);
      if (o.chan1_raw != 0xFFFF) left_ = o.chan1_raw;
      if (o.chan3_raw != 0xFFFF) right_ = o.chan3_raw;
      if (o.chan6_raw != 0xFFFF) rudder_ = o.chan6_raw;
      lastOverride_ = nowMs_();
    } else if (rx_.msgid == MAVLINK_MSG_ID_PARAM_REQUEST_LIST) {
      paramStreamNext_ = 0;
    } else if (rx_.msgid == MAVLINK_MSG_ID_PARAM_REQUEST_READ) {
      mavlink_param_request_read_t r; mavlink_msg_param_request_read_decode(&rx_, &r);
      if (r.param_index >= 0) emitParam(r.param_index, pending_);
      else for (int i = 0; i < kParamCount; i++) if (std::strncmp(kParams[i].name, r.param_id, 16) == 0) emitParam(i, pending_);
    } else if (rx_.msgid == MAVLINK_MSG_ID_PARAM_SET) {
      mavlink_param_set_t ps; mavlink_msg_param_set_decode(&rx_, &ps);
      for (int i = 0; i < kParamCount; i++) if (std::strncmp(kParams[i].name, ps.param_id, 16) == 0) { paramOverrides_[i] = ps.param_value; emitParam(i, pending_); }
    } else if (rx_.msgid == MAVLINK_MSG_ID_COMMAND_LONG) {
      mavlink_command_long_t c; mavlink_msg_command_long_decode(&rx_, &c);
      uint8_t result = MAV_RESULT_ACCEPTED;
      if (c.command == MAV_CMD_COMPONENT_ARM_DISARM) {
        const bool arm = c.param1 >= 0.5f;
        if (arm && !armed_) statusText(pending_, 6, "Arming motors");
        if (!arm && armed_) statusText(pending_, 6, "Disarming motors");
        armed_ = arm;
      } else if (c.command == MAV_CMD_DO_SET_MODE) {
        mode_ = static_cast<uint32_t>(c.param2);
      } else if (c.command == MAV_CMD_SET_MESSAGE_INTERVAL) {
        // accepted; the simulator already streams at the rates the dashboard asks for
      } else if (c.command == MAV_CMD_DO_SET_SERVO) {
        // Like ArduPilot: only an output whose SERVOn_FUNCTION is Disabled takes a raw PWM.
        const int ch = static_cast<int>(c.param1);
        int fnIndex = -1;
        const std::string fnName = "SERVO" + std::to_string(ch) + "_FUNCTION";
        for (int i = 0; i < kParamCount; i++) if (fnName == kParams[i].name) fnIndex = i;
        const float fn = fnIndex < 0 ? -1.0f : (paramOverrides_.count(fnIndex) ? paramOverrides_[fnIndex] : kParams[fnIndex].value);
        if (ch < 1 || ch > 8 || fn != 0.0f) result = MAV_RESULT_FAILED;
        else {
          servoPwm_[ch - 1] = static_cast<int>(c.param2);
          // a hobby ESC's beeps, so the dashboard flow can be followed by eye
          if (servoPwm_[ch - 1] >= 1900) statusText(pending_, 6, ("Sim ESC " + std::to_string(ch) + ": beep beep (saw full throttle)").c_str());
          else if (servoPwm_[ch - 1] <= 1100) statusText(pending_, 6, ("Sim ESC " + std::to_string(ch) + ": beep (range stored)").c_str());
        }
      } else result = MAV_RESULT_UNSUPPORTED;
      mavlink_message_t ack;
      mavlink_msg_command_ack_pack(SYS, COMP, &ack, c.command, result, 0, 0, 0, 0);
      emit(ack, pending_);
    }
  }
}

std::vector<uint8_t> SimVehicle::poll() {
  std::vector<uint8_t> out;
  out.swap(pending_);
  const uint32_t now = nowMs_();
  if (lastStep_ == 0) lastStep_ = now;
  const double dt = (now - lastStep_) / 1000.0;
  lastStep_ = now;

  // Simple boat physics: thrust from both motors, turning from their difference and the rudder.
  const bool driving = armed_ && now - lastOverride_ < 1000;
  const double l = driving ? (left_ - 1500) / 500.0 : 0, r = driving ? (right_ - 1500) / 500.0 : 0, rud = driving ? (rudder_ - 1500) / 500.0 : 0;
  const double targetSpeed = (l + r) / 2.0 * 2.5;   // 2.5 m/s at full throttle
  const double prevSpeed = speedMps_;
  speedMps_ += (targetSpeed - speedMps_) * std::min(1.0, dt * 1.5);
  turnRateDps_ = (r - l) * 40.0 + rud * speedMps_ * 25.0;
  headingDeg_ = std::fmod(headingDeg_ + turnRateDps_ * dt + 360.0, 360.0);
  // Attitude: a little heel into turns, bow-up under acceleration, plus a gentle wave motion.
  accelMps2_ = dt > 0 ? (speedMps_ - prevSpeed) / dt : 0;
  const double wave = now / 1000.0;
  rollDeg_ += ((turnRateDps_ * 0.25) + std::sin(wave * 1.3) * 2.0 - rollDeg_) * std::min(1.0, dt * 3.0);
  pitchDeg_ += ((accelMps2_ * 4.0 + speedMps_ * 1.2) + std::cos(wave * 0.9) * 1.0 - pitchDeg_) * std::min(1.0, dt * 3.0);
  const double rad = headingDeg_ * PI / 180.0;
  lat_ += speedMps_ * std::cos(rad) * dt / 111320.0;
  lon_ += speedMps_ * std::sin(rad) * dt / (111320.0 * std::cos(lat_ * PI / 180.0));
  if (armed_) voltage_ = std::max(10.5f, voltage_ - static_cast<float>(dt) * 0.002f);

  // Stream the parameter list a few entries per poll, dropping one the first time round.
  for (int n = 0; n < 3 && paramStreamNext_ >= 0; n++) {
    const int i = paramStreamNext_++;
    if (i == 7 && !droppedOnce_) droppedOnce_ = true; else emitParam(i, out);
    if (paramStreamNext_ >= kParamCount) paramStreamNext_ = -1;
  }
  if (now >= nextHeartbeat_) {
    nextHeartbeat_ = now + 1000;
    mavlink_message_t m;
    mavlink_msg_heartbeat_pack(SYS, COMP, &m, MAV_TYPE_SURFACE_BOAT, MAV_AUTOPILOT_ARDUPILOTMEGA,
                               MAV_MODE_FLAG_CUSTOM_MODE_ENABLED | (armed_ ? MAV_MODE_FLAG_SAFETY_ARMED : 0), mode_, MAV_STATE_ACTIVE);
    emit(m, out);
  }
  if (now >= nextSysStatus_) {
    nextSysStatus_ = now + 1000;
    mavlink_message_t m;
    const int8_t remaining = static_cast<int8_t>(std::max(0.0f, std::min(100.0f, (voltage_ - 10.5f) / 2.1f * 100.0f)));
    mavlink_msg_sys_status_pack(SYS, COMP, &m, 0, 0, 0, 120, static_cast<uint16_t>(voltage_ * 1000), -1, remaining, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    emit(m, out);
  }
  if (now >= nextGps_) {
    nextGps_ = now + 1000;
    mavlink_message_t m;
    mavlink_msg_gps_raw_int_pack(SYS, COMP, &m, static_cast<uint64_t>(now) * 1000, 3, static_cast<int32_t>(lat_ * 1e7), static_cast<int32_t>(lon_ * 1e7), 259000,
                                 120, 180, static_cast<uint16_t>(std::abs(speedMps_) * 100), static_cast<uint16_t>(headingDeg_ * 100), 9, 0, 0, 0, 0, 0, 0);
    emit(m, out);
  }
  if (now >= nextAttitude_) {
    nextAttitude_ = now + 100;
    mavlink_message_t m;
    const float toRad = static_cast<float>(PI / 180.0);
    mavlink_msg_attitude_pack(SYS, COMP, &m, now, static_cast<float>(rollDeg_) * toRad, static_cast<float>(pitchDeg_) * toRad,
                              static_cast<float>(headingDeg_) * toRad, 0, 0, static_cast<float>(turnRateDps_) * toRad);
    emit(m, out);
  }
  if (now >= nextPosition_) {
    nextPosition_ = now + 200;
    mavlink_message_t m;
    const int16_t vx = static_cast<int16_t>(speedMps_ * std::cos(rad) * 100), vy = static_cast<int16_t>(speedMps_ * std::sin(rad) * 100);
    mavlink_msg_global_position_int_pack(SYS, COMP, &m, now, static_cast<int32_t>(lat_ * 1e7), static_cast<int32_t>(lon_ * 1e7), 259000, 0, vx, vy, 0,
                                         static_cast<uint16_t>(headingDeg_ * 100));
    emit(m, out);
  }
  return out;
}

}  // namespace platform
