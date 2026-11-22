// Loopback-only WebSocket server the dashboard connects to. Inbound text messages are queued for the
// main loop; outbound broadcasts go to every connected client.
#pragma once
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace ix { class WebSocketServer; }

namespace platform {

class WsServer {
 public:
  /** `hello` is called on each new connection and must return the full-state message to send first. */
  WsServer(int port, std::function<std::string()> hello);
  ~WsServer();
  bool start(std::string& error);
  void broadcast(const std::string& text);
  /** Takes every inbound message received since the last call. */
  std::vector<std::string> takeInbound();
  int clientCount() const;
  int port() const { return port_; }

 private:
  int port_;
  std::function<std::string()> hello_;
  std::unique_ptr<ix::WebSocketServer> server_;
  mutable std::mutex mutex_;
  std::vector<std::string> inbound_;
};

}  // namespace platform
