#include "platform/sim_vehicle.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace platform {

namespace {
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
  speedMps_ += (targetSpeed - speedMps_) * std::min(1.0, dt * 1.5);
  headingDeg_ = std::fmod(headingDeg_ + ((r - l) * 40.0 + rud * speedMps_ * 25.0) * dt + 360.0, 360.0);
  const double rad = headingDeg_ * M_PI / 180.0;
  lat_ += speedMps_ * std::cos(rad) * dt / 111320.0;
  lon_ += speedMps_ * std::sin(rad) * dt / (111320.0 * std::cos(lat_ * M_PI / 180.0));
  if (armed_) voltage_ = std::max(10.5f, voltage_ - static_cast<float>(dt) * 0.002f);

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
                                 120, 180, static_cast<uint16_t>(speedMps_ * 100), static_cast<uint16_t>(headingDeg_ * 100), 9, 0, 0, 0, 0, 0, 0);
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
