// N-API glue. Exposes the platform input layer to JavaScript and bridges OS hook
// callbacks (which fire on a dedicated OS thread) to the JS thread via a
// ThreadSafeFunction.

#include <napi.h>
#include <atomic>
#include <memory>
#include "input.h"

// Interface-scoped sockets (VPN bypass). On macOS, IP_BOUND_IF forces a socket's
// traffic out a chosen physical NIC regardless of the routing table — so when a
// full-tunnel VPN has hijacked the default route, the app's LAN traffic still
// reaches a peer on the same Wi-Fi. Windows peers here are never on the VPN, so
// these are no-ops there.
#if defined(__APPLE__)
#include <sys/socket.h>
#include <netinet/in.h>
#include <net/if.h>
#include <arpa/inet.h>
#include <fcntl.h>
#include <poll.h>
#include <unistd.h>
#include <errno.h>
#include <cstring>
#include <string>
#endif

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

// ---- interface-scoped sockets (VPN bypass) --------------------------------

// bindToInterface(fd, ifName) -> bool. Scope an existing socket to a NIC.
Napi::Value BindToInterface(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
#if defined(__APPLE__)
  int fd = info[0].As<Napi::Number>().Int32Value();
  std::string name = info[1].As<Napi::String>().Utf8Value();
  unsigned int idx = if_nametoindex(name.c_str());
  if (idx == 0) return Napi::Boolean::New(env, false);
  int r = setsockopt(fd, IPPROTO_IP, IP_BOUND_IF, &idx, sizeof(idx));
  return Napi::Boolean::New(env, r == 0);
#else
  // Windows side is never on the VPN in the supported scenario — nothing to do.
  (void)info;
  return Napi::Boolean::New(env, true);
#endif
}

#if defined(__APPLE__)
// Off-thread: create a socket, scope it to the NIC, connect (non-blocking with a
// timeout), and hand the connected fd back so JS can wrap it with net.Socket.
// Doing the connect natively is the only way to scope it BEFORE the SYN is sent.
class ConnectWorker : public Napi::AsyncWorker {
 public:
  ConnectWorker(Napi::Env env, std::string host, int port, std::string ifname,
                int timeoutMs, Napi::Promise::Deferred def)
      : Napi::AsyncWorker(env), host_(host), port_(port), ifname_(ifname),
        timeoutMs_(timeoutMs), def_(def) {}

  void Execute() override {
    int fd = ::socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) { SetError("socket() failed"); return; }
    unsigned int idx = if_nametoindex(ifname_.c_str());
    if (idx != 0) setsockopt(fd, IPPROTO_IP, IP_BOUND_IF, &idx, sizeof(idx));

    int flags = fcntl(fd, F_GETFL, 0);
    fcntl(fd, F_SETFL, flags | O_NONBLOCK);

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons((uint16_t)port_);
    if (inet_pton(AF_INET, host_.c_str(), &addr.sin_addr) != 1) {
      ::close(fd); SetError("host must be an IPv4 address"); return;
    }
    int r = ::connect(fd, (struct sockaddr*)&addr, sizeof(addr));
    if (r != 0 && errno != EINPROGRESS) {
      std::string e = std::string("connect: ") + strerror(errno);
      ::close(fd); SetError(e); return;
    }
    if (r != 0) {  // in progress — wait for writability
      struct pollfd pfd; pfd.fd = fd; pfd.events = POLLOUT; pfd.revents = 0;
      int pr = ::poll(&pfd, 1, timeoutMs_);
      if (pr <= 0) { ::close(fd); SetError("connect timed out"); return; }
      int soerr = 0; socklen_t len = sizeof(soerr);
      getsockopt(fd, SOL_SOCKET, SO_ERROR, &soerr, &len);
      if (soerr != 0) {
        std::string e = std::string("connect: ") + strerror(soerr);
        ::close(fd); SetError(e); return;
      }
    }
    fd_ = fd;  // connected; ownership passes to JS (net.Socket closes it)
  }

  void OnOK() override { def_.Resolve(Napi::Number::New(Env(), fd_)); }
  void OnError(const Napi::Error& e) override { def_.Reject(e.Value()); }

 private:
  std::string host_;
  int port_;
  std::string ifname_;
  int timeoutMs_;
  Napi::Promise::Deferred def_;
  int fd_ = -1;
};
#endif  // __APPLE__

// connectBoundTcp(host, port, ifName, timeoutMs?) -> Promise<fd>
Napi::Value ConnectBoundTcp(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto def = Napi::Promise::Deferred::New(env);
#if defined(__APPLE__)
  std::string host = info[0].As<Napi::String>().Utf8Value();
  int port = info[1].As<Napi::Number>().Int32Value();
  std::string ifname = info[2].As<Napi::String>().Utf8Value();
  int timeoutMs = info.Length() > 3 && info[3].IsNumber()
                      ? info[3].As<Napi::Number>().Int32Value() : 4000;
  (new ConnectWorker(env, host, port, ifname, timeoutMs, def))->Queue();
#else
  def.Reject(Napi::Error::New(env, "connectBoundTcp not supported on this platform").Value());
#endif
  return def.Promise();
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
  exports.Set("bindToInterface", Napi::Function::New(env, BindToInterface));
  exports.Set("connectBoundTcp", Napi::Function::New(env, ConnectBoundTcp));
  return exports;
}

}  // namespace

NODE_API_MODULE(cursorkeyshare_native, Init)
