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
const RAG_TIMEOUT_MS = 75_000;

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
  debug?: {
    event?: string;
    repo_dir?: string;
    index_dir?: string;
    generation_model?: string;
    api_key_loaded?: boolean;
    fallback_used?: boolean;
    error_type?: string;
    error_message?: string;
  };
};

type RunPythonRagOptions = {
  calculatorData?: string;
  topK?: number;
};

function parseRetryDelayMs(stderr: string): number | null {
  const match = stderr.match(/retry in ([0-9]+(?:\.[0-9]+)?)s/i);
  if (!match) return null;
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.ceil(seconds * 1000) + 1000;
}

const PYTHON_BRIDGE = String.raw`
import json
import re
import sys
import traceback
from pathlib import Path

from fetal_rag.config import get_api_key, get_generation_model
from fetal_rag.rag import TfidfRagEngine

payload = json.loads(sys.stdin.read() or "{}")
question = str(payload.get("question", "")).strip()
calculator_data = str(payload.get("calculator_data", "")).strip() or None
index_dir = Path(payload.get("index_dir", "vector_db/fetal_mri"))
top_k = int(payload.get("top_k", 6))

api_key = get_api_key()

engine = TfidfRagEngine.from_index(index_dir)

def _page_label(chunk):
    if chunk.page_start is not None and chunk.page_end is not None:
        if chunk.page_start == chunk.page_end:
            return f"p. {chunk.page_start}"
        return f"pp. {chunk.page_start}-{chunk.page_end}"
    return ""


def _summarize_text(text, max_chars=260):
    cleaned = re.sub(r"\s+", " ", str(text)).strip()
    if not cleaned:
        return ""
    sentences = re.split(r"(?<=[.!?])\s+", cleaned)
    summary = " ".join(sentence.strip() for sentence in sentences[:2]).strip()
    if not summary:
        summary = cleaned
    if len(summary) > max_chars:
        summary = summary[: max_chars - 1].rsplit(" ", 1)[0].rstrip(" ,;:") + "..."
    return summary


def _build_sources(contexts):
    sources = []
    for index, context in enumerate(contexts, start=1):
        chunk = context.chunk
        sources.append(
            {
                "citation": f"C{index}",
                "sourceId": chunk.source_id,
                "title": chunk.source_title or chunk.source_id,
                "pageLabel": _page_label(chunk),
                "score": context.score,
            }
        )
    return sources


def _build_fallback_answer(contexts):
    if not contexts:
        return "The indexed literature did not retrieve enough evidence to answer."

    lines = [
        "Based on the retrieved literature, here is the grounded context most relevant to your question.",
        "The live Gemini generator was unavailable, so this is a retrieval-based fallback.",
    ]
    for index, context in enumerate(contexts[:3], start=1):
        chunk = context.chunk
        title = chunk.source_title or chunk.source_id
        page_label = _page_label(chunk)
        summary = _summarize_text(chunk.text)
        if not summary:
            summary = "Relevant supporting text was retrieved from this source."
        citation_label = f"{title}{(' ' + page_label) if page_label else ''}"
        lines.append(f"[C{index}] {citation_label}: {summary}")
    return "\\n\\n".join(lines)


contexts = engine.retrieve(question, top_k=top_k)
sources = _build_sources(contexts)
fallback_used = False
error_type = ""
error_message = ""

if not contexts:
    answer = "The indexed literature did not retrieve enough evidence to answer."
else:
    try:
        result = engine.answer(question, calculator_data=calculator_data, top_k=top_k)
        answer = result.answer
        if result.contexts:
            sources = _build_sources(result.contexts)
    except Exception as error:
        fallback_used = True
        error_type = type(error).__name__
        error_message = str(error)
        traceback.print_exc(file=sys.stderr)
        answer = _build_fallback_answer(contexts)

sys.stdout.write(
    json.dumps(
        {
            "answer": answer,
            "sources": sources,
            "debug": {
                "event": "rag_runtime_config",
                "repo_dir": str(Path.cwd()),
                "index_dir": str(index_dir),
                "generation_model": get_generation_model(),
                "api_key_loaded": bool(api_key),
                "fallback_used": fallback_used,
                "error_type": error_type,
                "error_message": error_message,
            },
        }
    )
)
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
  options: RunPythonRagOptions = {},
  attempt = 0
) {
  const pythonBin = resolvePythonBinary(ragRepoDir);
  const indexDir = process.env.RAG_INDEX_DIR?.trim() || "vector_db/fetal_mri";
  const calculatorData = options.calculatorData?.trim() || "";
  const topK = options.topK ?? 6;

  console.info("RAG request context", {
    repoDir: ragRepoDir,
    pythonBin,
    indexDir,
    topK,
    attempt,
  });

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
      console.error("RAG subprocess spawn error", error);
      finish(() => {
        reject(error);
      });
    });
    child.on("close", code => {
      finish(() => {
        if (stderr.trim()) {
          const log = code === 0 ? console.warn : console.error;
          log("RAG subprocess stderr", stderr.trim());
        }
        if (code !== 0) {
          const retryDelayMs = parseRetryDelayMs(stderr);
          if (
            attempt === 0 &&
            retryDelayMs !== null &&
            /429\s+RESOURCE_EXHAUSTED/i.test(stderr)
          ) {
            console.warn(
              `RAG quota exhausted, retrying once in ${retryDelayMs}ms`
            );
            setTimeout(() => {
              void runPythonRag(question, ragRepoDir, options, attempt + 1)
                .then(resolve)
                .catch(reject);
            }, retryDelayMs);
            return;
          }

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
            debug?: unknown;
          };
          const debug =
            typeof parsed.debug === "object" && parsed.debug !== null
              ? (parsed.debug as RagResponse["debug"])
              : undefined;
          if (debug?.event === "rag_runtime_config") {
            console.info("RAG runtime config", {
              repoDir: debug.repo_dir,
              indexDir: debug.index_dir,
              generationModel: debug.generation_model,
              apiKeyLoaded: debug.api_key_loaded,
              fallbackUsed: debug.fallback_used,
            });
            if (debug.fallback_used) {
              console.warn("RAG generation fallback used", {
                errorType: debug.error_type,
                errorMessage: debug.error_message,
              });
            }
          }
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
            debug,
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
  console.info("Resolved RAG repo path", resolveRagRepoDir());
  console.info(
    "Resolved RAG index path",
    process.env.RAG_INDEX_DIR?.trim() || "vector_db/fetal_mri"
  );
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
