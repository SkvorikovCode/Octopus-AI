// Recent projects: a small list of folders the user opened, kept in localStorage.
// Most recent first, capped at MAX_RECENT. Every storage access is guarded,
// because localStorage can be blocked or throw (private windows, cleared data).

export type RecentProject = { path: string; name: string; openedAt: number };

const KEY = "octopus.recentProjects";
const MAX_RECENT = 12;

function isRecent(value: unknown): value is RecentProject {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.path === "string" &&
    v.path.length > 0 &&
    typeof v.name === "string" &&
    typeof v.openedAt === "number" &&
    Number.isFinite(v.openedAt)
  );
}

function readAll(): RecentProject[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecent).slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

function writeAll(list: RecentProject[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Storage unavailable: the list simply stays in memory for this session.
  }
}

/** Last path segment, ignoring trailing separators. Falls back to the full path. */
export function projectName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const segment = trimmed.split(/[\\/]/).pop() ?? "";
  return segment || path;
}

export function getRecentProjects(): RecentProject[] {
  return readAll();
}

/** Adds the path to the top of the list (or moves it there) and returns the new list. */
export function touchProject(path: string): RecentProject[] {
  const entry: RecentProject = { path, name: projectName(path), openedAt: Date.now() };
  const next = [entry, ...readAll().filter((p) => p.path !== path)].slice(0, MAX_RECENT);
  writeAll(next);
  return next;
}

/** Removes the path from the list and returns the new list. */
export function forgetProject(path: string): RecentProject[] {
  const next = readAll().filter((p) => p.path !== path);
  writeAll(next);
  return next;
}
