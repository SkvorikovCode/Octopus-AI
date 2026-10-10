# Contributing to Octopus AI

Thanks for wanting to help. Octopus is early, so small, focused changes and
honest bug reports are the most useful things you can send.

## Getting set up

You need [Rust](https://rustup.rs), Node.js 20.19+ and the `omp` engine (see the
[README](README.md#run-it-from-source)).

```sh
npm install
npm run tauri dev        # the desktop app with hot reload
npm test                 # frontend unit tests (vitest)
npm run build            # type-check + production bundle
cargo test --manifest-path src-tauri/Cargo.toml
```

Before you open a pull request, `npm run build`, `npm test` and `cargo test`
should pass. CI runs the same checks.

## Before you start

- **Small fix or obvious bug?** Just open a PR.
- **New feature, new setting, or anything that changes how the app behaves?**
  Open an issue first so we can agree on the shape before you spend time on it.
  Octopus has a deliberate design (calm, plain language, depth on demand), and
  we would rather say so up front than after a big PR.
- **Security issue?** Do not open a public issue — see [SECURITY.md](SECURITY.md).

## Branches and commits

Work on a branch off `main` (`feat/swarm-filters`, `fix/worktree-cleanup`).

Commit messages and PR titles follow
[Conventional Commits](https://www.conventionalcommits.org):

```
<type>(<optional scope>): <what changed, imperative, lower case>
```

| Type | Use for |
| --- | --- |
| `feat` | a user-visible capability |
| `fix` | a bug fix |
| `docs` | documentation only |
| `refactor` | code change that neither fixes a bug nor adds a feature |
| `test` | adding or fixing tests |
| `perf` | a performance improvement |
| `build` / `ci` | build system, dependencies, CI config |
| `chore` | everything else |

Add `!` after the type for a breaking change (`feat!: ...`) and explain it in the
body. Examples: `feat(swarm): filter agents by status`,
`fix(worktrees): remove the directory when a task is cancelled`.

We squash-merge, so the **PR title** becomes the commit on `main` and must follow
this format (a check enforces it). Individual commits inside your branch can be
messy.

## Pull requests

- Keep a PR to one idea. Describe *why*, not just *what*.
- Add or update tests when behaviour changes. Bug fixes should come with a test
  that fails without the fix where practical.
- UI changes: include a screenshot or short recording.
- Never commit secrets, real API keys or personal data, including in test
  fixtures.

## Code style

Match the surrounding code. TypeScript runs in strict mode; run `cargo fmt` on the
Rust files you touch. User-visible text lives in
`src/i18n/`, not inline in components. The interface never exposes the engine's
internals — talk about "the agent", not about the process underneath.

## Licence

By contributing you agree your work is released under the [Apache-2.0
licence](LICENSE), as the rest of the project.
