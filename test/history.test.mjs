import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createContext, runInContext } from "node:vm";
import { parseHTML } from "linkedom";

test("history groups by session identity, preserves folding and selection across polling, and orders new activity", async () => {
	const { document, window } = parseHTML(await readFile(new URL("../public/index.html", import.meta.url), "utf8"));
	const script = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
	const makeRun = (id, sessionId, prompt, startedAt) => ({
		id,
		sessionId,
		prompt,
		startedAt,
		endedAt: startedAt + 10,
		status: "completed",
		cwd: "/same/project",
		revision: 1,
		spans: [],
	});
	const first = makeRun("a-first", "aaaaaaaa-1111", "A 最早的问题", 10);
	const second = makeRun("a-second", "aaaaaaaa-1111", "A 后续问题", 30);
	const other = makeRun("b-first", "bbbbbbbb-2222", "同目录的另一个会话", 40);
	let runs = [other, second, first];
	const context = createContext({
		document,
		URLSearchParams,
		location: { hash: "" },
		setInterval: () => 0,
		fetch: async (path) => ({
			ok: true,
			json: async () => (path === "/api/runs" ? { runs } : runs.find((run) => path === `/api/runs/${run.id}`)),
		}),
	});
	runInContext(script, context);
	await runInContext("poll()", context);
	for (let count = 0; count < 20 && document.querySelectorAll(".session-group").length !== 2; count++) await delay(0);
	const group = (id) => [...document.querySelectorAll(".session-group")].find((item) => item.dataset.sessionId === id);
	assert.equal(document.getElementById("run-count").textContent, "2 会话 · 3 请求");
	assert.equal(document.querySelector(".session-group").dataset.sessionId, "bbbbbbbb-2222");
	assert.equal(group("aaaaaaaa-1111").querySelector(".session-title").textContent, "A 最早的问题");
	assert.equal(group("aaaaaaaa-1111").querySelector(".session-count").textContent, "2 条");
	assert.equal(group("aaaaaaaa-1111").open, false);
	assert.equal(group("bbbbbbbb-2222").open, true);
	const original = group("aaaaaaaa-1111");
	original.open = true;
	original.dispatchEvent(new window.Event("toggle"));
	await runInContext("poll()", context);
	assert.equal(group("aaaaaaaa-1111"), original, "unchanged polling preserves the DOM and keyboard focus");
	const newest = makeRun("a-new", "aaaaaaaa-1111", "A 新请求", 50);
	runs = [newest, ...runs];
	await runInContext("poll()", context);
	assert.equal(document.querySelector(".session-group").dataset.sessionId, "aaaaaaaa-1111");
	assert.equal(group("aaaaaaaa-1111").open, true);
	assert.equal(group("aaaaaaaa-1111").querySelector(".session-count").textContent, "3 条");
	group("aaaaaaaa-1111").querySelector('[data-run-id="a-new"]').click();
	for (let count = 0; count < 20 && document.getElementById("run-title").textContent !== "A 新请求"; count++)
		await delay(0);
	assert.equal(document.getElementById("run-title").textContent, "A 新请求");
	assert.equal(group("aaaaaaaa-1111").querySelector('[aria-pressed="true"]').dataset.runId, "a-new");
	group("aaaaaaaa-1111").open = false;
	runs = [{ ...newest, endedAt: 75 }, ...runs.slice(1)];
	await runInContext("poll()", context);
	assert.equal(group("aaaaaaaa-1111").open, false, "metadata updates preserve a user's collapsed session");
});
