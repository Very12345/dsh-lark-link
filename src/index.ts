// dsh-lark-link — Cordis bundle plugin entry (thin assembly layer, spec §3).
// Registers:
//   - bridge lifecycle (ctx.effect disposer → clean teardown on unload)
//   - /lark-* commands (ctx.commands)
//   - lark_send_local_file / lark_config_get tools (ctx.tools)
//   - system-prompt section telling the model it's bridged
//   - session/event fan-out → event-forwarder (streaming + durable outbox)
// The heavy logic lives in the layered modules; this file only wires them
// against the real DSH services. No approval/deny gates (user decision:
// 默认全放开).

import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createDshAdapter } from "./sessions/dsh-adapter.ts";
import { createMemoryDshBackend } from "./sessions/dsh-session-backend.ts";
import { createConversationManager } from "./sessions/conversation-manager.ts";
import { createConversationConfigStore } from "./sessions/conversation-config.ts";
import {
	listWorkspaceSessions,
	extractTitleFromEvents,
	resolveSessionsRoot,
	type WorkspaceSessionInfo,
} from "./sessions/workspace-sessions.ts";

import {
	deleteSession,
	listProjectCwds,
	moveSessionToProject,
	type SessionAdminDeps,
} from "./sessions/session-admin.ts";
import { createSessionAliasStore } from "./sessions/session-aliases.ts";
import { createTurnSupervisor } from "./sessions/turn-supervisor.ts";
import {
	createTaskRegistry,
	conversationKeyForSessionId,
	conversationKeyOf,
	type TaskRecord,
} from "./sessions/task-registry.ts";
import {
	ensureWorkspaceDir,
	isInsideWorkspace,
	resolveIsolatedWorkspace,
	userWorkspaceRoot,
} from "./common/user-workspace.ts";
import { formValuesOf } from "./application/card-action.ts";
import { createOutbox, type OutboxSender } from "./outbound/outbox.ts";
import { createEventForwarder } from "./outbound/event-forwarder.ts";
import {
	createCardKitStream,
	type CardKitStreamHandle,
} from "./outbound/cardkit-stream.ts";
import { createRouteStore } from "./outbound/outbound-router.ts";
import {
	createTransport,
	extractUploadKey,
	type FeishuClientLike,
} from "./inbound/transport.ts";
import { createConnectionSupervisor } from "./inbound/connection-supervisor.ts";
import { createMissedCompensation } from "./inbound/missed-compensation.ts";
import { createGroupTrigger } from "./inbound/group-trigger.ts";
import {
	createBridgeContext,
	type FeishuSender,
} from "./application/bridge-context.ts";
import { createMessageHandler } from "./application/message-handler.ts";
import { startMediaSweeper } from "./application/media-retention.ts";
import { createUserUsageStore } from "./application/user-usage.ts";
import {
	isModelAllowed,
	modelRef,
	normalizeModelRefs,
	parseModelRef,
	pickEffectiveDefault,
	type ModelSelection,
} from "./application/model-access.ts";
import {
	createCommandRouter,
	type DshCommandRegistry,
} from "./application/command-router.ts";
import { createDiagnosticsService } from "./application/diagnostics-service.ts";
import {
	formatStatusLine,
	statusDetailLines,
} from "./application/status-formatter.ts";
import { createStatusStore } from "./common/connection-status.ts";
import { createConfigStore, HOT_RELOADABLE, buildHotReloadPatch } from "./common/config.ts";
import { createLogger, type Logger } from "./common/logger.ts";
import { createDedupeStore } from "./common/dedupe-store.ts";
import { createInboundWal } from "./inbound/inbound-wal.ts";
import { createReplaySalvage } from "./inbound/replay-salvage.ts";
import { createQuotaGovernor } from "./common/quota-governor.ts";
import {
	helpCard,
	commandPanelCard,
	statusCard,
	newConfirmCard,
	stopResultCard,
	configPanelCard,
	larkAdminPanelCard,
	workspaceBrowserCard,
	workspaceNewFolderCard,
	markdownCard,
	looksLikeMarkdown,
	modeCard,
	modelCard,
	reasoningCard,
	permissionCard,
	questionCard,
	resumeCard,
	sessionManageCard,
	sessionManageDetailCard,
	sessionRenameCard,
	sessionMoveCard,
	sessionDeleteConfirmCard,
	taskListCard,
	taskBriefingCard,
	type TaskRow,
	type ManageableSession,
	withButtons,
	button,
	AGENT_PRESETS,
	PERMISSION_PRESETS,
	buildTaskBoardCard,
	buildGoalControlCard,
	buildGoalSetupCard,
	buildPlanReviewCard,
	buildSessionResumedCard,
	sitePreviewCard,
} from "./presentation/cards.ts";
import { createSitePreviewManager } from "./preview/site-preview-manager.ts";
import type { GoalSnapshotState, TodoItemState } from "./common/types.ts";
import { createTaskCardSyncer, type TaskCardSyncer } from "./outbound/task-card-syncer.ts";
import { createCommandPanelSync, type CommandPanelSync } from "./outbound/command-panel-sync.ts";



import { createAuthSetup, registerAppWithFetch } from "./host/auth-setup.ts";
import {
	resolveCredentials,
	persistCredentials,
	clearCredentials,
	normalizeManualCredentials,
	buildLarkClient,
	type CredentialsStore,
	type LarkDomain,
} from "./host/lark-client.ts";
import * as qrcode from "qrcode-terminal";
import QRCode from "qrcode";
import { homedir, hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
	resolveWorkspaceTarget,
	resolveInWorkspacePath,
	isAbsoluteAny,
	parentDirectory,
	sanitizeDirectoryName,
	decodeOpPath,
	BROWSER_ENTRY_LIMIT,
} from "./common/paths.ts";
import {
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	rmSync,
	existsSync,
} from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import type { FeishuInboundMessage } from "./common/types.ts";
import type { ReasoningEffortId } from "@deepseek-ai/dsh-llm";

export const name = "dsh-lark-link";
export const inject = [
	"tools",
	"commands",
	"agents",
	"systemPrompt",
	"credentials",
	"webServer",
];

export interface LarkLinkConfig {
	enabled?: boolean;
	groupPolicy?: "open" | "mention" | "keywords" | "reply";
	denyList?: string[];
}

type WebRequest = AsyncIterable<Uint8Array> & { method?: string };
type WebResponse = {
	writeHead(status: number, headers: Record<string, string>): unknown;
	end(body?: unknown): unknown;
};

async function readWebJson(req: unknown, limit = 16 * 1024): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req as WebRequest) {
		const bytes = Buffer.from(chunk);
		size += bytes.length;
		if (size > limit) throw new TypeError("请求内容过大");
		chunks.push(bytes);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new TypeError("请求 JSON 无效");
	}
}

function sendWebJson(res: unknown, status: number, value: unknown): void {
	const r = res as WebResponse;
	r.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
	});
	r.end(JSON.stringify(value));
}

/** Bridge state directory (<DSH_HOME>/lark-link, overridable). */
export function stateDir(): string {
	return (
		process.env.DSH_LARK_LINK_HOME ??
		join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "lark-link")
	);
}

export function apply(ctx: Context, rawConfig: unknown): void {
	const cfg = rawConfig as LarkLinkConfig | undefined;
	if (cfg?.enabled === false) return;

	const dir = stateDir();
	mkdirSync(dir, { recursive: true });
	const logger: Logger = createLogger("lark-link");

	// ---- config / status / stores -------------------------------------------
	const configStore = createConfigStore(dir, {
		groupPolicy: cfg?.groupPolicy,
		denyList: cfg?.denyList,
	});
	const status = createStatusStore(join(dir, "status.json"));
	const routeStore = createRouteStore(join(dir, "routes.json"));
	const userUsage = createUserUsageStore(join(dir, "user-usage.json"));
	// Bridge-side session names (对话管理 → 重命名): DSH's own title service
	// only retitles a session that is LIVE in its store, so historical sessions
	// carry this alias instead.
	const sessionAliases = createSessionAliasStore(join(dir, "session-aliases.json"));
	const dedupe = createDedupeStore(join(dir, "dedupe.jsonl"));
	// Parallel tasks per conversation: each task is its own agent + session +
	// streaming card, and one of them is ACTIVE (what a plain message reaches).
	const taskRegistry = createTaskRegistry(join(dir, "tasks.json"));
	// Durable inbound-request journal (入站请求补发). Records agent-bound text
	// requests before enqueue; on boot, accepted-but-undelivered requests are
	// re-dispatched so a crash/plugin-reload/dsh-restart mid-turn doesn't drop
	// the user's message. Persists in <state>/inbound-wal/.
	const inboundWal = createInboundWal({ dir: join(dir, "inbound-wal") });
	const getCfg = (): ReturnType<typeof configStore.get> => configStore.get();
	// Per-conversation overrides (workspace / model / preset). The bridge-level
	// config stays the DEFAULT; /workspace, /model and /mode in one chat now
	// scope to THAT chat only — other chats no longer follow the switch when
	// their agent is rebuilt (idle TTL, /new, maxSessions pressure).
	const convCfg = createConversationConfigStore(
		join(dir, "conversation-overrides.json"),
	);

	// ---- permission scoping (GH #8) --------------------------------------------
	// The bridge's `permissionMode` is applied PER SESSION at agent creation
	// and resume (see dsh-adapter) plus on /permission switches for the live
	// session. The bridge NEVER writes the host's global permission default
	// (`settings.permission.defaultPreset`): the old boot-time sync silently
	// flipped the whole deployment — including non-Feishu sessions a
	// deployment wanted conservative — to the bridge's default
	// (danger-full-access). The old boot-time syncDefaultPermission() is gone
	// entirely; bridge sessions get their mode per-session at creation/resume
	// via the dsh-adapter's permissionMode dep, and /permission switches apply
	// to the live session plus future bridge sessions through this config.

	// ---- backend: real DSH adapter, falling back to the in-memory mock ------
	// LIVE model selection: liveModelSelection is the bridge-wide DEFAULT
	// (initialized from the deployment agentDefaultModel service; a GUI-side
	// default switch is picked up by the poll started in startBridge). Each
	// conversation gets its own mutable entry via liveModelFor(key) —
	// installModelSelection keeps a reference to it, so mutating the entry
	// switches that conversation's model WITHOUT rebuilding its agent.
	// Entries WITHOUT a per-key /model override snapshot the bridge default at
	// first use and keep it (a GUI default switch only affects NEW
	// conversations, never existing ones); entries with an override keep
	// their own model.
	const liveModelSelection: { provider: string; model: string; reasoningEffort?: ReasoningEffortId } = { provider: "", model: "" };
	const admService = (
		ctx as unknown as {
			get?(
				name: string,
			):
				| {
						currentSelection?():
							| { provider?: string; model?: string; reasoningEffort?: ReasoningEffortId }
							| undefined;
						saveSelection?(s: {
							provider: string;
							model: string;
						}): Promise<unknown>;
				  }
				| undefined;
		}
	).get?.("agentDefaultModel");
	type CatalogModel = { id: string; name?: string };
	type CatalogGroup = {
		provider: string;
		label?: string;
		models: CatalogModel[];
	};
	const llmService = (
		ctx as unknown as { get?(name: string): unknown }
	).get?.("llm") as
		| {
				listProviders?(): Array<{ id?: string; name?: string }>;
				listModels?(provider: string): Promise<CatalogModel[]>;
				resolveModelInfo?(provider: string, model: string): Promise<unknown>;
		  }
		| undefined;
	let modelCatalogCache:
		| { expiresAt: number; groups: CatalogGroup[] }
		| undefined;
	const listModelCatalog = async (): Promise<CatalogGroup[]> => {
		if (modelCatalogCache && modelCatalogCache.expiresAt > Date.now())
			return modelCatalogCache.groups;
		const groups: CatalogGroup[] = [];
		for (const provider of llmService?.listProviders?.() ?? []) {
			const providerId = provider.id ?? "";
			if (!providerId) continue;
			try {
				const models = (await llmService?.listModels?.(providerId)) ?? [];
				if (models.length > 0) {
					groups.push({
						provider: providerId,
						label: provider.name ?? providerId,
						models,
					});
				}
			} catch {
				// One unavailable provider must not hide the rest of the catalog.
			}
		}
		modelCatalogCache = { expiresAt: Date.now() + 30_000, groups };
		return groups;
	};
	{
		const cur = admService?.currentSelection?.();
		if (cur?.provider && cur.model) {
			liveModelSelection.provider = cur.provider;
			liveModelSelection.model = cur.model;
			liveModelSelection.reasoningEffort = cur.reasoningEffort;
		}
		const appDefault = parseModelRef(getCfg().modelAccess.defaultModel);
		if (appDefault) {
			liveModelSelection.provider = appDefault.provider;
			liveModelSelection.model = appDefault.model;
			delete liveModelSelection.reasoningEffort;
		}
	}
	const effectiveBridgeDefault = (): ModelSelection | undefined =>
		pickEffectiveDefault(
			getCfg().modelAccess,
			liveModelSelection.provider && liveModelSelection.model
				? liveModelSelection
				: undefined,
		);
	const liveModels = new Map<
		string,
		{ provider: string; model: string; reasoningEffort?: ReasoningEffortId; override: boolean }
	>();
	const liveModelFor = (
		key: string,
	): { provider: string; model: string; reasoningEffort?: ReasoningEffortId; override: boolean } => {
		let m = liveModels.get(key);
		if (!m) {
			const o = convCfg.get(key);
			const requested =
				o.provider && o.model
					? { provider: o.provider, model: o.model }
					: effectiveBridgeDefault();
			const selected =
				requested && isModelAllowed(getCfg().modelAccess, requested)
					? requested
					: effectiveBridgeDefault();
			m = {
				provider: selected?.provider ?? "",
				model: selected?.model ?? "",
				reasoningEffort: (o.reasoningEffort ?? liveModelSelection.reasoningEffort) as ReasoningEffortId | undefined,
				override: Boolean(
					o.provider &&
						o.model &&
						isModelAllowed(getCfg().modelAccess, {
							provider: o.provider,
							model: o.model,
						}),
				),
			};
			liveModels.set(key, m);
		}
		return m;
	};

	// Fresh per-run nonce — NEVER persisted. (352af88 persisted it so bridge
	// session ids survive restarts, but that makes a restarted bridge reuse a
	// session id whose on-disk log does not match the live session, and
	// dsh-agent-loop's resume/create then fail the first turn with "already
	// has a persisted log on disk that does not match this live session (id
	// collision)". A fresh nonce per run means create never collides and the
	// bridge always boots clean; the GUI gets a new conversation row per
	// restart, which is the correct trade-off for a reliable bridge.)
	const runNonce = `${Date.now().toString(36)}${Math.random()
		.toString(36)
		.slice(2, 6)}`;
	let backend: ReturnType<typeof createDshAdapter> | undefined;
	try {
		backend = createDshAdapter({
			ctx,
			sessionPrefix: "lark-link",
			runNonce,
			logger,
			// Per-key workspace: the ISOLATION-aware resolver (conversation
			// override ?? per-user hash dir under the workspace root). This used
			// to fall back to process.cwd() — which on the core service IS the
			// shared dsh-workspace root — so every session ran in the flat root
			// and per-user isolation silently never applied to new sessions.
			// Lazy call: workspaceForTaskKey is defined later in this setup.
			cwd: (key: string) => workspaceForTaskKey(key),
			preset: (key: string) => {
				const p =
					convCfg.get(key).preset ?? (getCfg().agentPreset || "code");
				return p;
			},
			modelSelection: {
				currentFor: (key: string) => {
					const m = liveModelFor(conversationKeyOf(key));
					if (
						m.provider &&
						m.model &&
						isModelAllowed(getCfg().modelAccess, m)
					) {
						return m;
					}
					const fallback = effectiveBridgeDefault();
					if (!fallback) return undefined;
					m.provider = fallback.provider;
					m.model = fallback.model;
					delete m.reasoningEffort;
					m.override = false;
					return m;
				},
			},
			activeSessionId: (key: string) => convCfg.get(key).activeSessionId,
			setActiveSessionId: (key: string, sessionId: string | undefined) => {
				convCfg.set(key, { activeSessionId: sessionId });
			},
			askUserQuestion,
			// GH #8: bridge sessions carry the bridge's permission preset at
			// creation/resume — the host-wide default is never modified.
			permissionMode: () => getCfg().permissionMode,
		});
	} catch (err) {
		logger.warn(
			`DSH adapter unavailable — using in-memory backend: ${String(err)}`,
		);
		backend = createMemoryDshBackend();
	}

	// ---- lark client (lazily built from credentials at start) ---------------
	let larkClient: FeishuClientLike | undefined;
	const getLarkClient = (): FeishuClientLike | undefined => larkClient;

	// Credentials live in ctx.credentials under config.credentialRef (ref-style,
	// spec §4.1). Harness-agnostic adapter — no-ops if the service is absent.
	const credStore: CredentialsStore = {
		resolve: (ref) =>
			(
				ctx as unknown as { credentials?: CredentialsStore }
			).credentials?.resolve(ref) ?? Promise.resolve(undefined),
		set: (ref, value) =>
			(ctx as unknown as { credentials?: CredentialsStore }).credentials?.set(
				ref,
				value,
			) ?? Promise.resolve(),
		unset: (ref) =>
			(ctx as unknown as { credentials?: CredentialsStore }).credentials?.unset(
				ref,
			) ?? Promise.resolve(),
	};
	let startBlocker: string | undefined;
	const maskId = (id: string): string =>
		id.length <= 8 ? "****" : `${id.slice(0, 6)}…${id.slice(-4)}`;
	let applyManualCredentials:
		| ((input: unknown) => Promise<{
				configured: true;
				appSwitched: boolean;
				appIdMasked: string;
				domain: LarkDomain;
				connState: string;
		  }>)
		| undefined;
	let applyBridgeControl:
		| ((action: "start" | "stop" | "restart") => Promise<{
				connState: string;
		  }>)
		| undefined;
	let applyBridgePolicy:
		| ((input: unknown) => Promise<{
				modelAccess: ReturnType<typeof getCfg>["modelAccess"];
				workspaceRoot: string;
		  }>)
		| undefined;

	// ---- webui QR surface ---------------------------------------------------
	// /lark setup renders its QR into a PNG served at /plugins/lark-link/qr so
	// the Web GUI (sidebar panel) can show a scannable image directly — the GUI
	// markdown image sanitizer only allows http(s), and a plugin can't push to
	// the client, so a host-served local image is the reliable channel.
	let activeQr: { png: Buffer; expireAt: number } | undefined;
	const webServer = (
		ctx as unknown as {
			webServer?: {
				register(r: {
					kind: "exact" | "prefix";
					path: string;
					handler: (req: unknown, res: unknown) => void;
				}): () => void;
			};
		}
	).webServer;
	if (webServer) {
		ctx.effect(
			() =>
				webServer.register({
					kind: "exact",
					path: "/plugins/lark-link/qr",
					handler: (_req, res) => {
						const r = res as {
							writeHead(
								status: number,
								headers: Record<string, string>,
							): unknown;
							end(body?: unknown): unknown;
						};
						if (activeQr && Date.now() < activeQr.expireAt) {
							r.writeHead(200, {
								"Content-Type": "image/png",
								"Cache-Control": "no-store",
							});
							r.end(activeQr.png);
						} else {
							r.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
							r.end("no active lark-link setup qr (run /lark setup)");
						}
					},
				}),
			"lark-link: webui qr route",
		);
		ctx.effect(
			() =>
				webServer.register({
					kind: "exact",
					path: "/plugins/lark-link/status",
					handler: async (_req, res) => {
						const r = res as {
							writeHead(s: number, h: Record<string, string>): unknown;
							end(body?: unknown): unknown;
						};
						const credentials = await resolveCredentials(
							credStore,
							getCfg().credentialRef,
						);
						r.writeHead(200, {
							"Content-Type": "application/json; charset=utf-8",
							"Cache-Control": "no-store",
						});
						r.end(
							JSON.stringify({
								...status.get(),
								configured: Boolean(credentials),
								...(credentials
									? {
											appIdMasked: maskId(credentials.appId),
											domain: credentials.domain,
									  }
									: {}),
							}),
						);
					},
				}),
			"lark-link: webui status route",
		);
		ctx.effect(
			() =>
				webServer.register({
					kind: "exact",
					path: "/plugins/lark-link/credentials",
					handler: async (req, res) => {
						if ((req as WebRequest).method !== "POST") {
							sendWebJson(res, 405, { ok: false, error: "仅支持 POST" });
							return;
						}
						try {
							if (!applyManualCredentials)
								throw new Error("Lark Link 尚未完成初始化");
							const result = await applyManualCredentials(await readWebJson(req));
							sendWebJson(res, 200, { ok: true, ...result });
						} catch (error) {
							const message =
								error instanceof Error ? error.message : "手动配置失败";
							sendWebJson(res, error instanceof TypeError ? 400 : 500, {
								ok: false,
								error: message,
							});
						}
					},
				}),
			"lark-link: webui manual credentials route",
		);
		ctx.effect(
			() =>
				webServer.register({
					kind: "exact",
					path: "/plugins/lark-link/management",
					handler: async (req, res) => {
						if ((req as WebRequest).method !== "GET") {
							sendWebJson(res, 405, { ok: false, error: "仅支持 GET" });
							return;
						}
						const credentials = await resolveCredentials(
							credStore,
							getCfg().credentialRef,
						);
						const users = userUsage.list().map((usage) => {
							const overrides = convCfg.get(usage.sessionKey);
							const route = routeStore.get(usage.sessionKey);
							return {
								...usage,
								activeSessionId: overrides.activeSessionId ?? route?.sessionId,
								workspaceRoot:
									overrides.workspaceRoot ?? getCfg().workspaceRoot,
								provider: overrides.provider,
								model: overrides.model,
								reasoningEffort: overrides.reasoningEffort,
								preset: overrides.preset,
							};
						});
						const modelCatalog = await listModelCatalog();
						sendWebJson(res, 200, {
							ok: true,
							instance: { host: hostname(), pid: process.pid },
							app: credentials
								? {
										appIdMasked: maskId(credentials.appId),
										domain: credentials.domain,
								  }
								: null,
							status: status.get(),
							policy: {
								modelAccess: getCfg().modelAccess,
								workspaceRoot: getCfg().workspaceRoot,
								effectiveDefaultModel: effectiveBridgeDefault()
									? modelRef(effectiveBridgeDefault()!)
									: "",
							},
							modelCatalog,
							users,
						});
					},
				}),
			"lark-link: webui management route",
		);
		ctx.effect(
			() =>
				webServer.register({
					kind: "exact",
					path: "/plugins/lark-link/control",
					handler: async (req, res) => {
						if ((req as WebRequest).method !== "POST") {
							sendWebJson(res, 405, { ok: false, error: "仅支持 POST" });
							return;
						}
						try {
							const body = (await readWebJson(req)) as { action?: unknown };
							const action = String(body.action ?? "");
							if (!applyBridgeControl)
								throw new Error("Lark Link 尚未完成初始化");
							if (!(["start", "stop", "restart"] as string[]).includes(action))
								throw new TypeError("不支持的管理操作");
							const result = await applyBridgeControl(
								action as "start" | "stop" | "restart",
							);
							sendWebJson(res, 200, { ok: true, ...result });
						} catch (error) {
							sendWebJson(res, error instanceof TypeError ? 400 : 500, {
								ok: false,
								error:
									error instanceof Error ? error.message : "管理操作失败",
							});
						}
					},
				}),
			"lark-link: webui management control route",
		);
		ctx.effect(
			() =>
				webServer.register({
					kind: "exact",
					path: "/plugins/lark-link/policy",
					handler: async (req, res) => {
						if ((req as WebRequest).method !== "POST") {
							sendWebJson(res, 405, { ok: false, error: "仅支持 POST" });
							return;
						}
						try {
							if (!applyBridgePolicy)
								throw new Error("Lark Link 尚未完成初始化");
							const result = await applyBridgePolicy(await readWebJson(req));
							sendWebJson(res, 200, { ok: true, ...result });
						} catch (error) {
							sendWebJson(res, error instanceof TypeError ? 400 : 500, {
								ok: false,
								error:
									error instanceof Error ? error.message : "策略保存失败",
							});
						}
					},
				}),
			"lark-link: webui app policy route",
		);
	}

	// ---- sender (outbox target) ----------------------------------------------
	const sender: FeishuSender = {
		async replyTo(msg, textOrCard) {
			const text =
				typeof textOrCard === "string"
					? textOrCard
					: JSON.stringify(textOrCard);
			if (typeof textOrCard === "string")
				await sender.sendText(msg.chatId, text);
			else await sender.sendCard(msg.chatId, textOrCard as unknown);
		},
		async sendText(chatId, text) {
			const client = getLarkClient();
			if (!client?.sendMessage) throw new Error("lark client not ready");
			// Markdown-ish replies render as schema-1.0 cards (Feishu renders the
			// markdown element in every client — old and new). Schema 2.0 cards
			// break older clients ("请升级至最新版本客户端" placeholder), and plain
			// text shows raw markdown source. 1.0 is the compatible middle
			// ground; oversize replies fall back to plain text.
			if (looksLikeMarkdown(text) && text.length <= 28_000) {
				await client.sendMessage({
					receive_id_type: chatId.startsWith("oc_") ? "chat_id" : "open_id",
					params: {
						receive_id: chatId,
						msg_type: "interactive",
						content: JSON.stringify(markdownCard(text)),
					},
				});
				return;
			}
			await client.sendMessage({
				receive_id_type: chatId.startsWith("oc_") ? "chat_id" : "open_id",
				params: {
					receive_id: chatId,
					msg_type: "text",
					content: JSON.stringify({ text }),
				},
			});
		},
		async sendCard(chatId, card) {
			const client = getLarkClient();
			if (!client?.sendMessage) throw new Error("lark client not ready");
			await client.sendMessage({
				receive_id_type: chatId.startsWith("oc_") ? "chat_id" : "open_id",
				params: {
					receive_id: chatId,
					msg_type: "interactive",
					content: JSON.stringify(card),
				},
			});
		},
		async addReaction(messageId, emojiType) {
			const client = getLarkClient();
			if (!client?.addReaction) throw new Error("lark client not ready");
			await client.addReaction({
				message_id: messageId,
				emoji_type: emojiType,
			});
		},
		async sendFile(chatId, fileKey, type) {
			const client = getLarkClient();
			if (!client?.sendMessage) throw new Error("lark client not ready");
			await client.sendMessage({
				receive_id_type: chatId.startsWith("oc_") ? "chat_id" : "open_id",
				params: {
					receive_id: chatId,
					msg_type: type,
					content: JSON.stringify(
						type === "image" ? { image_key: fileKey } : { file_key: fileKey },
					),
				},
			});
		},
		async listMessages({ chatId, startTimeMs, endTimeMs }) {
			const client = getLarkClient();
			if (!client?.listMessages) return [];
			const res = await client.listMessages({
				container_id_type: "chat",
				container_id: chatId,
				start_time: String(startTimeMs),
				end_time: String(endTimeMs),
			});
			return (res.items ?? []).map((i) => ({
				messageId: i.message_id ?? "",
				timestampMs: Number(i.create_time ?? 0),
			}));
		},
	};

	// ---- bridge context (getters — never snapshots) --------------------------
	const bridge = createBridgeContext({
		logger,
		cfg: getCfg,
		configStore,
		status,
		backend,
		router: routeStore,
		sender,
		// DSH attachment store — saves inbound Feishu images as ImageBlocks.
		// LIVE getter (NOT a snapshot): the service may mount after the
		// plugin loads (Cordis load order) — a construction-time read stayed
		// undefined forever and every inbound image silently lost its
		// imageRef, so the model never saw the image at all.
		attachmentsRef: () =>
			(
				ctx as unknown as {
					get?(name: string):
						| {
								saveImage(input: {
									data: Uint8Array;
									mediaType:
										| "image/png"
										| "image/jpeg"
										| "image/webp"
										| "image/gif";
									name?: string;
								}): Promise<{
									attachmentId: string;
									mediaType: string;
									bytes: number;
									width: number;
									height: number;
									name?: string;
								}>;
						  }
						| undefined;
				}
			).get?.("attachments"),
	});

	// Command replies share one CardKit entity per chat. The outbox remains the
	// durable scheduler; its command-reply sender below first tries this panel
	// and falls back to a standalone message only when CardKit is unavailable.
	const commandPanelSync: CommandPanelSync = createCommandPanelSync({
		createCard: async (payload) => {
			const client = getLarkClient();
			if (!client?.cardkitCreateCard) throw new Error("CardKit unavailable");
			return client.cardkitCreateCard(payload);
		},
		deliverCard: async (cardId, chatId) => {
			const client = getLarkClient();
			if (!client?.cardkitDeliverCard) throw new Error("CardKit unavailable");
			return client.cardkitDeliverCard({ chatId, cardId });
		},
		updateCard: async (cardId, body) => {
			const client = getLarkClient();
			if (!client?.cardkitUpdateCard) throw new Error("CardKit unavailable");
			return client.cardkitUpdateCard(cardId, body);
		},
	});

	// ---- outbox ---------------------------------------------------------------
	const outboxSender: OutboxSender = {
		async deliver(env, payload) {
			const chatId = env.route.chatId;
			try {
				if (env.kind === "command-reply") {
					const command = env.dedupeKey.includes(":cmd:")
						? env.dedupeKey.split(":cmd:")[1]?.split(":")[0] ?? "command"
						: env.dedupeKey.startsWith("bridge:")
							? env.dedupeKey.split(":")[1] ?? "command"
							: "command";
					const panelUpdated = payload.kind === "card"
						? await commandPanelSync.showCard(
							chatId,
							env.dedupeKey,
							command,
							payload.card,
						)
						: await commandPanelSync.append(chatId, {
							id: env.dedupeKey,
							command,
							result: payload.kind === "text" ? payload.text : "命令已完成",
							...(payload.kind === "text" && payload.status
								? { status: payload.status }
								: {}),
						});
					if (panelUpdated && (payload.kind === "text" || payload.kind === "card")) {
						return { ok: true };
					}
				}
				if (payload.kind === "text") {
					if (payload.card !== undefined)
						await sender.sendCard(chatId, payload.card);
					else await sender.sendText(chatId, payload.text);
				} else if (payload.kind === "card") {
					await sender.sendCard(chatId, payload.card);
				} else if (payload.kind === "media") {
					await sender.sendFile(chatId, payload.fileKey, payload.type);
				} else if (payload.kind === "reaction") {
					await sender.addReaction(payload.messageId, payload.emojiType);
				}
				return { ok: true };
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return { ok: false, retryable: true, error: message };
			}
		},
	};
	const outbox = createOutbox({
		dir: join(dir, "outbox"),
		sender: outboxSender,
		cfg: getCfg().outbox,
		// Live outbox counters → status, so /status (and the Web panel) reflect
		// pending/failed in real time instead of only on startup / timers.
		onStatsChange: (stats) => {
			try {
				status.refreshCounters({ outboxPending: stats.pending, outboxFailed: stats.failed });
			} catch {
				// best-effort
			}
		},
	});

	// ---- forwarder / compensation / trigger / diagnostics --------------------
	// CardKit streaming handles, one per conversation key. The forwarder calls
	// ensureStream() on every chunk, so the SAME handle must be returned for
	// the whole turn (a fresh one per chunk would create a card per chunk);
	// a disposed handle (finalized / errored) is replaced on next access.
	const streamHandles = new Map<string, CardKitStreamHandle>();
	// One-time per conversation: tell the user WHY streaming fell back to a
	// plain reply (silent fallback reads as "卡片功能无法开启"). Content is
	// never lost — the forwarder degrades to the durable outbox — this notice
	// just makes the degradation diagnosable (missing CardKit scope, old
	// client, entity-already-sent, …).
	const cardkitNotified = new Set<string>();
	const resolveRawAgent = (handle: unknown): unknown => {
		if (!handle) return undefined;
		const h = handle as { rawAgent?: unknown; agentId?: string; id?: string };
		if (h.rawAgent) return h.rawAgent;
		if (h.agentId) {
			const agentsService = (ctx as unknown as { get?(name: string): unknown }).get?.("agents") as
				| { get?(id: string): unknown }
				| undefined;
			const found = agentsService?.get?.(h.agentId);
			if (found) return found;
		}
		return handle;
	};
	/**
	 * Routes are stored per CONVERSATION; everything downstream of the
	 * ConversationManager speaks TASK keys (`dm:oc_x#2`) — so every consumer of
	 * a task key has to strip the `#n` suffix before a route lookup. (Forgetting
	 * this made the forwarder drop every event silently: the bot never replied.)
	 */
	const routeForTaskKey = (taskKey: string) => routeStore.get(conversationKeyOf(taskKey));

	/**
	 * Route of the conversation that OWNS a session id (what tools receive).
	 * Three layers, cheapest first:
	 *   1. the backend reverse map (authoritative, but EMPTY for a resumed task,
	 *      a disposed idle agent or a web-GUI session — `keyBySession.delete` on
	 *      dispose, and nothing registers a GUI session at all);
	 *   2. parse the id (`conversationKeyForSessionId`);
	 *   3. scan the routes for one whose key the id embeds.
	 * Layers 2–3 matter: the old inline fallback could not parse
	 * `…:<nonce>:<index>` and returned an unparsed task key, so tool calls died
	 * with "无法定位当前飞书会话" even though the conversation existed.
	 */
	const routeForSessionId = (sessionId: string) => {
		const backendKey = bridge.backend?.keyForSessionId?.(sessionId);
		return (
			(backendKey ? routeStore.get(conversationKeyOf(backendKey)) : undefined) ??
			routeStore.get(conversationKeyForSessionId(sessionId)) ??
			routeStore.all().find((r) => sessionId.includes(r.sessionKey))
		);
	};

	const notifyCardkitFailure = (sessionKey: string, err: unknown): void => {

		if (cardkitNotified.has(sessionKey)) return;
		cardkitNotified.add(sessionKey);
		const chatId = routeForTaskKey(sessionKey)?.chatId;
		if (!chatId) return;
		const msg = err instanceof Error ? err.message : String(err);
		void sender
			.sendText(
				chatId,
				`⚠️ 流式卡片创建失败，本轮已回退普通消息（原因: ${msg.slice(0, 200)}）。` +
					"常见排查：应用未开通 CardKit 卡片权限（cardkit:card）、飞书客户端版本过旧、或 stream 文本超限。错误只提示一次。",
			)
			.catch(() => undefined);
	};
	const taskCardSyncer = createTaskCardSyncer({
		api: {
			createCard: async (payload) => {
				const client = getLarkClient();
				if (!client?.cardkitCreateCard) return undefined;
				return await client.cardkitCreateCard(payload);
			},
			deliverCard: async (cardId) => {
				// Handled via deliverCard option
			},
			streamText: async (cardId, elementId, body) => {
				const client = getLarkClient();
				return client?.cardkitStreamText ? await client.cardkitStreamText(cardId, elementId, body) : {};
			},
			patchSettings: async (cardId, body) => {
				const client = getLarkClient();
				return client?.cardkitPatchSettings ? await client.cardkitPatchSettings(cardId, body) : {};
			},
			updateCard: async (cardId, body) => {
				const client = getLarkClient();
				return client?.cardkitUpdateCard ? await client.cardkitUpdateCard(cardId, body) : {};
			},
		},
		routeFor: (key) => routeForTaskKey(key),
		deliverCard: async ({ chatId, cardId }) => {
			const client = getLarkClient();
			return client?.cardkitDeliverCard ? await client.cardkitDeliverCard({ chatId, cardId }) : {};
		},
		debounceMs: 1500,
		onError: (err) =>
			logger.warn(`task card syncer error: ${err instanceof Error ? err.message : String(err)}`),
	});

	const forwarder = createEventForwarder({
		outbox,
		taskCardSyncer,
		routeFor: (key) => routeForTaskKey(key),

		// Streaming cards stay off (省流量) unless hot-reloaded via
		// /lark-config streaming.enabled=true; the StreamTarget exists so
		// turn/end can always receipt the trigger message (fixed state-mapped
		// reactions: OnIt 收到 / DONE 完成 / ERROR 失败). best-effort via the sender.
		streamFor: (sessionKey) => {
			const route = routeForTaskKey(sessionKey);
			if (!route) return undefined;
			return {
				route: {
					sessionKey: route.sessionKey,
					chatId: route.chatId,
					chatType: route.chatType,
					threadMessageId: route.threadMessageId,
				},
				ensureStream: () => {
					const client = getLarkClient();
					if (!client?.cardkitCreateCard || !client.cardkitDeliverCard)
						return undefined; // CardKit unavailable → chunks stay preview-only
					const existing = streamHandles.get(sessionKey);
					if (existing && !existing.disposed) return existing;
					streamHandles.delete(sessionKey);
					const cfgStream = getCfg().streaming;
					const handle = createCardKitStream({
						api: {
							createCard: async (payload) => {
								try {
									return await client.cardkitCreateCard!(payload);
								} catch (err) {
									notifyCardkitFailure(sessionKey, err);
									throw err;
								}
							},
							deliverCard: (cardId) =>
								client.cardkitDeliverCard!({
									chatId: route.chatId,
									cardId,
								}),
							streamText: (cardId, elementId, body) =>
								client.cardkitStreamText!(cardId, elementId, body),
							patchSettings: (cardId, body) =>
								client.cardkitPatchSettings!(cardId, body),
							updateCard: (cardId, body) =>
								client.cardkitUpdateCard!(cardId, body),
						},
						printFrequencyMs: cfgStream.printFrequencyMs,
						printStep: cfgStream.printStep,
						minPushIntervalMs: 800,
						// A long turn has to drop detail to stay inside CardKit's
						// card-size budget; log the level CHANGE so the degradation
						// is observable instead of silently guessed at.
						onCompacted: ({ stage, scale, bytes }) => {
							logger.info(
								`cardkit stream compacted for ${sessionKey}: stage=${stage} detailScale=${scale.toFixed(2)} bytes=${bytes}`,
							);
						},
						onError: (err) => {
							const errStr = String(err);
							if (!errStr.includes("230020") && !errStr.includes("rate limit")) {
								logger.warn(
									`cardkit stream error for ${sessionKey}: ${err instanceof Error ? err.message : String(err)}`,
								);
							}
						},
					});
					streamHandles.set(sessionKey, handle);
					return handle;
				},

				fallbackText: async (text) => {
					await outbox.enqueue({
						dedupeKey: `${sessionKey}:fallback:${Date.now()}`,
						laneKey: sessionKey,
						route: {
							sessionKey: route.sessionKey,
							chatId: route.chatId,
							chatType: route.chatType,
						},
						kind: "assistant-output",
						payload: { kind: "text", text },
					});
				},
				markDone: (messageId) =>
					bridge.markDone(
						conversationKeyOf(sessionKey),
						messageId ?? route.lastMessageId,
					),
				markError: (messageId) =>
					bridge.markError(
						conversationKeyOf(sessionKey),
						messageId ?? route.lastMessageId,
					),
			};
		},
		cfg: () => ({ streamingEnabled: getCfg().streaming.enabled }),
		warn: (message) => logger.warn(message),
		// Durable output enqueued → the triggering user request has been
		// answered, so it won't be re-triggered after a crash. Best-effort.
		onDelivered: (taskOrConversationKey) => {
			try {
				// The forwarder speaks TASK keys; the WAL is per conversation.
				const delivered = inboundWal.deliveredOldest(
					conversationKeyOf(taskOrConversationKey),
				);
				status.refreshCounters({
					inboundPending: inboundWal.pendingReplays().length,
					inboundFailed: inboundWal.failedCount(),
				});
				return delivered?.messageId;
			} catch {
				// swallow — WAL failures never break delivery
				return undefined;
			}
		},
	});
	const groupTrigger = createGroupTrigger({
		cfg: () => ({
			policy: getCfg().groupPolicy,
			keywords: getCfg().groupKeywords,
			alsoOnReply: getCfg().alsoOnReply,
		}),
		botOpenId: () => bridge.botOpenId(),
	});

	const diagnostics = createDiagnosticsService({
		ctx: bridge,
		secrets: [],
	});

	// ---- intent confirmation (ask_user_question → Feishu) ---------------------
	// Model questions pause the tool call until the user answers; we send a
	// Feishu card (option buttons) and resolve on the callback. Plain-text
	// replies to the same conversation are treated as a custom answer.
	const pendingQuestions = new Map<
		string,
		{
			resolve: (a: { id: string; selected: string[]; custom?: string }) => void;
			chatId: string;
			questionId: string;
			timer: NodeJS.Timeout;
			options: Array<{ label: string }>;
		}
	>();

	async function askUserQuestion(
		questions: Array<{
			id: string;
			question: string;
			header?: string;
			options?: Array<{ label: string; description?: string }>;
			multiSelect?: boolean;
		}>,
		agentId: string,
	): Promise<{
		answers: Array<{ id: string; selected: string[]; custom?: string }>;
	}> {
		// One card per question, answered serially (multi-question is rare).
		const answers: Array<{
			id: string;
			selected: string[];
			custom?: string;
		}> = [];
		const key = backend?.keyForSessionId?.(agentId);
		// The backend maps a session to its TASK key; routes are per conversation.
		const route = key ? routeForTaskKey(key) : undefined;
		const chatId = route?.chatId;
		if (!chatId) {
			logger.warn(`ask_user_question: no Feishu route for ${agentId}`);
			return {
				answers: questions.map((q) => ({
					id: q.id,
					selected: ["(无会话，未回答)"],
				})),
			};
		}
		for (const q of questions) {
			const answer = await new Promise<{
				id: string;
				selected: string[];
				custom?: string;
			}>((resolve) => {
				const timer = setTimeout(() => {
					pendingQuestions.delete(q.id);
					resolve({ id: q.id, selected: ["(超时未回答)"] });
				}, 10 * 60_000);
				timer.unref?.();
				pendingQuestions.set(q.id, {
					resolve,
					chatId,
					questionId: q.id,
					timer,
					options: q.options ?? [],
				});
				void sender.sendCard(chatId, questionCard(q)).catch((err) => {
					clearTimeout(timer);
					pendingQuestions.delete(q.id);
					resolve({
						id: q.id,
						selected: [
							`(卡片发送失败: ${err instanceof Error ? err.message : String(err)})`,
						],
					});
				});
			});
			answers.push(answer);
		}
		return { answers };
	}

	// ---- command router --------------------------------------------------------
	const dshCommands: DshCommandRegistry = {
		// DSH's CommandRuntime has no `has()`; use find(agent, name) — the
		// agent-scoped effective command registry (ScopedLayers).
		has: (name, agentId) => {
			try {
				const services = ctx as unknown as {
					commands?: { find?(agent: unknown, name: string): unknown };
					agents?: { get?(id: string): unknown };
				};
				const agent = agentId ? services.agents?.get?.(agentId) : undefined;
				if (!agent) return false;
				return Boolean(services.commands?.find?.(agent, name));
			} catch {
				return false;
			}
		},
		async run(name, rawInput, agentId) {
			try {
				const services = ctx as unknown as {
					commands?: {
						execute?(
							agent: unknown,
							line: string,
							signal?: AbortSignal,
						): Promise<
							| {
									result?: { kind: string; text?: string };
							  }
							| undefined
						>;
					};
					agents?: { get?(id: string): unknown };
				};
				const commands = services.commands;
				const agent = services.agents?.get?.(agentId);
				if (!commands?.execute || !agent)
					return { kind: "error", text: "commands service unavailable" };
				const line = rawInput.trim()
					? `/${name} ${rawInput.trim()}`
					: `/${name}`;
				// execute() needs a live signal; a never-aborted controller is fine
				// for a one-shot command.
				const out = await commands.execute(
					agent,
					line,
					new AbortController().signal,
				);
				if (!out?.result) return { kind: "error", text: `未知命令 /${name}` };
				return {
					kind: out.result.kind,
					text: out.result.text,
				};
			} catch (err) {
				return {
					kind: "error",
					text: err instanceof Error ? err.message : String(err),
				};
			}
		},
	};

	// ---- durable command reply (入站请求补发 / 命令回复可靠化) ----------------
	// Bridge-command replies (status/help/sessions/workspace/lark-config/mode/
	// permission/model/new/stop/…) go through the DURABLE outbox (command-reply
	// kind), same as DSH-registered command replies — so a bridge reply in
	// flight when the process dies / plugin reloads still gets delivered on the
	// next boot. Idempotent per trigger message (no duplicates after replay).
	const durableReply = async (
		cmdName: string,
		msg: FeishuInboundMessage,
		textOrCard: string | unknown,
		opts?: { status?: "ok" | "error" },
	): Promise<void> => {
		const key = bridge.conversationKeyFor(msg);
		await outbox.enqueue({
			dedupeKey: `bridge:${cmdName}:${msg.messageId}`,
			laneKey: key,
			route: {
				sessionKey: key,
				chatId: msg.chatId,
				chatType: msg.chatType,
			},
			kind: "command-reply",
			payload:
				typeof textOrCard === "string"
					? {
							kind: "text",
							text: textOrCard,
							...(opts?.status ? { status: opts.status } : {}),
						}
					: { kind: "card", card: textOrCard as never },
		});
	};

	// ---- conversation management (对话管理) ---------------------------------
	// Shared session plumbing for /resume and /manage: both list ONE workspace's
	// persisted sessions (service headers preferred, filesystem scan fallback)
	// and both resolve titles the same way, so the picker and the management
	// panel can never disagree about what exists.
	const ctxGet = (serviceName: string): unknown =>
		(ctx as unknown as { get?(name: string): unknown }).get?.(serviceName);

	/** Structural slice of the host's sessionPersistence service. */
	interface PersistenceSlice {
		list?(): Promise<
			Array<{
				id: string;
				createdAt: number;
				cwd?: string;
				agentPreset?: string;
				origin?: string;
				title?: string;
			}>
		>;
		inspect?(id: string): Promise<{ meta?: unknown; events?: readonly unknown[] } | undefined>;
		load?(id: string): Promise<{ header?: unknown; events?: readonly unknown[] } | undefined>;
		readFrom?(id: string, fromSeq: number): Promise<{ meta?: unknown; events?: readonly unknown[] } | undefined>;
		open?(id: string, access: "read"): Promise<{
			read(offset?: number, length?: number): Promise<{ events: readonly unknown[] }>;
			close(): Promise<void>;
		}>;
	}
	const persistenceSlice = (): PersistenceSlice | undefined =>
		ctxGet("sessionPersistence") as PersistenceSlice | undefined;

	const listConversationSessions = async (key: string): Promise<WorkspaceSessionInfo[]> => {
		const wsRoot = workspaceForTaskKey(key);
		const persistence = persistenceSlice();
		const titleService = ctxGet("sessionTitle") as {
			get?(session: unknown): { title?: string } | undefined;
		} | undefined;
		const liveSessions = ctxGet("sessions") as { get?(id: string): unknown } | undefined;
		const titleFor = (sid: string): string | undefined => {
			try {
				const sess = liveSessions?.get?.(sid) as { events?: readonly unknown[] } | undefined;
				if (!sess) return undefined;
				const fromService = titleService?.get?.(sess)?.title;
				if (fromService) return fromService;
				if (sess.events) return extractTitleFromEvents(sess.events);
			} catch {
				// Titles are decoration — never fail a listing over one.
			}
			return undefined;
		};
		try {
			return await listWorkspaceSessions({
				sessionsRoot: resolveSessionsRoot(),
				cwd: wsRoot,
				persistence: persistence?.list
					? {
							list: async () => await persistence.list!(),
							inspect: persistence.inspect
								? async (id: string) => await persistence.inspect!(id)
								: undefined,
							load: persistence.load
								? async (id: string) => await persistence.load!(id)
								: undefined,
							readFrom: persistence.readFrom
								? async (id: string, fromSeq: number) =>
										await persistence.readFrom!(id, fromSeq)
								: undefined,
							open: persistence.open
								? async (id: string, access: "read") =>
										await persistence.open!(id, access)
								: undefined,
						}
					: undefined,
				titleFor,
			});
		} catch (err) {
			logger.warn(
				`session listing failed for ${wsRoot}: ${err instanceof Error ? err.message : String(err)}`,
			);
			return [];
		}
	};

	/**
	 * Workspace of one conversation.
	 *
	 * With isolation on (default) every user/group owns
	 * `<workspaceRoot>/<5-letter hash of its id>/`, and an explicit /workspace
	 * override only counts while it stays inside that subtree — a stale or
	 * hand-edited override can never hand one user another's directory.
	 */
	const workspaceFor = (key: string): string => {
		// Base = the configured workspace, else the deployment convention
		// (`$HOME/dsh-workspace`, the same default run-linux.sh hands to DSH Core).
		// Falling back to process.cwd() put user roots inside the plugin install.
		const base = getCfg().workspaceRoot || join(homedir(), "dsh-workspace");
		const explicit = convCfg.get(key).workspaceRoot;
		if (!getCfg().workspaceIsolation) {
			return explicit ?? base;
		}
		const ownerId = taskRegistry.owner(key).id ?? key;
		return ensureWorkspaceDir(resolveIsolatedWorkspace(base, ownerId, explicit));
	};

	/** The user's isolation root (absolute), whether or not an override is in force. */
	const isolationRootFor = (key: string): string =>
		userWorkspaceRoot(
			getCfg().workspaceRoot || join(homedir(), "dsh-workspace"),
			taskRegistry.owner(key).id ?? key,
		);

	/** Adapter-facing variant: the argument is a TASK key (`dm:oc_x#2`). */
	const workspaceForTaskKey = (key: string): string =>
		workspaceFor(conversationKeyOf(key));

	/** Live session id of one conversation (agent first, then the stored override). */
	const currentSessionFor = (key: string): string | undefined =>
		bridge.backend?.get(key)?.sessionId ?? convCfg.get(key).activeSessionId;

	/** Rows for the management panel: alias applied, current session always shown. */
	const manageRowsFor = async (key: string): Promise<ManageableSession[]> => {
		const rows = await listConversationSessions(key);
		const list: ManageableSession[] = rows.map((row) => ({
			id: row.id,
			createdAt: row.createdAt,
			...(row.title ? { title: row.title } : {}),
			...(sessionAliases.get(row.id) ? { alias: sessionAliases.get(row.id) } : {}),
			...(row.preset ? { preset: row.preset } : {}),
			...(row.summary ? { summary: row.summary } : {}),
			...(typeof row.userTurns === "number" ? { userTurns: row.userTurns } : {}),
			...(typeof row.toolCalls === "number" ? { toolCalls: row.toolCalls } : {}),
			...(typeof row.lastActivityAt === "number" ? { lastActivityAt: row.lastActivityAt } : {}),
			cwd: workspaceFor(key),
		}));
		// A brand-new conversation's session has no log yet, so the listing
		// cannot contain it — show it anyway: it is exactly the one users want to
		// rename (and the only one that can carry a real DSH title).
		const current = currentSessionFor(key);
		if (current && !list.some((row) => row.id === current)) {
			const alias = sessionAliases.get(current);
			list.unshift({
				id: current,
				createdAt: Date.now(),
				...(alias ? { alias } : {}),
				cwd: workspaceFor(key),
			});
		}
		return list;
	};

	// ---- parallel tasks (任务列表 / 切换) -------------------------------------
	/**
	 * Every task of one conversation, plus the historical sessions that no task
	 * has claimed yet — that union is what replaces the old /resume picker.
	 * Status comes from the live agents (running = mid-turn), titles and
	 * summaries from the workspace log.
	 */
	const taskRowsFor = async (key: string): Promise<TaskRow[]> => {
		const tasks = conversations.tasks(key); // newest first
		const activeId = conversations.activeTask(key)?.id;
		const sessions = await listConversationSessions(key);
		const bySession = new Map(sessions.map((session) => [session.id, session]));
		const claimed = new Set<string>();
		const baseRow = (task: TaskRecord): TaskRow => ({
			taskId: task.id,
			...(task.sessionId ? { sessionId: task.sessionId } : {}),
			seq: task.seq,
			...(task.label ? { label: task.label } : {}),
			status: "stopped",
			active: false,
			lastActivityAt: task.lastActivityAt,
		});
		const rows: TaskRow[] = tasks.map((task) => {
			if (task.sessionId) claimed.add(task.sessionId);
			const info = task.sessionId ? bySession.get(task.sessionId) : undefined;
			const alias = task.sessionId ? sessionAliases.get(task.sessionId) : undefined;
			return {
				...baseRow(task),
				status: conversations.statusOf(task.id),
				active: task.id === activeId,
				lastActivityAt: info?.lastActivityAt ?? task.lastActivityAt,
				...(alias ? { label: alias } : {}),
				...(info?.title ? { title: info.title } : {}),
				...(info?.summary ? { summary: info.summary } : {}),
				...(info?.preset ? { preset: info.preset } : {}),
			};
		});
		let seq = rows.length;
		for (const session of sessions) {
			if (claimed.has(session.id)) continue;
			seq += 1;
			const alias = sessionAliases.get(session.id);
			rows.push({
				sessionId: session.id,
				seq,
				status: "stopped",
				active: false,
				historical: true,
				lastActivityAt: session.lastActivityAt ?? session.createdAt,
				...(alias ? { label: alias } : {}),
				...(session.title ? { title: session.title } : {}),
				...(session.summary ? { summary: session.summary } : {}),
				...(session.preset ? { preset: session.preset } : {}),
			});
		}
		return rows;
	};

	/** One task's briefing card (status + what it has produced so far). */
	const taskBriefingFor = async (
		key: string,
		row: TaskRow,
		note?: string,
	): Promise<unknown> => {
		const snapshot = row.taskId ? forwarder.snapshot(row.taskId) : undefined;
		return taskBriefingCard({
			task: {
				...row,
				status: row.taskId ? conversations.statusOf(row.taskId) : "stopped",
				active: true,
				lastActivityAt: Date.now(),
			},
			...(snapshot ? { snapshot } : {}),
			workspace: workspaceFor(key),
			preset: convCfg.get(key).preset ?? getCfg().agentPreset,
			...(note ? { note } : {}),
		});
	};

	/**
	 * Make one row the message target. A registered task is switched; a bare
	 * historical session is bound to a NEW task and resumed, so "switch" works
	 * for anything the listing shows.
	 */
	const switchToTaskRow = async (
		key: string,
		row: TaskRow,
	): Promise<{ row: TaskRow; note: string }> => {
		if (row.taskId) {
			const { task } = await conversations.switchTask(key, row.taskId);
			const status = conversations.statusOf(task.id);
			return {
				row: {
					...row,
					taskId: task.id,
					...(task.sessionId ? { sessionId: task.sessionId } : {}),
					status,
					active: true,
					lastActivityAt: Date.now(),
				},
				note:
					status === "running"
						? "已切换到运行中的任务：输出继续更新在它自己的卡片里（已续上流式）"
						: "已切换到这个任务，下一条消息发到这里",
			};
		}
		if (!row.sessionId) throw new Error("这一行既没有任务也没有会话");
		const { task, agent } = await conversations.resumeTask(key, row.sessionId, {
			...(row.preset ? { preset: row.preset } : {}),
		});
		const running = !agent.isIdle();
		return {
			row: {
				...row,
				taskId: task.id,
				sessionId: task.sessionId ?? row.sessionId,
				status: running ? "running" : "idle",
				active: true,
				historical: false,
				lastActivityAt: Date.now(),
			},
			note: "已接管这条历史会话，下一条消息将续上它的上下文",
		};
	};

	/** Resolve a typed /tasks argument: 1-based index, task id or session prefix. */
	const findTaskRow = (
		rows: ReadonlyArray<TaskRow>,
		arg: string,
	): TaskRow | undefined => {
		let sel = arg;
		try {
			if (arg.includes("%")) sel = decodeURIComponent(arg);
		} catch {
			// malformed encoding — use the raw arg
		}
		const index = Number(sel);
		if (Number.isInteger(index) && index >= 1) {
			const viaIndex = rows.find((row) => row.seq === index);
			if (viaIndex) return viaIndex;
		}
		return rows.find(
			(row) =>
				row.taskId === sel ||
				row.sessionId === sel ||
				(row.taskId?.startsWith(sel) ?? false) ||
				(row.sessionId?.startsWith(sel) ?? false),
		);
	};

	/** Session-admin dependencies (live probe + optional service delete). */
	const sessionAdminDeps = (): SessionAdminDeps => {
		const persistence = ctxGet("sessionPersistence") as
			| {
					delete?(id: string): Promise<void> | void;
					remove?(id: string): Promise<void> | void;
					destroy?(id: string): Promise<void> | void;
				}
			| undefined;
		const serviceDelete =
			persistence?.delete ?? persistence?.remove ?? persistence?.destroy;
		const live = ctxGet("sessions") as { get?(id: string): unknown } | undefined;
		const agents = ctxGet("agents") as { get?(id: string): unknown } | undefined;
		return {
			sessionsRoot: resolveSessionsRoot(),
			isLive: (id: string) => Boolean(live?.get?.(id) ?? agents?.get?.(id)),
			onServiceDeleteError: (id: string, err: unknown) =>
				logger.warn(
					`sessionPersistence.delete refused ${id} (removing the log anyway): ${
						err instanceof Error ? err.message : String(err)
					}`,
				),
			...(serviceDelete
				? { serviceDelete: (id: string) => serviceDelete.call(persistence, id) }
				: {}),
		};
	};

	/**
	 * Shared hot-reload applier for /lark-config (text form) and the `cfg:`
	 * card toggles, so both paths validate and persist identically.
	 */
	const applyHotConfig = async (
		rawKey: string,
		rawValue: string,
	): Promise<{ ok: true; key: string; value: unknown } | { ok: false; message: string }> => {
		const key = rawKey.trim();
		const raw = String(rawValue ?? "").trim();
		let value: unknown = raw;
		if (raw === "true" || raw === "false") value = raw === "true";
		else if (raw !== "" && !Number.isNaN(Number(raw))) value = Number(raw);
		try {
			configStore.update(buildHotReloadPatch(key, value));
			configStore.saveOverrides();
			return { ok: true, key, value };
		} catch (err) {
			return {
				ok: false,
				message:
					err instanceof Error && /not hot-reloadable/.test(err.message)
						? `"${key}" 不可热改（可改: ${HOT_RELOADABLE.join(", ")}）`
						: `更新失败: ${err instanceof Error ? err.message : String(err)}`,
			};
		}
	};

	/**
	 * Build the /workspace browser card for one conversation (filesystem
	 * snapshot). Only DIRECTORIES are listed, hidden entries are skipped, the
	 * list is capped at BROWSER_ENTRY_LIMIT and ".." is offered exactly while
	 * ascending is still possible — the browser may walk ABOVE the DSH
	 * workspace up to the filesystem root (the model-facing tool
	 * `lark_send_local_file` keeps its own workspace containment).
	 */
	const buildWorkspaceBrowserCard = (key: string, browsePath: string): unknown => {
		const workspacePath = workspaceForTaskKey(key);
		try {
			if (!statSync(browsePath).isDirectory()) throw new Error("不是目录");
			const all = readdirSync(browsePath, { withFileTypes: true })
				.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
				.sort((left, right) => left.name.localeCompare(right.name));
			const entries = all.slice(0, BROWSER_ENTRY_LIMIT).map((entry) => ({
				name: entry.name,
				path: join(browsePath, entry.name),
			}));
			const parentPath = parentDirectory(browsePath);
			return workspaceBrowserCard({
				browsePath,
				workspacePath,
				...(parentPath ? { parentPath } : {}),
				entries,
				truncated: all.length > BROWSER_ENTRY_LIMIT,
			});
		} catch (err) {
			return markdownCard(
				`**无法浏览该目录**\n\n\`${browsePath}\`\n${err instanceof Error ? err.message : String(err)}`,
				{ header: "工作区", accent: false },
			);
		}
	};

	const bridgeHandler = async (
		name: string,
		_rawInput: string,
		msg: FeishuInboundMessage,
	): Promise<boolean> => {
		switch (name) {
			case "status":
				await durableReply(name, 
					msg,
					statusCard(
						formatStatusLine(status.get()),
						statusDetailLines(status.get()),
					),
				);
				return true;
			case "feishu-config":
			case "lark-config": {
				// /lark-config key=value — hot reload (no value shows status).
				const arg = _rawInput.trim();
				if (!arg) {
					await durableReply(name, 
						msg,
						configPanelCard({
							streamingEnabled: getCfg().streaming.enabled,
							reactionsEnabled: getCfg().reactions.enabled,
							groupPolicy: getCfg().groupPolicy,
							agentPreset: getCfg().agentPreset,
							permissionMode: getCfg().permissionMode,
							allowlist: getCfg().allowlist,
							denyList: getCfg().denyList,
						}),
					);
					return true;
				}
				const eq = arg.indexOf("=");
				if (eq === -1) {
					await durableReply(name,
						msg,
						"用法：/lark-config key=value（可热改: " +
							HOT_RELOADABLE.join(", ") +
							"；嵌套键用点路径，如 streaming.enabled=true）",
					);
					return true;
				}
				// Dotted paths (streaming.enabled) resolve into a NESTED patch —
				// previously only exact top-level whitelist names matched, so
				// `/lark-config streaming.enabled=true` answered 不可热改. The
				// shared applier is also used by the `cfg:` card toggles.
				const applied = await applyHotConfig(arg.slice(0, eq), arg.slice(eq + 1));
				await durableReply(
					name,
					msg,
					applied.ok
						? `已更新 ${applied.key}=${JSON.stringify(applied.value)}`
						: applied.message,
					applied.ok ? undefined : { status: "error" },
				);
				return true;
			}
			case "support":
			case "doctor": {
				// pi design: the diagnostic bundle comes back as a FILE. The
				// bundle is a ZIP containing the DSH session log (decompressed
				// jsonl, same shape as the GUI "Session log" export) plus a
				// sanitized ISSUE.md — falls back to a text reply when the
				// upload path is unavailable.
				const diag = await diagnostics.build();
				const client = getLarkClient();
				if (client?.uploadFile) {
					try {
						const key = bridge.conversationKeyFor(msg);
						const sessionId =
							bridge.backend?.get(key)?.sessionId ?? findLatestLarkSessionId();
						const zipBuf = sessionId
							? await buildSessionExportZip(sessionId, diag.text, diag.issueMd)
							: undefined;
						if (zipBuf) {
							const fileName = `lark-link-doctor-${Date.now()}.zip`;
							const uploadKey = extractUploadKey(
								await client.uploadFile({
									file_type: "file",
									file_name: fileName,
									file: zipBuf,
								}),
								"file_key",
							);
							if (uploadKey) {
								await sender.sendFile(msg.chatId, uploadKey, "file");
								await durableReply(name, msg, "✅ 诊断包已发送");
								return true;
							}
						}
						// No session log or zip failed — send the report as a file.
						const fileName = `lark-link-doctor-${Date.now()}.md`;
						const buf = Buffer.from(
							`# dsh-lark-link 诊断包\n\n${diag.text}\n\n${diag.issueMd}\n`,
							"utf8",
						);
						const uploadKey = extractUploadKey(
							await client.uploadFile({
								file_type: "file",
								file_name: fileName,
								file: buf,
							}),
							"file_key",
						);
						if (uploadKey) {
							await sender.sendFile(msg.chatId, uploadKey, "file");
							await durableReply(name, msg, "✅ 诊断报告已发送");
							return true;
						}
					} catch (err) {
						logger.warn(
							`doctor file send failed: ${err instanceof Error ? err.message : String(err)}`,
						);
					}
				}
				await durableReply(name, msg, diag.text);
				return true;
			}
			case "manage":
			case "sessions": {
				// 对话管理: one panel for the destructive / structural operations
				// (rename · delete · migrate project). They used to live in the
				// /resume picker, where a single mis-tap destroyed a session;
				// recovery stays there, management moved here. `/sessions` is kept
				// as an alias so the old habit still lands somewhere useful.
				const key = bridge.conversationKeyFor(msg);
				const current = currentSessionFor(key);
				const arg = _rawInput.trim();
				if (!arg) {
					await durableReply(
						name,
						msg,
						sessionManageCard({
							sessions: await manageRowsFor(key),
							currentSessionId: current,
						}),
					);
					return true;
				}
				// `/manage <序号>` or `/manage <会话ID前缀>` opens that session's
				// detail card directly (the card buttons do the same).
				const rows = await manageRowsFor(key);
				let sel = arg;
				try {
					if (arg.includes("%")) sel = decodeURIComponent(arg);
				} catch {
					// malformed encoding — use the raw arg
				}
				const index = Number(sel);
				const picked =
					Number.isInteger(index) && index >= 1 && index <= rows.length
						? rows[index - 1]
						: rows.find((row) => row.id === sel || row.id.startsWith(sel));
				if (!picked) {
					await durableReply(
						name,
						msg,
						sessionManageCard({
							sessions: rows,
							currentSessionId: current,
							note: `未找到会话「${arg}」，请从下面的列表中选择`,
						}),
					);
					return true;
				}
				await durableReply(
					name,
					msg,
					sessionManageDetailCard({ session: picked, currentSessionId: current }),
				);
				return true;
			}
			case "help":
				await durableReply(name, msg, helpCard());
				return true;
			case "workspace": {
				const arg = _rawInput.trim();
				const wsKey = bridge.conversationKeyFor(msg);
				// Per-conversation workspace: isolation-aware (override honored
				// only inside the user's subtree).
				const curWs = workspaceForTaskKey(wsKey);
				if (!arg) {
					await durableReply(name, 
						msg,
						buildWorkspaceBrowserCard(wsKey, curWs),
					);
					return true;
				}
				// Text fallback for creating a folder when the card form is
				// unavailable (old clients / schema validation): /workspace mk <名称>
				if (arg === "mk" || arg.startsWith("mk ")) {
					try {
						const dirName = sanitizeDirectoryName(arg.slice(2).trim());
						const target = join(curWs, dirName);
						if (existsSync(target)) throw new Error("该目录已存在");
						mkdirSync(target, { recursive: false });
						await durableReply(
							name,
							msg,
							`已创建目录: ${target}\n发送 /workspace 打开浏览器即可切换过去。`,
						);
					} catch (err) {
						await durableReply(
							name,
							msg,
							`创建失败: ${err instanceof Error ? err.message : String(err)}`,
							{ status: "error" },
						);
					}
					return true;
				}
				// /workspace <path> — switch the bridge workspace root: persist it
				// and dispose hosted sessions so the next message rebuilds agents
				// under the new cwd (DSH session cwd is fixed at creation).
				// Expand ~ and relative paths against the current workspace.
				// GH #7: absoluteness via node:path isAbsolute (drive letters
				// AND UNC included) — startsWith("/") rejected every Windows path.
				const target = resolveWorkspaceTarget(arg, curWs);
				if (!isAbsoluteAny(target)) {
					await durableReply(name, msg, `无效路径: ${arg}`);
					return true;
				}
				try {
					if (!statSync(target).isDirectory()) {
						await durableReply(name, msg, `不是有效目录: ${target}`);
						return true;
					}
				} catch {
					await durableReply(name, msg, `目录不存在: ${target}`);
					return true;
				}
				// Scope the switch to THIS conversation only (per-key override).
				// The bridge default is untouched, so other chats keep their
				// workspace even when their agent is later rebuilt.
				convCfg.set(wsKey, { workspaceRoot: target, activeSessionId: undefined });
				// Only the current conversation rebuilds (next message) — other
				// conversations keep their agents/sessions. rotate() (NOT dispose):
				// dispose() tears down the agent AND removes its session from the
				// store (GUI row vanishes) and the next message would reuse the
				// same sessionId → stale content / id collision. rotate() mints a
				// fresh runNonce so the next message opens a brand-new session
				// under the new cwd, and the old row stays listed.
				await conversations?.rotate(bridge.conversationKeyFor(msg));
				await durableReply(name, 
					msg,
					`工作区已切换: ${target}\n当前会话已重置，下一条消息在新工作区生效（其他会话不受影响）。`,
				);
				return true;
			}
			case "tasks": {
				// 任务列表（替代 /resume）：运行中优先，一键切换。切换后会发送该任务
				// 的现状，仍在运行时输出继续更新在它自己的卡片里（已续上流式）。
				const key = bridge.conversationKeyFor(msg);
				const rows = await taskRowsFor(key);
				const arg = _rawInput.trim();
				if (!arg) {
					await durableReply(
						name,
						msg,
						taskListCard({ tasks: rows, workspace: workspaceFor(key) }),
					);
					return true;
				}
				const picked = findTaskRow(rows, arg);
				if (!picked) {
					await durableReply(
						name,
						msg,
						taskListCard({
							tasks: rows,
							workspace: workspaceFor(key),
							note: `没有找到「${arg}」，请从下面的列表里选`,
						}),
					);
					return true;
				}
				try {
					const { row, note } = await switchToTaskRow(key, picked);
					await durableReply(name, msg, await taskBriefingFor(key, row, note));
				} catch (err) {
					await durableReply(
						name,
						msg,
						`切换失败：${err instanceof Error ? err.message : String(err)}`,
						{ status: "error" },
					);
				}
				return true;
			}
			case "resume": {
				// /resume 已并入 /tasks：任务列表同时包含"还在跑的任务"与尚未认领的
				// 历史会话，切换即恢复。保留命令名，旧习惯仍然落在同一个面板。
				return bridgeHandler("tasks", _rawInput.trim(), msg);
			}
			case "_legacy_resume_picker": {
				// /resume — resume a HISTORICAL session of THIS conversation's
				// workspace: no arg renders the picker (service-sourced headers
				// preferred, filesystem scan fallback); an arg picks by list
				// index or session-id prefix. The current agent is detached
				// rotate-style (never disposed — its GUI row survives) and the
				// stored log is loaded via agents.resume, so the NEXT message
				// continues that conversation's context.
				const key = bridge.conversationKeyFor(msg);
				const currentSessionId = currentSessionFor(key);
				// Titles come from the shared listing, which already merges the
				// bridge alias-free title sources (service, then the log events) —
				// /manage layers its own alias on top.
				const sessions = await listConversationSessions(key);
				logger.info(
					`resume: ${sessions.length} session(s) for ${workspaceFor(key)}; current=${currentSessionId ?? "none"}`,
				);

				const arg = _rawInput.trim();
				if (!arg) {
					await durableReply(
						name,
						msg,
						resumeCard(sessions, currentSessionId),
					);
					return true;
				}

				// Card buttons pass the id URI-ENCODED (lark-link ids contain
				// colons which the card-action op splitter would otherwise
				// cut at the first one); a typed /resume <id> may be raw, a
				// prefix, or a 1-based index matching the card numbering.
				let sel = arg;
				try {
					if (arg.includes("%")) sel = decodeURIComponent(arg);
				} catch {
					// malformed encoding — use the raw arg
				}
				// Numbering matches the card: only RESUMABLE rows carry #n
				// (the current session is displayed disabled and unnumbered).
				const resumable = sessions.filter(
					(s) => s.id !== currentSessionId,
				);

				const pick = /^\d+$/.test(sel)
					? resumable[Number(sel) - 1]
					: resumable.find(
							(s) =>
								s.id === sel ||
								s.id.startsWith(sel) ||
								s.id.endsWith(`:${sel}`),
						);
				if (!pick) {
					await durableReply(
						name,
						msg,
						`未找到会话 «${arg}»（发送 /resume 查看当前工作区的历史会话）`,
					);
					return true;
				}
				try {
					await conversations.resume(
						key,
						pick.id,
						pick.preset ? { preset: pick.preset } : undefined,
					);
					logger.info(`resume: ${key} restored ${pick.id}`);
					const resumedHandle = bridge.backend?.get(key);
					const rawAgent = resolveRawAgent(resumedHandle);
					await durableReply(
						name,
						msg,
						buildSessionResumedCard({
							sessionId: pick.id,
							workspacePath: workspaceFor(key),
							preset: pick.preset,
						}),
					);

				} catch (err) {
					await durableReply(
						name,
						msg,
						`恢复失败: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
				return true;
			}
			case "goal": {
				const key = bridge.conversationKeyFor(msg);
				const wsRoot = workspaceForTaskKey(key);
				const arg = _rawInput.trim();
				let agentHandle = bridge.backend?.get(key);
				if (!agentHandle) {
					try {
						agentHandle = await bridge.backend?.ensureAgent?.(key);
					} catch {
						// fall through
					}
				}
				const rawAgent = resolveRawAgent(agentHandle);
				const goalsService = (ctx as unknown as { get?(name: string): unknown }).get?.("goals") as {
					get?(agent: unknown): GoalSnapshotState | undefined;
					create?(agent: unknown, req: { objective: string }): GoalSnapshotState;
					pause?(agent: unknown, ref: { id: string; revision: number }): GoalSnapshotState;
					resume?(agent: unknown, ref: { id: string; revision: number }): GoalSnapshotState;
					clear?(agent: unknown, ref: { id: string; revision: number }): unknown;
				} | undefined;

				let currentGoal: GoalSnapshotState | undefined;
				try {
					currentGoal = rawAgent && goalsService?.get ? goalsService.get(rawAgent) : undefined;
				} catch {
					currentGoal = undefined;
				}

				if (!arg) {
					// Cards carry the controls (pause / resume / clear / templates)
					// instead of a text-only hint: buildGoalControlCard and
					// buildGoalSetupCard existed but previously had NO producer, so
					// the goal buttons in the task board could never be reached from
					// the command itself.
					await durableReply(
						name,
						msg,
						currentGoal
							? buildGoalControlCard(currentGoal, {
									workspacePath: wsRoot,
								})
							: buildGoalSetupCard(),
					);
					return true;
				}

				if (arg === "pause") {
					if (!currentGoal) {
						await durableReply(name, msg, "当前没有正在运行的目标。");
						return true;
					}
					try {
						goalsService?.pause?.(rawAgent, { id: currentGoal.id, revision: currentGoal.revision });
						await durableReply(name, msg, "⏸ 目标已暂停。发送 /goal resume 可恢复执行。");
					} catch (err) {
						await durableReply(name, msg, `暂停失败: ${err instanceof Error ? err.message : String(err)}`);
					}
					return true;
				}

				if (arg === "resume") {
					if (!currentGoal) {
						await durableReply(name, msg, "当前没有可恢复的目标。");
						return true;
					}
					try {
						goalsService?.resume?.(rawAgent, { id: currentGoal.id, revision: currentGoal.revision });
						await durableReply(name, msg, "▶️ 目标已恢复执行。");
					} catch (err) {
						await durableReply(name, msg, `恢复失败: ${err instanceof Error ? err.message : String(err)}`);
					}
					return true;
				}

				if (arg === "clear") {
					if (!currentGoal) {
						await durableReply(name, msg, "当前没有活跃的目标。");
						return true;
					}
					try {
						goalsService?.clear?.(rawAgent, { id: currentGoal.id, revision: currentGoal.revision });
						await bridge.conversations?.stop(key);
						await durableReply(name, msg, "🛑 目标已清除并停止当前任务轮次。");
					} catch (err) {
						await durableReply(name, msg, `清除失败: ${err instanceof Error ? err.message : String(err)}`);
					}
					return true;
				}

				// Custom objective: /goal <objective>
				try {
					goalsService?.create?.(rawAgent, { objective: arg });
					await durableReply(name, msg, `🎯 已启动目标：${arg}\nAgent 将围绕该目标自主执行。`);
				} catch (err) {
					await durableReply(name, msg, `目标启动失败: ${err instanceof Error ? err.message : String(err)}`);
				}
				return true;
			}
			case "stop": {
				const key = bridge.conversationKeyFor(msg);
				await bridge.conversations?.stop(key);
				await durableReply(
					name,
					msg,
					stopResultCard({
						text: "已向当前会话发送停止请求，正在运行的轮次会被取消。",
					}),
				);
				return true;
			}
			case "new": {
				// /new — reset this conversation onto a fresh session in the current
				// workspace. Resetting is one tap away in the control panel but it
				// discards the live context, so the bare command asks first:
				//   /new          → confirmation card
				//   /new confirm  → rotate (panel button `new:confirm`)
				//   /new cancel   → dismiss  (panel button `new:cancel`)
				const key = bridge.conversationKeyFor(msg);
				// The card must show the workspace the new task will REALLY use:
				// with isolation on that is the per-user hash directory, not the
				// shared root (showing the root made the isolation look broken).
				const newWs = workspaceFor(key);
				const newMode = _rawInput.trim();
				if (newMode === "cancel") {
					await durableReply(name, msg, "已取消，保持当前会话。");
					return true;
				}
				if (newMode !== "confirm") {
					await durableReply(
						name,
						msg,
						newConfirmCard({ workspace: newWs }),
					);
					return true;
				}
				// Confirmed: open a NEW TASK. The previous task is NOT rotated away —
				// it keeps its agent, its session and its streaming card, so a long
				// job started earlier continues while this new task runs (多任务并行).
				const task = conversations.createTask(key);
				await durableReply(
					name,
					msg,
					`已开启任务 #${task.seq}（工作区: ${newWs}）。下一条消息在这里开始全新上下文；之前任务继续运行，用 /tasks 查看与切换。`,
				);
				return true;
			}
			case "model": {
				// /model — list the current model + available models (no arg) or
				// switch: /model <provider>/<model> | /model <model>. The switch is
				// scoped to THIS conversation (per-key override + live entry): the
				// agent reads the live entry via installModelSelection, so the model
				// changes on the next reply WITHOUT rebuilding the session, and no
				// other chat follows the switch.
				const arg = _rawInput.trim();
				const modelKey = bridge.conversationKeyFor(msg);
				const mine = liveModelFor(modelKey);
				const current =
					mine.provider && mine.model
						? { provider: mine.provider, model: mine.model }
						: admService?.currentSelection?.();
				if (!arg) {
					// Picker card grouped by provider (single-select, no typing).
					const groups: Array<{
						provider: string;
						label?: string;
						models: Array<{ id: string; name?: string }>;
					}> = [];
					for (const p of await listModelCatalog()) {
						const models = p.models.filter((model) =>
							isModelAllowed(
								getCfg().modelAccess,
								modelRef({ provider: p.provider, model: model.id }),
							),
						);
						if (models.length > 0) {
							groups.push({
								provider: p.provider,
								label: p.label ?? p.provider,
								models,
							});
						}
					}
					await durableReply(name, msg, modelCard(current, groups));
					return true;
				}
				// Switch: accept provider/model or bare model id (same provider).
				let provider = current?.provider ?? "";
				let model = arg;
				if (arg.includes("/")) {
					const parsed = parseModelRef(arg);
					if (parsed) {
						provider = parsed.provider;
						model = parsed.model;
					}
				}
				if (!provider || !model) {
					await durableReply(name, 
						msg,
						"用法：/model <provider>/<model> 或 /model <model>",
					);
					return true;
				}
				if (!isModelAllowed(getCfg().modelAccess, { provider, model })) {
					await durableReply(
						name,
						msg,
						`该飞书应用未获准使用模型 ${provider}/${model}。请由管理员在 Lark 管理面板中授权。`,
					);
					return true;
				}
				// Scope to THIS conversation: persist the per-key override and
				// mutate the live entry — the agent's installed selection object
				// IS this entry, so the next reply uses the new model without a
				// rebuild. The bridge default (and other chats) are untouched.
				// Reasoning ids are model-owned. Reset the previous model's explicit
				// effort so an incompatible value cannot poison the next request.
				convCfg.set(modelKey, { provider, model, reasoningEffort: undefined });
				const entry = liveModelFor(modelKey);
				entry.provider = provider;
				entry.model = model;
				delete entry.reasoningEffort;
				entry.override = true;
				backend?.clearImageUnsupported?.(modelKey);
				await durableReply(name, 
					msg,
					`模型已切换: ${provider}/${model}\n本会话下次回复生效（会话不中断，其他会话不受影响）。`,
				);
				return true;
			}
			case "reasoning":
			case "thinking": {
				const key = bridge.conversationKeyFor(msg);
				const selected = liveModelFor(key);
				if (!selected.provider || !selected.model) {
					await durableReply(name, msg, "当前会话尚未选择模型，请先使用 /model。");
					return true;
				}
				const llm = (ctx as unknown as { get?(name: string): unknown }).get?.("llm") as
					| { resolveModelInfo?(provider: string, model: string): Promise<{ reasoning?: { efforts: ReadonlyArray<{ id: string; name: string; description?: string }>; defaultEffort?: string } }> }
					| undefined;
				let info: { reasoning?: { efforts: ReadonlyArray<{ id: string; name: string; description?: string }>; defaultEffort?: string } } | undefined;
				try {
					info = await llm?.resolveModelInfo?.(selected.provider, selected.model);
				} catch (err) {
					await durableReply(name, msg, `读取模型思考档位失败: ${err instanceof Error ? err.message : String(err)}`);
					return true;
				}
				const reasoning = info?.reasoning;
				if (!reasoning || reasoning.efforts.length === 0) {
					await durableReply(name, msg, `当前模型 ${selected.provider}/${selected.model} 不提供可选思考强度。`);
					return true;
				}
				const arg = _rawInput.trim().toLowerCase();
				if (!arg) {
					await durableReply(name, msg, reasoningCard(
						{ provider: selected.provider, model: selected.model },
						selected.reasoningEffort,
						reasoning.defaultEffort,
						reasoning.efforts,
					));
					return true;
				}
				if (["default", "auto", "provider-default"].includes(arg)) {
					convCfg.set(key, { reasoningEffort: undefined });
					delete selected.reasoningEffort;
					await durableReply(name, msg, `思考强度已恢复为模型默认${reasoning.defaultEffort ? `（${reasoning.defaultEffort}）` : ""}，本会话下次请求生效。`);
					return true;
				}
				const effort = reasoning.efforts.find((item) => item.id.toLowerCase() === arg);
				if (!effort) {
					await durableReply(name, msg, `当前模型不支持思考强度 ${arg}（可用: default, ${reasoning.efforts.map((item) => item.id).join(", ")}）`);
					return true;
				}
				convCfg.set(key, { reasoningEffort: effort.id });
				selected.reasoningEffort = effort.id as ReasoningEffortId;
				await durableReply(name, msg, `思考强度已切换为 ${effort.name}（${effort.id}），仅当前飞书会话生效，下次请求生效。`);
				return true;
			}
			case "mode": {
				// /mode — picker card (single-select buttons) or switch by name.
				// The roster is LIVE: shipped presets + user-authored (custom)
				// ones, read from DSH's agentPresets service so a preset created
				// in the GUI is selectable here too. AGENT_PRESETS is only the
				// fallback when the service is unreachable.
				const live = backend ? await backend.listPresets() : [];
				const roster = live.length > 0 ? live : [...AGENT_PRESETS];
				const arg = _rawInput.trim().toLowerCase();
				if (!arg) {
					await durableReply(
						name,
						msg,
						withButtons(
							modeCard(getCfg().agentPreset, roster),
							roster
								.filter((p) => !p.broken)
								.map((p) => button(p.label, { op: `mode:${p.id}` })),
						),
					);
					return true;
				}
				if (!roster.some((p) => p.id === arg)) {
					await durableReply(name, 
						msg,
						`未知模式 ${arg}（可用: ${roster.map((p) => p.id).join(", ")}）`,
					);
					return true;
				}
				// Per-conversation preset override — other chats keep theirs.
				convCfg.set(bridge.conversationKeyFor(msg), {
					preset: arg,
					activeSessionId: undefined,
				});
				// Agent presets snapshot at agent creation — an existing session's
				// agent CANNOT change mode mid-flight. rotate() (NOT dispose): mints
				// a fresh runNonce so the next message opens a brand-new session in
				// this workspace under the new mode; the old row stays listed.
				// dispose() would tear down the agent + remove its session from the
				// store AND the next message would reuse the same sessionId (stale
				// content / id collision).
				await conversations?.rotate(bridge.conversationKeyFor(msg));
				const picked = roster.find((p) => p.id === arg);
				await durableReply(name, 
					msg,
					`模式已切换为 ${picked?.label ?? arg}${
						picked?.trust === "user" ? "（自定义）" : ""
					}（当前会话已重置，下条消息生效；其他会话不受影响）`,
				);
				return true;
			}
			case "permission": {
				// /permission — picker card or switch by name. The DSH side also
				// registers a /permission command; this bridge handler wins first
				// (Tier 1) so the picker card shows instead of plain text.
				const arg = _rawInput.trim().toLowerCase();
				if (!arg) {
					await durableReply(
						name,
						msg,
						withButtons(
							permissionCard(getCfg().permissionMode),
							PERMISSION_PRESETS.map((p) =>
								button(p.label, { op: `permission:${p.id}` }),
							),
						),
					);
					return true;
				}
				if (!PERMISSION_PRESETS.some((p) => p.id === arg)) {
					await durableReply(name, 
						msg,
						`未知权限 ${arg}（可用: ${PERMISSION_PRESETS.map((p) => p.id).join(", ")}）`,
					);
					return true;
				}
				// Apply on the live DSH permission service (session-scoped knobs).
				try {
					const services = ctx as unknown as {
						get?(name: string): unknown;
					};
					const sessionId = bridge.backend?.get(
						bridge.conversationKeyFor(msg),
					)?.sessionId;
					const agent = sessionId
						? (
								services.get?.("agents") as {
									get?(id: string): { session: unknown };
								}
							)?.get?.(sessionId)
						: undefined;
					const permission = services.get?.("permissionPresets") as
						| {
								apply?(
									session: unknown,
									name: string,
									setApproval: (policy: string) => void,
								): void;
						  }
						| undefined;
					if (agent?.session && permission?.apply) {
						permission.apply(agent.session, arg, (policy) => {
							const approval = services.get?.("approval") as
								| { setPolicy?(agent: unknown, policy: string): unknown }
								| undefined;
							approval?.setPolicy?.(agent, policy);
						});
					}
				} catch (err) {
					logger.warn(
						`permission switch failed: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
				configStore.update({ permissionMode: arg });
				configStore.saveOverrides();
				// GH #8: no host-global default write. The bridge's own
				// permissionMode governs FUTURE bridge sessions too (the
				// dsh-adapter applies it per-session at creation/resume); the
				// deployment-wide default stays whatever the host configured.
				await durableReply(name, msg, `权限已切换为 ${arg}（仅桥接会话生效）`);
				return true;
			}
			case "lark": {
				// Feishu-side /lark subcommands — same executor as the DSH command.
				const sub = _rawInput.trim().split(/\s+/)[0] ?? "";
				if (!sub) {
					// Bare /lark renders the administration panel so every
					// subcommand is one tap away; the buttons map back onto the very
					// same executor below.
					const credentials = await resolveCredentials(
						credStore,
						getCfg().credentialRef,
					);
					await durableReply(
						name,
						msg,
						larkAdminPanelCard({
							connState: status.get().connState,
							configured: Boolean(credentials),
						}),
					);
					return true;
				}
				await durableReply(name, msg, await runLarkSubcommand(sub.toLowerCase()));
				return true;
			}
			case "menu": {
				await durableReply(name, msg, commandPanelCard());
				return true;
			}
			case "cfg": {
				// Card-driven config toggles: op form `cfg:<key>=<value>` emitted by
				// the settings panel. Same validator/persister as /lark-config.
				const arg = _rawInput.trim();
				const eq = arg.indexOf("=");
				if (eq === -1) {
					await durableReply(name, msg, "用法：/lark-config <key>=<value>", {
						status: "error",
					});
					return true;
				}
				const applied = await applyHotConfig(arg.slice(0, eq), arg.slice(eq + 1));
				await durableReply(
					name,
					msg,
					applied.ok
						? `已更新 ${applied.key}=${JSON.stringify(applied.value)}`
						: applied.message,
					applied.ok ? undefined : { status: "error" },
				);
				return true;
			}
			case "stream": {
				const arg = _rawInput.trim().toLowerCase();
				const current = getCfg().streaming.enabled;
				if (arg !== "on" && arg !== "off") {
					await durableReply(
						name,
						msg,
						`流式卡片当前: ${current ? "🟢 已开启" : "⚪ 已关闭"}\n用法: \`/stream on\` 或 \`/stream off\`（也可在 /lark-config 面板点按钮）`,
					);
					return true;
				}
				const applied = await applyHotConfig(
					"streaming.enabled",
					String(arg === "on"),
				);
				await durableReply(
					name,
					msg,
					applied.ok
						? `流式卡片已${arg === "on" ? "开启" : "关闭"}，立即生效。`
						: applied.message,
					applied.ok ? undefined : { status: "error" },
				);
				return true;
			}
			case "reconnect": {
				try {
					const result = await applyBridgeControl?.("restart");
					await durableReply(
						name,
						msg,
						`已重连，当前连接状态: \`${result?.connState ?? status.get().connState}\``,
					);
				} catch (err) {
					await durableReply(
						name,
						msg,
						`重连失败: ${err instanceof Error ? err.message : String(err)}`,
						{ status: "error" },
					);
				}
				return true;
			}
			case "cwd": {
				const key = bridge.conversationKeyFor(msg);
				const override = convCfg.get(key);
				const ws = workspaceForTaskKey(key);
				await durableReply(
					name,
					msg,
					`📁 当前工作区: \`${ws}\`\n来源: ${
						override.workspaceRoot ? "本会话 /workspace 覆盖" : "机器人默认设置"
					}`,
				);
				return true;
			}
			case "whoami": {
				const key = bridge.conversationKeyFor(msg);
				const handle = bridge.backend?.get(key);
				const route = routeStore.get(key);
				const override = convCfg.get(key);
				const selected = liveModelFor(key);
				const lines = [
					"**当前会话诊断**",
					"",
					`- 会话键: \`${key}\``,
					`- 用户 open_id: \`${msg.senderOpenId || "—"}\``,
					`- chat_id: \`${msg.chatId}\` (${msg.chatType})`,
					`- 活跃 session: \`${handle?.sessionId ?? override.activeSessionId ?? "（尚未建立）"}\``,
					`- 工作区: \`${workspaceForTaskKey(key)}\` (${
						override.workspaceRoot ? "本会话覆盖" : "按用户隔离"
					})`,
					`- 模型: \`${
						selected.provider && selected.model
							? `${selected.provider}/${selected.model}`
							: "（默认）"
					}\`${selected.override ? " (本会话覆盖)" : ""}`,
					`- 模式/权限: \`${override.preset ?? getCfg().agentPreset}\` / \`${getCfg().permissionMode}\``,
					`- 连接: \`${status.get().connState}\`${
						route ? ` · 路由: ${route.chatType} → \`${route.chatId}\`` : ""
					}`,
				];
				await durableReply(name, msg, lines.join("\n"));
				return true;
			}
			case "usage": {
				const records = userUsage.list();
				if (records.length === 0) {
					await durableReply(
						name,
						msg,
						"暂无用量记录（还没有用户向机器人发过消息）。",
					);
					return true;
				}
				const total = records.reduce((sum, r) => sum + r.inboundMessages, 0);
				const lines = records.slice(0, 20).map((r) => {
					const who = r.senderName || r.senderOpenId || r.chatId;
					const last = new Date(r.lastSeenAt).toLocaleString("zh-CN");
					return `- ${who} · ${r.inboundMessages} 条 · 最近 ${last}`;
				});
				const text = [
					`**用量统计**（${records.length} 个会话 · 共 ${total} 条入站消息）`,
					"",
					...lines,
					...(records.length > 20 ? ["", "*（仅显示最近 20 个会话）*"] : []),
				].join("\n");
				await durableReply(name, msg, text);
				return true;
			}
			case "files": {
				const key = bridge.conversationKeyFor(msg);
				const curWs = workspaceForTaskKey(key);
				const arg = _rawInput.trim();
				const target = arg ? resolveWorkspaceTarget(arg, curWs) : curWs;
				try {
					if (!statSync(target).isDirectory()) throw new Error("不是目录");
					const entries = readdirSync(target, { withFileTypes: true })
						.filter((entry) => !entry.name.startsWith("."))
						.slice(0, 60)
						.map((entry) =>
							entry.isDirectory() ? `📁 ${entry.name}/` : `📄 ${entry.name}`,
						);
					await durableReply(
						name,
						msg,
						[
							`**${target}**`,
							"",
							...(entries.length > 0 ? entries : ["（空目录）"]),
						].join("\n"),
					);
				} catch (err) {
					await durableReply(
						name,
						msg,
						`无法读取目录 \`${target}\`: ${
							err instanceof Error ? err.message : String(err)
						}`,
						{ status: "error" },
					);
				}
				return true;
			}
			default:
				return false;
		}
	};

	const commandRouter = createCommandRouter({
		ctx: bridge,
		commands: dshCommands,
		bridgeHandler,
		commandProgress: commandPanelSync,
	});

	/**
	 * Form values of a `card.action.trigger` callback.
	 *
	 * Feishu's v2 callback body carries them at `action.form_value` — SNAKE_CASE,
	 * per the official form-container docs — while this bridge used to read
	 * `action.formValue`. Neither the SDK nor the transport normalizes the key,
	 * so the camelCase read silently yielded undefined and every form (新建文件夹,
	 * 重命名, 多选问卷) behaved as if the user had submitted nothing. Accept both
	 * spellings: older SDK builds and hand-built payloads may still use camelCase.
	 */
	const formValuesOf = (payload: unknown): Record<string, unknown> | undefined => {
		const action = (payload as { action?: Record<string, unknown> } | undefined)?.action;
		const raw = action?.form_value ?? action?.formValue;
		return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
	};

	// Card action routing (schema 2.0 behaviors:[{type:"callback",value}]):
	// a button click arrives as card.action.trigger with the op value.
	const handleCardAction = async (data: unknown): Promise<void> => {
		try {
			const raw = data as {
				action?: { value?: Record<string, unknown> };
				message?: { message_id?: string };
				open_id?: string;
			};
			const value = raw.action?.value ?? {};
			const op = typeof value.op === "string" ? value.op : "";
			const panelCardId =
				typeof value._panel_card_id === "string"
					? value._panel_card_id
					: "";
			logger.info(`card action data: ${JSON.stringify(raw).slice(0, 600)}`);
			const chatId =
				(raw as { context?: { open_chat_id?: string } }).context
					?.open_chat_id ??
				(raw as { operator?: { operator_id?: { open_id?: string } } }).operator
					?.operator_id?.open_id ??
				raw.open_id ??
				"";
			const messageId = raw.message?.message_id ?? "";
			if (!op) return;
			// 网站预览 (site:*): 复用路由里的会话键或其会话根，刷新/停止隧道，
			// 并原地回发新卡片（链接可能已变）。
			if (op.startsWith("site:")) {
				const siteKey =
					routeStore.all().find((r) => r.chatId === chatId)?.sessionKey ??
					(chatId.startsWith("oc_") ? `p2p:${chatId}` : `p2p:${chatId}`);
				const candidates: string[] = [
					siteKey,
					siteKey.split("#")[0] ?? siteKey,
					chatId,
				];
				const entry = candidates
					.map((candidate) => sitePreviews.get(candidate))
					.find(Boolean);
				if (op === "site:refresh") {
					if (!entry) {
						await sender.sendText(chatId, "当前没有进行中的预览。");
						return;
					}
					const refreshed = await sitePreviews.refresh(entry.convKey);
					await sender.sendCard(
						chatId,
						sitePreviewCard({
							title: refreshed.title,
							publicUrl: refreshed.publicUrl,
							debugUrl: refreshed.debugUrl,
							origin: refreshed.target,
							label: refreshed.label,
							action: "刷新",
							expiresAt: refreshed.expiresAt,
						}),
					);
					return;
				}
				if (op === "site:stop") {
					for (const candidate of candidates) sitePreviews.stop(candidate);
					await sender.sendText(chatId, "🛑 预览已关闭，链接失效。");
					return;
				}
			}
			// 任务列表 (tasks:*): 运行中优先，原地切换/停止；切换后简报现状，
			// 运行中的任务把输出续在它自己的卡片里。
			if (op.startsWith("tasks:")) {
				const tasksKey = conversationKeyOf(
					routeStore.all().find((r) => r.chatId === chatId)?.sessionKey ??
						`p2p:${chatId}`,
				);
				const renderTaskCard = async (card: unknown): Promise<void> => {
					if (panelCardId) await commandPanelSync.replace(panelCardId, "tasks", card);
					else await sender.sendCard(chatId, card);
				};
				const renderTaskList = async (note?: string): Promise<void> => {
					await renderTaskCard(
						taskListCard({
							tasks: await taskRowsFor(tasksKey),
							workspace: workspaceFor(tasksKey),
							...(note ? { note } : {}),
						}),
					);
				};
				/** Row for an id that the listing may no longer contain. */
				const taskRowFor = async (taskId: string): Promise<TaskRow> =>
					(await taskRowsFor(tasksKey)).find((row) => row.taskId === taskId) ?? {
						taskId,
						seq: taskRegistry.taskSeqOf(taskId),
						status: "stopped",
						active: false,
						lastActivityAt: Date.now(),
					};
				if (op === "tasks:list") {
					await renderTaskList();
					return;
				}
				if (op === "tasks:exit") {
					if (panelCardId) {
						await commandPanelSync.collapse(panelCardId, "tasks", "已退出任务列表");
					} else {
						await sender.sendText(chatId, "已退出任务列表。");
					}
					return;
				}
				if (op === "tasks:new") {
					const task = conversations.createTask(tasksKey);
					await renderTaskCard(
						await taskBriefingFor(
							tasksKey,
							await taskRowFor(task.id),
							`已开启任务 #${task.seq}：下一条消息发到这里`,
						),
					);
					return;
				}
				if (op.startsWith("tasks:switch:")) {
					const taskId = decodeOpPath(op.slice("tasks:switch:".length));
					try {
						const { row, note } = await switchToTaskRow(
							tasksKey,
							await taskRowFor(taskId),
						);
						await renderTaskCard(await taskBriefingFor(tasksKey, row, note));
					} catch (err) {
						await renderTaskList(
							`切换失败：${err instanceof Error ? err.message : String(err)}`,
						);
					}
					return;
				}
				if (op.startsWith("tasks:open:")) {
					const sessionId = decodeOpPath(op.slice("tasks:open:".length));
					const known = (await taskRowsFor(tasksKey)).find(
						(row) => row.sessionId === sessionId,
					);
					try {
						const { row, note } = await switchToTaskRow(
							tasksKey,
							known ?? {
								sessionId,
								seq: 0,
								status: "stopped",
								active: false,
								historical: true,
								lastActivityAt: Date.now(),
							},
						);
						await renderTaskCard(await taskBriefingFor(tasksKey, row, note));
					} catch (err) {
						await renderTaskList(
							`接管失败：${err instanceof Error ? err.message : String(err)}`,
						);
					}
					return;
				}
				if (op.startsWith("tasks:stop:")) {
					const taskId = decodeOpPath(op.slice("tasks:stop:".length));
					await conversations.stopTask(tasksKey, taskId);
					await renderTaskCard(
						await taskBriefingFor(tasksKey, await taskRowFor(taskId), "已发送停止请求"),
					);
					return;
				}
				if (op.startsWith("tasks:refresh:")) {
					const taskId = decodeOpPath(op.slice("tasks:refresh:".length));
					await renderTaskCard(await taskBriefingFor(tasksKey, await taskRowFor(taskId)));
					return;
				}
				return;
			}
			// 对话管理 (manage:*): one panel rendered IN PLACE. Every branch
			// updates the same card, so browsing sessions never floods the chat,
			// and the exit button folds the panel instead of leaving it hanging.
			if (op.startsWith("manage:")) {
				const manageKey =
					routeStore.all().find((r) => r.chatId === chatId)?.sessionKey ??
					`p2p:${chatId}`;
				const current = currentSessionFor(manageKey);
				const renderManage = async (card: unknown): Promise<void> => {
					if (panelCardId) await commandPanelSync.replace(panelCardId, "manage", card);
					else await sender.sendCard(chatId, card);
				};
				const renderList = async (note?: string): Promise<void> => {
					await renderManage(
						sessionManageCard({
							sessions: await manageRowsFor(manageKey),
							currentSessionId: current,
							...(note ? { note } : {}),
						}),
					);
				};
				/** Row for the detail/ops views; an unlisted id still renders. */
				const rowFor = async (id: string): Promise<ManageableSession> => {
					const rows = await manageRowsFor(manageKey);
					const found = rows.find((row) => row.id === id);
					if (found) return found;
					const alias = sessionAliases.get(id);
					return {
						id,
						createdAt: Date.now(),
						...(alias ? { alias } : {}),
						cwd: workspaceFor(manageKey),
					};
				};
				const renderDetail = async (id: string, note?: string): Promise<void> => {
					await renderManage(
						sessionManageDetailCard({
							session: await rowFor(id),
							currentSessionId: current,
							...(note ? { note } : {}),
						}),
					);
				};
				const formValue = (): Record<string, unknown> | undefined =>
					(raw as { action?: { formValue?: Record<string, unknown> } }).action?.formValue;
				if (op === "manage:list") {
					await renderList();
					return;
				}
				if (op === "manage:exit") {
					if (panelCardId) {
						await commandPanelSync.collapse(panelCardId, "manage", "已退出对话管理");
					} else {
						await sender.sendText(chatId, "已退出对话管理。");
					}
					return;
				}
				if (op.startsWith("manage:pick:")) {
					await renderDetail(decodeOpPath(op.slice("manage:pick:".length)));
					return;
				}
				if (op.startsWith("manage:rename:submit:")) {
					const id = decodeOpPath(op.slice("manage:rename:submit:".length));
					try {
						const alias = sessionAliases.set(id, String(formValue()?.alias ?? ""));
						// A LIVE session also gets the REAL DSH title — the host's
						// title service refuses a session that is not in its store,
						// which is exactly why historical ones use the bridge alias.
						const live = (ctxGet("sessions") as { get?(id: string): unknown } | undefined)?.get?.(id);
						const titleService = ctxGet("sessionTitle") as
							| { rename?(session: unknown, title: string): unknown }
							| undefined;
						if (live && titleService?.rename) {
							try {
								titleService.rename(live, alias);
							} catch (err) {
								logger.warn(
									`manage: DSH title rename failed for ${id}: ${err instanceof Error ? err.message : String(err)}`,
								);
							}
						}
						logger.info(`manage: renamed ${id} to 「${alias}」`);
						await renderDetail(id, `已重命名为「${alias}」`);
					} catch (err) {
						await sender.sendText(
							chatId,
							`重命名失败：${err instanceof Error ? err.message : String(err)}`,
						);
					}
					return;
				}
				if (op.startsWith("manage:rename:")) {
					const id = decodeOpPath(op.slice("manage:rename:".length));
					await renderManage(sessionRenameCard({ session: await rowFor(id) }));
					return;
				}
				if (op.startsWith("manage:delete:confirm:")) {
					const id = decodeOpPath(op.slice("manage:delete:confirm:".length));
					try {
						const removed = await deleteSession(sessionAdminDeps(), id);
						sessionAliases.clear(id);
						logger.info(`manage: deleted session ${id} (${removed.dir})`);
						await renderList(`已删除会话「${id}」`);
					} catch (err) {
						await renderDetail(
							id,
							`删除失败：${err instanceof Error ? err.message : String(err)}`,
						);
					}
					return;
				}
				if (op === "manage:delete:cancel") {
					await renderList("已取消删除");
					return;
				}
				if (op.startsWith("manage:delete:")) {
					const id = decodeOpPath(op.slice("manage:delete:".length));
					await renderManage(sessionDeleteConfirmCard({ session: await rowFor(id) }));
					return;
				}
				if (op.startsWith("manage:move:to:")) {
					const [rawId = "", rawTarget = ""] = op
						.slice("manage:move:to:".length)
						.split("|");
					const id = decodeOpPath(rawId);
					try {
						const moved = moveSessionToProject(
							sessionAdminDeps(),
							id,
							decodeOpPath(rawTarget),
						);
						logger.info(`manage: migrated ${id} -> ${moved.to} (cwd ${moved.cwd})`);
						await renderDetail(id, `已迁移到 \`${moved.cwd}\``);
					} catch (err) {
						await renderDetail(
							id,
							`迁移失败：${err instanceof Error ? err.message : String(err)}`,
						);
					}
					return;
				}
				if (op.startsWith("manage:move:submit:")) {
					const id = decodeOpPath(op.slice("manage:move:submit:".length));
					const target = String(formValue()?.path ?? "").trim();
					try {
						if (!target) throw new Error("目标路径不能为空");
						if (!isAbsoluteAny(target)) throw new Error("请填写绝对路径");
						const moved = moveSessionToProject(sessionAdminDeps(), id, target);
						logger.info(`manage: migrated ${id} -> ${moved.to} (cwd ${moved.cwd})`);
						await renderDetail(id, `已迁移到 \`${moved.cwd}\``);
					} catch (err) {
						await renderDetail(
							id,
							`迁移失败：${err instanceof Error ? err.message : String(err)}`,
						);
					}
					return;
				}
				if (op.startsWith("manage:move:")) {
					const id = decodeOpPath(op.slice("manage:move:".length));
					await renderManage(
						sessionMoveCard({
							session: await rowFor(id),
							targets: listProjectCwds(sessionAdminDeps()),
						}),
					);
					return;
				}
				if (op.startsWith("manage:resume:")) {
					const id = decodeOpPath(op.slice("manage:resume:".length));
					// Hand off to the /resume flow, reusing THIS card as its panel.
					const knownRoute = routeStore.all().find((r) => r.chatId === chatId);
					const pseudoMessageId = messageId
						? `${messageId}#manage-resume`
						: `card#${Date.now()}`;
					if (panelCardId) {
						commandPanelSync.adopt(
							chatId,
							`bridge:resume:${pseudoMessageId}`,
							panelCardId,
							"resume",
						);
					}
					await bridgeHandler("resume", encodeURIComponent(id), {
						messageId: pseudoMessageId,
						chatId,
						chatType: knownRoute?.chatType === "group" ? "group" : "p2p",
						chatMode: knownRoute?.chatType === "group" ? "group_all" : "p2p",
						senderOpenId: chatId,
						msgType: "interactive",
						content: "",
						text: "",
						mentions: [],
						timestamp: Date.now(),
					});
					return;
				}
				return;
			}
			// op may be "name" (bare command) or "name:input" (picker callback).
			// Single-select answer: "uqa:<questionId>:<optionIndex>".
			// Multi-select answer: form submit op "uqam:<questionId>" — the
			// callback event carries action.formValue.answer (string[] of
			// selected option values, i.e. stringified option indexes).
			if (op.startsWith("uqam:")) {
				const questionId = op.slice("uqam:".length);
				const pending = pendingQuestions.get(questionId);
				if (pending) {
					clearTimeout(pending.timer);
					pendingQuestions.delete(questionId);
					const form = formValuesOf(raw);
					const answer = form?.answer;
					const selectedValues = Array.isArray(answer)
						? answer.map((v) => String(v))
						: typeof answer === "string" && answer
							? [answer]
							: [];
					const selected = selectedValues.map((v) => {
						const i = Number(v);
						return Number.isInteger(i) && pending.options[i]
							? pending.options[i].label
							: v;
					});
					void sender
						.sendText(pending.chatId, `已收到你的选择 ✅（${selected.join("、")}）`)
						.catch(() => undefined);
					pending.resolve({
						id: questionId,
						selected,
					});
				}
				return;
			}
			if (op.startsWith("uqa:")) {
				const parts = op.split(":");
				const questionId = parts[1] ?? "";
				const optionIndex = Number(parts[2] ?? NaN);
				const pending = pendingQuestions.get(questionId);
				if (pending) {
					clearTimeout(pending.timer);
					pendingQuestions.delete(questionId);
					const label =
						pending.options[optionIndex]?.label ?? String(optionIndex);
					void sender
						.sendText(pending.chatId, `已收到你的选择 ✅（${label}）`)
						.catch(() => undefined);
					pending.resolve({
						id: questionId,
						selected: [label],
					});
				}
				return;
			}
			if (op === "task:toggle_fold") {
				const knownRoute = routeStore.all().find((r) => r.chatId === chatId);
				const sessionKey = knownRoute?.sessionKey ?? (chatId ? `dm:${chatId}` : "");
				if (sessionKey) {
					const isFolded = typeof value.folded === "boolean" ? value.folded : undefined;
					await taskCardSyncer.toggleFold(sessionKey, isFolded);
				}
				return;
			}
			if (op === "task:focus_board") {
				const knownRoute = routeStore.all().find((r) => r.chatId === chatId);
				const sessionKey = knownRoute?.sessionKey ?? (chatId ? `dm:${chatId}` : "");
				if (sessionKey) {
					const st = taskCardSyncer.getState(sessionKey);
					if (st) {
						await sender.sendCard(chatId, buildTaskBoardCard(st));
					} else {
						await sender.sendText(chatId, "当前会话暂无活跃任务看板。");
					}
				}
				return;
			}
			if (op.startsWith("plan:approve_goal:")) {
				const questionId = op.slice("plan:approve_goal:".length);
				const pending = pendingQuestions.get(questionId);
				if (pending) {
					clearTimeout(pending.timer);
					pendingQuestions.delete(questionId);
					void sender.sendText(pending.chatId, "已批准方案，正在启动目标执行 🚀").catch(() => undefined);
					pending.resolve({ id: questionId, selected: ["Approve"] });
					const knownRoute = routeStore.all().find((r) => r.chatId === chatId);
					const sessionKey = knownRoute?.sessionKey ?? (chatId ? `dm:${chatId}` : "");
					const agentHandle = sessionKey ? bridge.backend?.get(sessionKey) : undefined;
					const rawAgent = resolveRawAgent(agentHandle);
					const goalsService = (ctx as unknown as { get?(name: string): unknown }).get?.("goals") as {
						create?(agent: unknown, req: { objective: string }): GoalSnapshotState;
					} | undefined;
					if (rawAgent && goalsService?.create) {
						try {
							const opt = pending.options[0] as { label?: string; description?: string } | undefined;
							const firstLine = (opt?.description ?? opt?.label ?? "").split("\n")[0] || "执行已批准的规划方案";
							goalsService.create(rawAgent, { objective: firstLine });
						} catch {
							// ignore
						}
					}
				}
				return;
			}
			if (op.startsWith("plan:approve_plain:")) {
				const questionId = op.slice("plan:approve_plain:".length);
				const pending = pendingQuestions.get(questionId);
				if (pending) {
					clearTimeout(pending.timer);
					pendingQuestions.delete(questionId);
					void sender.sendText(pending.chatId, "已批准方案 ✅，退出 Plan 模式继续执行。").catch(() => undefined);
					pending.resolve({ id: questionId, selected: ["Approve"] });
				}
				return;
			}
			if (op.startsWith("plan:feedback:")) {
				const questionId = op.slice("plan:feedback:".length);
				const pending = pendingQuestions.get(questionId);
				if (pending) {
					void sender.sendText(pending.chatId, "请在聊天框直接回复你的修改建议 💬，Agent 将在 Plan 模式下调整方案。").catch(() => undefined);
				}
				return;
			}
			if (op.startsWith("plan:cancel:")) {
				const questionId = op.slice("plan:cancel:".length);
				const pending = pendingQuestions.get(questionId);
				if (pending) {
					clearTimeout(pending.timer);
					pendingQuestions.delete(questionId);
					void sender.sendText(pending.chatId, "已放弃当前方案 🛑，退出 Plan 模式。").catch(() => undefined);
					const planModeService = (ctx as unknown as { get?(name: string): unknown }).get?.("planMode") as {
						set?(agent: unknown, active: boolean): unknown;
					} | undefined;
					const knownRoute = routeStore.all().find((r) => r.chatId === chatId);
					const sessionKey = knownRoute?.sessionKey ?? (chatId ? `dm:${chatId}` : "");
					const agentHandle = sessionKey ? bridge.backend?.get(sessionKey) : undefined;
					const rawAgent = resolveRawAgent(agentHandle);
					if (rawAgent && planModeService?.set) {
						try {
							planModeService.set(rawAgent, false);
						} catch {
							// ignore
						}
					}
					pending.resolve({ id: questionId, selected: ["Keep planning"] });
				}
				return;
			}
			// ---- workspace browser (single card, in-place streaming) -----------
			// Every navigation re-renders the SAME CardKit entity through
			// `_panel_card_id`, so browsing never posts another message.
			if (op.startsWith("ws:")) {
				const wsKey =
					routeStore.all().find((r) => r.chatId === chatId)?.sessionKey ??
					(chatId ? `dm:${chatId}` : "");
				if (!wsKey) return;
				const renderCard = async (card: unknown): Promise<void> => {
					if (panelCardId) {
						await commandPanelSync.replace(panelCardId, "workspace", card);
					} else {
						await sender.sendCard(chatId, card);
					}
				};
				const renderBrowser = async (path: string): Promise<void> => {
					await renderCard(buildWorkspaceBrowserCard(wsKey, path));
				};
				const renderError = async (title: string, err: unknown): Promise<void> => {
					await renderCard(
						markdownCard(
							`**${title}**\n\n${err instanceof Error ? err.message : String(err)}`,
							{ header: "工作区", accent: false },
						),
					);
				};
				/** Isolation guard: with isolation on, browsing stays in the subtree. */
				const insideIsolation = (target: string): boolean =>
					!getCfg().workspaceIsolation ||
					isInsideWorkspace(isolationRootFor(wsKey), target);
				const navigate = async (target: string): Promise<void> => {
					if (!insideIsolation(target)) {
						await renderError(
							"已开启用户隔离",
							`只能在自己的工作区（\`${isolationRootFor(wsKey)}\`）内浏览`,
						);
						return;
					}
					await renderBrowser(target);
				};
				if (op.startsWith("ws:cd:")) {
					await navigate(decodeOpPath(op.slice("ws:cd:".length)));
					return;
				}
				if (op.startsWith("ws:up:")) {
					await renderBrowser(decodeOpPath(op.slice("ws:up:".length)));
					return;
				}
				if (op.startsWith("ws:back:")) {
					await renderBrowser(decodeOpPath(op.slice("ws:back:".length)));
					return;
				}
				if (op.startsWith("ws:mk:submit:")) {
					const parent = decodeOpPath(op.slice("ws:mk:submit:".length));
					const form = formValuesOf(raw);
					try {
						const folderName = sanitizeDirectoryName(String(form?.name ?? ""));
						const target = join(parent, folderName);
						if (existsSync(target)) throw new Error("该目录已存在");
						mkdirSync(target, { recursive: false });
						// Re-render the parent: the new folder shows up in the list,
						// which doubles as the confirmation (no extra message).
						await renderBrowser(parent);
					} catch (err) {
						await renderError("新建文件夹失败", err);
					}
					return;
				}
				if (op.startsWith("ws:mk:")) {
					const parentPath = decodeOpPath(op.slice("ws:mk:".length));
					await renderCard(
						workspaceNewFolderCard({ parentPath }),
					);
					return;
				}
				if (op.startsWith("ws:pick:")) {
					const target = decodeOpPath(op.slice("ws:pick:".length));
					try {
						if (!statSync(target).isDirectory()) throw new Error("不是目录");
						if (!insideIsolation(target)) {
							throw new Error(
								`已开启用户隔离：只能切换到自己的目录（${isolationRootFor(wsKey)}）下`,
							);
						}
						// Same semantics as `/workspace <path>`: scope the switch to
						// THIS conversation and rotate (never dispose) so the GUI row
						// survives and the next message opens under the new cwd.
						convCfg.set(wsKey, {
							workspaceRoot: target,
							activeSessionId: undefined,
						});
						await conversations?.rotate(wsKey);
						if (panelCardId) {
							await commandPanelSync.collapse(
								panelCardId,
								"workspace",
								`工作区已切换: ${target}（下一条消息在新工作区生效）`,
							);
						} else {
							await sender.sendText(chatId, `工作区已切换: ${target}`);
						}
					} catch (err) {
						await renderError("切换失败", err);
					}
					return;
				}
				if (op === "ws:cancel") {
					if (panelCardId) {
						await commandPanelSync.collapse(
							panelCardId,
							"workspace",
							"已取消，保持原工作区",
						);
					} else {
						await sender.sendText(chatId, "已取消，保持原工作区。");
					}
					return;
				}
				return;
			}
			if (op.startsWith("goal:tpl:")) {
				const tpl = op.slice("goal:tpl:".length);
				const knownRoute = routeStore.all().find((r) => r.chatId === chatId);
				const sessionKey = knownRoute?.sessionKey ?? (chatId ? `dm:${chatId}` : "");
				const wsRoot = workspaceForTaskKey(sessionKey);
				let obj = "构建工程并运行全量测试验证";
				if (tpl === "fix") obj = "诊断并修复当前工程中的已知问题与测试失败";
				else if (tpl === "refactor") obj = "重构核心模块并补齐单元测试与文档";
				let agentHandle = sessionKey ? bridge.backend?.get(sessionKey) : undefined;
				if (!agentHandle && sessionKey) {
					try {
						agentHandle = await bridge.backend?.ensureAgent?.(sessionKey);
					} catch {
						// fall through
					}
				}
				const rawAgent = resolveRawAgent(agentHandle);
				const goalsService = (ctx as unknown as { get?(name: string): unknown }).get?.("goals") as {
					create?(agent: unknown, req: { objective: string }): GoalSnapshotState;
				} | undefined;
				try {
					if (rawAgent && goalsService?.create) {
						goalsService.create(rawAgent, { objective: obj });
					}
					await sender.sendText(chatId, `🎯 已设定目标：${obj}\nAgent 将围绕该目标自主执行。`);
				} catch (err) {
					await sender.sendText(chatId, `设定目标失败: ${err instanceof Error ? err.message : String(err)}`);
				}
				return;
			}


			const sep = op.indexOf(":");
			const cmd = sep === -1 ? op : op.slice(0, sep);
			const arg = sep === -1 ? "" : op.slice(sep + 1);
			// messageId must be UNIQUE per click: durableReply dedupes command
			// replies by `bridge:<cmd>:<messageId>`, and the card message id is
			// the same for every click on that card — a second click (e.g.
			// picking another model from the picker) used to be swallowed as a
			// duplicate, so the user got NO confirmation for the new choice.
			// chatType: reuse the known route for this chat so the pseudo message
			// lands on the right conversation lane (group vs dm).
			const knownRoute = routeStore.all().find((r) => r.chatId === chatId);
			const pseudo: FeishuInboundMessage = {
				messageId: messageId
					? `${messageId}#${op}`
					: `card#${Date.now()}#${op}`,
				chatId,
				chatType: knownRoute?.chatType === "group" ? "group" : "p2p",
				chatMode: knownRoute?.chatType === "group" ? "group_all" : "p2p",
				senderOpenId: chatId,
				msgType: "interactive",
				content: "",
				text: "",
				mentions: [],
				timestamp: Date.now(),
			};
			if (panelCardId) {
				commandPanelSync.adopt(
					chatId,
					`bridge:${cmd}:${pseudo.messageId}`,
					panelCardId,
					cmd,
				);
			}
			await bridgeHandler(cmd, arg, pseudo);
		} catch (err) {
			logger.error(`card action failed: ${String(err)}`);
		}
	};

	// GH #9: salvage answers a boot-replayed request from the session log's
	// EXISTING final assistant output (the turn had already completed; only
	// the bridge event was lost) instead of blindly re-invoking the agent.
	const sessionPersistenceService = (
		ctx as unknown as { get?(name: string): unknown }
	).get?.("sessionPersistence") as
		| {
				load?(id: string): Promise<{ events?: readonly unknown[] } | undefined>;
		  }
		| undefined;
	const replaySalvage = createReplaySalvage({
		loadSession: async (id) => sessionPersistenceService?.load?.(id),
		enqueue: (input) => outbox.enqueue(input),
		wal: inboundWal,
		logger,
	});

	const messageHandler = createMessageHandler({
		ctx: bridge,
		commands: commandRouter,
		groupTrigger,
		dedupe,
		usage: userUsage,
		allowlist: () => getCfg().allowlist,
		wal: inboundWal,
		// Persist inbound Feishu images/files as real local files so a
		// non-vision model / external tooling can read them off disk (the
		// DSH attachment store alone is in-memory). Root: OS TEMP DIR by
		// default — they are transient turn artifacts, not durable state;
		// the sweeper below bounds growth by age. attachments.dir overrides
		// (startup-time setting; takes effect after a reload).
		inboundDir:
			getCfg().attachments.dir.trim() ||
			join(tmpdir(), "dsh-lark-link", "inbound"),
	});

	// ---- conversations / turn supervisor --------------------------------------
	// Session keys whose in-flight turn has produced at least one deliverable
	// assistant output. Used to detect SILENT turn failures (no reply): when a
	// turn ends aborted/rejected WITHOUT any output, the agent is almost
	// certainly stuck (e.g. a reasoning model returning empty `content`, or a
	// swallowed model/tool error) and would keep swallowing every subsequent
	// message — the chat appears broken with no error. We recover it (dispose
	// → fresh session on next message) and surface a diagnostic so it's never
	// a silent no-reply again. Shared by every conversation (keyed by key).
	const turnDelivered = new Set<string>();
	const conversations = createConversationManager({
		backend,
		registry: taskRegistry,
		maxSessions: getCfg().maxSessions,
		idleTtlMs: getCfg().sessionIdleTtlMs,
		logger,
		// The conversation-level "current session" mirrors the ACTIVE task.
		onActiveSessionId: (key, sessionId) => {
			convCfg.set(key, { activeSessionId: sessionId });
		},
		// `key` below is the TASK id (`dm:oc_x#2`): per-task FIFO, per-task
		// watchdog and per-task streaming all key off it, while the inbound WAL
		// and the route table stay conversation-scoped (see conversationKey).
		onEvent: (key, event) => {
			const conversationKey = conversationKeyOf(key);
			void forwarder
				.onSessionEvent(key, event)
				.catch((e) => logger.warn(`forwarder: ${String(e)}`));
			// Arm the turn watchdog when a turn opens; disarm ONLY on real
			// (non-empty) output or turn end. An EMPTY assistant message (e.g.
			// reasoning models emit content-less messages) must NOT disarm the
			// watchdog — that is exactly how a hung turn used to disable its
			// own recovery and kill the chat until /new. Any observable
			// progress (text chunks, tool calls/results) refreshes the deadline.
			if (event.type === "turn/start") {
				turnDelivered.delete(key);
				streamHandles.delete(key);
				turnSupervisor.arm(key);
			}
			if (event.type === "assistant/chunk") {
				if ((event.text ?? "").trim() !== "") turnSupervisor.arm(key);
			}
			if (event.type === "assistant/reasoning") {
				if ((event.text ?? "").trim() !== "") turnSupervisor.arm(key);
			}
			if (event.type === "tool/call" || event.type === "tool/result") {
				turnSupervisor.arm(key); // tools run long legitimately — extend
			}
			if (event.type === "assistant/message") {
				if ((event.text ?? "").trim() !== "") {
					turnSupervisor.disarm(key);
					turnDelivered.add(key);
				} else {
					turnSupervisor.arm(key); // empty message — refresh, stay armed
				}
			}
			if (event.type === "turn/end") {
				turnSupervisor.disarm(key);
				streamHandles.delete(key);
				const reason = event.reason;
				const rescuedFinal = String(event.finalText ?? "").trim();
				const noOutput =
					!turnDelivered.has(key) &&
					(rescuedFinal === "" || rescuedFinal === "No response.");
				// "aborted" is user cancellation via /stop or supervisor cancel — NOT an unhandled failure.
				// Do not emit error diagnostic or reset session on "aborted".
				const silent =
					noOutput &&
					(reason === "rejected" ||
						reason === "failed" ||
						reason === "error");
				turnDelivered.delete(key);
				const imageRetryInFlight =
					silent && backend.consumeImageRetryGrace?.(key);
				if (noOutput && !imageRetryInFlight) {
					// A terminal no-output turn must never remain replayable: doing so
					// caused old prompts/images to surface minutes later when Web UI or
					// a restart woke replay. Settle the exact FIFO request as failed.
					// The WAL is CONVERSATION-scoped (one request queue per chat).
					inboundWal.failOldest(conversationKey);
					status.refreshCounters({
						inboundPending: inboundWal.pendingReplays().length,
						inboundFailed: inboundWal.failedCount(),
					});
				}
				if (imageRetryInFlight) {
					// An image-degrade retry (non-vision model) is in flight:
					// its turn/start already landed, so this silent turn/end
					// belongs to the ORIGINAL image turn. Let the retry answer.
					logger.warn(
						`turn ended '${reason}' for ${key} but an image-degrade retry is in flight; skipping error notice`,
					);
				} else if (silent && !getCfg().streaming.enabled) {
					logger.warn(
						`turn ended '${reason}' with no output for ${key}`,
					);
					const chatId = routeStore.get(key)?.chatId;
					if (chatId) {
						const failure = event.error;
						const detail = failure?.message ?? "";
						const diagnostic =
							failure?.code === "qwen_gateway_rate_limited" ||
							/Baxia|temporarily rejecting this account/i.test(detail)
								? "千问网页触发 Baxia 风控；自动退避重试仍被拒绝。请等待冷却，或使用 /model 切换模型后重试。"
								: failure?.code === "empty_response" || /empty response/i.test(detail)
									? "千问 SSE 已结束，但没有返回正文或有效工具调用。请重试；持续发生时建议 /new 后再试。"
									: /output changed before already-streamed content/i.test(detail)
										? "千问网页在流式输出期间改写了已发送内容，为避免返回截断文本，本轮已拒绝该结果。请重试。"
										: `模型轮次异常结束${failure?.code ? `（${failure.code}）` : ""}。请重试。`;
						void sender
							.sendText(
								chatId,
								`⚠️ 本轮没有产出回复：${diagnostic}`,
							)
							.catch(() => undefined);
					}
				}
				if (
					noOutput &&
					!imageRetryInFlight &&
					reason !== "aborted" &&
					reason !== "cancelled"
				) {
					// The observed failure mode is sticky: later followups are accepted
					// but the same DSH agent never emits again. /new fixes it because it
					// rotates the agent; do that automatically after the error card has
					// consumed this final event. `key` here is a TASK key, and rotate()
					// MINTS a task — passing the task key created a NESTED group
					// (`dm:oc_x#1` → `dm:oc_x#1#1`) that no message can ever route to:
					// an empty conversation the panels list but nothing can delete.
					// Normalize to the conversation first.
					queueMicrotask(() => {
						const conversationKey = conversationKeyOf(key);
						void conversations.rotate(conversationKey).catch((err) =>
							logger.warn(
								`automatic failed-turn rotation for ${conversationKey}: ${String(err)}`,
							),
						);
					});
				}
			}
		},
	});
	const turnSupervisor = createTurnSupervisor({
		backend,
		timeoutMs: 10 * 60_000,
		logger,
	});

	// ---- compensation -----------------------------------------------------------
	const compensation = createMissedCompensation({
		routes: routeStore,
		listMessages: (p) => sender.listMessages(p),
		reinject: (msg) => messageHandler.handleCompensated(msg),
		logger,
	});

	// ---- GUI-side model default poll -----------------------------------------
	// The deployment default model can change outside the bridge (dsh web UI).
	// The bridge used to sample it exactly once at boot, so a GUI switch was
	// never reflected (chats kept the old model) and never announced. Poll the
	// agentDefaultModel service; on change: adopt it as the bridge default,
	// push it into follower conversations (those WITHOUT a per-chat /model
	// override), and notify the affected Feishu chats which model is in effect.
	let lastModelSig =
		liveModelSelection.provider && liveModelSelection.model
			? `${liveModelSelection.provider}/${liveModelSelection.model}/${liveModelSelection.reasoningEffort ?? "default"}`
			: "";
	let modelPollTimer: NodeJS.Timeout | undefined;
	const startModelDefaultPoll = (): void => {
		if (modelPollTimer || !admService?.currentSelection) return;
		const t = setInterval(() => {
			try {
				// An app-specific default intentionally decouples this bridge from
				// host-wide GUI changes. This is how an admin can keep paid models
				// available in DSH while withholding them from this bot.
				if (getCfg().modelAccess.defaultModel) return;
				const cur = admService?.currentSelection?.();
				if (!cur?.provider || !cur.model) return;
				if (
					!isModelAllowed(getCfg().modelAccess, {
						provider: cur.provider,
						model: cur.model,
					})
				)
					return;
				const sig = `${cur.provider}/${cur.model}/${cur.reasoningEffort ?? "default"}`;
				if (sig === lastModelSig) return;
				lastModelSig = sig;
				liveModelSelection.provider = cur.provider;
				liveModelSelection.model = cur.model;
				liveModelSelection.reasoningEffort = cur.reasoningEffort;
				logger.info(`bridge default model now ${sig} (GUI-side switch)`);
			} catch {
				// best-effort
			}
		}, 10_000);
		t.unref?.();
		modelPollTimer = t;
	};
	const stopModelDefaultPoll = (): void => {
		if (modelPollTimer) clearInterval(modelPollTimer);
		modelPollTimer = undefined;
	};

	// ---- lifecycle -------------------------------------------------------------
	let lifecycleStarted = false;
	let startPromise: Promise<void> | undefined;
	let supervisor: ReturnType<typeof createConnectionSupervisor> | undefined;

	const startBridgeOnce = async (): Promise<void> => {
		if (lifecycleStarted) return;
		// Resolve credentials + build the lark client before wiring the transport.
		// Missing credentials is NOT fatal (the plugin must still load) — bail with
		// a clear blocker so /lark start reports it and the plugin survives.
		const ref = getCfg().credentialRef;
		const creds = await resolveCredentials(credStore, ref);
		if (!creds) {
			startBlocker = `未配置飞书凭据（ref=${ref}）。请先运行 /lark setup 扫码，或设置 DSH_LARK_APP_ID/DSH_LARK_APP_SECRET 后再 /lark setup。`;
			logger.warn(startBlocker);
			return;
		}
		startBlocker = undefined;
		logger.info("starting bridge…");
		try {
			larkClient = await buildLarkClient({
				appId: creds.appId,
				appSecret: creds.appSecret,
				domain: creds.domain,
				logger,
			});
		} catch (err) {
			startBlocker = `lark client 构建失败: ${err instanceof Error ? err.message : String(err)}`;
			logger.error(startBlocker);
			return;
		}
		bridge.setConversations(conversations);
		bridge.setOutbox(outbox);
		bridge.setForwarder(forwarder);
		bridge.setCompensation(compensation);
		outbox.rebuildFromDisk();
		outbox.start();
		turnSupervisor.start();
		startModelDefaultPoll();

		// Transport + supervisor (in-process): WS long connection owns reconnects
		// via probe-driven supervisor; card actions route through the same handler.
		const transport = createTransport({
			getClient: () => larkClient ?? ({} as FeishuClientLike),
			onMessage: async (msg) => {
				// Custom answer to a pending intent question: a plain-text reply
				// in the same chat resolves it instead of reaching the agent.
				const pendingForChat = [...pendingQuestions.values()].find(
					(p) => p.chatId === msg.chatId,
				);
				if (pendingForChat && (msg.text ?? "").trim() !== "") {
					clearTimeout(pendingForChat.timer);
					pendingQuestions.delete(pendingForChat.questionId);
					const text = (msg.text ?? "").trim();
					pendingForChat.resolve({
						id: pendingForChat.questionId,
						selected: [],
						custom: text,
					});
					return;
				}
				await messageHandler.handleInbound(msg);
			},
			onEvent: (event, data) => {
				if (event === "card.action.trigger") void handleCardAction(data);
			},
			logger,
		});
		bridge.setTransport(transport);
		const quota2 = createQuotaGovernor(join(dir, "conn-history.jsonl"), {
			windowMinutes: getCfg().quota.windowMinutes,
			limit: getCfg().quota.limit,
		});
		supervisor = createConnectionSupervisor({
			transport,
			quota: quota2,
			status,
			cfg: {
				probeIntervalMs: getCfg().supervisor.probeIntervalMs,
				probeTimeoutMs: getCfg().supervisor.probeTimeoutMs,
				probeFailThreshold: getCfg().supervisor.probeFailThreshold,
				maxReconnectAttempts: getCfg().supervisor.maxReconnectAttempts,
				idleKeepaliveMs: getCfg().supervisor.idleKeepaliveMs,
				quotaWindowMinutes: getCfg().quota.windowMinutes,
				quotaLimit: getCfg().quota.limit,
			},
			logger,
			onStateChange: (state, detail) => {
				if (state === "connected") bridge.setBotOpenId(transport.botOpenId());
				logger.info(`conn state: ${state}${detail ? ` (${detail})` : ""}`);
			},
		});
		await supervisor.start();
		bridge.setBotOpenId(transport.botOpenId());

		status.refreshCounters({
			outboxPending: outbox.pendingCount(),
			outboxFailed: outbox.failedCount(),
			inboundPending: inboundWal.pendingReplays().length,
			inboundFailed: inboundWal.failedCount(),
		});
		status.setConn("connected", {
			wsReady: transport.wsReady(),
		});
		bridge.setStarted(true);
		lifecycleStarted = true;
		// ---- inbound request replay (入站请求补发) -----------------------------
		// Any text request recorded as "accepted" but whose agent-turn never
		// produced a durable output was almost certainly interrupted by the
		// previous process dying / a plugin reload / a dsh restart. Re-dispatch
		// it through the normal inbound pipeline (skipDedupe via handleCompensated)
		// so the user's request is answered, not silently dropped. Each record is
		// attempt-capped (default 2) within a replay window (default 30 min), so a
		// genuinely broken request can't loop forever. Fire-and-forget: never
		// blocks bridge startup.
		void (async () => {
			let replayed = 0;
			let salvaged = 0;
			try {
				inboundWal.prune();
				for (const rec of inboundWal.pendingReplays()) {
					if (!inboundWal.markReplay(rec.messageId)) continue;
					// GH #9: the previous run may have COMPLETED the agent turn —
					// the session log already holds the final assistant output and
					// only the bridge event was lost. Answer from the log first;
					// re-run the agent only when no usable output exists.
					const sessionId = convCfg.get(rec.sessionKey).activeSessionId;
					if (await replaySalvage.salvage(rec, sessionId)) {
						salvaged++;
						continue;
					}
					try {
						await messageHandler.handleCompensated({
							messageId: rec.messageId,
							chatId: rec.chatId,
							chatType: rec.chatType,
							chatMode:
								rec.chatType === "p2p" ? "p2p" : "group_all",
							senderOpenId: rec.senderOpenId,
							msgType: "text",
							content: rec.text,
							text: rec.text,
							mentions: [],
							timestamp: rec.acceptedAt,
						});
						replayed++;
					} catch (err) {
						logger.warn(
							`inbound replay failed for ${rec.messageId}: ${
								err instanceof Error ? err.message : String(err)
							}`,
						);
					}
				}
				if (replayed > 0 || salvaged > 0)
					logger.info(
						`inbound replay: ${salvaged} answered from session logs, ${replayed} re-dispatched`,
					);
				// Reflect the post-replay counts (requests that could not be
				// immediately answered stay visible in /status for transparency;
				// GH #9: exhausted ones surface as failed instead of hiding).
				status.refreshCounters({
					inboundPending: inboundWal.pendingReplays().length,
					inboundFailed: inboundWal.failedCount(),
				});
			} catch (err) {
				logger.warn(
					`inbound replay errored: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			}
		})();
		logger.info("bridge started (in-process) [HMR-RELOAD-MARKER-2]");
	};
	const startBridge = (): Promise<void> => {
		if (lifecycleStarted) return Promise.resolve();
		if (startPromise) return startPromise;
		const pending = startBridgeOnce();
		startPromise = pending;
		const release = () => {
			if (startPromise === pending) startPromise = undefined;
		};
		void pending.then(release, release);
		return pending;
	};
	const stopBridge = async (): Promise<void> => {
		const pending = startPromise;
		if (pending) {
			try {
				await pending;
			} catch {
				// The start caller owns reporting. Disposal still must wait until the
				// failed attempt has released every partially-created transport.
			}
		}
		if (!lifecycleStarted) return;
		logger.info("stopping bridge…");
		turnSupervisor.stop();
		stopModelDefaultPoll();
		await supervisor?.stop();
		supervisor = undefined;
		await outbox.stop();
		await conversations.disposeAll();
		bridge.setStarted(false);
		status.setConn("stopped");
		lifecycleStarted = false;
		logger.info("bridge stopped");
	};
	applyBridgePolicy = async (input) => {
		if (!input || typeof input !== "object" || Array.isArray(input))
			throw new TypeError("策略内容无效");
		const body = input as {
			modelAccess?: {
				restricted?: unknown;
				allowedModels?: unknown;
				defaultModel?: unknown;
			};
			workspaceRoot?: unknown;
		};
		if (!body.modelAccess || typeof body.modelAccess !== "object")
			throw new TypeError("缺少模型访问策略");
		const catalog = await listModelCatalog();
		const catalogRefs = new Set(
			catalog.flatMap((group) =>
				group.models.map((model) =>
					modelRef({ provider: group.provider, model: model.id }),
				),
			),
		);
		const restricted = body.modelAccess.restricted === true;
		const allowedModels = normalizeModelRefs(body.modelAccess.allowedModels);
		const unknownAllowed = allowedModels.filter((ref) => !catalogRefs.has(ref));
		if (unknownAllowed.length > 0)
			throw new TypeError(`以下模型当前不可用: ${unknownAllowed.join(", ")}`);
		if (restricted && allowedModels.length === 0)
			throw new TypeError("启用模型白名单时至少保留一个模型");
		let defaultModel = String(body.modelAccess.defaultModel ?? "").trim();
		if (defaultModel) {
			const parsed = parseModelRef(defaultModel);
			if (!parsed || !catalogRefs.has(modelRef(parsed)))
				throw new TypeError(`默认模型当前不可用: ${defaultModel}`);
			defaultModel = modelRef(parsed);
		}
		if (restricted && defaultModel && !allowedModels.includes(defaultModel))
			throw new TypeError("默认模型必须位于允许列表中");
		if (restricted && !defaultModel) defaultModel = allowedModels[0] ?? "";

		const oldWorkspace = getCfg().workspaceRoot;
		const workspaceInput = String(body.workspaceRoot ?? "").trim();
		const workspaceRoot = workspaceInput
			? resolveWorkspaceTarget(oldWorkspace || process.cwd(), workspaceInput)
			: "";
		if (workspaceRoot) {
			if (!existsSync(workspaceRoot))
				throw new TypeError(`工作区不存在: ${workspaceRoot}`);
			if (!statSync(workspaceRoot).isDirectory())
				throw new TypeError(`工作区不是目录: ${workspaceRoot}`);
		}

		const nextPolicy = { restricted, allowedModels, defaultModel };
		const host = admService?.currentSelection?.();
		const firstCatalogModel = catalog[0]?.models[0]
			? {
					provider: catalog[0].provider,
					model: catalog[0].models[0]!.id,
			  }
			: undefined;
		const nextDefault =
			pickEffectiveDefault(
				nextPolicy,
				host?.provider && host.model
					? { provider: host.provider, model: host.model }
					: undefined,
			) ?? (!restricted ? firstCatalogModel : undefined);
		if (!nextDefault)
			throw new TypeError("当前策略无法解析出可用的默认模型");
		configStore.updateManagementPolicy({
			modelAccess: nextPolicy,
			workspaceRoot,
		});
		configStore.saveOverrides();
		liveModelSelection.provider = nextDefault.provider;
		liveModelSelection.model = nextDefault.model;
		delete liveModelSelection.reasoningEffort;

		// Existing explicit model overrides that have just been revoked are
		// cleared immediately. Live agents hold these mutable selections, so the
		// next turn cannot continue using a removed paid model.
		for (const key of convCfg.keys()) {
			const current = convCfg.get(key);
			if (
				current.provider &&
				current.model &&
				!isModelAllowed(getCfg().modelAccess, {
					provider: current.provider,
					model: current.model,
				})
			) {
				convCfg.set(key, {
					provider: undefined,
					model: undefined,
					reasoningEffort: undefined,
				});
			}
		}
		for (const [key, selection] of liveModels) {
			if (
				!selection.override ||
				!isModelAllowed(getCfg().modelAccess, selection)
			) {
				selection.provider = nextDefault.provider;
				selection.model = nextDefault.model;
				delete selection.reasoningEffort;
				selection.override = false;
				backend?.clearImageUnsupported?.(key);
			}
		}

		// A changed default workspace applies to conversations that did not opt
		// into their own /workspace. Rotate them so the next message really starts
		// in the new cwd instead of retaining an already-created agent's old cwd.
		if (workspaceRoot !== oldWorkspace) {
			const keys = new Set([
				...liveModels.keys(),
				...userUsage.list().map((usage) => usage.sessionKey),
			]);
			for (const key of keys) {
				if (convCfg.get(key).workspaceRoot) continue;
				convCfg.set(key, { activeSessionId: undefined });
				await conversations.rotate(key);
			}
		}

		logger.info(
			`app policy updated: models=${restricted ? allowedModels.join(",") : "all"} default=${modelRef(nextDefault)} workspace=${workspaceRoot || "process.cwd"}`,
		);
		return { modelAccess: getCfg().modelAccess, workspaceRoot };
	};
	applyManualCredentials = async (input) => {
		const credentials = normalizeManualCredentials(input);
		const previous = await resolveCredentials(
			credStore,
			getCfg().credentialRef,
		);
		const appSwitched = Boolean(
			previous && previous.appId !== credentials.appId,
		);
		await stopBridge();
		if (appSwitched) {
			// Routes, replay WAL, dedupe and outbox payloads belong to one bot
			// application. Reusing them after an App ID switch can replay the old
			// bot's messages through the new bot — a cross-application leak.
			await outbox.clear();
			routeStore.clear();
			convCfg.clearAll();
			dedupe.clear();
			inboundWal.clear();
			userUsage.clear();
			rmSync(join(dir, "conn-history.jsonl"), { force: true });
			status.refreshCounters({
				outboxPending: 0,
				outboxFailed: 0,
				inboundPending: 0,
				inboundFailed: 0,
			});
		}
		await persistCredentials(
			credStore,
			getCfg().credentialRef,
			credentials,
		);
		startBlocker = undefined;
		await startBridge();
		if (!lifecycleStarted)
			throw new Error(startBlocker ?? "飞书连接未能启动，请检查应用凭据");
		return {
			configured: true,
			appSwitched,
			appIdMasked: maskId(credentials.appId),
			domain: credentials.domain,
			connState: status.get().connState,
		};
	};
	applyBridgeControl = async (action) => {
		if (action === "stop") await stopBridge();
		else if (action === "restart") {
			await stopBridge();
			await startBridge();
		} else await startBridge();
		return { connState: status.get().connState };
	};

	// ---- site preview manager ----------------------------------------------------
	const sitePreviews = createSitePreviewManager({
		stateDir: stateDir(),
		logger,
	});

	// ---- tools ------------------------------------------------------------------
	ctx.tools.register(
		defineTool({
			name: "lark_send_local_file",
			description:
				"Send a local file or image to the current Feishu chat. Feishu-only: it needs the session to be bound to a Feishu conversation, so it fails in the DSH Web GUI.",
			parameters: {
				path: {
					type: "string",
					required: true,
					description: "Absolute local path",
				},
				kind: {
					type: "string",
					required: true,
					description:
						"image（png/jpeg/webp/gif，其他格式如 svg 自动按 file 发送）| file",
				},
				caption: { type: "string", description: "Optional caption text" },
			},
			output: {
				schema: { type: "string" },
				render: (_args, value) => [{ type: "text", text: value as string }],
			},
			async execute(args, exec) {
				// Resolve the requesting conversation FIRST — see routeForSessionId.
				const sessionId = (exec as { agent?: { id?: string } }).agent?.id ?? "";
				// The agent's workspace is its conversation's workspace (per-key
				// override ?? config.workspaceRoot; may differ from the dsh process
				// cwd after /workspace) — resolve relative paths against it and
				// whitelist it. Using process.cwd() wrongly rejects files the agent
				// just created in its workspace.
				const workspaceRoot = workspaceForTaskKey(
					conversationKeyForSessionId(sessionId),
				);
				// GH #7: drive-letter paths are absolute too, and containment
				// must use relative() — startsWith("/") joined a Windows
				// absolute path under the root and then always rejected it.
				const { abs, ok: inWorkspace } = resolveInWorkspacePath(
					args.path,
					workspaceRoot,
				);
				if (!inWorkspace) return "拒绝: 路径不在工作区内";
				const route = routeForSessionId(sessionId);
				// No Feishu conversation means there is nowhere to send a file —
				// say WHY instead of the generic "cannot locate".
				if (!route)
					return "错误: 当前会话未绑定飞书对话，无法发送文件（请在飞书里对我说）";
				const key = route.sessionKey;
				const client = getLarkClient();
				if (!client) return "错误: lark 客户端未就绪";
				// Feishu image upload only accepts raster formats — non-raster
				// (svg etc.) falls back to file upload regardless of kind.
				const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
				const isImage = args.kind === "image" && IMAGE_EXT.test(args.path);
				if (isImage ? !client.uploadImage : !client.uploadFile)
					return "错误: lark 客户端未就绪";
				let buf: Buffer;
				try {
					const st = statSync(abs);
					if (st.size > 25 * 1024 * 1024) return "错误: 文件超过 25MB 上限";
					buf = readFileSync(abs);
				} catch (err) {
					return `错误: 读取文件失败 (${err instanceof Error ? err.message : String(err)})`;
				}
				const fileName = args.path.split(/[\\/]/).pop() ?? "file";
				// Tolerate both real top-level and legacy {data:{...}} shapes (pi 2026-08-14).
				let uploadKey: string | undefined;
				if (isImage) {
					uploadKey = extractUploadKey(
						await client.uploadImage!({ image: buf }),
						"image_key",
					);
				} else {
					uploadKey = extractUploadKey(
						await client.uploadFile!({
							file_type: "file",
							file_name: fileName,
							file: buf,
						}),
						"file_key",
					);
				}
				if (!uploadKey) return "错误: 上传失败";
				// When this tool is called inside an active Agent turn, keep generated
				// imagery and the accompanying explanation in ONE CardKit message.
				// Fall back to a standalone Feishu image outside a live card (or when
				// CardKit is unavailable) so delivery remains reliable.
				const liveCard = streamHandles.get(key);
				if (isImage && liveCard && !liveCard.disposed) {
					await liveCard.image(uploadKey, args.caption || fileName);
					return `已嵌入当前回复卡片 ${args.path}`;
				}
				await sender.sendFile(
					route.chatId,
					uploadKey,
					isImage ? "image" : "file",
				);
				return `已发送 ${args.path}`;
				},
				}),
				);
				ctx.tools.register(
				defineTool({
				name: "lark_publish_site",
				description:
					"Publish a webpage/game/front-end artifact as a TEMPORARY public link the user can open on their phone, and deliver a Feishu site card. Provide ONE of: url (an http server already running, e.g. a dev server), port (its port), or dir (a built static directory — served by the bridge). The bridge owns the tunnel lifecycle: same target reuses the previous link, a dead tunnel is refreshed with a new link, a different target replaces the old one. Links expire after ~2h. Works from ANY session; the site card is only delivered when the session is bound to a Feishu chat — otherwise use the returned link in your reply.",
				parameters: {
					url: { type: "string", description: "http(s) URL already reachable from this host" },
					port: { type: "number", description: "port of an already-running local server" },
					dir: { type: "string", description: "absolute path of a static directory to serve (index.html)" },
					title: { type: "string", description: "optional display title" },
				},
				output: {
					schema: { type: "string" },
					render: (_args, value) => [{ type: "text", text: value as string }],
				},
				async execute(args, exec) {
					const sessionId = (exec as { agent?: { id?: string } }).agent?.id ?? "";
					// A Feishu route is OPTIONAL here: publishing a public link is
					// useful from the DSH Web GUI too, and it must still work for a
					// Feishu task whose reverse-map entry is gone (resumed task /
					// disposed idle agent). Only the CARD needs a chat.
					const route = routeForSessionId(sessionId);
					const convKey =
						route?.sessionKey ??
						(conversationKeyForSessionId(sessionId) || sessionId);
					let result;
					try {
						result = await sitePreviews.publish({
							convKey,
							...(route?.chatId ? { chatId: route.chatId } : {}),
							url: args.url,
							port: typeof args.port === "number" ? args.port : undefined,
							dir: typeof args.dir === "string" ? args.dir : undefined,
							title: typeof args.title === "string" ? args.title : undefined,
						});
					} catch (err) {
						return `错误: ${err instanceof Error ? err.message : String(err)}`;
					}
					let delivery = "当前会话未绑定飞书对话（如 DSH Web GUI），未发卡片；";
					if (route) {
						try {
							await sender.sendCard(
								route.chatId,
								sitePreviewCard({
									title: result.title,
									publicUrl: result.publicUrl,
									debugUrl: result.debugUrl,
									origin: result.target,
									label: result.label,
									action: result.action,
									expiresAt: result.expiresAt,
								}),
							);
							delivery = "网站卡片已发给用户；";
						} catch (err) {
							logger.warn(`site preview card send failed: ${err instanceof Error ? err.message : String(err)}`);
							delivery = "卡片发送失败；";
						}
					}
					return `已发布（${result.action}）: ${result.publicUrl}（调试 ${result.debugUrl}，约 2 小时有效）。${delivery}把链接也写进回复。`;
				},
				}),
				);
	ctx.tools.register(
		defineTool({
			name: "lark_config_get",
			description: "Read bridge config (hot-reloadable keys).",
			parameters: {},
			output: {
				schema: { type: "string" },
				render: (_a, v) => [{ type: "text", text: v as string }],
			},
			async execute() {
				return JSON.stringify(getCfg(), null, 2);
			},
		}),
	);

	// ---- commands (DSH-side /lark-*) -------------------------------------------
	const commandsCtx = ctx as unknown as {
		commands?: { register(d: unknown): void };
	};
	const registerCmd = (
		name: string,
		description: string,
		handler: (rawInput: string) => Promise<string>,
		inputHint?: string,
	): void => {
		commandsCtx.commands?.register?.({
			name,
			description,
			// input hint is REQUIRED for the DSH web composer to execute a
			// command with arguments: ui-commands' matchEnter returns a claim
			// only when desc.input is defined, otherwise a non-bare slash line
			// (/lark setup) falls through to the agent as a plain message.
			...(inputHint !== undefined ? { input: { hint: inputHint } } : {}),
			handler: async (inv: { rawInput?: string }) => ({
				kind: "success",
				text: await handler(inv?.rawInput ?? ""),
			}),
		});
	};
	// Shared /lark subcommand executor — used by the DSH command (/lark x) AND
	// the Feishu-side route (/lark x in chat). startBridge/stopBridge/runSetup
	// are resolved at call time (all initialized before any message arrives).
	const runLarkSubcommand = async (sub: string): Promise<string> => {
		switch (sub) {
			case "status":
				return formatStatusLine(status.get());
			case "start":
				await startBridge();
				return lifecycleStarted
					? "bridge started"
					: (startBlocker ?? "bridge 未启动");
			case "stop":
				await stopBridge();
				return "bridge stopped";
			case "restart":
				await stopBridge();
				await startBridge();
				return lifecycleStarted
					? "bridge restarted"
					: (startBlocker ?? "bridge 未启动");
			case "setup":
				return await runSetup();
			case "uninstall-clean":
				return await runUninstallClean();
			default:
				return "Lark Link 用法：/lark setup | start | stop | restart | status | uninstall-clean";
		}
	};
	// Single /lark command with subcommand dispatch (DSH command names can't
	// contain spaces — the space separates name from input — so /lark setup is
	// command 'lark' + input 'setup', not a 'lark setup' command).
	registerCmd(
		"lark",
		"Lark Link bridge — usage: /lark setup|start|stop|restart|status|uninstall-clean",
		async (rawInput) =>
			runLarkSubcommand((rawInput.trim().split(/\s+/)[0] ?? "").toLowerCase()),
		"setup|start|stop|restart|status|uninstall-clean",
	);

	/**
	 * Locate the DSH session log for a bridge session id. Persisted logs live
	 * at <DSH_HOME>/sessions/<workspace-dir>/<encoded-session-id>/session.jsonl.zstd
	 * where ":" encodes as "~003A" — scan every workspace dir for the match.
	 */
	/** Scan ~/.dsh/sessions for the most recently written lark-link session id. */
	const findLatestLarkSessionId = (): string | undefined => {
		const sessionsRoot = join(
			process.env.DSH_HOME ?? join(homedir(), ".dsh"),
			"sessions",
		);
		if (!existsSync(sessionsRoot)) return undefined;
		let latest: { id: string; mtime: number } | undefined;
		for (const wsDir of readdirSync(sessionsRoot)) {
			const wsPath = join(sessionsRoot, wsDir);
			let entries: string[] = [];
			try {
				entries = readdirSync(wsPath);
			} catch {
				continue;
			}
			for (const name of entries) {
				if (!name.includes("lark-link")) continue;
				const sessionDir = join(wsPath, name);
				const zstd = join(sessionDir, "session.jsonl.zstd");
				if (!existsSync(zstd)) continue;
				let mtime = 0;
				try {
					mtime = statSync(zstd).mtimeMs;
				} catch {
					continue;
				}
				if (!latest || mtime > latest.mtime) {
					latest = { id: name.replace(/~003A/g, ":"), mtime };
				}
			}
		}
		return latest?.id;
	};

	const buildSessionExportZip = async (
		sessionId: string,
		diagText: string,
		issueMd: string,
	): Promise<Buffer | undefined> => {
		try {
			const services = ctx as unknown as {
				get?(name: string): unknown;
			};
			const persistence = services.get?.("sessionPersistence") as
				| {
						readRaw?(
							id: string,
						): Promise<
							{ filename: string; content: string; meta?: unknown } | undefined
						>;
				  }
				| undefined;
			const query = services.get?.("sessionQuery") as
				| {
						traceSession?(id: string): Promise<{
							descendants: Array<{
								session: { header: { id: string } };
								descendants: Array<{
									session: { header: { id: string } };
									descendants: unknown[];
								}>;
							}>;
						}>;
				  }
				| undefined;
			const files: Array<{ name: string; data: Uint8Array }> = [];

			// Primary: same shape as the webui "Session log" download via the
			// sessionPersistence service.
			let root: { filename: string; content: string } | undefined;
			if (persistence?.readRaw) {
				try {
					root = await persistence.readRaw(sessionId);
				} catch (err) {
					logger.warn(
						`doctor: sessionPersistence.readRaw failed: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			} else {
				logger.warn(
					"doctor: sessionPersistence service unavailable — falling back to file scan",
				);
			}
			if (root) {
				files.push({
					name: root.filename,
					data: Buffer.from(root.content, "utf8"),
				});
				// Descendant (subagent) logs.
				const seen = new Set<string>([sessionId]);
				const collect = async (
					nodes: Array<{
						session: { header: { id: string } };
						descendants: unknown[];
					}>,
				): Promise<void> => {
					for (const node of nodes) {
						const id = node.session.header.id;
						if (seen.has(id)) continue;
						seen.add(id);
						const raw = await persistence?.readRaw?.(id);
						if (raw !== undefined) {
							const safe = id.replace(/[^A-Za-z0-9_-]/g, "_");
							files.push({
								name: `subagents/${safe}/${raw.filename}`,
								data: Buffer.from(raw.content, "utf8"),
							});
						}
						await collect((node.descendants ?? []) as typeof nodes);
					}
				};
				if (query?.traceSession) {
					try {
						const lineage = await query.traceSession(sessionId);
						await collect(lineage.descendants as never);
					} catch (err) {
						logger.warn(
							`doctor: traceSession failed (subagents skipped): ${err instanceof Error ? err.message : String(err)}`,
						);
					}
				}
			}

			// Fallback: locate the session log on disk directly (node:zlib
			// decompresses zstd; no system unzstd needed).
			if (files.length === 0) {
				const sessionsRoot = join(
					process.env.DSH_HOME ?? join(homedir(), ".dsh"),
					"sessions",
				);
				const encoded = sessionId.replace(/:/g, "~003A");
				let zstdPath: string | undefined;
				if (existsSync(sessionsRoot)) {
					for (const wsDir of readdirSync(sessionsRoot)) {
						const candidate = join(
							sessionsRoot,
							wsDir,
							encoded,
							"session.jsonl.zstd",
						);
						if (existsSync(candidate)) {
							zstdPath = candidate;
							break;
						}
					}
				}
				if (!zstdPath) {
					logger.warn(
						`doctor: no session log found for ${sessionId} (service + file scan)`,
					);
					return undefined;
				}
				const jsonl = zstdDecompressSync(readFileSync(zstdPath)).toString(
					"utf8",
				);
				logger.info(`doctor: file-scan fallback used: ${zstdPath}`);
				files.push({ name: "session.jsonl", data: Buffer.from(jsonl, "utf8") });
			}

			// ISSUE.md + README (diagnostic bundle extras).
			files.push({
				name: "ISSUE.md",
				data: Buffer.from(
					`# dsh-lark-link 诊断包\n\n${diagText}\n\n${issueMd}\n`,
					"utf8",
				),
			});
			files.push({
				name: "README.txt",
				data: Buffer.from(
					[
						"本压缩包内容：",
						"- session.jsonl: 当前会话的 DSH session log（与 WebUI 右上角 Session log 下载一致）",
						"- subagents/: 子代理会话日志",
						"- ISSUE.md: 脱敏诊断信息（配置/连接状态/Outbox 等）",
						"",
						"将本包直接发给维护者，或贴 ISSUE.md 给 AI 即可定位问题。",
					].join("\n"),
					"utf8",
				),
			});

			// fflate sync ZIP (same compressor family the host export uses;
			// zipSync returns the archive directly — the streaming Zip callback
			// fires asynchronously, so reading its output synchronously would
			// yield an empty buffer).
			const { zipSync, strToU8 } = await import("fflate");
			const entries: Record<string, Uint8Array> = {};
			for (const f of files) {
				entries[f.name] = strToU8(new TextDecoder().decode(f.data));
			}
			const buf = Buffer.from(zipSync(entries, { level: 6 }));
			logger.info(
				`doctor: zip built (${files.length} files, ${buf.length} bytes)`,
			);
			return buf;
		} catch (err) {
			logger.warn(
				`doctor: zip build failed: ${err instanceof Error ? err.message : String(err)}`,
			);
			return undefined;
		}
	};

	const runSetup = async (): Promise<string> => {
		const ref = getCfg().credentialRef;
		// Manual channel via env (headless / GUI / CI).
		const envAppId = process.env.DSH_LARK_APP_ID?.trim();
		const envSecret = process.env.DSH_LARK_APP_SECRET?.trim();
		if (envAppId && envSecret) {
			const envDomain = (
				process.env.DSH_LARK_DOMAIN === "lark" ? "lark" : "feishu"
			) as LarkDomain;
			await persistCredentials(credStore, ref, {
				appId: envAppId,
				appSecret: envSecret,
				domain: envDomain,
			});
			return `凭据已保存（env 手动，appId=${maskId(envAppId)}，domain=${envDomain}）。运行 /lark start 启动。`;
		}
		// QR channel — NON-BLOCKING. registerApp only resolves AFTER the user
		// scans; awaiting it would hang the GUI ("执行中…") and the QR was only
		// going to host stdout. So: run registerApp detached in the background
		// (persists creds on scan), surface the QR URL to the GUI as soon as
		// onQRCodeReady fires, and return immediately.
		let qrInfo: { url: string; expireIn: number } | undefined;
		void (async () => {
			const setup = createAuthSetup({
				// SDK registerApp is broken under Node ESM: its axios 1.19.x
				// `default.default` entry (index.js → lib/axios.js) drives https
				// through http.request → "Protocol \"https:\" not supported".
				// Use the fetch-based implementation of the same device-code flow.
				registerApp: registerAppWithFetch(),
				persist: async (c) => {
					await persistCredentials(credStore, ref, c);
				},
				logger,
			});
			try {
				const res = await setup.run({
					onQRCodeReady(info) {
						qrInfo = info;
						// Render a PNG for the Web GUI panel (host-served route) and mirror
						// an ASCII QR to the terminal for TTY users.
						void QRCode.toBuffer(info.url, {
							type: "png",
							margin: 1,
							width: 256,
						})
							.then((png) => {
								activeQr = {
									png,
									expireAt: Date.now() + info.expireIn * 1000,
								};
							})
							.catch((e) =>
								logger.warn(
									`qr png failed: ${e instanceof Error ? e.message : String(e)}`,
								),
							);
						try {
							qrcode.generate(info.url, { small: true }, (qr) =>
								console.log(`\n${qr}`),
							);
						} catch {
							// qrcode-terminal optional
						}
					},
					onStatusChange: (s) => logger.info(`setup: ${s}`),
				});
				logger.info(`setup complete: appId=${res.appId} domain=${res.domain}`);
				activeQr = undefined;
			} catch (err) {
				logger.warn(
					`setup background failed: ${err instanceof Error ? err.message : String(err)}`,
				);
				activeQr = undefined;
			}
		})();
		// Bounded wait for the QR to appear (registerApp reaches Feishu first).
		const deadline = Date.now() + 30_000;
		while (!qrInfo && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 200));
		}
		if (!qrInfo) {
			return "扫码流程未在 30s 内就绪。可改用手动通道：设 DSH_LARK_APP_ID + DSH_LARK_APP_SECRET 后再 /lark setup。";
		}
		console.log(
			`飞书授权二维码链接: ${qrInfo.url}（${qrInfo.expireIn} 秒后过期）`,
		);
		return [
			"📱 飞书授权二维码已生成 —— 见左侧 🪶 Lark 面板（或终端），手机飞书扫码确认。",
			"",
			`二维码 ${qrInfo.expireIn} 秒后过期。扫码后凭据在后台写入，运行 /lark start 启动。`,
			`备用链接（手机浏览器打开）：${qrInfo.url}`,
			"看不到二维码？终端也打印了；或用 DSH_LARK_APP_ID/SECRET 手动通道。",
		].join("\n");
	};

	const runUninstallClean = async (): Promise<string> => {
		await stopBridge();
		const ref = getCfg().credentialRef;
		await clearCredentials(credStore, ref);
		larkClient = undefined;
		for (const f of [
			"config.json",
			"routes.json",
			"dedupe.jsonl",
			"conn-history.jsonl",
			"status.json",
			"runtime-overrides.json",
		]) {
			try {
				rmSync(join(dir, f), { force: true });
			} catch {
				// best effort
			}
		}
		try {
			rmSync(join(dir, "outbox"), { recursive: true, force: true });
		} catch {
			// best effort
		}
		try {
			rmSync(join(dir, "inbound-wal"), { recursive: true, force: true });
		} catch {
			// best effort
		}
		return `已清除凭据（ref=${ref}）并清理状态目录 ${dir}。重新使用请运行 /lark setup。`;
	};

	// ---- system prompt section ---------------------------------------------------
	try {
		(
			ctx as unknown as { systemPrompt?: { section(s: unknown): void } }
		).systemPrompt?.section?.({
			priority: 200,
			section: () => ({
				role: "system",
				content: [
					"你正在通过飞书/Lark 桥接与用户对话。",
					"可用工具: lark_send_local_file（发送本地文件到当前飞书会话）、lark_publish_site（把网页/游戏/前端产物发布成临时公网链接并给用户发网站卡片）、lark_config_get（读取桥配置）。",
					"需要让用户临时查看网页/游戏/前端产物时，调用 lark_publish_site：dev server 跑起来后传 port=<端口>；纯静态产物传 dir=<构建产物目录>。工具会自动管理隧道生命周期（相同目标自动复用旧链接）并把网站卡片发给用户；不要自己拼公网链接，也不要重复发布相同目标。",
					"回复要简洁；长输出会自动流式呈现给用户。",
				].join("\n"),
			}),
		});
	} catch {
		// prompt section optional
	}

	// ---- lifecycle registration (Cordis disposer — clean unload) ----------------
	ctx.effect(() => {
		void startBridge();
		// Inbound media retention: sweep expired temp files (startup + hourly;
		// retentionHours is read LIVE so /lark-config hot-reload applies).
		const stopMediaSweeper = startMediaSweeper({
			mediaDir: join(
				getCfg().attachments.dir.trim() ||
					join(tmpdir(), "dsh-lark-link", "inbound"),
				"media",
			),
			retentionHours: () => getCfg().attachments.retentionHours,
			logger,
		});
		const sweep = setInterval(() => {
			const n = conversations.sweep();
			status.update({
				sessions: conversations.size(),
				outboxPending: outbox.pendingCount(),
				outboxFailed: outbox.failedCount(),
				inboundPending: inboundWal.pendingReplays().length,
				inboundFailed: inboundWal.failedCount(),
			});
			if (n > 0) logger.info(`conversation sweep disposed ${n} idle session(s)`);
		}, 60_000);
		sweep.unref?.();
		return async () => {
			clearInterval(sweep);
			stopMediaSweeper();
			sitePreviews.stopAll();
			await stopBridge();
		};
	});
}