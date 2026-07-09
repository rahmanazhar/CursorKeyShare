// Windows implementation: low-level mouse & keyboard hooks (WH_MOUSE_LL,
// WH_KEYBOARD_LL) running on a dedicated thread with a message loop, plus
// SendInput for injection.
//
// Suppression: while suppressed we return 1 from the hook (swallowing the event)
// and re-center the physical cursor so we keep getting meaningful deltas — the
// classic software-KVM trick.

#ifdef _WIN32
#include <windows.h>
#include <atomic>
#include <thread>
#include "input.h"

namespace {
EventCallback g_cb;
std::atomic<bool> g_suppress{false};
std::atomic<bool> g_running{false};
HHOOK g_mouseHook = nullptr;
HHOOK g_kbHook = nullptr;
DWORD g_threadId = 0;
std::thread g_thread;

int g_lastX = 0, g_lastY = 0;
bool g_haveLast = false;
int g_centerX = 0, g_centerY = 0;

unsigned int CurrentModifiers() {
  unsigned int m = 0;
  if (GetAsyncKeyState(VK_SHIFT) & 0x8000) m |= 1;
  if (GetAsyncKeyState(VK_CONTROL) & 0x8000) m |= 2;
  if (GetAsyncKeyState(VK_MENU) & 0x8000) m |= 4;
  if ((GetAsyncKeyState(VK_LWIN) & 0x8000) || (GetAsyncKeyState(VK_RWIN) & 0x8000)) m |= 8;
  return m;
}

LRESULT CALLBACK MouseProc(int code, WPARAM wParam, LPARAM lParam) {
  if (code == HC_ACTION && g_cb) {
    auto* p = reinterpret_cast<MSLLHOOKSTRUCT*>(lParam);
    InputEvent ev;
    bool suppress = g_suppress.load();
    switch (wParam) {
      case WM_MOUSEMOVE: {
        // Ignore moves we generated ourselves (warpCursor on enter/return), so
        // they don't register as user movement. Let them through (don't block).
        if (p->flags & LLMHF_INJECTED) break;
        if (suppress) {
          // The cursor is frozen at the park point (g_center*) — set there when
          // suppression began and kept there by blocking every physical move.
          // pt therefore equals park + this move's delta, so report the delta and
          // block. No per-move SetCursorPos => no cursor jitter / "second cursor".
          ev.type = InputEvent::MouseMove;
          ev.dx = p->pt.x - g_centerX;
          ev.dy = p->pt.y - g_centerY;
          ev.x = g_centerX; ev.y = g_centerY;
          g_cb(ev);
          return 1; // swallow; local cursor stays put
        }
        if (!g_haveLast) { g_lastX = p->pt.x; g_lastY = p->pt.y; g_haveLast = true; }
        ev.type = InputEvent::MouseMove;
        ev.dx = p->pt.x - g_lastX;
        ev.dy = p->pt.y - g_lastY;
        ev.x = p->pt.x; ev.y = p->pt.y;
        g_cb(ev);
        g_lastX = p->pt.x; g_lastY = p->pt.y;
        break;
      }
      case WM_LBUTTONDOWN: case WM_LBUTTONUP:
      case WM_RBUTTONDOWN: case WM_RBUTTONUP:
      case WM_MBUTTONDOWN: case WM_MBUTTONUP: {
        bool down = (wParam == WM_LBUTTONDOWN || wParam == WM_RBUTTONDOWN || wParam == WM_MBUTTONDOWN);
        ev.type = down ? InputEvent::MouseDown : InputEvent::MouseUp;
        if (wParam == WM_LBUTTONDOWN || wParam == WM_LBUTTONUP) ev.button = 1;
        else if (wParam == WM_RBUTTONDOWN || wParam == WM_RBUTTONUP) ev.button = 2;
        else ev.button = 3;
        ev.x = p->pt.x; ev.y = p->pt.y;
        g_cb(ev);
        if (suppress) return 1;
        break;
      }
      case WM_MOUSEWHEEL: {
        ev.type = InputEvent::Wheel;
        ev.wheelY = GET_WHEEL_DELTA_WPARAM(p->mouseData) / WHEEL_DELTA;
        g_cb(ev);
        if (suppress) return 1;
        break;
      }
      case WM_MOUSEHWHEEL: {
        ev.type = InputEvent::Wheel;
        ev.wheelX = GET_WHEEL_DELTA_WPARAM(p->mouseData) / WHEEL_DELTA;
        g_cb(ev);
        if (suppress) return 1;
        break;
      }
    }
  }
  return CallNextHookEx(nullptr, code, wParam, lParam);
}

LRESULT CALLBACK KeyboardProc(int code, WPARAM wParam, LPARAM lParam) {
  if (code == HC_ACTION && g_cb) {
    auto* p = reinterpret_cast<KBDLLHOOKSTRUCT*>(lParam);
    bool down = (wParam == WM_KEYDOWN || wParam == WM_SYSKEYDOWN);
    bool up = (wParam == WM_KEYUP || wParam == WM_SYSKEYUP);
    if (down || up) {
      InputEvent ev;
      ev.type = down ? InputEvent::KeyDown : InputEvent::KeyUp;
      ev.keycode = p->vkCode;
      ev.scancode = p->scanCode;
      ev.extended = (p->flags & LLKHF_EXTENDED) != 0;
      ev.injected = (p->flags & LLKHF_INJECTED) != 0;
      ev.modifiers = CurrentModifiers();
      g_cb(ev);
      if (g_suppress.load()) return 1;
    }
  }
  return CallNextHookEx(nullptr, code, wParam, lParam);
}

void ThreadMain() {
  g_threadId = GetCurrentThreadId();
  g_mouseHook = SetWindowsHookEx(WH_MOUSE_LL, MouseProc, GetModuleHandle(nullptr), 0);
  g_kbHook = SetWindowsHookEx(WH_KEYBOARD_LL, KeyboardProc, GetModuleHandle(nullptr), 0);

  MSG msg;
  while (g_running.load() && GetMessage(&msg, nullptr, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessage(&msg);
  }
  if (g_mouseHook) { UnhookWindowsHookEx(g_mouseHook); g_mouseHook = nullptr; }
  if (g_kbHook) { UnhookWindowsHookEx(g_kbHook); g_kbHook = nullptr; }
}
}  // namespace

namespace platform {

bool Start(EventCallback cb) {
  g_cb = std::move(cb);
  g_running = true;
  g_centerX = GetSystemMetrics(SM_CXSCREEN) / 2;
  g_centerY = GetSystemMetrics(SM_CYSCREEN) / 2;
  g_haveLast = false;
  g_thread = std::thread(ThreadMain);
  return true;
}

void Stop() {
  g_running = false;
  if (g_threadId) PostThreadMessage(g_threadId, WM_QUIT, 0, 0);
  if (g_thread.joinable()) g_thread.join();
  g_threadId = 0;
}

void SetSuppress(bool on) {
  if (on) {
    // The caller has already parked the cursor (warpCursor) at the point we
    // should freeze it. Use that as the delta baseline.
    POINT pt; GetCursorPos(&pt);
    g_centerX = pt.x; g_centerY = pt.y;
  } else {
    g_haveLast = false; // re-baseline free-move deltas after returning local
  }
  g_suppress = on;
}

void InjectMouseMove(int x, int y) {
  // Absolute move in virtual-desktop space, normalized to 0..65535.
  int vw = GetSystemMetrics(SM_CXVIRTUALSCREEN);
  int vh = GetSystemMetrics(SM_CYVIRTUALSCREEN);
  int vx = GetSystemMetrics(SM_XVIRTUALSCREEN);
  int vy = GetSystemMetrics(SM_YVIRTUALSCREEN);
  if (vw <= 0) vw = 1; if (vh <= 0) vh = 1;
  INPUT in = {};
  in.type = INPUT_MOUSE;
  in.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
  in.mi.dx = (LONG)(((double)(x - vx) * 65535.0) / vw);
  in.mi.dy = (LONG)(((double)(y - vy) * 65535.0) / vh);
  SendInput(1, &in, sizeof(INPUT));
}

void InjectMouseButton(int button, bool down) {
  INPUT in = {};
  in.type = INPUT_MOUSE;
  if (button == 1) in.mi.dwFlags = down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP;
  else if (button == 2) in.mi.dwFlags = down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP;
  else in.mi.dwFlags = down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP;
  SendInput(1, &in, sizeof(INPUT));
}

void InjectWheel(int dx, int dy) {
  if (dy != 0) {
    INPUT in = {};
    in.type = INPUT_MOUSE;
    in.mi.dwFlags = MOUSEEVENTF_WHEEL;
    in.mi.mouseData = dy * WHEEL_DELTA;
    SendInput(1, &in, sizeof(INPUT));
  }
  if (dx != 0) {
    INPUT in = {};
    in.type = INPUT_MOUSE;
    in.mi.dwFlags = MOUSEEVENTF_HWHEEL;
    in.mi.mouseData = dx * WHEEL_DELTA;
    SendInput(1, &in, sizeof(INPUT));
  }
}

void InjectKey(bool down, unsigned int osKeycode, bool extended) {
  INPUT in = {};
  in.type = INPUT_KEYBOARD;

  // Numpad DIGITS (VK_NUMPAD0-9 = 0x60-0x69) and the numpad DECIMAL (VK_DECIMAL
  // = 0x6E) are the only keys whose hardware scancode is dual-function: with the
  // target's NumLock OFF, make codes 0x47/0x48/... resolve to Home/Up/... instead
  // of 7/8/... We inject THESE by virtual-key, because VK_NUMPADn always yields
  // the digit regardless of the target's NumLock state — which is what a KVM user
  // typing numbers wants. That sidesteps the NumLock-sync machinery Synergy/Barrier
  // need (and the numpad-acts-as-navigation bugs that plague them). The tradeoff:
  // VK injection carries a zero scancode, so these specific keys are invisible to
  // pure scancode/DirectInput consumers — acceptable, since numpad-as-movement in
  // games is the navigation semantics anyway, and typing digits is the target use.
  bool numpadDualFn = (osKeycode >= 0x60 && osKeycode <= 0x69) || osKeycode == 0x6E;

  // Everything else goes by SCANCODE. VK injection leaves wScan=0, so consumers
  // that read the hardware make code (Chromium/Electron KeyboardEvent.code,
  // RawInput/DirectInput, SDL, many terminals) receive nothing identifiable —
  // the root cause of "alternative keys don't work in some apps." Supplying the
  // real make code (+ E0 for extended keys) makes injected keys look physical.
  WORD scan;
  if (numpadDualFn) {
    scan = 0;
  } else if (osKeycode == 0x2C) {
    // VK_SNAPSHOT: MapVirtualKey returns 0x54 (the Alt+PrtSc "SysRq" make code),
    // not PrintScreen's real 0x37. Override so it injects as E0 37.
    scan = 0x37;
  } else {
    scan = (WORD)MapVirtualKey((UINT)osKeycode, MAPVK_VK_TO_VSC);
  }

  if (scan == 0) {
    // Numpad dual-function keys (by design) or keys with no scancode mapping:
    // fall back to virtual-key injection so the key still fires.
    in.ki.wVk = (WORD)osKeycode;
    in.ki.dwFlags = (down ? 0 : KEYEVENTF_KEYUP) | (extended ? KEYEVENTF_EXTENDEDKEY : 0);
  } else {
    in.ki.wVk = 0;  // scancode-driven: wVk must be zero
    in.ki.wScan = scan;
    // KEYEVENTF_SCANCODE must ride on the KEYUP too — dropping it on release is
    // the classic stuck-key bug. E0 comes solely from the caller's extended flag
    // (a corrected allow-list), never from MapVirtualKey's reverse-map artifacts.
    in.ki.dwFlags = KEYEVENTF_SCANCODE | (down ? 0 : KEYEVENTF_KEYUP) |
                    (extended ? KEYEVENTF_EXTENDEDKEY : 0);
  }
  SendInput(1, &in, sizeof(INPUT));
}

void WarpCursor(int x, int y) { SetCursorPos(x, y); }

void GetCursorPos(int* x, int* y) {
  POINT pt; ::GetCursorPos(&pt); *x = pt.x; *y = pt.y;
}

}  // namespace platform
#endif  // _WIN32
