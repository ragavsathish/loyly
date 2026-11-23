import type { ValidatedRun } from './live-contract.ts';
import { DEFAULT_PANEL_PLAN } from './project/loyly/index.ts';

// The worker receives only this approved set of LOYLY_* values.
export function workerEnvironment(
  { config, source }: ValidatedRun,
  inheritedEnvironment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    Object.entries(inheritedEnvironment).filter(
      ([name]) => !name.startsWith('LOYLY_') && name !== 'HARNESS_PROJECT_ID',
    ),
  );
  return {
    ...inherited,
    PATH: inheritedEnvironment.JAVA_HOME
      ? `${inheritedEnvironment.JAVA_HOME}/bin:${inheritedEnvironment.PATH}`
      : inheritedEnvironment.PATH,
    LOYLY_RUN_ID: config.run_id,
    ...(config.project ? { HARNESS_PROJECT_ID: config.project } : {}),
    LOYLY_SCORE_CYCLE: config.score_cycle ?? '02',
    LOYLY_SOURCE_REPO: source,
    LOYLY_APPROVED_COMMIT: config.source.commit,
    LOYLY_APPROVED_CHECKLIST_SHA256: config.source.checklist_sha256,
    LOYLY_BUILDER_COMMAND: config.builder.command,
    LOYLY_BUILDER_COMMAND_SHA256: config.builder.command_sha256,
    LOYLY_BUILDER_IMAGE: config.builder.image,
    LOYLY_BUILDER_IMAGE_SHA256: config.builder.image_sha256,
    LOYLY_BUILDER_MODEL: config.builder.model,
    LOYLY_BUILDER_INSTRUCTION_SHA256: config.builder.instruction_sha256,
    LOYLY_BUILDER_INSTRUCTION_FILE: config.builder.instruction_file ?? 'builder-instruction.md',
    LOYLY_GRADER_COMMAND: config.grader.command,
    LOYLY_GRADER_COMMAND_SHA256: config.grader.command_sha256,
    LOYLY_GRADER_IMAGE: config.grader.image,
    LOYLY_GRADER_IMAGE_SHA256: config.grader.image_sha256,
    LOYLY_GRADER_MODEL: config.grader.model,
    LOYLY_GRADER_SETTINGS: config.grader.settings,
    LOYLY_GRADER_SETTINGS_SHA256: config.grader.settings_sha256,
    LOYLY_GRADER_INSTRUCTION_SHA256: config.grader.instruction_sha256,
    LOYLY_GRADER_INSTRUCTION_FILE: config.grader.instruction_file ?? 'grader-instruction-01.md',
    LOYLY_GRADER_SCHEMA_SHA256: config.grader.schema_sha256,
    LOYLY_GRADER_SHARDS: String(config.grader.shards),
    LOYLY_BLIND_REQUIRED: config.schema === 'loyly.pi-live-run.v1' || config.blind ? '1' : '0',
    ...(config.blind
      ? {
          LOYLY_BLIND_AGENT_COMMAND: config.blind.command,
          LOYLY_BLIND_AGENT_COMMAND_SHA256: config.blind.command_sha256,
          LOYLY_BLIND_AGENT_IMAGE: config.blind.image,
          LOYLY_BLIND_AGENT_IMAGE_SHA256: config.blind.image_sha256,
          LOYLY_BLIND_AGENT_MODEL: config.blind.model,
          LOYLY_BLIND_AGENT_SETTINGS: config.blind.settings,
          LOYLY_BLIND_AGENT_SETTINGS_SHA256: config.blind.settings_sha256,
          LOYLY_BLIND_AGENT_INSTRUCTION_SHA256: config.blind.instruction_sha256,
          LOYLY_BLIND_AGENT_INSTRUCTION_FILE:
            config.blind.instruction_file ?? 'blind-agent-instruction.md',
        }
      : {}),
    LOYLY_PANEL_REQUIRED: config.schema === 'loyly.pi-live-run.v1' ? '1' : '0',
    ...(config.panel
      ? {
          LOYLY_PANEL_IMAGE: config.panel.image,
          LOYLY_PANEL_IMAGE_SHA256: config.panel.image_sha256,
          LOYLY_PANEL_PLAN_SHA256: config.panel.plan_sha256,
          LOYLY_PANEL_PLAN_FILE: config.panel.plan_file ?? DEFAULT_PANEL_PLAN,
        }
      : {}),
  };
}
