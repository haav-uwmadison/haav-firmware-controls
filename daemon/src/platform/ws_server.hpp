// Loopback-only WebSocket server the dashboard connects to. Inbound text messages are queued for the
// main loop; outbound broadcasts go to every connected client.
#pragma once
#include <functional>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <vector>

namespace ix { class WebSocket; class WebSocketServer; }

namespace platform {

class WsServer {
 public:
  /** `hello` is called on the main thread (via flushHellos) for each new connection. */
  WsServer(int port, std::function<std::string()> hello);
  ~WsServer();
  bool start(std::string& error);
  /** Sends the initial hello payload to newly connected clients; call from the main loop. */
  void flushHellos();
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
  std::vector<std::weak_ptr<ix::WebSocket>> pendingHellos_;
  std::set<std::weak_ptr<ix::WebSocket>, std::owner_less<std::weak_ptr<ix::WebSocket>>> readyClients_;
};

}  // namespace platform
