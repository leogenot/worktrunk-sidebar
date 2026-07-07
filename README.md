# Worktrunk Sidebar

A VS Code activity-bar sidebar for managing git worktrees with [worktrunk](https://worktrunk.dev) (`wt`). It's a thin UI over the `wt` CLI — worktrunk stays the engine; this just gives you buttons.

## Features

- **Worktrees list** — every worktree for the current repo, with branch name, commit age, ahead/behind, and `+/−` diff counts. Live from `wt list --format json`.
- **Context-aware UI** — the worktree open in *this* window is highlighted (blue `◉`) and sorted to the top; worktrees with uncommitted changes are tinted like VS Code's git decorations. Icons: blue circle = this window · green star = current · repo = main · branch = others. The view header shows `repo · count` and the activity-bar icon carries a count badge.
- **Click a worktree** → opens it in a **new window** (one window per worktree).
- **Create Worktree** (`+` in the view title) → prompts for a branch name and runs `wt switch --create`.
- **Rename** (pencil icon / right-click) → renames the local branch (`git branch -m`) and moves the worktree folder to match via `wt step relocate`. The remote branch and any open PR keep the old name. Offers to reopen the moved folder afterward.
- **Per-item actions** (right-click or inline icons): Open in New Window · Open in This Window · Rename · Open Terminal Here · Copy Path · Merge into Default Branch · Remove Worktree.
- **Refresh** (`↻`) — also auto-refreshes when the panel is shown or the window regains focus.

## Requirements

- worktrunk installed (`brew install worktrunk`). Auto-detected at `/opt/homebrew/bin/wt`, `/usr/local/bin/wt`, or `~/.cargo/bin/wt`. Override with `worktrunk.wtPath`.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `worktrunk.wtPath` | `""` | Absolute path to `wt`; empty = auto-detect. |
| `worktrunk.openAfterCreate` | `false` | Open the new worktree in a window from the extension after Create. Leave **off** if your worktrunk `post-switch` hook already opens the editor (avoids double windows). |
| `worktrunk.createArgs` | `["--create"]` | Args passed to `wt switch` before the branch name. |

### Note on window-opening

If your worktrunk user config has `post-switch = "code {{ worktree_path }}"`, that hook opens the window when the extension runs **Create** (because Create calls `wt switch`). So `openAfterCreate` defaults to `false` to avoid opening two windows. Set it to `true` only if you remove that hook.

## Develop

```bash
npm install
npm run compile      # or: npm run watch
# press F5 in VS Code to launch an Extension Development Host
```

## Package & install

```bash
npm install
npx @vscode/vsce package
code --install-extension worktrunk-sidebar-0.0.1.vsix
```
