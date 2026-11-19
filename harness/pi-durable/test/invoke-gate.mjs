import { runGate } from "../gate-adapter.mjs";

await runGate(JSON.parse(process.argv[2]));
