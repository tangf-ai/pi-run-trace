import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function fauxExtension(pi: ExtensionAPI): void {
	const faux = createFauxCore({
		provider: "run-trace-faux",
		api: "run-trace-faux",
		models: [{ id: "flow-test" }],
		tokensPerSecond: 10000,
	});
	const model = faux.getModel();
	faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("read", { path: "seed.txt" }, { id: "trace-read" }),
				fauxToolCall(
					"bash",
					{ command: "printf 'expected trace test failure\\n'; exit 7" },
					{ id: "trace-failed-check" },
				),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(fauxToolCall("trace_parent", {}, { id: "trace-parent" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("轨迹测试完成：已读取文件、记录预期失败，并完成嵌套工具调用。"),
		fauxAssistantMessage("节点问答测试完成：工具错误已交回模型，后续轮次继续处理。"),
	]);
	pi.registerProvider("run-trace-faux", {
		api: faux.api,
		apiKey: "local-faux-only",
		baseUrl: model.baseUrl,
		streamSimple: faux.streamSimple,
		models: [
			{
				id: model.id,
				name: "本地轨迹测试",
				reasoning: false,
				input: ["text"],
				contextWindow: 200000,
				maxTokens: 4096,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		],
	});
	pi.registerTool(
		defineTool({
			name: "trace_parent",
			label: "轨迹嵌套测试",
			description: "Local deterministic nested read for trace testing",
			parameters: Type.Object({}),
			async execute(_id, _params, _signal, _onUpdate, ctx) {
				const result = await ctx.executeTool("read", { path: "seed.txt" });
				return { content: result.result.content, details: { nested: true } };
			},
		}),
	);
}
