import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useSettings } from "../lib/settings";
import { modKey } from "../lib/platform";
import { t, tn } from "../lib/i18n";
import { MAX_PINNED, setPinned, usePinned } from "../lib/context";
import { Icon } from "./Glyphs";
import { ForkGlyph } from "./WorktreeBar";
import "./composer.css";
import "./worktree.css";

export type ComposerImage = { data: string /* base64, no data: prefix */; mimeType: string; name: string };
export type SlashCommand = { name: string; description?: string; hint?: string };

type Props = {
  disabled: boolean;
  busy: boolean;
  model?: string;
  /** Replaces the read-only model pill, e.g. with the model picker. */
  modelSlot?: ReactNode;
  /** Replaces the hard-coded "Автономия" pill (lead will pass real controls). */
  controlsSlot?: ReactNode;
  draft: string;
  setDraft: (v: string) => void;
  onSend: (text: string, images: ComposerImage[]) => void;
  /** "!command" runs in the project's shell instead of going to the agent. */
  onShell?: (command: string) => void;
  onAbort: () => void;
  /** omp slash commands */
  commands?: SlashCommand[];
  /** Project file search for @-mentions. Without it, @-mentions are off. */
  searchFiles?: (query: string) => Promise<string[]>;
  /** "Plan first" mode: the agent only plans. The chip shows only when onTogglePlan is set. */
  planMode?: boolean;
  onTogglePlan?: () => void;
  /** "Separate copy" mode: the task runs in its own git worktree. The chip shows only when onToggleIsolated is set. */
  isolated?: boolean;
  onToggleIsolated?: () => void;
  /** Small muted line under the controls, e.g. why the task goes to a copy. Russian source text, passed through t(). */
  isolatedHint?: string;
  /** Project folder: dropped files inside it are mentioned relative to it. */
  projectDir?: string;
  /** Session the pinned files belong to. Without it, pinning is off. */
  sessionKey?: string;
  /** Pinned to the right of the hint line under the field, e.g. the compact session tiles. */
  statusSlot?: ReactNode;
};

const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const IMAGE_PATH = /\.(png|jpe?g|gif|webp)$/i;
const MAX_SUGGESTIONS = 8;
const SEARCH_DEBOUNCE_MS = 120;
const DROP_LINE_MS = 8000;
const DEFAULT_IMAGE_TEXT = "Посмотри на изображение.";

type Trigger = { kind: "cmd" | "file"; query: string; start: number; end: number };
type PopItem = { key: string; label: string; insert: string; description?: string; hint?: string };
type Pop = { kind: "cmd" | "file"; items: PopItem[]; start: number; end: number };

function wordStart(text: string, pos: number) {
  let i = pos;
  while (i > 0 && !/\s/.test(text[i - 1])) i--;
  return i;
}

function wordEnd(text: string, pos: number) {
  let i = pos;
  while (i < text.length && !/\s/.test(text[i])) i++;
  return i;
}

/** Works out whether the caret sits in a slash-command word or an @-mention word. */
function findTrigger(text: string, caret: number, hasFiles: boolean): Trigger | null {
  const pos = Math.min(caret, text.length);
  if (text.startsWith("/")) {
    const firstEnd = wordEnd(text, 0);
    if (pos >= 1 && pos <= firstEnd) return { kind: "cmd", query: text.slice(1, pos), start: 0, end: firstEnd };
  }
  if (!hasFiles) return null;
  const start = wordStart(text, pos);
  if (text[start] !== "@" || pos <= start) return null;
  return { kind: "file", query: text.slice(start + 1, pos), start, end: wordEnd(text, pos) };
}

/** Reads an image file and splits the data URL into mimeType and bare base64. */
function readAsImage(file: File): Promise<ComposerImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      if (!result.startsWith("data:") || comma < 0) {
        reject(new Error("unexpected data URL"));
        return;
      }
      const mimeType = result.slice(5, comma).split(";")[0] || file.type;
      resolve({
        data: result.slice(comma + 1),
        mimeType,
        name: file.name || `image.${file.type.split("/")[1] ?? "png"}`,
      });
    };
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

/** Image returned by the read_image_file command. */
type NativeImage = { data: string; mimeType: string };
type DropPos = { x: number; y: number };

function basename(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

/** Mention text for a dropped path (without "@"): relative inside the project, folders end with "/". */
function mentionPath(abs: string, projectDir: string | undefined, isDir: boolean): string {
  const root = projectDir?.replace(/\/+$/, "");
  let rel = abs;
  if (root) {
    if (abs === root) rel = ".";
    else if (abs.startsWith(`${root}/`)) rel = abs.slice(root.length + 1);
  }
  const clean = rel.replace(/\/+$/, "") || ".";
  return isDir ? `${clean}/` : clean;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Removes "@path" tokens (and the spaces after them) from the text. */
function removeMentions(text: string, paths: string[]): string {
  let out = text;
  for (const p of paths) {
    out = out.replace(new RegExp(`(^|\\s)@${escapeRe(p)}(?=\\s|$)[ \\t]*`, "g"), "$1");
  }
  return out;
}

/**
 * Whether a point from a native drag event (physical px, relative to the webview)
 * is over the element. elementFromPoint uses the same geometry as the page, so it
 * also works when the UI zoom is not 1.
 */
function overElement(at: DropPos, el: HTMLElement | null): boolean {
  if (!el) return false;
  const dpr = window.devicePixelRatio || 1;
  const hit = document.elementFromPoint(at.x / dpr, at.y / dpr);
  return hit !== null && el.contains(hit);
}

function FileGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true" className="cmp-pin-ico">
      <path d="M3.5 1.5h4.6L11 4.4v8.1H3.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M8 1.7v2.8h2.9" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

function PinGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M5 1.8h4l-.6 3.6 1.8 1.8v1H3.8v-1l1.8-1.8z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M7 8.2v4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

export function Composer({
  disabled,
  busy,
  model,
  modelSlot,
  controlsSlot,
  draft,
  setDraft,
  onSend,
  onShell,
  onAbort,
  commands,
  searchFiles,
  planMode = false,
  onTogglePlan,
  isolated = false,
  onToggleIsolated,
  isolatedHint,
  projectDir,
  sessionKey,
  statusSlot,
}: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [composing, setComposing] = useState(false);

  const uid = useId();
  const listId = `${uid}-list`;

  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [closed, setClosed] = useState(false);
  const pendingCaret = useRef<number | null>(null);

  const [images, setImages] = useState<ComposerImage[]>([]);
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const [notice, setNotice] = useState<{ key: string; vars?: Record<string, string | number> } | null>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  /** Mentions added by the last drop of non-image paths; offers "Pin". */
  const [dropped, setDropped] = useState<{ paths: string[] } | null>(null);
  const pinned = usePinned(sessionKey);

  const hasSearch = searchFiles !== undefined;
  const searchRef = useRef(searchFiles);
  searchRef.current = searchFiles;
  const [fileRes, setFileRes] = useState<{ query: string; items: string[] } | null>(null);

  const trigger = useMemo(() => findTrigger(draft, caret, hasSearch), [draft, caret, hasSearch]);
  const fileQuery = trigger?.kind === "file" ? trigger.query : null;

  const cmdItems = useMemo(() => {
    if (trigger?.kind !== "cmd") return [];
    const q = trigger.query.toLowerCase();
    const startsWith = (c: SlashCommand) => c.name.toLowerCase().startsWith(q);
    return (commands ?? [])
      .filter((c) => c.name.toLowerCase().includes(q))
      .sort((a, b) => Number(!startsWith(a)) - Number(!startsWith(b)))
      .slice(0, MAX_SUGGESTIONS);
  }, [trigger, commands]);

  // Debounced project file search for @-mentions.
  useEffect(() => {
    if (fileQuery === null) {
      setFileRes(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const search = searchRef.current;
      if (!search) return;
      search(fileQuery).then(
        (items) => {
          if (!cancelled) setFileRes({ query: fileQuery, items: items.slice(0, MAX_SUGGESTIONS) });
        },
        () => {
          if (!cancelled) setFileRes({ query: fileQuery, items: [] });
        },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [fileQuery]);

  const pop: Pop | null = useMemo(() => {
    if (!trigger || closed) return null;
    if (trigger.kind === "cmd") {
      if (!cmdItems.length) return null;
      return {
        kind: "cmd",
        start: trigger.start,
        end: trigger.end,
        items: cmdItems.map((c) => ({
          key: c.name,
          label: c.name,
          insert: `/${c.name} `,
          description: c.description,
          hint: c.hint,
        })),
      };
    }
    if (!fileRes || fileRes.query !== trigger.query || !fileRes.items.length) return null;
    return {
      kind: "file",
      start: trigger.start,
      end: trigger.end,
      items: fileRes.items.map((p) => ({ key: p, label: p, insert: `@${p} ` })),
    };
  }, [trigger, closed, cmdItems, fileRes]);

  const activeIdx = pop ? Math.min(active, pop.items.length - 1) : 0;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
    if (pendingCaret.current !== null) {
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [draft]);

  useEffect(() => {
    if (!disabled) ref.current?.focus();
  }, [disabled]);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(t);
  }, [notice]);

  useEffect(() => {
    if (!dropped) return;
    const timer = window.setTimeout(() => setDropped(null), DROP_LINE_MS);
    return () => window.clearTimeout(timer);
  }, [dropped]);

  const settings = useSettings();
  const shellMode = !!onShell && draft.startsWith("!");
  const canSend = !disabled && (draft.trim().length > 0 || images.length > 0) && !(shellMode && !draft.slice(1).trim());

  const submit = () => {
    if (!canSend) return;
    if (shellMode && onShell) {
      onShell(draft.slice(1).trim());
      setDraft("");
      setClosed(true);
      return;
    }
    const typed = draft.trim() || t(DEFAULT_IMAGE_TEXT);
    // Pinned files travel with every message of the session.
    const text = pinned.length
      ? `${typed}\n\n${t("Закреплённые файлы:")} ${pinned.map((p) => `@${p}`).join(" ")}`
      : typed;
    onSend(text, images);
    setDraft("");
    setImages([]);
    setClosed(true);
    setDropped(null);
  };

  const accept = (item: PopItem) => {
    if (!pop) return;
    const rest = draft.slice(pop.end).replace(/^[ \t]+/, "");
    const next = draft.slice(0, pop.start) + item.insert + rest;
    const at = pop.start + item.insert.length;
    pendingCaret.current = at;
    setCaret(at);
    setActive(0);
    setClosed(true);
    setDraft(next);
    ref.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (composing || e.nativeEvent.isComposing) return;
    if (pop) {
      const n = pop.items.length;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((activeIdx + 1) % n);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((activeIdx - 1 + n) % n);
        return;
      }
      if ((e.key === "Enter" && !e.shiftKey) || (e.key === "Tab" && !e.shiftKey)) {
        e.preventDefault();
        accept(pop.items[activeIdx]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setClosed(true);
        return;
      }
    }
    // Send key follows the setting: Enter, or ⌘/Ctrl+Enter (then Enter is a newline).
    const sendKey =
      settings.sendWith === "mod-enter"
        ? e.key === "Enter" && (e.metaKey || e.ctrlKey)
        : e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey;
    if (sendKey) {
      e.preventDefault();
      submit();
    }
  };

  const attach = async (files: File[]) => {
    if (disabled || files.length === 0) return;
    const typed = files.filter((f) => IMAGE_TYPES.includes(f.type));
    if (typed.length !== files.length) setNotice({ key: "Поддерживаются только PNG, JPEG, GIF и WebP" });
    const sized = typed.filter((f) => {
      if (f.size <= MAX_IMAGE_BYTES) return true;
      setNotice({ key: "Файл «{name}» больше 5 МБ", vars: { name: f.name } });
      return false;
    });
    const room = Math.max(0, MAX_IMAGES - imagesRef.current.length);
    if (sized.length > room) setNotice({ key: "Можно прикрепить не больше {count} изображений", vars: { count: MAX_IMAGES } });
    const take = sized.slice(0, room);
    if (take.length === 0) return;
    const results = await Promise.allSettled(take.map(readAsImage));
    const loaded = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    if (loaded.length) setImages((prev) => [...prev, ...loaded].slice(0, MAX_IMAGES));
    if (loaded.length < take.length) setNotice({ key: "Не удалось прочитать изображение" });
  };

  const removeImage = (index: number) => setImages((prev) => prev.filter((_, i) => i !== index));

  /** Adds images read from disk, with the same count limit as pasted ones. */
  const commitImages = (loaded: ComposerImage[]) => {
    const room = Math.max(0, MAX_IMAGES - imagesRef.current.length);
    if (loaded.length > room) setNotice({ key: "Можно прикрепить не больше {count} изображений", vars: { count: MAX_IMAGES } });
    const take = loaded.slice(0, room);
    if (take.length) setImages((prev) => [...prev, ...take].slice(0, MAX_IMAGES));
  };

  /** Puts "@path" mentions at the caret, separated by spaces. */
  const insertMentions = (paths: string[]) => {
    const el = ref.current;
    const text = draftRef.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? start;
    const before = text.slice(0, start);
    const after = text.slice(end).replace(/^[ \t]+/, "");
    const lead = before && !/\s$/.test(before) ? " " : "";
    const insert = `${lead}${paths.map((p) => `@${p}`).join(" ")} `;
    const at = before.length + insert.length;
    pendingCaret.current = at;
    setCaret(at);
    setActive(0);
    setClosed(true);
    setDraft(before + insert + after);
    ref.current?.focus();
  };

  const pinPaths = (paths: string[]) => {
    if (!sessionKey) return;
    const fresh = paths.filter((p) => !pinned.includes(p));
    const room = Math.max(0, MAX_PINNED - pinned.length);
    if (fresh.length > room) setNotice({ key: "Можно закрепить не больше {count} файлов", vars: { count: MAX_PINNED } });
    setPinned(sessionKey, [...pinned, ...fresh.slice(0, room)]);
  };

  const unpin = (path: string) => {
    if (sessionKey) setPinned(sessionKey, pinned.filter((p) => p !== path));
  };

  const togglePin = (path: string) => (pinned.includes(path) ? unpin(path) : pinPaths([path]));

  const pinDropped = () => {
    if (!dropped) return;
    pinPaths(dropped.paths);
    setDraft(removeMentions(draft, dropped.paths));
    setDropped(null);
  };

  /** Tauri native drop: files and folders from Finder. Only drops over the composer count. */
  const hoverNative = (at: DropPos | null) => {
    setDragging(at !== null && !disabled && overElement(at, composerRef.current));
  };

  const dropNative = async (paths: string[], at: DropPos) => {
    if (disabled || !overElement(at, composerRef.current)) return;
    const images = paths.filter((p) => IMAGE_PATH.test(p));
    const others = paths.filter((p) => !IMAGE_PATH.test(p));

    if (images.length) {
      const results = await Promise.allSettled(images.map((p) => invoke<NativeImage>("read_image_file", { path: p })));
      const loaded: ComposerImage[] = [];
      results.forEach((r, i) => {
        if (r.status === "fulfilled") {
          loaded.push({ data: r.value.data, mimeType: r.value.mimeType, name: basename(images[i]) });
        } else {
          setNotice({ key: String(r.reason) });
        }
      });
      commitImages(loaded);
    }

    if (others.length) {
      const dirs = await Promise.all(
        others.map((p) => invoke<boolean>("path_is_dir", { path: p }).catch(() => false)),
      );
      const mentions = others.map((p, i) => mentionPath(p, projectDir, dirs[i]));
      insertMentions(mentions);
      setDropped({ paths: mentions });
    }
  };

  // Latest handlers for the Tauri listener, which is registered once.
  const nativeHandlers = useRef({
    hover: (_at: DropPos | null) => {},
    drop: (_paths: string[], _at: DropPos) => {},
  });
  nativeHandlers.current = { hover: hoverNative, drop: (paths, at) => void dropNative(paths, at) };

  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "drop") {
          nativeHandlers.current.hover(null);
          nativeHandlers.current.drop(p.paths, p.position);
        } else if (p.type === "leave") {
          nativeHandlers.current.hover(null);
        } else {
          nativeHandlers.current.hover(p.position);
        }
      })
      .then((stop) => {
        if (alive) unlisten = stop;
        else stop();
      })
      .catch(() => {
        /* no native drop: the HTML5 handlers below still work for pasted and dragged images */
      });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (disabled || !e.clipboardData) return;
    const items = Array.from(e.clipboardData.items);
    const files = items
      .filter((i) => i.kind === "file" && i.type.startsWith("image/"))
      .map((i) => i.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length === 0) return;
    // Keep plain-text paste working when the clipboard carries text alongside the image.
    const hasText = items.some((i) => i.kind === "string" && i.type === "text/plain");
    if (!hasText) e.preventDefault();
    void attach(files);
  };

  const hasFileData = (e: DragEvent<HTMLDivElement>) => Array.from(e.dataTransfer.types).includes("Files");

  // File drags are always swallowed here so the webview never navigates to a dropped file.
  const onDragEnter = (e: DragEvent<HTMLDivElement>) => {
    if (!hasFileData(e)) return;
    e.preventDefault();
    if (disabled) return;
    dragDepth.current += 1;
    setDragging(true);
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!hasFileData(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = disabled ? "none" : "copy";
  };

  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (!hasFileData(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!hasFileData(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    // In Tauri the native drop (above) handles files; attaching here too would add them twice.
    if (isTauri()) return;
    void attach(Array.from(e.dataTransfer.files));
  };

  const showDrop = dragging && !disabled;

  return (
    <div className="composer-wrap">
      <div
        ref={composerRef}
        className={`composer${showDrop ? " is-dragging" : ""}${shellMode ? " is-shell" : ""}`}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {notice && (
          <div className="cmp-notice" role="status">
            {t(notice.key, notice.vars)}
          </div>
        )}
        {images.length > 0 && (
          <div className="cmp-thumbs">
            {images.map((img, i) => (
              <div className="cmp-thumb" key={`${i}-${img.name}`}>
                <img src={`data:${img.mimeType};base64,${img.data}`} alt={img.name} />
                <button
                  type="button"
                  className="cmp-thumb-x"
                  onClick={() => removeImage(i)}
                  aria-label={t("Убрать картинку")}
                  title={t("Убрать")}
                >
                  <Icon name="close" size={10} />
                </button>
              </div>
            ))}
          </div>
        )}
        {sessionKey && pinned.length > 0 && (
          <div className="cmp-pins" role="group" aria-label={t("Закреплённые файлы")}>
            {pinned.map((p) => (
              <span className="cmp-pin-chip" key={p} title={p}>
                <FileGlyph />
                <span className="cmp-pin-name">{basename(p)}</span>
                <button
                  type="button"
                  className="cmp-pin-x"
                  onClick={() => unpin(p)}
                  aria-label={t("Открепить")}
                  title={t("Открепить")}
                >
                  <Icon name="close" size={10} />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={ref}
          rows={2}
          value={draft}
          disabled={disabled}
          placeholder={
            busy ? t("Уточнить задачу на ходу…") : planMode ? t("Опишите задачу — агент сначала предложит план") : t("Опишите задачу")
          }
          aria-label={t("Сообщение агенту")}
          // Prompts often carry code: no smart quotes, autocorrect or capitalization.
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={pop !== null}
          aria-controls={pop ? listId : undefined}
          aria-activedescendant={pop ? `${listId}-${activeIdx}` : undefined}
          onChange={(e) => {
            setDraft(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setActive(0);
            setClosed(false);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onClick={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onBlur={() => setClosed(true)}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <div className="composer-bar">
          <div className="cmp-tools">
          <button
            type="button"
            className="cmp-attach"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled}
            aria-label={t("Прикрепить изображение")}
            title={t("Прикрепить изображение")}
          >
            <Icon name="plus" size={14} />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              void attach(files);
            }}
          />
          {modelSlot ?? <span className="pill-btn" title={t("Текущая модель")}>{model ?? t("модель…")}</span>}
          {controlsSlot ?? (
            <span className="pill-btn" title={t("Агент спрашивает перед записью и командами")}>
              {t("Автономия")}
              <span style={{ display: "flex", gap: 3 }} aria-label={t("средняя")}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent-ink)" }} />
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent-ink)" }} />
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--dot)" }} />
              </span>
            </span>
          )}
          </div>
          <div className="cmp-actions">
          {onTogglePlan && (
            <button
              type="button"
              className="ctl-pill cmp-toggle cmp-plan"
              onClick={onTogglePlan}
              disabled={busy}
              aria-pressed={planMode}
              aria-label={t("План")}
              title={t("Сначала план: агент изучит проект и предложит план, ничего не меняя")}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" className="cmp-plan-icon">
                <rect x="1.5" y="1.5" width="4" height="4" rx="1.4" stroke="currentColor" strokeWidth="1.5" strokeDasharray="0 2.6" strokeLinecap="round" />
                <rect x="1.5" y="8.5" width="4" height="4" rx="1.4" stroke="currentColor" strokeWidth="1.5" strokeDasharray="0 2.6" strokeLinecap="round" />
                <path d="M7.5 3.5h5M7.5 10.5h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          )}
          {onToggleIsolated && (
            <button
              type="button"
              className="ctl-pill cmp-toggle cmp-isolated"
              onClick={onToggleIsolated}
              disabled={busy}
              aria-pressed={isolated}
              aria-label={t("Копия")}
              title={t("Отдельная копия проекта: агент работает в своей git-ветке и не мешает другим задачам")}
            >
              <ForkGlyph size={14} className="cmp-isolated-icon" />
            </button>
          )}
          {busy && (
            <button className="send stop" onClick={onAbort} aria-label={t("Остановить агента")} title={t("Остановить")}>
              <Icon name="stop" />
            </button>
          )}
          <button className="send" onClick={submit} disabled={!canSend} aria-label={t("Отправить")}>
            <Icon name="send" />
          </button>
          </div>
        </div>
        {isolatedHint && <div className="cmp-isolated-hint">{t(isolatedHint)}</div>}
        {pop && (
          <div
            id={listId}
            role="listbox"
            className={`cmp-pop cmp-pop-${pop.kind}`}
            aria-label={pop.kind === "cmd" ? t("Команды") : t("Файлы проекта")}
          >
            {pop.items.map((item, i) => (
              <div
                key={item.key}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === activeIdx}
                className={`cmp-opt${i === activeIdx ? " is-active" : ""}`}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => accept(item)}
              >
                {pop.kind === "cmd" ? (
                  <>
                    <span className="cmp-opt-name">/{item.label}</span>
                    {item.description && <span className="cmp-opt-desc">{item.description}</span>}
                    {item.hint && <span className="cmp-opt-hint">{item.hint}</span>}
                  </>
                ) : (
                  <>
                    <span className="cmp-opt-path">{item.label}</span>
                    {sessionKey && (
                      <button
                        type="button"
                        className={`cmp-pin-btn${pinned.includes(item.label) ? " is-on" : ""}`}
                        aria-pressed={pinned.includes(item.label)}
                        aria-label={pinned.includes(item.label) ? t("Открепить") : t("Закрепить в сессии")}
                        title={pinned.includes(item.label) ? t("Открепить") : t("Закрепить в сессии")}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={(e) => {
                          e.stopPropagation();
                          togglePin(item.label);
                        }}
                      >
                        <PinGlyph />
                      </button>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>
        )}
        {showDrop && (
          <div className="cmp-drop" aria-hidden="true">
            {t("Отпустите, чтобы прикрепить")}
          </div>
        )}
      </div>
      {dropped && (
        <div className="cmp-added" role="status">
          <span>{t("Добавлено: {n}", { n: tn(dropped.paths.length, "файл|файла|файлов") })}</span>
          {sessionKey && (
            <button type="button" className="cmp-added-pin" onClick={pinDropped}>
              {t("Закрепить")}
            </button>
          )}
        </div>
      )}
      <div className={statusSlot ? "hint has-status" : "hint"}>
        <span className="hint-text">
          {shellMode
            ? t("Команда выполнится в папке проекта, агент увидит вывод")
            : settings.sendWith === "mod-enter"
              ? t("{key} — отправить · Enter — новая строка · ! — команда в терминале", { key: modKey("Enter") })
              : t("Enter — отправить · Shift+Enter — новая строка · ! — команда в терминале")}
        </span>
        {statusSlot && <div className="hint-status">{statusSlot}</div>}
      </div>
    </div>
  );
}
