import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sanitize, TraceRecorder } from "./recorder.ts";
import { TraceViewer } from "./server.ts";
import { readSource } from "./source.ts";

export default function runTrace(pi: ExtensionAPI): void {
	const configDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	const recorder = new TraceRecorder(join(configDir, "run-trace", "runs"));
	let enabled = true;
	let viewer: TraceViewer | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let context: ExtensionContext | undefined;
	let compactionId: string | undefined;
	let waitingId: string | undefined;
	let sawInitialUserMessage = false;

	function status(ctx: ExtensionContext): void {
		ctx.ui.setStatus("run-trace", enabled ? `运行轨迹${recorder.active ? " · 记录中" : " · 已启用"}` : undefined);
	}

	pi.on("session_start", (_event, ctx) => {
		context = ctx;
		if (recorder.active && recorder.active.sessionId !== ctx.sessionManager.getSessionId())
			recorder.finish("interrupted");
		status(ctx);
		timer ??= setInterval(() => recorder.persist(), 1000);
		timer.unref();
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (!enabled) return;
		context = ctx;
		sawInitialUserMessage = event.messageType !== "user";
		recorder.begin(
			ctx.sessionManager.getSessionId(),
			ctx.cwd,
			event.messageType === "user" ? event.prompt : JSON.stringify(sanitize(event.message.content)),
		);
		status(ctx);
	});
	pi.on("agent_start", () => {
		if (enabled) recorder.add("lifecycle", "执行循环开始");
	});
	pi.on("turn_start", (event, ctx) => {
		if (enabled) recorder.startTurn(event.turnIndex, ctx.model?.provider, ctx.model?.id);
	});
	pi.on("context_with_system", (event) => {
		if (enabled) recorder.context(event.messages);
	});
	pi.on("before_provider_request", (event) => {
		if (enabled) recorder.request(event.payload);
	});
	pi.on("after_provider_response", (event) => {
		if (enabled) recorder.response(event.status);
	});
	pi.on("message_update", (event) => {
		if (!enabled) return;
		const update = event.assistantMessageEvent;
		if (update.type === "text_delta" || update.type === "thinking_delta" || update.type === "toolcall_delta")
			recorder.stream(update.delta);
	});
	pi.on("message_end", (event) => {
		if (!enabled) return;
		if (event.message.role === "assistant") recorder.modelEnd(event.message);
		else if (event.message.role === "user" && recorder.active) {
			if (sawInitialUserMessage) recorder.add("input", "追加用户消息", event.message.content);
			sawInitialUserMessage = true;
		}
	});
	pi.on("tool_execution_start", (event) => {
		if (enabled) recorder.toolStart(event.toolCallId, event.toolName, event.args, event.parentToolCallId);
	});
	pi.on("tool_execution_end", (event) => {
		if (enabled) recorder.toolEnd(event.toolCallId, event.result, event.isError, event.durationMs);
	});
	pi.on("agent_end", () => {
		if (enabled) recorder.add("lifecycle", "本轮循环结束（可能继续）");
	});
	pi.on("agent_settled", (event, ctx) => {
		if (enabled) {
			const lastModel = recorder.active?.spans.findLast((span) => span.kind === "model");
			recorder.finish(event.aborted ? "aborted" : lastModel?.status === "error" ? "error" : "completed");
		}
		status(ctx);
	});
	pi.on("session_before_compact", (event) => {
		if (enabled) compactionId = recorder.add("compaction", "上下文压缩", { reason: event.reason })?.id;
	});
	pi.on("session_compact", (event) => {
		const span = recorder.active?.spans.find((item) => item.id === compactionId);
		if (span) recorder.end(span, "completed", event.compactionEntry);
		compactionId = undefined;
	});
	pi.on("session_compact_failed", (event) => {
		const span = recorder.active?.spans.find((item) => item.id === compactionId);
		if (span) recorder.end(span, "error", event);
		compactionId = undefined;
	});
	pi.on("ui_prompt_start", (event) => {
		if (enabled) waitingId = recorder.add("waiting", "等待用户输入", event)?.id;
	});
	pi.on("ui_prompt_end", () => {
		const span = recorder.active?.spans.find((item) => item.id === waitingId);
		if (span) recorder.end(span, "completed");
		waitingId = undefined;
	});

	pi.registerCommand("trace", {
		description: "查看运行流程、模型轮次、工具参数与结果（on/off/path/open）",
		getArgumentCompletions: (prefix) =>
			["on", "off", "path", "open"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			context = ctx;
			const command = args.trim();
			if (command === "off") {
				enabled = false;
				recorder.finish("interrupted");
				status(ctx);
				ctx.ui.notify("运行轨迹已暂停，历史记录保留。", "info");
				return;
			}
			if (command === "on") {
				enabled = true;
				status(ctx);
				ctx.ui.notify("运行轨迹已启用，从下一次任务开始记录。", "info");
				return;
			}
			if (command === "path") {
				ctx.ui.notify(recorder.directory, "info");
				return;
			}
			if (command && command !== "open") {
				ctx.ui.notify("用法：/trace [open|on|off|path]", "warning");
				return;
			}
			if (!viewer) {
				const candidates = [
					process.env.PI_RUN_TRACE_SOURCE_ROOT,
					ctx.cwd,
					resolve(fileURLToPath(new URL("../..", import.meta.url)), "pi"),
				];
				const sourceRoot = candidates.find(
					(candidate) => candidate && existsSync(join(candidate, "packages/agent/src/agent-loop.ts")),
				);
				viewer = new TraceViewer({
					recorder,
					sourceRoot,
					onQuestion: async (run, span, question) => {
						if (!context) throw new Error("Pi 会话已关闭");
						const detail = JSON.stringify(sanitize({ originalTask: run.prompt, node: span }, 12000), null, 2);
						const source = await readSource(sourceRoot, span.kind);
						const sourceDetail = source.available
							? `\n关联源码（按阶段映射）：${source.file}:${source.line}\n${source.code}`
							: "";
						if (!context) throw new Error("Pi 会话已关闭");
						pi.sendUserMessage(
							`请用中文解释这一步 Pi 运行轨迹。\n轨迹数据：\n${detail}${sourceDetail}\n我的问题：${question}\n请根据实际输入、输出和状态回答，区分观察到的事实与推断。`,
							{ deliverAs: "followUp" },
						);
					},
				});
			}
			const url = await viewer.start();
			ctx.ui.notify(`运行轨迹查看器：${url}`, "info");
			if (ctx.mode === "tui" && process.env.PI_RUN_TRACE_NO_OPEN !== "1") {
				const opener =
					process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
				const child = spawn(opener, [url], { stdio: "ignore", detached: true });
				child.on("error", () => ctx.ui.notify("请手动打开上面的查看器地址。", "info"));
				child.unref();
			}
		},
	});

	pi.on("session_shutdown", async () => {
		if (timer) clearInterval(timer);
		timer = undefined;
		recorder.finish("interrupted");
		await recorder.flush();
		await viewer?.close();
		viewer = undefined;
		context = undefined;
	});
}
