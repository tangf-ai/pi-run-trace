import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createContext, runInContext } from "node:vm";
import { parseHTML } from "linkedom";
import { TraceRecorder } from "../src/recorder.ts";
import { TraceViewer } from "../src/server.ts";

test("actual viewer selects nodes, loads related code, and submits a contextual question", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-run-trace-dom-"));
	const sourceRoot = join(directory, "source");
	await mkdir(join(sourceRoot, "packages/agent/src"), { recursive: true });
	await writeFile(
		join(sourceRoot, "packages/agent/src/agent-loop.ts"),
		"async function executePreparedToolCall(\n) {}\n",
	);
	const recorder = new TraceRecorder(directory);
	const run = recorder.begin("dom-test", "/project", "读取文件后解释");
	recorder.startTurn(0, "faux", "test");
	recorder.modelEnd({
		content: [],
		stopReason: "toolUse",
		usage: { input: 80, output: 30, cacheRead: 20, cacheWrite: 0, totalTokens: 130 },
	});
	recorder.toolStart("read-dom", "read", { path: "example.ts" });
	recorder.toolEnd("read-dom", { content: [{ type: "text", text: "example contents" }] }, false, 9);
	recorder.finish();
	await recorder.flush();
	const questions = [];
	const viewer = new TraceViewer({
		recorder,
		sourceRoot,
		onQuestion: (selectedRun, span, question) => {
			questions.push({ runId: selectedRun.id, spanId: span.id, question });
		},
	});
	const pending = new Set();
	try {
		const url = new URL(await viewer.start());
		const { document, window } = parseHTML(await readFile(new URL("../public/index.html", import.meta.url), "utf8"));
		const script = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
		const context = createContext({
			document,
			location: url,
			URLSearchParams,
			fetch: (path, options) => {
				const operation = fetch(new URL(path, url), options);
				pending.add(operation);
				void operation.finally(() => pending.delete(operation));
				return operation;
			},
			setInterval: () => 0,
		});
		async function until(predicate) {
			const deadline = Date.now() + 2000;
			while (!predicate()) {
				if (Date.now() > deadline)
					throw new Error(`Page condition timed out: ${document.getElementById("connection").textContent}`);
				await delay(10);
			}
		}
		runInContext(script, context);
		await until(() => document.querySelectorAll(".flow-node").length === 3);
		assert.equal(document.getElementById("stat-total").textContent, "130");
		assert.equal(document.getElementById("stat-input").textContent, "100");
		assert.equal(document.getElementById("stat-output").textContent, "30");
		assert.equal(document.getElementById("stat-cache").textContent, "20.0%");
		const model = document.querySelectorAll(".flow-node")[1];
		model.click();
		assert.equal(document.getElementById("node-metrics").hidden, false);
		assert.ok(document.getElementById("node-metrics").textContent.includes("30"));
		const tool = document.querySelector('[data-span-id="read-dom"]');
		tool.click();
		assert.equal(document.getElementById("node-metrics").hidden, true);
		assert.equal(document.getElementById("node-title").textContent, "read");
		const metadata = [...document.querySelectorAll("#node-meta .node-meta-item")];
		assert.equal(metadata.length, 4);
		const parent = metadata.find((item) => item.querySelector("dt").textContent === "父节点").querySelector("dd");
		assert.ok(parent.textContent.includes("模型请求"));
		assert.equal(parent.title, run.spans.find((span) => span.kind === "model").id);
		assert.ok(document.getElementById("node-input").textContent.includes("example.ts"));
		document.querySelector('#node-output [data-mode="json"]').click();
		assert.ok(document.getElementById("node-output").textContent.includes("example contents"));
		document.getElementById("tab-source").click();
		await until(() => document.getElementById("source-code").textContent.includes("executePreparedToolCall"));
		assert.equal(document.getElementById("source-view").hidden, false);
		assert.equal(document.getElementById("data-view").hidden, true);
		document.getElementById("tab-ask").click();
		document.querySelector("[data-question]").click();
		assert.ok(document.getElementById("question").value.includes("输入和输出"));
		document.getElementById("ask-form").dispatchEvent(new window.Event("submit", { cancelable: true }));
		await until(() => document.getElementById("ask-status").textContent.includes("已发送"));
		assert.equal(questions.length, 1);
		assert.equal(questions[0].spanId, "read-dom");
		assert.equal(questions[0].runId, run.id);
		assert.equal(document.getElementById("send-question").disabled, false);
		document.getElementById("tab-data").click();
		assert.equal(document.getElementById("data-view").hidden, false);
		assert.equal(document.getElementById("ask-view").hidden, true);
		await Promise.all(pending);
	} finally {
		await viewer.close();
		await rm(directory, { recursive: true, force: true });
	}
});
