import { detectTestCommand } from './project';

// Builds a compact, deterministic description of the workspace from the known
// file set (the shared Y.Doc), so the planner and coder never have to guess the
// project layout. The agent's terminal starts in /workspace; if the project
// lives in a subdirectory (e.g. /workspace/app) the summary says so explicitly.
//
// Note: this reflects the files tracked in the session. The sandbox may also
// contain generated files (node_modules, build output) that the tools can
// inspect at runtime — `list_files` with recursive:true covers that.

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.next',
  'coverage',
  '.cache',
  '__pycache__',
  '.svn',
  '.hg',
]);

// Manifest / config files that reveal the project type.
const MANIFESTS = new Set([
  'package.json',
  'pnpm-workspace.yaml',
  'yarn.lock',
  'package-lock.json',
  'pnpm-lock.yaml',
  'tsconfig.json',
  'next.config.js',
  'next.config.ts',
  'next.config.mjs',
  'vite.config.js',
  'vite.config.ts',
  'webpack.config.js',
  'eslint.config.mjs',
  'docker-compose.yml',
  'Dockerfile',
  'pyproject.toml',
  'requirements.txt',
  'setup.py',
  'go.mod',
  'Cargo.toml',
  'composer.json',
  'Gemfile',
  'README.md',
]);

const TREE_LINE_CAP = 150;
const TREE_DEPTH_CAP = 4;

interface TreeNode {
  name: string;
  isDir: boolean;
  children: Map<string, TreeNode>;
}

export function describeWorkspace(files: Record<string, string>): string {
  const paths = Object.keys(files);
  const manifestPaths: string[] = [];
  for (const p of paths) {
    const base = p.split('/').pop() ?? p;
    if (MANIFESTS.has(base)) manifestPaths.push(p);
  }
  manifestPaths.sort();

  const treeLines = renderTree(buildTree(paths), TREE_LINE_CAP, TREE_DEPTH_CAP);
  const tree = treeLines.join('\n');
  const root = projectRoot(files);
  const testCommand = detectTestCommand(files);

  const parts: string[] = [];
  parts.push(`Workspace layout (${paths.length} files):`);
  parts.push(treeLines.length > 0 ? tree : '(empty workspace — no files yet)');

  if (manifestPaths.length > 0) {
    const shown = manifestPaths.slice(0, 10).join(', ');
    const extra = manifestPaths.length > 10 ? `, … (${manifestPaths.length - 10} more)` : '';
    const rootLabel = root ? `/workspace/${root}` : '/workspace';
    parts.push('');
    parts.push(`Detected project root: ${rootLabel}`);
    parts.push(`Manifests found: ${shown}${extra}`);
    parts.push(
      `Your terminal starts in /workspace — "cd" into the project root before running build/test/run commands.`,
    );
  }

  if (testCommand) parts.push(`Test/build command: ${testCommand}`);

  return parts.join('\n');
}

// Directory containing the project manifest (package.json preferred), or '' if
// the manifest is at the workspace root.
function projectRoot(files: Record<string, string>): string {
  const pkgPaths = Object.keys(files).filter(
    (p) => p === 'package.json' || p.endsWith('/package.json'),
  );
  if (pkgPaths.length === 0) {
    for (const f of ['pyproject.toml', 'requirements.txt', 'go.mod', 'Cargo.toml']) {
      const hit = Object.keys(files).find((p) => p === f || p.endsWith(`/${f}`));
      if (hit && hit !== f) return hit.slice(0, hit.lastIndexOf('/'));
    }
    return '';
  }
  const chosen = pkgPaths.includes('package.json')
    ? 'package.json'
    : pkgPaths.sort((a, b) => a.length - b.length)[0];
  return chosen === 'package.json' ? '' : chosen.slice(0, chosen.lastIndexOf('/'));
}

function buildTree(paths: string[]): TreeNode {
  const root: TreeNode = { name: '', isDir: true, children: new Map() };
  for (const p of paths) {
    const dirMarker = p.endsWith('/');
    const trimmed = dirMarker ? p.slice(0, -1) : p;
    const parts = trimmed.split('/').filter(Boolean);
    if (parts.length === 0) continue;

    let node = root;
    let skipped = false;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const last = i === parts.length - 1;
      if (!last && SKIP_DIRS.has(part)) {
        skipped = true;
        break;
      }
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, isDir: !last || dirMarker, children: new Map() };
        node.children.set(part, child);
      }
      node = child;
    }
    if (skipped) continue;
  }
  return root;
}

function renderTree(root: TreeNode, maxLines: number, maxDepth: number): string[] {
  const lines: string[] = [];
  const walk = (node: TreeNode, depth: number) => {
    if (lines.length >= maxLines || depth > maxDepth) return;
    const children = [...node.children.entries()].sort(([a], [b]) => a.localeCompare(b));
    const dirs = children.filter(([, c]) => c.isDir);
    const files = children.filter(([, c]) => !c.isDir);
    const indent = '  '.repeat(depth);
    for (const [name, child] of [...dirs, ...files]) {
      if (lines.length >= maxLines) return;
      lines.push(`${indent}${child.isDir ? `${name}/` : name}`);
      if (child.isDir) walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return lines;
}
