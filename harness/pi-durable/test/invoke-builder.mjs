import { runBuilder } from "../builder-adapter.ts";

await runBuilder(JSON.parse(process.argv[2]));
