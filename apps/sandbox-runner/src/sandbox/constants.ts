export const CONTAINER_IMAGE = 'node:20-slim';
export const CONTAINER_NAME_PREFIX = 'coforge-sandbox-';
export const CONTAINER_MEMORY = 512 * 1024 * 1024; // 512mb
export const CONTAINER_CPUS = 1;
export const CONTAINER_PIDS_LIMIT = 128;
export const WORKSPACE_DIR = '/workspace';
export const SANDBOX_NETWORK_NAME = 'coforge-sandbox-net';

export const SETUP_PACKAGES = 'git python3 make g++ curl ca-certificates';

export const DEFAULT_MAX_CONTAINERS = 10;
export const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
export const SWEEPER_INTERVAL_MS = 60_000;

export const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.next',
  'build',
  '.cache',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
]);

// Common dev-server ports published to random host ports at container
// creation. Docker Desktop hosts cannot reach bridge-network container IPs,
// so published ports are the only way the browser can reach a sandboxed
// dev server. Add a port here (and restart sandbox-runner) to support it.
export const PREVIEW_PORTS = [
  3000, 3001, 5173, 8080, 8000, 5000, 4000, 4173, 9000, 8008,
];
