import { test } from "node:test";
import assert from "node:assert/strict";
import {
	isModelAllowed,
	modelRef,
	normalizeModelRefs,
	parseModelRef,
	pickEffectiveDefault,
} from "../../../src/application/model-access.ts";

test("model access: parses at the first slash and preserves model subpaths", () => {
	assert.deepEqual(parseModelRef("openrouter/openai/gpt-paid"), {
		provider: "openrouter",
		model: "openai/gpt-paid",
	});
	assert.equal(modelRef({ provider: "webagent", model: "deepseek.web" }), "webagent/deepseek.web");
});

test("model access: restricted policy never falls through to a disallowed host default", () => {
	const policy = {
		restricted: true,
		allowedModels: ["webagent/qwen.text.web.3.7-plus"],
		defaultModel: "",
	};
	assert.equal(isModelAllowed(policy, "webagent/deepseek.web"), false);
	assert.deepEqual(
		pickEffectiveDefault(policy, { provider: "paid", model: "expensive" }),
		{ provider: "webagent", model: "qwen.text.web.3.7-plus" },
	);
});

test("model access: configured default wins and refs are normalized", () => {
	const policy = {
		restricted: true,
		allowedModels: ["p/free", "p/backup"],
		defaultModel: "p/backup",
	};
	assert.deepEqual(pickEffectiveDefault(policy, { provider: "p", model: "free" }), {
		provider: "p",
		model: "backup",
	});
	assert.deepEqual(normalizeModelRefs([" p/free ", "p/free", "bad"]), ["p/free"]);
});
