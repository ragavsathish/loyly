#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
  checkCandidateCaches,
  checkContract,
  checkEvidence,
  decideAttempt,
  type CycleContract,
  type EvidenceFiles,
} from "./adapter.ts";
import type {
  BuildResult,
  GateResult,
  TaskOutcome,
} from "../cycle-core/types.ts";

const [action, inputFile] = process.argv.slice(2);
if (
  !action ||
  !inputFile ||
  !["preflight", "candidate", "decide", "evidence"].includes(action)
) {
  console.error(
    "usage: node cli.ts preflight|candidate|decide|evidence <input.json>",
  );
  process.exit(2);
}
const input: unknown = JSON.parse(readFileSync(inputFile, "utf8"));
let report: unknown;
if (action === "preflight") report = checkContract(input as CycleContract);
else if (action === "candidate") {
  const candidate = input as { room: string; mode?: "sealed" | "post-gate" };
  report = checkCandidateCaches(candidate.room, candidate.mode);
} else if (action === "evidence")
  report = checkEvidence(input as EvidenceFiles);
else {
  const decision = input as {
    attempt: number;
    build: TaskOutcome<BuildResult>;
    gate?: TaskOutcome<GateResult>;
  };
  report = decideAttempt(decision.attempt, decision.build, decision.gate);
}
console.log(JSON.stringify(report, null, 2));
