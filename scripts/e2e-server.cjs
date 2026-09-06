const { existsSync, mkdirSync, rmSync } = require('node:fs');
const { spawn } = require('node:child_process');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const isWindows = process.platform === 'win32';
const dbPath = path.join(repoRoot, 'packages', 'e2e', 'test-results', 'agentboard-e2e.db');
const agentboardHome = path.join(repoRoot, 'packages', 'e2e', 'test-results', 'agentboard-home');
const dshHome = path.join(repoRoot, 'packages', 'e2e', 'test-results', 'mock-dsh-home');
const dshState = path.join(repoRoot, 'packages', 'e2e', 'test-results', 'mock-dsh-state');
const dshLauncher = path.join(repoRoot, 'scripts', 'e2e-local-openai-launcher.cjs');
function portFromEnv(name, fallback) {
  const value = process.env[name] || fallback;
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a numeric port`);
  }
  return value;
}
const serverPort = portFromEnv('E2E_SERVER_PORT', '3002');
const clientPort = portFromEnv('E2E_CLIENT_PORT', '4176');
const allowedRepoRoots = [
  repoRoot,
  process.env.TEMP,
  process.env.TMP,
  process.env.TMPDIR,
].filter(Boolean).join(',');

mkdirSync(path.dirname(dbPath), { recursive: true });
rmSync(dbPath, { force: true });
rmSync(agentboardHome, { recursive: true, force: true });
rmSync(dshHome, { recursive: true, force: true });
rmSync(dshState, { recursive: true, force: true });
mkdirSync(agentboardHome, { recursive: true });
mkdirSync(dshHome, { recursive: true });
mkdirSync(dshState, { recursive: true });

const builtServer = path.join(repoRoot, 'packages', 'server', 'dist', 'index.js');
const useBuiltServer = existsSync(builtServer);
const command = useBuiltServer ? 'node' : (isWindows ? 'npx tsx src/index.ts' : 'npx');
const args = useBuiltServer ? [builtServer] : (isWindows ? [] : ['tsx', 'src/index.ts']);

const child = spawn(command, args, {
  cwd: path.join(repoRoot, 'packages', 'server'),
  env: {
    ...process.env,
    PORT: serverPort,
    DATABASE_URL: '',
    DB_PATH: dbPath,
    API_KEY: '',
    ALLOWED_ORIGINS: `http://localhost:${clientPort}`,
    ALLOWED_REPO_ROOTS: allowedRepoRoots,
    AGENTBOARD_HOME: agentboardHome,
    DSH_LAUNCHER_PATH: dshLauncher,
    DSH_HOME: dshHome,
    DSH_PROFILE: 'e2e-mock',
    LOCAL_OPENAI_DISPLAY_NAME: 'Mock Local AI',
    LOCAL_OPENAI_MODEL: 'E2E Mock',
    AGENTBOARD_E2E_MOCK_LOCAL_OPENAI: '1',
    AGENTBOARD_E2E_MOCK_STATE_DIR: dshState,
    // E2E never runs real agents; skip booting agent SDK clients so an
    // unauthenticated environment can't crash the server on startup.
    AGENTBOARD_DISABLE_AGENT_STARTUP: '1',
  },
  shell: isWindows,
  stdio: 'inherit',
});

const forwardSignal = (signal) => {
  if (!child.killed) {
    child.kill(signal);
  }
};

process.on('SIGINT', () => forwardSignal('SIGINT'));
process.on('SIGTERM', () => forwardSignal('SIGTERM'));

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
