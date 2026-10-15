import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TraceRecorder } from "../src/recorder.ts";
import { TraceViewer } from "../src/server.ts";

test("viewer serves real traces, source links and node questions with local authorization", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-run-trace-server-"));
	const sourceRoot = join(directory, "source");
	await mkdir(join(sourceRoot, "packages/agent/src"), { recursive: true });
	await writeFile(
		join(sourceRoot, "packages/agent/src/agent-loop.ts"),
		"async function streamAssistantResponse(\n) {}\n",
	);
	const recorder = new TraceRecorder(directory);
	const run = recorder.begin("session", "/project", "测试任务");
	recorder.startTurn(0, "faux", "test");
	const questions: string[] = [];
	const viewer = new TraceViewer({
		recorder,
		sourceRoot,
		onQuestion: (_run, span, question) => {
			questions.push(`${span.kind}:${question}`);
		},
	});
	try {
		const url = new URL(await viewer.start());
		assert.equal(await viewer.start(), url.href);
		const headers = { "X-Trace-Token": new URLSearchParams(url.hash.slice(1)).get("token") ?? "" };
		assert.equal((await fetch(`${url.origin}/api/runs`)).status, 401);
		assert.equal(
			(await fetch(`${url.origin}/api/runs`, { headers: { ...headers, Origin: "https://other.example" } })).status,
			403,
		);
		const page = await fetch(url.origin);
		assert.equal(page.status, 200);
		assert.ok((await page.text()).includes("执行流程"));
		const list = await fetch(`${url.origin}/api/runs`, { headers }).then((response) => response.json());
		assert.equal(list.runs[0].id, run.id);
		const detail = await fetch(`${url.origin}/api/runs/${run.id}`, { headers }).then((response) => response.json());
		assert.equal(detail.spans.length, 2);
		const source = await fetch(`${url.origin}/api/source?kind=model`, { headers }).then((response) => response.json());
		assert.ok(source.code.includes("streamAssistantResponse"));
		assert.equal((await fetch(`${url.origin}/api/source?kind=../../secrets`, { headers })).status, 400);
		const answer = await fetch(`${url.origin}/api/ask`, {
			method: "POST",
			headers,
			body: JSON.stringify({ runId: run.id, spanId: run.spans[1].id, question: "为什么请求模型？" }),
		});
		assert.equal(answer.status, 202);
		assert.deepEqual(questions, ["model:为什么请求模型？"]);
		assert.equal((await fetch(`${url.origin}/api/ask`, { method: "POST", headers, body: "null" })).status, 400);
		assert.equal((await fetch(`${url.origin}/api/ask`, { method: "POST", headers, body: "{" })).status, 400);
		assert.equal(
			(await fetch(`${url.origin}/api/ask`, { method: "POST", headers, body: "x".repeat(13000) })).status,
			413,
		);
	} finally {
		await viewer.close();
		await recorder.flush();
		await rm(directory, { recursive: true, force: true });
	}
});
