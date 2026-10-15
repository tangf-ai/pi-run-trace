import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { SpanKind, TraceRecorder, TraceRun, TraceSpan } from "./recorder.ts";
import { readSource } from "./source.ts";

export interface ViewerOptions {
	recorder: TraceRecorder;
	sourceRoot?: string;
	onQuestion: (run: TraceRun, span: TraceSpan, question: string) => void | Promise<void>;
}

export class TraceViewer {
	private readonly options: ViewerOptions;
	private server?: Server;
	private baseUrl?: string;
	private readonly token = randomBytes(24).toString("hex");
	private starting?: Promise<string>;

	constructor(options: ViewerOptions) {
		this.options = options;
	}
	get url(): string | undefined {
		return this.baseUrl ? `${this.baseUrl}/#token=${this.token}` : undefined;
	}

	async start(): Promise<string> {
		if (this.url) return this.url;
		if (this.starting) return this.starting;
		this.starting = new Promise<string>((resolve, reject) => {
			const server = createServer((request, response) => {
				void this.handle(request, response).catch(() => {
					if (!response.headersSent) this.json(response, 500, { error: "请求处理失败" });
					else response.end();
				});
			});
			this.server = server;
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				const address = server.address();
				if (!address || typeof address === "string") {
					reject(new Error("无法获取本地地址"));
					return;
				}
				this.baseUrl = `http://127.0.0.1:${address.port}`;
				resolve(this.url ?? "");
			});
		});
		try {
			return await this.starting;
		} finally {
			this.starting = undefined;
		}
	}

	async close(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		this.baseUrl = undefined;
		if (server) {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	}

	private json(response: ServerResponse, status: number, data: unknown): void {
		response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
		response.end(JSON.stringify(data));
	}

	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		response.setHeader("X-Content-Type-Options", "nosniff");
		response.setHeader("Referrer-Policy", "no-referrer");
		response.setHeader(
			"Content-Security-Policy",
			"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
		);
		if (!this.baseUrl || request.headers.host !== new URL(this.baseUrl).host) {
			this.json(response, 403, { error: "仅允许本机访问" });
			return;
		}
		if (request.headers.origin && request.headers.origin !== this.baseUrl) {
			this.json(response, 403, { error: "来源不匹配" });
			return;
		}
		const url = new URL(request.url ?? "/", this.baseUrl);
		const assets: Record<string, [string, string]> = {
			"/": ["index.html", "text/html; charset=utf-8"],
			"/app.js": ["app.js", "text/javascript; charset=utf-8"],
			"/style.css": ["style.css", "text/css; charset=utf-8"],
		};
		if (request.method === "GET" && assets[url.pathname]) {
			const [file, contentType] = assets[url.pathname];
			const body = await readFile(new URL(`../public/${file}`, import.meta.url));
			response.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
			response.end(body);
			return;
		}
		const supplied = request.headers["x-trace-token"];
		if (
			typeof supplied !== "string" ||
			!/^[a-f0-9]{48}$/.test(supplied) ||
			!timingSafeEqual(Buffer.from(supplied), Buffer.from(this.token))
		) {
			this.json(response, 401, { error: "请从 Pi 的 /trace 命令打开查看器" });
			return;
		}
		if (request.method === "GET" && url.pathname === "/api/runs") {
			this.json(response, 200, {
				runs: await this.options.recorder.list(),
				activeId: this.options.recorder.active?.id,
				error: this.options.recorder.error,
			});
			return;
		}
		if (request.method === "GET" && url.pathname.startsWith("/api/runs/")) {
			const run = await this.options.recorder.read(url.pathname.slice(10));
			this.json(response, run ? 200 : 404, run ?? { error: "轨迹不存在" });
			return;
		}
		if (request.method === "GET" && url.pathname === "/api/source") {
			const kind = url.searchParams.get("kind") ?? "";
			if (!["input", "model", "tool", "compaction", "waiting", "lifecycle"].includes(kind)) {
				this.json(response, 400, { error: "未知源码类型" });
				return;
			}
			this.json(response, 200, await readSource(this.options.sourceRoot, kind as SpanKind));
			return;
		}
		if (request.method === "POST" && url.pathname === "/api/ask") {
			request.setEncoding("utf8");
			let body = "";
			for await (const chunk of request) {
				body += String(chunk);
				if (Buffer.byteLength(body) > 12000) {
					this.json(response, 413, { error: "问题过长" });
					return;
				}
			}
			let data: { runId?: unknown; spanId?: unknown; question?: unknown };
			try {
				data = JSON.parse(body);
			} catch {
				this.json(response, 400, { error: "问题格式不正确" });
				return;
			}
			if (
				!data ||
				typeof data !== "object" ||
				typeof data.runId !== "string" ||
				typeof data.spanId !== "string" ||
				typeof data.question !== "string" ||
				!data.question.trim() ||
				data.question.length > 2000
			) {
				this.json(response, 400, { error: "请选择节点并填写问题（最多 2000 字）" });
				return;
			}
			const run = await this.options.recorder.read(data.runId);
			const span = run?.spans.find((item) => item.id === data.spanId);
			if (!run || !span) {
				this.json(response, 404, { error: "节点不存在" });
				return;
			}
			await this.options.onQuestion(run, span, data.question.trim());
			this.json(response, 202, { accepted: true });
			return;
		}
		this.json(response, 404, { error: "地址不存在" });
	}
}
