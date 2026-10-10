// Dependency-free Markdown renderer for agent replies.
// A small block parser builds a plain tree, then React elements are created from it.
// No HTML is injected: every node is a React element or a plain string.
// Streaming-safe: an unclosed fence renders as an open code block, and any parse
// failure falls back to the raw text instead of throwing.

import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { t } from "../lib/i18n";
import "./markdown.css";

type Align = "left" | "center" | "right" | undefined;
type Kind = "strong" | "em" | "del" | "bi";
type Marker = { indent: number; ordered: boolean; num: number; content: string; off: number };
type ListItem = { checked?: boolean; blocks: Block[] };
type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "p"; lines: string[] }
  | { kind: "code"; lang: string; code: string }
  | { kind: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { kind: "quote"; blocks: Block[] }
  | { kind: "hr" }
  | { kind: "table"; align: Align[]; head: string[]; rows: string[][] };

const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const QUOTE = /^ {0,3}>/;
const FENCE = /^( *)(`{3,}|~{3,})(.*)$/;
const HR = /^ {0,3}([-*_])( *\1){2,} *$/;
const MARKER = /^( *)([-*+]|(\d{1,9})[.)])(?:( +)(.*))?$/;
const TASK = /^\[([ xX])\](?:\s+(.*)|$)/;
const ESC = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
const SAFE_URL = /^(https?:\/\/\S+|mailto:\S+)$/i;
// Longest delimiters first, so "***" wins over "**" and "*".
const EMPH: Record<string, [string, Kind][]> = {
  "*": [["***", "bi"], ["**", "strong"], ["*", "em"]],
  _: [["___", "bi"], ["__", "strong"], ["_", "em"]],
  "~": [["~~", "del"]],
};

// File paths in inline code become buttons that open the file viewer.
let fileOpener: ((path: string, line?: number) => void) | undefined;
/** App registers how to open a project file from a reply. */
export function setMarkdownFileOpener(fn: typeof fileOpener) {
  fileOpener = fn;
}

// Path with an extension, optional ":line" or ":line:col" suffix.
const FILE_REF = /^((?:\.{0,2}\/)?(?:[\w@.-]+\/)*[\w@.-]+\.([A-Za-z0-9]{1,8}))(?::(\d+))?(?::\d+)?$/;
const FILE_EXT = new Set(
  "ts tsx js jsx mjs cjs json md mdx css scss html rs toml yaml yml py go rb java kt swift c h cpp hpp cs php sh zsh txt lock sql vue svelte".split(" ")
);

/** Path and line when the whole inline code span is a file reference, else null. */
function parseFileRef(text: string): { path: string; line?: number } | null {
  if (text.includes("://") || /\s/.test(text)) return null;
  const m = FILE_REF.exec(text);
  if (!m) return null;
  // Bare names like "example.com" or "1.2.3" are not files: require a slash or a known extension.
  if (!m[1].includes("/") && !FILE_EXT.has(m[2].toLowerCase())) return null;
  return { path: m[1], line: m[3] !== undefined ? parseInt(m[3], 10) : undefined };
}

const isBlank = (s: string) => s.trim() === "";
const indentOf = (s: string) => /^ */.exec(s)?.[0].length ?? 0;
const stripIndent = (s: string, n: number) => {
  let k = 0;
  while (k < n && s[k] === " ") k++;
  return s.slice(k);
};

/** Opening code fence (``` or ~~~), or null. */
function fenceAt(line: string) {
  const m = FENCE.exec(line);
  // A backtick fence cannot carry backticks in its info string.
  if (!m || (m[2][0] === "`" && m[3].includes("`"))) return null;
  return { indent: m[1].length, ch: m[2][0], len: m[2].length, lang: m[3].trim().split(/\s+/)[0] };
}

/** List marker ("-", "*", "+", "1.", "1)"), or null. */
function marker(line: string): Marker | null {
  const m = MARKER.exec(line);
  if (!m) return null;
  const indent = m[1].length;
  return {
    indent,
    ordered: m[3] !== undefined,
    num: m[3] !== undefined ? parseInt(m[3], 10) : 1,
    content: m[5] ?? "",
    off: indent + m[2].length + (m[4] ? m[4].length : 1), // column where item content starts
  };
}

/** Splits a table row on unescaped pipes. Outer pipes are dropped. */
function splitRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let c = 0; c < t.length; c++) {
    if (t[c] === "\\" && t[c + 1] === "|") {
      cur += "\\|"; // stays escaped; the inline parser renders it as "|"
      c++;
    } else if (t[c] === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += t[c];
  }
  cells.push(cur.trim());
  return cells;
}

const isSepRow = (line: string) => line.includes("|") && splitRow(line).every((c) => /^:?-+:?$/.test(c));

function isTableStart(lines: string[], k: number) {
  return (
    k + 1 < lines.length &&
    lines[k].includes("|") &&
    isSepRow(lines[k + 1]) &&
    splitRow(lines[k]).length === splitRow(lines[k + 1]).length
  );
}

/** True when line k starts a block that may end a paragraph or quote. */
function interrupts(lines: string[], k: number) {
  const l = lines[k];
  return (
    fenceAt(l) !== null || HEADING.test(l) || HR.test(l) || QUOTE.test(l) || !!marker(l)?.content || isTableStart(lines, k)
  );
}

// ---------- block parser ----------

function parseBlocks(lines: string[]): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }

    // Code fence. With no closing fence the block runs to the end (still streaming).
    const fence = fenceAt(line);
    if (fence) {
      const body: string[] = [];
      let k = i + 1;
      for (; k < lines.length; k++) {
        const t = lines[k].trim();
        if (t.length >= fence.len && t === fence.ch.repeat(t.length)) break;
        body.push(stripIndent(lines[k], fence.indent));
      }
      out.push({ kind: "code", lang: fence.lang, code: body.join("\n") });
      i = k + 1;
      continue;
    }

    const mk = marker(line);
    const h = HEADING.exec(line);
    if (h) {
      out.push({ kind: "heading", level: h[1].length, text: (h[2] ?? "").replace(/(^|[ \t]+)#+$/, "").trim() });
    } else if (HR.test(line)) {
      out.push({ kind: "hr" });
    } else if (QUOTE.test(line)) {
      // Quote lines, plus lazy continuation of a quoted paragraph.
      const inner: string[] = [];
      let k = i;
      for (; k < lines.length; k++) {
        const l = lines[k];
        if (QUOTE.test(l)) inner.push(l.replace(/^ {0,3}> ?/, ""));
        else if (!isBlank(l) && !isBlank(inner[inner.length - 1]) && !interrupts(lines, k)) inner.push(l);
        else break;
      }
      out.push({ kind: "quote", blocks: parseBlocks(inner) });
      i = k;
      continue;
    } else if (mk) {
      const [block, next] = parseList(lines, i, mk);
      out.push(block);
      i = next;
      continue;
    } else if (isTableStart(lines, i)) {
      const [block, next] = parseTable(lines, i);
      out.push(block);
      i = next;
      continue;
    } else {
      // Paragraph: until a blank line or a block-level interrupt.
      const para = [line.trimStart()];
      let k = i + 1;
      while (k < lines.length && !isBlank(lines[k]) && !interrupts(lines, k)) para.push(lines[k++].trimStart());
      out.push({ kind: "p", lines: para });
      i = k;
      continue;
    }
    i++;
  }
  return out;
}

/**
 * Parses a list from `start`. Item bodies are collected by indentation,
 * dedented, and parsed recursively, which gives nested lists for free.
 */
function parseList(lines: string[], start: number, first: Marker): [Block, number] {
  const { indent: base, ordered } = first;
  const items: ListItem[] = [];
  let mk: Marker | null = first;
  let i = start;

  while (mk) {
    const body: string[] = [mk.content];
    let k = i + 1;
    for (; k < lines.length; k++) {
      const ln = lines[k];
      if (isBlank(ln)) {
        // Blank lines belong to the item only if the item continues after them.
        let q = k + 1;
        while (q < lines.length && isBlank(lines[q])) q++;
        if (q < lines.length && indentOf(lines[q]) > base) body.push("");
        else break;
      } else if (indentOf(ln) > base) {
        body.push(stripIndent(ln, Math.min(indentOf(ln), mk.off)));
      } else if (marker(ln) || interrupts(lines, k) || isBlank(body[body.length - 1])) {
        break;
      } else {
        body.push(ln.trim()); // lazy continuation of the item's paragraph
      }
    }

    while (body.length && isBlank(body[body.length - 1])) body.pop();
    const task = body.length ? TASK.exec(body[0]) : null;
    if (task) body[0] = task[2] ?? "";
    items.push({ checked: task ? task[1] !== " " : undefined, blocks: parseBlocks(body) });
    i = k;

    // The list goes on if the next non-blank line is a sibling marker.
    let p = i;
    while (p < lines.length && isBlank(lines[p])) p++;
    const next = p < lines.length ? marker(lines[p]) : null;
    mk = next && next.indent === base && next.ordered === ordered ? next : null;
    if (mk) i = p;
  }
  return [{ kind: "list", ordered, start: first.num, items }, i];
}

function parseTable(lines: string[], i: number): [Block, number] {
  const head = splitRow(lines[i]);
  const align = splitRow(lines[i + 1]).map((c): Align => {
    const l = c.startsWith(":");
    const r = c.endsWith(":");
    return l && r ? "center" : r ? "right" : l ? "left" : undefined;
  });
  const rows: string[][] = [];
  let k = i + 2;
  for (; k < lines.length; k++) {
    const l = lines[k];
    if (isBlank(l) || FENCE.test(l) || HEADING.test(l) || QUOTE.test(l)) break;
    const cells = splitRow(l);
    rows.push(Array.from({ length: head.length }, (_, c) => cells[c] ?? ""));
  }
  return [{ kind: "table", align, head, rows }, k];
}

/** Normalises line endings and leading tabs, then parses. Falls back to raw text on error. */
function parseMarkdown(src: string): Block[] {
  try {
    const lines = src.replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/^\t+/, (t) => "    ".repeat(t.length)));
    return parseBlocks(lines);
  } catch {
    return [{ kind: "p", lines: [src] }];
  }
}

// ---------- inline parser ----------

/** Inline markup to React nodes. `inLink` disables nested links. */
function inline(s: string, inLink = false, depth = 0): ReactNode[] {
  if (depth > 8) return [s];
  const out: ReactNode[] = [];
  let buf = "";
  let i = 0;
  const flush = () => {
    if (buf) out.push(buf);
    buf = "";
  };

  while (i < s.length) {
    const c = s[i];
    const auto = inLink ? null : autoLinkAt(s, i);
    let step = 1;
    let node: ReactNode = null;

    if (c === "\\" && i + 1 < s.length && ESC.includes(s[i + 1])) {
      buf += s[i + 1]; // backslash escape: "\*" is a literal asterisk
      i += 2;
      continue;
    } else if (c === "\n") {
      node = <br key={out.length} />;
    } else if (c === "`") {
      const code = codeSpan(s, i);
      if (code) {
        // Inside a link label a button would be invalid markup, so only plain code there.
        const file = !inLink && fileOpener ? parseFileRef(code.text) : null;
        node = file ? (
          <button
            key={out.length}
            type="button"
            className="md-file-link"
            title={t("Открыть файл")}
            onClick={() => fileOpener?.(file.path, file.line)}
          >
            {code.text}
          </button>
        ) : (
          <code key={out.length}>{code.text}</code>
        );
        step = code.end - i;
      }
    } else if (c === "[" && !inLink) {
      const link = linkAt(s, i);
      if (link) {
        const kids = inline(link.label, true, depth + 1);
        node = SAFE_URL.test(link.url) ? anchor(link.url, kids, out.length) : <Fragment key={out.length}>{kids}</Fragment>;
        step = link.end - i;
      }
    } else if (auto) {
      node = anchor(auto.url, [auto.url], out.length);
      step = auto.end - i;
    } else if (c === "*" || c === "_" || c === "~") {
      const em = emphasisAt(s, i);
      if (em) {
        const Tag = em.kind === "del" ? "del" : em.kind === "em" ? "em" : "strong";
        const kids = inline(em.inner, inLink, depth + 1);
        node = <Tag key={out.length}>{em.kind === "bi" ? <em>{kids}</em> : kids}</Tag>;
        step = em.end - i;
      }
    }

    if (node !== null) {
      flush();
      out.push(node);
    } else buf += c;
    i += step;
  }
  flush();
  return out;
}

/** Inline code: a backtick run closed by a run of the same length. */
function codeSpan(s: string, i: number): { text: string; end: number } | null {
  let k = i;
  while (s[k] === "`") k++;
  const re = /`+/g;
  re.lastIndex = k;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m[0].length !== k - i) continue;
    let text = s.slice(k, m.index).replace(/\n/g, " ");
    if (text.trim() && text.startsWith(" ") && text.endsWith(" ")) text = text.slice(1, -1);
    return { text, end: m.index + m[0].length };
  }
  return null;
}

/** [label](url "title") with balanced brackets and parentheses. */
function linkAt(s: string, i: number): { label: string; url: string; end: number } | null {
  let depth = 0;
  let close = -1;
  for (let j = i; j < s.length && close < 0; j++) {
    if (s[j] === "\\") j++;
    else if (s[j] === "[") depth++;
    else if (s[j] === "]" && --depth === 0) close = j;
  }
  if (close < 0 || s[close + 1] !== "(") return null;

  let pd = 1;
  let end = -1;
  for (let p = close + 2; p < s.length && end < 0; p++) {
    if (s[p] === "\\") p++;
    else if (s[p] === "(") pd++;
    else if (s[p] === ")" && --pd === 0) end = p;
  }
  if (end < 0) return null;

  const dest = /^\s*<?([^\s>]*)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*$/.exec(s.slice(close + 2, end));
  return dest ? { label: s.slice(i + 1, close), url: dest[1], end: end + 1 } : null;
}

/** Bare http(s) URLs and <autolinks>. Trailing punctuation stays outside the link. */
function autoLinkAt(s: string, i: number): { url: string; end: number } | null {
  if (s[i] === "<") {
    const m = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/.exec(s.slice(i));
    return m ? { url: m[1], end: i + m[0].length } : null;
  }
  if (s[i] !== "h" || (i > 0 && /[A-Za-z0-9]/.test(s[i - 1]))) return null;
  const m = /^https?:\/\/[^\s<>"]+/.exec(s.slice(i));
  if (!m) return null;
  let url = m[0];
  for (;;) {
    const last = url[url.length - 1];
    if (last !== undefined && ".,;:!?'".includes(last)) url = url.slice(0, -1);
    else if (last === ")" && url.split(")").length > url.split("(").length) url = url.slice(0, -1);
    else break;
  }
  return /^https?:\/\/./.test(url) ? { url, end: i + url.length } : null;
}

/** Emphasis, strong or strikethrough opened at i, or null. */
function emphasisAt(s: string, i: number): { kind: Kind; inner: string; end: number } | null {
  if (s[i] === "_" && i > 0 && /[A-Za-z0-9]/.test(s[i - 1])) return null; // snake_case stays literal
  for (const [delim, kind] of EMPH[s[i]]) {
    if (!s.startsWith(delim, i)) continue;
    const close = closeFor(s, i, delim);
    if (close !== null) return { kind, inner: s.slice(i + delim.length, close), end: close + delim.length };
  }
  return null;
}

/** Index of the closing delimiter for the one opened at i, or null. */
function closeFor(s: string, i: number, delim: string): number | null {
  const open = i + delim.length;
  if (open >= s.length || /\s/.test(s[open])) return null; // opener must be followed by text
  for (let idx = s.indexOf(delim, open + 1); idx !== -1; idx = s.indexOf(delim, idx + 1)) {
    const before = s.charAt(idx - 1);
    const after = s.charAt(idx + delim.length);
    const ok =
      !/\s/.test(before) &&
      !(delim.length === 1 && (after === delim || before === delim)) && // "*" must not be part of "**"
      !(delim[0] === "_" && /[A-Za-z0-9]/.test(after)); // "_" must not close inside a word
    if (ok) return idx;
  }
  return null;
}

/** Link element. Opens externally through the Tauri opener; falls back to window.open. */
function anchor(url: string, children: ReactNode[], key: number): ReactNode {
  const open = () => window.open(url, "_blank");
  return (
    <a
      key={key}
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => {
        e.preventDefault();
        try {
          openUrl(url).catch(open);
        } catch {
          open();
        }
      }}
    >
      {children}
    </a>
  );
}

// ---------- rendering ----------

function renderBlocks(blocks: Block[]): ReactNode[] {
  return blocks.map((b, n) => renderBlock(b, n));
}

function renderBlock(b: Block, key: number): ReactNode {
  switch (b.kind) {
    case "heading": {
      // # -> h3 (18px), ## -> h4 (16px), ### and deeper -> h5 (15px).
      const Tag = b.level === 1 ? "h3" : b.level === 2 ? "h4" : "h5";
      return <Tag key={key}>{inline(b.text)}</Tag>;
    }
    case "p":
      return <p key={key}>{inline(b.lines.join("\n"))}</p>;
    case "code":
      return <CodeBlock key={key} lang={b.lang} code={b.code} />;
    case "list": {
      const items = b.items.map((it, n) => (
        <li key={n} className={it.checked === undefined ? undefined : "md-task"}>
          {it.checked !== undefined && <input type="checkbox" disabled checked={it.checked} />}
          {renderBlocks(it.blocks)}
        </li>
      ));
      return b.ordered ? (
        <ol key={key} start={b.start !== 1 ? b.start : undefined}>{items}</ol>
      ) : (
        <ul key={key}>{items}</ul>
      );
    }
    case "quote":
      return <blockquote key={key} className="md-quote">{renderBlocks(b.blocks)}</blockquote>;
    case "hr":
      return <hr key={key} />;
    case "table":
      return (
        <div key={key} className="md-table-wrap">
          <table>
            <thead>
              <tr>{b.head.map((h, c) => <th key={c} style={{ textAlign: b.align[c] }}>{inline(h)}</th>)}</tr>
            </thead>
            <tbody>
              {b.rows.map((r, ri) => (
                <tr key={ri}>{r.map((cell, c) => <td key={c} style={{ textAlign: b.align[c] }}>{inline(cell)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

/** Code block with a language label and a copy button. */
function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = () => {
    const done = () => {
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    };
    try {
      navigator.clipboard.writeText(code).then(done, () => {});
    } catch {
      // Clipboard API unavailable: nothing to do.
    }
  };

  return (
    <div className="md-code">
      <div className="md-code-head">
        <span className="md-code-lang">{lang}</span>
        <button type="button" className="md-copy" onClick={copy}>
          {copied ? t("Скопировано") : t("Копировать")}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(typeof text === "string" ? text : ""), [text]);
  return <div className="md">{renderBlocks(blocks)}</div>;
}
