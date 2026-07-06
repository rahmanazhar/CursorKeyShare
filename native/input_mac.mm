// macOS implementation: a CGEventTap (session level) running on a dedicated
// thread's run loop, plus CGEvent* for injection.
//
// Suppression: returning NULL from the tap callback swallows the event. Mouse
// deltas come from kCGMouseEventDeltaX/Y, which are valid even when the cursor is
// frozen, so we don't need the re-centering trick used on Windows.
//
// Requires the user to grant Accessibility AND Input Monitoring permission. An
// ACTIVE (event-consuming) tap can only be created once the process is
// Accessibility-trusted, so Start() prompts for trust and reports back whether
// the tap was actually installed (instead of silently doing nothing).
//
// Injected events are tagged via a dedicated CGEventSource so our own tap can
// recognize and ignore them — without this, events we post would be re-observed
// by our session tap and cause a feedback loop / double input.

#ifdef __APPLE__
#import <ApplicationServices/ApplicationServices.h>
#import <CoreGraphics/CoreGraphics.h>
#import <CoreFoundation/CoreFoundation.h>
#import <IOKit/hidsystem/IOLLEvent.h>  // NX_DEVICE*KEYMASK per-side modifier bits
#include <dlfcn.h>
#include <atomic>
#include <cstdint>
#include <future>
#include <thread>
#include "input.h"

namespace {
// Marks events we inject so the tap callback can ignore them.
static const int64_t CKS_SENTINEL = 0x434B53;  // 'CKS'

EventCallback g_cb;
std::atomic<bool> g_suppress{false};
std::atomic<bool> g_running{false};
std::thread g_thread;
CFMachPortRef g_tap = nullptr;
CFRunLoopRef g_runLoop = nullptr;
CFRunLoopSourceRef g_source = nullptr;
CGEventSourceRef g_src = nullptr;  // tagged source for injected events

unsigned int ModsFromFlags(CGEventFlags f) {
  unsigned int m = 0;
  if (f & kCGEventFlagMaskShift) m |= 1;
  if (f & kCGEventFlagMaskControl) m |= 2;
  if (f & kCGEventFlagMaskAlternate) m |= 4;
  if (f & kCGEventFlagMaskCommand) m |= 8;
  return m;
}

// Modifier keys on macOS never produce kCGEventKeyDown/KeyUp — only
// kCGEventFlagsChanged. To forward them like normal keys we map the keycode of
// the changed modifier to its DEVICE-side flag bit (from IOLLEvent.h), whose
// presence tells us down vs up. The device bits distinguish left/right keys,
// which the generic kCGEventFlagMask* bits (shared by both sides) cannot.
uint64_t DeviceBitForModifierKeycode(unsigned int keycode) {
  switch (keycode) {
    case 59: return NX_DEVICELCTLKEYMASK;    // kVK_Control
    case 62: return NX_DEVICERCTLKEYMASK;    // kVK_RightControl
    case 56: return NX_DEVICELSHIFTKEYMASK;  // kVK_Shift
    case 60: return NX_DEVICERSHIFTKEYMASK;  // kVK_RightShift
    case 58: return NX_DEVICELALTKEYMASK;    // kVK_Option
    case 61: return NX_DEVICERALTKEYMASK;    // kVK_RightOption
    case 55: return NX_DEVICELCMDKEYMASK;    // kVK_Command
    case 54: return NX_DEVICERCMDKEYMASK;    // kVK_RightCommand
    default: return 0;  // CapsLock / Fn etc.: leave to the OS untouched
  }
}

CGEventRef TapCallback(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void* refcon) {
  if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
    if (g_tap) CGEventTapEnable(g_tap, true);
    return event;
  }
  // Ignore events we injected ourselves (prevents a feedback loop).
  if (CGEventGetIntegerValueField(event, kCGEventSourceUserData) == CKS_SENTINEL) {
    return event;
  }
  if (!g_cb) return event;

  InputEvent ev;
  bool suppress = g_suppress.load();
  bool handled = false;

  switch (type) {
    case kCGEventMouseMoved:
    case kCGEventLeftMouseDragged:
    case kCGEventRightMouseDragged:
    case kCGEventOtherMouseDragged: {
      ev.type = InputEvent::MouseMove;
      ev.dx = (int)CGEventGetIntegerValueField(event, kCGMouseEventDeltaX);
      ev.dy = (int)CGEventGetIntegerValueField(event, kCGMouseEventDeltaY);
      CGPoint p = CGEventGetLocation(event);
      ev.x = (int)p.x; ev.y = (int)p.y;
      g_cb(ev); handled = true;
      break;
    }
    case kCGEventLeftMouseDown: case kCGEventLeftMouseUp:
    case kCGEventRightMouseDown: case kCGEventRightMouseUp:
    case kCGEventOtherMouseDown: case kCGEventOtherMouseUp: {
      bool down = (type == kCGEventLeftMouseDown || type == kCGEventRightMouseDown || type == kCGEventOtherMouseDown);
      ev.type = down ? InputEvent::MouseDown : InputEvent::MouseUp;
      if (type == kCGEventLeftMouseDown || type == kCGEventLeftMouseUp) ev.button = 1;
      else if (type == kCGEventRightMouseDown || type == kCGEventRightMouseUp) ev.button = 2;
      else ev.button = 3;
      CGPoint p = CGEventGetLocation(event);
      ev.x = (int)p.x; ev.y = (int)p.y;
      g_cb(ev); handled = true;
      break;
    }
    case kCGEventScrollWheel: {
      ev.type = InputEvent::Wheel;
      ev.wheelY = (int)CGEventGetIntegerValueField(event, kCGScrollWheelEventDeltaAxis1);
      ev.wheelX = (int)CGEventGetIntegerValueField(event, kCGScrollWheelEventDeltaAxis2);
      g_cb(ev); handled = true;
      break;
    }
    case kCGEventKeyDown: case kCGEventKeyUp: {
      ev.type = (type == kCGEventKeyDown) ? InputEvent::KeyDown : InputEvent::KeyUp;
      ev.keycode = (unsigned int)CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
      ev.modifiers = ModsFromFlags(CGEventGetFlags(event));
      g_cb(ev); handled = true;
      break;
    }
    case kCGEventFlagsChanged: {
      // A modifier key went down or up. Which key: the event's keycode field.
      // Down or up: whether that key's device-side bit is set in the new flags.
      unsigned int keycode = (unsigned int)CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode);
      uint64_t bit = DeviceBitForModifierKeycode(keycode);
      if (bit == 0) break;  // CapsLock/Fn — pass through, never suppress
      CGEventFlags flags = CGEventGetFlags(event);
      ev.type = (flags & bit) ? InputEvent::KeyDown : InputEvent::KeyUp;
      ev.keycode = keycode;
      ev.modifiers = ModsFromFlags(flags);
      g_cb(ev); handled = true;
      break;
    }
    default: break;
  }

  if (handled && suppress) return nullptr;  // swallow
  return event;
}

void ThreadMain(std::promise<bool>* ready) {
  CGEventMask mask =
      CGEventMaskBit(kCGEventMouseMoved) | CGEventMaskBit(kCGEventLeftMouseDragged) |
      CGEventMaskBit(kCGEventRightMouseDragged) | CGEventMaskBit(kCGEventOtherMouseDragged) |
      CGEventMaskBit(kCGEventLeftMouseDown) | CGEventMaskBit(kCGEventLeftMouseUp) |
      CGEventMaskBit(kCGEventRightMouseDown) | CGEventMaskBit(kCGEventRightMouseUp) |
      CGEventMaskBit(kCGEventOtherMouseDown) | CGEventMaskBit(kCGEventOtherMouseUp) |
      CGEventMaskBit(kCGEventScrollWheel) | CGEventMaskBit(kCGEventKeyDown) |
      CGEventMaskBit(kCGEventKeyUp) | CGEventMaskBit(kCGEventFlagsChanged);

  g_tap = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap,
                           kCGEventTapOptionDefault, mask, TapCallback, nullptr);
  if (!g_tap) {
    // Missing Accessibility/Input-Monitoring permission, almost always.
    g_running = false;
    ready->set_value(false);
    return;
  }
  g_runLoop = CFRunLoopGetCurrent();
  g_source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, g_tap, 0);
  CFRunLoopAddSource(g_runLoop, g_source, kCFRunLoopCommonModes);
  CGEventTapEnable(g_tap, true);
  ready->set_value(true);  // tap installed successfully
  CFRunLoopRun();
}
}  // namespace

namespace platform {

bool IsTrusted(bool prompt) {
  // Pure CoreFoundation (no Foundation link needed): build { kAXTrustedCheckOptionPrompt: bool }.
  const void* keys[] = { kAXTrustedCheckOptionPrompt };
  const void* vals[] = { prompt ? kCFBooleanTrue : kCFBooleanFalse };
  CFDictionaryRef opts = CFDictionaryCreate(NULL, keys, vals, 1,
                                            &kCFTypeDictionaryKeyCallBacks,
                                            &kCFTypeDictionaryValueCallBacks);
  bool trusted = AXIsProcessTrustedWithOptions(opts);
  CFRelease(opts);
  return trusted;
}

bool Start(EventCallback cb) {
  if (g_running) return true;
  g_cb = std::move(cb);
  g_running = true;

  // Prompt for Accessibility if needed — an active tap requires trust.
  IsTrusted(true);

  // Source used for injection, tagged so our own events are ignored by the tap.
  if (!g_src) {
    g_src = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
    if (g_src) CGEventSourceSetUserData(g_src, CKS_SENTINEL);
  }

  std::promise<bool> ready;
  std::future<bool> fut = ready.get_future();
  g_thread = std::thread([&ready]() { ThreadMain(&ready); });
  bool ok = fut.get();  // block until the tap is actually created (or fails)
  if (!ok) {
    if (g_thread.joinable()) g_thread.join();
    // Clean up state on the trust-denied / failure path.
    if (g_src) { CFRelease(g_src); g_src = nullptr; }
    g_cb = nullptr;
  }
  return ok;
}

void Stop() {
  g_running = false;
  if (g_runLoop) CFRunLoopStop(g_runLoop);
  if (g_thread.joinable()) g_thread.join();
  if (g_source) { CFRelease(g_source); g_source = nullptr; }
  if (g_tap) { CFRelease(g_tap); g_tap = nullptr; }
  if (g_src) { CFRelease(g_src); g_src = nullptr; }
  g_runLoop = nullptr;
}

void SetSuppress(bool on) { g_suppress = on; }

void InjectMouseMove(int x, int y) {
  CGEventRef e = CGEventCreateMouseEvent(g_src, kCGEventMouseMoved,
                                         CGPointMake(x, y), kCGMouseButtonLeft);
  CGEventPost(kCGHIDEventTap, e);
  CFRelease(e);
}

void InjectMouseButton(int button, bool down) {
  CGMouseButton b = kCGMouseButtonLeft;
  CGEventType t;
  if (button == 1) t = down ? kCGEventLeftMouseDown : kCGEventLeftMouseUp;
  else if (button == 2) { b = kCGMouseButtonRight; t = down ? kCGEventRightMouseDown : kCGEventRightMouseUp; }
  else { b = kCGMouseButtonCenter; t = down ? kCGEventOtherMouseDown : kCGEventOtherMouseUp; }
  CGEventRef cur = CGEventCreate(nullptr);
  CGPoint p = CGEventGetLocation(cur);
  CFRelease(cur);
  CGEventRef e = CGEventCreateMouseEvent(g_src, t, p, b);
  CGEventPost(kCGHIDEventTap, e);
  CFRelease(e);
}

void InjectWheel(int dx, int dy) {
  CGEventRef e = CGEventCreateScrollWheelEvent(g_src, kCGScrollEventUnitLine, 2, dy, dx);
  CGEventPost(kCGHIDEventTap, e);
  CFRelease(e);
}

void InjectKey(bool down, unsigned int osKeycode) {
  CGEventRef e = CGEventCreateKeyboardEvent(g_src, (CGKeyCode)osKeycode, down);
  CGEventPost(kCGHIDEventTap, e);
  CFRelease(e);
}

void WarpCursor(int x, int y) {
  CGWarpMouseCursorPosition(CGPointMake(x, y));
  CGAssociateMouseAndMouseCursorPosition(true);
}

// CGDisplayHideCursor only affects the cursor when the calling app is
// frontmost — useless for a background KVM. The private (but ~15-years-stable,
// used by Synergy/Barrier/Deskflow) "SetsCursorInBackground" connection
// property lifts that restriction. Resolved via dlsym at CALL time, not linked
// at load time: if Apple ever drops these exports, the failure must be "cursor
// no longer hides", not "the whole addon fails to require() and the app
// silently loses the native backend".
typedef int CGSConnectionID;
typedef CGSConnectionID (*CGSDefaultConnectionFn)(void);
typedef CGError (*CGSSetConnectionPropertyFn)(CGSConnectionID, CGSConnectionID,
                                              CFStringRef, CFTypeRef);

static std::atomic<bool> g_cursorHidden{false};

void SetCursorVisible(bool visible) {
  if (visible == !g_cursorHidden.load()) return;  // keep hide/show balanced
  static CGSDefaultConnectionFn defaultConn =
      (CGSDefaultConnectionFn)dlsym(RTLD_DEFAULT, "_CGSDefaultConnection");
  static CGSSetConnectionPropertyFn setProp =
      (CGSSetConnectionPropertyFn)dlsym(RTLD_DEFAULT, "CGSSetConnectionProperty");
  if (defaultConn && setProp) {
    setProp(defaultConn(), defaultConn(), CFSTR("SetsCursorInBackground"), kCFBooleanTrue);
  }
  // Without the CGS property this still works while the app is frontmost.
  if (visible) {
    CGDisplayShowCursor(kCGDirectMainDisplay);
    g_cursorHidden = false;
  } else {
    CGDisplayHideCursor(kCGDirectMainDisplay);
    g_cursorHidden = true;
  }
  CGAssociateMouseAndMouseCursorPosition(true);
}

void GetCursorPos(int* x, int* y) {
  CGEventRef e = CGEventCreate(nullptr);
  CGPoint p = CGEventGetLocation(e);
  CFRelease(e);
  *x = (int)p.x; *y = (int)p.y;
}

}  // namespace platform
#endif  // __APPLE__
