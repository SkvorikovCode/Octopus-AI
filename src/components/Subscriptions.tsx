// "Subscriptions" tab of the provider modal: sign in to Claude Pro/Max, ChatGPT
// Plus/Pro and other plans instead of pasting an API key. The sign-in itself
// runs in a helper agent process (src/lib/subscriptions.ts); providers that
// only sign in from a terminal get a small terminal right in the row.

import { useEffect, useRef, useState, type ReactElement } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  createLoginAgent,
  type Account,
  type LoginAgent,
  type LoginEvent,
  type Subscription,
} from "../lib/subscriptions";
import { openLoginPty } from "../lib/pty";
import { t, tErr } from "../lib/i18n";
import { DotSpinner } from "./Glyphs";
import { TerminalTab } from "./TerminalPanel";
import "./subscriptions.css";

type Props = {
  /** A sign-in or sign-out changed which models the agent can use. */
  onChanged: () => void;
};

type Flow = {
  /** Row the flow belongs to. */
  id: string;
  /** Provider id the sign-in runs for (the device-code variant may differ from the row). */
  loginId: string;
  method: Subscription["method"];
  url?: string;
  code?: string;
  input?: { requestId: string; placeholder?: string };
  /** The paste field is shown (always for providers that can't return the code). */
  pasteOpen: boolean;
  sending?: boolean;
  /** Terminal sign-in ended with an error: keep the terminal for reading. */
  failed?: boolean;
};

const open = (url: string) => {
  if (isTauri()) openUrl(url).catch(() => window.open(url, "_blank", "noopener,noreferrer"));
  else window.open(url, "_blank", "noopener,noreferrer");
};

const copy = (text: string) => navigator.clipboard?.writeText(text).catch(() => {});

export function Subscriptions({ onChanged }: Props): ReactElement {
  const agentRef = useRef<LoginAgent | null>(null);
  const [starting, setStarting] = useState(true);
  const [list, setList] = useState<Subscription[]>();
  const [accounts, setAccounts] = useState<Record<string, Account[]>>({});
  const [flow, setFlow] = useState<Flow | null>(null);
  const [paste, setPaste] = useState("");
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();
  const [leaving, setLeaving] = useState<string | null>(null);
  const [termSeq, setTermSeq] = useState(0);
  const flowRef = useRef<Flow | null>(null);
  flowRef.current = flow;

  const loadAccounts = async (agent: LoginAgent, subs: Subscription[]) => {
    const pairs = await Promise.all(
      subs
        .filter((s) => s.authenticated)
        .map(async (s) => [s.id, await agent.accounts(s.id).catch(() => [])] as const),
    );
    setAccounts(Object.fromEntries(pairs));
  };

  const refresh = async (agent: LoginAgent) => {
    const subs = await agent.subscriptions();
    if (agentRef.current !== agent) return;
    setList(subs);
    await loadAccounts(agent, subs);
  };

  /** (Re)starts the helper process: on open, after a cancelled sign-in, after a terminal sign-in. */
  const restart = async () => {
    agentRef.current?.dispose();
    agentRef.current = null;
    setStarting(true);
    try {
      const agent = createLoginAgent(isTauri() ? await homeDir() : "");
      agentRef.current = agent;
      await agent.start();
      if (agentRef.current !== agent) return;
      await refresh(agent);
    } catch (e) {
      setError(tErr(e));
    } finally {
      setStarting(false);
    }
  };

  useEffect(() => {
    restart();
    return () => {
      agentRef.current?.dispose();
      agentRef.current = null;
    };
  }, []);

  const finish = async (name: string) => {
    setFlow(null);
    setPaste("");
    setDone(t("Вход в {name} выполнен. Модели появятся в выборе модели.", { name }));
    onChanged();
  };

  const onEvent = (e: LoginEvent) => {
    if (e.kind === "url") open(e.url);
    setFlow((f) => {
      if (!f) return f;
      switch (e.kind) {
        case "url":
          return { ...f, url: e.url, code: e.code };
        case "input":
          return { ...f, input: { requestId: e.requestId, placeholder: e.placeholder } };
        case "cancel-input":
          return f.input?.requestId === e.requestId ? { ...f, input: undefined } : f;
      }
    });
  };

  const signIn = async (sub: Subscription, loginId = sub.id) => {
    const agent = agentRef.current;
    if (!agent || flowRef.current) return;
    setError(undefined);
    setDone(undefined);
    setPaste("");
    const method = loginId === sub.deviceAlt ? "device" : sub.method;
    setFlow({ id: sub.id, loginId, method, pasteOpen: !!sub.pasteRequired });
    if (method === "terminal") {
      setTermSeq((n) => n + 1);
      return;
    }
    try {
      await agent.login(loginId, onEvent);
      if (agentRef.current !== agent) return;
      await refresh(agent);
      await finish(sub.name);
    } catch (e) {
      // A cancelled sign-in disposes the agent: its rejection is expected.
      if (agentRef.current !== agent) return;
      setFlow(null);
      setError(tErr(e));
    }
  };

  const cancel = () => {
    setFlow(null);
    setPaste("");
    restart();
  };

  /** Switches a running browser sign-in to the device-code variant. */
  const switchToDevice = async (sub: Subscription) => {
    if (!sub.deviceAlt) return;
    setFlow(null);
    await restart();
    signIn(sub, sub.deviceAlt);
  };

  const sendCode = async () => {
    const agent = agentRef.current;
    const f = flowRef.current;
    if (!agent || !f?.input || !paste.trim()) return;
    setFlow({ ...f, sending: true });
    try {
      await agent.answer(f.input.requestId, paste.trim());
    } catch (e) {
      setError(tErr(e));
      setFlow((cur) => (cur ? { ...cur, sending: false } : cur));
    }
  };

  const onTerminalExit = async (sub: Subscription, code: number | null) => {
    if (code === 0) {
      await restart();
      await finish(sub.name);
    } else {
      setFlow((f) => (f ? { ...f, failed: true } : f));
    }
  };

  const signOut = async (sub: Subscription, account: Account) => {
    const agent = agentRef.current;
    if (!agent) return;
    const key = `${sub.id}:${account.credentialId}`;
    setLeaving(key);
    setError(undefined);
    setDone(undefined);
    try {
      await agent.logout(sub.id, account.credentialId);
      await refresh(agent);
      onChanged();
    } catch (e) {
      setError(tErr(e));
    } finally {
      setLeaving(null);
    }
  };

  const renderFlow = (sub: Subscription, f: Flow) => {
    if (f.method === "terminal") {
      return (
        <div className="sub-flow">
          <p className="sub-flow-text">
            {f.failed
              ? t("Вход не завершён. Проверьте вывод терминала и попробуйте ещё раз.")
              : t(
                  "Этот провайдер входит через терминал. Ответьте на вопросы ниже — после входа статус обновится сам.",
                )}
          </p>
          <div className="sub-term">
            <TerminalTab
              key={termSeq}
              tabKey={termSeq}
              cwd=""
              visible
              spawn={(cols, rows) => openLoginPty(f.loginId, cols, rows)}
              onExit={(code) => onTerminalExit(sub, code)}
            />
          </div>
          <div className="sub-flow-actions">
            <button type="button" className="btn" onClick={() => setFlow(null)}>
              {f.failed ? t("Закрыть") : t("Отмена")}
            </button>
          </div>
        </div>
      );
    }

    const showPaste = f.input && (f.pasteOpen || sub.pasteRequired);
    return (
      <div className="sub-flow">
        {f.method === "device" ? (
          f.code ? (
            <>
              <p className="sub-flow-text">
                {t("Введите этот код на странице входа, она открылась в браузере:")}
              </p>
              <div className="sub-code">
                <span className="sub-code-value">{f.code}</span>
                <button type="button" className="prov-link" onClick={() => copy(f.code!)}>
                  {t("Скопировать")}
                </button>
              </div>
            </>
          ) : (
            <p className="sub-flow-text sub-wait">
              <DotSpinner /> {t("Получаем код входа…")}
            </p>
          )
        ) : (
          <p className="sub-flow-text sub-wait">
            <DotSpinner />
            {f.url
              ? sub.pasteRequired
                ? t("Войдите в браузере, затем скопируйте код и вставьте его ниже.")
                : t("Войдите в браузере — Octopus получит подтверждение сам.")
              : t("Готовим вход…")}
          </p>
        )}

        {f.url && (
          <div className="sub-flow-links">
            <button type="button" className="prov-link" onClick={() => open(f.url!)}>
              {t("Открыть страницу снова")}
            </button>
            <button type="button" className="prov-link" onClick={() => copy(f.url!)}>
              {t("Скопировать ссылку")}
            </button>
            {f.input && !showPaste && (
              <button
                type="button"
                className="prov-link"
                onClick={() => setFlow({ ...f, pasteOpen: true })}
              >
                {t("Браузер не вернул в приложение?")}
              </button>
            )}
            {sub.deviceAlt && f.loginId !== sub.deviceAlt && (
              <button type="button" className="prov-link" onClick={() => switchToDevice(sub)}>
                {t("Войти по коду")}
              </button>
            )}
          </div>
        )}

        {showPaste && (
          <div className="prov-field">
            <span className="prov-hint">
              {t("Вставьте код или адрес страницы из адресной строки браузера после входа.")}
            </span>
            <div className="prov-manual">
              <input
                className="prov-input"
                value={paste}
                placeholder={f.input?.placeholder ?? t("Код или адрес страницы")}
                autoComplete="off"
                spellCheck={false}
                aria-label={t("Код из браузера")}
                onChange={(e) => setPaste(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    sendCode();
                  }
                }}
              />
              <button
                type="button"
                className="btn"
                disabled={!paste.trim() || f.sending}
                onClick={sendCode}
              >
                {t("Отправить")}
              </button>
            </div>
          </div>
        )}

        <div className="sub-flow-actions">
          <button type="button" className="btn" onClick={cancel}>
            {t("Отмена")}
          </button>
        </div>
      </div>
    );
  };

  return (
    <section className="prov-section" aria-label={t("Подписки")}>
      <p>
        {t(
          "Войдите в свою подписку — Octopus будет работать на её моделях без API-ключа. Токены хранит агент и сам их обновляет.",
        )}
      </p>

      {error && <div className="err-card">{error}</div>}
      {done && <div className="sub-done">{done}</div>}

      {list === undefined && (
        <div className="prov-empty sub-wait">
          {starting && <DotSpinner />}{" "}
          {starting ? t("Загрузка…") : t("Список подписок недоступен.")}
        </div>
      )}

      {list && (
        <div className="prov-list">
          {list.map((sub) => {
            const f = flow?.id === sub.id ? flow : null;
            const accs = accounts[sub.id] ?? [];
            return (
              <div className={`sub-item${f ? " is-active" : ""}`} key={sub.id}>
                <div className="prov-row">
                  <span className={`sub-dot${sub.authenticated ? " on" : ""}`} aria-hidden />
                  <div className="prov-row-main">
                    <span className="prov-row-id">{sub.name}</span>
                    {sub.note && !sub.authenticated && (
                      <span className="sub-note">{t(sub.note)}</span>
                    )}
                    {sub.authenticated && accs.length === 0 && (
                      <span className="sub-note">{t("вход выполнен")}</span>
                    )}
                  </div>
                  <div className="prov-row-meta">
                    {sub.method === "terminal" && !sub.authenticated && (
                      <span className="prov-badge">{t("через терминал")}</span>
                    )}
                    {!sub.authenticated && (
                      <button
                        type="button"
                        className="prov-del"
                        disabled={starting || flow !== null}
                        onClick={() => signIn(sub)}
                      >
                        {t("Войти")}
                      </button>
                    )}
                  </div>
                </div>

                {accs.map((a) => (
                  <div className="sub-account" key={a.credentialId}>
                    <span className="sub-account-name" title={a.detail ?? a.label}>
                      {a.label}
                      {a.detail && a.detail !== a.label && (
                        <span className="sub-note"> · {a.detail}</span>
                      )}
                    </span>
                    <button
                      type="button"
                      className="prov-del"
                      disabled={starting || flow !== null || leaving !== null}
                      onClick={() => signOut(sub, a)}
                    >
                      {leaving === `${sub.id}:${a.credentialId}` ? t("Выходим…") : t("Выйти")}
                    </button>
                  </div>
                ))}

                {f && renderFlow(sub, f)}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
