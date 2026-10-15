import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SpanKind } from "./recorder.ts";

const locations: Record<SpanKind, { file: string; symbol: string; anchor: string }> = {
	input: {
		file: "packages/coding-agent/src/core/agent-session.ts",
		symbol: "AgentSession.prompt",
		anchor: "async prompt(text: string",
	},
	model: {
		file: "packages/agent/src/agent-loop.ts",
		symbol: "streamAssistantResponse",
		anchor: "async function streamAssistantResponse(",
	},
	tool: {
		file: "packages/agent/src/agent-loop.ts",
		symbol: "executePreparedToolCall",
		anchor: "async function executePreparedToolCall(",
	},
	compaction: { file: "packages/coding-agent/src/core/agent-session.ts", symbol: "compact", anchor: "async compact(" },
	waiting: {
		file: "packages/coding-agent/src/core/extensions/runner.ts",
		symbol: "ExtensionRunner",
		anchor: "export class ExtensionRunner",
	},
	lifecycle: { file: "packages/agent/src/agent-loop.ts", symbol: "runLoop", anchor: "async function runLoop(" },
};

export async function readSource(
	root: string | undefined,
	kind: SpanKind,
): Promise<{ file: string; symbol: string; line?: number; code?: string; available: boolean }> {
	const location = locations[kind];
	if (!location) throw new Error("未知源码类型");
	if (!root) return { ...location, available: false };
	try {
		const lines = (await readFile(join(root, location.file), "utf8")).split("\n");
		const index = lines.findIndex((line) => line.includes(location.anchor));
		if (index < 0) return { ...location, available: false };
		return {
			file: location.file,
			symbol: location.symbol,
			line: index + 1,
			code: lines
				.slice(index, index + 34)
				.map((line, offset) => `${index + offset + 1}  ${line}`)
				.join("\n"),
			available: true,
		};
	} catch {
		return { ...location, available: false };
	}
}
