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
  commit?: { short_sha?: string; message?: string; timestamp?: number };
  working_tree?: {
    staged?: boolean;
    modified?: boolean;
    untracked?: boolean;
    renamed?: boolean;
    deleted?: boolean;
    diff?: { added?: number; deleted?: number };
  };
  remote?: { ahead?: number; behind?: number };
  repo?: { name?: string };
}

/** Strip a trailing slash so paths compare cleanly. */
function norm(p: string): string {
  return p.replace(/\/+$/, '');
}

/** Folder paths open in THIS editor window. */
function currentWindowPaths(): Set<string> {
  const set = new Set<string>();
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    set.add(norm(folder.uri.fsPath));
  }
  return set;
}

/** Does the worktree have uncommitted work? */
function isDirty(entry: WtEntry): boolean {
  const wt = entry.working_tree;
  if (!wt) {
    return false;
  }
  const diff = (wt.diff?.added ?? 0) + (wt.diff?.deleted ?? 0);
  return Boolean(wt.staged || wt.modified || wt.untracked || wt.renamed || wt.deleted || diff);
}

/** Compact relative age, e.g. "2h", "3d". */
function ago(timestamp?: number): string {
  if (!timestamp) {
    return '';
  }
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - timestamp);
  const units: [number, string][] = [
    [60, 's'],
    [60, 'm'],
    [24, 'h'],
    [30, 'd'],
    [12, 'mo'],
    [Number.POSITIVE_INFINITY, 'y'],
  ];
  let value = seconds;
  for (let i = 0; i < units.length; i++) {
    const [size, label] = units[i];
    if (value < size || i === units.length - 1) {
      return `${Math.floor(value)}${label}`;
    }
    value = value / size;
  }
  return '';
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

type CreateResult = 'created' | 'switched' | 'failed';

/**
 * Create a worktree for a new branch. worktrunk rejects `--create` when the
 * branch already exists, so on that specific error we fall back to a plain
 * `wt switch`, which opens (or creates a worktree for) the existing branch.
 */
async function createOrSwitchWorktree(name: string, cwd: string): Promise<CreateResult> {
  const createArgs =
    vscode.workspace.getConfiguration('worktrunk').get<string[]>('createArgs') ?? ['--create'];
  const wt = resolveWt();
  const run = (args: string[]) =>
    execFileAsync(wt, args, { cwd, env: hookEnv(), maxBuffer: 32 * 1024 * 1024 });
  const stderrOf = (err: unknown) => ((err as { stderr?: string }).stderr ?? '').trim();
  const detailOf = (err: unknown) =>
    (stderrOf(err) || (err as { message?: string }).message || 'unknown error').trim();

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Preparing worktree ${name}…`,
      cancellable: false,
    },
    async () => {
      try {
        await run(['switch', ...createArgs, name, '-y']);
        return 'created';
      } catch (err) {
        if (/already exists/i.test(stderrOf(err))) {
          try {
            await run(['switch', name, '-y']);
            return 'switched';
          } catch (switchErr) {
            vscode.window.showErrorMessage(`wt switch ${name} failed: ${detailOf(switchErr)}`);
            return 'failed';
          }
        }
        vscode.window.showErrorMessage(
          `wt switch ${createArgs.join(' ')} ${name} failed: ${detailOf(err)}`,
        );
        return 'failed';
      }
    },
  );
}

/**
 * Tints tree rows and adds a small badge, like VS Code's own git decorations:
 * blue "◉" for the worktree open in this window, and the modified color with a
 * "●" for worktrees that have uncommitted changes.
 */
class WorktreeDecorations implements vscode.FileDecorationProvider {
  private readonly emitter = new vscode.EventEmitter<undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;
  private readonly map = new Map<string, vscode.FileDecoration>();

  update(entries: WtEntry[], windowPaths: Set<string>): void {
    this.map.clear();
    for (const entry of entries) {
      const key = norm(entry.path);
      if (windowPaths.has(key)) {
        this.map.set(
          key,
          new vscode.FileDecoration('◉', 'Open in this window', new vscode.ThemeColor('charts.blue')),
        );
      } else if (isDirty(entry)) {
        this.map.set(
          key,
          new vscode.FileDecoration(
            '●',
            'Uncommitted changes',
            new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'),
          ),
        );
      }
    }
    this.emitter.fire(undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    return this.map.get(norm(uri.fsPath));
  }
}

class WorktreeItem extends vscode.TreeItem {
  constructor(
    public readonly entry?: WtEntry,
    message?: string,
    isThisWindow = false,
  ) {
    super(entry ? entry.branch : message ?? '', vscode.TreeItemCollapsibleState.None);

    if (!entry) {
      this.contextValue = 'message';
      this.iconPath = new vscode.ThemeIcon('info');
      return;
    }

    this.resourceUri = vscode.Uri.file(entry.path);
    this.contextValue = entry.is_main ? 'worktreeMain' : 'worktree';

    // Description: age · ahead/behind · diff — status/role are shown via icon + decoration.
    const parts: string[] = [];
    const age = ago(entry.commit?.timestamp);
    if (age) {
      parts.push(age);
    }
    const ahead = entry.remote?.ahead ?? 0;
    const behind = entry.remote?.behind ?? 0;
    if (ahead || behind) {
      parts.push(`${ahead ? `↑${ahead}` : ''}${behind ? `↓${behind}` : ''}`);
    }
    const added = entry.working_tree?.diff?.added ?? 0;
    const deleted = entry.working_tree?.diff?.deleted ?? 0;
    if (added || deleted) {
      parts.push(`+${added}/−${deleted}`);
    }
    this.description = parts.join('  ·  ');

    this.iconPath = isThisWindow
      ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.blue'))
      : entry.is_current
        ? new vscode.ThemeIcon('star-full', new vscode.ThemeColor('charts.green'))
        : entry.is_main
          ? new vscode.ThemeIcon('repo')
          : new vscode.ThemeIcon('git-branch');

    this.tooltip = this.buildTooltip(entry, isThisWindow, ahead, behind, added, deleted);

    // Primary click action: open this worktree in a new window.
    this.command = {
      command: 'worktrunk.openInNewWindow',
      title: 'Open in New Window',
      arguments: [this],
    };
  }

  private buildTooltip(
    entry: WtEntry,
    isThisWindow: boolean,
    ahead: number,
    behind: number,
    added: number,
    deleted: number,
  ): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    const tags: string[] = [];
    if (isThisWindow) {
      tags.push('$(circle-filled) this window');
    }
    if (entry.is_current) {
      tags.push('$(star-full) current');
    }
    if (entry.is_main) {
      tags.push('$(repo) main');
    }
    md.appendMarkdown(`**${entry.branch}**`);
    if (tags.length) {
      md.appendMarkdown(`  —  ${tags.join('  ·  ')}`);
    }
    md.appendMarkdown('\n\n');
    md.appendMarkdown(`$(folder) \`${entry.path}\`\n\n`);
    if (entry.commit?.short_sha) {
      const age = ago(entry.commit.timestamp);
      md.appendMarkdown(
        `$(git-commit) \`${entry.commit.short_sha}\` ${entry.commit.message ?? ''}` +
          (age ? `  ·  ${age} ago` : '') +
          '\n\n',
      );
    }
    const meta: string[] = [];
    if (ahead || behind) {
      meta.push(`$(git-branch) ${ahead ? `↑${ahead} ` : ''}${behind ? `↓${behind}` : ''}`.trim());
    }
    if (added || deleted) {
      meta.push(`$(diff) +${added} −${deleted}`);
    } else if (!isDirty(entry)) {
      meta.push('$(check) clean');
    }
    if (meta.length) {
      md.appendMarkdown(meta.join('  ·  '));
    }
    return md;
  }
}

class WorktreeProvider implements vscode.TreeDataProvider<WorktreeItem> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  view?: vscode.TreeView<WorktreeItem>;
  decorations?: WorktreeDecorations;

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(item: WorktreeItem): vscode.TreeItem {
    return item;
  }

  /** Sort key: this-window → worktrunk-current → main → rest; ties by newest commit. */
  private rank(entry: WtEntry, windowPaths: Set<string>): number {
    if (windowPaths.has(norm(entry.path))) {
      return 0;
    }
    if (entry.is_current) {
      return 1;
    }
    if (entry.is_main) {
      return 2;
    }
    return 3;
  }

  private setHeader(repo: string | undefined, count: number): void {
    if (!this.view) {
      return;
    }
    this.view.description = repo ? `${repo} · ${count}` : undefined;
    this.view.badge = count
      ? { value: count, tooltip: `${count} worktree${count === 1 ? '' : 's'}` }
      : undefined;
  }

  async getChildren(): Promise<WorktreeItem[]> {
    const cwd = getRepoCwd();
    if (!cwd) {
      this.setHeader(undefined, 0);
      return []; // viewsWelcome handles the empty state.
    }
    try {
      const entries = await listWorktrees(cwd);
      const windowPaths = currentWindowPaths();
      this.decorations?.update(entries, windowPaths);

      entries.sort(
        (a, b) =>
          this.rank(a, windowPaths) - this.rank(b, windowPaths) ||
          (b.commit?.timestamp ?? 0) - (a.commit?.timestamp ?? 0),
      );

      const repo = entries[0]?.repo?.name;
      this.setHeader(repo, entries.length);

      return entries.map((e) => new WorktreeItem(e, undefined, windowPaths.has(norm(e.path))));
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      const detail = (e.stderr && e.stderr.trim()) || e.message || 'wt list failed';
      this.setHeader(undefined, 0);
      return [new WorktreeItem(undefined, detail.split('\n')[0])];
    }
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new WorktreeProvider();
  const decorations = new WorktreeDecorations();
  const view = vscode.window.createTreeView('worktrunkWorktrees', {
    treeDataProvider: provider,
    showCollapseAll: false,
  });
  provider.view = view;
  provider.decorations = decorations;
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(decorations));

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
      const result = await createOrSwitchWorktree(name, cwd);
      if (result === 'failed') {
        return;
      }
      provider.refresh();
      if (result === 'switched') {
        vscode.window.setStatusBarMessage(`Branch “${name}” already existed — opened it`, 4000);
      }
      if (vscode.workspace.getConfiguration('worktrunk').get<boolean>('openAfterCreate')) {
        try {
          const target = (await listWorktrees(cwd)).find((e) => e.branch === name);
          if (target) {
            void vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target.path), {
              forceNewWindow: true,
            });
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
