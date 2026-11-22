#include "platform/gamepad.hpp"

#include <SDL.h>

#include <cstdio>

namespace platform {

Gamepad::Gamepad() {
  SDL_SetHint(SDL_HINT_JOYSTICK_ALLOW_BACKGROUND_EVENTS, "1");
  SDL_SetHint(SDL_HINT_JOYSTICK_HIDAPI, "1");
  // Windows only: Xbox sticks and buttons arrive as WM_INPUT raw-input messages, which SDL only
  // dispatches from the video subsystem's event pump. The daemon has no window, so without its own
  // joystick thread those messages are never read and only the XInput-polled triggers move.
  SDL_SetHint(SDL_HINT_JOYSTICK_THREAD, "1");
  if (SDL_Init(SDL_INIT_GAMECONTROLLER | SDL_INIT_JOYSTICK) != 0) {
    std::fprintf(stderr, "gamepad: SDL_Init failed: %s\n", SDL_GetError());
    return;
  }
  ready_ = true;
  openFirst();
}

Gamepad::~Gamepad() {
  if (pad_) SDL_GameControllerClose(static_cast<SDL_GameController*>(pad_));
  if (ready_) SDL_Quit();
}

void Gamepad::openFirst() {
  for (int i = 0; i < SDL_NumJoysticks(); i++) {
    if (!SDL_IsGameController(i)) continue;
    SDL_GameController* pad = SDL_GameControllerOpen(i);
    if (!pad) continue;
    pad_ = pad;
    name_ = SDL_GameControllerName(pad) ? SDL_GameControllerName(pad) : "Game controller";
    std::printf("gamepad: %s connected\n", name_.c_str());
    return;
  }
}

boat::Controller Gamepad::sample() {
  boat::Controller c;
  if (!ready_) return c;
  SDL_Event e;
  while (SDL_PollEvent(&e)) {
    if (e.type == SDL_CONTROLLERDEVICEADDED && !pad_) openFirst();
    if (e.type == SDL_CONTROLLERDEVICEREMOVED && pad_ && e.cdevice.which == SDL_JoystickInstanceID(SDL_GameControllerGetJoystick(static_cast<SDL_GameController*>(pad_)))) {
      SDL_GameControllerClose(static_cast<SDL_GameController*>(pad_));
      pad_ = nullptr; std::printf("gamepad: %s disconnected\n", name_.c_str()); name_.clear();
    }
  }
  if (!pad_) return c;
  auto* pad = static_cast<SDL_GameController*>(pad_);
  auto* joystick = SDL_GameControllerGetJoystick(pad);
  auto axis = [pad](SDL_GameControllerAxis a) { return SDL_GameControllerGetAxis(pad, a) / 32767.0f; };
  c.connected = SDL_GameControllerGetAttached(pad) == SDL_TRUE;
  c.lx = axis(SDL_CONTROLLER_AXIS_LEFTX);
  c.ly = -axis(SDL_CONTROLLER_AXIS_LEFTY);   // SDL reads up as negative; the boat wants forward = +1
  c.rx = axis(SDL_CONTROLLER_AXIS_RIGHTX);
  c.ry = -axis(SDL_CONTROLLER_AXIS_RIGHTY);
  // Some Windows SDL/HID mappings expose Xbox triggers through GameController
  // but leave the stick mappings empty. Fall back to SDL's standard raw Xbox
  // joystick axis order (left X/Y, right X/Y) only when all mapped stick axes
  // are centered; working GameController mappings always take precedence.
  if (joystick && c.lx == 0 && c.ly == 0 && c.rx == 0 && c.ry == 0 && SDL_JoystickNumAxes(joystick) >= 4) {
    auto rawAxis = [joystick](int index) { return SDL_JoystickGetAxis(joystick, index) / 32767.0f; };
    const float lx = rawAxis(0), ly = rawAxis(1), rx = rawAxis(2), ry = rawAxis(3);
    if (lx != 0 || ly != 0 || rx != 0 || ry != 0) {
      c.lx = lx;
      c.ly = -ly;
      c.rx = rx;
      c.ry = -ry;
    }
  }
  c.lt = axis(SDL_CONTROLLER_AXIS_TRIGGERLEFT);
  c.rt = axis(SDL_CONTROLLER_AXIS_TRIGGERRIGHT);
  c.a = SDL_GameControllerGetButton(pad, SDL_CONTROLLER_BUTTON_A) != 0;
  c.b = SDL_GameControllerGetButton(pad, SDL_CONTROLLER_BUTTON_B) != 0;
  for (float* v : {&c.lx, &c.ly, &c.rx, &c.ry}) { if (*v > 1) *v = 1; if (*v < -1) *v = -1; }
  for (float* v : {&c.lt, &c.rt}) { if (*v > 1) *v = 1; if (*v < 0) *v = 0; }
  return c;
}

}  // namespace platform
