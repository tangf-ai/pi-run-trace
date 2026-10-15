import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type ModelMetrics,
	type RunStatistics,
	readUsage,
	runStatistics,
	type SpanStatistics,
	spanStatistics,
} from "./metrics.ts";

export type SpanKind = "input" | "model" | "tool" | "compaction" | "waiting" | "lifecycle";
export type TraceStatus = "running" | "completed" | "error" | "aborted" | "interrupted";

export interface TraceSpan {
	id: string;
	parentId?: string;
	kind: SpanKind;
	name: string;
	startedAt: number;
	endedAt?: number;
	durationMs?: number;
	status: TraceStatus;
	input?: unknown;
	output?: unknown;
	turnIndex?: number;
	attempts?: { startedAt: number; status?: number; payload?: unknown }[];
	metrics?: ModelMetrics;
	statistics?: SpanStatistics;
}

export interface TraceRun {
	version: 1;
	id: string;
	sessionId: string;
	processId: number;
	cwd: string;
	prompt: string;
	startedAt: number;
	endedAt?: number;
	status: TraceStatus;
	revision: number;
	truncated: boolean;
	spans: TraceSpan[];
	statistics?: RunStatistics;
}

const secretKey =
	/^(authorization|proxy-authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|cookie|set-cookie)$/i;

export function sanitize(value: unknown, maxChars = 16000): unknown {
	let budget = maxChars;
	const seen = new WeakSet<object>();
	function visit(item: unknown, depth: number): unknown {
		if (budget <= 0) return "[内容已截断]";
		if (typeof item === "string") {
			const redacted = item
				.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [已隐藏]")
				.replace(/\bsk-[A-Za-z0-9_-]{12,}/g, "[已隐藏凭证]");
			const text = redacted.slice(0, budget);
			budget -= text.length;
			return text.length < redacted.length ? `${text}\n[内容已截断]` : text;
		}
		if (item === null || typeof item === "boolean" || typeof item === "number") return item;
		if (typeof item !== "object") return String(item ?? "");
		if (depth > 12) return "[结构过深]";
		if (seen.has(item)) return "[循环引用]";
		seen.add(item);
		if (Array.isArray(item)) return item.slice(0, 100).map((entry) => visit(entry, depth + 1));
		const result: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(item).slice(0, 100)) {
			if (key === "data" && typeof entry === "string" && entry.length > 1000) result[key] = "[二进制或图片内容省略]";
			else result[key] = secretKey.test(key) ? "[已隐藏]" : visit(entry, depth + 1);
			if (budget <= 0) {
				result.truncated = true;
				break;
			}
		}
		return result;
	}
	return visit(value, 0);
}

export class TraceRecorder {
	readonly directory: string;
	active?: TraceRun;
	private model?: TraceSpan;
	private sequence = 0;
	private pendingWrite: Promise<void> = Promise.resolve();
	private dirty = false;
	private lastFailure?: string;
	private readonly clock: () => number;

	constructor(directory: string, clock: () => number = Date.now) {
		this.directory = directory;
		this.clock = clock;
	}

	begin(sessionId: string, cwd: string, prompt: string): TraceRun {
		if (this.active && this.active.sessionId === sessionId) {
			this.add("input", "追加消息", { text: prompt });
			return this.active;
		}
		if (this.active) this.finish("interrupted");
		this.active = {
			version: 1,
			id: randomUUID(),
			sessionId,
			processId: process.pid,
			cwd,
			prompt: String(sanitize(prompt, 2000)),
			startedAt: this.clock(),
			status: "running",
			revision: 1,
			truncated: false,
			spans: [],
		};
		this.sequence = 0;
		this.model = undefined;
		this.add("input", "接收任务", { text: prompt });
		return this.active;
	}

	add(kind: SpanKind, name: string, input?: unknown, parentId?: string, id?: string): TraceSpan | undefined {
		const run = this.active;
		if (!run) return undefined;
		if (run.spans.length >= 512) {
			run.truncated = true;
			this.touch();
			return undefined;
		}
		const span: TraceSpan = {
			id: id ?? `${run.id}:${++this.sequence}`,
			kind,
			name,
			parentId,
			startedAt: this.clock(),
			status: kind === "input" || kind === "lifecycle" ? "completed" : "running",
			input: sanitize(input),
		};
		if (span.status === "completed") {
			span.endedAt = span.startedAt;
			span.durationMs = 0;
		}
		run.spans.push(span);
		this.touch();
		return span;
	}

	startTurn(turnIndex: number, provider?: string, modelId?: string): void {
		if (this.model?.status === "running") this.end(this.model, "interrupted", { reason: "下一轮开始时上一轮未完成" });
		this.model = this.add("model", `模型请求 · ${provider ?? ""}/${modelId ?? ""}`, undefined);
		if (this.model) {
			this.model.turnIndex = turnIndex;
			this.model.metrics = { chunks: 0, asciiCharacters: 0, otherCharacters: 0, estimatedOutputTokens: 0 };
		}
	}

	stream(delta: string): void {
		const model = this.model;
		const metrics = model?.metrics;
		if (!model || model.status !== "running" || !metrics) return;
		if (delta) {
			const now = this.clock();
			metrics.firstContentAt ??= now;
			metrics.lastContentAt = now;
			metrics.chunks++;
			for (const character of delta) {
				if (character.charCodeAt(0) < 128) metrics.asciiCharacters++;
				else metrics.otherCharacters++;
			}
			metrics.estimatedOutputTokens = Math.ceil(metrics.asciiCharacters / 4 + metrics.otherCharacters);
		}
		this.touch();
	}

	request(payload: unknown): void {
		if (!this.model || this.model.status !== "running") return;
		this.model.attempts ??= [];
		if (this.model.attempts.length < 16)
			this.model.attempts.push({ startedAt: this.clock(), payload: sanitize(payload, 8000) });
		this.touch();
	}

	response(status: number): void {
		const attempt = this.model?.attempts?.at(-1);
		if (attempt) {
			attempt.status = status;
			this.touch();
		}
	}

	context(messages: unknown): void {
		if (!this.model || this.model.status !== "running") return;
		this.model.input = sanitize(messages);
		this.touch();
	}

	modelEnd(message: {
		content: unknown;
		stopReason: string;
		usage?: unknown;
		errorMessage?: string;
		durationMs?: number;
	}): void {
		if (!this.model || this.model.status !== "running") return;
		const reported = readUsage(message.usage);
		if (
			this.model.metrics &&
			reported &&
			(reported.totalTokens > 0 || !["error", "aborted"].includes(message.stopReason))
		)
			this.model.metrics.usage = reported;
		const status =
			message.stopReason === "error" ? "error" : message.stopReason === "aborted" ? "aborted" : "completed";
		this.end(this.model, status, message, message.durationMs);
	}

	toolStart(id: string, name: string, args: unknown, parentId?: string): void {
		this.add("tool", name, args, parentId ?? this.model?.id, id);
	}

	toolEnd(id: string, result: unknown, isError: boolean, durationMs?: number): void {
		const span = this.active?.spans.find((item) => item.id === id);
		if (span) this.end(span, isError ? "error" : "completed", result, durationMs);
	}

	end(span: TraceSpan, status: TraceStatus, output?: unknown, durationMs?: number): void {
		span.status = status;
		span.endedAt = this.clock();
		span.durationMs = durationMs ?? span.endedAt - span.startedAt;
		span.output = sanitize(output);
		this.touch();
	}

	finish(status: TraceStatus = "completed"): void {
		const run = this.active;
		if (!run) return;
		for (const span of run.spans) {
			if (span.status === "running") this.end(span, status === "completed" ? "interrupted" : status);
		}
		run.status = status;
		run.endedAt = this.clock();
		this.touch();
		this.persist();
		this.active = undefined;
		this.model = undefined;
	}

	private touch(): void {
		if (this.active) this.active.revision++;
		this.dirty = true;
	}

	persist(): void {
		if (!this.active || !this.dirty) return;
		const snapshot = JSON.stringify(this.active);
		const id = this.active.id;
		this.dirty = false;
		this.pendingWrite = this.pendingWrite
			.then(async () => {
				await mkdir(this.directory, { recursive: true, mode: 0o700 });
				const target = join(this.directory, `${id}.json`);
				const temporary = `${target}.${process.pid}.tmp`;
				await writeFile(temporary, snapshot, { mode: 0o600 });
				await rename(temporary, target);
				this.lastFailure = undefined;
			})
			.catch((error) => {
				this.lastFailure = String(error);
			});
	}

	async flush(): Promise<void> {
		this.persist();
		await this.pendingWrite;
	}
	get error(): string | undefined {
		return this.lastFailure;
	}

	private snapshot(run: TraceRun): TraceRun {
		const copy = structuredClone(run);
		const now = this.clock();
		for (const span of copy.spans) if (span.kind === "model") span.statistics = spanStatistics(span, now);
		copy.statistics = runStatistics(copy.spans, now);
		return copy;
	}

	async read(id: string): Promise<TraceRun | undefined> {
		if (this.active?.id === id) return this.snapshot(this.active);
		if (!/^[a-f0-9-]{36}$/.test(id)) return undefined;
		try {
			const run = JSON.parse(await readFile(join(this.directory, `${id}.json`), "utf8")) as TraceRun;
			if (run.version !== 1 || run.id !== id || !Array.isArray(run.spans)) return undefined;
			if (run.status === "running") {
				try {
					process.kill(run.processId, 0);
				} catch {
					run.status = "interrupted";
				}
			}
			return this.snapshot(run);
		} catch {
			return undefined;
		}
	}

	async list(): Promise<Omit<TraceRun, "spans">[]> {
		let names: string[] = [];
		try {
			names = await readdir(this.directory);
		} catch {
			/* A new install has no history yet. */
		}
		const runs = await Promise.all(
			names.filter((name) => /^[a-f0-9-]{36}\.json$/.test(name)).map((name) => this.read(name.slice(0, -5))),
		);
		const unique = new Map(runs.filter((run): run is TraceRun => Boolean(run)).map((run) => [run.id, run]));
		if (this.active) unique.set(this.active.id, this.snapshot(this.active));
		return [...unique.values()]
			.sort((a, b) => b.startedAt - a.startedAt)
			.slice(0, 200)
			.map(({ spans: _spans, ...summary }) => summary);
	}
}
