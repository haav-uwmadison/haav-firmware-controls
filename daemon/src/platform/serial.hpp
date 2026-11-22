// Non-blocking serial port for macOS, Linux and Windows.
#pragma once
#include <cstdint>
#include <string>
#include <vector>

namespace platform {

struct SerialPortInfo { std::string path; std::string description; };

/** Serial devices that could be the radio or the Pixhawk, most likely first (USB serial adapters before USB modems). */
std::vector<SerialPortInfo> listSerialPorts();

class SerialPort {
 public:
  SerialPort() = default;
  ~SerialPort();
  SerialPort(const SerialPort&) = delete;
  SerialPort& operator=(const SerialPort&) = delete;

  /** Opens and configures 8N1 raw mode. On failure returns false and fills `error`. */
  bool open(const std::string& path, int baud, std::string& error);
  void close();
  bool isOpen() const { return open_; }
  /** Reads whatever is available without blocking. Returns bytes read, or -1 when the port went away. */
  int read(uint8_t* buf, size_t len);
  bool write(const uint8_t* data, size_t len);
  const std::string& path() const { return path_; }

 private:
  bool open_ = false;
  std::string path_;
#ifdef _WIN32
  void* handle_ = nullptr;
#else
  int fd_ = -1;
#endif
};

}  // namespace platform
