export interface TokenUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	reasoning?: number;
}

export interface ModelMetrics {
	firstContentAt?: number;
	lastContentAt?: number;
	chunks: number;
	asciiCharacters: number;
	otherCharacters: number;
	estimatedOutputTokens: number;
	usage?: TokenUsage;
}

interface MetricSpan {
	kind: string;
	status: string;
	startedAt: number;
	endedAt?: number;
	durationMs?: number;
	metrics?: ModelMetrics;
	output?: unknown;
}

export interface SpanStatistics {
	usage?: TokenUsage;
	outputTokens?: number;
	estimated: boolean;
	requestMs: number;
	firstResponseMs?: number;
	outputTps?: number;
	generationTps?: number;
}

export interface RunStatistics {
	models: number;
	tools: number;
	toolErrors: number;
	reportedModels: number;
	estimatedModels: number;
	unknownModels: number;
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	cacheHitRate?: number;
	outputTps?: number;
	firstResponseMs?: number;
	modelTimeMs: number;
}

export function readUsage(value: unknown): TokenUsage | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const counts: Record<string, number> = {};
	for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
		const number = record[key];
		if (typeof number !== "number" || !Number.isFinite(number) || number < 0) return undefined;
		counts[key] = number;
	}
	const sum = counts.input + counts.output + counts.cacheRead + counts.cacheWrite;
	const total = record.totalTokens;
	const reasoning = record.reasoning;
	return {
		input: counts.input,
		output: counts.output,
		cacheRead: counts.cacheRead,
		cacheWrite: counts.cacheWrite,
		totalTokens: typeof total === "number" && Number.isFinite(total) && total >= sum ? total : sum,
		...(typeof reasoning === "number" && Number.isFinite(reasoning) && reasoning >= 0 ? { reasoning } : {}),
	};
}

export function spanStatistics(span: MetricSpan, now = Date.now()): SpanStatistics {
	const requestMs = Math.max(
		0,
		span.status === "running"
			? now - span.startedAt
			: (span.durationMs ?? (span.endedAt ?? span.startedAt) - span.startedAt),
	);
	const message = span.output && typeof span.output === "object" ? (span.output as Record<string, unknown>) : undefined;
	let usage = span.metrics?.usage ?? readUsage(message?.usage);
	// Pi initializes usage to zero, including on errors where the provider never reported usage.
	if (usage?.totalTokens === 0 && ["error", "aborted", "interrupted"].includes(span.status)) usage = undefined;
	const estimate = span.metrics?.estimatedOutputTokens;
	const outputTokens = usage?.output ?? (estimate && estimate > 0 ? estimate : undefined);
	const first = span.metrics?.firstContentAt;
	const firstResponseMs = first === undefined ? undefined : Math.max(0, first - span.startedAt);
	const generationMs =
		first === undefined
			? 0
			: Math.max(0, (span.status === "running" ? now : (span.metrics?.lastContentAt ?? first)) - first);
	return {
		usage,
		outputTokens,
		estimated: !usage && outputTokens !== undefined,
		requestMs,
		firstResponseMs,
		outputTps: outputTokens !== undefined && requestMs > 0 ? (outputTokens * 1000) / requestMs : undefined,
		generationTps:
			outputTokens !== undefined && (span.metrics?.chunks ?? 0) > 1 && generationMs > 0
				? (outputTokens * 1000) / generationMs
				: undefined,
	};
}

export function runStatistics(spans: readonly MetricSpan[], now = Date.now()): RunStatistics {
	const models = spans.filter((span) => span.kind === "model");
	const stats = models.map((span) => spanStatistics(span, now));
	const known = stats.filter((stat) => stat.outputTokens !== undefined);
	const reported = stats.filter((stat) => stat.usage !== undefined);
	const inputTokens = reported.reduce((sum, stat) => sum + (stat.usage?.input ?? 0), 0);
	const cacheReadTokens = reported.reduce((sum, stat) => sum + (stat.usage?.cacheRead ?? 0), 0);
	const cacheWriteTokens = reported.reduce((sum, stat) => sum + (stat.usage?.cacheWrite ?? 0), 0);
	const prefill = inputTokens + cacheReadTokens + cacheWriteTokens;
	const outputTokens = known.reduce((sum, stat) => sum + (stat.outputTokens ?? 0), 0);
	const modelTimeMs = stats.reduce((sum, stat) => sum + stat.requestMs, 0);
	return {
		models: models.length,
		tools: spans.filter((span) => span.kind === "tool").length,
		toolErrors: spans.filter((span) => span.kind === "tool" && span.status === "error").length,
		reportedModels: reported.length,
		estimatedModels: stats.filter((stat) => stat.estimated).length,
		unknownModels: stats.length - known.length,
		inputTokens: reported.length ? inputTokens : undefined,
		outputTokens: known.length ? outputTokens : undefined,
		totalTokens: known.length
			? stats.reduce((sum, stat) => sum + (stat.usage?.totalTokens ?? stat.outputTokens ?? 0), 0)
			: undefined,
		cacheReadTokens: reported.length ? cacheReadTokens : undefined,
		cacheWriteTokens: reported.length ? cacheWriteTokens : undefined,
		cacheHitRate: prefill > 0 ? cacheReadTokens / prefill : undefined,
		outputTps: known.length && modelTimeMs > 0 ? (outputTokens * 1000) / modelTimeMs : undefined,
		firstResponseMs: stats.at(-1)?.firstResponseMs,
		modelTimeMs,
	};
}
