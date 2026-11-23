#include "platform/ws_server.hpp"

#include <algorithm>
#include <ixwebsocket/IXNetSystem.h>
#include <ixwebsocket/IXWebSocketServer.h>

namespace platform {

namespace {
bool isOriginHost(const std::string& origin, const std::string& base) {
  if (origin.rfind(base, 0) != 0) return false;
  if (origin.size() == base.size()) return true;
  if (origin[base.size()] != ':' || origin.size() == base.size() + 1) return false;
  for (size_t i = base.size() + 1; i < origin.size(); i++) {
    if (origin[i] < '0' || origin[i] > '9') return false;
  }
  return true;
}

bool originAllowed(const std::string& origin) {
  if (origin.empty()) return true;   // non-browser clients (curl, scripts)
  return origin == "https://mission.haav.build" ||
         isOriginHost(origin, "http://localhost") ||
         isOriginHost(origin, "https://localhost") ||
         isOriginHost(origin, "http://127.0.0.1");
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
  server_->setOnConnectionCallback([this](std::weak_ptr<ix::WebSocket> weakWs, std::shared_ptr<ix::ConnectionState>) {
    auto ws = weakWs.lock();
    if (!ws) return;
    auto allowed = std::make_shared<bool>(false);
    ws->setOnMessageCallback([this, weakWs, allowed](const ix::WebSocketMessagePtr& msg) {
      if (msg->type == ix::WebSocketMessageType::Open) {
        auto it = msg->openInfo.headers.find("Origin");
        if (it != msg->openInfo.headers.end() && !originAllowed(it->second)) {
          if (auto locked = weakWs.lock()) locked->close(1008, "origin not allowed");
          return;
        }
        *allowed = true;
        std::lock_guard<std::mutex> lock(mutex_);
        pendingHellos_.push_back(weakWs);
      } else if (msg->type == ix::WebSocketMessageType::Message && *allowed) {
        std::lock_guard<std::mutex> lock(mutex_);
        inbound_.push_back(msg->str);
      } else if (msg->type == ix::WebSocketMessageType::Close) {
        *allowed = false;
        std::lock_guard<std::mutex> lock(mutex_);
        readyClients_.erase(weakWs);
        pendingHellos_.erase(
            std::remove_if(pendingHellos_.begin(), pendingHellos_.end(),
                           [&](const std::weak_ptr<ix::WebSocket>& w) { return !w.owner_before(weakWs) && !weakWs.owner_before(w); }),
            pendingHellos_.end());
      }
    });
  });
  const auto res = server_->listen();
  if (!res.first) { error = res.second; return false; }
  server_->start();
  return true;
}

void WsServer::flushHellos() {
  std::vector<std::weak_ptr<ix::WebSocket>> pending;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    pending.swap(pendingHellos_);
  }
  if (pending.empty()) return;
  const std::string payload = hello_();
  std::vector<std::shared_ptr<ix::WebSocket>> live;
  live.reserve(pending.size());
  for (const auto& weakWs : pending) {
    if (auto ws = weakWs.lock()) {
      if (ws->getReadyState() != ix::ReadyState::Open) continue;
      ws->send(payload);
      live.push_back(std::move(ws));
    }
  }
  std::lock_guard<std::mutex> lock(mutex_);
  for (const auto& ws : live) readyClients_.insert(ws);
}

void WsServer::broadcast(const std::string& text) {
  if (!server_) return;
  std::vector<std::shared_ptr<ix::WebSocket>> targets;
  {
    std::lock_guard<std::mutex> lock(mutex_);
    for (auto it = readyClients_.begin(); it != readyClients_.end();) {
      if (auto ws = it->lock()) {
        targets.push_back(std::move(ws));
        ++it;
      } else {
        it = readyClients_.erase(it);
      }
    }
  }
  for (const auto& client : targets) client->send(text);
}

std::vector<std::string> WsServer::takeInbound() {
  std::lock_guard<std::mutex> lock(mutex_);
  std::vector<std::string> out;
  out.swap(inbound_);
  return out;
}

int WsServer::clientCount() const {
  std::lock_guard<std::mutex> lock(mutex_);
  int count = 0;
  for (const auto& weakWs : readyClients_) if (!weakWs.expired()) count++;
  return count;
}

}  // namespace platform
