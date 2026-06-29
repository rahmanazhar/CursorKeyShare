// N-API glue. Exposes the platform input layer to JavaScript and bridges OS hook
// callbacks (which fire on a dedicated OS thread) to the JS thread via a
// ThreadSafeFunction.

#include <napi.h>
#include <atomic>
#include <memory>
#include "input.h"

namespace {

Napi::ThreadSafeFunction g_tsfn;
// Read on the OS hook thread, written on the JS thread.
std::atomic<bool> g_running{false};

// Called on the OS hook thread. Marshal the event onto the JS thread.
void OnEvent(const InputEvent& ev) {
  if (!g_running) return;
  auto* copy = new InputEvent(ev);
  napi_status status = g_tsfn.BlockingCall(copy, [](Napi::Env env, Napi::Function jsCb, InputEvent* e) {
    std::unique_ptr<InputEvent> guard(e);
    Napi::Object o = Napi::Object::New(env);
    const char* type = "mousemove";
    switch (e->type) {
      case InputEvent::MouseMove: type = "mousemove"; break;
      case InputEvent::MouseDown: type = "mousedown"; break;
      case InputEvent::MouseUp:   type = "mouseup";   break;
      case InputEvent::Wheel:     type = "wheel";     break;
      case InputEvent::KeyDown:   type = "keydown";   break;
      case InputEvent::KeyUp:     type = "keyup";     break;
    }
    o.Set("type", Napi::String::New(env, type));
    o.Set("x", Napi::Number::New(env, e->x));
    o.Set("y", Napi::Number::New(env, e->y));
    o.Set("dx", Napi::Number::New(env, e->dx));
    o.Set("dy", Napi::Number::New(env, e->dy));
    o.Set("button", Napi::Number::New(env, e->button));
    // For wheel events the JS layer reads dx/dy; mirror the wheel axes onto them.
    o.Set("dx", Napi::Number::New(env, e->type == InputEvent::Wheel ? e->wheelX : e->dx));
    o.Set("dy", Napi::Number::New(env, e->type == InputEvent::Wheel ? e->wheelY : e->dy));
    o.Set("keycode", Napi::Number::New(env, e->keycode));
    o.Set("modifiers", Napi::Number::New(env, e->modifiers));
    jsCb.Call({o});
  });
  if (status != napi_ok) {
    delete copy;
  }
}

Napi::Value StartCapture(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (g_running) return env.Undefined();
  if (info.Length() < 1 || !info[0].IsFunction()) {
    Napi::TypeError::New(env, "callback required").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  g_tsfn = Napi::ThreadSafeFunction::New(env, info[0].As<Napi::Function>(),
                                         "cks-input", 0, 1);
  g_running = true;
  if (!platform::Start(OnEvent)) {
    g_running = false;
    g_tsfn.Release();
    Napi::Error::New(env, "failed to start capture").ThrowAsJavaScriptException();
  }
  return env.Undefined();
}

Napi::Value StopCapture(const Napi::CallbackInfo& info) {
  if (g_running) {
    g_running = false;
    platform::Stop();
    g_tsfn.Release();
  }
  return info.Env().Undefined();
}

Napi::Value SetSuppress(const Napi::CallbackInfo& info) {
  platform::SetSuppress(info.Length() > 0 && info[0].ToBoolean().Value());
  return info.Env().Undefined();
}

Napi::Value InjectMouseMove(const Napi::CallbackInfo& info) {
  platform::InjectMouseMove(info[0].As<Napi::Number>().Int32Value(),
                            info[1].As<Napi::Number>().Int32Value());
  return info.Env().Undefined();
}

Napi::Value InjectMouseButton(const Napi::CallbackInfo& info) {
  platform::InjectMouseButton(info[0].As<Napi::Number>().Int32Value(),
                              info[1].ToBoolean().Value());
  return info.Env().Undefined();
}

Napi::Value InjectWheel(const Napi::CallbackInfo& info) {
  platform::InjectWheel(info[0].As<Napi::Number>().Int32Value(),
                        info[1].As<Napi::Number>().Int32Value());
  return info.Env().Undefined();
}

Napi::Value InjectKey(const Napi::CallbackInfo& info) {
  platform::InjectKey(info[0].ToBoolean().Value(),
                      info[1].As<Napi::Number>().Uint32Value());
  return info.Env().Undefined();
}

Napi::Value WarpCursor(const Napi::CallbackInfo& info) {
  platform::WarpCursor(info[0].As<Napi::Number>().Int32Value(),
                       info[1].As<Napi::Number>().Int32Value());
  return info.Env().Undefined();
}

Napi::Value GetCursorPos(const Napi::CallbackInfo& info) {
  int x = 0, y = 0;
  platform::GetCursorPos(&x, &y);
  Napi::Object o = Napi::Object::New(info.Env());
  o.Set("x", Napi::Number::New(info.Env(), x));
  o.Set("y", Napi::Number::New(info.Env(), y));
  return o;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("startCapture", Napi::Function::New(env, StartCapture));
  exports.Set("stopCapture", Napi::Function::New(env, StopCapture));
  exports.Set("setSuppress", Napi::Function::New(env, SetSuppress));
  exports.Set("injectMouseMove", Napi::Function::New(env, InjectMouseMove));
  exports.Set("injectMouseButton", Napi::Function::New(env, InjectMouseButton));
  exports.Set("injectWheel", Napi::Function::New(env, InjectWheel));
  exports.Set("injectKey", Napi::Function::New(env, InjectKey));
  exports.Set("warpCursor", Napi::Function::New(env, WarpCursor));
  exports.Set("getCursorPos", Napi::Function::New(env, GetCursorPos));
  return exports;
}

}  // namespace

NODE_API_MODULE(cursorkeyshare_native, Init)
