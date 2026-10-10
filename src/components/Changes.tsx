import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import type { GitFile, GitStatus } from "../lib/workspace";
import { applyHunk, gitDiff, gitRestore, gitStatus } from "../lib/workspace";
import { DotSpinner, Icon } from "./Glyphs";
import { t, tErr, tw } from "../lib/i18n";
import "./changes.css";
import "./commit.css";

const CARD_LIMIT = 4;
const CONFIRM_MS = 3000;
const SENT_MS = 2500;

const STATUS_LETTER: Record<GitFile["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  untracked: "U",
  conflict: "C",
};

const STATUS_TITLE: Record<GitFile["status"], string> = {
  added: "Добавлен",
  modified: "Изменён",
  deleted: "Удалён",
  renamed: "Переименован",
  untracked: "Не отслеживается",
  conflict: "Конфликт",
};

function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return t("Неизвестная ошибка");
}

function StatusBadge({ status }: { status: GitFile["status"] }) {
  return (
    <span className={`chg-badge s-${status}`} title={t(STATUS_TITLE[status])}>
      {STATUS_LETTER[status]}
    </span>
  );
}

function Counts({ add, del }: { add: number; del: number }) {
  return (
    <span className="chg-nums">
      <span className="chg-add">+{add}</span>
      <span className="chg-del">−{del}</span>
    </span>
  );
}

function Totals({ add, del }: { add: number; del: number }) {
  return (
    <span className="chg-totals">
      <span className="chg-dots chg-add">+{add}</span>
      <span className="chg-dots chg-del">−{del}</span>
    </span>
  );
}

function CleanMark() {
  return (
    <svg width="72" height="72" viewBox="0 0 72 72" fill="none" strokeLinecap="round" aria-hidden="true">
      <circle cx="36" cy="36" r="30" stroke="var(--dot)" strokeWidth="4" strokeDasharray="0 6" />
      <path d="M22 37l9 9 19-20" stroke="var(--accent-ink)" strokeWidth="4" strokeDasharray="0 6" />
    </svg>
  );
}

export function ChangesCard({
  status,
  onOpen,
  onOpenFile,
  onCommit,
}: {
  status: GitStatus | null;
  onOpen: () => void;
  onOpenFile?: (path: string) => void;
  /** Opens the commit dialog. The button shows only when this is provided. */
  onCommit?: () => void;
}): ReactElement | null {
  if (!status?.isRepo || status.files.length === 0) return null;
  const { files, additions, deletions } = status;
  const shown = files.slice(0, CARD_LIMIT);
  const rest = files.length - shown.length;

  return (
    <div className="chg-card">
      <div className="chg-card-head">
        <span className="label">{t("ИЗМЕНЕНИЯ")}</span>
        <span className="chg-card-count">
          {files.length} {tw(files.length, "файл|файла|файлов")}
        </span>
        <Totals add={additions} del={deletions} />
      </div>
      <ul className="chg-files">
        {shown.map((f) => (
          <li key={f.path} className="chg-file">
            <StatusBadge status={f.status} />
            {onOpenFile && f.status !== "deleted" ? (
              <button type="button" className="chg-file-path chg-path-link" title={t("Открыть {path}", { path: f.path })} onClick={() => onOpenFile(f.path)}>
                {f.path}
              </button>
            ) : (
              <span className="chg-file-path" title={f.path}>
                {f.path}
              </span>
            )}
            <Counts add={f.additions} del={f.deletions} />
          </li>
        ))}
      </ul>
      {rest > 0 && <div className="chg-more">{t("и ещё {count}", { count: rest })}</div>}
      <div className="chg-card-foot">
        {onCommit && (
          <button type="button" className="btn commit-entry" onClick={onCommit}>
            {t("Закоммитить")}
          </button>
        )}
        <button type="button" className="btn" onClick={onOpen}>
          {t("Посмотреть дифф")}
        </button>
      </div>
    </div>
  );
}

type DiffLine = {
  kind: "add" | "del" | "ctx" | "note";
  /** Line text without its sign. */
  text: string;
  /** Line as written in a unified diff, sign included (used in patches and comments). */
  raw: string;
  oldNo: number | null;
  newNo: number | null;
};

type DiffHunk = { header: string; lines: DiffLine[] };

/** Selected lines of one hunk; anchor and cursor are line indexes in that hunk. */
type LineSelection = { hunk: number; anchor: number; cursor: number };

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const SIGN: Record<DiffLine["kind"], string> = { add: "+", del: "-", ctx: "", note: "" };

/** Splits unified diff text of one file into hunks with old/new line numbers. */
function parseDiff(text: string): DiffHunk[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const hunks: DiffHunk[] = [];
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  for (const line of lines) {
    const head = HUNK_RE.exec(line);
    if (head) {
      oldNo = Number(head[1]);
      newNo = Number(head[2]);
      hunk = { header: line, lines: [] };
      hunks.push(hunk);
      continue;
    }
    if (!hunk) continue; // file header lines (diff --git, index, ---, +++)

    const sign = line[0];
    if (sign === "+") {
      hunk.lines.push({ kind: "add", text: line.slice(1), raw: line, oldNo: null, newNo: newNo++ });
    } else if (sign === "-") {
      hunk.lines.push({ kind: "del", text: line.slice(1), raw: line, oldNo: oldNo++, newNo: null });
    } else if (sign === " " || line === "") {
      hunk.lines.push({ kind: "ctx", text: line.slice(1), raw: ` ${line.slice(1)}`, oldNo: oldNo++, newNo: newNo++ });
    } else {
      // "\ No newline at end of file", or the truncation marker: shown, never patched.
      hunk.lines.push({ kind: "note", text: line, raw: line, oldNo: null, newNo: null });
    }
  }
  return hunks;
}

/** A complete single-file patch carrying one hunk: the form git_apply_hunk takes. */
function hunkPatch(path: string, hunk: DiffHunk): string {
  const body = hunk.lines.filter((l) => l.kind !== "note" || l.raw.startsWith("\\")).map((l) => l.raw);
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${[hunk.header, ...body].join("\n")}\n`;
}

/** The message sent to the agent: where the comment points, the selected diff lines, the comment. */
function commentMessage(path: string, lines: DiffLine[], comment: string): string {
  const shown = lines.filter((l) => l.kind !== "note");
  const nums = shown.map((l) => l.newNo ?? l.oldNo ?? 0);
  const first = nums[0];
  const last = nums[nums.length - 1];
  const file = `\`${path}\``;
  const where =
    first === last
      ? t("Замечание к файлу {path}, строка {line}:", { path: file, line: first })
      : t("Замечание к файлу {path}, строки {range}:", { path: file, range: `${first}–${last}` });
  const code = shown.map((l) => l.raw).join("\n");
  return `${where}\n\`\`\`diff\n${code}\n\`\`\`\n${comment}`;
}

type HunkActions = { busy: string | null; onAct: (hunk: number, mode: "stage" | "revert") => void };

function DiffView({
  text,
  hunks,
  range,
  onPick,
  composer,
  hunkActions,
}: {
  text: string;
  hunks: DiffHunk[];
  /** Selected lines (inclusive), or null. */
  range: { hunk: number; lo: number; hi: number } | null;
  /** Set only when lines can be selected for a comment. */
  onPick?: (hunk: number, line: number, extend: boolean) => void;
  /** Rendered under the last selected line. */
  composer?: ReactNode;
  /** Set only when hunks can be staged or discarded. */
  hunkActions?: HunkActions | null;
}) {
  if (hunks.length === 0) {
    return (
      <div className="chg-center chg-muted">
        {text.includes("Binary files") ? t("Бинарный файл — построчный дифф недоступен.") : t("Нет текстовых изменений.")}
      </div>
    );
  }

  return (
    <div className="chg-diff" aria-label={t("Построчный дифф")}>
      {hunks.map((h, hi) => (
        <Fragment key={hi}>
          <div className="chg-hunk">
            <span className="chg-hunk-text">{h.header}</span>
            {hunkActions && (
              <span className="chg-hunk-actions">
                <button
                  type="button"
                  className="chg-hunk-btn"
                  title={t("Принять фрагмент")}
                  disabled={hunkActions.busy !== null}
                  onClick={() => hunkActions.onAct(hi, "stage")}
                >
                  {t("Принять")}
                </button>
                <button
                  type="button"
                  className="chg-hunk-btn"
                  title={t("Отклонить фрагмент")}
                  disabled={hunkActions.busy !== null}
                  onClick={() => hunkActions.onAct(hi, "revert")}
                >
                  {t("Отменить правку")}
                </button>
              </span>
            )}
          </div>
          {h.lines.map((l, li) => {
            const inRange = range !== null && range.hunk === hi && li >= range.lo && li <= range.hi;
            const gutters = (
              <>
                <span className="chg-gutter">{l.oldNo ?? ""}</span>
                <span className="chg-gutter">{l.newNo ?? ""}</span>
              </>
            );
            return (
              <Fragment key={li}>
                <div className={`chg-line ${l.kind}${inRange ? " sel" : ""}`}>
                  {onPick && l.kind !== "note" ? (
                    <button
                      type="button"
                      className="chg-gutters"
                      aria-label={t("Выбрать строку")}
                      aria-pressed={inRange}
                      title={t("Shift+клик — выделить диапазон")}
                      onClick={(e) => onPick(hi, li, e.shiftKey)}
                    >
                      {gutters}
                    </button>
                  ) : (
                    gutters
                  )}
                  <span className="chg-sign">{SIGN[l.kind]}</span>
                  <span className="chg-code">{l.text}</span>
                </div>
                {composer && range !== null && range.hunk === hi && range.hi === li ? composer : null}
              </Fragment>
            );
          })}
        </Fragment>
      ))}
    </div>
  );
}

export function ChangesPanel({
  cwd,
  onClose,
  onChanged,
  onOpenFile,
  onComment,
  onCommit,
}: {
  cwd: string;
  onClose: () => void;
  onChanged?: () => void;
  onOpenFile?: (path: string) => void;
  /** Receives a comment on selected diff lines, already formatted for the agent. */
  onComment?: (text: string) => void;
  /** Opens the commit dialog. The button shows only when this is provided. */
  onCommit?: () => void;
}): ReactElement {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState("");
  const [diffError, setDiffError] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffNonce, setDiffNonce] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [sel, setSel] = useState<LineSelection | null>(null);
  const [draft, setDraft] = useState("");
  const [sentAt, setSentAt] = useState<number | null>(null);
  const [hunkBusy, setHunkBusy] = useState<string | null>(null);
  const [hunkError, setHunkError] = useState<string | null>(null);
  const requestId = useRef(0);
  const hunks = useMemo(() => parseDiff(diff), [diff]);

  /** Reloads status; when the selected file is gone, selects the file at `keepIndex`. */
  const reload = useCallback(
    async (keepIndex = 0) => {
      const id = ++requestId.current;
      setLoading(true);
      try {
        const next = await gitStatus(cwd);
        if (id !== requestId.current) return;
        setStatus(next);
        setLoadError(null);
        setSelected((prev) => {
          if (prev && next.files.some((f) => f.path === prev)) return prev;
          if (next.files.length === 0) return null;
          return next.files[Math.min(keepIndex, next.files.length - 1)].path;
        });
      } catch (e) {
        if (id === requestId.current) setLoadError(errText(e));
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    },
    [cwd],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  // Load the diff of the selected file; reset per-file UI state on change.
  useEffect(() => {
    setConfirming(false);
    setActionError(null);
    setHunkError(null);
    setSel(null);
    setDraft("");
    setSentAt(null);
    if (!selected) {
      setDiff("");
      setDiffError(null);
      setDiffLoading(false);
      return;
    }
    let cancelled = false;
    setDiffLoading(true);
    setDiffError(null);
    gitDiff(cwd, selected)
      .then((text) => {
        if (!cancelled) setDiff(text);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setDiff("");
          setDiffError(errText(e));
        }
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, selected, diffNonce]);

  // The confirmation for a destructive action expires after a few seconds.
  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(false), CONFIRM_MS);
    return () => window.clearTimeout(timer);
  }, [confirming]);

  // The "sent to agent" note fades after a moment.
  useEffect(() => {
    if (sentAt === null) return;
    const timer = window.setTimeout(() => setSentAt(null), SENT_MS);
    return () => window.clearTimeout(timer);
  }, [sentAt]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const files = status?.files ?? [];
  const current = files.find((f) => f.path === selected) ?? null;
  const isUntracked = current?.status === "untracked";

  const refresh = () => {
    setDiffNonce((n) => n + 1);
    void reload();
  };

  const restore = async () => {
    if (!current || restoring) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    const index = files.findIndex((f) => f.path === current.path);
    setConfirming(false);
    setRestoring(true);
    setActionError(null);
    try {
      await gitRestore(cwd, current.path);
    } catch (e) {
      setActionError(errText(e));
      setRestoring(false);
      return;
    }
    setRestoring(false);
    onChanged?.();
    await reload(index);
  };

  // Stage or discard one hunk, then reload the diff and the app's status.
  const actHunk = async (hi: number, mode: "stage" | "revert") => {
    const path = current?.path;
    const hunk = hunks[hi];
    if (!path || !hunk || hunkBusy) return;
    setHunkBusy(`${hi}:${mode}`);
    setHunkError(null);
    try {
      await applyHunk(cwd, path, hunkPatch(path, hunk), mode);
    } catch (e) {
      setHunkError(tErr(e));
      setHunkBusy(null);
      return;
    }
    setHunkBusy(null);
    onChanged?.();
    refresh();
  };

  const pickLine = (hunk: number, line: number, extend: boolean) => {
    setSel((prev) => (extend && prev && prev.hunk === hunk ? { ...prev, cursor: line } : { hunk, anchor: line, cursor: line }));
  };

  const range = sel
    ? { hunk: sel.hunk, lo: Math.min(sel.anchor, sel.cursor), hi: Math.max(sel.anchor, sel.cursor) }
    : null;

  const cancelComment = () => {
    setSel(null);
    setDraft("");
  };

  const sendComment = () => {
    const text = draft.trim();
    const path = current?.path;
    if (!range || !text || !path || !onComment) return;
    onComment(commentMessage(path, hunks[range.hunk].lines.slice(range.lo, range.hi + 1), text));
    setSel(null);
    setDraft("");
    setSentAt(Date.now());
  };

  const composer =
    onComment && range && current ? (
      <div className="chg-composer">
        <textarea
          className="chg-composer-input"
          autoFocus
          rows={3}
          value={draft}
          placeholder={t("Что здесь не так?")}
          aria-label={t("Что здесь не так?")}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              // Keep Esc from also closing the whole panel.
              e.stopPropagation();
              cancelComment();
            } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              sendComment();
            }
          }}
        />
        <div className="chg-composer-foot">
          <button type="button" className="btn chg-composer-btn" onClick={cancelComment}>
            {t("Отмена")}
          </button>
          <button type="button" className="btn primary chg-composer-btn" disabled={!draft.trim()} onClick={sendComment}>
            {t("Отправить агенту")}
          </button>
        </div>
      </div>
    ) : null;

  // Hunks come from a diff against HEAD of a modified file; new and untracked files keep whole-file actions only.
  const canHunks = current?.status === "modified" && !diffLoading && !diffError && hunks.length > 0;

  const restoreLabel = confirming
    ? isUntracked
      ? t("Точно удалить?")
      : t("Точно откатить?")
    : isUntracked
      ? t("Удалить файл")
      : t("Откатить файл");

  let body: ReactElement | null;
  if (!status) {
    body = loading ? (
      <div className="chg-center">
        <DotSpinner size={18} />
      </div>
    ) : null;
  } else if (!status.isRepo) {
    body = <div className="chg-center chg-muted">{t("Папка не под git — изменения не отслеживаются.")}</div>;
  } else if (files.length === 0) {
    body = (
      <div className="chg-center chg-clean">
        <CleanMark />
        <p>{t("Изменений нет")}</p>
      </div>
    );
  } else {
    body = (
      <>
        <ul className="chg-list" aria-label={t("Изменённые файлы")}>
          {files.map((f) => {
            const slash = f.path.lastIndexOf("/");
            const dir = slash >= 0 ? f.path.slice(0, slash + 1) : "";
            const base = f.path.slice(slash + 1);
            const active = f.path === selected;
            return (
              <li key={f.path}>
                <button
                  type="button"
                  className={`chg-row${active ? " on" : ""}`}
                  aria-pressed={active}
                  title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
                  onClick={() => setSelected(f.path)}
                >
                  <StatusBadge status={f.status} />
                  <span className="chg-row-name">
                    <span className="chg-row-dir">{dir}</span>
                    <span>{base}</span>
                  </span>
                  <Counts add={f.additions} del={f.deletions} />
                </button>
              </li>
            );
          })}
        </ul>

        <section className="chg-viewer" aria-label={t("Дифф файла")}>
          {current ? (
            <>
              <div className="chg-viewer-head">
                {onOpenFile && current.status !== "deleted" ? (
                  <button type="button" className="chg-viewer-path chg-path-link" title={t("Открыть файл")} onClick={() => onOpenFile(current.path)}>
                    {current.path}
                  </button>
                ) : (
                  <span className="chg-viewer-path" title={current.path}>
                    {current.path}
                  </span>
                )}
                <button
                  type="button"
                  className={`btn chg-restore${confirming ? " confirm" : ""}`}
                  onClick={() => void restore()}
                  disabled={restoring}
                >
                  {restoreLabel}
                </button>
              </div>
              {actionError && (
                <div className="err-card chg-err" role="alert">
                  {actionError}
                </div>
              )}
              {hunkError && (
                <div className="chg-inline-err" role="alert">
                  {hunkError}
                </div>
              )}
              {sentAt !== null && (
                <div className="chg-note" role="status">
                  {t("Отправлено агенту")}
                </div>
              )}
              <div className="chg-diff-scroll">
                {diffLoading ? (
                  <div className="chg-center">
                    <DotSpinner size={18} />
                  </div>
                ) : diffError ? (
                  <div className="err-card chg-err" role="alert">
                    {diffError}
                  </div>
                ) : (
                  <DiffView
                    text={diff}
                    hunks={hunks}
                    range={range}
                    onPick={onComment ? pickLine : undefined}
                    composer={composer}
                    hunkActions={canHunks ? { busy: hunkBusy, onAct: (hi, mode) => void actHunk(hi, mode) } : null}
                  />
                )}
              </div>
            </>
          ) : (
            <div className="chg-center chg-muted">{t("Выберите файл")}</div>
          )}
        </section>
      </>
    );
  }

  const showTotals = status?.isRepo && files.length > 0;

  return (
    <aside className="card chg-panel" aria-labelledby="chg-title">
      <header className="chg-head">
        <h2 className="chg-title" id="chg-title">
          {t("Изменения")}
        </h2>
        {status?.isRepo && status.branch && <span className="chg-chip mono">{status.branch}</span>}
        {showTotals && <Totals add={status.additions} del={status.deletions} />}
        <div className="chg-head-actions">
          {onCommit && status?.isRepo && files.length > 0 && (
            <button type="button" className="btn commit-entry" onClick={onCommit}>
              {t("Закоммитить")}
            </button>
          )}
          <button type="button" className="icon-btn" aria-label={t("Обновить")} title={t("Обновить")} onClick={refresh} disabled={loading}>
            <span className={loading ? "spin" : undefined}>
              <Icon name="refresh" size={16} />
            </span>
          </button>
          <button type="button" className="icon-btn" aria-label={t("Закрыть")} title={t("Закрыть (Esc)")} onClick={onClose}>
            <Icon name="close" size={16} />
          </button>
        </div>
      </header>
      {loadError && (
        <div className="err-card chg-err" role="alert">
          {loadError}
        </div>
      )}
      <div className="chg-body">{body}</div>
    </aside>
  );
}
