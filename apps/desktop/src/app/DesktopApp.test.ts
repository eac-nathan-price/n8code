import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";

import { resolveLinuxDisplayCommandLineSwitches } from "./DesktopApp.ts";

describe("DesktopApp", () => {
  it("prefers Wayland for WSLg when Electron has no explicit Ozone hint", () => {
    assert.deepEqual(
      resolveLinuxDisplayCommandLineSwitches({
        platform: "linux",
        waylandDisplay: Option.some("wayland-0"),
        wslDistroName: Option.some("Ubuntu"),
        electronOzonePlatformHint: Option.none(),
        desktopForceDeviceScaleFactor: Option.none(),
        disableWslgWayland: false,
      }),
      [
        ["ozone-platform", "wayland"],
        ["enable-features", "UseOzonePlatform,WaylandWindowDecorations"],
      ],
    );
  });

  it("respects explicit Ozone and scale-factor overrides", () => {
    assert.deepEqual(
      resolveLinuxDisplayCommandLineSwitches({
        platform: "linux",
        waylandDisplay: Option.some("wayland-0"),
        wslDistroName: Option.some("Ubuntu"),
        electronOzonePlatformHint: Option.some("x11"),
        desktopForceDeviceScaleFactor: Option.some("1.5"),
        disableWslgWayland: false,
      }),
      [["force-device-scale-factor", "1.5"]],
    );
  });

  it("leaves non-Linux platforms unchanged", () => {
    assert.deepEqual(
      resolveLinuxDisplayCommandLineSwitches({
        platform: "win32",
        waylandDisplay: Option.some("wayland-0"),
        wslDistroName: Option.some("Ubuntu"),
        electronOzonePlatformHint: Option.none(),
        desktopForceDeviceScaleFactor: Option.some("1.5"),
        disableWslgWayland: false,
      }),
      [],
    );
  });
});
