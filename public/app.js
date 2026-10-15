class JsonViewer {
	constructor(root, label) {
		this.root = root;
		this.label = label;
		this.mode = "preview";
		this.query = "";
		this.identity = undefined;
		this.serialized = undefined;
		this.records = new Map();
		this.rows = new Map();
		this.openPaths = new Set();
		this.openTexts = new Set();
		this.matches = [];
		this.matchIndex = -1;
		const toolbar = element("div", "json-toolbar");
		const modes = element("div", "json-modes");
		modes.setAttribute("role", "group");
		modes.setAttribute("aria-label", `${label}查看方式`);
		this.modeButtons = ["preview", "json"].map((mode) => {
			const button = this.button(mode === "preview" ? "预览" : "JSON", () => {
				this.mode = mode;
				this.render();
				this.search();
			});
			button.dataset.mode = mode;
			modes.append(button);
			return button;
		});
		this.expand = this.button("全部展开", () => {
			for (const record of this.records.values()) if (record.children) this.openPaths.add(record.id);
			this.render();
			this.search(false);
		});
		this.collapse = this.button("全部折叠", () => {
			this.openPaths.clear();
			this.openTexts.clear();
			this.render();
			this.search(false);
		});
		const copy = this.button("复制 JSON", async () => {
			try {
				if (!globalThis.navigator?.clipboard?.writeText) throw new Error("Clipboard unavailable");
				await globalThis.navigator.clipboard.writeText(this.formatted);
				this.copyStatus.textContent = "已复制";
			} catch {
				this.copyStatus.textContent = "请在 JSON 视图中选择文本复制";
			}
		});
		this.copyStatus = element("span", "muted");
		this.copyStatus.setAttribute("role", "status");
		toolbar.append(modes, this.expand, this.collapse, copy, this.copyStatus);
		const searchbar = element("div", "json-search");
		this.input = element("input");
		this.input.type = "search";
		this.input.placeholder = "搜索字段或内容";
		this.input.setAttribute("aria-label", `搜索${label}字段或内容`);
		this.input.addEventListener("input", () => {
			this.query = this.input.value.trim();
			this.search();
		});
		this.previous = this.button("上一处", () => this.selectMatch(this.matchIndex - 1));
		this.next = this.button("下一处", () => this.selectMatch(this.matchIndex + 1));
		this.counter = element("span", "json-counter muted");
		this.counter.setAttribute("role", "status");
		searchbar.append(this.input, this.previous, this.next, this.counter);
		this.body = element("div", "json-body");
		this.notice = element("div", "json-notice muted");
		root.replaceChildren(toolbar, searchbar, this.notice, this.body);
		this.setValue(undefined, "empty");
	}

	button(label, action) {
		const button = element("button", "json-button", label);
		button.type = "button";
		button.addEventListener("click", action);
		return button;
	}

	setValue(value, identity) {
		const serialized = JSON.stringify(value);
		if (identity === this.identity && serialized === this.serialized) return;
		const fresh = identity !== this.identity;
		if (fresh) {
			this.query = "";
			this.input.value = "";
			this.openPaths.clear();
			this.openTexts.clear();
		}
		this.identity = identity;
		this.serialized = serialized;
		this.records.clear();
		this.copyStatus.textContent = "";
		let limited = false;
		const visit = (original, key, parent, path) => {
			if (this.records.size >= 2000) {
				limited = true;
				return undefined;
			}
			let value = original;
			let jsonText = false;
			if (typeof original === "string" && /^[\s]*[[{]/.test(original)) {
				try {
					const parsed = JSON.parse(original);
					if (parsed && typeof parsed === "object") {
						value = parsed;
						jsonText = true;
					}
				} catch {
					/* Incomplete JSON and ordinary text remain readable as text. */
				}
			}
			const id = JSON.stringify(path);
			const record = { id, key, value, parent, jsonText, path, children: undefined };
			this.records.set(id, record);
			if (value !== null && typeof value === "object") {
				record.children = [];
				const entries = Array.isArray(value) ? value.map((item, index) => [index, item]) : Object.entries(value);
				for (const [childKey, child] of entries) {
					const childId = visit(child, childKey, id, [...path, childKey]);
					if (childId === undefined) break;
					record.children.push(childId);
				}
			}
			return id;
		};
		this.rootId = visit(value, null, undefined, []);
		const display = this.records.get(this.rootId)?.value;
		this.formatted = display === undefined ? "—" : JSON.stringify(display, null, 2);
		if (fresh && this.records.size) this.openPaths.add(this.rootId);
		this.notice.textContent = limited
			? "预览最多显示 2000 个字段；JSON 视图可查看全部已记录内容。"
			: this.records.get(this.rootId)?.jsonText
				? "JSON 文本已解析为结构预览。"
				: "";
		this.render();
		this.search(false);
	}

	paint(target, text) {
		target.replaceChildren();
		if (!this.query) {
			target.textContent = text;
			return;
		}
		const source = text.toLowerCase();
		const query = this.query.toLowerCase();
		let offset = 0;
		while (offset < text.length) {
			const index = source.indexOf(query, offset);
			if (index < 0) break;
			target.append(
				document.createTextNode(text.slice(offset, index)),
				element("mark", "json-match", text.slice(index, index + query.length)),
			);
			offset = index + query.length;
		}
		target.append(document.createTextNode(text.slice(offset)));
	}

	render() {
		this.rows.clear();
		this.body.replaceChildren();
		for (const button of this.modeButtons)
			button.setAttribute("aria-pressed", String(button.dataset.mode === this.mode));
		this.expand.hidden = this.mode !== "preview";
		this.collapse.hidden = this.mode !== "preview";
		if (this.mode === "json") {
			this.source = element("pre", "json-source");
			this.body.append(this.source);
			this.paint(this.source, this.formatted);
		} else if (this.rootId !== undefined) this.body.append(this.renderRecord(this.records.get(this.rootId)));
	}

	renderRecord(record) {
		const row = element(record.children ? "details" : "div", record.children ? "json-branch" : "json-leaf");
		row.dataset.jsonPath = record.id;
		const key = element("span", "json-key");
		const label =
			record.key === null ? "$" : typeof record.key === "number" ? `[${record.key}]` : JSON.stringify(record.key);
		this.paint(key, label);
		this.rows.set(record.id, { row, key, label });
		if (record.children) {
			const summary = element("summary");
			const length = Array.isArray(record.value) ? record.value.length : Object.keys(record.value).length;
			const role = typeof record.value.role === "string" ? ` · ${record.value.role.slice(0, 40)}` : "";
			summary.append(
				key,
				element(
					"span",
					"json-type",
					`${Array.isArray(record.value) ? `[${length} 项]` : `{${length} 字段}`}${record.jsonText ? " · JSON 文本" : ""}${role}`,
				),
			);
			const children = element("div", "json-children");
			row.append(summary, children);
			const build = () => {
				if (children.childNodes.length) return;
				for (const child of record.children) children.append(this.renderRecord(this.records.get(child)));
			};
			this.rows.get(record.id).build = build;
			row.open = this.openPaths.has(record.id);
			if (row.open) build();
			row.addEventListener("toggle", () => {
				if (!this.body.contains(row)) return;
				if (row.open) {
					this.openPaths.add(record.id);
					build();
				} else this.openPaths.delete(record.id);
			});
		} else {
			const value = element(
				typeof record.value === "string" && (record.value.length > 240 || record.value.includes("\n")) ? "pre" : "span",
				`json-value json-${record.value === null ? "null" : typeof record.value}`,
			);
			row.append(key, document.createTextNode(": "), value);
			this.rows.get(record.id).value = value;
			if (typeof record.value === "string" && record.value.length > 240) {
				const toggle = this.button("", () => {
					if (this.openTexts.has(record.id)) this.openTexts.delete(record.id);
					else this.openTexts.add(record.id);
					this.paintLeaf(record);
				});
				row.append(toggle);
				this.rows.get(record.id).toggle = toggle;
			}
			this.paintLeaf(record);
		}
		return row;
	}

	paintLeaf(record) {
		const entry = this.rows.get(record.id);
		const expanded = this.openTexts.has(record.id);
		const text =
			record.value === undefined
				? "—"
				: typeof record.value === "string" && (record.value.length > 240 || record.value.includes("\n"))
					? record.value
					: JSON.stringify(record.value);
		this.paint(entry.value, !expanded && text.length > 240 ? `${text.slice(0, 240)}…` : text);
		if (entry.toggle) {
			entry.toggle.textContent = expanded ? "收起文本" : `展开全文（${text.length.toLocaleString("zh-CN")} 字符）`;
			entry.toggle.setAttribute("aria-expanded", String(expanded));
		}
	}

	search(jump = true) {
		this.matchIndex = -1;
		this.matches = [];
		const query = this.query.toLowerCase();
		if (query) {
			if (this.mode === "json") {
				const lower = this.formatted.toLowerCase();
				let index = lower.indexOf(query);
				while (index >= 0) {
					this.matches.push(index);
					index = lower.indexOf(query, index + query.length);
				}
			} else {
				for (const record of this.records.values()) {
					const key = record.key === null ? "$" : String(record.key);
					const text = record.children
						? key
						: `${key}\n${typeof record.value === "string" ? record.value : JSON.stringify(record.value)}`;
					if (text.toLowerCase().includes(query)) this.matches.push(record.id);
				}
			}
		}
		for (const [id, entry] of this.rows) {
			entry.row.classList.remove("json-current");
			this.paint(entry.key, entry.label);
			if (entry.value) this.paintLeaf(this.records.get(id));
		}
		if (this.mode === "json") this.paint(this.source, this.formatted);
		this.previous.disabled = !this.matches.length;
		this.next.disabled = !this.matches.length;
		this.counter.textContent = !query ? "" : this.matches.length ? `${this.matches.length} 处匹配` : "没有匹配";
		if (this.matches.length && jump) this.selectMatch(0);
	}

	selectMatch(index) {
		if (!this.matches.length) return;
		this.matchIndex = (index + this.matches.length) % this.matches.length;
		for (const entry of this.rows.values()) entry.row.classList.remove("json-current");
		let target;
		let anchor;
		if (this.mode === "json") {
			for (const mark of this.source.querySelectorAll("mark")) mark.classList.remove("json-current");
			target = this.source.querySelectorAll("mark")[this.matchIndex];
		} else {
			const record = this.records.get(this.matches[this.matchIndex]);
			const parents = [];
			let parent = record.parent;
			while (parent !== undefined) {
				parents.unshift(parent);
				parent = this.records.get(parent).parent;
			}
			for (const id of parents) {
				const entry = this.rows.get(id);
				entry.row.open = true;
				this.openPaths.add(id);
				entry.build();
			}
			if (!record.children) {
				this.openTexts.add(record.id);
				this.paintLeaf(record);
			}
			target = this.rows.get(record.id).row;
			anchor = target.querySelector("mark") ?? target;
		}
		target?.classList.add("json-current");
		(anchor ?? target)?.scrollIntoView?.({ block: "nearest" });
		this.counter.textContent = `${this.matchIndex + 1} / ${this.matches.length} ${this.mode === "preview" ? "字段" : "处"}`;
	}
}

const token = new URLSearchParams(location.hash.slice(1)).get("token") ?? "";
const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map((element) => [element.id, element]));
const state = {
	runs: [],
	run: null,
	runId: null,
	spanId: null,
	revision: -1,
	tab: "data",
	polling: false,
	historySignature: undefined,
	sessionOpen: new Map(),
};
const labels = {
	input: "用户消息",
	model: "模型",
	tool: "工具",
	lifecycle: "执行循环",
	compaction: "上下文压缩",
	waiting: "等待输入",
	running: "进行中",
	completed: "已完成",
	error: "失败",
	aborted: "已取消",
	interrupted: "未完整结束",
};
const duration = (value) => (value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`);
const time = (value) => new Date(value).toLocaleTimeString("zh-CN", { hour12: false });
const count = (value, prefix = "") => (Number.isFinite(value) ? `${prefix}${value.toLocaleString("zh-CN")}` : "—");
const rate = (value, prefix = "") => (Number.isFinite(value) ? `${prefix}${value.toFixed(1)}` : "—");

function renderStatistics() {
	const run = state.run;
	const stats = run?.statistics;
	if (!stats) {
		for (const key of ["total", "input", "output", "tps", "first", "cache"]) elements[`stat-${key}`].textContent = "—";
		elements["stats-note"].textContent = run
			? "请在 Pi 执行 /reload，再打开 /trace 以启用统计。"
			: "生成中以 ≈ 标记估算值，结束后以模型返回的统计为准。";
		return;
	}
	const prefix = stats.estimatedModels > 0 ? "≈ " : stats.unknownModels > 0 ? "≥ " : "";
	const input =
		stats.inputTokens === undefined
			? undefined
			: stats.inputTokens + (stats.cacheReadTokens ?? 0) + (stats.cacheWriteTokens ?? 0);
	elements["stat-total"].textContent = count(stats.totalTokens, prefix);
	elements["stat-input"].textContent = count(input, stats.estimatedModels + stats.unknownModels > 0 ? "≥ " : "");
	elements["stat-input"].title =
		`普通输入 ${count(stats.inputTokens)} · 缓存读取 ${count(stats.cacheReadTokens)} · 缓存写入 ${count(stats.cacheWriteTokens)}`;
	elements["stat-output"].textContent = count(stats.outputTokens, prefix);
	elements["stat-tps"].textContent = rate(stats.outputTps, prefix);
	elements["stat-first"].textContent = stats.firstResponseMs === undefined ? "—" : duration(stats.firstResponseMs);
	elements["stat-cache"].textContent =
		stats.cacheHitRate === undefined ? "—" : `${(stats.cacheHitRate * 100).toFixed(1)}%`;
	elements["stats-scope"].textContent =
		`模型 ${stats.models} 轮 · 工具 ${stats.tools} 次${stats.toolErrors ? ` · 工具失败 ${stats.toolErrors} 次` : ""}`;
	elements["stats-note"].textContent =
		stats.estimatedModels > 0
			? "≈ 为流式内容粗估，结束后校准。当前轮次未上报的输入 tokens 暂不计入。"
			: stats.unknownModels > 0
				? "≥ 为已知用量；部分模型轮次未返回 tokens 统计。TPS 包含首段等待。"
				: "用量来自模型返回；输入含缓存。TPS 包含首段等待，不包含工具耗时。";
}

async function api(path, options = {}) {
	const response = await fetch(path, {
		...options,
		headers: { "X-Trace-Token": token, "Content-Type": "application/json", ...options.headers },
	});
	const data = await response.json();
	if (!response.ok) throw new Error(data.error || `请求失败 ${response.status}`);
	return data;
}

function element(tag, className, text) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

const jsonViews = {
	input: new JsonViewer(elements["node-input"], "输入"),
	output: new JsonViewer(elements["node-output"], "输出"),
	attempts: new JsonViewer(elements["node-attempts"], "模型请求尝试"),
};

function renderRuns() {
	const groups = new Map();
	for (const run of state.runs) {
		const sessionId = run.sessionId || run.id;
		if (!groups.has(sessionId)) groups.set(sessionId, []);
		groups.get(sessionId).push(run);
	}
	const signature = JSON.stringify([
		state.runId,
		state.runs.map((run) => [run.id, run.sessionId, run.cwd, run.prompt, run.status, run.startedAt, run.endedAt]),
	]);
	if (signature === state.historySignature) return;
	for (const group of elements.runs.querySelectorAll(".session-group"))
		state.sessionOpen.set(group.dataset.sessionId, group.open);
	state.historySignature = signature;
	elements.runs.replaceChildren();
	elements["run-count"].textContent = `${groups.size} 会话 · ${state.runs.length} 请求`;
	if (!state.runs.length) {
		elements.runs.append(element("div", "empty", "还没有轨迹。在 Pi 中提交一次任务即可。"));
		return;
	}
	const ordered = [...groups.entries()]
		.map(([id, runs]) => ({ id, runs: runs.sort((a, b) => b.startedAt - a.startedAt) }))
		.sort((a, b) => b.runs[0].startedAt - a.runs[0].startedAt);
	for (const { id, runs } of ordered) {
		const latest = runs[0];
		const earliest = runs.at(-1);
		const group = element("details", "session-group");
		group.dataset.sessionId = id;
		const selected = runs.some((run) => run.id === state.runId);
		group.classList.toggle("session-selected", selected);
		group.open = state.sessionOpen.has(id)
			? state.sessionOpen.get(id)
			: selected || runs.some((run) => run.status === "running");
		const summary = element("summary");
		const heading = element("span", "session-heading");
		const title =
			earliest.prompt
				.split("\n")
				.find((line) => line.trim())
				?.trim() || "未命名会话";
		heading.append(element("span", "session-title", title), element("span", "session-count", `${runs.length} 条`));
		const meta = element("span", "session-meta");
		const folder = latest.cwd.split(/[\\/]/).filter(Boolean).at(-1) || latest.cwd;
		const location = element(
			"span",
			"session-folder",
			`${folder} · ${new Date(latest.startedAt).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" })}`,
		);
		location.title = latest.cwd;
		const identity = element("span", "session-id", id.slice(0, 8));
		identity.title = id;
		meta.append(location, identity);
		summary.append(heading, meta);
		summary.setAttribute("aria-label", `会话 ${title}，${runs.length} 条请求，${folder}，${id.slice(0, 8)}`);
		const list = element("div", "session-requests");
		for (const run of runs) {
			const button = element("button", "request");
			button.type = "button";
			button.dataset.runId = run.id;
			button.setAttribute("aria-pressed", String(run.id === state.runId));
			button.append(element("span", "request-title", run.prompt));
			const info = element("span", "request-info");
			info.append(
				element("span", "", time(run.startedAt)),
				element("span", `status-${run.status}`, labels[run.status]),
			);
			if (run.endedAt) info.append(element("span", "", duration(run.endedAt - run.startedAt)));
			button.append(info);
			button.addEventListener("click", async () => {
				state.runId = run.id;
				state.spanId = null;
				state.revision = -1;
				state.sessionOpen.set(id, true);
				renderRuns();
				await loadRun();
			});
			list.append(button);
		}
		group.append(summary, list);
		group.addEventListener("toggle", () => {
			if (elements.runs.contains(group)) state.sessionOpen.set(id, group.open);
		});
		elements.runs.append(group);
	}
}

function timelineRows(run, now = Date.now()) {
	const byId = new Map(run.spans.map((span) => [span.id, span]));
	const end = Math.max(
		run.startedAt,
		run.endedAt ?? run.startedAt,
		run.status === "running" ? now : run.startedAt,
		...run.spans.map((span) => span.endedAt ?? span.startedAt + (span.durationMs ?? 0)),
	);
	const range = Math.max(1, end - run.startedAt);
	return [...run.spans]
		.sort((a, b) => a.startedAt - b.startedAt)
		.map((span) => {
			const active = span.status === "running" && run.status === "running";
			const status = span.status === "running" && !active ? "interrupted" : span.status;
			const elapsedMs = Number.isFinite(span.durationMs)
				? Math.max(0, span.durationMs)
				: span.endedAt !== undefined
					? Math.max(0, span.endedAt - span.startedAt)
					: active
						? Math.max(0, now - span.startedAt)
						: undefined;
			let depth = 0;
			let parent = byId.get(span.parentId);
			const visited = new Set([span.id]);
			while (parent && !visited.has(parent.id)) {
				visited.add(parent.id);
				depth++;
				parent = byId.get(parent.parentId);
			}
			const offsetMs = Math.max(0, span.startedAt - run.startedAt);
			return {
				span,
				status,
				elapsedMs,
				offsetMs,
				depth,
				startPercent: Math.min(100, (offsetMs * 100) / range),
				durationPercent:
					elapsedMs === undefined ? 0 : (Math.min(range - Math.min(offsetMs, range), elapsedMs) * 100) / range,
			};
		});
}

const timelineDuration = (milliseconds) =>
	milliseconds >= 60000
		? `${Math.floor(milliseconds / 60000)}m ${Math.floor((milliseconds % 60000) / 1000)}s`
		: duration(milliseconds);

function renderGraph() {
	const run = state.run;
	const scrollTop = elements.graph.scrollTop;
	const focused = document.activeElement?.closest(".flow-node")?.dataset.spanId;
	elements.graph.replaceChildren();
	if (!run) return;
	elements["run-title"].textContent = run.prompt;
	elements["run-meta"].textContent =
		`${run.cwd} · ${time(run.startedAt)}${run.truncated ? " · 轨迹达到记录上限，部分内容省略" : ""}`;
	elements["run-status"].textContent = labels[run.status];
	const rows = timelineRows(run);
	elements["timeline-count"].textContent = `${rows.length} 步 · 时间条表示开始位置与耗时`;
	elements["timeline-jump"].hidden = !rows.length;
	elements["timeline-jump"].textContent = rows.some((row) => row.status === "running")
		? "定位当前步骤"
		: "定位选中步骤";
	const heading = element("div", "timeline-head");
	heading.setAttribute("aria-hidden", "true");
	for (const text of ["距开始", "", "步骤", "状态 / 耗时"]) heading.append(element("span", "", text));
	const list = element("ol", "timeline-list");
	list.setAttribute("aria-label", "按开始时间排列的执行步骤");
	const shortStatus = { completed: "完成", running: "运行", error: "失败", aborted: "取消", interrupted: "中断" };
	for (const row of rows) {
		const { span } = row;
		const item = element("li", "timeline-entry");
		const button = element("button", "flow-node");
		button.type = "button";
		button.dataset.spanId = span.id;
		button.dataset.depth = String(Math.min(row.depth, 4));
		button.dataset.status = row.status;
		button.setAttribute("aria-pressed", String(span.id === state.spanId));
		const elapsed = row.elapsedMs === undefined ? "—" : timelineDuration(row.elapsedMs);
		const description = `${span.name} · ${labels[row.status] ?? row.status} · 距开始 ${timelineDuration(row.offsetMs)} · 耗时 ${elapsed}`;
		button.setAttribute("aria-label", description);
		button.title = description;
		const offset = element("span", "timeline-offset", `+${timelineDuration(row.offsetMs)}`);
		offset.title = new Date(span.startedAt).toLocaleTimeString("zh-CN", { hour12: false, fractionalSecondDigits: 3 });
		const marker = element("span", "timeline-marker");
		marker.setAttribute("aria-hidden", "true");
		const main = element("span", "timeline-main");
		const name =
			span.kind === "model" && span.turnIndex !== undefined
				? `第 ${span.turnIndex + 1} 轮 · ${span.name.replace(/^模型请求\s*·\s*/, "")}`
				: span.name;
		main.append(element("span", "node-name", name));
		if (row.elapsedMs !== undefined && row.elapsedMs > 0) {
			const track = element("span", "timeline-track");
			track.setAttribute("aria-hidden", "true");
			const bar = element("span", "timeline-bar");
			bar.style.marginLeft = `${row.startPercent}%`;
			bar.style.width = `${row.durationPercent}%`;
			track.append(bar);
			main.append(track);
		}
		button.append(
			offset,
			marker,
			main,
			element("span", `node-timing status-${row.status}`, `${shortStatus[row.status] ?? row.status} ${elapsed}`),
		);
		button.addEventListener("click", () => {
			state.spanId = span.id;
			renderGraph();
			renderDetail();
		});
		item.append(button);
		list.append(item);
	}
	elements.graph.append(heading, list);
	elements.graph.scrollTop = scrollTop;
	if (focused)
		[...elements.graph.querySelectorAll(".flow-node")]
			.find((button) => button.dataset.spanId === focused)
			?.focus({ preventScroll: true });
}

elements["timeline-jump"].addEventListener("click", () => {
	if (!state.run) return;
	const rows = timelineRows(state.run);
	const target =
		rows.findLast((row) => row.status === "running")?.span ??
		rows.find((row) => row.span.id === state.spanId)?.span ??
		rows.at(-1)?.span;
	if (!target) return;
	state.spanId = target.id;
	renderGraph();
	renderDetail();
	const button = [...elements.graph.querySelectorAll(".flow-node")].find(
		(button) => button.dataset.spanId === target.id,
	);
	button?.scrollIntoView?.({ block: "center" });
	button?.focus({ preventScroll: true });
});

function selectedSpan() {
	return state.run?.spans.find((span) => span.id === state.spanId);
}

function renderDetail() {
	const span = selectedSpan();
	if (!span) {
		elements["node-title"].textContent = "点击流程中的节点";
		elements["node-meta"].replaceChildren();
		elements["node-metrics"].hidden = true;
		jsonViews.input.setValue(undefined, "empty");
		jsonViews.output.setValue(undefined, "empty");
		return;
	}
	const timing = timelineRows(state.run).find((row) => row.span.id === span.id);
	const status = timing?.status ?? span.status;
	elements["node-title"].textContent = span.name;
	elements["node-kind"].textContent = labels[span.kind];
	elements["node-meta"].replaceChildren();
	const parent = state.run.spans.find((item) => item.id === span.parentId);
	for (const [key, value] of [
		["状态", labels[status]],
		["开始", time(span.startedAt)],
		["耗时", timing?.elapsedMs === undefined ? "—" : duration(timing.elapsedMs)],
		["父节点", parent?.name ?? span.parentId ?? "任务入口"],
	]) {
		const item = element("div", "node-meta-item");
		const detail = element("dd", "", value);
		if (key === "父节点" && span.parentId) detail.title = span.parentId;
		item.append(element("dt", "", key), detail);
		elements["node-meta"].append(item);
	}
	const metrics = span.statistics;
	elements["node-metrics"].hidden = span.kind !== "model" || !metrics;
	elements["node-metrics"].replaceChildren();
	if (span.kind === "model" && metrics) {
		const prefix = metrics.estimated ? "≈ " : "";
		const input = metrics.usage ? metrics.usage.input + metrics.usage.cacheRead + metrics.usage.cacheWrite : undefined;
		for (const [label, value, hint] of [
			["输入 tokens", count(input), "含普通输入、缓存读取及缓存写入。"],
			["输出 tokens", count(metrics.outputTokens, prefix), "包含思考和工具参数；≈ 为流式内容粗估。"],
			["输出 TPS", rate(metrics.outputTps, prefix), "输出 tokens ÷ 本轮请求耗时，包含首段等待。"],
			["生成阶段 TPS", rate(metrics.generationTps, prefix), "输出 tokens ÷ 首段到末段内容时间；只有一个片段时不计算。"],
			[
				"首段响应",
				metrics.firstResponseMs === undefined ? "—" : duration(metrics.firstResponseMs),
				"从本轮开始到首个内容片段。",
			],
			["缓存读取", count(metrics.usage?.cacheRead), "模型报告的缓存读取 tokens。"],
		]) {
			const entry = element("div");
			const name = element("dt", "", label);
			name.title = hint;
			entry.append(name, element("dd", "", value));
			elements["node-metrics"].append(entry);
		}
	}
	const identity = `${state.runId}/${span.id}`;
	jsonViews.input.setValue(span.input, identity);
	jsonViews.output.setValue(status === "running" ? "正在执行，完成后显示结果。" : span.output, identity);
	elements["attempts-view"].hidden = !span.attempts?.length;
	jsonViews.attempts.setValue(span.attempts, identity);
	if (state.tab === "source") void loadSource(span);
}

async function loadSource(span) {
	const id = span.id;
	try {
		const source = await api(`/api/source?kind=${encodeURIComponent(span.kind)}`);
		if (id !== state.spanId || state.tab !== "source") return;
		elements["source-location"].textContent =
			`${source.file}${source.line ? `:${source.line}` : ""} · ${source.symbol} · 按阶段关联`;
		elements["source-code"].textContent = source.available
			? source.code
			: "未找到 Pi 源码。可在启动 Pi 时设置 PI_RUN_TRACE_SOURCE_ROOT 指向源码目录。";
	} catch (error) {
		elements["source-code"].textContent = error.message;
	}
}

async function loadRun() {
	if (!state.runId) return;
	const id = state.runId;
	const run = await api(`/api/runs/${encodeURIComponent(id)}`);
	if (state.runId !== id) return;
	if (run.revision === state.revision && run.status !== "running") return;
	state.run = run;
	state.revision = run.revision;
	if (!run.spans.some((span) => span.id === state.spanId))
		state.spanId = run.spans.findLast((span) => span.kind === "tool" || span.kind === "model")?.id ?? run.spans[0]?.id;
	renderGraph();
	renderDetail();
	renderStatistics();
}

async function poll() {
	if (state.polling || document.hidden) return;
	state.polling = true;
	try {
		const data = await api("/api/runs");
		const previous = state.runId;
		state.runs = data.runs;
		if (!state.runId || !state.runs.some((run) => run.id === state.runId))
			state.runId = data.activeId ?? state.runs[0]?.id;
		if (previous !== state.runId) state.revision = -1;
		renderRuns();
		await loadRun();
		elements.connection.textContent = data.error
			? "记录写入失败，请查看 Pi"
			: data.activeId
				? "已连接 · 正在记录"
				: "已连接 · 等待任务";
	} catch (error) {
		elements.connection.textContent = `连接未就绪：${error.message}`;
	} finally {
		state.polling = false;
	}
}

for (const button of document.querySelectorAll("[data-tab]")) {
	button.addEventListener("click", () => {
		state.tab = button.dataset.tab;
		for (const tab of document.querySelectorAll("[data-tab]"))
			tab.setAttribute("aria-selected", String(tab === button));
		elements["detail-panel"].setAttribute("aria-labelledby", button.id);
		for (const name of ["data", "source", "ask"]) elements[`${name}-view`].hidden = name !== state.tab;
		renderDetail();
	});
}
for (const button of document.querySelectorAll("[data-question]"))
	button.addEventListener("click", () => {
		elements.question.value = button.dataset.question;
		elements.question.focus();
	});
elements["ask-form"].addEventListener("submit", async (event) => {
	event.preventDefault();
	const span = selectedSpan();
	const question = elements.question.value.trim();
	if (!span || !question) {
		elements["ask-status"].textContent = "请选择节点并填写问题。";
		return;
	}
	elements["send-question"].disabled = true;
	try {
		await api("/api/ask", { method: "POST", body: JSON.stringify({ runId: state.runId, spanId: span.id, question }) });
		elements["ask-status"].textContent = "已发送到当前 Pi 会话。回答会形成一条新的运行轨迹。";
	} catch (error) {
		elements["ask-status"].textContent = error.message;
	} finally {
		elements["send-question"].disabled = false;
	}
});
void poll();
setInterval(() => {
	void poll();
}, 1000);
