const { spawn } = require("node:child_process");
const path = require("node:path");
const electronPath = require("electron");
const { createLineFilter } = require("./log-filter.cjs");

const projectRoot = path.resolve(__dirname, "..");
const env = { ...process.env };

delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, [projectRoot, ...process.argv.slice(2)], {
  env,
  stdio: ["inherit", "inherit", "pipe"],
});
const stderrFilter = createLineFilter((text) => process.stderr.write(text));

child.stderr.on("data", (chunk) => {
  if (env.ATRI_SHOW_CHROMIUM_LOGS === "1") {
    process.stderr.write(chunk);
  } else {
    stderrFilter.push(chunk);
  }
});
child.stderr.on("end", () => stderrFilter.flush());

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
