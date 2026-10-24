"use strict";

// ── Windows: find the top-level window the user is dragging right now ──
//
// While a window sits in the system move/size loop (title-bar drag, edge
// resize, Win+arrows drag), its GUI thread reports GUI_INMOVESIZE in
// GetGUIThreadInfo().flags and names the window in hwndMoveSize. Passing
// idThread = 0 asks about the foreground thread, which is the one holding the
// mouse capture during such a drag. That is one cheap FFI call per probe; the
// rect lookups only happen while a drag is actually in progress.
//
// The probe returns the window's *visible* frame (DWM extended frame bounds,
// which excludes the invisible resize borders and drop shadow) in physical
// screen pixels, or null. Callers convert to DIPs. Windows owned by this
// process (the pet itself, bubbles, Settings) are ignored.
//
// Best effort like win-fullscreen-detect.js: when koffi/user32 cannot be
// loaded the factory returns a probe with `supported === false` that always
// answers null, so the kick feature degrades to "off" instead of throwing.

const GUI_INMOVESIZE = 0x00000002;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;

function createMovingWindowProbe(options = {}) {
  const isWin = options.isWin != null ? !!options.isWin : process.platform === "win32";
  const ownPid = Number.isInteger(options.pid) ? options.pid : process.pid;
  const noop = () => null;
  noop.supported = false;
  if (!isWin) return noop;

  let GetGUIThreadInfo;
  let GetWindowRect;
  let GetWindowThreadProcessId;
  let IsWindowVisible;
  let DwmGetWindowAttribute = null;
  let infoSize;
  let addressOf = null;
  try {
    const koffi = options.koffi || require("koffi");
    const user32 = koffi.load("user32.dll");
    koffi.struct("ClawdMoveRECT", { left: "int32", top: "int32", right: "int32", bottom: "int32" });
    koffi.struct("ClawdGUITHREADINFO", {
      cbSize: "uint32",
      flags: "uint32",
      hwndActive: "void*",
      hwndFocus: "void*",
      hwndCapture: "void*",
      hwndMenuOwner: "void*",
      hwndMoveSize: "void*",
      hwndCaret: "void*",
      rcCaret: "ClawdMoveRECT",
    });
    infoSize = koffi.sizeof("ClawdGUITHREADINFO");
    GetGUIThreadInfo = user32.func("bool __stdcall GetGUIThreadInfo(uint32 idThread, _Inout_ ClawdGUITHREADINFO* pgui)");
    GetWindowRect = user32.func("bool __stdcall GetWindowRect(void* hWnd, _Out_ ClawdMoveRECT* lpRect)");
    GetWindowThreadProcessId = user32.func("uint32 __stdcall GetWindowThreadProcessId(void* hWnd, _Out_ uint32* lpdwProcessId)");
    IsWindowVisible = user32.func("bool __stdcall IsWindowVisible(void* hWnd)");
    try {
      const dwmapi = koffi.load("dwmapi.dll");
      DwmGetWindowAttribute = dwmapi.func(
        "int32 __stdcall DwmGetWindowAttribute(void* hwnd, uint32 dwAttribute, _Out_ ClawdMoveRECT* pvAttribute, uint32 cbAttribute)"
      );
    } catch (err) {
      // Only costs frame accuracy (invisible borders stay in the rect).
      if (typeof options.onError === "function") options.onError(err);
    }
    if (typeof koffi.address === "function") addressOf = koffi.address;
  } catch (err) {
    if (typeof options.onError === "function") options.onError(err);
    return noop;
  }

  function probe() {
    try {
      const info = {
        cbSize: infoSize,
        flags: 0,
        hwndActive: null,
        hwndFocus: null,
        hwndCapture: null,
        hwndMenuOwner: null,
        hwndMoveSize: null,
        hwndCaret: null,
        rcCaret: {},
      };
      if (!GetGUIThreadInfo(0, info)) return null;
      if ((info.flags & GUI_INMOVESIZE) === 0 || !info.hwndMoveSize) return null;
      const hwnd = info.hwndMoveSize;
      if (!IsWindowVisible(hwnd)) return null;

      const pidOut = [0];
      GetWindowThreadProcessId(hwnd, pidOut);
      if (pidOut[0] === ownPid) return null;

      const rect = {};
      let ok = false;
      if (DwmGetWindowAttribute) {
        ok = DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, rect, 16) === 0;
      }
      if (!ok && !GetWindowRect(hwnd, rect)) return null;
      if (!(rect.right > rect.left && rect.bottom > rect.top)) return null;

      return {
        id: addressOf ? String(addressOf(hwnd)) : "moving",
        rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      };
    } catch (err) {
      if (typeof options.onCallError === "function") options.onCallError(err);
      return null;
    }
  }
  probe.supported = true;
  return probe;
}

module.exports = { createMovingWindowProbe, GUI_INMOVESIZE };
