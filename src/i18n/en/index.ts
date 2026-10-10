import app from "./app";
import prices from "./prices";
import budget from "./budget";
import context from "./context";
import sidebar from "./sidebar";
import terminal from "./terminal";
import worktrees from "./worktrees";
import connections from "./connections";
import gitops from "./gitops";
import onboarding from "./onboarding";
import plan from "./plan";
import checkpoints from "./checkpoints";
import review from "./review";
import search from "./search";
import theme from "./theme";
import backend from "./backend";
import chat from "./chat";
import markdown from "./markdown";
import session from "./session";
import settings from "./settings";
import shell from "./shell";
import work from "./work";
import instructions from "./instructions";
import rules from "./rules";

/** All English strings, keyed by the Russian source text. */
export const EN: Record<string, string> = { ...backend, ...session, ...markdown, ...shell, ...chat, ...settings, ...work, ...checkpoints, ...review, ...search, ...theme, ...plan, ...gitops, ...connections, ...onboarding, ...worktrees, ...terminal, ...context, ...sidebar, ...budget, ...prices, ...app, ...instructions, ...rules };
