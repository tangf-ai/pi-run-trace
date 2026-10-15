import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readUsage, runStatistics, spanStatistics } from "../src/metrics.ts";
import { TraceRecorder } from "../src/recorder.ts";

test("streamed tokens are estimates from content, then authoritative usage survives output truncation", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-trace-metrics-"));
	let now = 1000;
	const recorder = new TraceRecorder(directory, () => now);
	try {
		const run = recorder.begin("metrics", "/project", "test");
		recorder.startTurn(0);
		now = 2000;
		recorder.stream("abcd");
		let snapshot = await recorder.read(run.id);
		assert.equal(snapshot?.statistics?.outputTokens, 1);
		assert.equal(snapshot?.statistics?.estimatedModels, 1);
		assert.equal(snapshot?.statistics?.firstResponseMs, 1000);
		now = 3000;
		recorder.stream("efgh");
		snapshot = await recorder.read(run.id);
		assert.equal(snapshot?.statistics?.outputTokens, 2);
		assert.equal(snapshot?.statistics?.outputTps, 1);
		assert.equal(snapshot?.spans[1].statistics?.generationTps, 2);
		now = 4000;
		recorder.modelEnd({
			content: "x".repeat(20000),
			stopReason: "stop",
			usage: { input: 80, output: 10, cacheRead: 20, cacheWrite: 0, totalTokens: 110, reasoning: 4 },
		});
		recorder.finish();
		await recorder.flush();
		const saved = await recorder.read(run.id);
		assert.equal(saved?.statistics?.estimatedModels, 0);
		assert.equal(saved?.statistics?.outputTokens, 10);
		assert.equal(saved?.statistics?.totalTokens, 110);
		assert.equal(saved?.statistics?.cacheHitRate, 0.2);
		assert.equal(saved?.statistics?.outputTps, 10 / 3);
		assert.equal(saved?.spans[1].statistics?.generationTps, 10);
		assert.ok(!JSON.stringify(saved?.spans[1].output).includes('"usage"'));
		assert.equal(saved?.spans[1].metrics?.usage?.reasoning, 4);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("task TPS uses total model duration, excludes tools, and counts reasoning only once", () => {
	const stats = runStatistics([
		{
			kind: "model",
			status: "completed",
			startedAt: 0,
			endedAt: 1000,
			durationMs: 1000,
			output: { usage: { input: 100, output: 100, cacheRead: 100, cacheWrite: 50, totalTokens: 350, reasoning: 60 } },
		},
		{
			kind: "tool",
			status: "error",
			startedAt: 1000,
			endedAt: 101000,
			durationMs: 100000,
			output: { usage: { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0, totalTokens: 2000 } },
		},
		{
			kind: "model",
			status: "completed",
			startedAt: 101000,
			endedAt: 104000,
			durationMs: 3000,
			output: { usage: { input: 0, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 50 } },
		},
	]);
	assert.equal(stats.outputTokens, 150);
	assert.equal(stats.totalTokens, 400);
	assert.equal(stats.outputTps, 37.5);
	assert.equal(stats.modelTimeMs, 4000);
	assert.equal(stats.cacheHitRate, 0.4);
	assert.equal(stats.toolErrors, 1);
});

test("missing usage stays unknown; cancellation keeps estimates without inventing final counts", () => {
	assert.equal(readUsage({ input: Number.NaN, output: 10, cacheRead: 0, cacheWrite: 0 }), undefined);
	const missing = runStatistics([
		{
			kind: "model",
			status: "error",
			startedAt: 0,
			durationMs: 1000,
			output: { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } },
		},
	]);
	assert.equal(missing.totalTokens, undefined);
	assert.equal(missing.outputTps, undefined);
	assert.equal(missing.unknownModels, 1);
	const cancelled = spanStatistics({
		kind: "model",
		status: "aborted",
		startedAt: 0,
		endedAt: 2000,
		metrics: {
			firstContentAt: 0,
			lastContentAt: 0,
			chunks: 1,
			asciiCharacters: 40,
			otherCharacters: 0,
			estimatedOutputTokens: 10,
		},
	});
	assert.equal(cancelled.outputTokens, 10);
	assert.equal(cancelled.estimated, true);
	assert.equal(cancelled.firstResponseMs, 0);
	assert.equal(cancelled.outputTps, 5);
	assert.equal(cancelled.generationTps, undefined);
	const zeroTime = spanStatistics({
		kind: "model",
		status: "completed",
		startedAt: 0,
		endedAt: 0,
		output: { usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } },
	});
	assert.equal(zeroTime.outputTps, undefined);
});

test("splitting a stream into chunks does not turn chunks into tokens", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-trace-chunks-"));
	try {
		const one = new TraceRecorder(directory);
		one.begin("one", "/project", "one");
		one.startTurn(0);
		one.stream("abcdefgh你好");
		const split = new TraceRecorder(directory);
		split.begin("two", "/project", "two");
		split.startTurn(0);
		for (const character of "abcdefgh你好") split.stream(character);
		assert.equal(one.active?.spans[1].metrics?.estimatedOutputTokens, 4);
		assert.equal(split.active?.spans[1].metrics?.estimatedOutputTokens, 4);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
