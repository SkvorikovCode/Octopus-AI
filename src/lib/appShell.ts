// Native app shell (macOS): the menu bar, quitting while agents work, and updates.
// Everything here is a no-op outside Tauri (the browser demo).

import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { t } from "./i18n";

export type MenuActions = {
  newSession: () => void;
  openSettings: () => void;
  checkUpdates: () => void;
};

/** Builds the menu bar in the current interface language. Call again when the language changes. */
export async function setAppMenu(actions: MenuActions) {
  if (!isTauri()) return;
  const version = await getVersion();
  const sep = () => PredefinedMenuItem.new({ item: "Separator" });
  const app = await Submenu.new({
    text: "Octopus",
    items: [
      await PredefinedMenuItem.new({
        item: { About: { name: "Octopus", version, copyright: "Apache-2.0 · Octopus AI contributors", website: "https://github.com/SkvorikovCode/Octopus-AI" } },
        text: t("О программе Octopus"),
      }),
      await MenuItem.new({ id: "updates", text: t("Проверить обновления…"), action: actions.checkUpdates }),
      await sep(),
      await MenuItem.new({ id: "settings", text: t("Настройки…"), accelerator: "CmdOrCtrl+,", action: actions.openSettings }),
      await sep(),
      await PredefinedMenuItem.new({ item: "Hide", text: t("Скрыть Octopus") }),
      await PredefinedMenuItem.new({ item: "HideOthers", text: t("Скрыть остальные") }),
      await PredefinedMenuItem.new({ item: "ShowAll", text: t("Показать все") }),
      await sep(),
      // Not the predefined Quit: an agent at work turns quitting into a question.
      await MenuItem.new({ id: "quit", text: t("Завершить Octopus"), accelerator: "CmdOrCtrl+Q", action: () => void requestQuit() }),
    ],
  });
  const file = await Submenu.new({
    text: t("Файл"),
    items: [
      await MenuItem.new({ id: "new-session", text: t("Новая сессия"), accelerator: "CmdOrCtrl+N", action: actions.newSession }),
      await sep(),
      await PredefinedMenuItem.new({ item: "CloseWindow", text: t("Закрыть окно") }),
    ],
  });
  // Without an Edit menu macOS drops ⌘C / ⌘V / ⌘Z in text fields.
  const edit = await Submenu.new({
    text: t("Правка"),
    items: [
      await PredefinedMenuItem.new({ item: "Undo", text: t("Отменить") }),
      await PredefinedMenuItem.new({ item: "Redo", text: t("Повторить действие") }),
      await sep(),
      await PredefinedMenuItem.new({ item: "Cut", text: t("Вырезать") }),
      await PredefinedMenuItem.new({ item: "Copy", text: t("Копировать") }),
      await PredefinedMenuItem.new({ item: "Paste", text: t("Вставить") }),
      await PredefinedMenuItem.new({ item: "SelectAll", text: t("Выбрать все") }),
    ],
  });
  const window = await Submenu.new({
    text: t("Окно"),
    items: [
      await PredefinedMenuItem.new({ item: "Minimize", text: t("Свернуть") }),
      await PredefinedMenuItem.new({ item: "Maximize", text: t("Изменить масштаб") }),
      await PredefinedMenuItem.new({ item: "Fullscreen", text: t("Во весь экран") }),
    ],
  });
  const menu = await Menu.new({ items: [app, file, edit, window] });
  await menu.setAsAppMenu();
}

/** Tells the native side whether quitting now would interrupt an agent. */
export function reportBusy(busy: boolean) {
  if (isTauri()) invoke("app_set_busy", { busy }).catch(() => {});
}

async function requestQuit() {
  await invoke("app_quit", { force: false });
}

/** Asks before quitting when the native side reports an agent at work (⌘Q, Dock menu, logout). */
export function listenQuitRequests(): () => void {
  if (!isTauri()) return () => {};
  const off = listen("quit-requested", async () => {
    const ok = await ask(t("Агент ещё работает. Если выйти сейчас, задача прервётся."), {
      title: t("Завершить Octopus?"),
      kind: "warning",
      okLabel: t("Завершить"),
      cancelLabel: t("Остаться"),
    });
    if (ok) await invoke("app_quit", { force: true });
  });
  return () => void off.then((f) => f());
}

/** False for a Linux system package (.deb, AUR): the package manager updates it. */
function selfUpdates(): Promise<boolean> {
  return invoke<boolean>("app_self_updates").catch(() => true);
}

/** A newer release, or null. Release builds only: dev builds have no signed update feed. */
export async function findUpdate(): Promise<Update | null> {
  if (!isTauri() || import.meta.env.DEV || !(await selfUpdates())) return null;
  return check();
}

/** "You're up to date" after a manual check from the menu. */
export async function sayUpToDate() {
  const version = await getVersion();
  if (isTauri() && !(await selfUpdates())) {
    await message(t("Установлена версия {version}. Её обновляет менеджер пакетов системы.", { version }), { title: t("Обновления"), kind: "info" });
    return;
  }
  await message(t("Установлена последняя версия: {version}.", { version }), { title: t("Обновлений нет"), kind: "info" });
}

export async function sayUpdateFailed(error: unknown) {
  await message(t("Не удалось проверить обновления: {error}", { error: String(error) }), { title: t("Обновления"), kind: "error" });
}

export { relaunch };
export type { Update };
