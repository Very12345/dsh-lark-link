// Site preview — lifecycle manager per conversation: create / reuse /
// restart / replace decisions (site-preview-core), tunnel + static server
// processes (site-preview-net), and a persisted registry so a plugin reload
// can adopt still-running tunnels instead of churning URLs.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	decidePreviewAction,
	DEFAULT_PREVIEW_TTL_MS,
	normalizePreviewTarget,
	type PreviewEntry,
	type PreviewTarget,
	type PublishRequest,
	type PublishResult,
} from "./site-preview-core.ts";
import { startStaticServer, startTunnelProcess } from "./site-preview-net.ts";
import type { Logger } from "../common/logger.ts";

export interface SitePreviewDeps {
	stateDir: string;
	logger: Logger;
	ttlMs?: number;
	now?: () => number;
	startTunnel?: (
		localUrl: string,
		logPath: string,
	) => Promise<{ pid: number; publicUrl: string; stop: () => void }>;
	startStatic?: (
		dir: string,
		logger: Logger,
	) => Promise<{ port: number; stop: () => void }>;
}

interface RuntimeEntry extends PreviewEntry {
	stopTunnel?: () => void;
	stopServer?: () => void;
}

export interface SitePreviewManager {
	publish(req: PublishRequest): Promise<PublishResult>;
	refresh(convKey: string, chatId?: string): Promise<PublishResult>;
	stop(convKey: string): void;
	stopAll(): void;
	get(convKey: string): PreviewEntry | undefined;
}

export function createSitePreviewManager(deps: SitePreviewDeps): SitePreviewManager {
	const ttlMs = deps.ttlMs ?? DEFAULT_PREVIEW_TTL_MS;
	const now = deps.now ?? (() => Date.now());
	const registryPath = join(deps.stateDir, "site-previews.json");
	const entries = new Map<string, RuntimeEntry>();
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	const logFileFor = (convKey: string) =>
		join(deps.stateDir, `preview-tunnel-${convKey.replace(/[^a-z0-9]/gi, "-")}.log`);

	const persist = (): void => {
		try {
			const rows = [...entries.values()].map((entry) => {
				const { stopTunnel: _t, stopServer: _s, ...rest } = entry;
				return rest;
			});
			writeFileSync(registryPath, JSON.stringify(rows, null, 2), { mode: 0o600 });
		} catch (err) {
			deps.logger.warn(`preview registry persist failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	};

	const pidAlive = (pid?: number): boolean => {
		if (!pid) return false;
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};

	const teardown = (entry: RuntimeEntry): void => {
		const timer = timers.get(entry.convKey);
		if (timer) clearTimeout(timer);
		timers.delete(entry.convKey);
		entry.stopTunnel?.();
		entry.stopServer?.();
		entries.delete(entry.convKey);
	};

	const scheduleExpiry = (entry: RuntimeEntry): void => {
		const timer = setTimeout(() => {
			deps.logger.info(`preview expired for ${entry.convKey} — tearing down`);
			teardown(entry);
			persist();
		}, Math.max(0, entry.expiresAt - now()));
		timer.unref?.();
		timers.set(entry.convKey, timer);
	};

	const startAll = async (entry: RuntimeEntry): Promise<void> => {
		let localUrl = entry.localUrl;
		let stopServer: (() => void) | undefined;
		if (entry.kind === "dir" && entry.serveDir) {
			const staticServer = await (deps.startStatic ?? startStaticServer)(
				entry.serveDir,
				deps.logger,
			);
			localUrl = `http://127.0.0.1:${staticServer.port}`;
			entry.serverPort = staticServer.port;
			stopServer = staticServer.stop;
		}
		const tunnel = await (deps.startTunnel ?? startTunnelProcess)(
			localUrl,
			logFileFor(entry.convKey),
			deps.logger,
		);
		entry.localUrl = localUrl;
		entry.publicUrl = `${tunnel.publicUrl}${entry.pathSuffix ?? ""}`;
		entry.debugUrl = `${entry.publicUrl}${entry.publicUrl.includes("?") ? "&" : "?"}debug=1`;
		entry.tunnelPid = tunnel.pid;
		entry.startedAt = now();
		entry.expiresAt = now() + ttlMs;
		entry.stopTunnel = tunnel.stop;
		entry.stopServer = stopServer;
	};

	// Adopt persisted entries whose tunnel process is still alive (a plugin
	// reload does not kill its children): the link stays valid and a publish
	// for the same target reuses it instead of churning URLs.
	try {
		const rows = JSON.parse(readFileSync(registryPath, "utf8")) as RuntimeEntry[];
		for (const row of rows) {
			if (row.expiresAt > now() && pidAlive(row.tunnelPid)) {
				const adopted: RuntimeEntry = {
					...row,
					stopTunnel: () => {
						try {
							process.kill(row.tunnelPid!, "SIGTERM");
						} catch {
							/* already gone */
						}
					},
				};
				entries.set(row.convKey, adopted);
				scheduleExpiry(adopted);
			}
		}
		if (entries.size) {
			deps.logger.info(`site preview: adopted ${entries.size} live tunnel(s) after reload`);
		}
	} catch {
		// first run — no registry yet
	}

	return {
		async publish(req) {
			const target: PreviewTarget = normalizePreviewTarget(req);
			const existing = entries.get(req.convKey);
			const alive = Boolean(
				existing && pidAlive(existing.tunnelPid) && existing.expiresAt > now(),
			);
			const action = decidePreviewAction(
				existing && { target: existing.target, expiresAt: existing.expiresAt },
				target.target,
				alive,
				now(),
			);
			// Same target, tunnel healthy: the previous link is still the best
			// answer — do not churn URLs (the chat already has a card for it).
			if (action === "reuse" && existing) {
				existing.chatId = req.chatId || existing.chatId;
				if (req.title) existing.title = req.title;
				persist();
				return {
					action: "复用",
					publicUrl: existing.publicUrl,
					debugUrl: existing.debugUrl,
					expiresAt: existing.expiresAt,
					title: existing.title,
					label: existing.label,
					target: existing.target,
				};
			}
			// create / replace / restart — tear down whatever is running first.
			if (existing) teardown(existing);
			const entry: RuntimeEntry = {
				convKey: req.convKey,
				chatId: req.chatId,
				kind: target.kind,
				target: target.target,
				localUrl: target.localUrl,
				publicUrl: "",
				debugUrl: "",
				title: req.title || target.label,
				label: target.label,
				startedAt: now(),
				expiresAt: now() + ttlMs,
				...(target.serveDir ? { serveDir: target.serveDir } : {}),
				...(target.pathSuffix ? { pathSuffix: target.pathSuffix } : {}),
			};
			entries.set(req.convKey, entry);
			try {
				await startAll(entry);
			} catch (err) {
				teardown(entry);
				throw err;
			}
			scheduleExpiry(entry);
			persist();
			return {
				action: action === "restart" ? "刷新" : action === "replace" ? "替换" : "新建",
				publicUrl: entry.publicUrl,
				debugUrl: entry.debugUrl,
				expiresAt: entry.expiresAt,
				title: entry.title,
				label: entry.label,
				target: entry.target,
			};
		},

		async refresh(convKey, chatId) {
			const existing = entries.get(convKey);
			if (!existing) throw new Error("当前没有进行中的预览");
			const stale = { ...existing };
			teardown(existing);
			const entry: RuntimeEntry = { ...stale, chatId: chatId || stale.chatId };
			entries.set(convKey, entry);
			await startAll(entry);
			scheduleExpiry(entry);
			persist();
			return {
				action: "刷新",
				publicUrl: entry.publicUrl,
				debugUrl: entry.debugUrl,
				expiresAt: entry.expiresAt,
				title: entry.title,
				label: entry.label,
				target: entry.target,
			};
		},
		stop(convKey) {
			const entry = entries.get(convKey);
			if (entry) teardown(entry);
			persist();
		},
		stopAll() {
			for (const entry of [...entries.values()]) teardown(entry);
			persist();
		},
		get(convKey) {
			const entry = entries.get(convKey);
			return entry ? { ...entry } : undefined;
		},
	};
}
