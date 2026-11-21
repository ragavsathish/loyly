// Supported CLI for a pinned product live cycle.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLiveRun } from './live-contract.ts';
import { workerEnvironment } from './launch-config.ts';
export { checkLiveRun, verifySelectedSpecs } from './live-contract.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || !['--check', '--run'].includes(process.argv[2]))
    throw Error('usage: node run-live.mjs --check|--run <pinned-config.json>');
  const validated = checkLiveRun(JSON.parse(readFileSync(process.argv[3], 'utf8')));
  const { scratch } = validated;
  console.log('pinned cycle contract verified');
  if (process.argv[2] === '--run') {
    const env = workerEnvironment(validated, process.env);
    const result = spawnSync(process.execPath, [join(HERE, 'worker.mjs'), scratch, 'live'],
      { cwd: HERE, env, stdio: 'inherit' });
    process.exitCode = result.status ?? 1;
  }
}
