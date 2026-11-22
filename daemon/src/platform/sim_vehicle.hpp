// A pretend ArduPilot boat for testing the dashboard without hardware (--sim). Speaks enough MAVLink
// to exercise every status readout: heartbeat, SYS_STATUS, GPS, position that moves with the
// commanded motors, COMMAND_ACK for arm/disarm/mode, and STATUSTEXT on arming.
#pragma once
#include <cstdint>
#include <functional>
#include <vector>

#include <common/mavlink.h>

namespace platform {

class SimVehicle {
 public:
  explicit SimVehicle(std::function<uint32_t()> nowMs);
  /** Bytes from the ground station (the daemon's writes). */
  void onBytes(const uint8_t* data, size_t len);
  /** Produces telemetry bytes due since the last call. */
  std::vector<uint8_t> poll();

 private:
  void emit(const mavlink_message_t& msg, std::vector<uint8_t>& out);
  std::function<uint32_t()> nowMs_;
  mavlink_message_t rx_{};
  mavlink_status_t rxStatus_{};
  std::vector<uint8_t> pending_;
  uint32_t nextHeartbeat_ = 0, nextSysStatus_ = 0, nextGps_ = 0, nextPosition_ = 0, nextAttitude_ = 0, lastOverride_ = 0, lastStep_ = 0;
  bool armed_ = false;
  uint32_t mode_ = 0;
  int left_ = 1500, right_ = 1500, rudder_ = 1500;
  double lat_ = 43.0766, lon_ = -89.4125, headingDeg_ = 90, speedMps_ = 0, turnRateDps_ = 0, accelMps2_ = 0, rollDeg_ = 0, pitchDeg_ = 0;   // Lake Mendota, Madison
  float voltage_ = 12.6f;
};

}  // namespace platform
