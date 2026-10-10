# Security policy

Octopus handles provider API keys and runs agents that can edit files and run
commands in your projects, so we take security reports seriously.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private reporting instead:

👉 [Report a vulnerability](https://github.com/SkvorikovCode/Octopus-AI/security/advisories/new)

Include what you found, how to reproduce it, and the impact you expect. We aim to
acknowledge a report within **3 business days** and to keep you updated until
it is fixed. We will credit you in the advisory unless you prefer not to be named.

## What counts

Examples we especially want to hear about:

- Leaking or mishandling provider keys (keychain access, logs, crash reports,
  environment passed to child processes).
- An agent acting outside the project folder or bypassing a permission card.
- Command or path injection through project files, rules, instructions or MCP
  configuration.
- Anything in the Tauri capabilities/allowlist that grants more than the app needs.

Out of scope: problems that need a malicious local user who already controls your
account, and vulnerabilities in third-party engines or providers (report those
upstream — though tell us if Octopus makes them worse).

## Supported versions

Octopus is pre-1.0. Only the latest release and `main` receive fixes.
