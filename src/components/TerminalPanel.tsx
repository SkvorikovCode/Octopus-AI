// Bottom terminal panel of a session: tabs of real shells in the project folder.
// Each tab is an xterm.js view bound to one PTY (src/lib/pty.ts). Tabs stay
// mounted while the panel is hidden, so their sessions keep running.

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";
import { t, tErr } from "../lib/i18n";
import { closePty, onPtyData, onPtyExit, openPty, resizePty, writePty } from "../lib/pty";

const SHELL_NAME = "zsh";
const DEFAULT_HEIGHT = 260;
const MIN_HEIGHT = 140;
const MAX_HEIGHT_VH = 0.7;
const SEND_LINES = 60;

export type TerminalPanelProps = {
  cwd: string;
  open: boolean;
  onClose: () => void;
  onSendToAgent?: (text: string) => void;
  height?: number;
  onHeightChange?: (h: number) => void;
};

type TabHandle = {
  getSelection: () => string;
  getRecentText: (lines: number) => string;
  focus: () => void;
};

type TabInfo = { key: number; exited: boolean };

const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Selection color: the accent at 30%. Resolved through a probe element, since xterm needs a concrete color. */
function selectionColor(): string | undefined {
  const probe = document.createElement("span");
  probe.style.color = "var(--accent)";
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  const m = /(-?[\d.]+)[,\s]+(-?[\d.]+)[,\s]+(-?[\d.]+)/.exec(resolved);
  if (!m) return undefined;
  // color(srgb r g b) uses 0..1 channels; rgb() uses 0..255.
  const k = resolved.startsWith("color(") ? 255 : 1;
  const [r, g, b] = [m[1], m[2], m[3]].map((v) => Math.round(Math.min(255, Math.max(0, Number(v) * k))));
  return `rgba(${r}, ${g}, ${b}, 0.3)`;
}

function termTheme(): ITheme {
  const bg = cssVar("--code-bg");
  return {
    background: bg || undefined,
    foreground: cssVar("--ink") || undefined,
    cursor: cssVar("--accent") || undefined,
    cursorAccent: bg || undefined,
    selectionBackground: selectionColor(),
  };
}

/** Last `lines` non-empty lines of the terminal's buffer. */
function recentText(term: Terminal | null, lines: number): string {
  if (!term) return "";
  const buf = term.buffer.active;
  const from = Math.max(0, buf.length - lines - term.rows);
  const rows: string[] = [];
  for (let i = from; i < buf.length; i++) rows.push(buf.getLine(i)?.translateToString(true) ?? "");
  while (rows.length && rows[rows.length - 1] === "") rows.pop();
  return rows.slice(-lines).join("\n");
}

/**
 * One terminal: an xterm view and its PTY. Unmounting closes the PTY.
 * `cwd` is read once, at mount: later changes only affect new tabs.
 */
function TerminalTab({
  tabKey,
  cwd,
  visible,
  onExit,
  registry,
}: {
  tabKey: number;
  cwd: string;
  visible: boolean;
  onExit: () => void;
  registry: Map<number, TabHandle>;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const exitRef = useRef(onExit);
  useEffect(() => {
    exitRef.current = onExit;
  });

  useEffect(() => {
    registry.set(tabKey, {
      getSelection: () => (termRef.current?.hasSelection() ? termRef.current.getSelection() : ""),
      getRecentText: (lines) => recentText(termRef.current, lines),
      focus: () => termRef.current?.focus(),
    });
    return () => {
      registry.delete(tabKey);
    };
  }, [tabKey, registry]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      fontFamily: '"JetBrains Mono Variable", ui-monospace, monospace',
      fontSize: 12.5,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5000,
      theme: termTheme(),
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);

    let disposed = false;
    let ptyId: number | null = null;
    let exited = false;
    let sent = { cols: 0, rows: 0 };
    const typedBeforeOpen: string[] = [];

    const safeFit = () => {
      // Hidden (display: none) or not laid out yet: nothing to measure.
      if (disposed || host.offsetWidth === 0 || host.offsetHeight === 0) return;
      try {
        fit.fit();
      } catch {
        /* the terminal is not attached yet */
      }
    };

    const syncSize = () => {
      if (ptyId === null || (term.cols === sent.cols && term.rows === sent.rows)) return;
      sent = { cols: term.cols, rows: term.rows };
      resizePty(ptyId, term.cols, term.rows).catch(() => {});
    };

    const offResize = term.onResize(syncSize);
    const offInput = term.onData((data) => {
      if (exited) return;
      if (ptyId === null) typedBeforeOpen.push(data);
      else writePty(ptyId, data).catch(() => {});
    });

    // ⌘C (Ctrl+Shift+C elsewhere) copies a selection; without one it goes to the shell.
    term.attachCustomKeyEventHandler((e) => {
      const copy = e.type === "keydown" && e.key.toLowerCase() === "c" && (e.metaKey || (e.ctrlKey && e.shiftKey));
      if (copy && term.hasSelection()) {
        e.preventDefault();
        navigator.clipboard?.writeText(term.getSelection()).catch(() => {});
        return false;
      }
      return true;
    });

    const offData = onPtyData(({ id, data }) => {
      if (id === ptyId) term.write(data);
    });
    const offExit = onPtyExit(({ id }) => {
      if (id !== ptyId || exited) return;
      exited = true;
      term.write(`\r\n\x1b[2m${t("[процесс завершён]")}\x1b[0m\r\n`);
      exitRef.current();
    });

    const applyTheme = () => {
      term.options.theme = termTheme();
    };
    const themeObserver = new MutationObserver(applyTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    scheme.addEventListener("change", applyTheme);

    const resizeObserver = new ResizeObserver(safeFit);
    resizeObserver.observe(host);
    safeFit();
    void document.fonts?.ready.then(safeFit);

    openPty(cwd, term.cols, term.rows).then(
      (id) => {
        if (disposed) {
          closePty(id).catch(() => {});
          return;
        }
        ptyId = id;
        syncSize();
        for (const data of typedBeforeOpen.splice(0)) writePty(id, data).catch(() => {});
      },
      (e: unknown) => {
        if (disposed) return;
        exited = true;
        term.write(`\r\n\x1b[31m${tErr(e)}\x1b[0m\r\n`);
        exitRef.current();
      },
    );

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      themeObserver.disconnect();
      scheme.removeEventListener("change", applyTheme);
      offResize.dispose();
      offInput.dispose();
      offData();
      offExit();
      if (ptyId !== null) closePty(ptyId).catch(() => {});
      term.dispose();
      termRef.current = null;
    };
    // Mount-only on purpose: a tab keeps its shell when the panel's cwd changes.
  }, []);

  return <div ref={hostRef} className="term-pane" style={{ display: visible ? "block" : "none" }} />;
}

export function TerminalPanel({ cwd, open, onClose, onSendToAgent, height, onHeightChange }: TerminalPanelProps) {
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [activeKey, setActiveKey] = useState<number | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const seq = useRef(0);
  const started = useRef(false);
  const handles = useRef(new Map<number, TabHandle>());

  const clampHeight = useCallback(
    (h: number) => Math.min(Math.max(h, MIN_HEIGHT), Math.floor(window.innerHeight * MAX_HEIGHT_VH)),
    [],
  );
  const shownHeight = clampHeight(drag ?? height ?? DEFAULT_HEIGHT);

  const addTab = useCallback(() => {
    const key = ++seq.current;
    setTabs((prev) => [...prev, { key, exited: false }]);
    setActiveKey(key);
  }, []);

  // The first terminal is created when the panel is opened for the first time.
  useEffect(() => {
    if (open && !started.current) {
      started.current = true;
      addTab();
    }
  }, [open, addTab]);

  // Typing goes to the terminal once it's shown. The xterm instance of a new tab
  // attaches a moment after mount, so retry briefly.
  useEffect(() => {
    if (!open || activeKey === null) return;
    const focus = () => handles.current.get(activeKey)?.focus();
    focus();
    const timers = [50, 150, 400].map((ms) => window.setTimeout(focus, ms));
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, [open, activeKey]);

  const closeTab = (key: number) => {
    const idx = tabs.findIndex((tab) => tab.key === key);
    const next = tabs.filter((tab) => tab.key !== key);
    setTabs(next);
    if (activeKey === key) setActiveKey(next[Math.min(idx, next.length - 1)]?.key ?? null);
  };

  const markExited = (key: number) => {
    setTabs((prev) => prev.map((tab) => (tab.key === key ? { ...tab, exited: true } : tab)));
  };

  const onGripDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = shownHeight;
    let last = startHeight;
    const move = (ev: PointerEvent) => {
      last = clampHeight(startHeight + (startY - ev.clientY));
      setDrag(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setDrag(null);
      if (last !== startHeight) onHeightChange?.(last);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const sendToAgent = () => {
    if (!onSendToAgent || activeKey === null) return;
    const handle = handles.current.get(activeKey);
    const text = (handle?.getSelection() || handle?.getRecentText(SEND_LINES) || "").trimEnd();
    if (!text) return;
    onSendToAgent(`${t("Вывод терминала:")}\n\`\`\`\n${text}\n\`\`\``);
  };

  return (
    <section
      className="term"
      style={{ height: shownHeight, display: open ? undefined : "none" }}
      aria-label={t("ТЕРМИНАЛ")}
    >
      <div
        className="term-grip"
        role="separator"
        aria-orientation="horizontal"
        aria-label={t("Изменить высоту терминала")}
        onPointerDown={onGripDown}
      />
      <header className="term-head">
        <span className="label term-label">{t("ТЕРМИНАЛ")}</span>
        <div className="term-tabs" role="tablist">
          {tabs.map((tab) => (
            <div
              key={tab.key}
              className={`term-tab${tab.key === activeKey ? " is-active" : ""}${tab.exited ? " is-exited" : ""}`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={tab.key === activeKey}
                className="term-tab-name"
                onClick={() => setActiveKey(tab.key)}
              >
                {`${SHELL_NAME} ${tab.key}`}
              </button>
              <button
                type="button"
                className="term-tab-close"
                aria-label={t("Закрыть терминал")}
                title={t("Закрыть терминал")}
                onClick={() => closeTab(tab.key)}
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            className="term-icon"
            aria-label={t("Новый терминал")}
            title={t("Новый терминал")}
            onClick={addTab}
          >
            +
          </button>
        </div>
        <div className="term-actions">
          {onSendToAgent && (
            <button
              type="button"
              className="term-btn"
              disabled={activeKey === null}
              onClick={sendToAgent}
            >
              {t("Отправить агенту")}
            </button>
          )}
          <button
            type="button"
            className="term-icon"
            aria-label={t("Скрыть")}
            title={t("Скрыть")}
            onClick={onClose}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <path
                d="M2.5 4.5 6 8l3.5-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </header>
      <div className="term-body">
        {tabs.length === 0 && (
          <button type="button" className="term-empty" onClick={addTab}>
            {t("Новый терминал")}
          </button>
        )}
        {tabs.map((tab) => (
          <TerminalTab
            key={tab.key}
            tabKey={tab.key}
            registry={handles.current}
            cwd={cwd}
            visible={open && tab.key === activeKey}
            onExit={() => markExited(tab.key)}
          />
        ))}
      </div>
    </section>
  );
}
