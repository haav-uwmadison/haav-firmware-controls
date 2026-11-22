#include "platform/ws_server.hpp"

#include <ixwebsocket/IXNetSystem.h>
#include <ixwebsocket/IXWebSocketServer.h>

namespace platform {

namespace {
bool originAllowed(const std::string& origin) {
  if (origin.empty()) return true;   // non-browser clients (curl, scripts)
  return origin == "https://mission.haav.build" || origin.rfind("http://localhost", 0) == 0 || origin.rfind("http://127.0.0.1", 0) == 0 ||
         origin.rfind("https://localhost", 0) == 0;
}
}  // namespace

WsServer::WsServer(int port, std::function<std::string()> hello) : port_(port), hello_(std::move(hello)) {}

WsServer::~WsServer() {
  if (server_) server_->stop();
  ix::uninitNetSystem();
}

bool WsServer::start(std::string& error) {
  ix::initNetSystem();
  server_ = std::make_unique<ix::WebSocketServer>(port_, "127.0.0.1");
  server_->disablePerMessageDeflate();
  server_->setOnClientMessageCallback([this](std::shared_ptr<ix::ConnectionState> state, ix::WebSocket& ws, const ix::WebSocketMessagePtr& msg) {
    if (msg->type == ix::WebSocketMessageType::Open) {
      auto it = msg->openInfo.headers.find("Origin");
      if (it != msg->openInfo.headers.end() && !originAllowed(it->second)) { ws.close(1008, "origin not allowed"); return; }
      ws.send(hello_());
    } else if (msg->type == ix::WebSocketMessageType::Message) {
      std::lock_guard<std::mutex> lock(mutex_);
      inbound_.push_back(msg->str);
    }
  });
  const auto res = server_->listen();
  if (!res.first) { error = res.second; return false; }
  server_->start();
  return true;
}

void WsServer::broadcast(const std::string& text) {
  if (!server_) return;
  for (const auto& client : server_->getClients()) client->send(text);
}

std::vector<std::string> WsServer::takeInbound() {
  std::lock_guard<std::mutex> lock(mutex_);
  std::vector<std::string> out;
  out.swap(inbound_);
  return out;
}

int WsServer::clientCount() const { return server_ ? static_cast<int>(server_->getClients().size()) : 0; }

}  // namespace platform
