import { spawn } from "child_process";
import fs from "fs";
import path from "path";

const rootDir = process.cwd();
const serverEntry = path.resolve(rootDir, "server", "index.ts");
const serverEnv = {
  ...process.env,
  PORT: "3000",
  NODE_ENV: "development",
};

function spawnProcess(command, args, env = {}) {
  return spawn(command, args, {
    cwd: rootDir,
    env: {
      ...process.env,
      ...env,
    },
    stdio: "inherit",
  });
}

let shuttingDown = false;
let restartPending = false;
let serverProcess = null;

function startServer() {
  serverProcess = spawnProcess(
    process.execPath,
    ["--import", "tsx", serverEntry],
    serverEnv
  );
  serverProcess.on("exit", code => {
    if (shuttingDown) {
      return;
    }
    if (code && code !== 0) {
      console.error(`Express server exited with code ${code}`);
      process.exitCode = code;
    }
  });
}

function restartServer() {
  if (shuttingDown || restartPending) {
    return;
  }

  restartPending = true;
  const current = serverProcess;
  if (!current) {
    restartPending = false;
    startServer();
    return;
  }

  current.once("exit", () => {
    restartPending = false;
    if (!shuttingDown) {
      startServer();
    }
  });
  current.kill("SIGTERM");
}

startServer();

fs.watchFile(serverEntry, { interval: 250 }, () => {
  console.log("Detected server/index.ts change, restarting Express...");
  restartServer();
});

function shutdown(signal = "SIGINT") {
  if (shuttingDown) return;
  shuttingDown = true;
  fs.unwatchFile(serverEntry);
  if (serverProcess) {
    serverProcess.kill(signal);
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(signal));
}

process.on("exit", () => shutdown("SIGTERM"));
