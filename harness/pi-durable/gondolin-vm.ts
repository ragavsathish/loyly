// Minimal @earendil-works/gondolin + @earendil-works/pi-env VM daemon shim.
// Policy defaults (mounts, user, allowed hosts, resources) are passed by
// loyly.node.builder-host via environment / CLI; this file wraps ONLY the
// Gondolin VM + packagedDaemon SDK boundary.
import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  createHttpHooks,
  type HttpHooks,
  RealFSProvider,
  ReadonlyProvider,
  VM,
} from '@earendil-works/gondolin';
import { packagedDaemon } from '@earendil-works/pi-env';

const GUEST_DAEMON = '/opt/pi-env/pi-env';
const GUEST_WORKSPACE = process.env.LOYLY_GUEST_WORKSPACE || '/workspace';
const GUEST_USER = process.env.LOYLY_GUEST_USER || 'root';

const [roomArg, ...daemonArgs] = process.argv.slice(2);
if (!roomArg || daemonArgs[0] !== 'serve') {
  process.stderr.write('usage: gondolin-vm.ts <room> serve --token <hex>\n');
  process.exit(2);
}
const room = resolve(roomArg);
const readonlyInputs = process.env.LOYLY_ROOM_READONLY_INPUTS === '1';

const allowedList: string[] = process.env.LOYLY_ALLOWED_HOSTS
  ? (JSON.parse(process.env.LOYLY_ALLOWED_HOSTS) as string[])
  : [];
const allowed = new Set(allowedList.map((host) => host.toLowerCase()));
const httpHooks: HttpHooks =
  allowed.size === 0
    ? { isRequestAllowed: () => false, isIpAllowed: () => false }
    : createHttpHooks({
        allowedHosts: [...allowed],
        isRequestAllowed: (request) => allowed.has(new URL(request.url).hostname.toLowerCase()),
      }).httpHooks;

const vmMemory = process.env.LOYLY_VM_MEMORY?.trim() || '16G';
const vmCpus = process.env.LOYLY_VM_CPUS?.trim() || '10';
if (!/^[1-9]\d*[KMGT]?$/i.test(vmMemory)) {
  process.stderr.write(`gondolin-vm: invalid LOYLY_VM_MEMORY=${vmMemory}\n`);
  process.exit(2);
}
if (!/^[1-9]\d*$/.test(vmCpus)) {
  process.stderr.write(`gondolin-vm: invalid LOYLY_VM_CPUS=${vmCpus}\n`);
  process.exit(2);
}

const vm = await VM.create({
  httpHooks,
  sessionLabel: `loyly-builder ${basename(room)}`,
  vfs: {
    mounts: {
      [GUEST_WORKSPACE]: new RealFSProvider(room),
      ...(readonlyInputs
        ? {
            [`${GUEST_WORKSPACE}/impl`]: new ReadonlyProvider(
              new RealFSProvider(join(room, 'impl')),
            ),
            [`${GUEST_WORKSPACE}/plan`]: new ReadonlyProvider(
              new RealFSProvider(join(room, 'plan')),
            ),
          }
        : {}),
    },
  },
  memory: vmMemory,
  cpus: Number(vmCpus),
});

let closing: Promise<void> | undefined;
const close = (code: number) => {
  closing ??= vm.close().finally(() => process.exit(code));
};
process.once('SIGTERM', () => close(143));
process.once('SIGINT', () => close(130));

try {
  const user = (await vm.exec(['/usr/bin/id', '-un'])).stdout.trim();
  if (user !== GUEST_USER) throw new Error(`the VM runs as ${user || '?'}, not ${GUEST_USER}`);
  const arch = (await vm.exec(['/bin/uname', '-m'])).stdout.trim();
  const daemon = packagedDaemon({ platform: 'linux', arch: arch === 'aarch64' ? 'arm64' : 'x64' });
  await vm.fs.mkdir('/opt/pi-env', { recursive: true });
  await vm.fs.writeFile(GUEST_DAEMON, readFileSync(daemon));
  const chmod = await vm.exec(['/bin/chmod', '755', GUEST_DAEMON]);
  if (chmod.exitCode !== 0) throw new Error(`chmod pi-env: ${chmod.stderr.trim()}`);
  const proc = vm.exec([GUEST_DAEMON, ...daemonArgs], {
    stdin: process.stdin,
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: GUEST_WORKSPACE,
  });
  proc.stdout?.pipe(process.stdout);
  proc.stderr?.pipe(process.stderr);
  const result = await proc.result;
  close(result.exitCode);
} catch (error) {
  process.stderr.write(`gondolin-vm: ${error instanceof Error ? error.message : String(error)}\n`);
  close(1);
}
