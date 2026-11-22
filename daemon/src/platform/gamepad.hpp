// Xbox controller input through SDL2's GameController API (works for Bluetooth and USB pads on
// macOS, Windows and Linux). Produces the same sample shape the core and the dashboard use.
#pragma once
#include <string>

#include "core/boat_control.hpp"

namespace platform {

class Gamepad {
 public:
  Gamepad();
  ~Gamepad();
  /** Pumps SDL events and returns the current sample. `connected` is false when no pad is open. */
  boat::Controller sample();
  std::string name() const { return name_; }

 private:
  void openFirst();
  void* pad_ = nullptr;   // SDL_GameController*
  std::string name_;
  bool ready_ = false;
};

}  // namespace platform
