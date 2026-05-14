import { useEffect } from "react";
import { DEFAULT_UI_SCALE, type UiScale } from "@t3tools/contracts/settings";

import { useSettings } from "./useSettings";

function applyBrowserUiScale(scale: UiScale): void {
  const root = document.documentElement;
  if (scale === DEFAULT_UI_SCALE) {
    root.style.removeProperty("zoom");
    return;
  }

  root.style.setProperty("zoom", String(scale / 100));
}

export function useSyncUiScale(): void {
  const uiScale = useSettings((settings) => settings.uiScale);

  useEffect(() => {
    const desktopBridge = window.desktopBridge;
    if (desktopBridge) {
      document.documentElement.style.removeProperty("zoom");
      void desktopBridge.setUiScale(uiScale).catch((error: unknown) => {
        console.error("Failed to apply desktop UI scale", error);
      });
      return;
    }

    applyBrowserUiScale(uiScale);
  }, [uiScale]);
}

export function UiScaleSynchronizer(): null {
  useSyncUiScale();
  return null;
}
