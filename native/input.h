#pragma once
#include <functional>

// Platform-neutral event delivered from the OS hook to the N-API layer.
struct InputEvent {
  enum Type { MouseMove, MouseDown, MouseUp, Wheel, KeyDown, KeyUp } type;
  int x = 0, y = 0;        // absolute cursor position (screen px)
  int dx = 0, dy = 0;      // relative motion since last move
  int button = 0;          // 1=left, 2=right, 3=middle
  int wheelX = 0, wheelY = 0;
  unsigned int keycode = 0;   // raw OS virtual-key / CGKeyCode
  unsigned int modifiers = 0; // bit0 shift, bit1 ctrl, bit2 alt, bit3 meta
  unsigned int scancode = 0;  // Windows hardware make code (0 elsewhere)
  bool extended = false;      // Windows E0-prefixed key (LLKHF_EXTENDED)
  bool injected = false;      // event was synthesized (LLKHF_INJECTED), not physical
};

using EventCallback = std::function<void(const InputEvent&)>;

// Implemented per-platform (input_win.cc / input_mac.mm).
namespace platform {
bool Start(EventCallback cb);   // install hooks + run message/run loop on a thread
void Stop();                    // remove hooks, stop loop
void SetSuppress(bool on);      // swallow local events while controlling a remote

void InjectMouseMove(int x, int y);
void InjectMouseButton(int button, bool down);
void InjectWheel(int dx, int dy);
// extended: Windows-only "E0 prefix" hint (ignored on macOS). Must be set for
// AltGr/RightCtrl, Numpad Divide/Enter, the Win & Application keys, PrintScreen,
// and the Ins/Del/Home/End/PgUp/PgDn/arrow cluster, or Windows misreads them on
// injection. NOT NumLock (real make code 0x45, no E0) — see keymap_os.js.
void InjectKey(bool down, unsigned int osKeycode, bool extended);
void WarpCursor(int x, int y);
void GetCursorPos(int* x, int* y);
}  // namespace platform
