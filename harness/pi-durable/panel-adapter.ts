// A panel VM run has no external product effect: each attempt reads the frozen
// candidate and writes only its private scratch directory. A controller crash
// may leave one partial attempt; the next bounded attempt can safely run.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runPanelVms, verifyPanelVmRun } from './panel-vm-run.mjs';
import { compilePanel, verifyCompiledPanel } from './panel-compile.mjs';

const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const fileSha = (path: string) => sha(readFileSync(path));

interface SelectPanelAttemptArgs<T> {
  root: string;
  launch: (out: string) => Promise<T | null | undefined> | T | null | undefined;
  verify: (out: string) => T;
  maxAttempts?: number;
  manifestName?: string;
}

interface PanelAttemptResult {
  attempt: number;
  reconciled: boolean;
  [key: string]: unknown;
}

interface RunDurablePanelArgs {
  scratch: string;
  image: string;
  planFile?: string | URL;
  approvedPlanSha256: string;
  approvedImageSha256: string;
}

interface RunDurablePanelReportArgs {
  scratch: string;
  specialists: string;
  planFile: string;
}

async function selectPanelAttempt<T extends object>({
  root,
  launch,
  verify,
  maxAttempts = 2,
  manifestName = 'manifest.json',
}: SelectPanelAttemptArgs<T>): Promise<T & PanelAttemptResult> {
  root = resolve(root);
  mkdirSync(root, { recursive: true });
  const selectedFile = join(root, 'selected.json');
  if (existsSync(selectedFile)) {
    const selected = JSON.parse(readFileSync(selectedFile, 'utf8')) as {
      attempt: number;
      manifest_sha256: string;
    };
    const out = join(root, `attempt-${String(selected.attempt).padStart(2, '0')}`);
    const result = verify(out);
    if (selected.manifest_sha256 !== fileSha(join(out, manifestName)))
      throw new Error('selected panel manifest changed');
    return { ...result, attempt: selected.attempt, reconciled: true };
  }
  const failures: string[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const out = join(root, `attempt-${String(attempt).padStart(2, '0')}`);
    try {
      const hadManifest = existsSync(join(out, manifestName));
      const result = hadManifest ? verify(out) : existsSync(out) ? null : await launch(out);
      if (!result) {
        failures.push(`attempt ${attempt} was interrupted without a complete receipt`);
        continue;
      }
      const checked = verify(out);
      const selected = {
        schema: 'loyly.panel-selection.v1',
        attempt,
        manifest_sha256: fileSha(join(out, manifestName)),
      };
      writeFileSync(`${selectedFile}.partial`, `${JSON.stringify(selected)}\n`);
      renameSync(`${selectedFile}.partial`, selectedFile);
      return { ...checked, attempt, reconciled: hadManifest };
    } catch (error: unknown) {
      failures.push(`attempt ${attempt}: ${String(error)}`);
      if (existsSync(out))
        writeFileSync(
          join(out, 'controller-error.txt'),
          `${String(error instanceof Error ? (error.stack ?? error) : error)}\n`,
        );
    }
  }
  throw new Error(`panel VM attempts exhausted: ${failures.join('; ')}`);
}

async function runDurablePanel({
  scratch,
  image,
  planFile,
  approvedPlanSha256,
  approvedImageSha256,
}: RunDurablePanelArgs) {
  scratch = resolve(scratch);
  image = resolve(image);
  const here = new URL('.', import.meta.url);
  planFile ??= new URL('booking-core.panel.json', here);
  if (
    !/^[0-9a-f]{64}$/.test(approvedPlanSha256 ?? '') ||
    !/^[0-9a-f]{64}$/.test(approvedImageSha256 ?? '') ||
    sha(readFileSync(planFile)) !== approvedPlanSha256 ||
    fileSha(join(image, 'manifest.json')) !== approvedImageSha256
  )
    throw new Error('panel plan or Gondolin image differs from approved digest');
  return selectPanelAttempt({
    root: join(scratch, 'panel-vm'),
    launch: (out) => runPanelVms({ original: scratch, image, out, planFile }),
    verify: (out) =>
      verifyPanelVmRun({
        original: scratch,
        out,
        imageDigest: `sha256:${approvedImageSha256}`,
        planFile,
      }),
  });
}

async function runDurablePanelReport({
  scratch,
  specialists,
  planFile,
}: RunDurablePanelReportArgs) {
  scratch = resolve(scratch);
  specialists = resolve(specialists);
  return selectPanelAttempt({
    root: join(scratch, 'panel-report'),
    manifestName: 'panel-manifest.json',
    launch: (out) => compilePanel({ original: scratch, specialists, out, planFile }),
    verify: (out) => verifyCompiledPanel({ original: scratch, out, planFile }),
  });
}

export type {
  SelectPanelAttemptArgs,
  PanelAttemptResult,
  RunDurablePanelArgs,
  RunDurablePanelReportArgs,
};
export { selectPanelAttempt, runDurablePanel, runDurablePanelReport };
