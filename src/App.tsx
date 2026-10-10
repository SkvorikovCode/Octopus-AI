import { invoke, isTauri } from "@tauri-apps/api/core";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { Composer, type ComposerImage, type SlashCommand } from "./components/Composer";
import { AutonomyPicker, ThinkingPicker, type ApprovalMode } from "./components/Controls";
import { Emblem, Icon } from "./components/Glyphs";
import { Home } from "./components/Home";
import { ModelPicker, type AvailableModel } from "./components/ModelPicker";
import type { ModelCost } from "./lib/providers";
import { DebugDrawer } from "./components/Overlays";
import { ProviderModal } from "./components/ProviderModal";
import { ChangesCard, ChangesPanel } from "./components/Changes";
import { SwarmTranscript } from "./components/SwarmTranscript";
import { SettingsScreen, type SettingsTab } from "./components/Settings";
import { FileViewer } from "./components/FileViewer";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { StatsScreen } from "./components/Stats";
import { ConnectionsScreen } from "./components/Connections";
import { CommandPalette, type PaletteItem, type TextHitItem } from "./components/CommandPalette";
import { forgetProject, getRecentProjects, touchProject, type RecentProject } from "./lib/projects";
import { Sidebar, type View } from "./components/Sidebar";
import { Swarm } from "./components/Swarm";
import { Thread } from "./components/Thread";
import { Tiles } from "./components/Tiles";
import { Onboarding } from "./components/Onboarding";
import { isOnboarded, markOnboarded } from "./lib/onboarding";
import { homeDir } from "@tauri-apps/api/path";
import { PlanCard } from "./components/PlanCard";
import { displayPath } from "./lib/instructions";
import { approvePrompt, planPrompt, revisePrompt } from "./lib/plan";
import { DEMO_PROJECT, DEMO_SESSIONS, DemoClient } from "./lib/demo";
import { OmpClient, type Frame } from "./lib/omp";
import { describeApproval, initialSession, type Ask } from "./lib/session";
import { Runtime, rememberCheckpoint, sessionCheckpoints, type RuntimeSnapshot } from "./lib/runtime";
import { checkpointChanges, createCheckpoint, restoreCheckpoint, type CheckpointChange } from "./lib/checkpoints";
import { notifyIfAway } from "./lib/notify";
import { fileStem, sessionToMarkdown } from "./lib/exportMd";
import { useSettings } from "./lib/settings";
import { expandTemplate, useTemplates } from "./lib/templates";
import { gitDiff, gitStatus, projectFiles, type GitStatus } from "./lib/workspace";
import { CommitModal } from "./components/CommitModal";
import { WorktreeBar } from "./components/WorktreeBar";
import { TerminalPanel } from "./components/TerminalPanel";
import { BudgetBanner } from "./components/BudgetBanner";
import { allowOverSession, allowOverToday, budgetState, isOverAllowed, todaySpend } from "./lib/budget";
import { applyWorktree, createWorktree, listWorktrees, removeWorktree } from "./lib/worktrees";
import type { Subagent } from "./lib/swarm";
import { listSessions, type SessionMeta } from "./lib/sessions";
import { searchSessions } from "./lib/search";
import { initialSwarm, swarmCounts } from "./lib/swarm";
import { t, tErr } from "./lib/i18n";
import { setMarkdownFileOpener } from "./components/Markdown";

const PROJECT_KEY = "octopus.project";
const APPROVAL_KEY = "octopus.approval";
/** Outside Tauri (browser preview) a scripted engine stands in for omp. */
const DEMO = !isTauri();

const noSubscribe = () => () => {};
const EMPTY_SNAPSHOT: RuntimeSnapshot = { state: initialSession, swarm: initialSwarm, unread: false };
const emptySnapshot = () => EMPTY_SNAPSHOT;

function savedApproval(): ApprovalMode {
  try {
    const v = localStorage.getItem(APPROVAL_KEY);
    if (v === "always-ask" || v === "write" || v === "yolo") return v;
  } catch {
    /* default below */
  }
  return "write";
}

function savedProject(): string | undefined {
  if (DEMO) return DEMO_PROJECT;
  try {
    return localStorage.getItem(PROJECT_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export default function App() {
  const settings = useSettings();
  const templates = useTemplates();
  const [view, setView] = useState<View>("session");
  const [project, setProject] = useState<string | undefined>(savedProject);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>(getRecentProjects);
  const [ompPath, setOmpPath] = useState<string | null | undefined>(undefined);
  const [home, setHome] = useState<string | undefined>(DEMO ? "/Users/demo" : undefined);
  useEffect(() => {
    if (!DEMO) homeDir().then(setHome).catch(() => {});
  }, []);
  const [debugOpen, setDebugOpen] = useState(false);
  const [draft, setDraft] = useState("");
  /** Models the agent offers, with the price it will charge (own, catalog or zero). */
  const [models, setModels] = useState<(AvailableModel & { cost?: ModelCost })[]>([]);
  const [providersOpen, setProvidersOpen] = useState(false);
  const [changes, setChanges] = useState<GitStatus | null>(null);
  const [changesOpen, setChangesOpen] = useState(false);
  const [commitOpen, setCommitOpen] = useState(false);
  /** Changes panel for another folder than the shown agent's (the project, after moving a copy back). */
  const [changesFor, setChangesFor] = useState<string | undefined>();
  /** Next task in this empty session goes to a separate git worktree copy. */
  const [isolated, setIsolated] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  /** Open settings on a given tab. */
  const openSettings = (tab: SettingsTab = "general") => {
    setSettingsTab(tab);
    setView("settings");
  };
  const [termOpen, setTermOpen] = useState(false);
  const [termHeight, setTermHeight] = useState(() => {
    try {
      return Number(localStorage.getItem("octopus.terminalHeight")) || 260;
    } catch {
      return 260;
    }
  });
  /** Money spent today across all projects (for the daily budget). */
  const [daySpent, setDaySpent] = useState(0);
  const [budgetVersion, bumpBudget] = useReducer((n: number) => n + 1, 0);
  /** Session id → branch, for sessions that live in a worktree copy. */
  const [worktreeOf, setWorktreeOf] = useState<ReadonlyMap<string, string>>(new Map());
  const [transcriptOf, setTranscriptOf] = useState<Subagent | null>(null);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** Next task goes "plan first": the agent proposes a plan before changing anything. */
  const [planMode, setPlanMode] = useState(false);
  /** First run: a short setup screen instead of the empty states. */
  const [onboarding, setOnboarding] = useState(() => (DEMO ? location.search.includes("onboarding") : !isOnboarded()));
  const [viewFile, setViewFile] = useState<{ path: string; line?: number } | null>(null);
  // File paths in the agent's replies open the viewer.
  useEffect(() => {
    setMarkdownFileOpener((path, line) => setViewFile({ path, line }));
    return () => setMarkdownFileOpener(undefined);
  }, []);
  const [approval, setApproval] = useState<ApprovalMode>(savedApproval);
  const approvalRef = useRef(approval);
  approvalRef.current = approval;
  const projectRef = useRef(project);
  projectRef.current = project;
  const pruned = useRef(new Set<string>());

  // ---------- runtimes: one agent process per running session ----------
  const runtimes = useRef(new Map<number, Runtime>());
  const [activeId, setActiveId] = useState(0);
  /** Bumped when any runtime's status changes, so the sidebar shows what runs. */
  const [runtimesVersion, bumpRuntimes] = useReducer((n: number) => n + 1, 0);
  const active = runtimes.current.get(activeId);
  const rtRef = useRef<Runtime | undefined>(active);
  rtRef.current = active;
  const snap = useSyncExternalStore(active?.subscribe ?? noSubscribe, active?.getSnapshot ?? emptySnapshot);
  const s = snap.state;
  const swarm = snap.swarm;
  const failure = snap.failure;
  /** Notice into the active session's thread. */
  const notice = (message: string, rt = rtRef.current) => rt?.dispatch({ type: "frame", frame: { type: "notice", message } });

  const refreshChanges = useCallback(() => {
    const cwd = rtRef.current?.worktree?.path ?? projectRef.current;
    if (!cwd) return setChanges(null);
    gitStatus(cwd).then(setChanges).catch(() => setChanges(null));
  }, []);

  const refreshSessions = useCallback(() => {
    const cwd = projectRef.current;
    if (!cwd) return setSessions([]);
    if (DEMO) {
      // Demo agents keep their sessions in memory: list the ones with messages.
      const live: SessionMeta[] = [];
      for (const r of runtimes.current.values()) {
        const first = r.state.items.find((it) => it.kind === "user");
        if (!r.state.sessionId || !first || first.kind !== "user") continue;
        live.push({ path: `/demo/live/${r.state.sessionId}`, id: r.state.sessionId, title: r.state.title ?? first.text.slice(0, 60), cwd, updatedAt: Date.now() });
      }
      return setSessions([...live, ...DEMO_SESSIONS]);
    }
    Promise.all([
      listSessions(cwd).catch(() => [] as SessionMeta[]),
      listWorktrees(cwd).catch(() => []),
    ]).then(async ([main, copies]) => {
      const map = new Map<string, string>();
      const extra: SessionMeta[] = [];
      for (const wt of copies) {
        const list = await listSessions(wt.path).catch(() => [] as SessionMeta[]);
        for (const m of list) {
          map.set(m.id, wt.branch);
          extra.push(m);
        }
      }
      setWorktreeOf(map);
      setSessions([...main, ...extra].sort((a, b) => b.updatedAt - a.updatedAt));
    });
  }, []);

  const refresh = useCallback((rt: Runtime | undefined = rtRef.current) => {
    if (!rt || rt.disposed) return;
    const c = rt.client;
    c.request({ type: "get_state" }).then((data) => {
      rt.dispatch({ type: "state", data });
      // Each engine start leaves a header-only session file; tidy old ones once per project.
      const cwd = rt.cwd;
      if (!DEMO && cwd && data?.sessionId && !pruned.current.has(cwd)) {
        pruned.current.add(cwd);
        invoke<number>("sessions_prune_empty", { cwd, keepId: data.sessionId })
          .then((n) => n > 0 && refreshSessions())
          .catch(() => {});
      }
    }).catch(() => {});
    c.request({ type: "get_session_stats" }).then((data) => rt.dispatch({ type: "stats", data })).catch(() => {});
    c.request<{ models: any[] }>({ type: "get_available_models" })
      .then((d) => setModels((d?.models ?? []).map((m) => ({ provider: m.provider, id: m.id, name: m.name, cost: m.cost }))))
      .catch(() => {});
  }, [refreshSessions]);

  const createRuntime = useCallback((): Runtime => {
    const rt = new Runtime();
    const isActive = () => rtRef.current === rt;
    const handlers = {
      onFrame: (frame: Frame) => {
        if (rt.disposed) return;
        rt.dispatch({ type: "frame", frame });
        if (frame.type.startsWith("subagent_")) rt.swarmDispatch({ type: "frame", frame });
        if (frame.type === "btw_record") rt.onSideRecord(frame.record);
        if (frame.type === "available_commands_update" && Array.isArray(frame.commands)) setCommands(toCommands(frame.commands));
        if (frame.type === "ready") {
          const client = rt.client;
          rt.dispatch({ type: "status", status: "idle" });
          client.request({ type: "negotiate_protocol", protocolVersion: 2 }).catch(() => {});
          client.request({ type: "set_subagent_subscription", level: "progress" }).catch(() => {});
          client.request<{ commands: any[] }>({ type: "get_available_commands" })
            .then((d) => setCommands(toCommands(d?.commands ?? [])))
            .catch(() => {});
          const reopen = rt.pendingSession;
          rt.pendingSession = null;
          if (reopen) {
            client.request<{ cancelled?: boolean }>({ type: "switch_session", sessionPath: reopen })
              .then(() => client.request<{ messages: any[] }>({ type: "get_messages" }))
              .then((d) => {
                rt.dispatch({ type: "load", messages: d?.messages ?? [] });
                refresh(rt);
              })
              .catch(() => {});
          }
          const task = rt.pendingPrompt;
          rt.pendingPrompt = null;
          if (task) {
            rt.dispatch({ type: "log", line: { dir: "out", text: JSON.stringify(task) } });
            client.request(task).catch((e) => rt.dispatch({ type: "frame", frame: { type: "notice", message: t("Не отправлено: {error}", { error: tErr(e) }) } }));
          }
          const want = rt.pendingModel;
          rt.pendingModel = null;
          if (want) {
            client.request({ type: "set_model", provider: want.provider, modelId: want.id }).then(() => refresh(rt)).catch(() => refresh(rt));
          } else {
            refresh(rt);
          }
          refreshSessions();
        }
        if (frame.type === "extension_ui_request" && ["confirm", "select", "input", "editor"].includes(frame.method)) {
          const tool = describeApproval(frame.title, frame.options);
          notifyIfAway(t("Octopus ждёт вашего ответа"), tool ? [`${t(tool.action)}?`, ...tool.details].join(" · ") : frame.title || frame.message || t("Нужно решение"));
          if (!isActive()) rt.setUnread(true);
        }
        if (frame.type === "agent_end" && frame.isTerminal !== false) {
          const last = [...(frame.messages ?? [])].reverse().find((m: any) => m?.role === "assistant");
          const text = (Array.isArray(last?.content) ? last.content : []).filter((c: any) => c?.type === "text").map((c: any) => c.text).join(" ").trim();
          notifyIfAway(t("Octopus закончил"), text || t("Задача выполнена"));
          if (rt.snap.plan === "planning") rt.setPlan("ready");
          todaySpend().then(setDaySpent).catch(() => {});
          if (!isActive()) rt.setUnread(true);
          refresh(rt);
          refreshChanges();
          refreshSessions();
          rt.client.request<{ subagents: any[] }>({ type: "get_subagents" })
            .then((d) => rt.swarmDispatch({ type: "snapshot", list: d?.subagents ?? [] }))
            .catch(() => {});
        }
        if (frame.type === "model_changed" || frame.type === "thinking_level_changed") refresh(rt);
        if (frame.type === "message_start" && frame.message?.role === "user") {
          refresh(rt);
          refreshSessions();
        }
        if (frame.type === "session_info_update") refreshSessions();
      },
      onStderr: (line: string) => {
        rt.stderr = [...rt.stderr.slice(-200), line];
        rt.dispatch({ type: "log", line: { dir: "err", text: line } });
      },
      onExit: (code: number | null) => {
        if (rt.disposed) return;
        rt.dispatch({ type: "status", status: "offline" });
        if (rt.stopping) return;
        // Any exit we did not ask for is worth explaining (even code 0).
        rt.setFailure({ code, text: rt.stderr.slice(-12).join("\n") || t("Агент завершился без сообщений.") });
      },
    };
    rt.client = DEMO ? new DemoClient(handlers) : new OmpClient(handlers);
    rt.client.attach();
    rt.onStatus = bumpRuntimes;
    runtimes.current.set(rt.id, rt);
    return rt;
  }, [refresh, refreshSessions, refreshChanges]);

  /** Show this runtime; the previously shown one is stopped if it has nothing going on. */
  const activate = useCallback((rt: Runtime) => {
    const prev = rtRef.current;
    rtRef.current = rt;
    setActiveId(rt.id);
    rt.setUnread(false);
    if (prev && prev !== rt && !prev.busy && !prev.snap.unread) {
      prev.dispose();
      runtimes.current.delete(prev.id);
    }
    bumpRuntimes();
  }, []);

  const startRuntime = useCallback(async (rt: Runtime, cwd: string) => {
    rt.cwd = cwd;
    rt.stderr = [];
    rt.stopping = true;
    rt.setFailure(undefined);
    rt.dispatch({ type: "reset" });
    rt.swarmDispatch({ type: "reset" });
    rt.dispatch({ type: "status", status: "starting" });
    try {
      await rt.client.start(cwd, approvalRef.current);
      rt.stopping = false;
    } catch (e) {
      rt.stopping = false;
      rt.dispatch({ type: "status", status: "offline" });
      rt.setFailure({ code: null, text: tErr(e) });
    }
  }, []);

  // The first runtime lives as long as the app; more appear for parallel tasks.
  useEffect(() => {
    const rt = createRuntime();
    rtRef.current = rt;
    setActiveId(rt.id);
    if (DEMO) setOmpPath("demo");
    else invoke<string | null>("omp_locate").then(setOmpPath);
    const all = runtimes.current;
    return () => {
      all.forEach((r) => r.dispose());
      all.clear();
    };
  }, [createRuntime]);

  /** (Re)start the shown agent in `cwd`; a busy one keeps working in the background. */
  const start = useCallback((cwd: string) => {
    let rt = rtRef.current;
    if (!rt) return;
    setView("session");
    if (rt.busy) {
      rt = createRuntime();
      activate(rt);
    }
    return startRuntime(rt, cwd);
  }, [createRuntime, activate, startRuntime]);

  /** A new agent next to the running ones, optionally opening a saved session. */
  const spawn = (sessionPath?: string, copy?: { path: string; root: string; branch: string }) => {
    if (!project) return;
    const rt = createRuntime();
    rt.pendingSession = sessionPath ?? null;
    rt.worktree = copy;
    activate(rt);
    setView("session");
    // A new task next to a running agent of this project defaults to its own copy.
    if (!sessionPath && changes?.isRepo) setIsolated(true);
    startRuntime(rt, copy?.path ?? project);
    return rt;
  };

  // (Re)start the agent whenever the project changes and the engine is installed.
  useEffect(() => {
    refreshSessions();
    refreshChanges();
    if (project && !DEMO) setRecentProjects(touchProject(project));
    if (project && ompPath && rtRef.current) {
      // Idle background agents of another project have nothing left to show.
      for (const r of runtimes.current.values()) {
        if (r !== rtRef.current && !r.busy && r.cwd !== project) {
          r.dispose();
          runtimes.current.delete(r.id);
        }
      }
      start(project);
    } else if (!project && ompPath && onboarding && rtRef.current && !rtRef.current.cwd) {
      // No folder yet: run the agent outside any project just to list the models.
      const rt = rtRef.current;
      homeDir().then((home) => startRuntime(rt, home)).catch(() => {});
    }
  }, [project, ompPath, activeId === 0, start, refreshSessions, refreshChanges]);

  const switchProject = (dir: string) => {
    try {
      localStorage.setItem(PROJECT_KEY, dir);
    } catch {
      /* this run only */
    }
    if (dir === project) start(dir);
    else setProject(dir);
  };

  const pickProject = async () => {
    if (DEMO) return;
    const dir = await open({ directory: true, multiple: false, title: t("Папка проекта") });
    if (typeof dir !== "string") return;
    try {
      localStorage.setItem(PROJECT_KEY, dir);
    } catch {
      /* remembered for this run only */
    }
    switchProject(dir);
  };

  const busy = s.status === "working" || s.status === "thinking" || s.status === "waiting";
  useEffect(() => {
    todaySpend().then(setDaySpent).catch(() => {});
  }, []);
  const budget = useMemo(
    () => budgetState({ daySpent, sessionSpent: s.stats?.cost ?? 0, daily: settings.budgetDaily, session: settings.budgetSession }),
    [daySpent, s.stats?.cost, settings.budgetDaily, settings.budgetSession, budgetVersion],
  );
  /** Limit reached and not overridden: new tasks wait for the user's OK. */
  const budgetBlocked = budget.level === "over" && !isOverAllowed(budget.scope!, s.sessionId);
  /** Another agent of this project is running right now. */
  const othersBusy = [...runtimes.current.values()].some((x) => x !== active && !x.disposed && x.busy && x.cwd === project);
  /** Folder the shown agent works in: a worktree copy when isolated, else the project. */
  const workCwd = active?.worktree?.path ?? project;
  // The changes panel follows the shown agent (its copy or the project).
  useEffect(() => {
    refreshChanges();
  }, [activeId, refreshChanges]);
  const ready = s.status !== "offline" && s.status !== "starting";

  // ---------- file snapshots before each task ----------
  const [checkpointsVersion, bumpCheckpoints] = useReducer((n: number) => n + 1, 0);
  const checkpoints = useMemo(() => sessionCheckpoints(s.sessionId), [s.sessionId, checkpointsVersion]);
  const restorable = useMemo(() => new Set(Object.keys(checkpoints).map(Number)), [checkpoints]);

  const send = async (raw: string, images: ComposerImage[] = []) => {
    const r = rtRef.current;
    if (!r) return;
    const steer = r.busy;
    if (budgetBlocked && !steer) {
      notice(t("Лимит расходов исчерпан — подтвердите продолжение в плашке над полем ввода"), r);
      return;
    }
    // "/name rest" with a user template expands into the full task text.
    const m = /^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/.exec(raw.trim());
    const tpl = m ? templates.find((x) => x.name === m[1]) : undefined;
    let text = tpl ? expandTemplate(tpl, (m?.[2] ?? "").trim()) : raw;
    if (planMode && !steer) {
      text = planPrompt(text);
      r.setPlan("planning");
      setPlanMode(false);
    }
    const payload: Record<string, unknown> = { message: text };
    if (images.length) payload.images = images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType }));
    const command = steer ? { type: "steer", ...payload } : { type: "prompt", ...payload };
    // First task of an empty session in "copy" mode: make a worktree, restart the
    // agent there and send the task once it is ready.
    if (isolated && !steer && !r.worktree && r.state.items.length === 0 && project && changes?.isRepo) {
      setIsolated(false);
      try {
        const wt = await createWorktree(project, raw.slice(0, 40));
        r.worktree = { path: wt.path, root: wt.root, branch: wt.branch };
        r.pendingPrompt = command;
        await startRuntime(r, wt.path);
        refreshSessions();
      } catch (e) {
        notice(t("Не удалось создать копию проекта: {error}", { error: tErr(e) }), r);
      }
      return;
    }
    // Snapshot the files first, so this task's changes can be rolled back.
    const sid = r.state.sessionId;
    if (!steer && sid && r.cwd) {
      const userIndex = r.state.items.filter((it) => it.kind === "user").length;
      try {
        const id = await createCheckpoint(r.cwd);
        if (id) {
          rememberCheckpoint(sid, userIndex, id);
          bumpCheckpoints();
        }
      } catch {
        /* no snapshot: the task still runs */
      }
    }
    r.dispatch({ type: "log", line: { dir: "out", text: JSON.stringify({ ...command, images: images.length || undefined }) } });
    r.client.request(command)
      .then(() => steer && refresh(r))
      .catch((e) => notice(t("Не отправлено: {error}", { error: tErr(e) }), r));
  };

  /** Put the project files back to how they were before the user message #userIndex. */
  const restoreFiles = async (userIndex: number) => {
    const r = rtRef.current;
    const id = checkpoints[userIndex];
    if (!r?.cwd || !id || r.busy) return;
    try {
      const list = await checkpointChanges(r.cwd, id);
      if (list.length === 0) {
        notice(t("Файлы уже в этом состоянии"), r);
        return;
      }
      const shown = list.slice(0, 12).map((c: CheckpointChange) => `• ${c.path}`).join("\n") + (list.length > 12 ? `\n${t("и ещё {count}", { count: list.length - 12 })}` : "");
      const message = `${t("Вернуть файлы к состоянию до этого сообщения? Изменения после него пропадут:")}\n\n${shown}`;
      const ok = DEMO
        ? window.confirm(message)
        : await ask(message, { title: t("Вернуть файлы"), kind: "warning", okLabel: t("Вернуть"), cancelLabel: t("Отмена") });
      if (!ok) return;
      const n = await restoreCheckpoint(r.cwd, id);
      notice(t("Файлы возвращены: {count}", { count: n }), r);
      refreshChanges();
    } catch (e) {
      notice(t("Не удалось вернуть файлы: {error}", { error: tErr(e) }), r);
    }
  };

  /**
   * Edit the n-th user message: branch the session just before it (the agent
   * forks a new session with the earlier history), then put the text back
   * into the composer.
   */
  const editMessage = async (userIndex: number, text: string) => {
    const r = rtRef.current;
    if (!r || r.busy) return;
    const c = r.client;
    try {
      const list = await c.request<{ messages: { entryId: string; text: string }[] }>({ type: "get_branch_messages" });
      const entries = list?.messages ?? [];
      const entry = entries[userIndex]?.text === text ? entries[userIndex] : [...entries].reverse().find((e) => e.text === text) ?? entries[userIndex];
      if (!entry) throw new Error(t("сообщение не найдено"));
      const res = await c.request<{ text: string; cancelled?: boolean }>({ type: "branch", entryId: entry.entryId });
      if (res?.cancelled) return;
      r.dispatch({ type: "reset" });
      r.dispatch({ type: "status", status: "idle" });
      const data = await c.request<{ messages: any[] }>({ type: "get_messages" });
      r.dispatch({ type: "load", messages: data?.messages ?? [] });
      setDraft(res?.text ?? text);
      refresh(r);
      refreshSessions();
    } catch (e) {
      notice(t("Не удалось изменить сообщение: {error}", { error: tErr(e) }), r);
    }
  };

  const exportSession = async (format: "md" | "html") => {
    const r = rtRef.current;
    if (!r || !s.items.length) return;
    const name = fileStem(title);
    try {
      if (DEMO) {
        notice(t("Экспорт работает в приложении"), r);
        return;
      }
      const path = await save({
        title: t("Экспорт сессии"),
        defaultPath: `${name}.${format}`,
        filters: [format === "md" ? { name: "Markdown", extensions: ["md"] } : { name: "HTML", extensions: ["html"] }],
      });
      if (!path) return;
      if (format === "md") {
        await invoke("save_text_file", { path, content: sessionToMarkdown(title, s.items, { project, model: s.model }) });
      } else {
        await r.client.request({ type: "export_html", outputPath: path });
      }
      notice(t("Сессия сохранена: {path}", { path }), r);
    } catch (e) {
      notice(t("Экспорт не удался: {error}", { error: errText(e) }), r);
    }
  };

  const runShell = (command: string) => {
    const r = rtRef.current;
    if (!r || !command) return;
    const key = `sh${Date.now()}`;
    r.dispatch({ type: "shell_start", key, command });
    r.client.request<{ output?: string; exitCode?: number }>({ type: "bash", command })
      .then((res) => r.dispatch({ type: "shell_end", key, output: res?.output, exitCode: res?.exitCode }))
      .catch((e) => r.dispatch({ type: "shell_end", key, output: String(e.message ?? e), exitCode: -1 }))
      .finally(refreshChanges);
  };

  const answer = (q: Ask, reply: { confirmed?: boolean; value?: string; cancelled?: boolean }, label: string) => {
    const r = rtRef.current;
    if (!r) return;
    const frame = { type: "extension_ui_response", id: q.id, ...reply };
    r.dispatch({ type: "log", line: { dir: "out", text: JSON.stringify(frame) } });
    r.client.send(frame);
    r.dispatch({ type: "answer", id: q.id, answer: label });
  };

  const newSession = () => {
    const r = rtRef.current;
    if (!r) return;
    // While this agent works, the new session gets an agent of its own.
    if (r.busy) {
      spawn();
      return;
    }
    return r.client.request({ type: "new_session" }).then(() => {
      r.dispatch({ type: "reset" });
      r.swarmDispatch({ type: "reset" });
      r.dispatch({ type: "status", status: "idle" });
      setView("session");
      refresh(r);
      refreshSessions();
      return r;
    }).catch(() => undefined);
  };

  // «Составить автоматически»: a fresh session where the agent writes the project's instructions.
  const generateInstructions = (rel: string) => {
    const r = rtRef.current;
    if (!r || !project) return;
    // The engine's own file is named only by role, never by path.
    const file = displayPath(rel, {}) === rel ? rel : t("файл инструкций проекта, который ты уже читаешь");
    const text = t(
      "Изучи этот проект и напиши инструкции для агента в {file}: как устроен проект, как его запускать и проверять, соглашения по коду. Пиши кратко и только то, что не видно из кода сразу. Если в файле уже есть правила, сохрани их и дополни.",
      { file },
    );
    setView("session");
    if (r.busy) {
      const rt = spawn();
      if (rt) rt.pendingPrompt = { type: "prompt", message: text };
      setIsolated(false);
      return;
    }
    newSession()?.then((fresh) => fresh && send(text));
  };

  const openSession = async (meta: SessionMeta) => {
    setView("session");
    // Already open in some agent (maybe running in the background): just show it.
    const owner = [...runtimes.current.values()].find((x) => x.state.sessionId === meta.id && !x.disposed);
    if (owner) {
      if (owner !== rtRef.current) activate(owner);
      return;
    }
    const r = rtRef.current;
    if (!r) return;
    if (worktreeOf.has(meta.id)) {
      const branch = worktreeOf.get(meta.id)!;
      return spawn(meta.path, { path: meta.cwd, root: meta.cwd, branch });
    }
    if (r.busy || r.cwd !== project) return spawn(meta.path);
    try {
      const res = await r.client.request<{ cancelled?: boolean }>({ type: "switch_session", sessionPath: meta.path });
      if (res?.cancelled) return;
      r.dispatch({ type: "reset" });
      r.swarmDispatch({ type: "reset" });
      r.dispatch({ type: "status", status: "idle" });
      const data = await r.client.request<{ messages: any[] }>({ type: "get_messages" });
      r.dispatch({ type: "load", messages: data?.messages ?? [], title: meta.title });
      refresh(r);
    } catch (e) {
      notice(t("Не удалось открыть сессию: {error}", { error: errText(e) }), r);
    }
  };

  const deleteSession = async (meta: SessionMeta) => {
    try {
      if (!DEMO) await invoke("session_delete", { path: meta.path });
      setSessions((list) => list.filter((m) => m.path !== meta.path));
    } catch (e) {
      notice(t("Не удалось удалить сессию: {error}", { error: errText(e) }));
    }
  };

  const renameSession = (name: string) => {
    const r = rtRef.current;
    const value = name.trim();
    if (!r || !value) return;
    r.client.request({ type: "set_session_name", name: value })
      .then(() => {
        r.dispatch({ type: "frame", frame: { type: "session_info_update", title: value } });
        refreshSessions();
      })
      .catch(() => {});
  };

  const changeApproval = (mode: ApprovalMode) => {
    if (mode === approval) return;
    setApproval(mode);
    approvalRef.current = mode;
    try {
      localStorage.setItem(APPROVAL_KEY, mode);
    } catch {
      /* this run only */
    }
    // The mode is a launch flag: restart the shown agent and reopen its session.
    const r = rtRef.current;
    if (!project || !r || r.busy) return;
    const current = sessions.find((m) => m.id === s.sessionId);
    if (current && s.items.length) r.pendingSession = current.path;
    startRuntime(r, project);
  };

  /** Commit message from the agent, asked on the side so the session history stays clean. */
  const generateCommitMessage = async (): Promise<string> => {
    const r = rtRef.current;
    if (!r || !project || !changes) return "";
    if (DEMO) return "Add pricing page with Stripe checkout\n\n- Pricing page with monthly/yearly plans\n- Stripe checkout session and webhook";
    let diff = "";
    for (const f of changes.files) {
      if (diff.length > 14_000) break;
      const d = await gitDiff(workCwd ?? project, f.path).catch(() => "");
      diff += `\n### ${f.status} ${f.path}\n${d.slice(0, 6_000)}`;
    }
    const question = t("Напиши сообщение git-коммита для этих изменений: первая строка до 72 символов в повелительном наклонении, затем пустая строка и короткий список главного. Ответь только текстом сообщения, без кавычек и пояснений.") + "\n" + diff.slice(0, 16_000);
    const answer = await r.askSide(question);
    return answer.replace(/^```[a-z]*\n?|```$/g, "").trim();
  };

  /** Full-text search through this project's conversations (⌘K). */
  const searchText = async (query: string): Promise<TextHitItem[]> => {
    if (!project) return [];
    const hits = await searchSessions(project, query);
    return hits.map((h) => ({
      id: `${h.path}#${h.at}`,
      title: h.title,
      snippet: h.snippet,
      matchStart: h.matchStart,
      matchLen: h.matchLen,
      run: () => {
        const meta = sessions.find((m) => m.path === h.path) ?? { path: h.path, id: h.sessionId, title: h.title, cwd: project, updatedAt: h.at };
        openSession(meta);
      },
    }));
  };

  /** What each session's agent is doing, for the sidebar. */
  const sessionActivity = useMemo(() => {
    const map = new Map<string, "running" | "waiting" | "unread">();
    for (const r of runtimes.current.values()) {
      const id = r.state.sessionId;
      if (!id || r.disposed) continue;
      if (r.state.status === "waiting") map.set(id, "waiting");
      else if (r.busy) map.set(id, "running");
      else if (r.snap.unread) map.set(id, "unread");
    }
    return map;
  }, [runtimesVersion, s.status, s.sessionId]);

  // ⌘N — new session; ⌥⌘J — engine protocol log (dev builds only).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (import.meta.env.DEV && e.metaKey && e.altKey && e.code === "KeyJ") {
        e.preventDefault();
        setDebugOpen((v) => !v);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.code === "KeyJ") {
        e.preventDefault();
        setTermOpen((v) => !v);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.code === "KeyK") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n" && ready) {
        e.preventDefault();
        newSession();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const counts = swarmCounts(swarm);
  // Show the changes card only after the agent touched files in this session.
  const touched = s.items.some((it) => it.kind === "steps" && it.steps.some((st) => /write|edit|patch|bash|shell|apply/i.test(st.name)));
  const needKeys = failure?.text.includes("No models available");
  const lastReply = [...s.items].reverse().find((it) => it.kind === "assistant" && it.text.trim()) as { text: string } | undefined;
  const projectName = project?.split("/").filter(Boolean).pop();
  const activeMeta = sessions.find((m) => m.id === s.sessionId);
  const title = view === "settings" ? t("Настройки") : view === "swarm" ? t("Рой агентов") : s.title ?? activeMeta?.title ?? (s.items.length ? t("Сессия") : t("Новая сессия"));

  const composer = (
    <Composer
      disabled={!ready}
      busy={busy}
      planMode={planMode}
      onTogglePlan={() => setPlanMode((v) => !v)}
      projectDir={workCwd ?? project}
      sessionKey={s.sessionId}
      isolated={isolated}
      onToggleIsolated={changes?.isRepo && !active?.worktree && s.items.length === 0 ? () => setIsolated((v) => !v) : undefined}
      isolatedHint={isolated && othersBusy ? "Другой агент сейчас работает в этом проекте — задача пойдёт в отдельную копию" : undefined}
      model={s.model}
      modelSlot={
        <ModelPicker
          models={models}
          current={s.modelRef}
          disabled={!ready || busy}
          onSelect={(provider, id) => {
            rtRef.current?.client.request({ type: "set_model", provider, modelId: id }).then(() => refresh())
              .catch((e: unknown) => notice(t("Модель не выбрана: {error}", { error: tErr(e) })));
          }}
          onAddProvider={() => setProvidersOpen(true)}
        />
      }
      controlsSlot={
        <>
          <AutonomyPicker value={approval} disabled={!ready || busy} onChange={changeApproval} />
          <ThinkingPicker
            value={s.thinkingLevel}
            levels={s.thinkingLevels}
            disabled={!ready || busy}
            onChange={(level) => rtRef.current?.client.request({ type: "set_thinking_level", level }).then(() => refresh()).catch(() => {})}
          />
        </>
      }
      commands={[
        ...templates.map((tpl) => ({ name: tpl.name, description: `${t("Моя команда")} · ${tpl.title}` })),
        ...commands.filter((c) => !templates.some((t) => t.name === c.name)),
      ]}
      searchFiles={project ? (q) => projectFiles(project, q, 30) : undefined}
      draft={draft}
      setDraft={setDraft}
      onSend={send}
      onShell={runShell}
      onAbort={() => rtRef.current?.client.request({ type: "abort" }).catch(() => {})}
    />
  );

  const paletteItems: PaletteItem[] = [
    { id: "new", group: t("Действия"), title: t("Новая сессия"), shortcut: "⌘N", run: newSession },
    { id: "swarm", group: t("Действия"), title: t("Рой агентов"), keywords: t("агенты параллельно"), run: () => setView("swarm") },
    { id: "changes", group: t("Действия"), title: t("Изменения в проекте"), keywords: t("git дифф diff откат"), run: () => setChangesOpen(true) },
    { id: "compact", group: t("Действия"), title: t("Сжать контекст"), keywords: t("память токены"), run: () => rtRef.current?.client.request({ type: "compact" }).then(() => refresh()).catch(() => {}) },
    { id: "providers", group: t("Действия"), title: t("Провайдеры моделей"), keywords: t("ключ api модель"), run: () => setProvidersOpen(true) },
    { id: "settings", group: t("Действия"), title: t("Настройки"), run: () => openSettings() },
    { id: "stats", group: t("Действия"), title: t("Статистика"), keywords: t("токены стоимость расход"), run: () => openSettings("usage") },
    { id: "connections", group: t("Действия"), title: t("Подключения"), keywords: t("mcp навыки серверы инструменты"), run: () => openSettings("connections") },
    { id: "browse", group: t("Действия"), title: t("Открыть папку проекта…"), run: pickProject },
    { id: "restart", group: t("Действия"), title: t("Перезапустить агента"), run: () => project && start(project) },
    { id: "terminal", group: t("Действия"), title: t("Терминал"), shortcut: "⌘J", keywords: t("консоль shell командная строка"), run: () => setTermOpen((v) => !v) },
    ...(s.items.length
      ? [
          { id: "export-md", group: t("Действия"), title: t("Экспорт сессии в Markdown"), keywords: t("сохранить файл md"), run: () => exportSession("md") },
          { id: "export-html", group: t("Действия"), title: t("Экспорт сессии в HTML"), keywords: t("сохранить файл html"), run: () => exportSession("html") },
        ]
      : []),
    ...sessions.map((m): PaletteItem => ({
      id: `s:${m.path}`, group: t("Сессии"), title: m.title, subtitle: m.preview !== m.title ? m.preview : undefined,
      run: () => openSession(m),
    })),
    ...models.map((m): PaletteItem => ({
      id: `m:${m.provider}/${m.id}`, group: t("Модели"), title: m.name ?? m.id, subtitle: m.provider,
      keywords: m.id,
      run: () => rtRef.current?.client.request({ type: "set_model", provider: m.provider, modelId: m.id }).then(() => refresh()).catch(() => {}),
    })),
    ...recentProjects.filter((r) => r.path !== project).map((r): PaletteItem => ({
      id: `p:${r.path}`, group: t("Проекты"), title: r.name, subtitle: r.path, run: () => switchProject(r.path),
    })),
    ...templates.map((tpl): PaletteItem => ({
      id: `t:${tpl.id}`, group: t("Мои команды"), title: `/${tpl.name}`, subtitle: tpl.title, keywords: tpl.body.slice(0, 80),
      run: () => { setView("session"); setDraft(`/${tpl.name} `); },
    })),
    ...commands.map((c): PaletteItem => ({
      id: `c:${c.name}`, group: t("Команды агента"), title: `/${c.name}`, subtitle: c.description,
      run: () => { setView("session"); setDraft(`/${c.name} `); },
    })),
  ];

  const budgetBar = budget.level !== "ok" && (budget.level === "warn" || budgetBlocked) && (
    <BudgetBanner
      state={budget}
      onContinue={() => {
        if (budget.scope === "session" && s.sessionId) allowOverSession(s.sessionId);
        else allowOverToday();
        bumpBudget();
      }}
      onOpenSettings={() => openSettings("models")}
    />
  );

  let center: React.ReactNode;
  if (onboarding && view === "session") {
    center = (
      <Onboarding
        engine={ompPath === undefined ? "checking" : ompPath === null ? "missing" : "found"}
        models={models.length}
        modelsLoading={!!ompPath && models.length === 0 && s.status !== "idle" && s.status !== "offline"}
        project={project}
        onPickProject={pickProject}
        onOpenProviders={() => setProvidersOpen(true)}
        onRetryEngine={() => {
          setOmpPath(undefined);
          invoke<string | null>("omp_locate").then(setOmpPath);
        }}
        onFinish={(task) => {
          markOnboarded();
          setOnboarding(false);
          if (task) setDraft(task);
        }}
      />
    );
  } else if (ompPath === null) {
    center = (
      <Setup title={t("Не найден движок агента")} text={t("Octopus не нашёл движок, на котором работает агент. Установите его и перезапустите приложение.")} />
    );
  } else if (!project) {
    center = (
      <Setup title={t("Выберите папку проекта")} text={t("Агент будет читать и менять файлы только в этой папке.")}>
        <button className="btn primary" onClick={pickProject} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Icon name="folder" size={14} /> {t("Выбрать папку")}
        </button>
      </Setup>
    );
  } else if (failure && s.status === "offline") {
    center = (
      <Setup
        title={needKeys ? t("Нужна модель") : t("Агент остановился")}
        text={needKeys ? t("Нет ни одной доступной модели. Подключите провайдера или добавьте ключ API.") : t("Код выхода: {code}", { code: failure.code ?? "—" })}
      >
        {!needKeys && failure.text && <pre className="ask-msg" style={{ maxWidth: 560, textAlign: "left" }}>{failure.text}</pre>}
        <div style={{ display: "flex", gap: 8 }}>
          {needKeys && <button className="btn primary" onClick={() => setProvidersOpen(true)}>{t("Подключить провайдера")}</button>}
          <button className="btn" onClick={() => start(project)}>{t("Запустить снова")}</button>
        </div>
      </Setup>
    );
  } else if (view === "settings" || view === "stats" || view === "connections") {
    center = (
      <SettingsScreen
        tab={settingsTab}
        onTabChange={setSettingsTab}
        models={models}
        onRestartAgent={() => {
          const r = rtRef.current;
          if (!project || !r) return;
          const current = sessions.find((m) => m.id === s.sessionId);
          if (current && s.items.length && !r.busy) r.pendingSession = current.path;
          start(project);
        }}
        onBack={() => setView("session")}
        project={workCwd}
        home={home}
        contextFiles={s.contextFiles}
        agentRunning={s.status !== "offline"}
        onNewSession={() => newSession()}
        onGenerateInstructions={generateInstructions}
        onOpenProviders={() => setProvidersOpen(true)}
        engineInfo={{ model: s.model, project, status: s.status === "idle" ? t("агент готов") : s.status === "offline" ? t("агент не запущен") : t("агент работает") }}
        renderUsage={() => (
          <StatsScreen
            embedded
            project={project}
            onBack={() => setView("session")}
            onOpenSession={(path) => {
              const meta = sessions.find((m) => m.path === path);
              if (meta) openSession(meta);
              else setView("session");
            }}
          />
        )}
        renderConnections={() => (
          <ConnectionsScreen
            embedded
            project={project}
            skills={commands.filter((c) => c.name.startsWith("skill:")).map((c) => ({ name: c.name, description: c.description }))}
            onBack={() => setView("session")}
            onRestartAgent={() => {
              const r = rtRef.current;
              if (!project || !r) return;
              const current = sessions.find((m) => m.id === s.sessionId);
              if (current && s.items.length && !r.busy) r.pendingSession = current.path;
              start(project);
            }}
          />
        )}
      />
    );
  } else if (view === "swarm") {
    center = (
      <>
      {s.status === "waiting" && (
        <button className="strip-swarm" onClick={() => setView("session")}>
          <span className="dot on pulse" /> {t("Агент ждёт вашего ответа — открыть чат")}
          <Icon name="chevron-right" size={12} />
        </button>
      )}
      <Swarm
        swarm={swarm}
        goal={s.goal}
        busy={busy}
        onBack={() => setView("session")}
        onAbort={() => rtRef.current?.client.request({ type: "abort" }).catch(() => {})}
        onOpenAgent={setTranscriptOf}
      />
      </>
    );
  } else if (s.items.length === 0) {
    center = (
      <Home
        projectName={projectName}
        approval={approval}
        sessions={sessions}
        activeSubagents={counts.running}
        composer={<>{budgetBar}{composer}</>}
        onOpenSession={openSession}
        onSuggest={setDraft}
        onOpenSwarm={() => setView("swarm")}
      />
    );
  } else {
    center = (
      <>
        <Thread items={s.items} status={s.status} onAnswer={answer} onSuggest={setDraft} onRetry={(t) => send(t)} onEdit={editMessage} onOpenFile={(path) => setViewFile({ path })} busy={busy} restorable={restorable} onRestore={restoreFiles} />
        {!busy && snap.plan === "ready" && (
          <PlanCard
            phases={s.plan ?? []}
            summary={lastReply?.text}
            busy={busy}
            onApprove={() => {
              rtRef.current?.setPlan(undefined);
              send(approvePrompt());
            }}
            onRevise={(feedback) => {
              rtRef.current?.setPlan("planning");
              send(revisePrompt(feedback));
            }}
            onDismiss={() => rtRef.current?.setPlan(undefined)}
          />
        )}
        {!busy && snap.plan !== "ready" && touched && changes && changes.files.length > 0 && (
          <div className="changes-dock"><ChangesCard status={changes} onOpen={() => setChangesOpen(true)} onOpenFile={(path) => setViewFile({ path })} onCommit={() => setCommitOpen(true)} /></div>
        )}
        {s.queued.length > 0 && (
          <div className="queue-strip" aria-live="polite">
            <span className="label">{t("В очереди")}</span>
            {s.queued.slice(0, 3).map((q, i) => (
              <span key={i} className="queue-item" title={q}>{q}</span>
            ))}
            {s.queued.length > 3 && <span className="queue-more">+{s.queued.length - 3}</span>}
          </div>
        )}
        {counts.running > 0 && (
          <button className="strip-swarm" onClick={() => setView("swarm")}>
            <span className="dot on pulse" /> {t("Рой: работают агенты — {running} из {total}", { running: counts.running, total: counts.total })}
            <Icon name="chevron-right" size={12} />
          </button>
        )}
        {budgetBar}
        {active?.worktree && project && (
          <WorktreeBar
            branch={active.worktree.branch}
            changedFiles={changes?.files.length}
            busy={busy}
            onApply={async () => {
              const res = await applyWorktree(project, active.worktree!.path);
              refreshChanges();
              return res;
            }}
            onRemove={async () => {
              const r = active;
              await removeWorktree(project, r.worktree!.path, true);
              r.worktree = undefined;
              await startRuntime(r, project);
              refreshSessions();
            }}
            onOpenChanges={() => {
              setChangesFor(project);
              setChangesOpen(true);
            }}
          />
        )}
        {composer}
      </>
    );
  }

  return (
    <div className="app">
      <Sidebar
        project={project}
        status={s.status}
        activity={sessionActivity}
        worktreeOf={worktreeOf}
        onRenameActive={renameSession}
        view={view}
        sessions={sessions}
        activeSessionId={s.sessionId}
        swarmActive={counts.running}
        swarmTotal={counts.total}
        onNewSession={newSession}
        onOpenSession={openSession}
        onDeleteSession={deleteSession}
        onOpenSwarm={() => setView("swarm")}
        onPickProject={pickProject}
        recentProjects={recentProjects}
        onSwitchProject={switchProject}
        onForgetProject={(p) => setRecentProjects(forgetProject(p))}
        onOpenSettings={() => openSettings()}
        onRestart={() => project && start(project)}
      />

      <main className="main">
        <header className="main-head drag" data-tauri-drag-region>
          {view !== "settings" && view !== "stats" && view !== "connections" && (
            <EditableTitle title={title} editable={view === "session" && s.items.length > 0 && ready} onRename={renameSession} />
          )}
          {projectName && <span className="chip">{projectName}</span>}
          <span style={{ flex: 1 }} />
          {project && (
            <button className={`chip changes-chip ${termOpen ? "active" : ""}`} onClick={() => setTermOpen((v) => !v)} title={t("Терминал (⌘J)")}>
              {t("Терминал")}
            </button>
          )}
          {changes?.isRepo && (
            <button className={`chip changes-chip ${changesOpen ? "active" : ""}`} onClick={() => setChangesOpen(!changesOpen)} title={t("Изменения в рабочей папке")}>
              {changes.branch ?? "git"} · {changes.files.length > 0 ? <><span style={{ color: "var(--accent)" }}>+{changes.additions}</span> −{changes.deletions}</> : t("без изменений")}
            </button>
          )}
        </header>
        <ErrorBoundary key={view} inline onReset={() => setView("session")}>{center}</ErrorBoundary>
        {project && (
          <TerminalPanel
            cwd={workCwd ?? project}
            open={termOpen}
            onClose={() => setTermOpen(false)}
            onSendToAgent={ready ? (text) => send(text) : undefined}
            height={termHeight}
            onHeightChange={(h) => {
              setTermHeight(h);
              try {
                localStorage.setItem("octopus.terminalHeight", String(h));
              } catch {
                /* this run only */
              }
            }}
          />
        )}
      </main>

      {view === "session" && settings.showTiles && !onboarding && (
        <Tiles s={s} onCompact={() => rtRef.current?.client.request({ type: "compact" }).then(() => refresh()).catch(() => {})} />
      )}

      {providersOpen && (
        <ProviderModal
          onClose={() => setProvidersOpen(false)}
          onSaved={({ id, firstModel }) => {
            setProvidersOpen(false);
            // omp reads models.yml only at startup: restart it, then pick the new model.
            if (firstModel && rtRef.current) rtRef.current.pendingModel = { provider: id, id: firstModel };
            if (project && !busy) start(project);
          }}
        />
      )}
      {changesOpen && project && (
        <ChangesPanel cwd={changesFor ?? workCwd ?? project} onClose={() => { setChangesOpen(false); setChangesFor(undefined); }} onChanged={refreshChanges} onOpenFile={(path) => setViewFile({ path })} onComment={ready ? (text) => send(text) : undefined} onCommit={() => { setChangesOpen(false); setCommitOpen(true); }} />
      )}
      {commitOpen && project && changes && (
        <CommitModal
          cwd={workCwd ?? project}
          files={changes.files}
          generateMessage={ready ? generateCommitMessage : undefined}
          onClose={() => setCommitOpen(false)}
          onDone={refreshChanges}
        />
      )}
      {transcriptOf && (
        <SwarmTranscript
          title={`${String(transcriptOf.index + 1).padStart(2, "0")} · ${transcriptOf.agent}`}
          load={() =>
            rtRef.current
              ? rtRef.current.client.request<{ messages: any[] }>({ type: "get_subagent_messages", subagentId: transcriptOf.id })
              : Promise.resolve({ messages: [] })
          }
          onClose={() => setTranscriptOf(null)}
        />
      )}
      {viewFile && project && <FileViewer cwd={workCwd ?? project} path={viewFile.path} line={viewFile.line} onClose={() => setViewFile(null)} />}
      <CommandPalette open={paletteOpen} items={paletteItems} onClose={() => setPaletteOpen(false)} searchText={searchText} />
      {debugOpen && <DebugDrawer log={s.log} stderr={rtRef.current?.stderr ?? []} onClose={() => setDebugOpen(false)} />}
    </div>
  );
}

function toCommands(list: any[]): SlashCommand[] {
  return list
    .filter((c) => typeof c?.name === "string")
    .map((c) => ({ name: c.name, description: c.description, hint: c.input?.hint }));
}

function EditableTitle({ title, editable, onRename }: { title: string; editable: boolean; onRename: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  if (!editing) {
    return editable ? (
      <button className="main-title title-btn" onClick={() => { setValue(title); setEditing(true); }} title={t("Переименовать сессию")}>
        {title}
      </button>
    ) : (
      <span className="main-title">{title}</span>
    );
  }
  const done = (save: boolean) => {
    setEditing(false);
    if (save && value.trim() && value.trim() !== title) onRename(value);
  };
  return (
    <input
      className="title-input"
      autoFocus
      value={value}
      aria-label={t("Название сессии")}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => done(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter") done(true);
        if (e.key === "Escape") done(false);
      }}
    />
  );
}

function Setup({ title, text, children }: { title: string; text: string; children?: React.ReactNode }) {
  return (
    <div className="scroll">
      <div className="empty">
        <Emblem size={180} />
        <h1>{title}</h1>
        <p>{text}</p>
        {children}
      </div>
    </div>
  );
}

/** Error text for notices; backend messages are translated by their Russian text. */
function errText(e: unknown): string {
  return tErr(e);
}
