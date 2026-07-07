import * as vscode from 'vscode';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Shape of one entry from `wt list --format json` (only the fields we use). */
interface WtEntry {
  branch: string;
  path: string;
  kind?: string;
  is_main?: boolean;
  is_current?: boolean;
  commit?: { short_sha?: string; message?: string };
  working_tree?: {
    staged?: boolean;
    modified?: boolean;
    untracked?: boolean;
    diff?: { added?: number; deleted?: number };
  };
  remote?: { ahead?: number; behind?: number };
}

/** Resolve the `wt` binary. GUI-launched editors often lack Homebrew on PATH. */
function resolveWt(): string {
  const configured = vscode.workspace.getConfiguration('worktrunk').get<string>('wtPath');
  if (configured && configured.trim()) {
    return configured.trim();
  }
  const home = process.env.HOME ?? '';
  const candidates = [
    '/opt/homebrew/bin/wt',
    '/usr/local/bin/wt',
    `${home}/.cargo/bin/wt`,
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      /* ignore */
    }
  }
  return 'wt';
}

/** Env with common bin dirs appended so `wt` and its hooks (bun, code) resolve. */
function hookEnv(): NodeJS.ProcessEnv {
  const home = process.env.HOME ?? '';
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', `${home}/.local/bin`, `${home}/.cargo/bin`];
  const path = [process.env.PATH ?? '', ...extra].filter(Boolean).join(':');
  return { ...process.env, PATH: path };
}

/** The repo directory to run `wt` in: the active editor's folder, else the first workspace folder. */
function getRepoCwd(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    return undefined;
  }
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  if (activeUri) {
    const folder = vscode.workspace.getWorkspaceFolder(activeUri);
    if (folder) {
      return folder.uri.fsPath;
    }
  }
  return folders[0].uri.fsPath;
}

async function listWorktrees(cwd: string): Promise<WtEntry[]> {
  const { stdout } = await execFileAsync(resolveWt(), ['list', '--format', 'json'], {
    cwd,
    env: hookEnv(),
    maxBuffer: 32 * 1024 * 1024,
  });
  const parsed = JSON.parse(stdout) as WtEntry[];
  return parsed.filter((e) => e && e.path && (e.kind === undefined || e.kind === 'worktree'));
}

/** Run a binary with a progress notification; surface stderr on failure. */
async function runCommand(bin: string, args: string[], cwd: string, title: string): Promise<boolean> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: false },
    async () => {
      try {
        await execFileAsync(bin, args, { cwd, env: hookEnv(), maxBuffer: 32 * 1024 * 1024 });
        return true;
      } catch (err) {
        const e = err as { stderr?: string; message?: string };
        const detail = (e.stderr && e.stderr.trim()) || e.message || 'unknown error';
        const label = bin.split('/').pop() ?? bin;
        vscode.window.showErrorMessage(`${label} ${args.join(' ')} failed: ${detail}`);
        return false;
      }
    },
  );
}

/** Run a `wt` subcommand. */
function runWt(args: string[], cwd: string, title: string): Promise<boolean> {
  return runCommand(resolveWt(), args, cwd, title);
}

/** Absolute path of the repo's main worktree — a stable cwd for repo-wide operations. */
async function getMainWorktreePath(cwd: string): Promise<string | undefined> {
  try {
    const entries = await listWorktrees(cwd);
    return entries.find((e) => e.is_main)?.path;
  } catch {
    return undefined;
  }
}

class WorktreeItem extends vscode.TreeItem {
  constructor(public readonly entry?: WtEntry, message?: string) {
    super(entry ? entry.branch : message ?? '', vscode.TreeItemCollapsibleState.None);

    if (!entry) {
      this.contextValue = 'message';
      this.iconPath = new vscode.ThemeIcon('info');
      return;
    }

    this.resourceUri = vscode.Uri.file(entry.path);
    this.contextValue = entry.is_main ? 'worktreeMain' : 'worktree';

    const parts: string[] = [];
    if (entry.is_current) {
      parts.push('● current');
    }
    if (entry.is_main) {
      parts.push('main');
    }
    const ahead = entry.remote?.ahead ?? 0;
    const behind = entry.remote?.behind ?? 0;
    if (ahead || behind) {
      parts.push(`${ahead ? `↑${ahead}` : ''}${behind ? `↓${behind}` : ''}`);
    }
    const added = entry.working_tree?.diff?.added ?? 0;
    const deleted = entry.working_tree?.diff?.deleted ?? 0;
    if (added || deleted) {
      parts.push(`+${added}/-${deleted}`);
    }
    const wt = entry.working_tree;
    if (wt && (wt.staged || wt.modified || wt.untracked)) {
      parts.push('✎');
    }
    this.description = parts.join('  ');

    this.iconPath = entry.is_current
      ? new vscode.ThemeIcon('star-full', new vscode.ThemeColor('charts.green'))
      : entry.is_main
        ? new vscode.ThemeIcon('repo')
        : new vscode.ThemeIcon('git-branch');

    const tip = new vscode.MarkdownString();
    tip.appendMarkdown(`**${entry.branch}**\n\n`);
    tip.appendMarkdown(`\`${entry.path}\`\n\n`);
    if (entry.commit?.short_sha) {
      tip.appendMarkdown(`${entry.commit.short_sha} — ${entry.commit.message ?? ''}`);
    }
    this.tooltip = tip;

    // Primary click action: open this worktree in a new window.
    this.command = {
      command: 'worktrunk.openInNewWindow',
      title: 'Open in New Window',
      arguments: [this],
    };
  }
}

class WorktreeProvider implements vscode.TreeDataProvider<WorktreeItem> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(item: WorktreeItem): vscode.TreeItem {
    return item;
  }

  async getChildren(): Promise<WorktreeItem[]> {
    const cwd = getRepoCwd();
    if (!cwd) {
      return []; // viewsWelcome handles the empty state.
    }
    try {
      const entries = await listWorktrees(cwd);
      return entries.map((e) => new WorktreeItem(e));
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      const detail = (e.stderr && e.stderr.trim()) || e.message || 'wt list failed';
      return [new WorktreeItem(undefined, detail.split('\n')[0])];
    }
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new WorktreeProvider();
  const view = vscode.window.createTreeView('worktrunkWorktrees', {
    treeDataProvider: provider,
    showCollapseAll: false,
  });

  // Refresh when the panel becomes visible and on window focus.
  view.onDidChangeVisibility((e) => {
    if (e.visible) {
      provider.refresh();
    }
  });
  vscode.window.onDidChangeWindowState((s) => {
    if (s.focused) {
      provider.refresh();
    }
  });

  const openFolder = (item: WorktreeItem | undefined, forceNewWindow: boolean) => {
    const path = item?.entry?.path;
    if (!path) {
      return;
    }
    void vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(path), {
      forceNewWindow,
    });
  };

  context.subscriptions.push(
    view,

    vscode.commands.registerCommand('worktrunk.refresh', () => provider.refresh()),

    vscode.commands.registerCommand('worktrunk.openInNewWindow', (item?: WorktreeItem) =>
      openFolder(item, true),
    ),

    vscode.commands.registerCommand('worktrunk.openInThisWindow', (item?: WorktreeItem) =>
      openFolder(item, false),
    ),

    vscode.commands.registerCommand('worktrunk.openTerminal', (item?: WorktreeItem) => {
      const path = item?.entry?.path;
      if (!path) {
        return;
      }
      const terminal = vscode.window.createTerminal({ name: item!.entry!.branch, cwd: path });
      terminal.show();
    }),

    vscode.commands.registerCommand('worktrunk.copyPath', async (item?: WorktreeItem) => {
      const path = item?.entry?.path;
      if (!path) {
        return;
      }
      await vscode.env.clipboard.writeText(path);
      vscode.window.setStatusBarMessage(`Copied ${path}`, 2000);
    }),

    vscode.commands.registerCommand('worktrunk.create', async () => {
      const cwd = getRepoCwd();
      if (!cwd) {
        vscode.window.showErrorMessage('Open a folder inside a git repository first.');
        return;
      }
      const branch = await vscode.window.showInputBox({
        prompt: 'Branch name for the new worktree',
        placeHolder: 'dev-1234-my-feature',
        validateInput: (v) => (v && v.trim() ? undefined : 'Enter a branch name'),
      });
      if (!branch) {
        return;
      }
      const name = branch.trim();
      const cfg = vscode.workspace.getConfiguration('worktrunk');
      const createArgs = cfg.get<string[]>('createArgs') ?? ['--create'];
      const ok = await runWt(['switch', ...createArgs, name, '-y'], cwd, `Creating worktree ${name}…`);
      if (!ok) {
        return;
      }
      provider.refresh();
      if (cfg.get<boolean>('openAfterCreate')) {
        try {
          const entries = await listWorktrees(cwd);
          const created = entries.find((e) => e.branch === name);
          if (created) {
            void vscode.commands.executeCommand(
              'vscode.openFolder',
              vscode.Uri.file(created.path),
              { forceNewWindow: true },
            );
          }
        } catch {
          /* refresh already happened; ignore lookup failure */
        }
      }
    }),

    vscode.commands.registerCommand('worktrunk.rename', async (item?: WorktreeItem) => {
      const entry = item?.entry;
      const cwd = getRepoCwd();
      if (!entry || !cwd) {
        return;
      }
      const newName = await vscode.window.showInputBox({
        prompt: `Rename branch “${entry.branch}” to…`,
        value: entry.branch,
        valueSelection: [0, entry.branch.length],
        validateInput: (v) => {
          const t = (v ?? '').trim();
          if (!t) {
            return 'Enter a branch name';
          }
          if (t === entry.branch) {
            return 'Enter a different name';
          }
          if (/\s/.test(t)) {
            return 'Branch names cannot contain spaces';
          }
          return undefined;
        },
      });
      if (!newName) {
        return;
      }
      const name = newName.trim();
      const choice = await vscode.window.showWarningMessage(
        `Rename the local branch “${entry.branch}” to “${name}” and move its worktree folder to match? The remote branch and any open PR keep the old name.`,
        { modal: true },
        'Rename',
      );
      if (choice !== 'Rename') {
        return;
      }

      // 1. Rename the branch (git allows renaming a branch that's checked out).
      const renamed = await runCommand(
        'git',
        ['branch', '-m', name],
        entry.path,
        `Renaming ${entry.branch} → ${name}…`,
      );
      if (!renamed) {
        return;
      }

      // 2. Move the folder to the branch-named path, from a stable cwd (the main worktree).
      const mainPath = (await getMainWorktreePath(cwd)) ?? cwd;
      await runWt(['step', 'relocate', name], mainPath, 'Moving worktree folder…');
      provider.refresh();

      // 3. The old folder is gone; offer to (re)open the moved worktree.
      try {
        const moved = (await listWorktrees(mainPath)).find((e) => e.branch === name);
        if (moved) {
          const open = await vscode.window.showInformationMessage(
            `Renamed to “${name}”.`,
            'Open in New Window',
          );
          if (open === 'Open in New Window') {
            void vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(moved.path), {
              forceNewWindow: true,
            });
          }
        }
      } catch {
        /* refresh already happened; ignore lookup failure */
      }
    }),

    vscode.commands.registerCommand('worktrunk.remove', async (item?: WorktreeItem) => {
      const entry = item?.entry;
      const cwd = getRepoCwd();
      if (!entry || !cwd) {
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        `Remove the worktree for “${entry.branch}” and delete the branch?`,
        { modal: true },
        'Remove',
      );
      if (choice !== 'Remove') {
        return;
      }
      const ok = await runWt(['remove', entry.branch, '-y'], cwd, `Removing ${entry.branch}…`);
      if (ok) {
        provider.refresh();
      }
    }),

    vscode.commands.registerCommand('worktrunk.merge', async (item?: WorktreeItem) => {
      const entry = item?.entry;
      if (!entry) {
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        `Merge “${entry.branch}” into the default branch? worktrunk will rebase, squash, merge, and then remove this worktree.`,
        { modal: true },
        'Merge',
      );
      if (choice !== 'Merge') {
        return;
      }
      const ok = await runWt(['merge', '-y'], entry.path, `Merging ${entry.branch}…`);
      if (ok) {
        provider.refresh();
      }
    }),
  );
}

export function deactivate(): void {
  /* nothing to clean up */
}
