//! Minimal CoreGraphics FFI. All refs created here are released; no model text
//! is interpolated into AppleScript. API signatures match the SDK headers.
use super::{Action, Geometry};
use anyhow::{ensure, Result};
use std::{ffi::c_void, ptr};
use tokio_util::sync::CancellationToken;
#[repr(C)]
#[derive(Clone, Copy)]
struct Point {
    x: f64,
    y: f64,
}
#[repr(C)]
struct Size {
    width: f64,
    height: f64,
}
#[repr(C)]
struct Rect {
    origin: Point,
    size: Size,
}
type Event = *mut c_void;
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn CGMainDisplayID() -> u32;
    fn CGDisplayBounds(display: u32) -> Rect;
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
    fn CGPreflightPostEventAccess() -> bool;
    fn AXIsProcessTrusted() -> bool;
    fn CGEventCreateMouseEvent(
        source: *const c_void,
        kind: u32,
        point: Point,
        button: u32,
    ) -> Event;
    fn CGEventCreateKeyboardEvent(source: *const c_void, key: u16, down: bool) -> Event;
    fn CGEventCreateScrollWheelEvent2(
        source: *const c_void,
        units: u32,
        count: u32,
        w1: i32,
        w2: i32,
        w3: i32,
    ) -> Event;
    fn CGEventKeyboardSetUnicodeString(event: Event, len: usize, text: *const u16);
    fn CGEventSetIntegerValueField(event: Event, field: u32, value: i64);
    fn CGEventPost(location: u32, event: Event);
    fn CFRelease(object: *const c_void);
}
pub(super) unsafe fn screen_capture_granted() -> bool {
    CGPreflightScreenCaptureAccess()
}

pub(super) unsafe fn accessibility_granted() -> bool {
    AXIsProcessTrusted()
}

pub(super) fn geometry() -> Result<Geometry> {
    // SAFETY: no pointers or ownership are passed to these value-returning APIs.
    let rect = unsafe { CGDisplayBounds(CGMainDisplayID()) };
    Geometry {
        x: rect.origin.x,
        y: rect.origin.y,
        width: rect.size.width,
        height: rect.size.height,
    }
    .validate()
}
pub(super) fn check_capture() -> Result<()> {
    // Preflight never prompts; request so a "not-determined" app gets the
    // consent dialog, then re-check (the request returns the pre-grant state).
    if unsafe { !CGPreflightScreenCaptureAccess() } {
        unsafe { CGRequestScreenCaptureAccess() };
        ensure!(unsafe{CGPreflightScreenCaptureAccess()},"Screen Recording permission is required for WorldBase/app-server; grant it in System Settings and restart the app");
    }
    Ok(())
}
fn post(event: Event) -> Result<()> {
    ensure!(!event.is_null(), "could not create native input event");
    // SAFETY: caller passes a +1 CGEventRef; post doesn't consume ownership.
    unsafe {
        CGEventPost(0, event);
        CFRelease(event)
    };
    Ok(())
}
fn mouse(kind: u32, x: i64, y: i64, click: i64) -> Result<()> {
    let event = unsafe {
        CGEventCreateMouseEvent(
            ptr::null(),
            kind,
            Point {
                x: x as f64,
                y: y as f64,
            },
            0,
        )
    };
    ensure!(!event.is_null(), "could not create mouse event");
    unsafe { CGEventSetIntegerValueField(event, 1, click) };
    post(event)
}
pub(super) fn perform(action: &Action, abort: &CancellationToken) -> Result<()> {
    // CGPreflightPostEventAccess never prompts. Firing one synthetic event
    // through the trusted path is what raises the Accessibility consent dialog
    // for a "not-determined" app; if the user denies or defers, fail cleanly.
    if unsafe { !CGPreflightPostEventAccess() } {
        let event = unsafe { CGEventCreateMouseEvent(ptr::null(), 5, Point { x: 0.0, y: 0.0 }, 0) };
        if !event.is_null() {
            unsafe {
                CGEventPost(0, event);
                CFRelease(event)
            };
        }
        ensure!(unsafe{CGPreflightPostEventAccess()},"Accessibility permission is required for WorldBase/app-server; grant it in System Settings");
    }
    ensure!(!abort.is_cancelled(), "desktop control cancelled");
    match action {
        Action::Click { x, y, .. } | Action::DoubleClick { x, y, .. } => {
            let n = if matches!(action, Action::DoubleClick { .. }) {
                2
            } else {
                1
            };
            for count in 1..=n {
                ensure!(!abort.is_cancelled(), "cancelled");
                mouse(1, *x, *y, count)?;
                mouse(2, *x, *y, count)?;
            }
        }
        Action::Scroll { x, y, delta_y, .. } => {
            mouse(5, *x, *y, 0)?;
            post(unsafe { CGEventCreateScrollWheelEvent2(ptr::null(), 1, 1, *delta_y, 0, 0) })?;
        }
        Action::Type { text, .. } => {
            // Per Unicode scalar so a surrogate pair is never split. Bound by
            // the protocol's 2048 UTF-16-unit limit; cancellation between pairs.
            for c in text.chars() {
                ensure!(!abort.is_cancelled(), "cancelled");
                let mut buf = [0u16; 2];
                let units = c.encode_utf16(&mut buf);
                for down in [true, false] {
                    let event = unsafe { CGEventCreateKeyboardEvent(ptr::null(), 0, down) };
                    ensure!(!event.is_null(), "could not create keyboard event");
                    unsafe { CGEventKeyboardSetUnicodeString(event, units.len(), units.as_ptr()) };
                    post(event)?;
                }
            }
        }
        Action::Key { key, .. } => {
            let code = match key.as_str() {
                "Enter" => 36,
                "Tab" => 48,
                "Escape" => 53,
                "Backspace" => 51,
                "Delete" => 117,
                "Left" => 123,
                "Right" => 124,
                "Up" => 126,
                "Down" => 125,
                "Space" => 49,
                "Home" => 115,
                "End" => 119,
                "PageUp" => 116,
                "PageDown" => 121,
                _ => anyhow::bail!("unsupported key"),
            };
            post(unsafe { CGEventCreateKeyboardEvent(ptr::null(), code, true) })?;
            post(unsafe { CGEventCreateKeyboardEvent(ptr::null(), code, false) })?;
        }
    }
    Ok(())
}
