// Site preview — pure decision/target layer. The agent calls lark_publish_site
// with a url/port/dir; the manager owns tunnels and the registry. Links are
// ephemeral: the tunnel exits with the TTL.
import { existsSync, statSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

export const DEFAULT_PREVIEW_TTL_MS = 2 * 60 * 60 * 1000; // 2h

export type PreviewAction = "create" | "reuse" | "restart" | "replace";

export interface PreviewTarget {
	kind: "port" | "dir" | "url";
	target: string;
	localUrl: string;
	pathSuffix?: string;
	serveDir?: string;
	label: string;
}

export interface PreviewEntry {
	convKey: string;
	/** Feishu chat the card goes to — absent for a non-Feishu (web GUI) publish. */
	chatId?: string;
	kind: PreviewTarget["kind"];
	target: string;
	localUrl: string;
	publicUrl: string;
	debugUrl: string;
	title: string;
	label: string;
	tunnelPid?: number;
	serverPort?: number;
	serveDir?: string;
	pathSuffix?: string;
	startedAt: number;
	expiresAt: number;
}

export interface PublishRequest {
	convKey: string;
	/** Omitted when the publishing session has no Feishu chat (web GUI). */
	chatId?: string;
	url?: string;
	port?: number;
	dir?: string;
	title?: string;
}

export interface PublishResult {
	action: string;
	publicUrl: string;
	debugUrl: string;
	expiresAt: number;
	title: string;
	label: string;
	target: string;
}

export function normalizePreviewTarget(req: {
	url?: string;
	port?: number;
	dir?: string;
}): PreviewTarget {
	const port = typeof req.port === "number" && req.port > 0 ? req.port : undefined;
	if (req.url && port) throw new Error("url 与 port 只能二选一");
	if (req.url && req.dir) throw new Error("url 与 dir 只能二选一");
	if (port && req.dir) throw new Error("port 与 dir 只能二选一");
	if (req.url) {
		const parsed = new URL(req.url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			throw new Error("url 必须是 http/https 地址");
		}
		const pathSuffix = parsed.pathname !== "/" ? parsed.pathname : undefined;
		const originPath = `${parsed.origin}${parsed.pathname.replace(/\/$/, "")}`;
		return {
			kind: "url",
			target: `url:${originPath}`,
			localUrl: parsed.origin,
			pathSuffix,
			label: `URL ${parsed.host}`,
		};
	}
	if (port) {
		return {
			kind: "port",
			target: `port:${port}`,
			localUrl: `http://127.0.0.1:${port}`,
			label: `开发服务器 :${port}`,
		};
	}
	if (req.dir) {
		const dir = resolve(req.dir);
		if (!existsSync(dir) || !statSync(dir).isDirectory()) {
			throw new Error(`目录不存在或不是目录: ${dir}`);
		}
		const real = realpathSync(dir);
		return {
			kind: "dir",
			target: `dir:${real}`,
			localUrl: "",
			serveDir: real,
			label: `静态目录 ${dir.split(/[\\/]/).pop() || dir}`,
		};
	}
	throw new Error("需要提供 url、port 或 dir 之一");
}

/** Pure decision: reuse / restart / replace / create, per conversation. */
export function decidePreviewAction(
	existing: Pick<PreviewEntry, "target" | "expiresAt"> | undefined,
	target: string,
	alive: boolean,
	now: number,
): PreviewAction {
	if (!existing) return "create";
	if (existing.target !== target) return "replace";
	if (!alive || existing.expiresAt <= now) return "restart";
	return "reuse";
}
