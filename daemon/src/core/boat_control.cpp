#include "core/boat_control.hpp"

#include <algorithm>
#include <cmath>

namespace boat {

static float clampf(float v, float lo, float hi) { return std::min(hi, std::max(lo, v)); }

float applyDeadzone(float value) {
  if (std::fabs(value) < DEADZONE) return 0.0f;
  // Rescale so output ramps from 0 at the deadzone edge instead of jumping to 10%.
  const float sign = value > 0 ? 1.0f : -1.0f;
  return (value - sign * DEADZONE) / (1.0f - DEADZONE);
}

Command controllerToCommand(const Controller& c) {
  Command cmd;
  if (!c.connected) return cmd;
  cmd.left = applyDeadzone(c.ly);
  cmd.right = applyDeadzone(c.ry);
  cmd.rudder = clampf(c.rt - c.lt, -1.0f, 1.0f);
  return cmd;
}

int toPwm(float value, int span) {
  return static_cast<int>(std::lround(PWM_NEUTRAL + clampf(value, -1.0f, 1.0f) * static_cast<float>(span)));
}

Pwm commandToPwm(const Command& c, int motorSpan) {
  const int span = std::min(MAX_MOTOR_SPAN, std::max(MIN_MOTOR_SPAN, motorSpan));
  Pwm p;
  p.left = toPwm(c.left, span);
  p.right = toPwm(c.right, span);
  p.rudder = toPwm(c.rudder);
  return p;
}

float ReversePause::apply(float command, uint32_t nowMs) {
  const int direction = command > 0 ? 1 : (command < 0 ? -1 : 0);
  const bool reversing = direction != 0 && lastDirection_ != 0 && direction != lastDirection_;
  if (direction == 0 || reversing) {
    if (!atNeutral_) { atNeutral_ = true; neutralSince_ = nowMs; }
    if (direction == 0 || nowMs - neutralSince_ < REVERSE_PAUSE_MS) return 0.0f;
  }
  atNeutral_ = false;
  lastDirection_ = direction;
  return command;
}

void pwmToChannels(const Pwm& p, uint16_t out[8]) {
  for (int i = 0; i < 8; i++) out[i] = RC_CHANNEL_IGNORE;
  out[0] = static_cast<uint16_t>(p.left);
  out[2] = static_cast<uint16_t>(p.right);
  out[5] = static_cast<uint16_t>(p.rudder);
}

void rudderNeutralChannels(uint16_t out[8]) {
  for (int i = 0; i < 8; i++) out[i] = RC_CHANNEL_IGNORE;
  out[5] = PWM_NEUTRAL;
}

}  // namespace boat
