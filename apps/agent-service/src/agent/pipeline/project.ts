// Project-level context gathering (the opencode-style bits): directives from
// AGENTS.md / CLAUDE.md / editor rules, and a compact manifest-derived summary
// (name, scripts, framework, README excerpt, verification commands). Both are
// derived purely from the known file set, so no extra HTTP round-trips.

// Heuristic test-command detection from the shared file set. Extend as needed.
// When the manifest lives in a subdirectory (e.g. app/package.json), the command
// is prefixed with a cd so it runs from the sandbox's /workspace root.
export function detectTestCommand(
  files: Record<string, string>,
): string | null {
  const pkgPaths = Object.keys(files)
    .filter((p) => p === "package.json" || p.endsWith("/package.json"))
    .sort((a, b) =>
      a === "package.json"
        ? -1
        : b === "package.json"
          ? 1
          : a.length - b.length,
    );
  for (const p of pkgPaths) {
    const pkg = files[p];
    if (!pkg) continue;
    try {
      const parsed = JSON.parse(pkg);
      const scripts: Record<string, string> = parsed?.scripts ?? {};
      const dir = p === "package.json" ? "" : p.slice(0, p.lastIndexOf("/"));
      const prefix = dir ? `cd ${dir} && ` : "";
      if (scripts.test) return `${prefix}npm test`;
      if (scripts.build) return `${prefix}npm run build`;
      return `${prefix}npm test`;
    } catch {
      // malformed package.json — try the next candidate
    }
  }

  const nonJs: Array<[string, string]> = [
    ["pyproject.toml", "pytest"],
    ["requirements.txt", "pytest"],
    ["setup.py", "pytest"],
    ["go.mod", "go test ./..."],
    ["Cargo.toml", "cargo test"],
  ];
  for (const [f, cmd] of nonJs) {
    const hit = Object.keys(files).find((p) => p === f || p.endsWith(`/${f}`));
    if (!hit) continue;
    const dir = hit === f ? "" : hit.slice(0, hit.lastIndexOf("/"));
    return dir ? `cd ${dir} && ${cmd}` : cmd;
  }
  return null;
}

const INSTRUCTION_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  ".cursorrules",
  ".windsurfrules",
];
const INSTRUCTION_CAP = 3000;
const README_EXCERPT_LINES = 20;

// Well-known framework → label, keyed by dependency name.
const FRAMEWORKS: Array<[string, string]> = [
  ["next", "Next.js"],
  ["react", "React"],
  ["vue", "Vue"],
  ["nuxt", "Nuxt"],
  ["svelte", "Svelte"],
  ["@angular/core", "Angular"],
  ["@remix-run/react", "Remix"],
  ["@nestjs/core", "NestJS"],
  ["express", "Express"],
  ["fastify", "Fastify"],
  ["astro", "Astro"],
  ["solid-js", "Solid"],
  ["gatsby", "Gatsby"],
  ["flask", "Flask"],
  ["django", "Django"],
  ["spring-boot-starter-web", "Spring Boot"],
  ["@docusaurus/core", "Docusaurus"],
];

export function extractInstructions(files: Record<string, string>): string {
  const parts: string[] = [];
  for (const f of INSTRUCTION_FILES) {
    const hit = Object.keys(files).find((p) => p === f || p.endsWith(`/${f}`));
    if (hit && files[hit]) {
      parts.push(`## ${hit}\n${files[hit]}`);
    }
  }
  if (parts.length === 0) return "";
  let joined = parts.join("\n\n");
  if (joined.length > INSTRUCTION_CAP) {
    joined = `${joined.slice(0, INSTRUCTION_CAP)}\n… (instructions truncated)`;
  }
  return joined;
}

export function summarizeProject(files: Record<string, string>): string {
  const parts: string[] = [];

  const pkgPaths = Object.keys(files).filter(
    (p) => p === "package.json" || p.endsWith("/package.json"),
  );
  for (const p of pkgPaths.sort((a, b) => a.length - b.length)) {
    const raw = files[p];
    if (!raw) continue;
    let pkg: any;
    try {
      pkg = JSON.parse(raw);
    } catch {
      continue;
    }
    const scripts: Record<string, string> = pkg?.scripts ?? {};
    const scriptNames = Object.keys(scripts);
    const deps: Record<string, string> = {
      ...(pkg?.dependencies ?? {}),
      ...(pkg?.devDependencies ?? {}),
    };
    const framework = FRAMEWORKS.find(([name]) => deps[name]);

    const lines = [`- ${p}${pkg?.name ? ` (${pkg.name})` : ""}`];
    if (scriptNames.length > 0) {
      lines.push(`  scripts: ${scriptNames.join(", ")}`);
    }
    if (framework) lines.push(`  framework: ${framework[1]}`);
    if (Object.keys(deps).length > 0) {
      lines.push(
        `  dependencies (${Object.keys(deps).length}): ${Object.keys(deps).slice(0, 12).join(", ")}${Object.keys(deps).length > 12 ? ", …" : ""}`,
      );
    }
    parts.push(lines.join("\n"));
  }

  const checks = detectVerificationCommands(files);
  if (checks.length > 0) {
    parts.push(`\nVerification commands: ${checks.join("; ")}`);
  }

  const readme = Object.keys(files).find(
    (p) => p === "README.md" || p.endsWith("/README.md"),
  );
  if (readme && files[readme]) {
    const excerpt = files[readme]
      .split("\n")
      .slice(0, README_EXCERPT_LINES)
      .join("\n");
    parts.push(`\nREADME (${readme}, first lines):\n${excerpt}`);
  }

  return parts.join("\n");
}

// Lint/typecheck commands present in any package.json scripts — the coder
// should run these (like opencode's lint+typecheck verification) in addition
// to the test/build command.
export function detectVerificationCommands(
  files: Record<string, string>,
): string[] {
  const commands: string[] = [];
  const seen = new Set<string>();
  for (const p of Object.keys(files)) {
    if (p !== "package.json" && !p.endsWith("/package.json")) continue;
    const raw = files[p];
    if (!raw) continue;
    let pkg: any;
    try {
      pkg = JSON.parse(raw);
    } catch {
      continue;
    }
    const scripts: Record<string, string> = pkg?.scripts ?? {};
    const dir = p === "package.json" ? "" : p.slice(0, p.lastIndexOf("/"));
    const prefix = dir ? `cd ${dir} && ` : "";
    const push = (cmd: string) => {
      const full = `${prefix}${cmd}`;
      if (!seen.has(full)) {
        seen.add(full);
        commands.push(full);
      }
    };
    if (scripts.lint) push("npm run lint");
    if (scripts.typecheck) push("npm run typecheck");
    if (scripts["type-check"]) push("npm run type-check");
    if (scripts["typecheck:ci"]) push("npm run typecheck:ci");
    if (scripts.check) push("npm run check");
    if (scripts["format:check"]) push("npm run format:check");
  }
  return commands;
}
