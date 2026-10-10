// First-run onboarding: a single flag in localStorage. Storage can be blocked,
// so every access is guarded; when it is unavailable onboarding simply shows again.

const KEY = "octopus.onboarded";

export function isOnboarded(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function markOnboarded(): void {
  try {
    localStorage.setItem(KEY, "1");
  } catch {
    /* not persisted: onboarding shows again on the next launch */
  }
}

/** Shows onboarding again on the next render (settings / debug). */
export function resetOnboarding(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing stored, nothing to reset */
  }
}
