import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const serverPort = process.env.PORT || '3000';

const children = [
  spawn(npm, ['run', 'dev:server'], {
    env: { ...process.env, PORT: serverPort },
    stdio: 'inherit'
  }),
  spawn(npm, ['run', 'dev:client'], {
    env: {
      ...process.env,
      VITE_API_PROXY_TARGET: `http://127.0.0.1:${serverPort}`
    },
    stdio: 'inherit'
  })
];

const stop = (code = 0) => {
  for (const child of children) child.kill('SIGTERM');
  process.exit(code);
};

for (const child of children) {
  child.on('exit', (code) => stop(code ?? 0));
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
