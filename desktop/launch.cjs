const { spawn } = require("node:child_process");
const path = require("node:path");
const electronPath = require("electron");

const projectRoot = path.resolve(__dirname, "..");
const env = { ...process.env };

delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, [projectRoot], {
  env,
  stdio: "inherit",
});

let childExited = false;
let forceKillTimer = null;

function requestChildExit(signal = "SIGTERM") {
  if (childExited) {
    return;
  }

  if (!child.killed) {
    child.kill(signal);
  }

  if (!forceKillTimer) {
    forceKillTimer = setTimeout(() => {
      if (!childExited) {
        child.kill("SIGKILL");
      }
    }, 5000);
    forceKillTimer.unref?.();
  }
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    requestChildExit(signal);
  });
}

process.once("exit", () => {
  requestChildExit();
});

child.on("exit", (code) => {
  childExited = true;

  if (forceKillTimer) {
    clearTimeout(forceKillTimer);
  }

  process.exit(code ?? 0);
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
