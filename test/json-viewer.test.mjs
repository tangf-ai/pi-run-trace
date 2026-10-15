import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import { parseHTML } from "linkedom";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const script = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

function createViewer() {
	const { document, window } = parseHTML(html);
	const copies = [];
	const scrollTargets = [];
	window.HTMLElement.prototype.scrollIntoView = function () {
		scrollTargets.push(this);
	};
	const context = createContext({
		document,
		URLSearchParams,
		location: { hash: "" },
		navigator: {
			clipboard: {
				writeText: async (text) => {
					copies.push(text);
				},
			},
		},
		fetch: async () => ({ ok: true, json: async () => ({ runs: [] }) }),
		setInterval: () => 0,
	});
	const JsonViewer = runInContext(`${script}\nJsonViewer;`, context);
	const root = document.createElement("div");
	document.body.append(root);
	return { viewer: new JsonViewer(root, "测试"), root, window, copies, scrollTargets };
}

function search(root, window, query) {
	const input = root.querySelector('input[type="search"]');
	input.value = query;
	input.dispatchEvent(new window.Event("input"));
}

test("search opens collapsed ancestors and long fields, highlights literal matches and navigates", () => {
	const { viewer, root, window, scrollTargets } = createViewer();
	const data = {
		messages: [{ sections: { preamble: `${"first line\n".repeat(40)}needle` } }, { content: "other needle" }],
		literal: "[.*]",
	};
	viewer.setValue(data, "one");
	assert.ok(!root.textContent.includes("first line"), "nested contents start collapsed");
	search(root, window, "needle");
	assert.equal(root.querySelector(".json-counter").textContent, "1 / 2 字段");
	assert.equal(scrollTargets.at(-1).tagName, "MARK");
	assert.equal(
		root.querySelector(".json-current").dataset.jsonPath,
		JSON.stringify(["messages", 0, "sections", "preamble"]),
	);
	assert.ok(root.querySelector(".json-current").textContent.includes("first line\nfirst line"));
	assert.ok(root.querySelector(".json-current mark").textContent.includes("needle"));
	let ancestor = root.querySelector(".json-current").parentElement;
	while (ancestor && ancestor !== root) {
		if (ancestor.classList.contains("json-branch")) assert.equal(ancestor.open, true);
		ancestor = ancestor.parentElement;
	}
	[...root.querySelectorAll("button")].find((button) => button.textContent === "下一处").click();
	assert.equal(root.querySelector(".json-counter").textContent, "2 / 2 字段");
	assert.equal(root.querySelector(".json-current").dataset.jsonPath, JSON.stringify(["messages", 1, "content"]));
	[...root.querySelectorAll("button")].find((button) => button.textContent === "下一处").click();
	assert.equal(root.querySelector(".json-counter").textContent, "1 / 2 字段");
	search(root, window, "[.*]");
	assert.equal(root.querySelector(".json-counter").textContent, "1 / 1 字段");
	search(root, window, "absent");
	assert.equal(root.querySelector(".json-counter").textContent, "没有匹配");
	assert.ok([...root.querySelectorAll("button")].find((button) => button.textContent === "下一处").disabled);
	search(root, window, "");
	assert.equal(root.querySelectorAll("mark").length, 0);
});

test("formatted JSON round-trips, copy preserves data and polling preserves search and view state", async () => {
	const { viewer, root, window, copies } = createViewer();
	const data = { list: [{ text: "line one\nline two", active: true, nil: null }], score: 12 };
	viewer.setValue(data, "same-node");
	root.querySelector('[data-mode="json"]').click();
	assert.ok(root.querySelector(".json-source").textContent.includes('\n  "list": ['));
	assert.deepEqual(JSON.parse(root.querySelector(".json-source").textContent), data);
	search(root, window, "line");
	const source = root.querySelector(".json-source");
	viewer.setValue(structuredClone(data), "same-node");
	assert.equal(root.querySelector(".json-source"), source);
	assert.equal(root.querySelector('input[type="search"]').value, "line");
	assert.equal(root.querySelector('[data-mode="json"]').getAttribute("aria-pressed"), "true");
	[...root.querySelectorAll("button")].find((button) => button.textContent === "复制 JSON").click();
	await Promise.resolve();
	assert.deepEqual(JSON.parse(copies[0]), data);
	root.querySelector('[data-mode="preview"]').click();
	[...root.querySelectorAll("button")].find((button) => button.textContent === "全部折叠").click();
	assert.equal(root.querySelector("details").open, false);
	viewer.setValue(structuredClone(data), "same-node");
	assert.equal(root.querySelector("details").open, false);
	viewer.setValue(data, "other-node");
	assert.equal(root.querySelector('input[type="search"]').value, "");
});

test("JSON strings are parsed for preview, malformed text remains readable and markup stays inert", () => {
	const { viewer, root, window } = createViewer();
	viewer.setValue('{"nested":{"code":123},"unsafe":"<img src=x onerror=alert(1)>"}', "json-string");
	assert.ok(root.querySelector(".json-notice").textContent.includes("JSON 文本"));
	search(root, window, "123");
	assert.equal(root.querySelector(".json-current").dataset.jsonPath, JSON.stringify(["nested", "code"]));
	search(root, window, "<img");
	assert.equal(root.querySelectorAll("img").length, 0);
	assert.ok(root.querySelector(".json-current").textContent.includes("<img"));
	viewer.setValue('{"unclosed":\nplain text', "invalid");
	assert.ok(root.querySelector(".json-body").textContent.includes("\nplain text"));
	root.querySelector('[data-mode="json"]').click();
	assert.equal(JSON.parse(root.querySelector(".json-source").textContent), '{"unclosed":\nplain text');
});

test("large previews remain bounded while formatted JSON retains every recorded field", () => {
	const { viewer, root, window } = createViewer();
	const data = Array.from({ length: 2100 }, (_, index) => `item-${index}`);
	viewer.setValue(data, "large");
	assert.ok(root.querySelector(".json-notice").textContent.includes("2000"));
	root.querySelector('[data-mode="json"]').click();
	assert.equal(JSON.parse(root.querySelector(".json-source").textContent).length, 2100);
	search(root, window, "item-2099");
	assert.equal(root.querySelector(".json-counter").textContent, "1 / 1 处");
});

test("preview distinguishes strings from booleans and preserves multiline text", () => {
	const { viewer, root } = createViewer();
	viewer.setValue({ text: "true", flag: true, empty: "", lines: "first\nsecond" }, "types");
	const values = [...root.querySelectorAll(".json-value")].map((value) => value.textContent);
	assert.deepEqual(values, ['"true"', "true", '""', "first\nsecond"]);
});
