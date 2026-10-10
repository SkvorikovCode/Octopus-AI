import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { DotSpinner, Icon } from "./Glyphs";
import { locale, t, tn } from "../lib/i18n";
import "./fileviewer.css";

export type FileContent = {
  path: string;
  text: string;
  lines: number;
  bytes: number;
  truncated: boolean;
  language: string;
};

export type FileViewerProps = {
  cwd: string;
  path: string;
  line?: number;
  onClose: () => void;
};

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; file: FileContent; demo: boolean };

type CopyKey = "path" | "all";

const TINT_MAX_LINES = 4000;
const COPY_FEEDBACK_MS = 1500;

// ---------------------------------------------------------------------------
// Tokenizer: per-line, regex-based, no library. Output is React nodes only.
// ---------------------------------------------------------------------------

type Family = { re: RegExp; keywords: Set<string>; ci: boolean };

const words = (list: string) => new Set(list.split(/\s+/).filter(Boolean));

// Shared string and word alternatives. Strings must be closed on the same line.
const STRING_SRC = String.raw`"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\x60(?:\\.|[^\x60\\])*\x60`;
const WORD_SRC = String.raw`[A-Za-z_]\w*`;

function makeFamily(commentSrc: string, keywords: Set<string>, ci = false): Family {
  return {
    re: new RegExp(`(${commentSrc})|(${STRING_SRC})|(${WORD_SRC})`, "g"),
    keywords,
    ci,
  };
}

const FAMILIES: Record<string, Family> = {
  js: makeFamily(
    String.raw`\/\/.*$`,
    words("const let var function return if else for while import export from class new await async type interface null true false"),
  ),
  rust: makeFamily(
    String.raw`\/\/.*$`,
    words("fn pub use impl struct enum match let const return if else for while self async await mod trait true false"),
  ),
  py: makeFamily(
    String.raw`#.*$`,
    words("def class import from return if else for while None True False self async await"),
  ),
  sh: makeFamily(
    String.raw`#.*$`,
    words("if then else elif fi for while do done case esac function export return local in"),
  ),
  cfg: makeFamily(String.raw`#.*$`, words("true false null")),
  sql: makeFamily(
    String.raw`--.*$`,
    words("select from where insert into values update set delete create table join left right inner on and or not null as order by group having limit distinct"),
    true,
  ),
  plain: makeFamily(String.raw`\/\/.*$`, new Set()),
};

const FAMILY_BY_NAME: Record<string, string> = {
  typescript: "js", ts: "js", tsx: "js", javascript: "js", js: "js", jsx: "js", mjs: "js", cjs: "js",
  rust: "rust", rs: "rust",
  python: "py", py: "py",
  shell: "sh", bash: "sh", sh: "sh", zsh: "sh",
  yaml: "cfg", yml: "cfg", toml: "cfg",
  sql: "sql",
};

function familyFor(language: string, path: string): Family {
  const ext = path.includes(".") ? (path.split(".").pop() ?? "").toLowerCase() : "";
  const byLang = FAMILY_BY_NAME[language.toLowerCase()];
  if (byLang) return FAMILIES[byLang];
  const byExt = FAMILY_BY_NAME[ext];
  return FAMILIES[byExt] ?? FAMILIES.plain;
}

function tokenize(line: string, fam: Family): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = fam.re;
  re.lastIndex = 0;
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const text = m[0];
    if (m.index > last) out.push(line.slice(last, m.index));
    let cls: string | undefined;
    if (m[1] !== undefined) cls = "fv-c";
    else if (m[2] !== undefined) cls = "fv-s";
    else if (fam.keywords.has(fam.ci ? text.toLowerCase() : text)) cls = "fv-k";
    out.push(cls ? <span key={key++} className={cls}>{text}</span> : text);
    last = m.index + text.length;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function splitLines(text: string): string[] {
  const parts = text.split("\n");
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  return parts.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

function formatKb(bytes: number): string {
  return (Math.round((bytes / 1024) * 10) / 10).toLocaleString(locale(), { maximumFractionDigits: 1 });
}

/** Path shown in the header: project-relative when inside cwd, otherwise as given. */
function toRelative(cwd: string, path: string): string {
  const base = cwd.replace(/\/+$/, "");
  if (base && path.startsWith(`${base}/`)) return path.slice(base.length + 1);
  return path.replace(/^\.\//, "");
}

function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

const DEMO_SAMPLE = `// Демо-содержимое: вне Tauri файл не читается, показан пример TypeScript.
export interface ProjectFile {
  path: string;
  text: string;
  lines: number;
  bytes: number;
  truncated: boolean;
  language: string;
}

const LIMIT_BYTES = 2 * 1024 * 1024;
const TINT_MAX_LINES = 4000;

/** Читает файл внутри проекта и возвращает начальный фрагмент. */
export async function readProjectFile(cwd: string, path: string): Promise<ProjectFile> {
  const full = path.startsWith("/") ? path : \`\${cwd}/\${path}\`;
  const buf = await loadBytes(full);
  const truncated = buf.byteLength > LIMIT_BYTES;
  const slice = truncated ? buf.subarray(0, LIMIT_BYTES) : buf;
  const text = new TextDecoder().decode(slice);
  return {
    path,
    text,
    lines: text.split("\\n").length,
    bytes: buf.byteLength,
    truncated,
    language: languageOf(path),
  };
}

function languageOf(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const known: Record<string, string> = { ts: "typescript", tsx: "typescript", rs: "rust", py: "python" };
  return known[ext] ?? "text";
}

/** Файлы крупнее порога показываются без подсветки. */
export function isLarge(file: ProjectFile): boolean {
  return file.lines > TINT_MAX_LINES;
}
`;

function demoFile(path: string): FileContent {
  const text = t(DEMO_SAMPLE);
  return {
    path,
    text,
    lines: splitLines(text).length,
    bytes: new TextEncoder().encode(text).length,
    truncated: false,
    language: "typescript",
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function FileViewer({ cwd, path, line, onClose }: FileViewerProps): React.ReactElement {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [copied, setCopied] = useState<CopyKey | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const rel = useMemo(() => toRelative(cwd, path), [cwd, path]);
  const slash = rel.lastIndexOf("/");
  const name = slash >= 0 ? rel.slice(slash + 1) : rel;
  const dir = slash > 0 ? rel.slice(0, slash) : "";

  // Load the file (or demo content outside Tauri).
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    const tauri = isTauri();
    const request: Promise<FileContent> = tauri
      ? invoke<FileContent>("read_project_file", { cwd, path })
      : Promise.resolve(demoFile(path));
    request.then(
      (file) => {
        if (!cancelled) setState({ status: "ready", file, demo: !tauri });
      },
      (err: unknown) => {
        if (!cancelled) setState({ status: "error", message: errorText(err) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [cwd, path, attempt]);

  const file = state.status === "ready" ? state.file : null;
  const demo = state.status === "ready" && state.demo;

  const lines = useMemo(() => (file ? splitLines(file.text) : []), [file]);
  const tinted = lines.length <= TINT_MAX_LINES;
  const family = useMemo(() => familyFor(file?.language ?? "", rel), [file?.language, rel]);
  const rendered = useMemo(
    () => lines.map((text) => (tinted ? tokenize(text, family) : text)),
    [lines, tinted, family],
  );
  const digits = String(lines.length).length;

  // Scroll the requested line into view once the file is shown.
  useEffect(() => {
    if (!line || !file) return;
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-line="${line}"]`);
    el?.scrollIntoView({ block: "center" });
  }, [line, file]);

  // Escape closes the drawer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Copy feedback resets after 1.5 s.
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(null), COPY_FEEDBACK_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = useCallback(async (text: string, key: CopyKey) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
    } catch {
      setCopied(null);
    }
  }, []);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const metaText = file
    ? `${tn(file.lines, "строка|строки|строк")} · ${formatKb(file.bytes)} ${t("КБ")} · ${file.language}`
    : null;

  return (
    <aside className="card fv-root" role="dialog" aria-label={t("Файл {name}", { name })}>
      <header className="fv-head">
        <div className="fv-title">
          <div className="fv-name" title={rel}>{name}</div>
          <div className="fv-dir" title={dir || rel}>
            <bdi>{dir || t("корень проекта")}</bdi>
          </div>
        </div>

        {metaText && <span className="fv-meta">{metaText}</span>}

        <div className="fv-actions">
          <button
            type="button"
            className={`btn fv-btn${copied === "path" ? " is-done" : ""}`}
            onClick={() => copy(rel, "path")}
          >
            {copied === "path" ? <Icon name="check" size={13} /> : null}
            {copied === "path" ? t("Скопировано") : t("Копировать путь")}
          </button>
          <button
            type="button"
            className={`btn fv-btn${copied === "all" ? " is-done" : ""}`}
            onClick={() => file && copy(file.text, "all")}
            disabled={!file}
          >
            {copied === "all" ? <Icon name="check" size={13} /> : null}
            {copied === "all" ? t("Скопировано") : t("Копировать всё")}
          </button>
          <button type="button" className="icon-btn" aria-label={t("Закрыть")} onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
      </header>

      <div className="fv-body">
        {demo && <div className="fv-banner">{t("Демо-содержимое: в браузере файл не читается")}</div>}
        {file?.truncated && <div className="fv-banner">{t("Показан начальный фрагмент — файл больше 2 МБ")}</div>}

        {state.status === "loading" && (
          <div className="fv-center">
            <DotSpinner size={18} />
            <span>{t("Загрузка…")}</span>
          </div>
        )}

        {state.status === "error" && (
          <div className="fv-errwrap">
            <div className="err-card" role="alert">
              <span>{t("Не удалось открыть файл: {message}", { message: state.message })}</span>
            </div>
            <button type="button" className="btn fv-btn" onClick={retry}>
              <Icon name="refresh" size={13} />
              {t("Повторить")}
            </button>
          </div>
        )}

        {file && (
          <div className="fv-scroll" ref={scrollRef}>
            <div className="fv-lines">
              {lines.map((_, i) => {
                const n = i + 1;
                const hl = line === n;
                return (
                  <div key={n} className={hl ? "fv-row hl" : "fv-row"} data-line={n}>
                    <span className="fv-ln" style={{ width: `calc(${digits}ch + 28px)` }}>
                      {n}
                    </span>
                    <span className="fv-code">{rendered[i]}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
