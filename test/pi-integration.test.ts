import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runStatistics } from "../src/metrics.ts";
import type { TraceRun } from "../src/recorder.ts";

test(
	"installed Pi runs three faux model turns with parallel and nested tools; no paid provider",
	{ timeout: 45000 },
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-run-trace-integration-"));
		try {
			await writeFile(join(directory, "seed.txt"), "Pi Run Trace fixture\n");
			const extension = fileURLToPath(new URL("../src/index.ts", import.meta.url));
			const faux = fileURLToPath(new URL("./faux-extension.ts", import.meta.url));
			const execution = promisify(execFile)(
				"pi",
				[
					"--offline",
					"--no-extensions",
					"--no-skills",
					"--no-prompt-templates",
					"--no-context-files",
					"--no-mcp",
					"-e",
					extension,
					"-e",
					faux,
					"--model",
					"run-trace-faux/flow-test",
					"--thinking",
					"off",
					"-p",
					"执行本地确定性轨迹测试",
				],
				{
					cwd: directory,
					env: { ...process.env, PI_CODING_AGENT_DIR: join(directory, "config"), PI_OFFLINE: "1" },
					timeout: 40000,
					maxBuffer: 1000000,
				},
			);
			execution.child.stdin?.end();
			const { stdout, stderr } = await execution;
			assert.ok(stdout.includes("轨迹测试完成"), `${stdout}\n${stderr}`);
			assert.ok(!stderr.includes("Failed to load extension"), stderr);
			const root = join(directory, "config", "run-trace", "runs");
			const files = (await readdir(root)).filter((file) => file.endsWith(".json"));
			assert.equal(files.length, 1);
			const run = JSON.parse(await readFile(join(root, files[0]), "utf8")) as TraceRun;
			assert.equal(run.status, "completed");
			assert.equal(run.spans.filter((span) => span.kind === "model").length, 3);
			assert.ok(
				run.spans.filter((span) => span.kind === "model").every((span) => (span.metrics?.usage?.output ?? 0) > 0),
			);
			assert.ok(run.spans.some((span) => (span.metrics?.chunks ?? 0) > 0));
			const statistics = runStatistics(run.spans);
			assert.equal(statistics.reportedModels, 3);
			assert.equal(statistics.estimatedModels, 0);
			assert.ok((statistics.totalTokens ?? 0) > 0);
			assert.equal(run.spans.find((span) => span.id === "trace-failed-check")?.status, "error");
			assert.ok(run.spans.some((span) => span.parentId === "trace-parent" && span.name === "read"));
			assert.ok(run.spans.find((span) => span.id === "trace-read")?.output);
			assert.ok(run.spans.filter((span) => span.kind === "tool").every((span) => typeof span.durationMs === "number"));
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
);
