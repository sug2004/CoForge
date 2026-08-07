export const CONTAINER_IMAGE = 'node:20-slim';
export const CONTAINER_NAME_PREFIX = 'coforge-sandbox-';
export const CONTAINER_MEMORY = 512 * 1024 * 1024; // 512mb
export const CONTAINER_CPUS = 1;
export const CONTAINER_PIDS_LIMIT = 128;
export const WORKSPACE_DIR = '/workspace';

export const DEFAULT_RUN_COMMAND_TIMEOUT_MS = 300_000; // 5 min (npm install etc.)
export const DEFAULT_RUN_TESTS_TIMEOUT_MS = 120_000;

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

export const MAX_FILE_BYTES = 1024 * 1024; // 1mb
