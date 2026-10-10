import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { t } from "../lib/i18n";
import "./palette.css";

export type PaletteItem = {
  id: string;
  group: string; // e.g. "Действия", "Сессии", "Модели", "Проекты"
  title: string;
  subtitle?: string; // muted second line / right-side meta
  keywords?: string; // extra search text
  shortcut?: string; // e.g. "⌘N"
  run: () => void;
};

/** One message found by full-text search through conversations. */
export type TextHitItem = {
  id: string;
  title: string; // session title
  snippet: string; // text around the match, "…" where it was cut
  matchStart: number; // char offset of the match inside snippet
  matchLen: number; // length of the match in chars
  run: () => void;
};

type Props = {
  open: boolean;
  items: PaletteItem[];
  onClose: () => void;
  placeholder?: string;
  /** Full-text search through conversations; called for queries of 3+ chars. */
  searchText?: (query: string) => Promise<TextHitItem[]>;
};

const MAX_RESULTS = 50;
const DEFAULT_PLACEHOLDER = "Поиск по сессиям и действиям…";
const TEXT_GROUP = "Найдено в переписке";
const MIN_TEXT_QUERY = 3;
const TEXT_DEBOUNCE_MS = 200;
/** The "Ищем…" row appears only when a search is still running after this long. */
const TEXT_SLOW_MS = 150;
const NO_HITS: TextHitItem[] = [];
const BOUNDARY = /[\s\-_.,:\/()·]/;
const KEY_RE = /[⌘⌃⌥⇧]|[^⌘⌃⌥⇧+\s]+/gu;

/** Lowercase per UTF-16 unit (keeps indices aligned with the original text), fold "ё" to "е". */
function foldCase(s: string): string {
  return s
    .split("")
    .map((u) => {
      const l = u.toLowerCase();
      if (l.length !== 1) return u;
      return l === "ё" ? "е" : l;
    })
    .join("");
}

type Prepared = { item: PaletteItem; low: string; titleLen: number };

function prepare(item: PaletteItem): Prepared {
  const text = [item.title, item.subtitle ?? "", item.keywords ?? ""].join(" ");
  return { item, low: foldCase(text), titleLen: item.title.length };
}

type Hit = { score: number; pos: number[] };

function scoreHit(p: Prepared, q: string, pos: number[]): number {
  let score = 0;
  for (let i = 0; i < pos.length; i++) {
    const at = pos[i];
    score += 1;
    if (i > 0 && at === pos[i - 1] + 1) score += 4; // contiguous
    if (at === 0 || BOUNDARY.test(p.low[at - 1])) score += 3; // word start
  }
  const first = pos[0];
  const last = pos[pos.length - 1];
  if (last < p.titleLen) score += 12; // every matched char sits in the title
  if (first === 0) score += 5;
  const titleLow = p.low.slice(0, p.titleLen);
  if (titleLow.startsWith(q)) score += 30;
  else if (titleLow.includes(q)) score += 15;
  score -= (last - first - (q.length - 1)) * 0.5; // gaps between matches
  return score;
}

/** Subsequence match: tries every start position and keeps the best-scoring one. */
function fuzzy(p: Prepared, q: string): Hit | null {
  const { low } = p;
  let best: Hit | null = null;
  for (let s = 0; s < low.length; s++) {
    if (low[s] !== q[0]) continue;
    const pos = [s];
    let k = s + 1;
    let ok = true;
    for (let j = 1; j < q.length; j++) {
      while (k < low.length && low[k] !== q[j]) k++;
      if (k >= low.length) {
        ok = false;
        break;
      }
      pos.push(k);
      k++;
    }
    // A later start cannot match if this one failed, so stop here.
    if (!ok) break;
    const score = scoreHit(p, q, pos);
    if (!best || score > best.score) best = { score, pos };
  }
  // Letters scattered across a long description are noise, not a match.
  if (best && !low.includes(q)) {
    const span = best.pos[best.pos.length - 1] - best.pos[0] + 1;
    if (span > q.length * 2 + 1) return null;
  }
  return best;
}

type Result = { item: PaletteItem; hl: number[]; hit?: TextHitItem };
type Row = Result & { flat: number };
type Section = { group: string; rows: Row[] };

function splitKeys(shortcut: string): string[] {
  return shortcut.match(KEY_RE) ?? [];
}

function renderTitle(title: string, hl: number[]): ReactNode {
  if (hl.length === 0) return title;
  const marked = new Set(hl);
  const out: ReactNode[] = [];
  let buf = "";
  let on = false;
  for (let i = 0; i < title.length; i++) {
    const isOn = marked.has(i);
    if (isOn !== on) {
      if (buf) out.push(on ? <span key={`h${i}`} className="pal-hl">{buf}</span> : buf);
      buf = "";
      on = isOn;
    }
    buf += title[i];
  }
  if (buf) out.push(on ? <span key="hend" className="pal-hl">{buf}</span> : buf);
  return out;
}

/** Snippet with the match wrapped in <mark>. Offsets count code points, as the Rust side does. */
function renderSnippet(hit: TextHitItem): ReactNode {
  const chars = Array.from(hit.snippet);
  const end = hit.matchStart + hit.matchLen;
  return (
    <>
      {chars.slice(0, hit.matchStart).join("")}
      <mark className="pal-mark">{chars.slice(hit.matchStart, end).join("")}</mark>
      {chars.slice(end).join("")}
    </>
  );
}

export function CommandPalette({ open, ...rest }: Props): ReactElement | null {
  if (!open) return null;
  return <PaletteBody {...rest} />;
}

/** Mounted only while open, so query and selection reset on every opening. */
function PaletteBody({ items, onClose, placeholder, searchText }: Omit<Props, "open">): ReactElement {
  const [query, setQuery] = useState("");
  // Hits are kept together with the query they answer, so a late response for
  // an older query is never shown.
  const [textState, setTextState] = useState<{ q: string; hits: TextHitItem[] }>({ q: "", hits: [] });
  const [searching, setSearching] = useState(false);
  const [active, setActive] = useState(0);
  // Hover changes the selection only after the mouse has really moved over the list,
  // so an item under a stationary cursor is not pre-selected on open.
  const mouseMoved = useRef(false);
  const lastMouse = useRef<{ x: number; y: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const uid = useId();
  const listId = `${uid}-list`;
  const optId = (flat: number) => `${uid}-opt-${flat}`;

  const prepared = useMemo(() => items.map(prepare), [items]);
  const q = foldCase(query).trim();

  const ranked = useMemo<Result[]>(() => {
    if (!q) {
      return prepared.slice(0, MAX_RESULTS).map((p) => ({ item: p.item, hl: [] }));
    }
    const hits: { r: Result; score: number; idx: number }[] = [];
    prepared.forEach((p, idx) => {
      const h = fuzzy(p, q);
      if (!h) return;
      hits.push({
        r: { item: p.item, hl: h.pos.filter((i) => i < p.titleLen) },
        score: h.score,
        idx,
      });
    });
    hits.sort((a, b) => b.score - a.score || a.idx - b.idx);
    return hits.slice(0, MAX_RESULTS).map((h) => h.r);
  }, [prepared, q]);

  const textQuery = query.trim();
  const textEnabled = !!searchText && textQuery.length >= MIN_TEXT_QUERY;
  const textHits = textEnabled && textState.q === textQuery ? textState.hits : NO_HITS;
  // The query has 3+ chars but its answer has not arrived yet.
  const textPending = textEnabled && textState.q !== textQuery;
  const textGroup = t(TEXT_GROUP);

  useEffect(() => {
    if (!searchText || !textEnabled) return;
    let stale = false;
    let slow: ReturnType<typeof setTimeout> | undefined;
    const finish = (hits: TextHitItem[]) => {
      if (stale) return;
      clearTimeout(slow);
      setSearching(false);
      setTextState({ q: textQuery, hits });
    };
    const debounce = setTimeout(() => {
      slow = setTimeout(() => {
        if (!stale) setSearching(true);
      }, TEXT_SLOW_MS);
      Promise.resolve()
        .then(() => searchText(textQuery))
        .then(finish, () => finish([]));
    }, TEXT_DEBOUNCE_MS);
    return () => {
      stale = true;
      clearTimeout(debounce);
      clearTimeout(slow);
      setSearching(false);
    };
  }, [searchText, textEnabled, textQuery]);

  // Message hits go after the normal results, as their own group.
  const textRanked = useMemo<Result[]>(
    () =>
      textHits.map((h) => ({
        item: { id: `text:${h.id}`, group: textGroup, title: h.title, run: h.run },
        hl: [],
        hit: h,
      })),
    [textHits, textGroup],
  );

  // Groups appear in the order they first show up in the (ranked) results.
  const { sections, flat } = useMemo(() => {
    const byGroup = new Map<string, Result[]>();
    for (const r of [...ranked, ...textRanked]) {
      const arr = byGroup.get(r.item.group);
      if (arr) arr.push(r);
      else byGroup.set(r.item.group, [r]);
    }
    const list: Row[] = [];
    const secs: Section[] = [];
    for (const [group, rows] of byGroup) {
      const sectionRows: Row[] = rows.map((r) => {
        const row = { ...r, flat: list.length };
        list.push(row);
        return row;
      });
      secs.push({ group, rows: sectionRows });
    }
    return { sections: secs, flat: list };
  }, [ranked, textRanked]);

  const n = flat.length;
  const cur = n === 0 ? -1 : Math.min(active, n - 1);

  useEffect(() => {
    if (cur < 0) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-idx="${cur}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [cur]);

  const runItem = (item: PaletteItem) => {
    item.run();
    onClose();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing) return;
    switch (e.key) {
      case "ArrowDown":
        if (n === 0) return;
        e.preventDefault();
        setActive((cur + 1) % n);
        return;
      case "ArrowUp":
        if (n === 0) return;
        e.preventDefault();
        setActive((cur - 1 + n) % n);
        return;
      case "Home":
        if (n === 0) return;
        e.preventDefault();
        setActive(0);
        return;
      case "End":
        if (n === 0) return;
        e.preventDefault();
        setActive(n - 1);
        return;
      case "Enter": {
        e.preventDefault();
        const row = flat[cur];
        if (row) runItem(row.item);
        return;
      }
      case "Escape":
        e.preventDefault();
        onClose();
        return;
    }
  };

  return (
    <div
      className="pal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="pal-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t("Командная палитра")}
        onKeyDown={onKeyDown}
        onMouseDown={(e: ReactMouseEvent<HTMLDivElement>) => {
          // Keep focus in the input when clicking anywhere in the panel.
          if (e.target !== inputRef.current) e.preventDefault();
        }}
      >
        <div className="pal-search">
          <svg className="pal-glyph" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <circle
              cx="8"
              cy="8"
              r="5.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeDasharray="0 3"
              strokeLinecap="round"
            />
          </svg>
          <input
            ref={inputRef}
            className="pal-input"
            type="text"
            role="combobox"
            aria-label={t("Поиск")}
            aria-expanded={true}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={cur >= 0 ? optId(cur) : undefined}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            placeholder={placeholder ?? t(DEFAULT_PLACEHOLDER)}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
          />
        </div>

        <div
          className="pal-list"
          role="listbox"
          id={listId}
          ref={listRef}
          aria-label={t("Результаты")}
          onMouseDown={(e) => e.preventDefault()}
          onMouseMoveCapture={(e) => {
            // WebKit fires a mousemove when the list appears under a still
            // cursor; only a real change of position counts as moving.
            const at = lastMouse.current;
            if (at && (at.x !== e.clientX || at.y !== e.clientY)) mouseMoved.current = true;
            lastMouse.current = { x: e.clientX, y: e.clientY };
          }}
        >
          {n === 0 && !textPending ? (
            <div className="pal-empty">{t("Ничего не найдено")}</div>
          ) : (
            sections.map((sec) => (
              <div key={sec.group} role="group" aria-label={sec.group}>
                <div className="pal-group" role="presentation">
                  {sec.group}
                </div>
                {sec.rows.map((row) => {
                  const selected = row.flat === cur;
                  const keys = row.item.shortcut ? splitKeys(row.item.shortcut) : [];
                  return (
                    <div
                      key={row.item.id}
                      id={optId(row.flat)}
                      data-idx={row.flat}
                      role="option"
                      aria-selected={selected}
                      className="pal-row"
                      onMouseMove={() => {
                        if (mouseMoved.current && !selected) setActive(row.flat);
                      }}
                      onClick={() => runItem(row.item)}
                    >
                      {row.hit ? (
                        <span className="pal-hit">
                          <span className="pal-title">{row.item.title}</span>
                          <span className="pal-snippet">{renderSnippet(row.hit)}</span>
                        </span>
                      ) : (
                        <>
                          <span className="pal-title">{renderTitle(row.item.title, row.hl)}</span>
                          {row.item.subtitle ? (
                            <span className="pal-sub">{row.item.subtitle}</span>
                          ) : null}
                          {keys.length > 0 ? (
                            <span className="pal-keys">
                              {keys.map((k, i) => (
                                <kbd key={i} className="pal-kbd">
                                  {k}
                                </kbd>
                              ))}
                            </span>
                          ) : null}
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            ))
          )}
          {textPending && searching ? (
            <>
              <div className="pal-group" role="presentation">
                {textGroup}
              </div>
              <div className="pal-status" aria-live="polite">
                {t("Ищем…")}
              </div>
            </>
          ) : null}
        </div>

        <div className="pal-foot">{t("↑↓ выбрать · Enter открыть · Esc закрыть")}</div>
      </div>
    </div>
  );
}
