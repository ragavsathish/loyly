import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { runBuilder } from "./host.ts";

test("repair attempt forks the settled Pi transcript and reopens without a second model call", async () => {
	const dir = mkdtempSync(join(tmpdir(), "loyly-pi-fork-"));
	try {
		const room = join(dir, "room"), store = join(dir, "session.sqlite");
		const instruction = join(dir, "instruction.md");
		const firstReceipt = join(dir, "first.json"), secondReceipt = join(dir, "second.json");
		mkdirSync(room);
		writeFileSync(instruction, "Build from this room.\n");
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("First build."), fauxAssistantMessage("Repair build.")]);
		const model = { provider: faux.provider.id, modelId: faux.getModel().id };
		const base = { room, instruction, store, models, model, tools: [] };
		const first = await runBuilder({ ...base, requestId: "attempt-1",
			conversationReceipt: firstReceipt });
		assert.equal(first.settled.status, "done");
		const parent = JSON.parse(readFileSync(firstReceipt, "utf8"));
		assert.ok(parent.lastEntryId > 0);
		const second = await runBuilder({ ...base, requestId: "attempt-2",
			conversationReceipt: secondReceipt, parentConversationReceipt: firstReceipt });
		assert.equal(second.settled.status, "done");
		const fork = JSON.parse(readFileSync(secondReceipt, "utf8"));
		assert.equal(fork.parentConversationId, parent.conversationId);
		assert.equal(fork.forkEntryId, parent.lastEntryId);
		assert.notEqual(fork.conversationId, parent.conversationId);
		const reopened = await runBuilder({ ...base, requestId: "attempt-2",
			conversationReceipt: secondReceipt, parentConversationReceipt: firstReceipt });
		assert.equal(reopened.settled.id, second.settled.id);
		assert.equal(faux.state.callCount, 2);
		writeFileSync(firstReceipt, JSON.stringify({ ...parent, lastEntryId: parent.lastEntryId - 1 }));
		await assert.rejects(() => runBuilder({ ...base, requestId: "attempt-2",
			conversationReceipt: secondReceipt, parentConversationReceipt: firstReceipt }),
			/Pi fork receipt differs/);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
