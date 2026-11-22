#include "platform/serial.hpp"

#include <algorithm>
#include <cstring>

#ifdef _WIN32
#include <windows.h>
#else
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <termios.h>
#include <unistd.h>
#ifdef __APPLE__
#include <IOKit/serial/ioss.h>
#include <sys/ioctl.h>
#endif
#endif

namespace platform {

// ---- enumeration ----------------------------------------------------------------------------------

std::vector<SerialPortInfo> listSerialPorts() {
  std::vector<SerialPortInfo> ports;
#ifdef _WIN32
  HKEY key;
  if (RegOpenKeyExA(HKEY_LOCAL_MACHINE, "HARDWARE\\DEVICEMAP\\SERIALCOMM", 0, KEY_READ, &key) == ERROR_SUCCESS) {
    char name[256], value[256];
    for (DWORD i = 0;; i++) {
      DWORD nameLen = sizeof name, valueLen = sizeof value, type = 0;
      if (RegEnumValueA(key, i, name, &nameLen, nullptr, &type, reinterpret_cast<BYTE*>(value), &valueLen) != ERROR_SUCCESS) break;
      ports.push_back({std::string(value), std::string(name)});
    }
    RegCloseKey(key);
  }
  // USB serial adapters (radio) enumerate as \Device\USBSER or VCP; put them before anything else.
  std::stable_sort(ports.begin(), ports.end(), [](const SerialPortInfo& a, const SerialPortInfo& b) {
    auto score = [](const SerialPortInfo& p) { return p.description.find("USB") != std::string::npos || p.description.find("VCP") != std::string::npos || p.description.find("Silabser") != std::string::npos ? 0 : 1; };
    return score(a) < score(b);
  });
#else
  DIR* dir = opendir("/dev");
  if (!dir) return ports;
  while (dirent* e = readdir(dir)) {
    const std::string n = e->d_name;
#ifdef __APPLE__
    const bool match = n.rfind("cu.usbserial", 0) == 0 || n.rfind("cu.SLAB", 0) == 0 || n.rfind("cu.wchusbserial", 0) == 0 || n.rfind("cu.usbmodem", 0) == 0;
#else
    const bool match = n.rfind("ttyUSB", 0) == 0 || n.rfind("ttyACM", 0) == 0;
#endif
    if (match) ports.push_back({"/dev/" + n, n});
  }
  closedir(dir);
  // Radios (FTDI/CP210x: usbserial, SLAB, ttyUSB) before the Pixhawk's own USB port (usbmodem, ttyACM).
  std::stable_sort(ports.begin(), ports.end(), [](const SerialPortInfo& a, const SerialPortInfo& b) {
    auto score = [](const SerialPortInfo& p) { return p.description.find("usbmodem") != std::string::npos || p.description.find("ttyACM") != std::string::npos ? 1 : 0; };
    return score(a) < score(b);
  });
#endif
  return ports;
}

// ---- port -----------------------------------------------------------------------------------------

SerialPort::~SerialPort() { close(); }

#ifdef _WIN32

bool SerialPort::open(const std::string& path, int baud, std::string& error) {
  close();
  const std::string full = path.rfind("\\\\.\\", 0) == 0 ? path : "\\\\.\\" + path;
  HANDLE h = CreateFileA(full.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, 0, nullptr);
  if (h == INVALID_HANDLE_VALUE) { error = "cannot open " + path + " (error " + std::to_string(GetLastError()) + ")"; return false; }
  DCB dcb{}; dcb.DCBlength = sizeof dcb;
  if (!GetCommState(h, &dcb)) { error = "GetCommState failed"; CloseHandle(h); return false; }
  dcb.BaudRate = static_cast<DWORD>(baud); dcb.ByteSize = 8; dcb.Parity = NOPARITY; dcb.StopBits = ONESTOPBIT;
  dcb.fBinary = TRUE; dcb.fParity = FALSE; dcb.fOutxCtsFlow = FALSE; dcb.fOutxDsrFlow = FALSE; dcb.fDtrControl = DTR_CONTROL_ENABLE;
  dcb.fRtsControl = RTS_CONTROL_ENABLE; dcb.fOutX = FALSE; dcb.fInX = FALSE; dcb.fNull = FALSE; dcb.fAbortOnError = FALSE;
  if (!SetCommState(h, &dcb)) { error = "SetCommState failed (baud " + std::to_string(baud) + ")"; CloseHandle(h); return false; }
  COMMTIMEOUTS t{}; t.ReadIntervalTimeout = MAXDWORD;  // return immediately with whatever is buffered
  t.ReadTotalTimeoutConstant = 0; t.ReadTotalTimeoutMultiplier = 0; t.WriteTotalTimeoutConstant = 200; t.WriteTotalTimeoutMultiplier = 1;
  SetCommTimeouts(h, &t);
  PurgeComm(h, PURGE_RXCLEAR | PURGE_TXCLEAR);
  handle_ = h; path_ = path; open_ = true;
  return true;
}

void SerialPort::close() {
  if (open_) CloseHandle(static_cast<HANDLE>(handle_));
  handle_ = nullptr; open_ = false;
}

int SerialPort::read(uint8_t* buf, size_t len) {
  if (!open_) return -1;
  DWORD got = 0;
  if (!ReadFile(static_cast<HANDLE>(handle_), buf, static_cast<DWORD>(len), &got, nullptr)) { close(); return -1; }
  return static_cast<int>(got);
}

bool SerialPort::write(const uint8_t* data, size_t len) {
  if (!open_) return false;
  DWORD written = 0;
  if (!WriteFile(static_cast<HANDLE>(handle_), data, static_cast<DWORD>(len), &written, nullptr)) { close(); return false; }
  return written == len;
}

#else

bool SerialPort::open(const std::string& path, int baud, std::string& error) {
  close();
  int fd = ::open(path.c_str(), O_RDWR | O_NOCTTY | O_NONBLOCK);
  if (fd < 0) { error = "cannot open " + path + ": " + std::strerror(errno); return false; }
  termios tio{};
  if (tcgetattr(fd, &tio) != 0) { error = std::string("tcgetattr: ") + std::strerror(errno); ::close(fd); return false; }
  cfmakeraw(&tio);
  tio.c_cflag |= CLOCAL | CREAD;
  tio.c_cflag &= ~(PARENB | CSTOPB | CRTSCTS);
  tio.c_cflag = (tio.c_cflag & ~CSIZE) | CS8;
  tio.c_cc[VMIN] = 0; tio.c_cc[VTIME] = 0;
  speed_t speed = B57600;
  bool standard = true;
  switch (baud) {
    case 9600: speed = B9600; break; case 19200: speed = B19200; break; case 38400: speed = B38400; break;
    case 57600: speed = B57600; break; case 115200: speed = B115200; break; case 230400: speed = B230400; break;
#ifdef B921600
    case 921600: speed = B921600; break;
#endif
    default: standard = false; break;
  }
  if (standard) { cfsetispeed(&tio, speed); cfsetospeed(&tio, speed); }
  if (tcsetattr(fd, TCSANOW, &tio) != 0) { error = std::string("tcsetattr: ") + std::strerror(errno); ::close(fd); return false; }
  if (!standard) {
#ifdef __APPLE__
    speed_t custom = static_cast<speed_t>(baud);
    if (ioctl(fd, IOSSIOSPEED, &custom) != 0) { error = "unsupported baud rate " + std::to_string(baud); ::close(fd); return false; }
#else
    error = "unsupported baud rate " + std::to_string(baud); ::close(fd); return false;
#endif
  }
  tcflush(fd, TCIOFLUSH);
  fd_ = fd; path_ = path; open_ = true;
  return true;
}

void SerialPort::close() {
  if (open_) ::close(fd_);
  fd_ = -1; open_ = false;
}

int SerialPort::read(uint8_t* buf, size_t len) {
  if (!open_) return -1;
  const ssize_t n = ::read(fd_, buf, len);
  if (n < 0) {
    if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) return 0;
    close(); return -1;   // ENXIO/EIO: the USB device was unplugged
  }
  return static_cast<int>(n);
}

bool SerialPort::write(const uint8_t* data, size_t len) {
  if (!open_) return false;
  size_t done = 0; int spins = 0;
  while (done < len) {
    const ssize_t n = ::write(fd_, data + done, len - done);
    if (n < 0) {
      if ((errno == EAGAIN || errno == EWOULDBLOCK) && ++spins < 200) { usleep(500); continue; }
      close(); return false;
    }
    done += static_cast<size_t>(n);
  }
  return true;
}

#endif

}  // namespace platform
