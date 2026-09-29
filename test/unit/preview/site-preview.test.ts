import { test } from "node:test";
import assert from "node:assert/strict";
import {
	decidePreviewAction,
	normalizePreviewTarget,
} from "../../../src/preview/site-preview-core.ts";
import { sitePreviewCard } from "../../../src/presentation/cards.ts";

test("preview: target normalization", () => {
	const url = normalizePreviewTarget({ url: "http://127.0.0.1:5173/preview/" });
	assert.equal(url.kind, "url");
	assert.equal(url.localUrl, "http://127.0.0.1:5173");
	assert.equal(url.pathSuffix, "/preview/");
	const port = normalizePreviewTarget({ port: 8099 });
	assert.equal(port.target, "port:8099");
	assert.throws(() => normalizePreviewTarget({ port: 8099, url: "http://x" }));
	assert.throws(() => normalizePreviewTarget({}));
});

test("preview: lifecycle decision", () => {
	const now = 1_000_000;
	const entry = { target: "port:5173", expiresAt: now + 60_000 };
	assert.equal(decidePreviewAction(undefined, "port:5173", true, now), "create");
	assert.equal(decidePreviewAction(entry, "port:5173", true, now), "reuse");
	assert.equal(decidePreviewAction(entry, "port:5173", false, now), "restart");
	assert.equal(decidePreviewAction(entry, "port:9999", true, now), "replace");
	const expired = { target: "port:5173", expiresAt: now - 1 };
	assert.equal(decidePreviewAction(expired, "port:5173", true, now), "restart");
});

test("preview: card carries open_url + refresh/stop callbacks", () => {
	const card = sitePreviewCard({
		title: "我的世界 · 网页版",
		publicUrl: "https://abc.trycloudflare.com",
		debugUrl: "https://abc.trycloudflare.com/?debug=1",
		origin: "port:5173",
		label: "开发服务器 :5173",
		action: "新建",
		expiresAt: Date.now() + 3_600_000,
	}) as {
		header: { title: { content: string } };
		body: { elements: Array<Record<string, unknown>> };
	};
	assert.match(card.header.title.content, /我的世界/);
	const buttons = card.body.elements.filter((element) => element.tag === "button");
	const behaviors = buttons.map(
		(b) => (b.behaviors as Array<Record<string, unknown>>)[0]!,
	);
	assert.ok(behaviors.some((b) => b.type === "open_url"));
	const ops = buttons
		.filter((b) => (b.behaviors as Array<Record<string, unknown>>)[0]!.type === "callback")
		.map(
			(b) =>
				((b.behaviors as Array<{ value: { op: string } }>)[0]!).value.op,
		);
	assert.deepEqual(ops, ["site:refresh", "site:stop"]);
	const markdown = card.body.elements
		.filter((element) => element.tag === "markdown")
		.map((element) => String(element.content))
		.join("\n");
	assert.match(markdown, /trycloudflare\.com/);
});
