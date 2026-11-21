#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
  checkReassessment,
  type ReassessmentContract,
} from "./reassessment.ts";

const file = process.argv[2];
if (!file || process.argv.length !== 3) {
  console.error("usage: node reassessment-cli.ts <pinned-contract.json>");
  process.exit(2);
}
const contract = JSON.parse(readFileSync(file, "utf8")) as ReassessmentContract;
console.log(JSON.stringify(checkReassessment(contract), null, 2));
