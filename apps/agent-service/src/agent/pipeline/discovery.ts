// Deterministic project discovery from the known file set (the shared Y.Doc).
// This mirrors how opencode gathers project context: before the model does any
// work it is told which framework/routing/package-manager conventions the
// project actually uses, so it never has to guess where files go or which
// commands to run.

interface Manifest {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  packageManager?: string;
}

function readManifest(
  files: Record<string, string>,
  path: string,
): Manifest | null {
  const raw = files[path];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as Manifest;
  } catch {
    // Not JSON — ignore.
  }
  return null;
}

function findIn(
  files: Record<string, string>,
  name: string,
): string | undefined {
  return Object.keys(files).find((p) => p === name || p.endsWith(`/${name}`));
}

// Returns a compact, human-readable block describing the project's detected
// conventions, or null when nothing can be determined. Injected into the
// planner and coder system prompts before any work starts.
export function discoverProject(files: Record<string, string>): string | null {
  const parts: string[] = [];

  const pkgPath = findIn(files, "package.json");
  const manifest = pkgPath ? readManifest(files, pkgPath) : null;
  const projectDir =
    pkgPath && pkgPath !== "package.json"
      ? pkgPath.slice(0, -"/package.json".length)
      : "/";
  const deps = {
    ...(manifest?.dependencies ?? {}),
    ...(manifest?.devDependencies ?? {}),
  };
  const allDeps = Object.keys(deps).join(" ");

  // --- Package manager ---
  let pm = "npm";
  if (findIn(files, "pnpm-lock.yaml")) pm = "pnpm";
  else if (findIn(files, "yarn.lock")) pm = "yarn";
  else if (manifest?.packageManager?.startsWith("pnpm@")) pm = "pnpm";
  else if (manifest?.packageManager?.startsWith("yarn@")) pm = "yarn";
  if (findIn(files, "pnpm-workspace.yaml")) pm = "pnpm";
  parts.push(
    `Package manager: ${pm}${projectDir !== "/" ? ` (project root: ${projectDir})` : ""}`,
  );

  // --- Framework + routing conventions (the case that breaks most often) ---
  const hasAppDir = Object.keys(files).some(
    (p) =>
      p === "app/layout.tsx" ||
      p === "app/page.tsx" ||
      /^app\/.+\/page\.(tsx|ts|js|jsx)$/.test(p) ||
      p === "src/app/layout.tsx" ||
      p === "src/app/page.tsx" ||
      /^src\/app\/.+\/page\.(tsx|ts|js|jsx)$/.test(p),
  );
  const hasPagesDir = Object.keys(files).some(
    (p) =>
      /^pages\/.+\.(tsx|ts|js|jsx)$/.test(p) ||
      /^src\/pages\/.+\.(tsx|ts|js|jsx)$/.test(p),
  );

  if (allDeps.includes("next")) {
    if (hasAppDir) {
      parts.push(
        "Framework: Next.js (App Router). Routes live as `app/<segment>/page.tsx` files (e.g. `app/login/page.tsx`). " +
          "This project uses the App Router — do NOT create a `pages/` directory or `pages/<name>.tsx` files.",
      );
    } else if (hasPagesDir) {
      parts.push(
        "Framework: Next.js (Pages Router). Routes live as `pages/<name>.tsx` files (e.g. `pages/login.tsx`).",
      );
    } else {
      parts.push(
        "Framework: Next.js. Routes are either `app/<segment>/page.tsx` (App Router) or `pages/<name>.tsx` (Pages Router) — inspect the existing structure with list_files before choosing.",
      );
    }
  } else if (allDeps.includes("react")) {
    parts.push(
      "Framework: React. Components live under `src/components` (or `components`); pages under `src/pages` (or `app`).",
    );
  } else if (allDeps.includes("vue")) {
    parts.push(
      "Framework: Vue. Components live under `src/components`, pages under `src/pages` or `src/views`.",
    );
  } else if (allDeps.includes("@nestjs/core") || allDeps.includes("nest")) {
    parts.push(
      "Framework: NestJS. Modules live under `src`, each module is a directory with `<name>.module.ts`, `<name>.controller.ts`, `<name>.service.ts`.",
    );
  } else if (
    findIn(files, "pyproject.toml") ||
    findIn(files, "requirements.txt") ||
    findIn(files, "setup.py")
  ) {
    parts.push(
      "Framework: Python. Install deps with `pip install -r requirements.txt` (or `pip install -e .` for pyproject.toml/setup.py).",
    );
  } else if (findIn(files, "go.mod")) {
    parts.push(
      "Framework: Go. Deps fetched via `go mod download`; no package manager needed.",
    );
  } else if (findIn(files, "Cargo.toml")) {
    parts.push(
      "Framework: Rust. Deps fetched via `cargo build`; no package manager needed.",
    );
  }

  // --- Scripts the model will need ---
  const scripts = manifest?.scripts;
  if (scripts && Object.keys(scripts).length > 0) {
    const known = [
      "dev",
      "build",
      "test",
      "lint",
      "start",
      "typecheck",
      "check",
    ];
    const lines = known
      .filter((s) => scripts[s])
      .map((s) => `${s}: ${scripts[s]}`)
      .join("; ");
    if (lines) parts.push(`Scripts (from package.json): ${lines}`);
  }

  if (parts.length === 0) return null;
  return `Project discovery:\n${parts.map((p) => `- ${p}`).join("\n")}`;
}
