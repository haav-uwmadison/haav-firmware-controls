// Controller -> boat command -> PWM. Portable C++17, no OS dependencies, so the same code can run in
// the laptop daemon and on the ESP32. Mirrors web-control/lib/boat-control.ts and haav-model/src/main.cpp:
//   RC1 = left stick vertical  -> left motor  (OUT 1)
//   RC3 = right stick vertical -> right motor (OUT 2)
//   RC6 = right trigger minus left trigger -> rudder (OUT 3)
#pragma once
#include <cstdint>

namespace boat {

constexpr float DEADZONE = 0.1f;
constexpr uint32_t REVERSE_PAUSE_MS = 500;   // ESCs only reverse after sitting at neutral this long
constexpr int PWM_NEUTRAL = 1500;
constexpr int PWM_SPAN = 500;                // full stick = 1500 +- 500 us
constexpr int DEFAULT_MOTOR_SPAN = 250;      // 1250..1750, the SERVO1/2_MIN/MAX travel in haav-esp32.params
constexpr int MIN_MOTOR_SPAN = 0;
constexpr int MAX_MOTOR_SPAN = PWM_SPAN;
constexpr uint16_t RC_CHANNEL_IGNORE = 0xFFFF;

/** One controller sample. Sticks are -1..1 with forward = +1; triggers 0..1. */
struct Controller {
  bool connected = false;
  float lx = 0, ly = 0, rx = 0, ry = 0;
  float lt = 0, rt = 0;
  bool a = false, b = false;
};

struct Command { float left = 0, right = 0, rudder = 0; };   // each -1..1
struct Pwm { int left = PWM_NEUTRAL, right = PWM_NEUTRAL, rudder = PWM_NEUTRAL; };
/** Per-motor direction flip, for a thruster wired or mounted the other way round. */
struct MotorReverse { bool left = false, right = false; };

float applyDeadzone(float value);
Command controllerToCommand(const Controller& c);
/** Flips the sign of each reversed motor so stick forward sends that motor's PWM below neutral. */
Command applyMotorReverse(const Command& c, const MotorReverse& reverse);
int toPwm(float value, int span = PWM_SPAN);
/** Motors scale to 1500 +- motorSpan so full stick maps to the limit; the rudder always uses the full range. */
Pwm commandToPwm(const Command& c, int motorSpan = PWM_SPAN);

/** Holds a motor at neutral for REVERSE_PAUSE_MS when its direction flips. One per motor. */
class ReversePause {
 public:
  float apply(float command, uint32_t nowMs);
 private:
  int lastDirection_ = 0;
  uint32_t neutralSince_ = 0;
  bool atNeutral_ = false;
};

/** RC1..RC8 for RC_CHANNELS_OVERRIDE; channels we do not drive are left alone. */
void pwmToChannels(const Pwm& p, uint16_t out[8]);
/** Only the rudder at centre; every other channel left alone (used while disarmed). */
void rudderNeutralChannels(uint16_t out[8]);

}  // namespace boat
