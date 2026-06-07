import express from "express";
import fs from "fs";
import { createServer } from "http";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_RAG_REPO_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  "gemini_based_rag"
);
const RAG_TIMEOUT_MS = 30_000;

const PYTHON_BRIDGE = String.raw`
import json
import sys
from pathlib import Path

from fetal_rag.rag import TfidfRagEngine

payload = json.loads(sys.stdin.read() or "{}")
report = str(payload.get("report", "")).strip()
index_dir = Path(payload.get("index_dir", "vector_db/fetal_mri"))

question = (
    "Provide concise literature context for this fetal brain MRI report.\n\n"
    + report
)
engine = TfidfRagEngine.from_index(index_dir)
result = engine.answer(question, calculator_data=report)
sys.stdout.write(json.dumps({"answer": result.answer}))
`;

function resolveRagRepoDir() {
  const configured = process.env.RAG_REPO_DIR?.trim();
  return configured ? path.resolve(configured) : DEFAULT_RAG_REPO_DIR;
}

function resolvePythonBinary(ragRepoDir: string) {
  const configured = process.env.RAG_PYTHON_BIN?.trim();
  if (configured) return configured;

  const venvPython = path.resolve(ragRepoDir, ".venv", "bin", "python");
  if (fs.existsSync(venvPython)) return venvPython;

  const venvPython3 = path.resolve(ragRepoDir, ".venv", "bin", "python3");
  if (fs.existsSync(venvPython3)) return venvPython3;

  return "python3";
}

function runPythonRag(report: string, ragRepoDir: string) {
  const pythonBin = resolvePythonBinary(ragRepoDir);
  const indexDir = process.env.RAG_INDEX_DIR?.trim() || "vector_db/fetal_mri";

  return new Promise<string>((resolve, reject) => {
    const child = spawn(pythonBin, ["-c", PYTHON_BRIDGE], {
      cwd: ragRepoDir,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };

    const timeout = setTimeout(() => {
      finish(() => {
        child.kill("SIGKILL");
        reject(new Error("RAG subprocess timed out"));
      });
    }, RAG_TIMEOUT_MS);

    child.stdout.on("data", chunk => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", chunk => {
      stderr += chunk.toString();
    });
    child.on("error", error => {
      finish(() => {
        reject(error);
      });
    });
    child.on("close", code => {
      finish(() => {
        if (code !== 0) {
          reject(
            new Error(
              `RAG subprocess exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`
            )
          );
          return;
        }

        try {
          const parsed = JSON.parse(stdout.trim() || "{}") as {
            answer?: unknown;
          };
          resolve(typeof parsed.answer === "string" ? parsed.answer : "");
        } catch {
          reject(
            new Error(
              `Unable to parse RAG subprocess output${stderr ? `: ${stderr.trim()}` : ""}`
            )
          );
        }
      });
    });

    child.stdin.end(
      JSON.stringify({
        report,
        index_dir: indexDir,
      })
    );
  });
}

function registerRagRoute(app: express.Express) {
  app.use(express.json({ limit: "1mb" }));

  app.post("/api/rag", async (req, res) => {
    const report = typeof req.body?.report === "string" ? req.body.report : "";
    if (!report.trim()) {
      res.json({ answer: "" });
      return;
    }

    try {
      const answer = await runPythonRag(report, resolveRagRepoDir());
      res.json({ answer });
    } catch (error) {
      console.error("RAG request failed:", error);
      res.json({ answer: "" });
    }
  });

  console.log("RAG route registered");
}

function createApp() {
  const app = express();
  registerRagRoute(app);

  return app;
}

async function startServer() {
  const app = createApp();
  const server = createServer(app);
  const port = process.env.PORT || 3000;

  if (process.env.NODE_ENV === "production") {
    const staticPath = path.resolve(__dirname, "public");
    app.use(express.static(staticPath));

    app.get("*", (_req, res) => {
      res.sendFile(path.join(staticPath, "index.html"));
    });
  } else {
    const {
      createServer: createViteServer,
      loadConfigFromFile,
      mergeConfig,
    } = await import("vite");
    const viteConfig = await loadConfigFromFile(
      { command: "serve", mode: "development" },
      path.resolve(__dirname, "..", "vite.config.ts")
    );
    const vite = await createViteServer(
      mergeConfig(viteConfig?.config ?? {}, {
        appType: "custom",
        server: {
          middlewareMode: true,
          hmr: { server },
        },
      })
    );

    app.use(vite.middlewares);

    app.get("*", async (req, res, next) => {
      try {
        const indexPath = path.resolve(__dirname, "..", "client", "index.html");
        let html = fs.readFileSync(indexPath, "utf-8");
        html = await vite.transformIndexHtml(req.originalUrl, html);
        res.status(200).setHeader("Content-Type", "text/html").end(html);
      } catch (error) {
        vite.ssrFixStacktrace(error as Error);
        next(error);
      }
    });
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}

startServer().catch(console.error);
