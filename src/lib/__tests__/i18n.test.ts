import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetSettings, updateSettings } from "../settings";
import { currentLang, locale, systemLang, t, tErr, tn, tw } from "../i18n";

/** Pins the UI language setting; the store is re-read on each call, so no reload is needed. */
function setLanguage(language: "auto" | "ru" | "en") {
  updateSettings({ language });
}

/** Fakes the webview language list (navigator is read on every call, so an own property works). */
function setNavigator(languages: string[], language = languages[0] ?? "") {
  Object.defineProperty(navigator, "languages", { configurable: true, get: () => languages });
  Object.defineProperty(navigator, "language", { configurable: true, get: () => language });
}

function restoreNavigator() {
  const nav = navigator as unknown as Record<string, unknown>;
  delete nav.languages;
  delete nav.language;
}

beforeEach(() => {
  resetSettings();
});

afterEach(() => {
  restoreNavigator();
  resetSettings();
});

describe("systemLang", () => {
  it("is ru for ru-* tags", () => {
    setNavigator(["ru-RU", "en-US"]);
    expect(systemLang()).toBe("ru");
  });

  it("matches the tag case-insensitively", () => {
    setNavigator(["RU"]);
    expect(systemLang()).toBe("ru");
  });

  it("is en for any other language, including Ukrainian and Kazakh", () => {
    setNavigator(["uk-UA"]);
    expect(systemLang()).toBe("en");
    setNavigator(["de-DE", "ru-RU"]);
    expect(systemLang()).toBe("en");
  });

  it("uses only the first preferred language", () => {
    setNavigator(["en-US", "ru-RU"]);
    expect(systemLang()).toBe("en");
  });

  it("falls back to navigator.language when the languages list is empty", () => {
    setNavigator([], "ru-RU");
    expect(systemLang()).toBe("ru");
  });
});

describe("currentLang", () => {
  it("follows an explicit ru setting even when the system is English", () => {
    setNavigator(["en-US"]);
    setLanguage("ru");
    expect(currentLang()).toBe("ru");
  });

  it("follows an explicit en setting even when the system is Russian", () => {
    setNavigator(["ru-RU"]);
    setLanguage("en");
    expect(currentLang()).toBe("en");
  });

  it("follows the system language on auto", () => {
    setLanguage("auto");
    setNavigator(["ru-RU"]);
    expect(currentLang()).toBe("ru");
    setNavigator(["en-GB"]);
    expect(currentLang()).toBe("en");
  });

  it("ignores an unknown stored value and uses the system language", () => {
    setNavigator(["ru-RU"]);
    updateSettings({ language: "de" as unknown as "auto" });
    expect(currentLang()).toBe("ru");
  });
});

describe("locale", () => {
  it("is en-US for English and ru-RU for Russian", () => {
    setLanguage("en");
    expect(locale()).toBe("en-US");
    setLanguage("ru");
    expect(locale()).toBe("ru-RU");
  });
});

describe("t", () => {
  describe("in Russian", () => {
    beforeEach(() => setLanguage("ru"));

    it("returns the Russian source text", () => {
      expect(t("Новая сессия")).toBe("Новая сессия");
    });

    it("substitutes {var} placeholders", () => {
      expect(t("Код выхода: {code}", { code: 3 })).toBe("Код выхода: 3");
    });

    it("substitutes a zero value", () => {
      expect(t("Код выхода: {code}", { code: 0 })).toBe("Код выхода: 0");
    });

    it("leaves a placeholder without a value as is", () => {
      expect(t("Код выхода: {code}")).toBe("Код выхода: {code}");
      expect(t("Код выхода: {code}", { other: 1 })).toBe("Код выхода: {code}");
    });

    it("does not interpret $ patterns in values", () => {
      expect(t("Привет, {name}!", { name: "$&$1" })).toBe("Привет, $&$1!");
    });
  });

  describe("in English", () => {
    beforeEach(() => setLanguage("en"));

    it("returns the dictionary entry for a known Russian key", () => {
      expect(t("Новая сессия")).toBe("New session");
    });

    it("falls back to the Russian text for an unknown key", () => {
      expect(t("Тестовая строка без перевода")).toBe("Тестовая строка без перевода");
    });

    it("substitutes vars into the English entry", () => {
      expect(t("Код выхода: {code}", { code: 3 })).toBe("Exit code: 3");
    });

    it("substitutes vars into a Russian fallback text", () => {
      expect(t("Привет, {name}!", { name: "Аня" })).toBe("Привет, Аня!");
    });

    it("substitutes vars into a long dictionary entry", () => {
      expect(t("Агент работает в папке «{name}»: {mode}.", { name: "Octopus", mode: "ask" })).toBe(
        "Working in “Octopus”: ask.",
      );
    });
  });
});

describe("tn", () => {
  describe("Russian plural rules", () => {
    beforeEach(() => setLanguage("ru"));
    const forms = "файл|файла|файлов";

    it.each([
      [1, "1 файл"],
      [2, "2 файла"],
      [4, "4 файла"],
      [5, "5 файлов"],
      [0, "0 файлов"],
      [11, "11 файлов"],
      [12, "12 файлов"],
      [14, "14 файлов"],
      [21, "21 файл"],
      [22, "22 файла"],
      [25, "25 файлов"],
      [101, "101 файл"],
      [111, "111 файлов"],
      [112, "112 файлов"],
      [-1, "-1 файл"],
    ])("n=%i → %s", (n, expected) => {
      expect(tn(n, forms)).toBe(expected);
    });

    it("formats the number with the Russian locale", () => {
      expect(tn(1000, forms)).toBe(`${(1000).toLocaleString("ru-RU")} файлов`);
    });

    it("places the number where {n} is in the form", () => {
      expect(tn(5, "{n} монета|{n} монеты|{n} монет")).toBe("5 монет");
      expect(tn(2, "{n} монета|{n} монеты|{n} монет")).toBe("2 монеты");
    });

    it("substitutes extra vars alongside {n}", () => {
      expect(tn(3, "{n} файл в {dir}|{n} файла в {dir}|{n} файлов в {dir}", { dir: "src" })).toBe("3 файла в src");
    });
  });

  describe("English plural rules", () => {
    beforeEach(() => setLanguage("en"));

    it("uses the dictionary plural for the Russian key", () => {
      expect(tn(1, "файл|файла|файлов")).toBe("1 file");
      expect(tn(0, "файл|файла|файлов")).toBe("0 files");
      expect(tn(2, "файл|файла|файлов")).toBe("2 files");
      expect(tn(21, "файл|файла|файлов")).toBe("21 files");
    });

    it("uses the English form for 0 and fractions other than 1", () => {
      expect(tn(0, "день|дня|дней")).toBe("0 days");
      expect(tn(1.5, "день|дня|дней")).toBe("1.5 days");
    });

    it("formats the number with the English locale", () => {
      expect(tn(1000, "файл|файла|файлов")).toBe(`${(1000).toLocaleString("en-US")} files`);
    });
  });
});

describe("tw", () => {
  it("returns only the Russian word form", () => {
    setLanguage("ru");
    expect(tw(1, "файл|файла|файлов")).toBe("файл");
    expect(tw(3, "файл|файла|файлов")).toBe("файла");
    expect(tw(7, "файл|файла|файлов")).toBe("файлов");
    expect(tw(11, "файл|файла|файлов")).toBe("файлов");
    expect(tw(21, "файл|файла|файлов")).toBe("файл");
  });

  it("returns only the English word form", () => {
    setLanguage("en");
    expect(tw(1, "файл|файла|файлов")).toBe("file");
    expect(tw(0, "файл|файла|файлов")).toBe("files");
    expect(tw(5, "шаг|шага|шагов")).toBe("steps");
  });
});

describe("tErr", () => {
  describe("in Russian", () => {
    beforeEach(() => setLanguage("ru"));

    it("returns the message unchanged", () => {
      expect(tErr(new Error("Файл не найден"))).toBe("Файл не найден");
      expect(tErr("Папка не найдена: /tmp/x")).toBe("Папка не найдена: /tmp/x");
    });
  });

  describe("in English", () => {
    beforeEach(() => setLanguage("en"));

    it("translates an exact backend message", () => {
      expect(tErr(new Error("Файл не найден"))).toBe("File not found");
      expect(tErr("Файл слишком большой (максимум 20 МБ)")).toBe("File is too large (20 MB max)");
    });

    it("translates the prefix of a 'Prefix: details' message and keeps the details", () => {
      expect(tErr("Папка не найдена: /Users/me/project")).toBe("Folder not found: /Users/me/project");
    });

    it("keeps multi-line details after the prefix", () => {
      expect(tErr("Папка не найдена: line one\nline two")).toBe("Folder not found: line one\nline two");
    });

    it("returns an untranslated message unchanged", () => {
      expect(tErr(new Error("Something unexpected happened"))).toBe("Something unexpected happened");
      expect(tErr("Что-то неизвестное: детали")).toBe("Что-то неизвестное: детали");
    });

    it("does not treat a short or multi-line prefix as a key", () => {
      expect(tErr("Ко: x")).toBe("Ко: x");
      expect(tErr("Папка\nне найдена: x")).toBe("Папка\nне найдена: x");
    });

    it("converts non-Error values to text", () => {
      expect(tErr(42)).toBe("42");
      expect(tErr(null)).toBe("null");
      expect(tErr("Файл не найден")).toBe("File not found");
    });

    it("does not return inherited Object.prototype members as translations", () => {
      expect(typeof t("constructor")).toBe("string");
      expect(typeof tErr(new Error("toString"))).toBe("string");
    });
  });
});
