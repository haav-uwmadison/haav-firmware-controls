// mission_daemon: owns the Xbox controller and the Pixhawk serial link on the laptop and serves the
// dashboard over a loopback WebSocket. The browser only visualises and sends commands.
//
//   mission_daemon                      auto-detect the radio, serve ws://127.0.0.1:8765
//   mission_daemon --port COM5          explicit serial port (Windows)
//   mission_daemon --sim                no hardware: a simulated boat for testing the dashboard
//   mission_daemon --list-ports         show serial candidates and exit

#include <algorithm>
#include <chrono>
#include <cmath>
#include <csignal>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <limits>
#include <string>
#include <thread>

#include <nlohmann/json.hpp>

#include "core/mission.hpp"
#include "platform/gamepad.hpp"
#include "platform/serial.hpp"
#include "platform/sim_vehicle.hpp"
#include "platform/ws_server.hpp"

using json = nlohmann::json;
using namespace boat;

namespace {

constexpr const char* VERSION = "0.1.0";
constexpr int DEFAULT_WS_PORT = 8765;
constexpr uint32_t STATE_BROADCAST_MS = 33;   // 30 Hz is plenty for the gauges and graphs
volatile std::sig_atomic_t shutdownSignal = 0;

void handleShutdownSignal(int signal) { shutdownSignal = signal; }

void installShutdownHandlers() {
  // SDL may install its own SIGINT handler during SDL_Init. Replace it after
  // Gamepad construction so Ctrl-C sets a flag that the main loop can handle.
  std::signal(SIGINT, handleShutdownSignal);
#ifdef SIGTERM
  std::signal(SIGTERM, handleShutdownSignal);
#endif
}

uint32_t monotonicMs() {
  using namespace std::chrono;
  static const auto start = steady_clock::now();
  return static_cast<uint32_t>(duration_cast<milliseconds>(steady_clock::now() - start).count());
}

std::string clockString() {
  const std::time_t t = std::time(nullptr);
  std::tm tm{};
#ifdef _WIN32
  localtime_s(&tm, &t);
#else
  localtime_r(&t, &tm);
#endif
  const int hour12 = tm.tm_hour % 12 == 0 ? 12 : tm.tm_hour % 12;
  char buf[32];
  std::snprintf(buf, sizeof buf, "%d:%02d:%02d %s", hour12, tm.tm_min, tm.tm_sec, tm.tm_hour >= 12 ? "PM" : "AM");
  return buf;
}

json toJson(const Controller& c) {
  return {{"connected", c.connected}, {"id", ""}, {"lx", c.lx}, {"ly", c.ly}, {"rx", c.rx}, {"ry", c.ry}, {"lt", c.lt}, {"rt", c.rt}, {"a", c.a}, {"b", c.b}, {"time", monotonicMs()}};
}

json toJson(const Param& p) { return {{"name", p.name}, {"value", p.value}, {"type", p.type}, {"index", p.index}}; }

json paramsJson(const ParamTable& t) {
  json byName = json::object();
  for (const auto& kv : t.byName) byName[kv.first] = toJson(kv.second);
  return {{"byName", byName}, {"count", t.count}, {"received", t.byName.size()}, {"loading", t.loading}, {"updatedAt", 0}};
}

json toJson(const LogLine& l) { return {{"id", l.id}, {"time", l.time}, {"kind", name(l.kind)}, {"text", l.text}}; }

json positionJson(const MissionState& s) {
  if (!s.hasPosition) return nullptr;
  const Position& p = s.position;
  return {{"lat", p.lat}, {"lon", p.lon}, {"heading", p.hasHeading ? json(p.heading) : json(nullptr)}, {"fixType", p.fixType}, {"satellites", p.satellites}, {"time", p.timeMs}};
}

json pfdJson(const Pfd& p) {
  const auto opt = [](bool has, double v) { return has ? json(v) : json(nullptr); };
  return {{"rollDeg", opt(p.hasAttitude, p.rollDeg)}, {"pitchDeg", opt(p.hasAttitude, p.pitchDeg)}, {"yawRateDps", opt(p.hasAttitude, p.yawRateDps)},
          {"speedMps", opt(p.hasSpeed, p.speedMps)}, {"headingDeg", opt(p.hasHeading, p.headingDeg)}};
}

/** The same field names as MissionState in web-control/lib/mission-controller.ts. */
json stateJson(const Mission& m, const std::string& controllerName) {
  const MissionState& s = m.state();
  const char* blocked = m.startBlockedReason();
  json controller = toJson(s.controller);
  controller["id"] = controllerName;
  return {
    {"type", "state"},
    {"connected", s.connected}, {"connecting", s.connecting}, {"linkPhase", name(s.linkPhase)}, {"lostSeconds", s.lostSeconds},
    {"baud", std::to_string(s.baud)}, {"portLabel", s.portLabel},
    {"telemetry", {{"vehicle", s.telemetry.vehicle}, {"mode", s.telemetry.mode}, {"armed", s.telemetry.armed < 0 ? json(nullptr) : json(s.telemetry.armed == 1)},
                   {"gps", s.telemetry.gps}, {"battery", s.telemetry.battery}, {"speed", s.telemetry.speed}, {"heading", s.telemetry.heading}, {"last", s.telemetry.last}}},
    {"frames", s.frames}, {"bytesIn", s.bytesIn}, {"recovered", s.recovered}, {"badCrc", s.badCrc},
    {"position", positionJson(s)}, {"pfd", pfdJson(s.pfd)},
    {"controller", controller}, {"controllerLost", s.controllerLost},
    {"sending", s.sending}, {"outputPhase", name(s.outputPhase)},
    {"pwm", {{"left", s.pwm.left}, {"right", s.pwm.right}, {"rudder", s.pwm.rudder}}},
    {"overridesSent", s.overridesSent}, {"heartbeatsSent", s.heartbeatsSent},
    {"banner", s.banner.empty() ? json(nullptr) : json(s.banner)},
    {"armPending", s.armPending == ArmPending::None ? json(false) : json(name(s.armPending))},
    {"motorSpan", s.motorSpan},
    {"motorReverse", {{"left", s.motorReverse.left}, {"right", s.motorReverse.right}}},
    {"lastAck", s.lastAck.valid ? json{{"command", s.lastAck.command}, {"result", s.lastAck.result}, {"seq", s.lastAck.seq}} : json(nullptr)},
    {"startBlockedReason", blocked ? json(blocked) : json(nullptr)},
  };
}

struct Options {
  std::string port = "auto";
  int baud = 57600;
  int wsPort = DEFAULT_WS_PORT;
  bool sim = false, listPorts = false, autoConnect = true, help = false;
};

Options parseArgs(int argc, char** argv) {
  Options o;
  for (int i = 1; i < argc; i++) {
    const std::string a = argv[i];
    auto next = [&](const char* flag) -> std::string { if (i + 1 >= argc) { std::fprintf(stderr, "%s needs a value\n", flag); std::exit(2); } return argv[++i]; };
    if (a == "--port") o.port = next("--port");
    else if (a == "--baud") o.baud = std::atoi(next("--baud").c_str());
    else if (a == "--ws") o.wsPort = std::atoi(next("--ws").c_str());
    else if (a.rfind("--ws=", 0) == 0) o.wsPort = std::atoi(a.c_str() + 5);
    else if (a == "--sim") o.sim = true;
    else if (a == "--list-ports") o.listPorts = true;
    else if (a == "--no-autoconnect") o.autoConnect = false;
    else if (a == "--help" || a == "-h") o.help = true;
    else { std::fprintf(stderr, "unknown option %s\n", a.c_str()); o.help = true; }
  }
  return o;
}

}  // namespace

int main(int argc, char** argv) {
  const Options opt = parseArgs(argc, argv);
  if (opt.help) {
    std::printf("mission_daemon %s\n  --port <path|COMx|auto>  serial port (default auto: first USB serial adapter)\n  --baud <n>               serial baud (default 57600, the telemetry radio rate)\n"
                "  --ws <n>                 WebSocket port on 127.0.0.1 (default %d)\n  --sim                    simulated boat, no serial port\n  --no-autoconnect         wait for the dashboard to click Link\n  --list-ports             list serial candidates\n",
                VERSION, DEFAULT_WS_PORT);
    return 0;
  }
  if (opt.listPorts) {
    for (const auto& p : platform::listSerialPorts()) std::printf("%s\t%s\n", p.path.c_str(), p.description.c_str());
    return 0;
  }

  std::printf("mission_daemon %s\n", VERSION);
  platform::SerialPort serial;
  platform::SimVehicle sim(monotonicMs);
  platform::Gamepad gamepad;
  installShutdownHandlers();
  bool simLinkOpen = false;

  MissionIO io;
  io.nowMs = monotonicMs;
  io.clockString = clockString;
  io.linkConnected = [&] { return opt.sim ? simLinkOpen : serial.isOpen(); };
  io.write = [&](const uint8_t* data, size_t len) {
    if (opt.sim) { if (!simLinkOpen) return false; sim.onBytes(data, len); return true; }
    return serial.write(data, len);
  };
  Mission mission(io);
  mission.setBaud(opt.baud);

  platform::WsServer ws(opt.wsPort, [&] {
    json hello = stateJson(mission, gamepad.name());
    hello["type"] = "hello"; hello["version"] = VERSION;
    hello["logs"] = json::array(); for (const auto& l : mission.logs()) hello["logs"].push_back(toJson(l));
    hello["trail"] = json::array(); for (const auto& t : mission.state().trail) hello["trail"].push_back({t.lat, t.lon});
    hello["params"] = paramsJson(mission.params());
    return hello.dump();
  });
  mission.onLog = [&](const LogLine& l) { std::printf("[%s] %s\n", name(l.kind), l.text.c_str()); std::fflush(stdout); ws.broadcast(json{{"type", "log"}, {"line", toJson(l)}}.dump()); };
  mission.onTrailPoint = [&](const TrailPoint& t) { ws.broadcast(json{{"type", "trail"}, {"point", {t.lat, t.lon}}}.dump()); };
  mission.onTrailCleared = [&] { ws.broadcast(json{{"type", "trailClear"}}.dump()); };
  mission.onParams = [&](const std::vector<Param>& batch, int count, bool loading) {
    json items = json::array(); for (const Param& p : batch) items.push_back(toJson(p));
    ws.broadcast(json{{"type", "params"}, {"items", items}, {"count", count}, {"loading", loading}}.dump());
  };
  mission.onParamsCleared = [&](bool loading) { ws.broadcast(json{{"type", "paramsClear"}, {"loading", loading}}.dump()); };

  std::string error;
  if (!ws.start(error)) { std::fprintf(stderr, "cannot listen on 127.0.0.1:%d: %s\n", opt.wsPort, error.c_str()); return 1; }
  std::printf("dashboard link: ws://127.0.0.1:%d  (open https://mission.haav.build or http://localhost:3000)\n", opt.wsPort);

  auto openLink = [&] {
    if (opt.sim) { mission.onLinkOpening(); simLinkOpen = true; mission.onLinkOpened("Simulated boat", mission.state().baud); return; }
    std::string path = opt.port;
    if (path == "auto") {
      const auto ports = platform::listSerialPorts();
      if (ports.empty()) { mission.onLinkOpening(); mission.onLinkFailed("no serial port found. Plug in the radio (or pass --port)."); return; }
      path = ports.front().path;
      if (ports.size() > 1) { std::string others; for (size_t i = 1; i < ports.size(); i++) others += (i > 1 ? ", " : "") + ports[i].path; mission.logExternal("Several serial ports found; using " + path + " (others: " + others + "). Pass --port to choose.", LogKind::Warn); }
    }
    mission.onLinkOpening();
    std::string err;
    if (!serial.open(path, mission.state().baud, err)) { mission.onLinkFailed(err); return; }
    mission.onLinkOpened(path + " · " + std::to_string(mission.state().baud), mission.state().baud);
  };
  auto closeLink = [&](const std::string& reason) {
    if (opt.sim) simLinkOpen = false; else serial.close();
    mission.onLinkClosed(reason);
  };

  if (opt.autoConnect) openLink();

  uint8_t buf[4096];
  uint32_t nextBroadcast = 0;
  while (!shutdownSignal) {
    const uint32_t now = monotonicMs();
    // 1. controller
    mission.onController(gamepad.sample());
    // 2. inbound bytes
    if (opt.sim) { if (simLinkOpen) { const auto bytes = sim.poll(); if (!bytes.empty()) mission.onBytes(bytes.data(), bytes.size()); } }
    else if (serial.isOpen()) {
      const int n = serial.read(buf, sizeof buf);
      if (n > 0) mission.onBytes(buf, static_cast<size_t>(n));
      else if (n < 0) closeLink("device unplugged");
    }
    // 3. commands from the dashboard
    for (const std::string& text : ws.takeInbound()) {
      try {
        json cmd = json::parse(text, nullptr, false);
        if (!cmd.is_object() || !cmd.contains("name") || !cmd["name"].is_string()) continue;
        const std::string name = cmd["name"].get<std::string>();
        if (name == "connect") openLink();
        else if (name == "disconnect") { mission.stopOutput("disconnecting"); closeLink(""); }
        else if (name == "startOutput") mission.startOutput();
        else if (name == "stopOutput") {
          const std::string reason = (cmd.contains("reason") && cmd["reason"].is_string()) ? cmd["reason"].get<std::string>() : "stopped by user";
          mission.stopOutput(reason);
        } else if (name == "arm") mission.arm();
        else if (name == "disarm") mission.disarm();
        else if (name == "panic") mission.panic();
        else if (name == "setMotorSpan") {
          if (cmd.contains("span") && cmd["span"].is_number()) {
            const double rawSpan = cmd["span"].get<double>();
            if (std::isfinite(rawSpan)) {
              const double clamped = std::min<double>(MAX_MOTOR_SPAN, std::max<double>(MIN_MOTOR_SPAN, rawSpan));
              mission.setMotorSpan(static_cast<int>(std::lround(clamped)));
            }
          }
        } else if (name == "setMotorReverse") {
          if (cmd.contains("motor") && cmd["motor"].is_string() && cmd.contains("reverse") && cmd["reverse"].is_boolean()) {
            const std::string motor = cmd["motor"].get<std::string>();
            if (motor == "left" || motor == "right") {
              mission.setMotorReverse(motor == "left", cmd["reverse"].get<bool>());
            }
          }
        } else if (name == "setBaud") {
          int baud = 0;
          if (cmd.contains("baud") && cmd["baud"].is_string()) baud = std::atoi(cmd["baud"].get<std::string>().c_str());
          else if (cmd.contains("baud") && cmd["baud"].is_number_integer()) baud = cmd["baud"].get<int>();
          if (baud > 0) mission.setBaud(baud);
        } else if (name == "clearTrail") mission.clearTrail();
        else if (name == "refreshParams") mission.refreshParams();
        else if (name == "setParam") {
          if (cmd.contains("param") && cmd["param"].is_string() && cmd.contains("value") && cmd["value"].is_number()) {
            const double rawVal = cmd["value"].get<double>();
            if (std::isfinite(rawVal) && std::fabs(rawVal) <= static_cast<double>(std::numeric_limits<float>::max())) {
              mission.setParam(cmd["param"].get<std::string>(), static_cast<float>(rawVal));
            }
          }
        } else if (name == "commandLong") {
          if (cmd.contains("command") && cmd["command"].is_number_integer()) {
            const int64_t rawCmd = cmd["command"].get<int64_t>();
            if (rawCmd >= 0 && rawCmd <= 65535) {
              std::vector<float> params;
              bool validParams = true;
              if (cmd.contains("params") && cmd["params"].is_array()) {
                for (const auto& v : cmd["params"]) {
                  if (!v.is_number()) { params.push_back(0.0f); continue; }
                  const double d = v.get<double>();
                  if (!std::isfinite(d) || std::fabs(d) > static_cast<double>(std::numeric_limits<float>::max())) { validParams = false; break; }
                  params.push_back(static_cast<float>(d));
                }
              }
              if (validParams) mission.sendCommandLong(static_cast<uint16_t>(rawCmd), params);
            }
          }
        }
      } catch (const std::exception&) {
        // Ignore malformed dashboard command payloads rather than crashing the control daemon.
      }
    }
    // 4. timers and the control loop
    mission.tick();
    // 5. send initial hellos to new clients, then stream state to the dashboard
    ws.flushHellos();
    if (now >= nextBroadcast) { nextBroadcast = now + STATE_BROADCAST_MS; if (ws.clientCount() > 0) ws.broadcast(stateJson(mission, gamepad.name()).dump()); }
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
  }

  std::printf("\nShutting down: stopping output and disarming.\n");
  std::fflush(stdout);
  if (io.linkConnected()) mission.panic();
  closeLink("");
  std::printf("Mission daemon stopped.\n");
  return 0;
}
