import { spawn } from "node:child_process";

import {
  applyLinuxDisplayLaunchEnvironment,
  desktopDir,
  resolveElectronPath,
} from "./electron-launcher.mjs";

const childEnv = applyLinuxDisplayLaunchEnvironment({ ...process.env });
delete childEnv.ELECTRON_RUN_AS_NODE;

const child = spawn(resolveElectronPath(), ["dist-electron/main.cjs"], {
  stdio: "inherit",
  cwd: desktopDir,
  env: childEnv,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
