// The ground-station state machine: link phases, telemetry, the 20 Hz control loop, arming with ACK
// tracking, watchdogs and GPS trail. Portable C++17 with injected I/O so it runs in the laptop daemon
// today and can run on an ESP32 later. No threads, no OS timers: the platform calls tick() often.
// Mirrors web-control/lib/mission-controller.ts field for field so the dashboard needs no translation.
#pragma once
#include <cstdint>
#include <functional>
#include <map>
#include <string>
#include <vector>

#include "core/boat_control.hpp"

// MAVLink parser state lives here so the header stays self-contained for the platform code.
#include <common/mavlink.h>

namespace boat {

enum class LinkPhase { Disconnected, Opening, NoData, NoFrames, Waiting, Heartbeat, Lost, Failed, PortLost };
enum class OutputPhase { Idle, Sending, Stopped, Error };
enum class ArmPending { None, Arm, Disarm };
enum class LogKind { Info, Pixhawk, Ack, Warn, Error };

const char* name(LinkPhase p);
const char* name(OutputPhase p);
const char* name(ArmPending p);
const char* name(LogKind k);

struct LogLine { int id = 0; std::string time; LogKind kind = LogKind::Info; std::string text; };

struct Telemetry {
  std::string vehicle = "—", mode = "—";
  int armed = -1;  // -1 unknown, 0 disarmed, 1 armed
  std::string gps = "—", battery = "—", speed = "—", heading = "—", last = "—";
};

struct Position {
  double lat = 0, lon = 0;
  bool hasHeading = false;
  double heading = 0;
  int fixType = 0, satellites = 0;
  uint32_t timeMs = 0;
};

struct TrailPoint { double lat = 0, lon = 0; };

/** One Pixhawk parameter; `type` is MAV_PARAM_TYPE (1 UINT8 … 9 REAL32). */
struct Param { std::string name; float value = 0; int type = 0; int index = 0; };
/** The parameter table lives outside MissionState: it is sent once and then as deltas, never in the 30 Hz broadcast. */
struct ParamTable { std::map<std::string, Param> byName; int count = 0; bool loading = false; };

/** Numbers behind the dashboard's primary flight display; the has* flags mirror the nulls in the JSON. */
struct Pfd {
  bool hasAttitude = false, hasSpeed = false, hasHeading = false;
  double rollDeg = 0, pitchDeg = 0, yawRateDps = 0, speedMps = 0, headingDeg = 0;
};

struct MissionState {
  bool connected = false, connecting = false;
  LinkPhase linkPhase = LinkPhase::Disconnected;
  int lostSeconds = 0;
  int baud = 57600;
  std::string portLabel = "—";
  Telemetry telemetry;
  uint32_t frames = 0, bytesIn = 0, recovered = 0, badCrc = 0;
  bool hasPosition = false;
  Position position;
  Pfd pfd;
  std::vector<TrailPoint> trail;
  Controller controller;
  bool controllerLost = false;
  bool sending = false;
  OutputPhase outputPhase = OutputPhase::Idle;
  Pwm pwm;
  uint32_t overridesSent = 0, heartbeatsSent = 0;
  std::string banner;
  ArmPending armPending = ArmPending::None;
  int motorSpan = DEFAULT_MOTOR_SPAN;
  MotorReverse motorReverse;
};

/** Everything the core needs from the outside world. */
struct MissionIO {
  std::function<bool(const uint8_t* data, size_t len)> write;   // bytes to the Pixhawk; false on failure
  std::function<bool()> linkConnected;                           // is the serial port open
  std::function<uint32_t()> nowMs;                               // monotonic milliseconds
  std::function<std::string()> clockString;                      // wall-clock time for log lines
};

constexpr uint8_t TARGET_SYSTEM = 1, TARGET_COMPONENT = 1;     // the Pixhawk autopilot
constexpr uint8_t GCS_SYSTEM = 255, GCS_COMPONENT = 190;        // must match MAV_GCS_SYSID on the Pixhawk
constexpr uint32_t OVERRIDE_INTERVAL_MS = 50;                  // 20 Hz, same as the ESP32 firmware
constexpr uint32_t HEARTBEAT_INTERVAL_MS = 1000;
constexpr uint32_t HEARTBEAT_TIMEOUT_MS = 3000;

class Mission {
 public:
  explicit Mission(MissionIO io);

  // ---- events from the platform layer ----
  void onLinkOpening();
  void onLinkOpened(const std::string& portLabel, int baud);
  void onLinkFailed(const std::string& error);
  /** reason empty = user disconnect; otherwise the port went away */
  void onLinkClosed(const std::string& reason);
  void onBytes(const uint8_t* data, size_t len);
  void onReadRecovered(const std::string& name, const std::string& message);
  void onController(const Controller& c);
  /** Drive timers and the control loop. Call at least every 5 ms. */
  void tick();

  // ---- commands ----
  void startOutput();
  void stopOutput(const std::string& reason, bool disarm = false, bool write = true, OutputPhase phase = OutputPhase::Stopped);
  void arm();
  void disarm();
  /** Esc: stop output and disarm; disarm alone when idle. */
  void panic();
  void setMotorSpan(int span);
  /** Flip one motor's PWM direction; the reverse pause still runs on the flipped output. */
  void setMotorReverse(bool left, bool reverse);
  void setBaud(int baud);
  void clearTrail();
  /** Re-read the Pixhawk's parameter table (also runs automatically on each connect). */
  void refreshParams();
  void logExternal(const std::string& text, LogKind kind = LogKind::Info) { log(text, kind); }

  // ---- state ----
  const MissionState& state() const { return s_; }
  const std::vector<LogLine>& logs() const { return logs_; }
  const ParamTable& params() const { return params_; }
  const char* startBlockedReason() const;

  // Incremental notifications for the transport (so the browser gets log/trail deltas, not full copies).
  std::function<void(const LogLine&)> onLog;
  std::function<void(const TrailPoint&)> onTrailPoint;
  std::function<void()> onTrailCleared;
  std::function<void(const std::vector<Param>& batch, int count, bool loading)> onParams;
  std::function<void(bool loading)> onParamsCleared;

 private:
  void handleFrame(const mavlink_message_t& msg);
  void loopTick(uint32_t now);
  void watchdog(uint32_t now);
  void log(const std::string& text, LogKind kind = LogKind::Info);
  bool send(const mavlink_message_t& msg);
  bool sendOverride(const Pwm& p);
  bool sendRudderNeutral();
  bool sendHeartbeat();
  bool sendCommand(uint16_t command, float p1 = 0, float p2 = 0);
  void waitForAck(ArmPending what);
  void clearAckWait();
  void resetLinkState();
  void stopLoop();

  MissionIO io_;
  MissionState s_;
  std::vector<LogLine> logs_;
  int logId_ = 0;

  mavlink_message_t rxMsg_{};
  mavlink_status_t rxStatus_{};
  uint32_t heartbeatAt_ = 0, lostSince_ = 0, connectedAt_ = 0;
  bool streamsRequested_ = false;
  void requestStreams();
  ParamTable params_;
  std::vector<Param> paramBatch_;
  uint32_t lastParamAt_ = 0, nextParamFlushAt_ = 0;
  int paramRetries_ = 0;
  void flushParams(uint32_t now);
  void paramWatchdog(uint32_t now);
  std::string lastMessage_ = "—";
  std::string seenErrors_;
  int gpsFix_ = 0, gpsSats_ = 0;
  bool haveTrail_ = false;
  TrailPoint lastTrail_;
  uint32_t lastTrailAt_ = 0;
  bool prevA_ = false, prevB_ = false;

  // timers (all expressed as "next due" or "deadline" in nowMs)
  uint32_t nextLoopAt_ = 0, nextRudderAt_ = 0, nextWatchdogAt_ = 0, nextLastMessageAt_ = 0;
  uint32_t stoppedUntil_ = 0, ackDeadline_ = 0, lastHeartbeatSentAt_ = 0;
  ReversePause reverseLeft_, reverseRight_;
};

}  // namespace boat
