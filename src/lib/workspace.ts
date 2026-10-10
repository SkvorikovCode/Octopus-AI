// Git state of the project folder and file search, served by Rust commands.
// Outside Tauri (plain browser preview) every call returns scripted demo data
// so the Changes UI can be seen without a repository.

import { invoke, isTauri } from "@tauri-apps/api/core";

export type GitFile = {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflict";
  additions: number;
  deletions: number;
  oldPath?: string | null;
};

export type GitStatus = {
  isRepo: boolean;
  branch?: string | null;
  files: GitFile[];
  additions: number;
  deletions: number;
};

/** Current status of `cwd`; `isRepo: false` when the folder is not under git. */
export function gitStatus(cwd: string): Promise<GitStatus> {
  if (!isTauri()) return Promise.resolve(demoStatus());
  return invoke<GitStatus>("git_status", { cwd });
}

/** Unified diff text of one file, relative to HEAD. */
export function gitDiff(cwd: string, path: string): Promise<string> {
  if (!isTauri()) return Promise.resolve(demoDiff(path));
  return invoke<string>("git_diff", { cwd, path });
}

/** Reverts one file to HEAD; deletes it when it is untracked. */
export function gitRestore(cwd: string, path: string): Promise<void> {
  if (!isTauri()) {
    demoRestore(path);
    return Promise.resolve();
  }
  return invoke<void>("git_restore", { cwd, path });
}

/**
 * Applies one hunk of `path` to the index ("stage") or to the worktree ("revert").
 * `patch` is a complete single-file patch: git headers naming `path` plus one hunk.
 */
export function applyHunk(cwd: string, path: string, patch: string, mode: "stage" | "revert"): Promise<void> {
  if (!isTauri()) return new Promise((resolve) => window.setTimeout(resolve, 250));
  return invoke<void>("git_apply_hunk", { cwd, path, patch, mode });
}

/** Project files whose path contains `query` (case-insensitive). */
export function projectFiles(cwd: string, query: string, limit = 50): Promise<string[]> {
  if (!isTauri()) return Promise.resolve(demoProjectFiles(query, limit));
  return invoke<string[]>("project_files", { cwd, query, limit });
}

// ---------- demo data (browser preview) ----------

let demoFiles: GitFile[] = [
  { path: "src/pages/pricing.tsx", status: "added", additions: 84, deletions: 0 },
  { path: "src/api/stripe.ts", status: "modified", additions: 31, deletions: 6 },
  { path: "README.md", status: "modified", additions: 4, deletions: 1 },
];

const DEMO_DIFFS: Record<string, string> = {
  "src/pages/pricing.tsx": `diff --git a/src/pages/pricing.tsx b/src/pages/pricing.tsx
new file mode 100644
--- /dev/null
+++ b/src/pages/pricing.tsx
@@ -0,0 +1,22 @@
+import { useState } from "react";
+import { PLANS, type Plan } from "../api/stripe";
+
+export default function Pricing() {
+  const [yearly, setYearly] = useState(false);
+
+  return (
+    <section className="pricing">
+      <header>
+        <h1>Тарифы</h1>
+        <label>
+          <input type="checkbox" checked={yearly} onChange={(e) => setYearly(e.target.checked)} />
+          Оплата за год, −20%
+        </label>
+      </header>
+      <div className="plans">
+        {PLANS.map((plan: Plan) => (
+          <article key={plan.id}>
+            <h2>{plan.name}</h2>
+            <p>{yearly ? plan.yearly : plan.monthly} ₽ / мес</p>
+          </article>
+        ))}
+      </div>
+    </section>
+  );
+}
`,
  "src/api/stripe.ts": `diff --git a/src/api/stripe.ts b/src/api/stripe.ts
index 3f2a9c1..b71d4e0 100644
--- a/src/api/stripe.ts
+++ b/src/api/stripe.ts
@@ -1,15 +1,24 @@
 import Stripe from "stripe";
+
+export type Plan = { id: string; name: string; monthly: number; yearly: number };
+
+export const PLANS: Plan[] = [
+  { id: "free", name: "Free", monthly: 0, yearly: 0 },
+  { id: "pro", name: "Pro", monthly: 990, yearly: 792 },
+  { id: "team", name: "Team", monthly: 2990, yearly: 2392 },
+];

 const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
   apiVersion: "2024-06-20",
 });

-export async function createCheckout(priceId: string, email: string) {
+export async function createCheckout(priceId: string, email: string, trialDays = 0) {
   return stripe.checkout.sessions.create({
     mode: "subscription",
     customer_email: email,
     line_items: [{ price: priceId, quantity: 1 }],
+    subscription_data: { trial_period_days: trialDays || undefined },
     success_url: \`\${process.env.APP_URL}/billing/ok\`,
     cancel_url: \`\${process.env.APP_URL}/billing\`,
   });
 }
`,
  "README.md": `diff --git a/README.md b/README.md
index 9d0e5b2..4c1a7f8 100644
--- a/README.md
+++ b/README.md
@@ -12,5 +12,8 @@ Octopus demo project.
 ## Запуск

-\`npm run dev\`
+\`npm install\`
+\`npm run dev\`
+
+Переменные окружения: \`STRIPE_SECRET_KEY\`, \`APP_URL\`.

 ## Структура
`,
};

const DEMO_PROJECT_PATHS = [
  "src/App.tsx",
  "src/main.tsx",
  "src/styles.css",
  "src/pages/pricing.tsx",
  "src/pages/index.tsx",
  "src/pages/login.tsx",
  "src/api/stripe.ts",
  "src/api/client.ts",
  "src/components/Header.tsx",
  "src/components/Button.tsx",
  "README.md",
  "package.json",
  "vite.config.ts",
  "tsconfig.json",
];

function demoStatus(): GitStatus {
  const files = demoFiles.map((f) => ({ ...f }));
  return {
    isRepo: true,
    branch: "feat/pricing",
    files,
    additions: files.reduce((sum, f) => sum + f.additions, 0),
    deletions: files.reduce((sum, f) => sum + f.deletions, 0),
  };
}

function demoDiff(path: string): string {
  return DEMO_DIFFS[path] ?? "";
}

function demoRestore(path: string): void {
  demoFiles = demoFiles.filter((f) => f.path !== path);
}

function demoProjectFiles(query: string, limit: number): string[] {
  const q = query.trim().toLowerCase();
  return DEMO_PROJECT_PATHS.filter((p) => p.toLowerCase().includes(q)).slice(0, limit);
}
