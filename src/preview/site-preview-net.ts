// Site preview — network plumbing (static server + cloudflared tunnel).
// Injectable in tests; Node stdlib only.
import { spawn, spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize } from "node:path";
import type { Logger } from "../common/logger.ts";

const MIME: Record<string, string> = {
	html: "text/html; charset=utf-8",
	js: "text/javascript",
	mjs: "text/javascript",
	css: "text/css; charset=utf-8",
	json: "application/json",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
	ico: "image/x-icon",
	wasm: "application/wasm",
	txt: "text/plain; charset=utf-8",
	map: "application/json",
	mp4: "video/mp4",
	wav: "audio/wav",
	mp3: "audio/mpeg",
};

export function startStaticServer(
	dir: string,
	logger: Logger,
): Promise<{ port: number; stop: () => void }> {
	const root = realpathSync(dir);
	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		try {
			const raw = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
			let file = normalize(join(root, raw));
			if (!file.startsWith(root)) {
				res.writeHead(403).end("forbidden");
				return;
			}
			if (existsSync(file) && statSync(file).isDirectory()) {
				file = join(file, "index.html");
			}
			if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
				res.writeHead(404).end("not found");
				return;
			}
			const ext = file.split(".").pop()?.toLowerCase() ?? "";
			res.writeHead(200, {
				"content-type": MIME[ext] ?? "application/octet-stream",
				"cache-control": "no-cache",
			});
			res.end(readFileSync(file));
		} catch (err) {
			logger.warn(`preview static server error: ${err instanceof Error ? err.message : String(err)}`);
			try {
				res.writeHead(500).end("error");
			} catch {
				/* already closed */
			}
		}
	});
	return new Promise((resolvePromise) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			resolvePromise({
				port: typeof address === "object" && address ? address.port : 0,
				stop: () => server.close(),
			});
		});
	});
}

function resolveCloudflared(): string {
	const candidates = [
		process.env.DSH_CLOUDFLARED,
		join(homedir(), ".local", "bin", "cloudflared"),
		"cloudflared",
	].filter(Boolean) as string[];
	for (const candidate of candidates) {
		if (candidate.includes("/") || candidate.includes("\\")) {
			if (existsSync(candidate)) return candidate;
		} else {
			const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
			if (!probe.error) return candidate;
		}
	}
	throw new Error("cloudflared 未安装（在主机上运行 scripts/install-cloudflared.sh）");
}

export function startTunnelProcess(
	localUrl: string,
	logPath: string,
	logger: Logger,
): Promise<{ pid: number; publicUrl: string; stop: () => void }> {
	const bin = resolveCloudflared();
	try {
		mkdirSync(logPath.slice(0, Math.max(logPath.lastIndexOf("/"), 0)), { recursive: true });
	} catch {
		/* log dir best-effort */
	}
	const child = spawn(bin, ["tunnel", "--url", localUrl, "--no-autoupdate"], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	const collect = (chunk: Buffer) => {
		output += String(chunk);
		if (output.length > 64 * 1024) output = output.slice(-32 * 1024);
	};
	child.stdout?.on("data", collect);
	child.stderr?.on("data", collect);
	const stop = () => {
		try {
			child.kill("SIGTERM");
		} catch {
			/* already gone */
		}
	};
	return new Promise((resolvePromise, rejectPromise) => {
		const started = Date.now();
		const poll = () => {
			const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(output);
			if (match) {
				resolvePromise({ pid: child.pid ?? 0, publicUrl: match[0], stop });
				return;
			}
			if (child.exitCode !== null) {
				rejectPromise(new Error(`cloudflared 提前退出：${output.slice(-200)}`));
				return;
			}
			if (Date.now() - started > 30_000) {
				stop();
				rejectPromise(new Error("cloudflared 30 秒内未建立隧道"));
				return;
			}
			setTimeout(poll, 500);
		};
		setTimeout(poll, 800);
	});
}
