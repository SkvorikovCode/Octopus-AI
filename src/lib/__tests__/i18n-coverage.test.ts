// Regression guard for the Russian-source i18n: every Russian literal passed to
// t() / tn() / tw() must have an English entry, and the dictionary itself must
// stay consistent (no empty values, placeholders match the Russian keys).
//
// Sources are read at build time with import.meta.glob (?raw), so no Node
// typings are needed. Files under __tests__ and src/i18n are skipped.

import { describe, expect, it } from "vitest";
import { EN } from "../../i18n/en";
import { DEFAULT_TEMPLATES } from "../templates";

const RAW_SOURCES = import.meta.glob("../../**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Glob keys are relative to this file; reduce them to a path under src/ (e.g. "lib/budget.ts"). */
function srcRelative(key: string): string {
  const abs = new URL(key, import.meta.url).pathname;
  return abs.slice(abs.lastIndexOf("/src/") + "/src/".length);
}

const SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(RAW_SOURCES).map(([key, text]) => [srcRelative(key), text]),
);

const isScanned = (rel: string) => !rel.includes("__tests__/") && !rel.startsWith("i18n/");

type Hit = { file: string; line: number; fn: "t" | "tn" | "tw"; key: string };

/** Replaces comment text with spaces (newlines kept), leaving string literals intact. */
function stripComments(src: string): string {
  const out = src.split("");
  const n = src.length;
  let i = 0;
  let quote: string | null = null; // ' or " end at the newline (JSX text can hold a stray apostrophe)
  let backtick = false;
  while (i < n) {
    const c = src[i];
    if (quote) {
      if (c === "\\") i += 2;
      else if (c === quote || c === "\n") {
        quote = null;
        i++;
      } else i++;
      continue;
    }
    if (backtick) {
      if (c === "\\") i += 2;
      else {
        if (c === "`") backtick = false;
        i++;
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") out[i++] = " ";
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] !== "\n") out[i] = " ";
        i++;
      }
      if (i < n) {
        out[i] = " ";
        out[i + 1] = " ";
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "`") backtick = true;
    i++;
  }
  return out.join("");
}

function unescapeLiteral(raw: string): string {
  const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r" };
  return raw.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_m, e: string) => {
    if ((e[0] === "u" && e.length === 5) || (e[0] === "x" && e.length === 3)) {
      return String.fromCharCode(parseInt(e.slice(1), 16));
    }
    return simple[e] ?? e;
  });
}

/**
 * Reads a plain string literal starting at `pos`. Returns null for anything that
 * is not a complete static literal: a template with ${...}, or a value that is
 * concatenated or used in an expression (the key would be only part of the text).
 */
function readLiteral(src: string, pos: number): { value: string; end: number } | null {
  const q = src[pos];
  if (q !== '"' && q !== "'" && q !== "`") return null;
  let i = pos + 1;
  let raw = "";
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") {
      raw += c + (src[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (c === q) break;
    if (q !== "`" && c === "\n") return null;
    if (q === "`" && c === "$" && src[i + 1] === "{") return null;
    raw += c;
    i++;
  }
  if (src[i] !== q) return null;
  let next = i + 1;
  while (next < src.length && /\s/.test(src[next])) next++;
  if (src[next] !== "," && src[next] !== ")") return null;
  return { value: unescapeLiteral(raw), end: i + 1 };
}

/** Skips the first argument of tn()/tw() (a number expression) up to the top-level comma. */
function skipFirstArg(src: string, pos: number): number | null {
  let depth = 0;
  let i = pos;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < src.length && src[i] !== c) i += src[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return null;
      depth--;
    } else if (c === "," && depth === 0) return i + 1;
    else if (c === ";") return null;
    i++;
  }
  return null;
}

function extractHits(file: string, source: string): Hit[] {
  const src = stripComments(source);
  const hits: Hit[] = [];
  const callRe = /(?<![\w$.])(t|tn|tw)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(src))) {
    const fn = m[1] as Hit["fn"];
    let pos = m.index + m[0].length;
    if (fn !== "t") {
      const after = skipFirstArg(src, pos);
      if (after === null) continue;
      pos = after;
    }
    while (pos < src.length && /\s/.test(src[pos])) pos++;
    const lit = readLiteral(src, pos);
    if (!lit) continue;
    const line = src.slice(0, pos).split("\n").length;
    hits.push({ file, line, fn, key: lit.value });
  }
  return hits;
}

const CYRILLIC = /[Ѐ-ӿ]/;
const PLACEHOLDER = /\{(\w+)\}/g;

function placeholders(s: string): string[] {
  return [...new Set([...s.matchAll(PLACEHOLDER)].map((x) => x[1]))].sort();
}

const hasEntry = (key: string) => Object.prototype.hasOwnProperty.call(EN, key);

describe("i18n coverage", () => {
  const hits = Object.entries(SOURCES)
    .filter(([file]) => isScanned(file))
    .flatMap(([file, source]) => extractHits(file, source));

  it("finds the translatable literals (scanner sanity check)", () => {
    expect(hits.length).toBeGreaterThan(100);
    expect(hits.some((h) => h.fn === "tn")).toBe(true);
    expect(hits.some((h) => h.fn === "tw")).toBe(true);
  });

  it("the extractor reads static literals only (no comments, ${}, ternaries or foo.t())", () => {
    const sample = [
      't("Новая сессия");',
      'tn(2, "файл|файла|файлов");',
      'tw(1, "файл|файла|файлов");',
      "t(`x ${y}`);",
      '// t("Комментарий")',
      't(cond ? "a" : "b");',
      'foo.t("Нет");',
      'const s = "https://example.com"; t(\n  "Перенос строки",\n  { n: 1 },\n);',
    ].join("\n");
    expect(extractHits("sample.tsx", sample).map((h) => `${h.fn}:${h.key}`)).toEqual([
      "t:Новая сессия",
      "tn:файл|файла|файлов",
      "tw:файл|файла|файлов",
      "t:Перенос строки",
    ]);
  });

  it("every Cyrillic key passed to t/tn/tw exists in the English dictionary", () => {
    const missing = new Map<string, string>();
    for (const h of hits) {
      if (!CYRILLIC.test(h.key) || hasEntry(h.key)) continue;
      if (!missing.has(h.key)) missing.set(h.key, `src/${h.file}:${h.line} (${h.fn})`);
    }
    const list = [...missing].map(([key, where]) => `  ${JSON.stringify(key)}  <- ${where}`);
    expect(
      missing.size,
      `${missing.size} Russian key(s) without an English entry:\n${list.join("\n")}`,
    ).toBe(0);
  });

  it("built-in prompt templates have English texts (they are translated at runtime, not via a literal)", () => {
    const missing = DEFAULT_TEMPLATES.flatMap((tpl) =>
      [tpl.title, tpl.body].filter((s) => !hasEntry(s)).map((s) => `${tpl.id}: ${JSON.stringify(s)}`),
    );
    expect(missing, `Missing dictionary entries:\n${missing.join("\n")}`).toEqual([]);
  });

  it("no English value is empty", () => {
    const empty = Object.entries(EN)
      .filter(([, en]) => typeof en !== "string" || en.trim() === "")
      .map(([ru]) => JSON.stringify(ru));
    expect(empty, `Empty English values for:\n${empty.join("\n")}`).toEqual([]);
  });

  it("English placeholders match the placeholders of the Russian key", () => {
    const mismatched = Object.entries(EN)
      .filter(([ru, en]) => JSON.stringify(placeholders(ru)) !== JSON.stringify(placeholders(en)))
      .map(([ru, en]) => `${JSON.stringify(ru)} [${placeholders(ru)}] -> ${JSON.stringify(en)} [${placeholders(en)}]`);
    expect(mismatched, `Placeholder mismatch:\n${mismatched.join("\n")}`).toEqual([]);
  });
});

// Engine internals must never reach the UI copy. Only the .tsx components and App.tsx
// render text; import paths, identifiers, comments and JSX attribute names are skipped.
const ENGINE_NAME = /\bomp\b|oh-my-pi|models\.yml/i;
const NON_COPY_ATTR = /(?:className|class|id|key|href|src|type|name|role|style|htmlFor|data-[\w-]+|aria-[\w-]+|testid|to)\s*=\s*\{?\s*$/;
const NON_COPY_CONTEXT = /(?:\bfrom|\bimport|\brequire|\bimport\()\s*$/;

type EngineHit = { file: string; line: number; text: string };

function engineNameHits(file: string, source: string): EngineHit[] {
  const src = stripComments(source);
  const hits: EngineHit[] = [];
  const lines = src.split("\n");
  const push = (index: number) => {
    const line = src.slice(0, index).split("\n").length;
    hits.push({ file, line, text: lines[line - 1].trim() });
  };
  // 1) string literals: "...", '...' and `...`, skipping import sources and JSX attribute names.
  const litRe = /(["'`])((?:\\[\s\S]|(?!\1)[^\\\n])*?)\1/g;
  let m: RegExpExecArray | null;
  while ((m = litRe.exec(src))) {
    if (!ENGINE_NAME.test(m[2])) continue;
    const before = src.slice(Math.max(0, m.index - 80), m.index);
    if (NON_COPY_CONTEXT.test(before) || NON_COPY_ATTR.test(before)) continue;
    push(m.index);
  }
  // 2) JSX text: the run of text between a tag's ">" and the next "<" or "{".
  const jsxRe = /(?<=[^=\s]>)([^<>{}\n]+)(?=[<{])/g;
  while ((m = jsxRe.exec(src))) {
    if (ENGINE_NAME.test(m[1])) push(m.index);
  }
  return hits;
}

describe("engine names stay out of UI copy", () => {
  it("no string literal in components or App.tsx mentions omp / oh-my-pi / models.yml", () => {
    const uiFiles = Object.entries(SOURCES).filter(
      ([file]) => file === "App.tsx" || (file.startsWith("components/") && file.endsWith(".tsx")),
    );
    expect(uiFiles.length).toBeGreaterThan(10);
    const found = uiFiles.flatMap(([file, source]) => engineNameHits(`src/${file}`, source));
    const list = found.map((h) => `  ${h.file}:${h.line}  ${h.text}`);
    expect(found, `Engine name in UI copy:\n${list.join("\n")}`).toEqual([]);
  });

  it("the scanner flags UI copy and ignores imports, identifiers and comments", () => {
    const sample = [
      'import { OmpClient } from "./lib/omp";',
      "// omp reads models.yml at startup",
      "const omp = 1;",
      "export const A = () => <p>Запущен omp, читайте models.yml</p>;",
      'const compact = "compact the prompt";',
    ].join("\n");
    const found = engineNameHits("src/sample.tsx", sample).map((h) => h.line);
    expect(found).toEqual([4]);
  });

  it("the ENGINE_NAME matcher ignores compact / prompt and catches the real names", () => {
    expect(ENGINE_NAME.test("compact the prompt")).toBe(false);
    expect(ENGINE_NAME.test("Запущен omp")).toBe(true);
    expect(ENGINE_NAME.test("Edit models.yml")).toBe(true);
    expect(ENGINE_NAME.test("oh-my-pi engine")).toBe(true);
  });
});
