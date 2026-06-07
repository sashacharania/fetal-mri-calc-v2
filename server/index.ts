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

type RagSource = {
  citation: string;
  sourceId: string;
  title: string;
  pageLabel: string;
  score: number;
};

type RagResponse = {
  answer: string;
  sources: RagSource[];
};

const PYTHON_BRIDGE = String.raw`
import json
import sys
from pathlib import Path

from fetal_rag.rag import TfidfRagEngine

payload = json.loads(sys.stdin.read() or "{}")
question = str(payload.get("question", "")).strip()
calculator_data = str(payload.get("calculator_data", "")).strip() or None
index_dir = Path(payload.get("index_dir", "vector_db/fetal_mri"))
top_k = int(payload.get("top_k", 6))

engine = TfidfRagEngine.from_index(index_dir)
result = engine.answer(question, calculator_data=calculator_data, top_k=top_k)

sources = []
for index, context in enumerate(result.contexts, start=1):
    chunk = context.chunk
    if chunk.page_start is not None and chunk.page_end is not None:
        page_label = (
            f"p. {chunk.page_start}"
            if chunk.page_start == chunk.page_end
            else f"pp. {chunk.page_start}-{chunk.page_end}"
        )
    else:
        page_label = ""
    sources.append(
        {
            "citation": f"C{index}",
            "sourceId": chunk.source_id,
            "title": chunk.source_title or chunk.source_id,
            "pageLabel": page_label,
            "score": context.score,
        }
    )

sys.stdout.write(json.dumps({"answer": result.answer, "sources": sources}))
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

function runPythonRag(
  question: string,
  ragRepoDir: string,
  options: { calculatorData?: string; topK?: number } = {}
) {
  const pythonBin = resolvePythonBinary(ragRepoDir);
  const indexDir = process.env.RAG_INDEX_DIR?.trim() || "vector_db/fetal_mri";
  const calculatorData = options.calculatorData?.trim() || "";
  const topK = options.topK ?? 6;

  return new Promise<RagResponse>((resolve, reject) => {
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
            sources?: unknown;
          };
          const sources = Array.isArray(parsed.sources)
            ? parsed.sources
                .map(source => {
                  if (typeof source !== "object" || source === null) {
                    return null;
                  }
                  const raw = source as Record<string, unknown>;
                  return {
                    citation:
                      typeof raw.citation === "string" ? raw.citation : "",
                    sourceId:
                      typeof raw.sourceId === "string" ? raw.sourceId : "",
                    title: typeof raw.title === "string" ? raw.title : "",
                    pageLabel:
                      typeof raw.pageLabel === "string" ? raw.pageLabel : "",
                    score:
                      typeof raw.score === "number"
                        ? raw.score
                        : Number(raw.score ?? 0),
                  } as RagSource;
                })
                .filter((source): source is RagSource => source !== null)
            : [];
          resolve({
            answer: typeof parsed.answer === "string" ? parsed.answer : "",
            sources,
          });
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
        question,
        calculator_data: calculatorData,
        index_dir: indexDir,
        top_k: topK,
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
      const result = await runPythonRag(
        "Provide concise literature context for this fetal brain MRI report.\n\n" +
          report,
        resolveRagRepoDir(),
        { calculatorData: report }
      );
      res.json({ answer: result.answer });
    } catch (error) {
      console.error("RAG request failed:", error);
      res.json({ answer: "" });
    }
  });

  app.post("/api/rag/chat", async (req, res) => {
    const question =
      typeof req.body?.question === "string" ? req.body.question : "";
    const report = typeof req.body?.report === "string" ? req.body.report : "";
    if (!question.trim()) {
      res.json({ answer: "", sources: [] });
      return;
    }

    try {
      const result = await runPythonRag(question, resolveRagRepoDir(), {
        calculatorData: report,
      });
      res.json(result);
    } catch (error) {
      console.error("RAG chat request failed:", error);
      res.json({ answer: "", sources: [] });
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
