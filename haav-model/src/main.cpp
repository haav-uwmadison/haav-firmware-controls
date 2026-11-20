#include <Arduino.h>
#include <XboxSeriesXControllerESP32_asukiaaa.hpp>
#include <common/mavlink.h>

XboxSeriesXControllerESP32_asukiaaa::Core xboxController("0c:35:26:fd:09:85");

const int RADIO_RX_PIN = D6;
const int RADIO_TX_PIN = D7;
const long RADIO_BAUD = 57600;

const uint8_t MY_SYSID = 255;
const uint8_t MY_COMPID = MAV_COMP_ID_MISSIONPLANNER;
const uint8_t TARGET_SYSID = 1;
const uint8_t TARGET_COMPID = MAV_COMP_ID_AUTOPILOT1;

const uint32_t ROVER_MODE_MANUAL = 0;
const float DEADZONE = 0.1f;
// How long a motor sits at neutral when switching direction; the ESCs won't reverse without it.
const unsigned long REVERSE_PAUSE_MS = 500;

bool vehicleArmed = false;
unsigned long lastVehicleHeartbeatAt = 0;
unsigned long rxBytes = 0, rxPackets = 0;

void sendMessage(const mavlink_message_t &msg) {
  uint8_t buf[MAVLINK_MAX_PACKET_LEN];
  Serial1.write(buf, mavlink_msg_to_send_buffer(buf, &msg));
}

void sendHeartbeat() {
  mavlink_message_t msg;
  mavlink_msg_heartbeat_pack(MY_SYSID, MY_COMPID, &msg, MAV_TYPE_GCS, MAV_AUTOPILOT_INVALID, 0, 0, MAV_STATE_ACTIVE);
  sendMessage(msg);
}

void sendCommand(uint16_t command, float param1, float param2 = 0) {
  mavlink_message_t msg;
  mavlink_msg_command_long_pack(MY_SYSID, MY_COMPID, &msg, TARGET_SYSID, TARGET_COMPID,
                                command, 0, param1, param2, 0, 0, 0, 0, 0);
  sendMessage(msg);
}

// RC1 = left motor, RC3 = right motor (the Pixhawk's "two paddles" input), RC6 = rudder.
// UINT16_MAX leaves a channel alone.
void sendRcOverride(uint16_t leftMotor, uint16_t rightMotor, uint16_t rudder) {
  const uint16_t SKIP = UINT16_MAX;
  mavlink_message_t msg;
  mavlink_msg_rc_channels_override_pack(MY_SYSID, MY_COMPID, &msg, TARGET_SYSID, TARGET_COMPID,
                                        leftMotor, SKIP, rightMotor, SKIP, SKIP, rudder, SKIP, SKIP,
                                        0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
  sendMessage(msg);
}

void readRadio() {
  mavlink_message_t msg;
  mavlink_status_t status;
  while (Serial1.available()) {
    rxBytes++;
    if (!mavlink_parse_char(MAVLINK_COMM_0, Serial1.read(), &msg, &status)) {
      continue;
    }
    rxPackets++;
    if (msg.sysid != TARGET_SYSID) {
      continue;
    }
    if (msg.msgid == MAVLINK_MSG_ID_HEARTBEAT && msg.compid == TARGET_COMPID) {
      lastVehicleHeartbeatAt = millis();
      vehicleArmed = mavlink_msg_heartbeat_get_base_mode(&msg) & MAV_MODE_FLAG_SAFETY_ARMED;
    } else if (msg.msgid == MAVLINK_MSG_ID_STATUSTEXT) {
      char text[MAVLINK_MSG_STATUSTEXT_FIELD_TEXT_LEN + 1] = {};
      mavlink_msg_statustext_get_text(&msg, text);
      Serial.printf("PIXHAWK: %s\n", text);
    } else if (msg.msgid == MAVLINK_MSG_ID_COMMAND_ACK) {
      Serial.printf("ACK: command %u result %u\n", mavlink_msg_command_ack_get_command(&msg),
                    mavlink_msg_command_ack_get_result(&msg));
    }
  }
}

float readStick(uint16_t raw) {
  const float center = XboxControllerNotificationParser::maxJoy / 2.0f;
  float value = (raw - center) / center;
  if (fabs(value) < DEADZONE) {
    return 0;
  }
  // Rescale so the motor ramps up from 0 at the deadzone edge instead of jumping to 10%.
  return (value - copysignf(DEADZONE, value)) / (1 - DEADZONE);
}

struct Motor {
  int lastDirection = 0;          // direction of the last non-neutral command: -1 or +1
  unsigned long neutralSince = 0;  // when the motor went to neutral; 0 while it is running
};

// The ESCs only change direction after sitting at neutral, so a reversal holds the motor
// at 0 until it has been neutral for REVERSE_PAUSE_MS.
float applyReversePause(float command, Motor &motor, unsigned long now) {
  int direction = (command > 0) - (command < 0);
  bool reversing = direction != 0 && motor.lastDirection != 0 && direction != motor.lastDirection;
  if (direction == 0 || reversing) {
    if (motor.neutralSince == 0) {
      motor.neutralSince = now;
    }
    if (direction == 0 || now - motor.neutralSince < REVERSE_PAUSE_MS) {
      return 0;
    }
  }
  motor.neutralSince = 0;
  motor.lastDirection = direction;
  return command;
}

uint16_t toPwm(float value) {
  return 1500 + constrain(value, -1.0f, 1.0f) * 500;
}

void setup() {
  Serial.begin(115200);
  Serial1.begin(RADIO_BAUD, SERIAL_8N1, RADIO_RX_PIN, RADIO_TX_PIN);
  xboxController.begin();
}

void loop() {
  xboxController.onLoop();
  if (xboxController.getCountFailedConnection() > 2) {
    ESP.restart();
  }
  readRadio();

  bool connected = xboxController.isConnected() && !xboxController.isWaitingForFirstNotification();
  auto &n = xboxController.xboxNotif;
  unsigned long now = millis();

  static bool lastA = false, lastB = false;
  bool a = connected && n.btnA;
  bool b = connected && n.btnB;
  if (a && !lastA) {
    Serial.println("A pressed: sending MANUAL + arm");
    sendCommand(MAV_CMD_DO_SET_MODE, MAV_MODE_FLAG_CUSTOM_MODE_ENABLED, ROVER_MODE_MANUAL);
    sendCommand(MAV_CMD_COMPONENT_ARM_DISARM, 1);
  }
  if (b && !lastB) {
    Serial.println("B pressed: sending disarm");
    sendCommand(MAV_CMD_COMPONENT_ARM_DISARM, 0);
  }
  lastA = a;
  lastB = b;

  // Tank-style: each stick's vertical axis drives its own motor (stick up reads low, hence
  // the minus). Right trigger swings the rudder right, left trigger left.
  float leftCommand = 0, rightCommand = 0, rudderCommand = 0;
  if (connected) {
    leftCommand = -readStick(n.joyLVert);
    rightCommand = -readStick(n.joyRVert);
    rudderCommand = (float(n.trigRT) - n.trigLT) / XboxControllerNotificationParser::maxTrig;
  }
  static Motor leftMotor, rightMotor;
  uint16_t leftPwm = toPwm(applyReversePause(leftCommand, leftMotor, now));
  uint16_t rightPwm = toPwm(applyReversePause(rightCommand, rightMotor, now));
  uint16_t rudderPwm = toPwm(rudderCommand);

  static unsigned long lastHeartbeatAt = 0, lastOverrideAt = 0, lastLogAt = 0;
  if (now - lastHeartbeatAt >= 1000) {
    lastHeartbeatAt = now;
    sendHeartbeat();
    if (!connected) {
      sendCommand(MAV_CMD_COMPONENT_ARM_DISARM, 0);
    }
  }
  if (now - lastOverrideAt >= 50) {
    lastOverrideAt = now;
    sendRcOverride(leftPwm, rightPwm, rudderPwm);
  }
  if (now - lastLogAt >= 200) {
    lastLogAt = now;
    bool linked = lastVehicleHeartbeatAt && now - lastVehicleHeartbeatAt < 3000;
    Serial.printf("ctrl %-3s | link %-3s | rx %lu B %lu pkt | %-8s | left %4u right %4u rudder %4u\n",
                  connected ? "ok" : "--", linked ? "ok" : "--", rxBytes, rxPackets,
                  vehicleArmed ? "ARMED" : "disarmed", leftPwm, rightPwm, rudderPwm);
  }

  delay(10);
}
