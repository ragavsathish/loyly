import { runBuilder } from "../builder-adapter.mjs";

await runBuilder(JSON.parse(process.argv[2]));
