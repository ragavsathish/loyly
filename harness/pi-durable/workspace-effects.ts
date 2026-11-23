import { existsSync, readFileSync } from 'node:fs';
import { Context, Data, Effect, Layer } from 'effect';

export class WorkspaceReadError extends Data.TaggedError('WorkspaceReadError')<{
  readonly path: string;
  readonly reason: string;
}> {}

export class InvalidWorkspaceData extends Data.TaggedError('InvalidWorkspaceData')<{
  readonly path: string;
  readonly reason: string;
}> {}

export class WorkspaceFiles extends Context.Service<
  WorkspaceFiles,
  {
    readonly exists: (path: string) => Effect.Effect<boolean, WorkspaceReadError>;
    readonly readText: (path: string) => Effect.Effect<string, WorkspaceReadError>;
  }
>()('HarnessWorkspaceFiles') {}

export const WorkspaceFilesLive = Layer.succeed(WorkspaceFiles, {
  exists: (path) =>
    Effect.try({
      try: () => existsSync(path),
      catch: (cause) => new WorkspaceReadError({ path, reason: String(cause) }),
    }),
  readText: (path) =>
    Effect.try({
      try: () => readFileSync(path, 'utf8'),
      catch: (cause) => new WorkspaceReadError({ path, reason: String(cause) }),
    }),
});

export function parseWorkspaceJson(
  path: string,
  text: string,
): Effect.Effect<unknown, InvalidWorkspaceData> {
  return Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: (cause) => new InvalidWorkspaceData({ path, reason: String(cause) }),
  });
}

export function readWorkspaceJson(path: string) {
  return Effect.gen(function* () {
    const files = yield* WorkspaceFiles;
    return yield* parseWorkspaceJson(path, yield* files.readText(path));
  });
}
