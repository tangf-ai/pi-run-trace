import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createContext, runInContext } from "node:vm";
import { parseHTML } from "linkedom";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const script = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

async function pageFor(run) {
	const { document } = parseHTML(html);
	const context = createContext({
		document,
		URLSearchParams,
		location: { hash: "" },
		setInterval: () => 0,
		fetch: async (path) => ({ ok: true, json: async () => (path === "/api/runs" ? { runs: [run] } : run) }),
	});
	runInContext(script, context);
	for (let count = 0; count < 30 && document.querySelectorAll(".flow-node").length !== run.spans.length; count++)
		await delay(0);
	return { document, context };
}

test("timeline follows actual start order, preserves nesting, and places parallel intervals on one scale", async () => {
	const run = {
		id: "timeline",
		sessionId: "session",
		cwd: "/project",
		prompt: "并行任务",
		status: "completed",
		startedAt: 1000,
		endedAt: 6000,
		revision: 1,
		spans: [
			{
				id: "model",
				kind: "model",
				name: "模型请求 · faux/test",
				turnIndex: 0,
				status: "completed",
				startedAt: 1000,
				endedAt: 2000,
				durationMs: 1000,
			},
			{
				id: "parent",
				parentId: "model",
				kind: "tool",
				name: "bash",
				status: "completed",
				startedAt: 2000,
				endedAt: 5000,
				durationMs: 3000,
				input: { command: "test" },
			},
			{
				id: "nested",
				parentId: "parent",
				kind: "tool",
				name: "read",
				status: "completed",
				startedAt: 4000,
				endedAt: 4200,
				durationMs: 200,
			},
			{
				id: "parallel",
				parentId: "model",
				kind: "tool",
				name: "grep",
				status: "error",
				startedAt: 3000,
				endedAt: 3500,
				durationMs: 500,
			},
			{
				id: "final",
				kind: "model",
				name: "模型请求 · faux/test",
				turnIndex: 1,
				status: "completed",
				startedAt: 5000,
				endedAt: 6000,
				durationMs: 1000,
			},
		],
	};
	const { document, context } = await pageFor(run);
	const buttons = [...document.querySelectorAll(".flow-node")];
	assert.deepEqual(
		buttons.map((button) => button.dataset.spanId),
		["model", "parent", "parallel", "nested", "final"],
	);
	assert.deepEqual(
		buttons.map((button) => button.dataset.depth),
		["0", "1", "1", "2", "0"],
	);
	assert.deepEqual(
		buttons.map((button) => button.querySelector(".timeline-bar").style.marginLeft),
		["0%", "20%", "40%", "60%", "80%"],
	);
	assert.deepEqual(
		buttons.map((button) => button.querySelector(".timeline-bar").style.width),
		["20%", "60%", "10%", "4%", "20%"],
	);
	assert.ok(buttons[2].textContent.includes("失败"));
	assert.ok(buttons[0].querySelector(".timeline-offset").textContent.startsWith("+0"));
	document.getElementById("graph").scrollTop = 60;
	buttons[1].click();
	assert.equal(document.getElementById("graph").scrollTop, 60);
	assert.equal(document.getElementById("node-title").textContent, "bash");
	assert.equal(document.querySelector('.flow-node[aria-pressed="true"]').dataset.spanId, "parent");
	await runInContext("poll()", context);
	assert.equal(document.querySelector('.flow-node[aria-pressed="true"]').dataset.spanId, "parent");
});

test("locating current work selects the latest running step and orphaned or cyclic spans stay visible", async () => {
	const now = Date.now();
	const run = {
		id: "running",
		sessionId: "session",
		cwd: "/project",
		prompt: "正在执行",
		status: "running",
		startedAt: now - 5000,
		revision: 1,
		spans: [
			{ id: "model", kind: "model", name: "model", status: "completed", startedAt: now - 5000, durationMs: 1000 },
			{ id: "active", parentId: "model", kind: "tool", name: "active bash", status: "running", startedAt: now - 4000 },
			{
				id: "orphan",
				parentId: "absent",
				kind: "tool",
				name: "orphan",
				status: "completed",
				startedAt: now - 3000,
				durationMs: 0,
			},
			{
				id: "cycle-a",
				parentId: "cycle-b",
				kind: "tool",
				name: "cycle a",
				status: "completed",
				startedAt: now - 2000,
				durationMs: 10,
			},
			{
				id: "cycle-b",
				parentId: "cycle-a",
				kind: "tool",
				name: "cycle b",
				status: "completed",
				startedAt: now - 1000,
				durationMs: 10,
			},
		],
	};
	const { document } = await pageFor(run);
	assert.equal(document.querySelectorAll(".flow-node").length, 5);
	assert.equal(document.getElementById("timeline-jump").textContent, "定位当前步骤");
	document.getElementById("timeline-jump").click();
	assert.equal(document.getElementById("node-title").textContent, "active bash");
	assert.equal(document.querySelector('.flow-node[aria-pressed="true"]').dataset.spanId, "active");
	assert.ok(document.querySelector('[data-span-id="active"] .node-timing').textContent.includes("运行"));
});

test("an interrupted trace does not invent a running duration or keep showing active output", async () => {
	const run = {
		id: "stopped",
		sessionId: "session",
		cwd: "/project",
		prompt: "停止的任务",
		status: "interrupted",
		startedAt: 1000,
		revision: 1,
		spans: [{ id: "unfinished", kind: "tool", name: "bash", status: "running", startedAt: 2000 }],
	};
	const { document } = await pageFor(run);
	assert.ok(document.querySelector(".node-timing").textContent.includes("中断 —"));
	assert.equal(document.querySelector(".timeline-bar"), null);
	assert.ok(!document.getElementById("node-output").textContent.includes("正在执行"));
	assert.equal(document.getElementById("timeline-jump").textContent, "定位选中步骤");
});
