import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sanitize, TraceRecorder } from "../src/recorder.ts";

test("one task preserves multiple loops, parallel tools, nested tools and a recovered error", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-run-trace-record-"));
	try {
		const recorder = new TraceRecorder(directory);
		const run = recorder.begin("session-one", "/project", "修复登录");
		recorder.startTurn(0, "faux", "test");
		recorder.context([{ role: "user", content: "修复登录" }]);
		recorder.request({ apiKey: "must-not-persist", prompt: "test" });
		recorder.response(503);
		recorder.request({ prompt: "retry" });
		recorder.response(200);
		recorder.modelEnd({ content: [], stopReason: "toolUse" });
		recorder.toolStart("read-a", "read", { path: "a.ts" });
		recorder.toolStart("bash-a", "bash", { command: "check" });
		recorder.toolEnd("bash-a", { content: "failed" }, true, 12);
		recorder.toolEnd("read-a", { content: "source" }, false, 20);
		recorder.toolStart("parent", "codemode", {});
		recorder.toolStart("child", "read", { path: "b.ts" }, "parent");
		recorder.toolEnd("child", { content: "nested" }, false, 5);
		recorder.toolEnd("parent", { content: "done" }, false, 6);
		recorder.add("lifecycle", "agent_end");
		assert.equal(recorder.active?.id, run.id, "agent_end is not final settlement");
		recorder.startTurn(0, "faux", "test");
		recorder.modelEnd({ content: "已修复", stopReason: "stop" });
		recorder.finish();
		await recorder.flush();
		assert.equal(recorder.error, undefined);
		const saved = await recorder.read(run.id);
		assert.equal(saved?.status, "completed");
		assert.equal(saved?.spans.filter((span) => span.kind === "model").length, 2);
		assert.equal(saved?.spans.find((span) => span.id === "child")?.parentId, "parent");
		assert.equal(saved?.spans.find((span) => span.id === "bash-a")?.status, "error");
		assert.equal(saved?.spans.find((span) => span.id === "read-a")?.durationMs, 20);
		assert.equal(saved?.spans.filter((span) => span.kind === "model")[0].attempts?.length, 2);
		assert.ok(!JSON.stringify(saved).includes("must-not-persist"));
		assert.equal((await new TraceRecorder(directory).list()).length, 1);
		assert.equal(await recorder.read("../../private"), undefined);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("aborted task closes running spans and session change preserves the earlier task", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-run-trace-cancel-"));
	try {
		const recorder = new TraceRecorder(directory);
		const first = recorder.begin("one", "/project", "first");
		recorder.startTurn(0);
		recorder.toolStart("long", "bash", {});
		recorder.finish("aborted");
		const second = recorder.begin("two", "/project", "second");
		recorder.startTurn(0);
		recorder.begin("three", "/project", "third");
		await recorder.flush();
		assert.equal((await recorder.read(first.id))?.spans.find((span) => span.id === "long")?.status, "aborted");
		assert.equal((await recorder.read(second.id))?.status, "interrupted");
		assert.equal((await recorder.list()).length, 3);
		recorder.finish();
		await recorder.flush();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("recording bounds and credential redaction retain readable error text", () => {
	const data = sanitize({
		Authorization: "Bearer private",
		nested: { apiKey: "secret", access_token: "secret" },
		text: "Bearer abc.def.ghi failed",
		data: "x".repeat(2000),
	});
	const text = JSON.stringify(data);
	assert.ok(!text.includes("secret"));
	assert.ok(!text.includes("abc.def.ghi"));
	assert.ok(text.includes("failed"));
	assert.ok(text.includes("二进制"));
	assert.ok(String(sanitize("x".repeat(20000), 50)).length < 100);
	const circular: { self?: unknown } = {};
	circular.self = circular;
	assert.ok(JSON.stringify(sanitize(circular)).includes("循环引用"));
});
