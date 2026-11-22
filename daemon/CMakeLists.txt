cmake_minimum_required(VERSION 3.21)
project(mission_daemon LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

include(FetchContent)
set(FETCHCONTENT_QUIET OFF)
if(POLICY CMP0135)
  cmake_policy(SET CMP0135 NEW)
endif()

# MAVLink headers: the same library the ESP32 firmware in ../haav-model uses.
FetchContent_Declare(mavlink
  GIT_REPOSITORY https://github.com/mavlink/c_library_v2.git
  GIT_TAG        master
  GIT_SHALLOW    TRUE)
FetchContent_MakeAvailable(mavlink)   # header-only, no CMakeLists: this only downloads it

# JSON for the WebSocket protocol.
FetchContent_Declare(json
  URL https://github.com/nlohmann/json/releases/download/v3.11.3/json.tar.xz)
FetchContent_MakeAvailable(json)

# WebSocket server (no TLS: the daemon only listens on 127.0.0.1).
set(USE_TLS OFF CACHE BOOL "" FORCE)
set(USE_ZLIB OFF CACHE BOOL "" FORCE)
set(IXWEBSOCKET_INSTALL OFF CACHE BOOL "" FORCE)
FetchContent_Declare(ixwebsocket
  GIT_REPOSITORY https://github.com/machinezone/IXWebSocket.git
  GIT_TAG        v11.4.5
  GIT_SHALLOW    TRUE)
FetchContent_MakeAvailable(ixwebsocket)

# SDL2 for the Xbox controller. Uses the system copy when present (brew install sdl2),
# otherwise builds it from source so Windows users need nothing beyond CMake and a compiler.
find_package(SDL2 CONFIG QUIET)
if(NOT SDL2_FOUND)
  message(STATUS "SDL2 not found on the system; fetching and building it")
  set(SDL_SHARED OFF CACHE BOOL "" FORCE)
  set(SDL_STATIC ON CACHE BOOL "" FORCE)
  set(SDL_TEST OFF CACHE BOOL "" FORCE)
  set(SDL2_DISABLE_INSTALL ON CACHE BOOL "" FORCE)
  FetchContent_Declare(SDL2
    GIT_REPOSITORY https://github.com/libsdl-org/SDL.git
    GIT_TAG        release-2.30.9
    GIT_SHALLOW    TRUE)
  FetchContent_MakeAvailable(SDL2)
endif()

add_executable(mission_daemon
  src/core/boat_control.cpp
  src/core/mission.cpp
  src/platform/serial.cpp
  src/platform/gamepad_sdl.cpp
  src/platform/ws_server.cpp
  src/platform/sim_vehicle.cpp
  src/main.cpp)

target_include_directories(mission_daemon PRIVATE src ${mavlink_SOURCE_DIR})
target_compile_definitions(mission_daemon PRIVATE MAVLINK_NO_CONVERSION_HELPERS)
target_link_libraries(mission_daemon PRIVATE nlohmann_json::nlohmann_json ixwebsocket::ixwebsocket)

if(TARGET SDL2::SDL2-static)
  target_link_libraries(mission_daemon PRIVATE SDL2::SDL2-static)
elseif(TARGET SDL2::SDL2)
  target_link_libraries(mission_daemon PRIVATE SDL2::SDL2)
else()
  target_include_directories(mission_daemon PRIVATE ${SDL2_INCLUDE_DIRS})
  target_link_libraries(mission_daemon PRIVATE ${SDL2_LIBRARIES})
endif()

if(MSVC)
  target_compile_options(mission_daemon PRIVATE /W3 /utf-8)
  target_compile_definitions(mission_daemon PRIVATE _CRT_SECURE_NO_WARNINGS NOMINMAX WIN32_LEAN_AND_MEAN)
  target_link_libraries(mission_daemon PRIVATE ws2_32 setupapi)
else()
  target_compile_options(mission_daemon PRIVATE -Wall -Wextra -Wno-address-of-packed-member -Wno-unused-parameter)
endif()
if(APPLE)
  target_link_libraries(mission_daemon PRIVATE "-framework IOKit" "-framework CoreFoundation")
endif()
