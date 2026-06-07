/*
 * Design: "Editorial Clinical" — journal-style, two-column editorial layout.
 * Top sticky GA bar, collapsible context panel, left column of biometric
 * parameter rows, right column with the live structured report preview and
 * differential-diagnosis cards. Hairline rules. Deep teal accent. Serif
 * display + sans body + monospace numerics.
 */
import { useMemo, useState, useEffect, useRef, type FormEvent } from "react";
import { Link } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import {
  ChevronDown,
  Copy,
  RotateCcw,
  BookOpen,
  Loader2,
  Send,
  Sparkles,
} from "lucide-react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import AuxiliaryMeasurementRow from "@/components/AuxiliaryMeasurementRow";
import ParameterRow from "@/components/ParameterRow";
import QualitativeFindingRow from "@/components/QualitativeFindingRow";
import DifferentialCard, {
  DifferentialRailItem,
} from "@/components/DifferentialCard";
import {
  AUXILIARY_MEASUREMENTS,
  GA,
  GROUP_ORDER,
  PARAMETERS_ALL,
  QUALITATIVE_FINDINGS,
  evaluateAll,
  gaToDecimalWeeks,
  parseGestationalAge,
} from "@/lib/biometry";
import { copyReportPlainText } from "@/lib/clipboard";
import { generateReport } from "@/lib/report";
import type { Differential } from "@/lib/biometry";

/* ---------- Adaptive DDx panel ---------- */

function DifferentialPanel({ dxs }: { dxs: Differential[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Keep selection valid as the firing set changes; default to the
  // top-ranked card.
  useEffect(() => {
    if (dxs.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (!selectedId || !dxs.some(d => d.id === selectedId)) {
      setSelectedId(dxs[0].id);
    }
  }, [dxs, selectedId]);

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-display text-[22px]">
          Differential diagnosis engine
        </h2>
        <span className="smallcaps text-[color:var(--ink-soft)]">
          {dxs.length} card{dxs.length === 1 ? "" : "s"} · ranked by likelihood
        </span>
      </div>

      <AnimatePresence mode="popLayout">
        {dxs.length === 0 ? (
          <motion.div
            key="empty"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="border border-dashed border-[color:var(--rule)] rounded-sm p-6 text-sm text-[color:var(--ink-soft)]"
          >
            No abnormal thresholds tripped. As measurements cross evidence-based
            clinical thresholds (atrial diameter ≥ 10 mm, CSP &lt; 1 mm or &gt;
            10 mm, corpus callosum below the 5th percentile, small pons or TCD,
            etc.), citation-grounded differential cards will appear here —
            sorted by likelihood.
          </motion.div>
        ) : dxs.length <= 2 ? (
          <div key="stack" className="space-y-5">
            {dxs.map((dx, i) => (
              <DifferentialCard key={dx.id} dx={dx} rank={i + 1} />
            ))}
          </div>
        ) : (
          <motion.div
            key="rail"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.2 }}
            className="grid grid-cols-12 gap-0 border border-[color:var(--rule)] rounded-sm bg-white overflow-hidden"
          >
            <nav
              className="col-span-12 md:col-span-5 border-b md:border-b-0 md:border-r border-[color:var(--rule)] bg-[color:var(--paper)]/40 max-h-[280px] md:max-h-[640px] overflow-auto"
              aria-label="Differential diagnoses ranked by likelihood"
            >
              <div className="smallcaps text-[10.5px] text-[color:var(--ink-soft)] px-4 pt-3 pb-1">
                Ranked findings
              </div>
              <ul className="divide-y divide-[color:var(--rule)]">
                {dxs.map((dx, i) => (
                  <li key={dx.id}>
                    <DifferentialRailItem
                      dx={dx}
                      rank={i + 1}
                      selected={selectedId === dx.id}
                      onSelect={() => setSelectedId(dx.id)}
                    />
                  </li>
                ))}
              </ul>
              <div className="px-4 py-3 text-[10.5px] text-[color:var(--ink-soft)] border-t border-[color:var(--rule)]">
                Likelihood is computed from each finding’s prior in the source
                paper, then re-weighted when companion findings fire
                (e.g.&nbsp;an absent CSP raises the rank of a short corpus
                callosum).
              </div>
            </nav>
            <div className="col-span-12 md:col-span-7 min-w-0">
              {dxs
                .filter(d => d.id === selectedId)
                .map(dx => (
                  <DifferentialCard
                    key={dx.id}
                    dx={dx}
                    rank={dxs.findIndex(d => d.id === dx.id) + 1}
                  />
                ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

function extractRagAnswer(payload: unknown): string {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("answer" in payload)
  ) {
    return "";
  }

  const answer = (payload as { answer?: unknown }).answer;
  return typeof answer === "string" ? answer.trim() : "";
}

type RagSource = {
  citation: string;
  title: string;
  pageLabel: string;
  sourceId: string;
  score: number;
};

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  sources: RagSource[];
};

function extractRagSources(payload: unknown): RagSource[] {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("sources" in payload) ||
    !Array.isArray((payload as { sources?: unknown }).sources)
  ) {
    return [];
  }

  return (payload as { sources: unknown[] }).sources
    .map(source => {
      if (typeof source !== "object" || source === null) {
        return null;
      }
      const raw = source as Record<string, unknown>;
      return {
        citation: typeof raw.citation === "string" ? raw.citation.trim() : "",
        title: typeof raw.title === "string" ? raw.title.trim() : "",
        pageLabel:
          typeof raw.pageLabel === "string" ? raw.pageLabel.trim() : "",
        sourceId: typeof raw.sourceId === "string" ? raw.sourceId.trim() : "",
        score:
          typeof raw.score === "number" ? raw.score : Number(raw.score ?? 0),
      } satisfies RagSource;
    })
    .filter(
      (source): source is RagSource => source !== null && source.citation !== ""
    );
}

function LiteratureChatPanel({ report }: { report: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      content:
        "Ask a fetal MRI literature question. I’ll answer from the same RAG corpus used by the report workflow and keep [C1], [C2], etc. citations in the reply.",
      sources: [],
    },
  ]);
  const [draft, setDraft] = useState("");
  const [isSending, setIsSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, isSending]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const question = draft.trim();
    if (!question || isSending) return;

    setDraft("");
    setMessages(prev => [
      ...prev,
      { role: "user", content: question, sources: [] },
    ]);
    setIsSending(true);

    try {
      const response = await fetch("/api/rag/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ question, report }),
      });

      if (!response.ok) {
        throw new Error(`Chat request failed with ${response.status}`);
      }

      const payload: unknown = await response.json();
      const answer = extractRagAnswer(payload);
      const sources = extractRagSources(payload);

      setMessages(prev => [
        ...prev,
        {
          role: "assistant",
          content:
            answer ||
            "I couldn’t retrieve a grounded answer for that question.",
          sources,
        },
      ]);
    } catch {
      setMessages(prev => [
        ...prev,
        {
          role: "assistant",
          content:
            "The literature chat is temporarily unavailable. Please try again in a moment.",
          sources: [],
        },
      ]);
    } finally {
      setIsSending(false);
    }
  };

  return (
    <article className="bg-white border border-[color:var(--rule)] rounded-sm">
      <header className="flex items-center justify-between border-b border-[color:var(--rule)] px-5 py-3">
        <div>
          <div className="smallcaps text-[color:var(--teal)]">
            Literature Chat
          </div>
          <div className="font-display text-[15px] mt-0.5">
            RAG-backed literature assistant
          </div>
        </div>
      </header>

      <div className="px-5 py-4 space-y-4">
        <div className="max-h-[320px] overflow-auto space-y-3 pr-1">
          {messages.map((message, index) => (
            <div
              key={`${message.role}-${index}`}
              className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[92%] rounded-sm border px-3 py-2 text-[12.5px] leading-relaxed ${
                  message.role === "user"
                    ? "bg-[color:var(--teal)] text-[color:var(--paper)] border-[color:var(--teal)]"
                    : "bg-[color:var(--paper)]/40 text-[color:var(--ink)] border-[color:var(--rule)]"
                }`}
              >
                <div className="whitespace-pre-wrap">{message.content}</div>
                {message.role === "assistant" && message.sources.length > 0 ? (
                  <div className="mt-3 border-t border-[color:var(--rule)] pt-3">
                    <div className="smallcaps text-[10px] text-[color:var(--ink-soft)] mb-2">
                      Sources
                    </div>
                    <ul className="space-y-2 text-[11px] text-[color:var(--ink-soft)]">
                      {message.sources.map(source => (
                        <li key={source.citation} className="leading-snug">
                          <span className="font-semibold text-[color:var(--ink)]">
                            [{source.citation}]
                          </span>{" "}
                          {source.title}
                          {source.pageLabel ? ` · ${source.pageLabel}` : ""}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            </div>
          ))}
          <div ref={endRef} />
        </div>

        <form onSubmit={handleSubmit} className="space-y-2">
          <textarea
            aria-label="Literature chat question"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder="Ask about fetal ventriculomegaly, corpus callosum, posterior fossa, thresholds, or reporting language..."
            rows={3}
            className="w-full resize-none rounded-sm border border-[color:var(--rule)] bg-white px-3 py-2 text-[12.5px] leading-relaxed text-[color:var(--ink)] outline-none focus:border-[color:var(--teal)]"
          />
          <div className="flex items-center justify-between gap-3">
            <div className="text-[11px] text-[color:var(--ink-soft)]">
              Answers are grounded in the same indexed corpus as the report.
            </div>
            <button
              type="submit"
              disabled={isSending || !draft.trim()}
              className="inline-flex items-center gap-1.5 rounded-sm bg-[color:var(--teal)] px-3 py-1.5 text-xs smallcaps text-[color:var(--paper)] transition-colors hover:bg-[color:var(--ink)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
              Ask
            </button>
          </div>
        </form>
      </div>
    </article>
  );
}

const EMPTY_VALUES: Record<string, number | null> = Object.fromEntries([
  ...PARAMETERS_ALL.map(p => [p.id, null]),
  ...AUXILIARY_MEASUREMENTS.map(field => [field.id, null]),
  ...QUALITATIVE_FINDINGS.map(finding => [finding.id, null]),
]);

const TOTAL_MEASUREMENT_FIELDS =
  PARAMETERS_ALL.length +
  AUXILIARY_MEASUREMENTS.length +
  QUALITATIVE_FINDINGS.length;

// Reference cases for the sample loader.
//
// Both samples are pinned to the *50th-percentile prediction* of Luis 2025 at
// the chosen GA, so the resulting z-scores cluster around zero in the normal
// case and only depart from zero where the abnormal case intentionally
// breaks a threshold (atrial dilatation, absent CSP, short CC, small pons,
// small TCD, wide third ventricle, brain-OFD asymmetry).
const SAMPLE_NORMAL: Record<string, number | null> = {
  skull_bpd: 78.6, // mean(30) per Luis: -0.0527·900 + 5.7605·30 - 46.436
  skull_ofd: 95.5,
  brain_bpd: 66.4,
  brain_ofd_left: 85.5,
  brain_ofd_right: 85.5,
  atrial_left: 6.7,
  atrial_right: 6.7,
  tcd: 35.5,
  vermis_cc: 15.9,
  vermis_ap: 10.7,
  pons_ap: 9.9,
  cc_length: 35.4,
  csp_width: 7.7,
  third_ventricle: 1.8,
};

const SAMPLE_ABNORMAL: Record<string, number | null> = {
  skull_bpd: 70.0,
  skull_ofd: 86.0,
  brain_bpd: 62.0,
  brain_ofd_left: 78.0,
  brain_ofd_right: 78.0,
  atrial_left: 16.0, // severe VM
  atrial_right: 12.5, // asymmetric (>2 mm) and mild VM on R
  cc_length: 20.0, // short CC
  csp_width: 0.5, // absent CSP
  tcd: 25.0, // small TCD (z ≈ −2.5 at 26 w)
  vermis_cc: 14.0,
  vermis_ap: 9.0,
  pons_ap: 6.0, // small pons (z ≈ −4 at 26 w)
  third_ventricle: 5.0, // wide 3rd V
};

export default function Home() {
  const [ga, setGa] = useState<GA>({ weeks: 30, days: 0 });
  const [values, setValues] =
    useState<Record<string, number | null>>(EMPTY_VALUES);
  const [contextOpen, setContextOpen] = useState(false);
  const [fieldStrength, setFieldStrength] = useState("1.5T");
  const [motionSeverity, setMotionSeverity] = useState("None");
  const [focusedGroup, setFocusedGroup] = useState<string>("All");
  const [gaText, setGaText] = useState("");
  const [ragAnswer, setRagAnswer] = useState("");

  const { zs, dxs } = useMemo(() => evaluateAll(values, ga), [values, ga]);

  const report = useMemo(
    () =>
      generateReport({
        ga,
        fieldStrength,
        motion: motionSeverity,
        values,
        zs,
        dxs,
      }),
    [ga, fieldStrength, motionSeverity, values, zs, dxs]
  );

  useEffect(() => {
    setRagAnswer("");

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch("/api/rag", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ report }),
            signal: controller.signal,
          });

          if (!response.ok) {
            throw new Error(`RAG request failed with ${response.status}`);
          }

          const payload: unknown = await response.json();
          if (!controller.signal.aborted) {
            setRagAnswer(extractRagAnswer(payload));
          }
        } catch {
          if (!controller.signal.aborted) {
            setRagAnswer("");
          }
        }
      })();
    }, 400);

    return () => {
      controller.abort();
      window.clearTimeout(timeoutId);
    };
  }, [report]);

  const measuredCount = Object.values(values).filter(v => v != null).length;
  const abnormalCount = PARAMETERS_ALL.filter(p => {
    const z = zs[p.id];
    return z != null && Math.abs(z.z) > 2;
  }).length;
  const finalReport = ragAnswer
    ? `${report}\n\nLiterature Context (RAG)\n${ragAnswer}`
    : report;

  const handleCopy = async () => {
    try {
      await copyReportPlainText(finalReport);
      toast.success("Report copied to clipboard");
    } catch {
      toast.error("Unable to copy — select and copy manually");
    }
  };

  const handleClear = () => {
    setValues(EMPTY_VALUES);
    toast("Cleared all measurements");
  };

  const applyGaText = () => {
    const raw = gaText.trim();
    if (raw === "") return;
    const parsed = parseGestationalAge(raw);
    if (!parsed || parsed.weeks < 18 || parsed.weeks > 40) {
      toast.error("Enter GA as 24+3, 24w 3d, or 24.5w");
      return;
    }
    setGa(parsed);
    setGaText("");
  };

  const loadSample = (kind: "normal" | "abnormal") => {
    setValues(
      kind === "normal" ? { ...SAMPLE_NORMAL } : { ...SAMPLE_ABNORMAL }
    );
    setGa({
      weeks: kind === "normal" ? 30 : 24,
      days: kind === "normal" ? 0 : 4,
    });
    toast(
      kind === "normal"
        ? "Sample loaded: 30w0d, all within range"
        : "Sample loaded: 24w4d, flagged findings"
    );
  };

  const filteredGroups = focusedGroup === "All" ? GROUP_ORDER : [focusedGroup];

  // Highlight GA label on first render
  const gaPillRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    gaPillRef.current?.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 240,
      easing: "ease-out",
    });
  }, []);

  return (
    <div className="min-h-screen text-[color:var(--ink)]">
      {/* Top editorial banner */}
      <div className="border-b border-[color:var(--rule)] bg-[color:var(--paper)]/70 backdrop-blur-sm sticky top-0 z-30">
        <div className="container py-3 sm:py-4 flex flex-wrap items-center gap-x-5 gap-y-3">
          <div className="flex items-center gap-3 mr-auto sm:mr-0">
            <div className="h-8 w-8 rounded-sm border border-[color:var(--teal)] flex items-center justify-center">
              <svg
                viewBox="0 0 24 24"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
                style={{ color: "var(--teal)" }}
              >
                <path d="M12 21c-4.97 0-9-4.03-9-9 0-4.97 4.03-9 9-9s9 4.03 9 9c0 4.97-4.03 9-9 9z" />
                <path d="M3 14c3-2 6-2 9 0s6 2 9 0" />
                <path d="M3 10c3 2 6 2 9 0s6-2 9 0" />
              </svg>
            </div>
            <div className="leading-tight">
              <div className="font-display text-[19px] tracking-tight">
                Fetal Brain MRI Biometry
              </div>
              <div className="smallcaps text-[10px] text-[color:var(--ink-soft)]">
                Offline · Client-side · No PHI
              </div>
            </div>
          </div>

          <div className="h-8 w-px bg-[color:var(--rule)] hidden sm:block" />

          {/* GA input */}
          <div
            ref={gaPillRef}
            className="flex items-center gap-2 sm:gap-3 min-w-0"
          >
            <div className="smallcaps text-[color:var(--ink-soft)] hidden md:block">
              Gestational age
            </div>
            <div className="smallcaps text-[color:var(--ink-soft)] md:hidden">
              GA
            </div>
            <div className="flex items-center gap-1 border border-[color:var(--rule)] rounded-sm bg-white px-2 py-1">
              <Select
                value={String(ga.weeks)}
                onValueChange={v => setGa(g => ({ ...g, weeks: +v }))}
              >
                <SelectTrigger className="h-7 min-w-[68px] border-0 shadow-none font-numeric text-[15px] px-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 23 }, (_, i) => 18 + i).map(w => (
                    <SelectItem
                      key={w}
                      value={String(w)}
                      className="font-numeric"
                    >
                      {w} w
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-[color:var(--ink-soft)]">·</span>
              <Select
                value={String(ga.days)}
                onValueChange={v => setGa(g => ({ ...g, days: +v }))}
              >
                <SelectTrigger className="h-7 min-w-[60px] border-0 shadow-none font-numeric text-[15px] px-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 7 }, (_, i) => i).map(d => (
                    <SelectItem
                      key={d}
                      value={String(d)}
                      className="font-numeric"
                    >
                      {d} d
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="font-numeric text-xs text-[color:var(--ink-soft)]">
              = {gaToDecimalWeeks(ga).toFixed(1)} w
            </div>
            <input
              aria-label="Quick gestational age entry"
              value={gaText}
              onChange={e => setGaText(e.target.value)}
              onBlur={applyGaText}
              onKeyDown={e => {
                if (e.key === "Enter") {
                  e.currentTarget.blur();
                }
              }}
              placeholder="24+3"
              className="w-[68px] h-7 bg-white border border-[color:var(--rule)] rounded-sm px-2 font-numeric text-xs text-[color:var(--ink)] placeholder:text-[color:var(--ink-soft)]/50 outline-none focus:border-[color:var(--teal)]"
            />
          </div>

          <div className="w-full sm:w-auto sm:ml-auto flex items-center gap-1.5 sm:gap-2 flex-wrap">
            <button
              onClick={() => loadSample("normal")}
              className="text-xs smallcaps text-[color:var(--ink-soft)] hover:text-[color:var(--teal)] transition-colors flex items-center gap-1.5 px-2 py-1"
            >
              <Sparkles className="h-3 w-3" />
              <span className="hidden sm:inline">Sample:&nbsp;</span>normal
            </button>
            <button
              onClick={() => loadSample("abnormal")}
              className="text-xs smallcaps text-[color:var(--ink-soft)] hover:text-[color:var(--state-rare)] transition-colors flex items-center gap-1.5 px-2 py-1"
            >
              <Sparkles className="h-3 w-3" />
              <span className="hidden sm:inline">Sample:&nbsp;</span>flagged
            </button>
            <button
              onClick={handleClear}
              className="text-xs smallcaps text-[color:var(--ink-soft)] hover:text-[color:var(--ink)] transition-colors flex items-center gap-1.5 px-2 py-1 border border-[color:var(--rule)] rounded-sm"
            >
              <RotateCcw className="h-3 w-3" /> Clear All
            </button>
            <button
              onClick={handleCopy}
              className="text-xs smallcaps text-[color:var(--paper)] bg-[color:var(--teal)] hover:bg-[color:var(--ink)] transition-colors flex items-center gap-1.5 px-3 py-1.5 rounded-sm"
            >
              <Copy className="h-3 w-3" />
              <span className="hidden sm:inline">Copy to Clipboard</span>
              <span className="sm:hidden">Copy</span>
            </button>
            <Link
              href="/methodology"
              className="text-xs smallcaps text-[color:var(--ink-soft)] hover:text-[color:var(--teal)] transition-colors flex items-center gap-1.5 px-2 py-1"
            >
              <BookOpen className="h-3 w-3" />
              <span className="hidden md:inline">Methodology</span>
              <span className="md:hidden">Docs</span>
            </Link>
          </div>
        </div>

        {/* Imaging context collapsible */}
        <div className="border-t border-[color:var(--rule)] bg-white/40">
          <div className="container">
            <Collapsible open={contextOpen} onOpenChange={setContextOpen}>
              <CollapsibleTrigger className="w-full flex items-center justify-between py-2.5 text-left">
                <div className="flex items-center gap-3">
                  <span className="smallcaps text-[color:var(--ink-soft)]">
                    Imaging context
                  </span>
                  <span className="text-xs text-[color:var(--ink-soft)]">
                    {fieldStrength} · motion {motionSeverity.toLowerCase()} ·{" "}
                    multi-source consensus
                  </span>
                </div>
                <ChevronDown
                  className={`h-4 w-4 transition-transform ${contextOpen ? "rotate-180" : ""}`}
                />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="grid md:grid-cols-3 gap-6 py-4 border-t border-[color:var(--rule)]">
                  <div>
                    <div className="smallcaps text-[color:var(--ink-soft)] mb-2">
                      Field strength
                    </div>
                    <Select
                      value={fieldStrength}
                      onValueChange={setFieldStrength}
                    >
                      <SelectTrigger className="w-full bg-white border-[color:var(--rule)]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {["0.55T", "1.5T", "3T"].map(v => (
                          <SelectItem key={v} value={v}>
                            {v}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <div className="smallcaps text-[color:var(--ink-soft)] mb-2">
                      Motion severity
                    </div>
                    <Select
                      value={motionSeverity}
                      onValueChange={setMotionSeverity}
                    >
                      <SelectTrigger className="w-full bg-white border-[color:var(--rule)]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {["None", "Mild", "Moderate", "Severe"].map(v => (
                          <SelectItem key={v} value={v}>
                            {v}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <div className="smallcaps text-[color:var(--ink-soft)] mb-2">
                      Consensus mode
                    </div>
                    <div className="w-full bg-white border border-[color:var(--rule)] rounded-sm px-3 py-2 text-sm text-[color:var(--ink)]">
                      Multi-source consensus
                    </div>
                    <p className="text-[11px] text-[color:var(--ink-soft)] leading-snug mt-2">
                      Every measurement is evaluated against all applicable
                      source-registry entries. Consensus is the mean of in-range
                      z-scores; Delta z &gt;= 1.0 is flagged as source
                      disagreement.
                    </p>
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>
        </div>
      </div>

      {/* Body */}
      <main className="container grid grid-cols-12 gap-x-6 gap-y-10 lg:gap-10 pt-8 sm:pt-10 pb-16 sm:pb-24">
        {/* Left column — parameters */}
        <section className="col-span-12 lg:col-span-7 min-w-0">
          <div className="mb-6 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 sm:gap-4">
            <div>
              <div className="smallcaps text-[color:var(--teal)]">
                Biometry worksheet
              </div>
              <h1 className="font-display text-[32px] sm:text-[40px] lg:text-[44px] leading-[1.05] tracking-tight mt-1">
                Measure, convert, interpret.
              </h1>
              <p className="text-[color:var(--ink-soft)] text-[15px] max-w-[48ch] mt-3">
                Enter any subset of the fetal brain and posterior-fossa
                measurements. Z-scores and percentiles compute live against the
                source registry where normative models are available.
              </p>
            </div>

            <div className="shrink-0 sm:text-right">
              <div className="font-numeric text-[13px] text-[color:var(--ink-soft)]">
                {measuredCount}/{TOTAL_MEASUREMENT_FIELDS} measured
              </div>
              <div
                className={`font-numeric text-[13px] ${
                  abnormalCount > 0
                    ? "text-[color:var(--state-rare)]"
                    : "text-[color:var(--state-normal)]"
                }`}
              >
                {abnormalCount} flagged (|z| &gt; 2)
              </div>
            </div>
          </div>

          <Tabs
            value={focusedGroup}
            onValueChange={setFocusedGroup}
            className="mb-4 -mx-1 px-1 overflow-x-auto"
          >
            <TabsList className="bg-transparent p-0 gap-1 h-auto flex-nowrap sm:flex-wrap">
              {["All", ...GROUP_ORDER].map(g => (
                <TabsTrigger
                  key={g}
                  value={g}
                  className="shrink-0 whitespace-nowrap bg-transparent border border-[color:var(--rule)] rounded-sm smallcaps data-[state=active]:bg-[color:var(--teal)] data-[state=active]:text-[color:var(--paper)] data-[state=active]:border-[color:var(--teal)]"
                >
                  {g}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          <div className="hidden md:grid md:grid-cols-12 gap-3 pb-2 border-b border-[color:var(--ink)]/70">
            <div className="col-span-5 smallcaps text-[color:var(--ink-soft)]">
              Parameter
            </div>
            <div className="col-span-2 smallcaps text-[color:var(--ink-soft)] text-right">
              Value
            </div>
            <div className="col-span-2 smallcaps text-[color:var(--ink-soft)] text-center">
              Distribution
            </div>
            <div className="col-span-3 smallcaps text-[color:var(--ink-soft)] text-right">
              z · percentile
            </div>
          </div>

          <div>
            {filteredGroups.map(group => (
              <div key={group} className="pt-4">
                <h3 className="font-display text-[19px] text-[color:var(--ink)] mb-1">
                  § {group}
                </h3>
                {PARAMETERS_ALL.filter(p => p.group === group).map(p => (
                  <ParameterRow
                    key={p.id}
                    param={p}
                    value={values[p.id]}
                    zr={zs[p.id]}
                    onChange={v => setValues(prev => ({ ...prev, [p.id]: v }))}
                    ga={ga}
                  />
                ))}
                {AUXILIARY_MEASUREMENTS.filter(
                  field => field.group === group
                ).map(field => (
                  <AuxiliaryMeasurementRow
                    key={field.id}
                    field={field}
                    value={values[field.id] ?? null}
                    onChange={v =>
                      setValues(prev => ({ ...prev, [field.id]: v }))
                    }
                  />
                ))}
                {QUALITATIVE_FINDINGS.filter(
                  finding => finding.group === group
                ).map(finding => (
                  <QualitativeFindingRow
                    key={finding.id}
                    finding={finding}
                    value={values[finding.id] ?? null}
                    onChange={v =>
                      setValues(prev => ({ ...prev, [finding.id]: v }))
                    }
                  />
                ))}
              </div>
            ))}
          </div>

          <div className="mt-8 text-[11px] text-[color:var(--ink-soft)] leading-relaxed border-t border-[color:var(--rule)] pt-4">
            Active mode:{" "}
            <span className="text-[color:var(--ink)]">
              multi-source consensus
            </span>
            . Per-row source labels, agreement badges, and the structured report
            update live as gestational age or measurements change. See the{" "}
            <Link
              href="/validation"
              className="underline decoration-[color:var(--teal)]"
            >
              validation page
            </Link>{" "}
            for worked examples and per-parameter cross-checks.
          </div>
        </section>

        {/* Right column — report + differentials */}
        <aside className="col-span-12 lg:col-span-5 space-y-8 min-w-0">
          <div className="lg:sticky lg:top-[148px] space-y-8">
            <article className="bg-white border border-[color:var(--rule)] rounded-sm">
              <header className="flex items-center justify-between border-b border-[color:var(--rule)] px-5 py-3">
                <div>
                  <div className="smallcaps text-[color:var(--teal)]">
                    Structured report
                  </div>
                  <div className="font-display text-[15px] mt-0.5">
                    ESPR-style · PowerScribe-ready
                  </div>
                </div>
              </header>
              <textarea
                aria-label="Structured report preview"
                readOnly
                value={finalReport}
                spellCheck={false}
                className="block w-full h-[440px] resize-none border-0 bg-white px-5 py-4 text-[12.5px] leading-relaxed font-numeric text-[color:var(--ink)] outline-none overflow-auto"
              />
              <footer className="border-t border-[color:var(--rule)] px-5 py-3 flex justify-end">
                <button
                  onClick={handleCopy}
                  className="text-xs smallcaps text-[color:var(--paper)] bg-[color:var(--teal)] hover:bg-[color:var(--ink)] transition-colors flex items-center gap-1.5 px-3 py-1.5 rounded-sm whitespace-nowrap"
                >
                  <Copy className="h-3 w-3" /> Copy to Clipboard
                </button>
              </footer>
            </article>

            <LiteratureChatPanel report={report} />

            <DifferentialPanel dxs={dxs} />
          </div>
        </aside>
      </main>

      <footer className="border-t border-[color:var(--rule)] bg-white/50">
        <div className="container py-8 flex flex-wrap gap-4 items-start justify-between text-[12px] text-[color:var(--ink-soft)]">
          <div className="max-w-xl">
            Workflow-integrated fetal brain MRI biometry calculator. Normative
            reference data: Luis&nbsp;2025 (auto-proc-SVRTK), with
            cross-validation against Tilea&nbsp;2009, Kyriakopoulou&nbsp;2017,
            Vatansever&nbsp;2013, Dovjak&nbsp;2021, Kertes&nbsp;2021,
            Conte&nbsp;2018, and third-ventricle raw-threshold checks. No
            patient data is transmitted or stored; refreshing the page clears
            all inputs.
          </div>
          <div className="flex items-center gap-5">
            <Link href="/methodology" className="cite">
              Read methodology →
            </Link>
            <Link href="/validation" className="cite">
              Validation &amp; worked examples →
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
