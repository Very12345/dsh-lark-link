import { defineTool } from "@deepseek-ai/dsh-tools";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, win32 } from "node:path";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { gzipSync, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import * as qrcode from "qrcode-terminal";
import QRCode from "qrcode";
//#region src/sessions/dsh-adapter.ts
function textOf(blocks) {
	return (blocks ?? []).filter((b) => b.type === "text" && b.text !== void 0).map((b) => b.text).join("");
}
function reasoningOf(blocks) {
	return (blocks ?? []).filter((b) => b.type === "reasoning" && b.text !== void 0).map((b) => b.text).join("");
}
function nestedText(value) {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(nestedText).filter(Boolean).join("\n");
	if (!value || typeof value !== "object") return "";
	const row = value;
	if (typeof row.text === "string") return row.text;
	if (row.content !== void 0) return nestedText(row.content);
	return "";
}
/**
* Project DSH's `TokenUsage` onto the bridge's harness-agnostic snapshot.
*
* `assistant/message.usage` is the ONLY place token accounting is recorded —
* there is no separate usage event — and DSH omits it when the adapter reported
* none. Returning undefined for an empty/missing payload is therefore
* deliberate: the card header falls back to its own visible estimate instead of
* claiming "0 tok".
*/
function tokenUsageOf(value) {
	if (!value || typeof value !== "object") return void 0;
	const row = value;
	const num = (key) => {
		const found = row[key];
		return typeof found === "number" && Number.isFinite(found) ? found : void 0;
	};
	const inputTokens = num("inputTokens");
	const outputTokens = num("outputTokens");
	const totalTokens = num("totalTokens");
	const cacheReadTokens = num("cacheReadTokens");
	const cacheWriteTokens = num("cacheWriteTokens");
	const reasoningTokens = num("reasoningTokens");
	if (inputTokens === void 0 && outputTokens === void 0 && totalTokens === void 0 && cacheReadTokens === void 0) return;
	return {
		inputTokens: inputTokens ?? 0,
		outputTokens: outputTokens ?? 0,
		...totalTokens !== void 0 ? { totalTokens } : {},
		...cacheReadTokens !== void 0 ? { cacheReadTokens } : {},
		...cacheWriteTokens !== void 0 ? { cacheWriteTokens } : {},
		...reasoningTokens !== void 0 ? { reasoningTokens } : {}
	};
}
function toSessionEventOut(ev) {
	const raw = ev;
	switch (raw.type) {
		case "turn/start": return { type: "turn/start" };
		case "assistant/chunk": {
			const c = raw.data?.chunk;
			if (c?.type === "text-delta") return {
				type: "assistant/chunk",
				text: c.text
			};
			if (c?.type === "reasoning-delta") return {
				type: "assistant/reasoning",
				text: c.text
			};
			return;
		}
		case "assistant/message": return {
			type: "assistant/message",
			text: textOf(raw.data?.message?.content),
			reasoning: reasoningOf(raw.data?.message?.content),
			hasToolCalls: Array.isArray(raw.data?.message?.content) && raw.data.message.content.some((block) => block?.type === "tool-call"),
			usage: tokenUsageOf(raw.data?.usage)
		};
		case "turn/end": return {
			type: "turn/end",
			reason: raw.data?.reason?.kind ?? "done"
		};
		case "tool/call": return {
			type: "tool/call",
			name: raw.data?.name,
			callId: raw.data?.callId,
			arguments: typeof raw.data?.arguments === "string" ? raw.data.arguments : raw.data?.arguments === void 0 ? void 0 : JSON.stringify(raw.data.arguments)
		};
		case "tool/result": return {
			type: "tool/result",
			name: raw.data?.message?.content?.[0]?.type ?? "?",
			callId: raw.data?.message?.source?.callId,
			output: nestedText(raw.data?.message?.content),
			error: raw.data?.error
		};
		case "todo/write": {
			const d = raw.data;
			if (Array.isArray(d?.todos)) return {
				type: "todo/write",
				todos: d.todos
			};
			if (Array.isArray(raw.data)) return {
				type: "todo/write",
				todos: raw.data
			};
			return;
		}
		case "goal/change": {
			const d = raw.data;
			const target = d?.goal ?? d;
			if (target && typeof target.id === "string" && typeof target.objective === "string") return {
				type: "goal/change",
				goal: {
					id: target.id,
					revision: typeof target.revision === "number" ? target.revision : 1,
					objective: target.objective,
					phase: target.phase || "active",
					roundsStarted: typeof d.roundsStarted === "number" ? d.roundsStarted : typeof target.roundsStarted === "number" ? target.roundsStarted : 0,
					maxGoalRounds: typeof target.maxGoalRounds === "number" ? target.maxGoalRounds : 256,
					blockedReason: target.blockedReason,
					createdAt: typeof d.createdAt === "number" ? d.createdAt : typeof target.createdAt === "number" ? target.createdAt : Date.now(),
					updatedAt: typeof d.updatedAt === "number" ? d.updatedAt : typeof target.updatedAt === "number" ? target.updatedAt : Date.now()
				}
			};
			if (d?.operation === "clear" && d.cleared) return {
				type: "goal/change",
				goal: {
					id: d.cleared.id,
					revision: d.cleared.revision,
					objective: "(目标已清除)",
					phase: "complete",
					roundsStarted: 0,
					maxGoalRounds: 0,
					createdAt: Date.now(),
					updatedAt: Date.now()
				}
			};
			return;
		}
		default: return;
	}
}
function isImageUnsupportedError(errText, errCode) {
	if (errCode === "UNSUPPORTED_CONTENT" && /image|vision|multimodal|content/i.test(errText)) return true;
	return /does not support image/i.test(errText) || /does not support .*image/i.test(errText) || /adapter does not support image/i.test(errText) || /model .* does not support image/i.test(errText) || /model does not support/i.test(errText) && /image|vision/i.test(errText) || /image (?:input|content) is not supported/i.test(errText) || /not support (?:image|images|vision|multimodal)/i.test(errText) || /unsupported (?:image|content|content_type)/i.test(errText) || /cannot represent .*image/i.test(errText) || /image.*requires the durable attachment service/i.test(errText) || /UNSUPPORTED_CONTENT/i.test(errText);
}
function createDshAdapter(deps) {
	const c = deps.ctx;
	const selFor = (key) => {
		const ms = deps.modelSelection;
		if (!ms) return void 0;
		if ("currentFor" in ms) return ms.currentFor(key);
		return ms.current;
	};
	const tracked = /* @__PURE__ */ new Map();
	const keyBySession = /* @__PURE__ */ new Map();
	const listeners = /* @__PURE__ */ new Map();
	const disposers = /* @__PURE__ */ new Map();
	const lastAssistantText = /* @__PURE__ */ new Map();
	const lastAgentError = /* @__PURE__ */ new Map();
	const ensureInFlight = /* @__PURE__ */ new Map();
	let runNonce = deps.runNonce ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
	const generations = /* @__PURE__ */ new Map();
	const bridgeKey = (key) => `${deps.sessionPrefix}:${key}:${runNonce}:${generations.get(key) ?? 0}`;
	const pendingResume = /* @__PURE__ */ new Map();
	const presetOverrides = /* @__PURE__ */ new Map();
	const imageUnsupportedKeys = /* @__PURE__ */ new Set();
	const imageUnsupportedModels = /* @__PURE__ */ new Set();
	const imageRetryGrace = /* @__PURE__ */ new Set();
	const pendingImageRetry = /* @__PURE__ */ new Map();
	/**
	* Thoroughly retire/evict any live agent or session matching targetSessionId from memory.
	* DSH session persistence requires targetSessionId to be completely absent from ctx.sessions
	* before agents.resume / sessionPersistence.prepare can execute.
	*/
	const releaseLiveSession = async (targetSessionId) => {
		for (const [k, t] of Array.from(tracked.entries())) if (t.handle.sessionId === targetSessionId) {
			disposers.get(k)?.();
			disposers.delete(k);
			listeners.delete(k);
			tracked.delete(k);
			keyBySession.delete(targetSessionId);
			try {
				await t.handle.dispose();
			} catch (err) {
				deps.logger?.warn?.(`releaseLiveSession: error disposing tracked handle for ${targetSessionId}: ${String(err)}`);
			}
		}
		const ownerKey = keyBySession.get(targetSessionId);
		if (ownerKey) {
			keyBySession.delete(targetSessionId);
			const t = tracked.get(ownerKey);
			if (t) {
				disposers.get(ownerKey)?.();
				disposers.delete(ownerKey);
				listeners.delete(ownerKey);
				tracked.delete(ownerKey);
				try {
					await t.handle.dispose();
				} catch {}
			}
		}
		try {
			const agentsRegistry = c.agents;
			if (agentsRegistry) {
				const liveAgent = agentsRegistry.get?.(targetSessionId);
				if (liveAgent?.ctx) try {
					await (liveAgent.ctx.scope?.dispose?.() ?? liveAgent.ctx.dispose?.());
				} catch {}
				const list = agentsRegistry.list?.() ?? [];
				for (const a of list) if (a.id === targetSessionId || a.session?.id === targetSessionId) try {
					await (a.ctx?.scope?.dispose?.() ?? a.ctx?.dispose?.());
				} catch {}
				const agentStore = agentsRegistry.store;
				if (agentStore && agentStore.has(targetSessionId)) {
					const entry = agentStore.get(targetSessionId);
					try {
						await (entry?.agent?.ctx?.scope?.dispose?.() ?? entry?.agent?.ctx?.dispose?.());
					} catch {}
					try {
						entry?.detach?.();
					} catch {}
					agentStore.delete(targetSessionId);
				}
				if (agentsRegistry.agents && agentsRegistry.agents.has(targetSessionId)) agentsRegistry.agents.delete(targetSessionId);
				if (typeof agentsRegistry.delete === "function") try {
					agentsRegistry.delete(targetSessionId);
				} catch {}
			}
		} catch {}
		try {
			const sessionsRegistry = c.sessions;
			if (sessionsRegistry?.store && sessionsRegistry.store.has(targetSessionId)) {
				const entry = sessionsRegistry.store.get(targetSessionId);
				try {
					entry?.detach?.();
				} catch {}
				sessionsRegistry.store.delete(targetSessionId);
			}
		} catch {}
		try {
			const persistence = c.get?.("sessionPersistence") ?? c.sessionPersistence;
			if (typeof persistence?.waitForRetirement === "function") await persistence.waitForRetirement(targetSessionId);
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 0));
	};
	const rotateKey = (key) => {
		pendingImageRetry.delete(key);
		lastAssistantText.delete(key);
		lastAgentError.delete(key);
		runNonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		generations.delete(key);
		presetOverrides.delete(key);
		deps.setActiveSessionId?.(key, void 0);
		const t = tracked.get(key);
		if (t) {
			disposers.get(key)?.();
			disposers.delete(key);
			listeners.delete(key);
			tracked.delete(key);
			const oldId = t.handle.sessionId;
			if (oldId) keyBySession.delete(oldId);
			try {
				t.handle.dispose();
			} catch {}
		}
	};
	async function ensureAgent(key) {
		const existing = tracked.get(key);
		if (existing) {
			existing.lastUsedAt = Date.now();
			return existing.handle;
		}
		const inFlight = ensureInFlight.get(key);
		if (inFlight) return inFlight.then((h) => {
			const t = tracked.get(key);
			if (t) t.lastUsedAt = Date.now();
			return h;
		});
		const p = (async () => {
			const pending = pendingResume.get(key);
			let sessionId = pending?.sessionId ?? bridgeKey(key);
			let owned;
			const sel = selFor(key);
			const defaultModel = sel?.provider && sel.model ? sel : void 0;
			const agentOptions = defaultModel ? {
				provider: defaultModel.provider,
				model: defaultModel.model,
				...defaultModel.reasoningEffort === void 0 ? {} : { reasoningEffort: defaultModel.reasoningEffort }
			} : void 0;
			if (!defaultModel) deps.logger?.warn(`no model selection — bridge agent for ${key} has no provider/model; turns will fail unless one is supplied`);
			const setup = async (agentCtx) => {
				const sel = selFor(key);
				if (sel?.provider && sel.model) installModelSelection(agentCtx, {
					current: sel,
					assembled: void 0
				});
				const presets = c.get?.("agentPresets");
				if (presets?.mount) {
					const requestedPreset = presetOverrides.get(key) ?? deps.preset?.(key) ?? "ptc";
					let actualPreset = requestedPreset === "code" ? "ptc" : requestedPreset;
					try {
						const ids = new Set((await presets.list?.())?.map((row) => row.id) ?? []);
						if (ids.has(requestedPreset)) actualPreset = requestedPreset;
						else if (requestedPreset === "ptc" && ids.has("code")) actualPreset = "code";
						else if (requestedPreset === "code" && ids.has("ptc")) actualPreset = "ptc";
					} catch {}
					await presets.mount(agentCtx, actualPreset);
				}
				if (deps.askUserQuestion) {
					const askTool = defineTool({
						name: "ask_user_question",
						description: "Ask the user a concise question when you need confirmation, a choice, or missing information before proceeding. Send one or more questions, each with a stable id that will be echoed in the answer.",
						parameters: { questions: {
							type: "array",
							required: true,
							description: "Questions to ask the user before continuing.",
							items: {
								type: "object",
								additionalProperties: true,
								properties: {
									id: {
										type: "string",
										required: true,
										description: "Stable id for this question; echoed in the answer."
									},
									question: {
										type: "string",
										required: true,
										description: "The specific question to ask the user."
									},
									header: {
										type: "string",
										description: "Optional short heading for the question."
									},
									options: {
										type: "array",
										description: "Optional choices to show the user.",
										items: {
											type: "object",
											additionalProperties: true,
											properties: {
												label: {
													type: "string",
													required: true,
													description: "Short user-facing option label."
												},
												description: {
													type: "string",
													description: "One sentence explaining the tradeoff or impact."
												}
											}
										}
									},
									multi_select: {
										type: "boolean",
										description: "Whether the user may select more than one option. Defaults to false."
									}
								}
							}
						} },
						output: {
							schema: {
								type: "object",
								additionalProperties: false,
								properties: { answers: {
									type: "array",
									required: true,
									items: {
										type: "object",
										additionalProperties: false,
										properties: {
											id: {
												type: "string",
												required: true
											},
											selected: {
												type: "array",
												required: true,
												items: { type: "string" }
											},
											custom: { type: "string" }
										}
									}
								} }
							},
							render: (_args, value) => [{
								type: "text",
								text: JSON.stringify(value)
							}]
						},
						async execute(args, exec) {
							if (!deps.askUserQuestion) return { answers: [] };
							const questions = (args.questions ?? []).map((q) => ({
								id: q.id,
								question: q.question,
								...q.header !== void 0 ? { header: q.header } : {},
								...q.options !== void 0 ? { options: q.options } : {},
								...q.multi_select !== void 0 ? { multiSelect: q.multi_select } : {}
							}));
							const agentId = exec.agent?.id ?? "";
							return deps.askUserQuestion(questions, agentId);
						}
					});
					agentCtx.tools?.register?.(askTool);
				}
			};
			if (pending) {
				await releaseLiveSession(pending.sessionId);
				try {
					owned = await c.agents.resume({
						resumeSessionId: pending.sessionId,
						...agentOptions ? { agentOptions } : {},
						setup
					});
					sessionId = pending.sessionId;
					deps.setActiveSessionId?.(key, sessionId);
				} catch (err) {
					throw new Error(`failed to resume session "${pending.sessionId}" for ${key}: ${err instanceof Error ? err.message : String(err)}`);
				}
			} else {
				const activeId = deps.activeSessionId?.(key);
				let resumedOwned;
				if (activeId) try {
					await releaseLiveSession(activeId);
					resumedOwned = await c.agents.resume({
						resumeSessionId: activeId,
						...agentOptions ? { agentOptions } : {},
						setup
					});
					sessionId = activeId;
				} catch (err) {
					deps.logger?.warn(`failed to resume active session "${activeId}" for ${key}: ${err instanceof Error ? err.message : String(err)} — falling back to create fresh session`);
				}
				if (resumedOwned) owned = resumedOwned;
				else {
					sessionId = bridgeKey(key);
					try {
						owned = await c.agents.create({
							sessionId,
							meta: {
								cwd: deps.cwd?.(key) ?? process.cwd(),
								agentPreset: deps.preset?.(key) ?? "ptc"
							},
							...agentOptions ? { agentOptions } : {},
							setup
						});
						deps.setActiveSessionId?.(key, sessionId);
					} catch (err) {
						if (err instanceof Error && /already exists|already has a persisted log/i.test(err.message)) try {
							await releaseLiveSession(sessionId);
							owned = await c.agents.resume({
								resumeSessionId: sessionId,
								...agentOptions ? { agentOptions } : {},
								setup
							});
							deps.setActiveSessionId?.(key, sessionId);
						} catch (resumeErr) {
							deps.logger?.warn(`session id collision for ${key} and resume failed — minting fresh session: ${String(resumeErr)}`);
							runNonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
							const freshId = bridgeKey(key);
							try {
								owned = await c.agents.create({
									sessionId: freshId,
									meta: {
										cwd: deps.cwd?.(key) ?? process.cwd(),
										agentPreset: deps.preset?.(key) ?? "ptc"
									},
									...agentOptions ? { agentOptions } : {},
									setup
								});
								sessionId = freshId;
								deps.setActiveSessionId?.(key, sessionId);
							} catch (err2) {
								throw new Error(`failed to mint fresh session for ${key} (was "${sessionId}"): ${err2 instanceof Error ? err2.message : String(err2)}`);
							}
						}
						else throw new Error(`failed to create DSH agent for ${key}: ${err instanceof Error ? err.message : String(err)}`);
					}
				}
			}
			if (!owned?.agent) throw new Error(`DSH agents.create returned no agent for ${key}`);
			const wsCwd = deps.cwd?.(key) ?? process.cwd();
			try {
				const workspaces = c.get?.("workspaceRegistry");
				if (workspaces?.create) {
					const entity = await workspaces.create(wsCwd, basename(wsCwd));
					deps.logger?.info(`workspace create: ${wsCwd} (${entity ? "entity" : "none"})`);
					if (entity?.attachSession) {
						await entity.attachSession(sessionId);
						deps.logger?.info(`workspace attach: ${sessionId} -> ${wsCwd}`);
					} else deps.logger?.warn(`workspace attach skipped: entity has no attachSession (${wsCwd})`);
				} else deps.logger?.warn(`workspaceRegistry unavailable — session ${sessionId} will show under 未分组`);
			} catch (err) {
				deps.logger?.warn(`workspace create/attach failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
			}
			const agent = owned.agent;
			try {
				const services = c;
				const permission = services.get?.("permissionPresets");
				const approval = services.get?.("approval");
				const mode = deps.permissionMode?.();
				if (permission?.apply && agent.session && mode) {
					permission.apply(agent.session, mode, (policy) => {
						approval?.setPolicy?.(agent, policy);
					});
					deps.logger?.info(`permission for ${key} set to ${mode} (session-scoped)`);
				}
			} catch (err) {
				deps.logger?.warn(`permission apply failed for ${key}: ${err instanceof Error ? err.message : String(err)}`);
			}
			const handle = {
				agentId: agent.id,
				sessionId,
				async followup(text, attachments) {
					const parts = [text];
					const content = [{
						type: "text",
						text
					}];
					const currentModel = selFor(key);
					const modelTag = currentModel?.provider && currentModel?.model ? `${currentModel.provider}/${currentModel.model}` : void 0;
					const isUnsupported = imageUnsupportedKeys.has(key) || (modelTag ? imageUnsupportedModels.has(modelTag) : false);
					for (const a of attachments ?? []) if (a.kind === "image") {
						if (a.imageRef && !isUnsupported) content.push({
							type: "image",
							attachment: a.imageRef
						});
						if (a.path && !a.path.startsWith("feishu://")) parts.push(`\n\n[用户发送了图片，已保存到本地: ${a.path}（需要查看时用 read_image 工具读取该路径）]`);
						else if (!a.imageRef) parts.push("\n\n[用户发送了图片，但未能保存（无附件服务）]");
					} else if (a.kind === "file" && a.textPreview) parts.push(`\n\n[附件 ${a.name ?? "文件"} 内容]\n${a.textPreview}`);
					else if (a.kind === "file") parts.push(`\n\n[附件 ${a.name ?? "文件"}（未能提取文本）]`);
					content[0] = {
						type: "text",
						text: parts.join("")
					};
					const message = createUserMessage({
						content,
						source: { kind: "user" }
					});
					if (content.length > 1) pendingImageRetry.set(key, createUserMessage({
						content: [content[0]],
						source: { kind: "user" }
					}));
					else pendingImageRetry.delete(key);
					agent.followup(message);
					await agent.whenIdle();
				},
				rawAgent: agent,
				async cancel() {
					agent.cancel({ kind: "user" });
				},
				onEvent(fn) {
					const set = listeners.get(key) ?? /* @__PURE__ */ new Set();
					set.add(fn);
					listeners.set(key, set);
					return () => {
						set.delete(fn);
					};
				},
				isIdle: () => agent.status === "idle",
				async dispose() {
					disposers.get(key)?.();
					disposers.delete(key);
					await owned.dispose();
					tracked.delete(key);
					keyBySession.delete(sessionId);
					listeners.delete(key);
					pendingImageRetry.delete(key);
					lastAssistantText.delete(key);
					lastAgentError.delete(key);
				}
			};
			tracked.set(key, {
				handle,
				lastUsedAt: Date.now()
			});
			keyBySession.set(sessionId, key);
			const disp = (agent.ctx.on?.bind(agent.ctx) ?? c.on?.bind(c))?.("session/event", (sess, ev) => {
				if (sess !== void 0 && sess !== agent.session && sess?.id !== sessionId) return;
				const out = toSessionEventOut(ev);
				if (!out) return;
				if (out.type === "turn/start") {
					lastAssistantText.delete(key);
					lastAgentError.delete(key);
				}
				if (out.type === "assistant/message" && out.text.trim() !== "") lastAssistantText.set(key, out.text);
				if (out.type === "turn/end" && out.finalText === void 0) {
					const final = lastAssistantText.get(key);
					if (final !== void 0) out.finalText = final;
					lastAssistantText.delete(key);
					const failure = lastAgentError.get(key);
					if (failure) out.error = failure;
					lastAgentError.delete(key);
				}
				const set = listeners.get(key);
				if (set) for (const fn of set) fn(out);
			}) ?? (() => {});
			const errDisp = agent.ctx.on("agent/error", (payload) => {
				const errText = payload.error instanceof Error ? payload.error.message : String(payload.error);
				const errObj = payload.error;
				const errCode = errObj?.code ?? (errObj?.failure)?.code;
				lastAgentError.set(key, {
					message: errText.slice(0, 500),
					...errCode ? { code: String(errCode) } : {}
				});
				deps.logger?.warn(`agent error for ${key}: ${errText}`);
				if (isImageUnsupportedError(errText, errCode)) {
					imageUnsupportedKeys.add(key);
					const currentModel = selFor(key);
					if (currentModel?.provider && currentModel?.model) imageUnsupportedModels.add(`${currentModel.provider}/${currentModel.model}`);
					const retry = pendingImageRetry.get(key);
					if (retry) {
						pendingImageRetry.delete(key);
						imageRetryGrace.add(key);
						(async () => {
							try {
								if (typeof agent.whenIdle === "function") await agent.whenIdle();
								agent.followup(retry);
								deps.logger?.info(`model rejects image input for ${key}; retried text-only (image stays on disk, read_image available)`);
							} catch (err) {
								deps.logger?.warn(`text-only retry failed for ${key}: ${err instanceof Error ? err.message : String(err)}`);
							}
						})();
					}
				}
			});
			disposers.set(key, () => {
				disp();
				errDisp();
			});
			return handle;
		})();
		ensureInFlight.set(key, p);
		try {
			return await p;
		} finally {
			ensureInFlight.delete(key);
		}
	}
	return {
		consumeImageRetryGrace(key) {
			if (imageRetryGrace.has(key)) {
				imageRetryGrace.delete(key);
				return true;
			}
			return false;
		},
		clearImageUnsupported(key) {
			if (key) imageUnsupportedKeys.delete(key);
			else {
				imageUnsupportedKeys.clear();
				imageUnsupportedModels.clear();
			}
		},
		async ensureAgent(key) {
			return ensureAgent(key);
		},
		async resumeAgent(key, sessionId, opts) {
			const existingCurrent = tracked.get(key);
			if (existingCurrent && existingCurrent.handle.sessionId === sessionId && (!opts?.preset || opts.preset === deps.preset?.(key))) return existingCurrent.handle;
			await releaseLiveSession(sessionId);
			rotateKey(key);
			if (opts?.preset) presetOverrides.set(key, opts.preset);
			pendingResume.set(key, { sessionId });
			try {
				return await ensureAgent(key);
			} finally {
				pendingResume.delete(key);
			}
		},
		get: (key) => tracked.get(key)?.handle,
		keyForSessionId: (sessionId) => keyBySession.get(sessionId),
		async listPresets() {
			const presets = c.get?.("agentPresets");
			if (!presets?.list) return [];
			try {
				return (await presets.list()).map((row) => ({
					id: row.id,
					label: row.name ?? row.id,
					...row.trust === void 0 ? {} : { trust: row.trust },
					...row.description === void 0 ? {} : { desc: row.description },
					...row.broken === void 0 ? {} : { broken: row.broken }
				}));
			} catch (err) {
				deps.logger?.warn(`agentPresets.list() failed — /mode falls back to shipped presets: ${String(err)}`);
				return [];
			}
		},
		disposeIdle(idleTtlMs) {
			const toDispose = [];
			for (const [key, t] of tracked) if (t.handle.isIdle() && Date.now() - t.lastUsedAt >= idleTtlMs) toDispose.push({
				key,
				handle: t.handle
			});
			for (const { key, handle } of toDispose) {
				tracked.delete(key);
				keyBySession.delete(handle.sessionId);
				generations.set(key, (generations.get(key) ?? 0) + 1);
				handle.dispose();
			}
			return toDispose.length;
		},
		size: () => tracked.size,
		rotate(key) {
			rotateKey(key);
		},
		async dispose(key) {
			const t = tracked.get(key);
			if (!t) return;
			await t.handle.dispose();
			tracked.delete(key);
		},
		async disposeAll() {
			for (const t of tracked.values()) await t.handle.dispose();
			tracked.clear();
			keyBySession.clear();
		}
	};
}
//#endregion
//#region src/sessions/dsh-session-backend.ts
/** The shipped preset roster, mirrored here so the memory backend (used when
* DSH services are absent) still answers a /mode picker with the four
* official modes. Kept in sync with `AGENT_PRESETS` in presentation/cards. */
const SHIPPED_PRESETS = [
	{
		id: "standard",
		label: "标准模式",
		desc: "全能：文件/Shell/检索/Skills/目标/子代理/工作流",
		trust: "system"
	},
	{
		id: "code",
		label: "PTC 模式",
		desc: "标准能力 + Code Mode（多步操作一次执行，更快）",
		trust: "system"
	},
	{
		id: "minimal",
		label: "极简模式",
		desc: "仅 bash + 文件编辑，轻量省 token",
		trust: "system"
	},
	{
		id: "cordis",
		label: "创造模式",
		desc: "标准能力 + preset 创作工具（面向开发者）",
		trust: "system"
	}
];
function createMemoryDshBackend(opts = {}) {
	const agents = /* @__PURE__ */ new Map();
	const keyBySession = /* @__PURE__ */ new Map();
	let counter = 0;
	const makeAgent = (key, sessionId) => {
		const sid = sessionId ?? `session-${++counter}`;
		const agentId = sessionId ?? `agent-${counter}`;
		const listeners = /* @__PURE__ */ new Set();
		let busy = false;
		let disposed = false;
		const emit = (e) => {
			for (const fn of listeners) fn(e);
		};
		return {
			agentId,
			sessionId: sid,
			async followup(text, attachments) {
				if (disposed) throw new Error("agent disposed");
				busy = true;
				const reply = opts.autoReply?.(key, text);
				const stream = async () => {
					const content = reply ?? `echo: ${text}`;
					const mid = Math.floor(content.length / 2);
					emit({
						type: "assistant/chunk",
						text: content.slice(0, mid)
					});
					if (opts.latencyMs) await new Promise((r) => setTimeout(r, opts.latencyMs));
					emit({
						type: "assistant/chunk",
						text: content.slice(mid)
					});
					emit({
						type: "assistant/message",
						text: content
					});
					emit({
						type: "turn/end",
						reason: "complete",
						finalText: content
					});
					busy = false;
				};
				stream();
			},
			async cancel() {
				busy = false;
			},
			onEvent(fn) {
				listeners.add(fn);
				return () => listeners.delete(fn);
			},
			isIdle: () => !busy,
			async dispose() {
				disposed = true;
				listeners.clear();
				agents.delete(key);
				keyBySession.delete(sid);
			}
		};
	};
	return {
		agents,
		async ensureAgent(key) {
			let a = agents.get(key);
			if (!a) {
				a = makeAgent(key);
				agents.set(key, a);
				keyBySession.set(a.sessionId, key);
			}
			return a;
		},
		get: (key) => agents.get(key),
		async resumeAgent(key, sessionId) {
			const prev = agents.get(key);
			if (prev) {
				agents.delete(key);
				keyBySession.delete(prev.sessionId);
			}
			const a = makeAgent(key, sessionId);
			agents.set(key, a);
			keyBySession.set(a.sessionId, key);
			return a;
		},
		keyForSessionId: (sessionId) => keyBySession.get(sessionId),
		listPresets: async () => [...SHIPPED_PRESETS],
		disposeIdle(ttlMs) {
			let n = 0;
			for (const [key, a] of agents) if (a.isIdle()) {
				a.dispose();
				agents.delete(key);
				keyBySession.delete(a.sessionId);
				n++;
			}
			return n;
		},
		size: () => agents.size,
		rotate() {},
		clearImageUnsupported() {},
		async dispose(key) {
			const a = agents.get(key);
			if (a) await a.dispose();
			agents.delete(key);
		},
		async disposeAll() {
			for (const a of agents.values()) await a.dispose();
			agents.clear();
			keyBySession.clear();
		}
	};
}
//#endregion
//#region src/common/reactions.ts
/** All Feishu-valid emoji_type values (open.feishu.cn …/emojis-introduce). */
const VALID_EMOJI_TYPES = /* @__PURE__ */ new Set([
	"OK",
	"THUMBSUP",
	"THANKS",
	"MUSCLE",
	"FINGERHEART",
	"APPLAUSE",
	"FISTBUMP",
	"JIAYI",
	"DONE",
	"SMILE",
	"BLUSH",
	"LAUGH",
	"SMIRK",
	"LOL",
	"FACEPALM",
	"LOVE",
	"WINK",
	"PROUD",
	"WITTY",
	"SMART",
	"SCOWL",
	"THINKING",
	"SOB",
	"CRY",
	"ERROR",
	"NOSEPICK",
	"HAUGHTY",
	"SLAP",
	"SPITBLOOD",
	"TOASTED",
	"GLANCE",
	"DULL",
	"INNOCENTSMILE",
	"JOYFUL",
	"WOW",
	"TRICK",
	"YEAH",
	"ENOUGH",
	"TEARS",
	"EMBARRASSED",
	"KISS",
	"SMOOCH",
	"DROOL",
	"OBSESSED",
	"MONEY",
	"TEASE",
	"SHOWOFF",
	"COMFORT",
	"CLAP",
	"PRAISE",
	"STRIVE",
	"XBLUSH",
	"SILENT",
	"WAVE",
	"WHAT",
	"FROWN",
	"SHY",
	"DIZZY",
	"LOOKDOWN",
	"CHUCKLE",
	"WAIL",
	"CRAZY",
	"WHIMPER",
	"HUG",
	"BLUBBER",
	"WRONGED",
	"HUSKY",
	"SHHH",
	"SMUG",
	"ANGRY",
	"HAMMER",
	"SHOCKED",
	"TERROR",
	"PETRIFIED",
	"SKULL",
	"SWEAT",
	"SPEECHLESS",
	"SLEEP",
	"DROWSY",
	"YAWN",
	"SICK",
	"PUKE",
	"BETRAYED",
	"HEADSET",
	"EatingFood",
	"MeMeMe",
	"Sigh",
	"Typing",
	"Lemon",
	"Get",
	"LGTM",
	"OnIt",
	"OneSecond",
	"VRHeadset",
	"YouAreTheBest",
	"SALUTE",
	"SHAKE",
	"HIGHFIVE",
	"UPPERLEFT",
	"ThumbsDown",
	"SLIGHT",
	"TONGUE",
	"EYESCLOSED",
	"RoarForYou",
	"CALF",
	"BEAR",
	"BULL",
	"RAINBOWPUKE",
	"ROSE",
	"HEART",
	"PARTY",
	"LIPS",
	"BEER",
	"CAKE",
	"GIFT",
	"CUCUMBER",
	"Drumstick",
	"Pepper",
	"CANDIEDHAWS",
	"BubbleTea",
	"Coffee",
	"Yes",
	"No",
	"OKR",
	"CheckMark",
	"CrossMark",
	"MinusOne",
	"Hundred",
	"AWESOMEN",
	"Pin",
	"Alarm",
	"Loudspeaker",
	"Trophy",
	"Fire",
	"BOMB",
	"Music",
	"XmasTree",
	"Snowman",
	"XmasHat",
	"FIREWORKS",
	"REDPACKET",
	"FORTUNE",
	"LUCK",
	"FIRECRACKER",
	"StickyRiceBalls",
	"HEARTBROKEN",
	"POOP",
	"StatusFlashOfInspiration",
	"CLEAVER",
	"Soccer",
	"Basketball",
	"GeneralDoNotDisturb",
	"Status_PrivateMessage",
	"GeneralInMeetingBusy",
	"StatusReading",
	"StatusInFlight",
	"GeneralBusinessTrip",
	"GeneralWorkFromHome",
	"StatusEnjoyLife",
	"GeneralTravellingCar",
	"StatusBus",
	"GeneralSun",
	"GeneralMoonRest",
	"MoonRabbit",
	"Mooncake",
	"JubilantRabbit",
	"TV",
	"Movie",
	"Pumpkin",
	"BeamingFace",
	"Delighted",
	"ColdSweat",
	"FullMoonFace",
	"Partying",
	"GoGoGo",
	"ThanksFace",
	"SaluteFace",
	"Shrug",
	"ClownFace",
	"HappyDragon",
	"2022",
	"18X"
]);
/**
* Fixed, state-mapped reactions — chosen for MEANING, not decoration:
* `OnIt` = 收到，这就去办 · `DONE` = 完成 ✅ · `ERROR` = 失败 ❌.
* Reactions can only use Feishu's BUILT-IN emoji catalog: the reaction API
* rejects anything else with 231001 (tenant custom emojis are not supported),
* so every value is validated against {@link VALID_EMOJI_TYPES}.
*/
const DEFAULT_REACTIONS = {
	receipt: "OnIt",
	done: "DONE",
	error: "ERROR"
};
/**
* Resolve the configured reactions into a usable set. Each field is normalized
* (trim; strip stray brackets/quotes a text config assignment may leave) and
* falls back to its default when it is not a valid catalog entry. Deterministic
* by design — the same config always renders the same reaction, unlike the
* random pool this replaces: the reaction is a STATEMENT about the turn.
*/
function resolveReactions(configured) {
	const pick = (value, fallback) => {
		const cleaned = String(value ?? "").replace(/[[\]"']/g, "").trim();
		return cleaned !== "" && VALID_EMOJI_TYPES.has(cleaned) ? cleaned : fallback;
	};
	return {
		receipt: pick(configured?.receipt, DEFAULT_REACTIONS.receipt),
		done: pick(configured?.done, DEFAULT_REACTIONS.done),
		error: pick(configured?.error, DEFAULT_REACTIONS.error)
	};
}
//#endregion
//#region src/application/command-router.ts
const BRIDGE_COMMANDS = /* @__PURE__ */ new Set([
	"status",
	"workspace",
	"stop",
	"support",
	"doctor",
	"sessions",
	"lark-config",
	"help",
	"feishu-config",
	"model",
	"reasoning",
	"thinking",
	"mode",
	"permission",
	"new",
	"resume",
	"manage",
	"tasks",
	"goal",
	"menu",
	"cfg",
	"stream",
	"reconnect",
	"cwd",
	"whoami",
	"usage",
	"files"
]);
function stripLeadingMentions(text) {
	let cur = text.trim();
	while (true) {
		const next = cur.replace(/^(?:<at[^>]*>.*?<\/at>|@\S+)\s*/i, "").trim();
		if (next === cur) break;
		cur = next;
	}
	return cur;
}
function createCommandRouter(deps) {
	return {
		isCommand(text) {
			const cleaned = stripLeadingMentions(text);
			return /^\//.test(cleaned);
		},
		async route(msg) {
			const rawText = (msg.text ?? msg.content ?? "").trim();
			if (rawText === "") return "skipped";
			const text = stripLeadingMentions(rawText);
			if (text === "") return "skipped";
			if (!this.isCommand(rawText)) return "agent";
			const tokens = text.split(/\s+/);
			const cmdName = (tokens[0] ?? "").replace(/^\/+/, "").toLowerCase();
			const rawInput = tokens.slice(1).join(" ");
			if (BRIDGE_COMMANDS.has(cmdName) || cmdName === "lark") {
				const progressId = `bridge:${cmdName}:${msg.messageId}`;
				await deps.commandProgress?.start(msg.chatId, progressId, cmdName);
				const handled = await deps.bridgeHandler(cmdName, rawInput, msg);
				if (!handled) await deps.commandProgress?.cancel(msg.chatId, progressId);
				if (handled) {
					const cfg = deps.ctx.cfg();
					if (cfg.reactions.enabled) deps.ctx.sender?.addReaction(msg.messageId, resolveReactions(cfg.reactions).done).catch(() => void 0);
				}
				return handled ? "bridge" : "agent";
			}
			const key2 = deps.ctx.conversationKeyFor(msg);
			let agent = deps.ctx.backend?.get(key2);
			if (!agent) try {
				agent = await deps.ctx.backend?.ensureAgent?.(key2);
			} catch {}
			const agentId = agent?.agentId ?? "";
			if (agentId && deps.commands.has(cmdName, agentId)) {
				const progressId = `${key2}:cmd:${cmdName}:${msg.messageId}`;
				await deps.commandProgress?.start(msg.chatId, progressId, cmdName);
				try {
					const result = await deps.commands.run(cmdName, rawInput, agentId);
					const key = deps.ctx.conversationKeyFor(msg);
					if (result.kind === "success" && result.text) await deps.ctx.outbox?.enqueue({
						dedupeKey: `${key}:cmd:${cmdName}:${msg.messageId}`,
						laneKey: key,
						route: {
							sessionKey: key,
							chatId: msg.chatId,
							chatType: msg.chatType
						},
						kind: "command-reply",
						payload: {
							kind: "text",
							text: result.text
						}
					});
					else if (result.kind === "error" && result.text) await deps.ctx.outbox?.enqueue({
						dedupeKey: `${key}:cmd:${cmdName}:${msg.messageId}`,
						laneKey: key,
						route: {
							sessionKey: key,
							chatId: msg.chatId,
							chatType: msg.chatType
						},
						kind: "command-reply",
						payload: {
							kind: "text",
							text: `⚠️ ${result.text}`
						}
					});
					return "dsh";
				} catch {
					await deps.commandProgress?.cancel(msg.chatId, progressId);
					return "agent";
				}
			}
			return "agent";
		}
	};
}
//#endregion
//#region src/sessions/task-registry.ts
/** Strip the `#seq` suffix: the routing key of the conversation that owns it. */
function conversationKeyOf(taskId) {
	const match = /#(\d+)$/.exec(String(taskId ?? ""));
	return match ? String(taskId).slice(0, match.index) : String(taskId ?? "");
}
/**
* A bridge session id is `lark-link:<taskKey>:<runNonce>:<index>` — and the
* taskKey may itself carry `#n` suffixes. Tools receive that id and need the
* CONVERSATION key for their route lookup, which lives one or two `:` segments
* earlier. The old inline fallback stripped only ONE trailing `:segment`, which
* never matched `<nonce>:<index>` (the index is a single digit), so a route
* lookup could fail with "无法定位当前飞书会话" while the conversation existed —
* e.g. for a resumed task or a disposed idle agent whose reverse map entry is
* gone. Accepts ids with or without the `lark-link:` prefix and task keys.
*/
function conversationKeyForSessionId(sessionId) {
	const raw = String(sessionId ?? "");
	const body = raw.startsWith("lark-link:") ? raw.slice(10) : raw;
	const withoutIndex = body.replace(/:[a-z0-9]{8,}:\d+$/, "");
	if (withoutIndex !== body) return conversationKeyOf(withoutIndex);
	const legacy = /^((?:dm|p2p|group):[^:]+):[a-z0-9]{8,}$/.exec(body);
	if (legacy?.[1]) return conversationKeyOf(legacy[1]);
	return conversationKeyOf(body);
}
/** Ordinal of a task id (`dm:x#2` → 2), or 0 when it carries none. */
function taskSeqOf(taskId) {
	const match = /#(\d+)$/.exec(String(taskId ?? ""));
	return match ? Number(match[1]) : 0;
}
/**
* In-memory registry — used by tests and by hosts that never configured one.
* Tasks still work; only the persistence across restarts is missing.
*/
function createMemoryTaskRegistry(now = Date.now) {
	return createTaskRegistry("", now, true);
}
function createTaskRegistry(file, now = Date.now, memoryOnly = false) {
	let data = {};
	let prunePersist = false;
	if (!memoryOnly) try {
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		if (parsed && typeof parsed === "object") data = parsed;
		for (const key of Object.keys(data)) if (key.includes("#")) {
			delete data[key];
			prunePersist = true;
		}
	} catch {}
	const persist = () => {
		if (memoryOnly) return;
		try {
			writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
		} catch {}
	};
	if (prunePersist) persist();
	const row = (conversationKey) => data[conversationKey] ?? { tasks: [] };
	const save = (conversationKey, value) => {
		data[conversationKey] = value;
		persist();
	};
	const create = (conversationKey, opts = {}) => {
		const current = row(conversationKey);
		const seq = current.tasks.reduce((max, task) => Math.max(max, task.seq), 0) + 1;
		const at = now();
		const task = {
			id: `${conversationKey}#${seq}`,
			seq,
			createdAt: at,
			lastActivityAt: at,
			...opts.label ? { label: opts.label } : {},
			...opts.fromTaskId ? { fromTaskId: opts.fromTaskId } : {}
		};
		save(conversationKey, {
			...current,
			activeId: task.id,
			tasks: [...current.tasks, task]
		});
		return task;
	};
	return {
		conversationKeyOf,
		taskSeqOf,
		list: (conversationKey) => [...row(conversationKey).tasks].reverse(),
		active(conversationKey) {
			const current = row(conversationKey);
			return current.activeId ? current.tasks.find((task) => task.id === current.activeId) : void 0;
		},
		ensureActive(conversationKey) {
			return this.active(conversationKey) ?? create(conversationKey);
		},
		create,
		switchTo(conversationKey, taskId) {
			const current = row(conversationKey);
			const target = current.tasks.find((task) => task.id === taskId);
			if (!target) return void 0;
			save(conversationKey, {
				...current,
				activeId: target.id
			});
			return target;
		},
		touch(conversationKey, taskId) {
			const current = row(conversationKey);
			const tasks = current.tasks.map((task) => task.id === taskId ? {
				...task,
				lastActivityAt: now()
			} : task);
			save(conversationKey, {
				...current,
				tasks
			});
		},
		setSessionId(conversationKey, taskId, sessionId) {
			const current = row(conversationKey);
			const tasks = current.tasks.map((task) => {
				if (task.id !== taskId) return task;
				const next = { ...task };
				if (sessionId) next.sessionId = sessionId;
				else delete next.sessionId;
				return next;
			});
			save(conversationKey, {
				...current,
				tasks
			});
		},
		setLabel(conversationKey, taskId, label) {
			const current = row(conversationKey);
			const tasks = current.tasks.map((task) => {
				if (task.id !== taskId) return task;
				const next = { ...task };
				if (label) next.label = label;
				else delete next.label;
				return next;
			});
			save(conversationKey, {
				...current,
				tasks
			});
		},
		remove(conversationKey, taskId) {
			const current = row(conversationKey);
			const tasks = current.tasks.filter((task) => task.id !== taskId);
			const activeId = current.activeId === taskId ? tasks.at(-1)?.id : current.activeId;
			save(conversationKey, {
				...current,
				tasks,
				...activeId ? { activeId } : { activeId: void 0 }
			});
		},
		owner: (conversationKey) => {
			const current = row(conversationKey);
			return {
				id: current.ownerId,
				name: current.ownerName
			};
		},
		setOwner(conversationKey, ownerId, ownerName) {
			const current = row(conversationKey);
			if (current.ownerId === ownerId && current.ownerName === ownerName) return;
			save(conversationKey, {
				...current,
				...ownerId ? { ownerId } : {},
				...ownerName ? { ownerName } : {}
			});
		},
		conversations: () => Object.keys(data)
	};
}
//#endregion
//#region src/sessions/conversation-manager.ts
/** The id whose workspace a conversation is isolated under. */
function ownerIdForMessage(msg) {
	return msg.chatType === "p2p" ? msg.senderOpenId : msg.chatId;
}
function createConversationManager(deps) {
	const registry = deps.registry ?? createMemoryTaskRegistry(deps.now);
	/**
	* Routing key of a task: the task id in registry mode, the CONVERSATION key
	* in the legacy single-task mode — so every downstream store keyed by a
	* conversation (outbox lanes, routes, WAL) keeps seeing the same string.
	*/
	const routeKey = (task) => deps.registry ? task.id : conversationKeyOf(task.id);
	const queues = /* @__PURE__ */ new Map();
	const hooks = /* @__PURE__ */ new Map();
	const hooksAgent = /* @__PURE__ */ new Map();
	const keyFor = (msg) => msg.chatType === "p2p" ? `dm:${msg.chatId}` : `group:${msg.chatId}`;
	const enqueueSerial = (routingKey, task) => {
		const next = (queues.get(routingKey) ?? Promise.resolve()).then(task, task);
		queues.set(routingKey, next.catch(() => void 0));
		return next;
	};
	const ensureUnderCap = async () => {
		if (deps.backend.size() < deps.maxSessions) return;
		deps.backend.disposeIdle(0);
		if (deps.backend.size() >= deps.maxSessions) {
			await new Promise((r) => setTimeout(r, 250));
			deps.backend.disposeIdle(0);
		}
	};
	const attachHook = (routingKey, agent) => {
		const prevAgentId = hooksAgent.get(routingKey);
		if (hooks.has(routingKey) && prevAgentId === agent.agentId) return;
		hooks.get(routingKey)?.();
		const detach = agent.onEvent((e) => deps.onEvent?.(routingKey, e));
		hooks.set(routingKey, detach);
		hooksAgent.set(routingKey, agent.agentId);
	};
	const dropHook = (routingKey) => {
		hooks.get(routingKey)?.();
		hooks.delete(routingKey);
		hooksAgent.delete(routingKey);
	};
	/** Get-or-create the agent of one task and subscribe its fan-out. */
	const ensureTaskAgent = async (key, task) => {
		await ensureUnderCap();
		const routingKey = routeKey(task);
		const agent = await deps.backend.ensureAgent(routingKey);
		registry.setSessionId(key, task.id, agent.sessionId);
		attachHook(routingKey, agent);
		deps.onActiveSessionId?.(key, agent.sessionId);
		return agent;
	};
	/** Bring a task's PERSISTED session back to life (its log continues). */
	const resumeTaskAgent = async (key, task, opts) => {
		const routingKey = routeKey(task);
		if (!task.sessionId) return ensureTaskAgent(key, task);
		const live = deps.backend.get(routingKey);
		if (live && live.sessionId === task.sessionId) {
			attachHook(routingKey, live);
			return live;
		}
		await ensureUnderCap();
		const agent = await deps.backend.resumeAgent(routingKey, task.sessionId, opts);
		registry.setSessionId(key, task.id, agent.sessionId);
		attachHook(routingKey, agent);
		deps.onActiveSessionId?.(key, agent.sessionId);
		return agent;
	};
	const findTask = (taskId) => registry.list(conversationKeyOf(taskId)).find((task) => task.id === taskId);
	const stopTaskById = async (taskId) => {
		if (!taskId) return;
		const task = findTask(taskId);
		const agent = deps.backend.get(task ? routeKey(task) : taskId);
		if (agent) await agent.cancel();
	};
	const manager = {
		keyFor,
		async handleMessage(msg, attachments) {
			const key = keyFor(msg);
			registry.setOwner(key, ownerIdForMessage(msg), msg.senderName);
			const rawText = msg.text ?? msg.content ?? "";
			const text = stripLeadingMentions(rawText) || rawText;
			const task = registry.ensureActive(key);
			registry.touch(key, task.id);
			await enqueueSerial(routeKey(task), async () => {
				try {
					await (await ensureTaskAgent(key, task)).followup(text, attachments);
				} catch (err) {
					deps.logger?.warn(`followup failed for ${task.id}: ${String(err)}`);
				}
			});
		},
		tasks: (key) => registry.list(key),
		activeTask: (key) => registry.active(key),
		ownerOf: (key) => registry.owner(key),
		statusOf(routingKey) {
			const agent = deps.backend.get(routingKey);
			if (!agent) return "stopped";
			return agent.isIdle() ? "idle" : "running";
		},
		agentFor: (routingKey) => deps.backend.get(routingKey),
		createTask(key, opts) {
			const previous = registry.active(key);
			const task = registry.create(key, {
				...opts?.label ? { label: opts.label } : {},
				...previous ? { fromTaskId: previous.id } : {}
			});
			deps.onActiveSessionId?.(key, void 0);
			return task;
		},
		async switchTask(key, taskId) {
			const task = registry.switchTo(key, taskId);
			if (!task) throw new Error(`未知任务: ${taskId}`);
			let agent;
			try {
				agent = task.sessionId ? await resumeTaskAgent(key, task) : await ensureTaskAgent(key, task);
			} catch (err) {
				deps.logger?.warn(`switchTask ${taskId} failed: ${String(err)}`);
			}
			return {
				task: registry.active(key) ?? task,
				...agent ? { agent } : {},
				running: agent ? !agent.isIdle() : false
			};
		},
		async stopTask(key, taskId) {
			await stopTaskById(taskId ?? registry.active(key)?.id);
		},
		async resumeTask(key, sessionId, opts) {
			const existing = registry.list(key).find((task) => task.sessionId === sessionId);
			const previous = registry.active(key);
			const task = existing ?? registry.create(key, {
				...opts?.label ? { label: opts.label } : {},
				...previous ? { fromTaskId: previous.id } : {}
			});
			registry.switchTo(key, task.id);
			if (!existing) registry.setSessionId(key, task.id, sessionId);
			const active = registry.active(key) ?? task;
			return {
				task: active,
				agent: await resumeTaskAgent(key, active, opts)
			};
		},
		async resume(key, sessionId, opts) {
			const { agent } = await manager.resumeTask(key, sessionId, opts);
			return agent;
		},
		async dropTask(key, taskId) {
			const task = findTask(taskId);
			const routingKey = task ? routeKey(task) : taskId;
			dropHook(routingKey);
			queues.delete(routingKey);
			registry.remove(key, taskId);
			await deps.backend.dispose(routingKey);
		},
		async stop(key) {
			await stopTaskById(registry.active(key)?.id);
		},
		async dispose(key) {
			for (const task of registry.list(key)) {
				const routingKey = routeKey(task);
				dropHook(routingKey);
				queues.delete(routingKey);
				await deps.backend.dispose(routingKey);
			}
		},
		async rotate(key) {
			manager.createTask(key);
		},
		sweep() {
			return deps.backend.disposeIdle(deps.idleTtlMs);
		},
		size: () => deps.backend.size(),
		keys: () => registry.conversations(),
		taskIds: () => registry.conversations().flatMap((key) => registry.list(key).map((task) => task.id)),
		async disposeAll() {
			for (const detach of hooks.values()) detach();
			hooks.clear();
			hooksAgent.clear();
			await deps.backend.disposeAll();
			queues.clear();
		}
	};
	return manager;
}
//#endregion
//#region src/sessions/conversation-config.ts
function createConversationConfigStore(file) {
	let data = {};
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		if (parsed && typeof parsed === "object") data = parsed;
	} catch {}
	const persist = () => {
		try {
			writeFileSync(file, JSON.stringify(data, null, 2), { mode: 384 });
		} catch {}
	};
	const clean = (o) => {
		const out = {};
		if (o.workspaceRoot) out.workspaceRoot = o.workspaceRoot;
		if (o.provider) out.provider = o.provider;
		if (o.model) out.model = o.model;
		if (o.reasoningEffort) out.reasoningEffort = o.reasoningEffort;
		if (o.preset) out.preset = o.preset;
		if (o.activeSessionId) out.activeSessionId = o.activeSessionId;
		return out;
	};
	return {
		get(key) {
			return data[key] ? { ...data[key] } : {};
		},
		set(key, partial) {
			const merged = clean({
				...data[key] ?? {},
				...partial
			});
			if (Object.keys(merged).length === 0) delete data[key];
			else data[key] = merged;
			persist();
		},
		clear(key) {
			delete data[key];
			persist();
		},
		clearAll() {
			data = {};
			persist();
		},
		keys() {
			return Object.keys(data);
		}
	};
}
//#endregion
//#region src/sessions/workspace-sessions.ts
/** Resolve the harness home used by stock DSH and the webagent deployment. */
function resolveDshHome(env = process.env, home = homedir()) {
	const explicit = env.DSH_HOME?.trim();
	if (explicit) return explicit;
	const webagentHome = env.WEBAGENT_HOME?.trim();
	if (webagentHome) return join(webagentHome, "deepseek-harness");
	return join(home, ".dsh");
}
/** Resolve the session store used by stock DSH and the webagent deployment. */
function resolveSessionsRoot(env = process.env, home = homedir()) {
	return join(resolveDshHome(env, home), "sessions");
}
/**
* Extract a human-readable title from a session's events:
* 1. session/title event (highest precedence)
* 2. first user message text (deterministic fallback)
*/
function extractTitleFromEvents(events) {
	return extractOverviewFromEvents(events).title;
}
const oneLine$1 = (value, limit) => value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, limit);
const messageText = (event) => {
	const ev = event;
	return (ev.data?.message?.content ?? ev.data?.content ?? []).filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text?.trim()).filter(Boolean).join(" ");
};
/** Extract a compact picker overview without invoking an LLM. */
function extractOverviewFromEvents(events) {
	let explicitTitle;
	let firstUser;
	let lastUser;
	let lastAssistant;
	let userTurns = 0;
	let toolCalls = 0;
	let lastActivityAt;
	if (!Array.isArray(events) || events.length === 0) return {
		userTurns: 0,
		toolCalls: 0
	};
	for (const event of events) {
		const ev = event;
		if (typeof ev.time === "number") lastActivityAt = Math.max(lastActivityAt ?? 0, ev.time);
		if (ev.type === "session/title" && ev.data?.title) {
			const title = oneLine$1(ev.data.title, 36);
			if (title) explicitTitle = title;
		} else if (ev.type === "user/message") {
			const text = messageText(event);
			if (text) {
				userTurns++;
				const clean = text.replace(/^\/[a-zA-Z0-9_-]+\s*/, "").trim() || text;
				firstUser ??= oneLine$1(clean, 36);
				lastUser = oneLine$1(clean, 90);
			}
		} else if (ev.type === "assistant/message") {
			const text = messageText(event);
			if (text) lastAssistant = oneLine$1(text, 90);
		} else if (ev.type === "tool/call") toolCalls++;
	}
	return {
		...explicitTitle || firstUser ? { title: explicitTitle ?? firstUser } : {},
		...lastAssistant || lastUser ? { summary: lastAssistant ?? `待处理：${lastUser}` } : {},
		userTurns,
		toolCalls,
		...lastActivityAt === void 0 ? {} : { lastActivityAt }
	};
}
/**
* Port of dsh-session-persistence-jsonl's projectKey: `/`, `\` and `:` become
* `-` (consecutive runs collapse), safe `[A-Za-z0-9._-]` passes, everything
* else escapes as `~XXXX` (uppercase hex code unit); wrapped `--…--` with the
* readable part bounded to 251 chars and `root` when empty.
*/
function projectKeyOf(cwd) {
	if (cwd.length === 0) throw new Error("cannot encode an empty project path");
	let readable = "";
	let separatorRun = false;
	for (let i = 0; i < cwd.length; i++) {
		const ch = cwd[i];
		if (ch === "/" || ch === "\\" || ch === ":") {
			if (!separatorRun) readable += "-";
			separatorRun = true;
		} else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
			readable += ch;
			separatorRun = false;
		} else {
			readable += `~${cwd.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0")}`;
			separatorRun = false;
		}
	}
	return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}
/** Decode an encoded session dir name (`~003A` → `:` etc.). */
function decodeSessionDirName(name) {
	return name.replace(/~([0-9A-Fa-f]{4})/g, (_m, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}
/** List historical sessions of one workspace, newest first, capped. */
async function listWorkspaceSessions(deps) {
	const limit = deps.limit ?? 10;
	const exclude = new Set(deps.exclude ?? []);
	let rows = [];
	if (deps.persistence?.list) try {
		const snapshots = await deps.persistence.list();
		rows = snapshots.map((entry) => "header" in entry ? entry.header : entry).filter((h) => h.cwd === deps.cwd && h.origin !== "subagent" && !exclude.has(h.id)).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit).map((h) => {
			const snapshot = snapshots.find((entry) => "header" in entry ? entry.header.id === h.id : entry.id === h.id);
			const title = deps.titleFor?.(h.id) ?? h.title;
			return {
				id: h.id,
				createdAt: h.createdAt,
				...h.agentPreset ? { preset: h.agentPreset } : {},
				...title ? { title } : {},
				...typeof snapshot?.eventCount === "number" ? { eventCount: snapshot.eventCount } : {},
				source: "service"
			};
		});
	} catch {}
	if (rows.length === 0) {
		const dir = join(deps.sessionsRoot, projectKeyOf(deps.cwd));
		if (existsSync(dir)) {
			for (const name of readdirSync(dir)) {
				const sessionDir = join(dir, name);
				const log = ["session.v3.jsonl.zstd", "session.jsonl.zstd"].map((filename) => join(sessionDir, filename)).find((candidate) => existsSync(candidate));
				if (!log) continue;
				let mtime;
				try {
					mtime = statSync(log).mtimeMs;
				} catch {
					continue;
				}
				const id = decodeSessionDirName(name);
				if (exclude.has(id)) continue;
				const title = deps.titleFor?.(id);
				rows.push({
					id,
					createdAt: mtime,
					...title ? { title } : {},
					source: "scan"
				});
			}
			rows.sort((a, b) => b.createdAt - a.createdAt);
			rows = rows.slice(0, limit);
		}
	}
	if (deps.persistence && rows.length > 0) await Promise.allSettled(rows.map(async (row) => {
		let overview;
		if (deps.titleFor) {
			const t = deps.titleFor(row.id);
			if (t) row.title = t;
		}
		try {
			let events;
			if (deps.persistence?.open) {
				const handle = await deps.persistence.open(row.id, "read");
				try {
					const count = row.eventCount;
					if (typeof count === "number" && count > 240) {
						const [head, tail] = await Promise.all([handle.read(0, 120), handle.read(Math.max(0, count - 120), 120)]);
						events = [...head.events, ...tail.events];
					} else events = (await handle.read(0, count ?? 400)).events;
				} finally {
					await handle.close();
				}
			} else if (deps.persistence?.inspect) events = (await deps.persistence.inspect(row.id))?.events;
			else if (deps.persistence?.load) events = (await deps.persistence.load(row.id))?.events;
			else if (deps.persistence?.readFrom) events = (await deps.persistence.readFrom(row.id, 0))?.events;
			if (events) {
				overview = extractOverviewFromEvents(events);
				row.title ??= overview.title;
				row.summary = overview.summary;
				row.userTurns = overview.userTurns;
				row.toolCalls = overview.toolCalls;
				row.lastActivityAt = overview.lastActivityAt;
			}
		} catch {}
	}));
	return rows;
}
//#endregion
//#region src/sessions/session-admin.ts
/**
* Session log filenames. DSH moved v3 → v4 in the 0.2 line, and a FIXED list made
* every session look missing there — the GUI kept listing them while delete
* failed with 找不到该会话的持久化日志 (and the archived-gate census reported the
* whole list as dangling). Match the SHAPE instead; rank the known names so a
* directory holding several formats resolves newest-first.
*/
const LOG_PATTERN = /^session(?:\.[a-z0-9]+)?\.jsonl\.zstd$/;
const LOG_RANK = [
	"session.v4.jsonl.zstd",
	"session.v3.jsonl.zstd",
	"session.jsonl.zstd"
];
/** DSH's open-session lock; a moved copy must never carry a stale one. */
const LOCK_NAME = "session.lock";
const logPathIn = (dir) => {
	let names;
	try {
		names = readdirSync(dir).filter((name) => LOG_PATTERN.test(name));
	} catch {
		return;
	}
	if (names.length === 0) return void 0;
	const rank = (name) => {
		const index = LOG_RANK.indexOf(name);
		return index === -1 ? LOG_RANK.length : index;
	};
	names.sort((a, b) => rank(a) - rank(b));
	const logName = names[0];
	return {
		logName,
		path: join(dir, logName)
	};
};
/** Read the stored header — the FIRST line of the (zstd) log. */
function readSessionHeader(logFile) {
	try {
		const text = zstdDecompressSync(readFileSync(logFile)).toString("utf8");
		const newlineAt = text.indexOf("\n");
		const head = (newlineAt === -1 ? text : text.slice(0, newlineAt)).trim();
		if (!head) return void 0;
		const parsed = JSON.parse(head);
		return parsed && typeof parsed === "object" ? parsed : void 0;
	} catch {
		return;
	}
}
/**
* Rewrite ONLY the header's `cwd`. Every later line is an event and must stay
* byte-identical, so the header line is patched in place rather than
* re-serialized from parsed events. Written through a temp file + rename so a
* crash mid-write cannot truncate the session log.
*/
function rewriteSessionCwd(logFile, cwd) {
	const text = zstdDecompressSync(readFileSync(logFile)).toString("utf8");
	const newlineAt = text.indexOf("\n");
	const head = newlineAt === -1 ? text : text.slice(0, newlineAt);
	const rest = newlineAt === -1 ? "" : text.slice(newlineAt);
	const header = JSON.parse(head);
	if (header.type !== "session") throw new Error("不是会话头记录，拒绝改写");
	header.cwd = cwd;
	const tmp = `${logFile}.rewrite`;
	writeFileSync(tmp, zstdCompressSync(Buffer.from(JSON.stringify(header) + rest, "utf8")));
	renameSync(tmp, logFile);
}
/** Find one session directory by id. Project directories are scanned, never
*  decoded: the projectKey encoding is lossy (separators collapse to `-`). */
function locateSession(deps, sessionId) {
	const root = deps.sessionsRoot;
	if (!sessionId || !existsSync(root)) return void 0;
	for (const projectName of readdirSync(root)) {
		const projectDir = join(root, projectName);
		let dirNames;
		try {
			if (!statSync(projectDir).isDirectory()) continue;
			dirNames = readdirSync(projectDir);
		} catch {
			continue;
		}
		for (const dirName of dirNames) {
			if (decodeSessionDirName(dirName) !== sessionId) continue;
			const dir = join(projectDir, dirName);
			const log = logPathIn(dir);
			if (!log) continue;
			const header = readSessionHeader(log.path);
			const cwd = typeof header?.cwd === "string" ? header.cwd : void 0;
			return {
				id: sessionId,
				dir,
				projectDir,
				logName: log.logName,
				...cwd ? { cwd } : {}
			};
		}
	}
}
/** Delete one persisted session (refuses while DSH still holds it). */
async function deleteSession(deps, sessionId) {
	const located = locateSession(deps, sessionId);
	if (!located) throw new Error("找不到该会话的持久化日志");
	if (deps.isLive?.(sessionId)) throw new Error("该会话仍由 DSH 正在使用，请先在网页端停止它");
	if (deps.serviceDelete) try {
		await deps.serviceDelete(sessionId);
	} catch (err) {
		deps.onServiceDeleteError?.(sessionId, err);
	}
	if (existsSync(located.dir)) rmSync(located.dir, {
		recursive: true,
		force: true
	});
	return located;
}
/**
* Move one session into the project directory of `targetCwd` (迁移项目). Copy →
* patch the copy's header → verify → drop the source, so a failure before the
* last step leaves the original untouched and removes the partial copy.
*/
function moveSessionToProject(deps, sessionId, targetCwd) {
	const cwd = String(targetCwd ?? "").trim();
	if (!cwd) throw new Error("目标项目路径不能为空");
	const located = locateSession(deps, sessionId);
	if (!located) throw new Error("找不到该会话的持久化日志");
	if (deps.isLive?.(sessionId)) throw new Error("该会话仍由 DSH 正在使用，请先在网页端停止它");
	if (located.cwd === cwd) throw new Error("该会话已经属于这个项目");
	const targetProjectDir = join(deps.sessionsRoot, projectKeyOf(cwd));
	const targetDir = join(targetProjectDir, basename(located.dir));
	if (existsSync(targetDir)) throw new Error("目标项目下已存在同名会话");
	mkdirSync(targetProjectDir, { recursive: true });
	cpSync(located.dir, targetDir, { recursive: true });
	try {
		const targetLog = join(targetDir, located.logName);
		rewriteSessionCwd(targetLog, cwd);
		if (readSessionHeader(targetLog)?.cwd !== cwd) throw new Error("迁移后校验失败（header.cwd 未生效）");
		rmSync(join(targetDir, LOCK_NAME), { force: true });
	} catch (err) {
		rmSync(targetDir, {
			recursive: true,
			force: true
		});
		throw err;
	}
	rmSync(located.dir, {
		recursive: true,
		force: true
	});
	return {
		id: sessionId,
		from: located.dir,
		to: targetDir,
		cwd
	};
}
/**
* Known projects (workspaces) under the sessions root, newest first.
*
* A project directory's NAME cannot be decoded back to its cwd (the encoding is
* lossy), so each project is labelled with the cwd stored in the header of its
* most recently written session.
*/
function listProjectCwds(deps, limit = 12) {
	const root = deps.sessionsRoot;
	if (!existsSync(root)) return [];
	const found = [];
	for (const projectName of readdirSync(root)) {
		const projectDir = join(root, projectName);
		let dirNames;
		try {
			dirNames = readdirSync(projectDir);
		} catch {
			continue;
		}
		let best;
		for (const dirName of dirNames) {
			const log = logPathIn(join(projectDir, dirName));
			if (!log) continue;
			const cwd = readSessionHeader(log.path)?.cwd;
			if (typeof cwd !== "string" || !cwd) continue;
			let at = 0;
			try {
				at = statSync(log.path).mtimeMs;
			} catch {}
			if (!best || at > best.at) best = {
				cwd,
				at
			};
		}
		if (best) found.push(best);
	}
	return found.sort((a, b) => b.at - a.at).slice(0, limit).map((entry) => entry.cwd);
}
/** Normalize one alias (single line, trimmed, bounded). Throws when empty. */
function sanitizeAlias(value) {
	const alias = String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
	if (!alias) throw new Error("名称不能为空");
	if (alias.length > 48) throw new Error(`名称过长（最多 48 字符）`);
	return alias;
}
function createSessionAliasStore(file) {
	let rows = {};
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		if (parsed && typeof parsed === "object") rows = parsed;
	} catch {
		rows = {};
	}
	const save = () => {
		try {
			writeFileSync(file, `${JSON.stringify(rows, null, 2)}\n`);
		} catch {}
	};
	return {
		get: (sessionId) => rows[sessionId],
		set(sessionId, alias) {
			const clean = sanitizeAlias(alias);
			rows[sessionId] = clean;
			save();
			return clean;
		},
		clear(sessionId) {
			if (sessionId) delete rows[sessionId];
			else rows = {};
			save();
		},
		all: () => ({ ...rows })
	};
}
//#endregion
//#region src/sessions/turn-supervisor.ts
function createTurnSupervisor(deps) {
	const now = deps.now ?? Date.now;
	const armed = /* @__PURE__ */ new Map();
	let timer;
	return {
		arm(key) {
			armed.set(key, now());
		},
		disarm(key) {
			armed.delete(key);
		},
		start() {
			if (timer) return;
			timer = setInterval(() => {
				const cutoff = now() - deps.timeoutMs;
				for (const [key, armedAt] of armed) if (armedAt < cutoff) {
					armed.delete(key);
					deps.logger?.warn(`turn timeout for ${key}; disposing agent to unlock`);
					const agent = deps.backend.get(key);
					if (agent) agent.dispose().then(() => {
						deps.logger?.info(`disposed agent for ${key} after turn timeout`);
					});
				}
			}, 1e3);
			timer.unref?.();
		},
		stop() {
			if (timer) clearInterval(timer);
			timer = void 0;
			armed.clear();
		}
	};
}
const LETTERS = "abcdefghijklmnopqrstuvwxyz";
/**
* Stable 5-letter directory name for one owner id.
*
* sha256 → base26: deterministic across restarts and platforms, and never
* produces path separators, dots (so no `.`/`..` surprises) or case-collision
* ambiguity.
*/
function userWorkspaceId(ownerId) {
	const digest = createHash("sha256").update(String(ownerId ?? "")).digest();
	let out = "";
	for (let i = 0; i < 5; i += 1) {
		const chunk = (digest[i * 4] ?? 0) << 24 | (digest[i * 4 + 1] ?? 0) << 16 | (digest[i * 4 + 2] ?? 0) << 8 | (digest[i * 4 + 3] ?? 0);
		out += LETTERS[(chunk >>> 0) % 26];
	}
	return out;
}
/** The owner's own root under the bridge workspace base. */
function userWorkspaceRoot(base, ownerId) {
	return join(base, userWorkspaceId(ownerId));
}
/** True when `target` is `root` itself or lives underneath it. */
function isInsideWorkspace(root, target) {
	const rel = win32.isAbsolute(root) || win32.isAbsolute(target) ? win32.relative(root, target) : relative(root, target);
	if (rel === "") return true;
	if (rel.startsWith("..")) return false;
	return !isAbsolute(rel) && !win32.isAbsolute(rel);
}
/**
* Resolve the workspace a user is allowed to work in.
*
* `explicit` (an override the user set with /workspace) wins ONLY when it stays
* inside the isolation root — otherwise the root is returned, so a stale or
* hand-edited override can never hand one user another's directory.
*/
function resolveIsolatedWorkspace(base, ownerId, explicit) {
	const root = userWorkspaceRoot(base, ownerId);
	if (explicit && isInsideWorkspace(root, explicit)) return explicit;
	return root;
}
/** Create the isolation root on demand (agent creation needs an existing cwd). */
function ensureWorkspaceDir(dir) {
	try {
		mkdirSync(dir, { recursive: true });
	} catch {}
	return dir;
}
//#endregion
//#region src/outbound/outbox.ts
/** Unref'd sleep so an idle pump never keeps the process alive. */
function sleep$2(ms) {
	return new Promise((resolve) => {
		setTimeout(resolve, ms).unref?.();
	});
}
function createOutbox(deps) {
	const now = deps.now ?? Date.now;
	const dir = deps.dir;
	mkdirSync(join(dir, "blobs"), { recursive: true });
	/** id -> envelope (all statuses, bounded by prune). */
	const envelopes = /* @__PURE__ */ new Map();
	/** laneKey -> array of envelope ids in FIFO order (pending+failed+sending). */
	const lanes = /* @__PURE__ */ new Map();
	/** dedupeKey -> done/fatal envelope id (idempotency, 30d). */
	const sentKeys = /* @__PURE__ */ new Map();
	const isFatal = deps.isFatalError ?? ((e) => /400|403|invalid|not found/i.test(e));
	let draining = false;
	let stopped = false;
	let pruneTimer;
	const activeDeliveries = /* @__PURE__ */ new Set();
	const laneQueues = /* @__PURE__ */ new Map();
	/** Wake signal for the idle pump (set while it waits). */
	let idleWake;
	const emitStats = () => {
		try {
			let pending = 0;
			let failed = 0;
			for (const env of envelopes.values()) {
				if (env.status === "pending" || env.status === "failed") pending++;
				if (env.status === "failed") failed++;
			}
			deps.onStatsChange?.({
				pending,
				failed
			});
		} catch {}
	};
	const segmentPath = (n) => join(dir, `seg-${n}.jsonl`);
	function loadSegment(file) {
		try {
			const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
			for (const line of lines) try {
				const env = JSON.parse(line);
				envelopes.set(env.id, env);
				if (env.dedupeKey) sentKeys.set(env.dedupeKey, env.id);
				if (env.status === "pending" || env.status === "failed" || env.status === "sending") {
					const lane = lanes.get(env.laneKey) ?? [];
					lane.push(env.id);
					lanes.set(env.laneKey, lane);
				}
			} catch {}
		} catch {}
	}
	function rebuildFromDisk() {
		envelopes.clear();
		lanes.clear();
		sentKeys.clear();
		let segs = [];
		try {
			segs = readdirSync(dir).filter((f) => /^seg-\d+\.jsonl$/.test(f)).sort((a, b) => {
				return Number(basename(a).match(/\d+/)?.[0] ?? 0) - Number(basename(b).match(/\d+/)?.[0] ?? 0);
			});
		} catch {
			segs = [];
		}
		for (const seg of segs) loadSegment(join(dir, seg));
		let changed = false;
		for (const env of envelopes.values()) if (env.status === "sending") {
			env.status = "pending";
			env.updatedAt = now();
			changed = true;
		}
		if (changed) persistAll();
	}
	function persistAll() {
		try {
			const segFile = segmentPath(Math.floor(now() / 1e3));
			const lines = [...envelopes.values()].map((e) => JSON.stringify(e));
			const tmp = `${segFile}.tmp`;
			writeFileSync(tmp, lines.join("\n") + "\n", { mode: 384 });
			renameSync(tmp, segFile);
			const cutoff = now() - deps.cfg.retainDays * 864e5;
			for (const f of readdirSync(dir).filter((x) => /^seg-\d+\.jsonl$/.test(x))) if (Number(basename(f).match(/\d+/)?.[0] ?? 0) * 1e3 < cutoff) try {
				rmSync(join(dir, f));
			} catch {}
		} catch {}
	}
	function spill(payload) {
		if (JSON.stringify(payload).length <= deps.cfg.blobThreshold) return { payload };
		const ref = `${randomUUID()}.json`;
		try {
			writeFileSync(join(dir, "blobs", ref), JSON.stringify(payload), { mode: 384 });
			return { blobRef: ref };
		} catch {
			return { payload };
		}
	}
	function resolvePayload(env) {
		if (env.payload) return env.payload;
		if (env.blobRef) try {
			return JSON.parse(readFileSync(join(dir, "blobs", env.blobRef), "utf8"));
		} catch {
			return;
		}
	}
	function enqueue(input) {
		if (stopped) return void 0;
		if (!input.skipDedupe && sentKeys.has(input.dedupeKey)) return void 0;
		if (envelopes.size >= deps.cfg.pendingCap) return;
		const id = randomUUID();
		const spilled = spill(input.payload);
		const env = {
			id,
			dedupeKey: input.dedupeKey,
			laneKey: input.laneKey,
			route: input.route,
			kind: input.kind,
			status: "pending",
			attempts: 0,
			nextRetryAt: now(),
			createdAt: now(),
			updatedAt: now(),
			...spilled
		};
		envelopes.set(id, env);
		sentKeys.set(input.dedupeKey, id);
		const lane = lanes.get(input.laneKey) ?? [];
		lane.push(id);
		lanes.set(input.laneKey, lane);
		persistAll();
		idleWake?.();
		emitStats();
		return id;
	}
	async function deliverOne(id) {
		const env = envelopes.get(id);
		if (!env || env.status === "done" || env.status === "fatal") return;
		const payload = resolvePayload(env);
		if (!payload) {
			env.status = "fatal";
			env.error = "payload unresolved (blob missing)";
			env.updatedAt = now();
			return;
		}
		env.status = "sending";
		env.updatedAt = now();
		const resolved = {
			...env,
			payload
		};
		const result = await deps.sender.deliver(resolved, payload);
		if (result.ok) {
			env.status = "done";
			env.updatedAt = now();
			if (env.dedupeKey) sentKeys.set(env.dedupeKey, env.id);
		} else {
			env.attempts += 1;
			env.error = result.error;
			env.updatedAt = now();
			if (!result.retryable || isFatal(result.error)) env.status = "fatal";
			else if (env.attempts >= deps.cfg.maxAttempts) env.status = "fatal";
			else {
				env.status = "failed";
				const backoff = Math.min(deps.cfg.backoffMaxMs, 1e3 * 2 ** Math.min(env.attempts - 1, 10));
				env.nextRetryAt = now() + backoff;
			}
		}
		persistAll();
		emitStats();
	}
	/** Drain one lane FIFO. Failed messages fall out; retry sweep picks them up. */
	async function drainLane(laneKey) {
		const ids = lanes.get(laneKey);
		if (!ids || ids.length === 0) return;
		const head = ids.shift();
		lanes.set(laneKey, ids);
		if (head !== void 0) await deliverOne(head);
	}
	/** Retry sweep: re-drain 'failed' envelopes whose nextRetryAt has passed. */
	function retrySweep() {
		let woke = false;
		const due = [];
		for (const env of envelopes.values()) if (env.status === "failed" && env.nextRetryAt <= now()) due.push(env.id);
		for (const id of due) {
			const env = envelopes.get(id);
			if (env) {
				const lane = lanes.get(env.laneKey) ?? [];
				if (!lane.includes(id)) {
					lane.push(id);
					lanes.set(env.laneKey, lane);
					woke = true;
				}
			}
		}
		if (woke) idleWake?.();
	}
	async function pump() {
		if (draining) return;
		draining = true;
		try {
			while (!stopped) {
				retrySweep();
				let worked = false;
				for (const laneKey of lanes.keys()) {
					const ids = lanes.get(laneKey);
					if (ids && ids.length > 0) {
						worked = true;
						const next = (laneQueues.get(laneKey) ?? Promise.resolve()).then(() => drainLane(laneKey));
						laneQueues.set(laneKey, next.catch(() => void 0));
						activeDeliveries.add(next);
						next.finally(() => activeDeliveries.delete(next));
					}
				}
				if (!worked) {
					await new Promise((resolve) => {
						idleWake = resolve;
						setTimeout(() => {
							idleWake = void 0;
							resolve();
						}, 200).unref?.();
					});
					idleWake = void 0;
				} else await sleep$2(25);
			}
		} finally {
			draining = false;
		}
	}
	function doPrune() {
		const cutoff = now() - deps.cfg.retainDays * 864e5;
		let changed = false;
		for (const [id, env] of envelopes) if ((env.status === "done" || env.status === "fatal") && env.updatedAt < cutoff) {
			envelopes.delete(id);
			if (env.blobRef) try {
				rmSync(join(dir, "blobs", env.blobRef));
			} catch {}
			changed = true;
		}
		if (changed) persistAll();
		emitStats();
	}
	return {
		enqueue,
		start() {
			stopped = false;
			const cadence = deps.pruneIntervalMs ?? Math.max(36e5, Math.min(864e5, deps.cfg.retainDays * 36e5));
			doPrune();
			pruneTimer = setInterval(() => doPrune(), cadence);
			if (pruneTimer.unref) pruneTimer.unref();
			pump();
		},
		async stop() {
			stopped = true;
			if (pruneTimer) clearInterval(pruneTimer);
			pruneTimer = void 0;
			await Promise.allSettled([...activeDeliveries]);
		},
		pendingCount() {
			let n = 0;
			for (const env of envelopes.values()) if (env.status === "pending" || env.status === "failed") n++;
			return n;
		},
		failedCount() {
			let n = 0;
			for (const env of envelopes.values()) if (env.status === "failed") n++;
			return n;
		},
		prune: doPrune,
		rebuildFromDisk,
		async clear() {
			stopped = true;
			if (pruneTimer) clearInterval(pruneTimer);
			pruneTimer = void 0;
			await Promise.allSettled([...activeDeliveries]);
			envelopes.clear();
			lanes.clear();
			sentKeys.clear();
			try {
				for (const file of readdirSync(dir)) rmSync(join(dir, file), {
					recursive: true,
					force: true
				});
			} catch {}
			mkdirSync(join(dir, "blobs"), { recursive: true });
			emitStats();
		},
		lanes: () => [...lanes.keys()]
	};
}
//#endregion
//#region src/common/token-usage.ts
/** Zero totals. Never mutated — accumulateTokens always returns a fresh object. */
const EMPTY_TOKEN_TOTALS = Object.freeze({
	tokens: 0,
	prompt: 0,
	cacheRead: 0
});
const positive = (value) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
/**
* Fold one step's usage into running totals.
*
* DSH's counts are DISJOINT: `inputTokens` is UNCACHED input only, cached input
* travels separately, so the billed prompt is input + cacheRead + cacheWrite.
* The displayed total prefers the adapter's own full-call `totalTokens` and
* falls back to prompt + output when the provider omitted it.
*/
function accumulateTokens(totals, usage) {
	if (!usage) return totals;
	const cacheRead = positive(usage.cacheReadTokens);
	const prompt = positive(usage.inputTokens) + cacheRead + positive(usage.cacheWriteTokens);
	const billed = usage.totalTokens !== void 0 && Number.isFinite(usage.totalTokens) ? positive(usage.totalTokens) : prompt + positive(usage.outputTokens);
	if (billed <= 0 && prompt <= 0) return totals;
	return {
		tokens: totals.tokens + billed,
		prompt: totals.prompt + prompt,
		cacheRead: totals.cacheRead + cacheRead
	};
}
/**
* Cache-hit share of the billed prompt as a whole percent, or undefined when
* nothing was billed / nothing came from cache (0% is noise, not information).
*/
function cacheHitPercent(totals) {
	if (totals.prompt <= 0 || totals.cacheRead <= 0) return void 0;
	return Math.round(totals.cacheRead / totals.prompt * 100);
}
/**
* Compact count as rendered in the header, matching DSH's footer style:
* `999` → "999", `19300` → "19.3K", `122000` → "122K". The unit (`tok`) is
* appended by the caller once for the whole line.
*/
function formatTokenCount(tokens) {
	const value = Math.max(0, Math.round(tokens));
	if (value < 1e3) return String(value);
	if (value < 1e5) {
		const rounded = Number((value / 1e3).toFixed(1));
		return `${rounded >= 100 ? Math.round(rounded) : rounded.toFixed(1)}K`;
	}
	return `${Math.round(value / 1e3)}K`;
}
//#endregion
//#region src/outbound/event-forwarder.ts
function truncate(value, limit = 900) {
	const text = String(value || "").trim();
	return text.length <= limit ? text : `${text.slice(0, limit)}\n…（已截断 ${text.length - limit} 字符）`;
}
function safeToolArguments(raw) {
	if (!raw) return "";
	try {
		const scrub = (value, key = "") => {
			if (/secret|token|password|authorization|cookie|api[_-]?key/i.test(key)) return "[已脱敏]";
			if (typeof value === "string") return value.length > 700 ? `${value.slice(0, 700)}…` : value;
			if (Array.isArray(value)) return value.slice(0, 12).map((item) => scrub(item));
			if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, k)]));
			return value;
		};
		return truncate(JSON.stringify(scrub(JSON.parse(raw)), null, 2));
	} catch {
		return truncate(raw);
	}
}
function fencedDetail(value, language = "text") {
	const safe = truncate(value).replace(/```/g, "｀｀｀");
	return safe ? "\n```" + language + "\n" + safe + "\n```" : "";
}
function createEventForwarder(deps) {
	const state = /* @__PURE__ */ new Map();
	const queues = /* @__PURE__ */ new Map();
	const emptyState = () => ({
		acc: "",
		lastFlushAt: Date.now(),
		hasOutput: false,
		doneIssued: false,
		errorIssued: false,
		stage: "",
		finalText: "",
		delivered: false,
		toolNames: /* @__PURE__ */ new Map(),
		reasoningRounds: 0,
		reasoningInStep: false,
		turnTokens: EMPTY_TOKEN_TOTALS,
		sessionTokens: EMPTY_TOKEN_TOTALS
	});
	/**
	* Re-render the header with the current token totals. Called whenever a step
	* reported real usage, and right after a card is (re)created mid-turn so a
	* fresh card never loses the session total. No-op without a live card.
	*/
	async function pushTokens(st) {
		if (!st.stream || st.stream.disposed) return;
		await st.stream.usage({
			turn: st.turnTokens,
			session: st.sessionTokens
		});
	}
	const routeRefFor = (route) => ({
		sessionKey: route.sessionKey,
		chatId: route.chatId,
		chatType: route.chatType,
		threadMessageId: route.threadMessageId
	});
	async function handleSessionEvent(sessionKey, event) {
		const route = deps.routeFor(sessionKey);
		if (!route) {
			deps.warn?.(String(sessionKey).includes("#") ? `no Feishu route for task ${sessionKey} — task→conversation routing is broken, output was dropped` : `no Feishu route for ${sessionKey}`);
			return;
		}
		const st = state.get(sessionKey) ?? emptyState();
		state.set(sessionKey, st);
		switch (event.type) {
			case "turn/start":
				st.hasOutput = false;
				st.doneIssued = false;
				st.errorIssued = false;
				st.acc = "";
				st.finalText = "";
				st.delivered = false;
				st.toolNames.clear();
				st.reasoningRounds = 0;
				st.reasoningInStep = false;
				st.triggerMessageId = void 0;
				st.stream = void 0;
				st.stage = "thinking";
				st.turnTokens = EMPTY_TOKEN_TOTALS;
				if (deps.cfg().streamingEnabled) {
					const stream = deps.streamFor(sessionKey)?.ensureStream();
					if (stream && !stream.disposed) {
						st.stream = stream;
						await stream.status("🧠 **思考中**", { phase: "thinking" });
						await pushTokens(st);
					}
				}
				break;
			case "assistant/chunk": {
				const { streamingEnabled } = deps.cfg();
				if (!streamingEnabled) return;
				st.acc += event.text;
				if (!st.stream || st.stream.disposed) {
					const stream = deps.streamFor(sessionKey)?.ensureStream();
					if (stream && !stream.disposed) st.stream = stream;
				}
				if (st.stream && !st.stream.disposed) {
					if (st.stage !== "answering") {
						st.stage = "answering";
						await st.stream.status("✍️ **生成中**", { phase: "generating" });
					}
					await st.stream.patch(event.text);
				}
				break;
			}
			case "assistant/message": {
				if (event.usage) {
					st.turnTokens = accumulateTokens(st.turnTokens, event.usage);
					st.sessionTokens = accumulateTokens(st.sessionTokens, event.usage);
					await pushTokens(st);
				}
				const text = st.acc.length > event.text.length ? st.acc : event.text;
				st.acc = "";
				if (event.reasoning && st.stream && !st.stream.disposed && !st.reasoningInStep) {
					st.reasoningRounds += 1;
					await st.stream.reasoning(event.reasoning);
				}
				st.reasoningInStep = false;
				if (event.hasToolCalls) {
					if (st.stream && !st.stream.disposed) {
						if (text.trim()) await st.stream.patch(text, true);
						st.stage = "thought";
						await st.stream.status("🧠 **思考中**", { phase: "thinking" });
					}
					return;
				}
				if (!text || text.trim() === "" || text === "No response.") return;
				st.hasOutput = true;
				st.finalText = text;
				if (deps.cfg().streamingEnabled && st.stream && !st.stream.disposed) {
					st.stage = "output-success";
					await st.stream.patch(text, true);
					await st.stream.status("✍️ **生成中**", { phase: "generating" });
					return;
				}
				await deps.outbox.enqueue({
					dedupeKey: `${sessionKey}:assistant:${text.length}:${Date.now()}`,
					laneKey: sessionKey,
					route: routeRefFor(route),
					kind: "assistant-output",
					payload: {
						kind: "text",
						text
					}
				});
				st.delivered = true;
				st.triggerMessageId = deps.onDelivered?.(sessionKey);
				break;
			}
			case "turn/end": {
				st.acc = "";
				const rescue = String(event.finalText ?? "").trim();
				const final = st.finalText || (rescue !== "No response." ? rescue : "");
				if (final) st.hasOutput = true;
				if (st.hasOutput && !st.delivered) {
					if (st.stream && !st.stream.disposed) try {
						st.stage = "ended";
						await st.stream.patch(final, true);
						await st.stream.status("✅ **对话结束**", { phase: "done" });
						await st.stream.finalize(final);
						st.stream = void 0;
						st.delivered = true;
						st.triggerMessageId = deps.onDelivered?.(sessionKey);
					} catch {
						st.stream = void 0;
					}
					if (!st.delivered) try {
						await deps.outbox.enqueue({
							dedupeKey: `${sessionKey}:final:${final.length}:${Date.now()}`,
							laneKey: sessionKey,
							route: routeRefFor(route),
							kind: "assistant-output",
							payload: {
								kind: "text",
								text: final
							}
						});
						st.delivered = true;
						st.triggerMessageId = deps.onDelivered?.(sessionKey);
					} catch {}
				}
				const failed = [
					"rejected",
					"failed",
					"error"
				].includes(event.reason);
				if (!st.hasOutput) {
					const detail = event.error?.message?.trim();
					const status = failed ? `❌ **对话异常结束**${detail ? `\n\n\`${detail.slice(0, 300)}\`` : ""}` : "⚪ **对话结束（无输出）**";
					const target = deps.streamFor(sessionKey);
					if (st.stream && !st.stream.disposed) try {
						st.stage = failed ? "failed" : "empty";
						await st.stream.status(status, { phase: "done" });
						await st.stream.finalize("");
					} catch {
						await target?.fallbackText(status);
					}
					else if (deps.cfg().streamingEnabled) await target?.fallbackText(status);
					st.stream = void 0;
				}
				const target = deps.streamFor(sessionKey);
				if (failed) {
					if (!st.errorIssued) {
						st.errorIssued = true;
						await target?.markError(st.triggerMessageId);
					}
				} else if (target && st.delivered && !st.doneIssued) {
					st.doneIssued = true;
					await target.markDone(st.triggerMessageId);
				}
				break;
			}
			case "tool/call":
				if (!deps.cfg().streamingEnabled) break;
				if (!st.stream || st.stream.disposed) st.stream = deps.streamFor(sessionKey)?.ensureStream();
				if (st.stream && !st.stream.disposed) {
					if (event.callId) st.toolNames.set(event.callId, event.name);
					st.stage = "tool";
					if (event.arguments) st.stream.countGenerated(event.arguments);
					const args = safeToolArguments(event.arguments);
					await st.stream.tool(`▶️ 调用 \`${event.name || "unknown"}\`${args ? fencedDetail(args, "json") : ""}`, {
						phase: "call",
						callId: event.callId,
						title: event.name || "unknown"
					});
					await st.stream.status("🛠️ **工具执行中**", { phase: "tool" });
				}
				break;
			case "assistant/reasoning":
				if (!deps.cfg().streamingEnabled) return;
				if (!st.stream || st.stream.disposed) st.stream = deps.streamFor(sessionKey)?.ensureStream();
				if (st.stream && !st.stream.disposed) {
					st.stage = "thinking";
					await st.stream.status("🧠 **思考中**", { phase: "thinking" });
					if (!st.reasoningInStep) {
						st.reasoningRounds += 1;
						st.reasoningInStep = true;
						await st.stream.reasoning(event.text);
					} else await st.stream.reasoning(event.text);
				}
				break;
			case "tool/result":
				if (!deps.cfg().streamingEnabled) break;
				if (!st.stream || st.stream.disposed) st.stream = deps.streamFor(sessionKey)?.ensureStream();
				if (st.stream && !st.stream.disposed) {
					const toolName = event.callId && st.toolNames.get(event.callId) || (event.name === "tool-result" ? "unknown" : event.name) || "unknown";
					if (event.callId) st.toolNames.delete(event.callId);
					st.stage = event.error ? "tool-error" : "thinking";
					const resultDetail = event.error?.message || event.output || "";
					await st.stream.tool(event.error ? `❌ \`${toolName}\` 失败${event.error.code ? ` · \`${event.error.code}\`` : ""}${resultDetail ? fencedDetail(resultDetail) : ""}` : `✅ \`${toolName}\` 成功${resultDetail ? fencedDetail(resultDetail) : ""}`, {
						phase: "result",
						callId: event.callId,
						title: toolName
					});
					await st.stream.status("🧠 **思考中**", { phase: "thinking" });
				}
		}
	}
	function onSessionEvent(sessionKey, event) {
		const next = (queues.get(sessionKey) ?? Promise.resolve()).then(() => handleSessionEvent(sessionKey, event), () => handleSessionEvent(sessionKey, event));
		queues.set(sessionKey, next.catch(() => void 0));
		return next;
	}
	async function finalizeSession(sessionKey) {
		await queues.get(sessionKey)?.catch(() => void 0);
		const st = state.get(sessionKey);
		if (!st) return;
		if (st.acc.length > 0 && st.hasOutput === false) {
			const route = deps.routeFor(sessionKey);
			if (route) await deps.outbox.enqueue({
				dedupeKey: `${sessionKey}:finalize:${Date.now()}`,
				laneKey: sessionKey,
				route: routeRefFor(route),
				kind: "assistant-output",
				payload: {
					kind: "text",
					text: st.acc
				}
			});
		}
		if (st.stream) {
			try {
				await st.stream.finalize("");
			} catch {}
			st.stream = void 0;
		}
		state.delete(sessionKey);
		queues.delete(sessionKey);
	}
	return {
		onSessionEvent,
		finalizeSession,
		snapshot(sessionKey) {
			const st = state.get(sessionKey);
			if (!st) return void 0;
			return {
				text: st.finalText || st.acc,
				stage: st.stage,
				streaming: Boolean(st.stream && !st.stream.disposed),
				settled: [
					"ended",
					"failed",
					"empty"
				].includes(st.stage)
			};
		}
	};
}
/** CJK / kana / hangul ranges counted as one token per character. */
const CJK_CHAR = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f\uac00-\ud7af]/;
/** Serialized-card budget — a CardKit platform limit, not a policy knob. */
const MAX_CARD_BYTES = 24e3;
/** Characters of detail kept for the NEWEST folded round at full quality. */
const DEFAULT_DETAIL_LIMIT = 900;
/** Every step of AGE halves the allowance: the newest round keeps 900 chars,
*  the one before it 450, then 225 … down to 0 (titles only). */
const DETAIL_DECAY = .5;
/** Binary-search passes used to fit one stage (8 ≈ 0.4% resolution). */
const DETAIL_FIT_STEPS = 8;
/** Last-resort card: a longer answer belongs on the durable text channel. */
const MINIMAL_CARD_ANSWER_LIMIT = 1e4;
/** Per-age body allowance BEFORE scaling (index 0 = the newest round). */
const DETAIL_LADDER = Array.from({ length: 12 }, (_unused, age) => Math.max(0, Math.round(DEFAULT_DETAIL_LIMIT * DETAIL_DECAY ** age)));
/**
* Compaction stages, tried in order until the card fits the budget.
*
* The order encodes the reader's priority: the LATEST state is the last thing to
* lose detail, because what the user opens the card for is "what is the AI doing
* right now". Stage 1 shrinks every round's body allowance (newest keeps the
* most), stage 2 drops intermediate narration, and the rest drop the OLDEST
* rounds' bodies and then the rounds themselves. The status line with its token
* totals and the live/answer text are never compressed by any stage.
*/
const COMPACT_STAGES = [
	{
		dropNarration: false,
		keepRounds: Number.POSITIVE_INFINITY
	},
	{
		dropNarration: true,
		keepRounds: Number.POSITIVE_INFINITY
	},
	{
		dropNarration: true,
		keepRounds: 8
	},
	{
		dropNarration: true,
		keepRounds: 4
	},
	{
		dropNarration: true,
		keepRounds: 2
	},
	{
		dropNarration: true,
		keepRounds: 1
	}
];
/** element ids are 1–20 chars per CardKit rules. */
const STREAM_ELEMENT_ID = "stream_md";
const STATUS_ELEMENT_ID = "status_md";
const REASONING_ELEMENT_ID = "reasoning_md";
const TOOL_ELEMENT_ID = "tool_md";
function createCardKitStream(opts) {
	let cardId;
	let seq = 0;
	const lastPatchAt = /* @__PURE__ */ new Map();
	let disposed = false;
	let createPromise;
	let operationTail = Promise.resolve();
	let backoffUntil = 0;
	const timeline = [];
	let nextTimelineOrdinal = 1;
	let reasoningCount = 0;
	let toolCount = 0;
	let textCount = 0;
	let statusText = "";
	let structureSignature = "";
	/** Compaction level last reported (observability fires on CHANGE only). */
	let compactStage = -1;
	/** Text segment that carries the ANSWER once the turn has settled. */
	let finalSegmentId;
	const now = opts.now ?? Date.now;
	const startedAt = now();
	const minInterval = opts.minPushIntervalMs ?? opts.printFrequencyMs ?? 800;
	const maxCardBytes = opts.maxCardBytes ?? MAX_CARD_BYTES;
	/** Detail scale that fit last time (1 = uncompacted), seeding the next search. */
	let lastFittedScale = 1;
	const statusTickMs = opts.statusTickMs === void 0 ? 1e3 : Math.max(0, opts.statusTickMs);
	let statusTimer;
	const nextSeq = () => {
		seq += 1;
		return seq;
	};
	const elapsedSeconds = () => Math.max(0, Math.floor((now() - startedAt) / 1e3));
	/**
	* Fallback estimate for one piece of GENERATED text (assistant output +
	* reasoning): CJK costs ~1 token per character, everything else ~1 per 4.
	*
	* This is ONLY a fallback. DSH reports real accounting on every step's
	* `assistant/message` (`usage: {inputTokens, outputTokens, cacheReadTokens…}`)
	* and THAT is what the header shows; the estimate keeps the header meaningful
	* for adapters that report none.
	*/
	const estimateTokens = (text) => {
		let cjk = 0;
		let other = 0;
		for (const ch of text) if (CJK_CHAR.test(ch)) cjk += 1;
		else other += 1;
		return cjk + Math.ceil(other / 4);
	};
	/** Whole-turn generated estimate — used only when no real usage arrived. */
	let generatedTokens = 0;
	/**
	* Real accounting pushed by the forwarder: this turn's own total and the
	* session's running total. Undefined until a step reports usage.
	*/
	let tokenTotals;
	/**
	* Record model-generated content into the fallback estimate. `replace` calls
	* are deliberately NOT routed here: they may re-deliver a whole message that
	* was already counted.
	*/
	const recordGeneration = (deltaTokens) => {
		generatedTokens += deltaTokens;
	};
	/**
	* Header suffix: elapsed time plus token accounting.
	*
	* Real accounting renders the way DSH's own WebUI footer does —
	* `12s · 本回合 19.3K · 会话 122K tok`, plus `缓存命中 N%` once anything was
	* served from cache. Only when no adapter reported usage does it degrade to
	* the stream-derived estimate, marked `≈` so it can never be mistaken for a
	* real number — including the case where the only totals pushed so far are
	* zeros (a failed turn reports no usage at all, and claiming "0 tok" would be
	* a fabricated reading). Token SPEED is gone on purpose: it needed a
	* per-episode denominator, flickered while generating and read as noise — a
	* total is what a reader can act on.
	*/
	const progressSuffix = () => {
		const parts = [`**${elapsedSeconds()}s**`];
		const totals = tokenTotals && (tokenTotals.turn.tokens > 0 || tokenTotals.session.tokens > 0) ? tokenTotals : void 0;
		if (totals) {
			parts.push(`本回合 ${formatTokenCount(totals.turn.tokens)} · 会话 ${formatTokenCount(totals.session.tokens)} tok`);
			const hit = cacheHitPercent(totals.session);
			if (hit !== void 0) parts.push(`缓存命中 ${hit}%`);
		} else if (generatedTokens > 0) parts.push(`≈${formatTokenCount(generatedTokens)} tok`);
		return ` · ${parts.join(" · ")}`;
	};
	const renderedStatus = () => `${statusText || "🧠 **思考中**"}${progressSuffix()}`;
	const reasoningCode = (content) => {
		const safe = content.replace(/```/g, "｀｀｀").trim();
		return safe ? `\`\`\`text\n${safe}\n\`\`\`` : "*等待模型返回可展示的思考内容…*";
	};
	const clip = (value, limit) => {
		const text = String(value || "");
		if (limit <= 0) return "";
		return text.length <= limit ? text : `${text.slice(0, limit)}\n…（已省略 ${text.length - limit} 字符）`;
	};
	/**
	* One round inside a folded run: a LABELLED markdown block, deliberately not
	* another collapsible panel. That keeps the nesting at two levels
	* (总过程 → 轮次组 → 内容), which every Feishu client renders reliably.
	*/
	const segmentBlock = (segment, detailLimit) => {
		const label = segment.kind === "reasoning" ? `思考 ${segment.ordinal}` : `工具 ${segment.ordinal}${segment.title ? ` · ${segment.title}` : ""}`;
		const body = clip(segment.content, detailLimit);
		const rendered = segment.kind === "reasoning" ? body ? reasoningCode(body) : "*细节已省略*" : body || "*细节已省略*";
		return {
			tag: "markdown",
			element_id: segment.id,
			content: `**${label}**\n${rendered}`
		};
	};
	/**
	* The whole intermediate process folded into ONE collapsible panel.
	*
	* There is deliberately only ONE collapsible level: nested run panels used to
	* let several sub-panels stand open at once, and Feishu's `collapsible_panel`
	* expansion is client-local (no callback), so "one open at a time" cannot be
	* enforced server-side. Flattening every round into this single panel gets
	* that behaviour by construction, and renders more reliably (nesting depth 1).
	*/
	const outerPanel = (elements, plan) => {
		const tools = timeline.filter((segment) => segment.kind === "tool").length;
		const thinks = timeline.filter((segment) => segment.kind === "reasoning").length;
		const messages = plan.dropNarration ? 0 : timeline.filter((segment) => segment.kind === "text" && segment.id !== finalSegmentId).length;
		const parts = [];
		if (messages > 0) parts.push(`${messages} 轮对话`);
		if (tools > 0) parts.push(`${tools} 工具`);
		if (thinks > 0) parts.push(`${thinks} 思考`);
		return {
			tag: "collapsible_panel",
			expanded: false,
			header: {
				title: {
					tag: "plain_text",
					content: `过程 · ${parts.join(" · ")}`
				},
				icon: {
					tag: "standard_icon",
					token: "down-small-ccm_outlined",
					size: "16px 16px"
				},
				icon_position: "right",
				icon_expanded_angle: -180
			},
			border: {
				color: "grey",
				corner_radius: "5px"
			},
			elements
		};
	};
	const segmentId = (kind, count) => {
		if (count === 1) {
			if (kind === "reasoning") return REASONING_ELEMENT_ID;
			if (kind === "tool") return TOOL_ELEMENT_ID;
			return STREAM_ELEMENT_ID;
		}
		return `${kind === "reasoning" ? "reason" : kind === "tool" ? "tool" : "text"}_${count}`;
	};
	const currentStructure = () => timeline.map((segment) => segment.kind === "image" ? `i:${segment.order}` : `${segment.kind[0]}:${segment.id}`).join("|");
	/**
	* Card body: status header, every process round folded into ONE panel, then the
	* visible output (the settled answer, or the text currently being written, plus
	* any generated image).
	*
	* Detail is budgeted by AGE (see DETAIL_LADDER): the newest round keeps the most
	* characters, older rounds are progressively clipped and the oldest lose their
	* rows first — a shrinking budget must never cost the reader the CURRENT state.
	*/
	const cardElements = (plan) => {
		const header = {
			tag: "markdown",
			content: renderedStatus(),
			element_id: STATUS_ELEMENT_ID
		};
		const processSegments = timeline.filter((segment) => segment.kind === "reasoning" || segment.kind === "tool");
		const ageOf = /* @__PURE__ */ new Map();
		processSegments.forEach((segment, index) => ageOf.set(segment.id, processSegments.length - 1 - index));
		/** -1 = the round is dropped by the age cap (title included). */
		const detailFor = (segment) => {
			const age = ageOf.get(segment.id) ?? 0;
			if (age >= plan.keepRounds) return -1;
			return plan.detailLimits[Math.min(age, plan.detailLimits.length - 1)] ?? 0;
		};
		const body = [];
		for (const segment of timeline) if (segment.kind === "text") {
			const isFinal = segment.id === finalSegmentId;
			if (plan.dropNarration && !isFinal) continue;
			body.push({
				tag: "markdown",
				content: segment.content || " ",
				element_id: segment.id
			});
		} else if (segment.kind === "image") body.push({
			tag: "img",
			img_key: segment.imageKey,
			alt: {
				tag: "plain_text",
				content: segment.alt || "生成图片"
			},
			mode: "fit_horizontal",
			preview: true
		});
		else {
			const limit = detailFor(segment);
			if (limit < 0) continue;
			body.push(segmentBlock(segment, limit));
		}
		const isImage = (element) => element.tag === "img";
		const textIndices = [];
		body.forEach((element, index) => {
			if (element.tag === "markdown") textIndices.push(index);
		});
		let visibleText;
		if (finalSegmentId !== void 0) visibleText = textIndices.find((index) => body[index].element_id === finalSegmentId);
		if (visibleText === void 0) visibleText = textIndices.at(-1);
		const visible = body.filter((element, index) => index === visibleText || isImage(element));
		const process = body.filter((element, index) => index !== visibleText && !isImage(element));
		return process.length > 0 ? [
			header,
			outerPanel(process, plan),
			...visible
		] : [header, ...visible];
	};
	/** Card `config` block — shared by the full card and the last-resort card. */
	const cardConfig = (streaming) => ({
		update_multi: true,
		...streaming ? {
			streaming_mode: true,
			streaming_config: {
				print_frequency_ms: { default: opts.printFrequencyMs ?? 120 },
				print_step: { default: opts.printStep ?? 3 },
				print_strategy: "fast"
			}
		} : { streaming_mode: false }
	});
	const buildCardJson = (streaming, plan) => JSON.stringify({
		schema: "2.0",
		config: cardConfig(streaming),
		body: { elements: cardElements(plan) }
	});
	/** Plan for one compaction stage at a given detail scale (0 = titles only). */
	const planAt = (stage, scale) => {
		const { dropNarration, keepRounds } = COMPACT_STAGES[stage];
		return {
			detailLimits: DETAIL_LADDER.map((limit) => Math.round(limit * scale)),
			dropNarration,
			keepRounds
		};
	};
	const fitsBudget = (json) => Buffer.byteLength(json, "utf8") <= maxCardBytes;
	/**
	* Largest detail scale of ONE stage that fits the budget, or undefined when
	* even scale 0 (bodies fully dropped) overflows.
	*
	* The binary search is what makes this FINE-grained: instead of jumping
	* between a few coarse presets (900 → 300 → 120 → 0), the largest allowance
	* that still fits survives, so a 23.9KB card keeps meaningfully more detail
	* than a 12KB one.
	*/
	const fitStage = (stage, streaming) => {
		const build = (scale) => buildCardJson(streaming, planAt(stage, scale));
		const top = Math.min(1, lastFittedScale);
		const full = build(top);
		if (fitsBudget(full)) {
			lastFittedScale = top;
			return {
				json: full,
				scale: top
			};
		}
		const floor = build(0);
		if (!fitsBudget(floor)) {
			lastFittedScale = 1;
			return;
		}
		let lo = 0;
		let hi = top;
		let best = {
			json: floor,
			scale: 0
		};
		for (let step = 0; step < DETAIL_FIT_STEPS; step += 1) {
			const mid = (lo + hi) / 2;
			const json = build(mid);
			if (fitsBudget(json)) {
				best = {
					json,
					scale: mid
				};
				lo = mid;
			} else hi = mid;
		}
		lastFittedScale = best.scale;
		return best;
	};
	/** Report a compaction level CHANGE only (serialization runs per segment). */
	const reportCompaction = (stage, scale, bytes) => {
		if (stage === 0 && scale >= 1) return;
		if (stage === compactStage) return;
		compactStage = stage;
		opts.onCompacted?.({
			stage,
			scale,
			bytes
		});
	};
	/**
	* Serialize the card, COMPACTING until it fits CardKit's budget.
	*
	* A long turn (dozens of tool rounds with fenced arguments) overshoots the
	* card-size limit, and a rejected PUT used to freeze the card mid-stream with
	* no answer. Stages are tried in reader-priority order (see COMPACT_STAGES)
	* and every one of them leaves the status line and the visible answer intact —
	* the card must always answer "what is the AI doing right now".
	*/
	const cardJson = (streaming) => {
		for (let stage = 0; stage < COMPACT_STAGES.length; stage += 1) {
			const fitted = fitStage(stage, streaming);
			if (!fitted) continue;
			reportCompaction(stage, fitted.scale, Buffer.byteLength(fitted.json, "utf8"));
			return fitted.json;
		}
		const bare = minimalCardJson(finalAnswerText().slice(0, MINIMAL_CARD_ANSWER_LIMIT), streaming);
		reportCompaction(COMPACT_STAGES.length, 0, Buffer.byteLength(bare, "utf8"));
		return bare;
	};
	/** The answer text the settled card must keep visible. */
	const finalAnswerText = () => {
		const target = finalSegmentId ? timeline.find((segment) => segment.kind === "text" && segment.id === finalSegmentId) : timeline.filter((segment) => segment.kind === "text").at(-1);
		return target && target.kind === "text" ? target.content : "";
	};
	/**
	* Last-resort card (status + answer only) when the full card was rejected.
	* `streaming` keeps the typewriter config alive for an in-turn fallback.
	*/
	const minimalCardJson = (answer, streaming = false) => JSON.stringify({
		schema: "2.0",
		config: cardConfig(streaming),
		body: { elements: [{
			tag: "markdown",
			content: renderedStatus(),
			element_id: STATUS_ELEMENT_ID
		}, {
			tag: "markdown",
			content: answer || " ",
			element_id: STREAM_ELEMENT_ID
		}] }
	});
	const createPayload = (streaming) => ({
		type: "card_json",
		data: cardJson(streaming)
	});
	const extractCardId = (res) => res?.card_id ?? res?.data?.card_id;
	const startStatusTimer = () => {
		if (statusTimer || statusTickMs <= 0) return;
		statusTimer = setInterval(() => {
			if (!disposed && cardId) pushElement(STATUS_ELEMENT_ID, renderedStatus());
		}, statusTickMs);
		statusTimer.unref?.();
	};
	const stopStatusTimer = () => {
		if (statusTimer) clearInterval(statusTimer);
		statusTimer = void 0;
	};
	const enqueueOperation = async (op) => {
		const run = operationTail.then(op, op);
		operationTail = run.then(() => void 0, () => void 0);
		return run;
	};
	const ensureCard = async () => {
		if (disposed) return;
		if (cardId !== void 0) return;
		if (createPromise) return createPromise;
		createPromise = enqueueOperation(async () => {
			if (cardId !== void 0 || disposed) return;
			try {
				const created = await opts.api.createCard(createPayload(true));
				cardId = extractCardId(created);
				if (!cardId) throw new Error("CardKit create returned no card_id");
				await opts.api.deliverCard(cardId);
				structureSignature = currentStructure();
				const stamp = now();
				lastPatchAt.set(STATUS_ELEMENT_ID, stamp);
				for (const segment of timeline) if (segment.kind !== "image") lastPatchAt.set(segment.id, stamp);
				startStatusTimer();
			} catch (err) {
				opts.onError?.(err);
				disposed = true;
				stopStatusTimer();
			}
		}).finally(() => {
			createPromise = void 0;
		});
		return createPromise;
	};
	const syncStructure = async () => {
		await ensureCard();
		if (!cardId || disposed || structureSignature === currentStructure()) return;
		await enqueueOperation(async () => {
			if (!cardId || disposed || structureSignature === currentStructure()) return;
			try {
				await opts.api.updateCard(cardId, {
					card: {
						type: "card_json",
						data: cardJson(true)
					},
					sequence: nextSeq(),
					uuid: randomUUID()
				});
				structureSignature = currentStructure();
				const stamp = now();
				for (const segment of timeline) if (segment.kind !== "image") lastPatchAt.set(segment.id, stamp);
			} catch (err) {
				opts.onError?.(err);
			}
		});
	};
	async function pushElement(elementId, content) {
		await ensureCard();
		if (!cardId || disposed) return;
		await enqueueOperation(async () => {
			if (!cardId || disposed) return;
			const currentTime = now();
			if (currentTime < backoffUntil || currentTime - (lastPatchAt.get(elementId) ?? 0) < minInterval) return;
			lastPatchAt.set(elementId, currentTime);
			try {
				await opts.api.streamText(cardId, elementId, {
					content,
					sequence: nextSeq(),
					uuid: randomUUID()
				});
			} catch (err) {
				const errStr = String(err);
				if (errStr.includes("230020") || errStr.includes("rate limit") || errStr.includes("429")) backoffUntil = now() + 1500;
				opts.onError?.(err);
			}
		});
	}
	return {
		get cardId() {
			return cardId ?? "";
		},
		get disposed() {
			return disposed;
		},
		async status(text) {
			statusText = String(text || "").trim();
			await ensureCard();
			await pushElement(STATUS_ELEMENT_ID, renderedStatus());
		},
		async usage(totals) {
			if (disposed) return;
			tokenTotals = {
				turn: totals.turn,
				session: totals.session
			};
			await ensureCard();
			await pushElement(STATUS_ELEMENT_ID, renderedStatus());
		},
		countGenerated(text) {
			if (disposed) return;
			const tokens = estimateTokens(String(text || ""));
			if (tokens > 0) recordGeneration(tokens);
		},
		async reasoning(text, replace = false) {
			if (disposed) return;
			let segment = timeline.at(-1);
			if (segment?.kind !== "reasoning") {
				reasoningCount += 1;
				segment = {
					kind: "reasoning",
					id: segmentId("reasoning", reasoningCount),
					content: "",
					ordinal: reasoningCount,
					order: nextTimelineOrdinal++
				};
				timeline.push(segment);
			}
			const reasoningDelta = String(text || "");
			if (replace) segment.content = reasoningDelta;
			else {
				segment.content += reasoningDelta;
				recordGeneration(estimateTokens(reasoningDelta));
			}
			await syncStructure();
			await pushElement(segment.id, reasoningCode(segment.content));
		},
		async tool(text, options = {}) {
			if (disposed) return;
			let segment;
			if (options.phase === "result" && options.callId) segment = timeline.findLast((entry) => entry.kind === "tool" && entry.callId === options.callId);
			if (!segment && options.phase !== "call") {
				const last = timeline.at(-1);
				if (last?.kind === "tool") segment = last;
			}
			if (!segment) {
				toolCount += 1;
				segment = {
					kind: "tool",
					id: segmentId("tool", toolCount),
					content: "",
					ordinal: toolCount,
					order: nextTimelineOrdinal++,
					callId: options.callId,
					title: options.title
				};
				timeline.push(segment);
			}
			if (options.title && !segment.title) segment.title = options.title;
			const normalized = String(text || "").trim();
			segment.content += `${segment.content && normalized ? "\n\n" : ""}${normalized}`;
			await syncStructure();
			await pushElement(segment.id, segment.content || "*等待工具返回…*");
		},
		async image(imageKey, alt = "生成图片") {
			if (disposed || !imageKey) return;
			timeline.push({
				kind: "image",
				imageKey: String(imageKey),
				alt: String(alt || "生成图片"),
				order: nextTimelineOrdinal++
			});
			await syncStructure();
		},
		async patch(text, replace = false) {
			if (disposed) return;
			let segment = timeline.at(-1);
			if (segment?.kind !== "text") {
				textCount += 1;
				segment = {
					kind: "text",
					id: segmentId("text", textCount),
					content: "",
					ordinal: textCount,
					order: nextTimelineOrdinal++
				};
				timeline.push(segment);
			}
			const patchDelta = String(text || "");
			if (replace) segment.content = patchDelta;
			else {
				segment.content += patchDelta;
				recordGeneration(estimateTokens(patchDelta));
			}
			await syncStructure();
			await pushElement(segment.id, segment.content || " ");
		},
		async finalize(fullText) {
			if (disposed) {
				if (!cardId) throw new Error("CardKit stream handle was disposed (creation failed)");
				return cardId;
			}
			stopStatusTimer();
			await operationTail;
			if (fullText) {
				let segment = timeline.at(-1);
				if (segment?.kind !== "text") {
					textCount += 1;
					segment = {
						kind: "text",
						id: segmentId("text", textCount),
						content: "",
						ordinal: textCount,
						order: nextTimelineOrdinal++
					};
					timeline.push(segment);
				}
				segment.content = fullText;
				finalSegmentId = segment.id;
			} else {
				const lastText = timeline.filter((segment) => segment.kind === "text").at(-1);
				if (lastText) finalSegmentId = lastText.id;
			}
			if (!cardId) try {
				const created = await opts.api.createCard(createPayload(false));
				cardId = extractCardId(created);
				if (!cardId) throw new Error("CardKit create returned no card_id");
				await opts.api.deliverCard(cardId);
				disposed = true;
				return cardId;
			} catch (err) {
				opts.onError?.(err);
				disposed = true;
				throw err;
			}
			const id = cardId;
			try {
				await opts.api.patchSettings(id, {
					settings: JSON.stringify({ config: { streaming_mode: false } }),
					sequence: nextSeq(),
					uuid: randomUUID()
				});
			} catch (err) {
				opts.onError?.(err);
			}
			try {
				await opts.api.updateCard(id, {
					card: {
						type: "card_json",
						data: cardJson(false)
					},
					sequence: nextSeq(),
					uuid: randomUUID()
				});
			} catch (err) {
				const errStr = String(err);
				if (errStr.includes("230020") || errStr.includes("rate limit") || errStr.includes("429")) {
					await new Promise((r) => setTimeout(r, 600));
					try {
						await opts.api.updateCard(id, {
							card: {
								type: "card_json",
								data: cardJson(false)
							},
							sequence: nextSeq(),
							uuid: randomUUID()
						});
						disposed = true;
						return id;
					} catch (retryErr) {
						opts.onError?.(retryErr);
						disposed = true;
						throw retryErr;
					}
				}
				const answer = finalAnswerText();
				if (Buffer.byteLength(answer, "utf8") <= MINIMAL_CARD_ANSWER_LIMIT) try {
					await opts.api.updateCard(id, {
						card: {
							type: "card_json",
							data: minimalCardJson(answer)
						},
						sequence: nextSeq(),
						uuid: randomUUID()
					});
					opts.onError?.(err);
					disposed = true;
					return id;
				} catch (minimalErr) {
					opts.onError?.(minimalErr);
				}
				opts.onError?.(err);
				disposed = true;
				throw err;
			}
			disposed = true;
			return id;
		}
	};
}
//#endregion
//#region src/outbound/outbound-router.ts
function createRouteStore(file, now = Date.now) {
	let routes = /* @__PURE__ */ new Map();
	try {
		const raw = readFileSync(file, "utf8");
		const parsed = JSON.parse(raw);
		routes = new Map(parsed.map((r) => [r.sessionKey, r]));
	} catch {
		routes = /* @__PURE__ */ new Map();
	}
	const persist = () => {
		try {
			writeFileSync(file, JSON.stringify([...routes.values()], null, 2), { mode: 384 });
		} catch {}
	};
	return {
		get(key) {
			return routes.get(key);
		},
		all() {
			return [...routes.values()];
		},
		upsert(route) {
			routes.set(route.sessionKey, route);
			persist();
		},
		touch(key, lastMessageId) {
			const r = routes.get(key);
			if (!r) return;
			r.updatedAt = now();
			if (lastMessageId !== void 0) r.lastMessageId = lastMessageId;
			persist();
		},
		remove(key) {
			routes.delete(key);
			persist();
		},
		clear() {
			routes.clear();
			persist();
		},
		prune(maxAgeMs) {
			const cutoff = now() - maxAgeMs;
			let changed = false;
			for (const [k, r] of routes) if (r.updatedAt < cutoff) {
				routes.delete(k);
				changed = true;
			}
			if (changed) persist();
		},
		persist
	};
}
//#endregion
//#region src/inbound/transport.ts
function msgTypeOf(type) {
	switch (type) {
		case "text": return "text";
		case "post": return "post";
		case "image": return "image";
		case "file": return "file";
		case "audio": return "audio";
		case "interactive": return "interactive";
		default: return "unknown";
	}
}
function pickText(contentRaw, msgType) {
	if (!contentRaw) return void 0;
	try {
		const parsed = JSON.parse(contentRaw);
		if (typeof parsed.text === "string") return parsed.text;
		if (msgType === "post") {
			const content = parsed.content;
			if (content?.paragraphs) return content.paragraphs.map((p) => (p.elements ?? []).map((e) => e.text_run?.content ?? "").join("")).join("\n");
			if (Array.isArray(parsed.content)) {
				const text = parsed.content.map((line) => (Array.isArray(line) ? line : [line]).map((e) => {
					const el = e;
					return el?.tag === "text" && typeof el.text === "string" ? el.text : "";
				}).join("")).filter((l) => l.trim().length > 0).join("\n");
				if (text.trim()) return text;
			}
		}
		if (typeof parsed.content === "string") return parsed.content;
	} catch {
		return contentRaw;
	}
}
function chatModeFor(opts) {
	if (opts.chatType === "p2p") return "p2p";
	if (opts.groupPolicy === "open") return "group_at";
	if (opts.groupPolicy === "mention") return opts.mentionedBot ? "group_at" : "group_all";
	return "group_at";
}
/**
* Normalize a raw Feishu event (any shape) into a FeishuInboundMessage.
* Returns undefined when the event is not a message we should process
* (e.g. non-message events, missing ids).
*/
function normalizeInbound(raw, opts = {}) {
	const msg = raw.message ?? raw;
	const messageId = msg.message_id ?? raw.message_id;
	const chatId = msg.chat_id ?? raw.chat_id;
	if (!messageId || !chatId) return void 0;
	const chatType = (msg.chat_type ?? raw.chat_type ?? "p2p") === "group" ? "group" : "p2p";
	const msgType = msgTypeOf(msg.message_type ?? raw.message_type);
	const senderOpenId = raw.sender?.sender_id?.open_id ?? raw.operator?.operator_id?.open_id ?? "unknown";
	const senderName = String(raw.sender?.sender_name ?? raw.sender?.name ?? "").trim();
	const mentions = (msg.mentions ?? []).map((m) => m.id?.open_id ?? m.id?.user_id ?? m.name ?? "").filter(Boolean);
	return {
		messageId,
		chatId,
		chatType,
		chatMode: chatModeFor({
			chatType,
			mentionedBot: opts.mentionedBot ?? (opts.botOpenId !== void 0 ? mentions.includes(opts.botOpenId) : mentions.length > 0),
			groupPolicy: opts.groupPolicy ?? (chatType === "group" ? "mention" : "open")
		}),
		senderOpenId,
		...senderName ? { senderName } : {},
		msgType,
		content: msg.content ?? raw.content ?? "",
		text: msgType === "image" ? "[图片]" : msgType === "file" ? "[文件]" : pickText(msg.content ?? raw.content, msgType),
		rootId: msg.root_id ?? raw.root_id,
		parentId: msg.parent_id ?? raw.parent_id,
		threadId: msg.thread_id ?? raw.thread_id,
		mentions,
		timestamp: Number(msg.create_time ?? raw.create_time ?? Date.now())
	};
}
/** Event name constants. */
const EVENT_MESSAGE = "im.message.receive_v1";
const EVENT_CARD_ACTION = "card.action.trigger";
function createTransport(deps) {
	let started = false;
	let wsReadyFlag = false;
	let botOpenId;
	const normalize = deps.normalize ?? normalizeInbound;
	const client = () => deps.getClient();
	async function handleEvent(event, data) {
		deps.onEvent?.(event, data);
		if (event !== "im.message.receive_v1") return;
		const msg = normalize(data, { botOpenId });
		if (!msg) return;
		try {
			await deps.onMessage(msg);
		} catch (err) {
			deps.logger?.error(`onMessage failed: ${String(err)}`);
		}
	}
	return {
		async start() {
			if (started) return;
			started = true;
			const c = client();
			if (c.on) {
				c.on(EVENT_MESSAGE, (data) => void handleEvent(EVENT_MESSAGE, data));
				c.on(EVENT_CARD_ACTION, (data) => void handleEvent(EVENT_CARD_ACTION, data));
			}
			try {
				botOpenId = (await c.getBotInfo?.())?.open_id;
			} catch {}
			try {
				await c.ws?.start?.();
				wsReadyFlag = true;
			} catch (err) {
				deps.logger?.error(`ws start failed: ${String(err)}`);
				wsReadyFlag = false;
			}
		},
		async stop() {
			started = false;
			wsReadyFlag = false;
			try {
				await client().ws?.stop?.();
			} catch {}
		},
		isConnected: () => started && wsReadyFlag,
		wsReady: () => wsReadyFlag,
		async probe() {
			try {
				const bot = await client().getBotInfo?.();
				if (bot?.open_id) botOpenId = bot.open_id;
				return true;
			} catch {
				return false;
			}
		},
		botOpenId: () => botOpenId,
		async downloadResource(params) {
			const c = client();
			if (!c.downloadResource) throw new Error("lark client does not support downloadResource");
			return c.downloadResource(params);
		}
	};
}
/**
* Extract an upload key from a Feishu SDK upload response, tolerating BOTH
* the real top-level shape ({file_key}) and the legacy nested shape
* ({data:{file_key}}) — pi-feishu-link 2026-08-14 real-SDK fix.
*/
function extractUploadKey(res, key) {
	if (!res || typeof res !== "object") return void 0;
	const r = res;
	const direct = r[key];
	if (typeof direct === "string" && direct.length > 0) return direct;
	const nested = r.data?.[key];
	return typeof nested === "string" && nested.length > 0 ? nested : void 0;
}
//#endregion
//#region src/inbound/connection-supervisor.ts
const sleep$1 = (ms) => new Promise((r) => {
	setTimeout(r, ms).unref?.();
});
function createConnectionSupervisor(deps) {
	const now = deps.now ?? Date.now;
	let state = "idle";
	let timer;
	let stopped = false;
	let probeFailStreak = 0;
	let reconnectAttempts = 0;
	const setState = (s, detail) => {
		state = s;
		deps.status.setConn(s, detail ? { lastError: detail } : {});
		deps.onStateChange?.(s, detail);
		if (detail) deps.logger?.warn(`conn -> ${s}: ${detail}`);
		else deps.logger?.info(`conn -> ${s}`);
	};
	async function ensureConnected() {
		if (stopped) return;
		if (deps.transport.isConnected()) {
			if (state !== "connected") setState("connected");
			return;
		}
		if (state === "quarantined") return;
		if (deps.quota.tripped()) {
			setState("quarantined", `quota breaker tripped (${deps.cfg.quotaLimit}/${deps.cfg.quotaWindowMinutes}min); retry after reset`);
			return;
		}
		if (reconnectAttempts >= deps.cfg.maxReconnectAttempts) {
			deps.quota.recordFailure();
			setState("quarantined", `reconnect attempts exhausted (${reconnectAttempts}); circuit breaker armed`);
			return;
		}
		setState("connecting");
		deps.quota.recordConnect();
		try {
			await deps.transport.start();
		} catch (err) {
			deps.logger?.error(`transport.start threw: ${String(err)}`);
		}
		if (deps.transport.isConnected()) {
			reconnectAttempts = 0;
			probeFailStreak = 0;
			setState("connected");
		} else {
			reconnectAttempts++;
			deps.quota.recordFailure();
			if (deps.quota.tripped()) {
				setState("quarantined", `quota breaker tripped after ${reconnectAttempts} failed connects`);
				return;
			}
			setState("reconnecting", `connect failed (attempt ${reconnectAttempts}/${deps.cfg.maxReconnectAttempts})`);
		}
	}
	async function tick() {
		if (stopped) return;
		if (state === "quarantined") {
			const liftAt = deps.quota.resetAt();
			if (liftAt === void 0 || now() >= liftAt) {
				deps.logger?.info("quota window reset — auto-recovering from quarantine");
				deps.quota.reset();
				reconnectAttempts = 0;
				if (state === "quarantined") state = "reconnecting";
				await ensureConnected();
			}
			return;
		}
		let ok = false;
		try {
			ok = await Promise.race([deps.transport.probe(), sleep$1(deps.cfg.probeTimeoutMs).then(() => false)]);
		} catch {
			ok = false;
		}
		deps.status.update({
			lastProbeAt: now(),
			lastProbeOk: ok,
			wsReady: deps.transport.wsReady()
		});
		if (ok) {
			probeFailStreak = 0;
			if (!deps.transport.isConnected()) {
				reconnectAttempts = 0;
				await ensureConnected();
			} else if (state !== "connected") setState("connected");
			return;
		}
		probeFailStreak++;
		if (probeFailStreak >= deps.cfg.probeFailThreshold) {
			if (deps.transport.isConnected()) setState("degraded", `probe failed ${probeFailStreak}x`);
			await ensureConnected();
		}
	}
	return {
		async start() {
			stopped = false;
			setState("connecting");
			await ensureConnected();
			timer = setInterval(() => void tick(), deps.cfg.probeIntervalMs);
			timer.unref?.();
		},
		async stop() {
			stopped = true;
			if (timer) clearInterval(timer);
			await deps.transport.stop();
			setState("stopped");
		},
		async tick() {
			await tick();
		},
		state: () => state,
		async reconnect() {
			reconnectAttempts = 0;
			deps.quota.reset();
			await deps.transport.stop();
			await ensureConnected();
		}
	};
}
//#endregion
//#region src/inbound/missed-compensation.ts
/** Replay window: pull messages from the last N minutes of disconnection. */
const REPLAY_WINDOW_MS = 6e5;
function createMissedCompensation(deps) {
	const now = deps.now ?? Date.now;
	const delivered = /* @__PURE__ */ new Set();
	const maxTracked = 5e3;
	return {
		noteDelivered(messageId) {
			delivered.add(messageId);
			if (delivered.size > maxTracked) {
				const arr = [...delivered];
				delivered.clear();
				for (const id of arr.slice(-2500)) delivered.add(id);
			}
		},
		async onRecovered() {
			const until = now();
			const since = until - REPLAY_WINDOW_MS;
			let pulled = 0;
			for (const route of deps.routes.all()) try {
				const items = await deps.listMessages({
					chatId: route.chatId,
					startTimeMs: since,
					endTimeMs: until
				});
				for (const item of items) {
					if (delivered.has(item.messageId)) continue;
					deps.reinject({
						messageId: item.messageId,
						chatId: route.chatId,
						chatType: route.chatType,
						chatMode: route.chatType === "p2p" ? "p2p" : "group_at",
						senderOpenId: "unknown",
						msgType: "text",
						content: "",
						text: "",
						mentions: [],
						timestamp: item.timestampMs
					});
					delivered.add(item.messageId);
					pulled++;
				}
			} catch (err) {
				deps.logger?.warn(`compensation listMessages failed for ${route.chatId}: ${String(err)}`);
			}
			if (pulled > 0) deps.logger?.info(`compensation re-injected ${pulled} missed messages`);
		}
	};
}
//#endregion
//#region src/inbound/group-trigger.ts
function createGroupTrigger(deps) {
	return { shouldTrigger(msg) {
		if (msg.chatType !== "group") return true;
		const { policy, keywords, alsoOnReply } = deps.cfg();
		const botOpenId = deps.botOpenId?.();
		const isReplyToBot = msg.parentId !== void 0 || msg.rootId !== void 0;
		switch (policy) {
			case "open": return true;
			case "mention":
				if (botOpenId !== void 0 && msg.mentions.includes(botOpenId)) return true;
				if (msg.mentions.length > 0 || msg.chatMode === "group_at") return true;
				return alsoOnReply && isReplyToBot;
			case "keywords":
				if (keywords.some((k) => (msg.text ?? "").includes(k))) return true;
				return alsoOnReply && isReplyToBot;
			case "reply": return isReplyToBot;
			default: return false;
		}
	} };
}
//#endregion
//#region src/application/bridge-context.ts
function createBridgeContext(deps) {
	let _conversations;
	let _transport;
	let _outbox;
	let _forwarder;
	let _compensation;
	let _botOpenId;
	let _started = false;
	return {
		get conversations() {
			return _conversations;
		},
		setConversations(v) {
			_conversations = v;
		},
		get backend() {
			return deps.backend;
		},
		get transport() {
			return _transport;
		},
		setTransport(v) {
			_transport = v;
		},
		get outbox() {
			return _outbox;
		},
		setOutbox(v) {
			_outbox = v;
		},
		get router() {
			return deps.router;
		},
		get forwarder() {
			return _forwarder;
		},
		setForwarder(v) {
			_forwarder = v;
		},
		get compensation() {
			return _compensation;
		},
		setCompensation(v) {
			_compensation = v;
		},
		get sender() {
			return deps.sender;
		},
		get attachments() {
			return deps.attachmentsRef?.();
		},
		get logger() {
			return deps.logger;
		},
		get cfg() {
			return deps.cfg;
		},
		get configStore() {
			return deps.configStore;
		},
		get status() {
			return deps.status;
		},
		botOpenId: () => _botOpenId,
		setBotOpenId(v) {
			_botOpenId = v;
		},
		started: () => _started,
		setStarted(v) {
			_started = v;
		},
		conversationKeyFor: (msg) => msg.chatType === "p2p" ? `dm:${msg.chatId}` : `group:${msg.chatId}`,
		routeFor(key) {
			return deps.router?.get(key);
		},
		async markDone(key, triggerMessageId) {
			if (!triggerMessageId || !deps.sender) return;
			const doneEmoji = resolveReactions(deps.cfg().reactions).done;
			deps.logger.info(`markDone: ${key} -> ${triggerMessageId} (${doneEmoji})`);
			try {
				await deps.sender.addReaction(triggerMessageId, doneEmoji);
			} catch (err) {
				deps.logger.warn(`markDone reaction failed for ${key}: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
		async markError(key, triggerMessageId) {
			if (!triggerMessageId || !deps.sender) return;
			const errorEmoji = resolveReactions(deps.cfg().reactions).error;
			deps.logger.info(`markError: ${key} -> ${triggerMessageId} (${errorEmoji})`);
			try {
				await deps.sender.addReaction(triggerMessageId, errorEmoji);
			} catch (err) {
				deps.logger.warn(`markError reaction failed for ${key}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	};
}
//#endregion
//#region src/application/message-handler.ts
/**
* Make a user-provided filename safe on EVERY platform we may run on
* (Linux/macOS/Windows — the bridge is cross-platform by design):
* - Windows forbids <>:"/\\|?* and trailing dots/spaces;
* - control characters confuse shells and terminals everywhere;
* - macOS screenshot names contain ":" (invalid on Windows) — a file written
*   with such a name on one OS becomes unreadable/unmovable when the state
*   dir lives on a share synced to another.
* CJK/unicode content itself is kept; only separators/reserved chars go.
*/
function sanitizeAttachmentName(name) {
	const trimmed = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]$/, "_").slice(0, 200);
	return trimmed.length > 0 ? trimmed : "feishu-attachment";
}
/** Sniff image media type from magic bytes (feishu im resources are raw). */
function sniffImageType(buf) {
	if (buf.length >= 8 && buf[0] === 137 && buf[1] === 80) return "image/png";
	if (buf.length >= 3 && buf[0] === 255 && buf[1] === 216) return "image/jpeg";
	if (buf.length >= 12 && buf.slice(0, 4).every((b, i) => b === [
		82,
		73,
		70,
		70
	][i]) && buf.slice(8, 12).every((b, i) => b === [
		87,
		69,
		66,
		80
	][i])) return "image/webp";
	if (buf.length >= 6 && buf[0] === 71 && buf[1] === 73) return "image/gif";
	return "image/png";
}
/** File extension (including dot) for an image media type. */
function imgExt(m) {
	switch (m) {
		case "image/png": return ".png";
		case "image/webp": return ".webp";
		case "image/gif": return ".gif";
		default: return ".jpg";
	}
}
/**
* Resolve inbound Feishu attachments (M6): image → download → attachment
* store (ImageBlock for the visual model); file → download → bounded text
* extraction. Post (rich text) messages carry images INLINE as
* `{tag:"img", image_key}` elements — every one is extracted and resolved.
* Failures degrade to text-only (never drop the message).
*/
async function resolveInboundAttachments(msg, ctx, inboundDir) {
	const out = [];
	if (!msg.messageId) return out;
	try {
		if (msg.msgType === "post") {
			const parsed = JSON.parse(msg.content ?? "{}");
			const keys = [];
			const pushImgKeys = (elements) => {
				if (!Array.isArray(elements)) return;
				for (const e of elements) {
					const el = e;
					if (el?.tag === "img" && typeof el.image_key === "string") keys.push(el.image_key);
				}
			};
			const content = parsed.content;
			const paragraphs = content?.paragraphs;
			if (Array.isArray(paragraphs)) for (const p of paragraphs) pushImgKeys(p?.elements);
			else if (Array.isArray(content)) for (const line of content) if (Array.isArray(line)) pushImgKeys(line);
			else pushImgKeys([line]);
			const unique = [...new Set(keys)];
			for (const key of unique) {
				const one = await resolveOneImage(msg, ctx, inboundDir, key);
				if (one) out.push(one);
			}
			return out;
		}
		if (msg.msgType === "image") {
			const parsed = JSON.parse(msg.content ?? "{}");
			if (parsed.image_key) {
				const one = await resolveOneImage(msg, ctx, inboundDir, parsed.image_key);
				if (one) out.push(one);
			}
		} else if (msg.msgType === "file") {
			const parsed = JSON.parse(msg.content ?? "{}");
			const key = parsed.file_key;
			const name = parsed.file_name ?? "附件";
			if (key && ctx.transport) {
				const buf = await ctx.transport.downloadResource({
					messageId: msg.messageId,
					fileKey: key,
					type: "file"
				});
				if (buf && buf.length > 0) {
					let localPath;
					if (inboundDir) try {
						mkdirSync(join(inboundDir, "media"), { recursive: true });
						const path = join(inboundDir, "media", `feishu-${sanitizeAttachmentName(msg.messageId)}-${Date.now()}-${sanitizeAttachmentName(name)}`);
						writeFileSync(path, buf);
						localPath = path;
					} catch (err) {
						ctx.logger.warn(`inbound file persist failed: ${err instanceof Error ? err.message : String(err)}`);
					}
					out.push({
						path: localPath ?? "feishu://file",
						kind: "file",
						name
					});
					if (buf.length <= 15e4) {
						const text = buf.toString("utf8");
						if (text && !text.includes("�")) out.push({
							path: "feishu://file-text",
							kind: "file",
							name: `${name} 内容提取`,
							textPreview: text
						});
					}
				}
			}
		}
	} catch (err) {
		ctx.logger.warn(`inbound attachment resolve failed: ${err instanceof Error ? err.message : String(err)}`);
	}
	return out;
}
/**
* Shared per-image resolution (image message + post-embedded img elements):
* download → persist a real local file → save into the DSH attachment store
* (ImageBlock ref). Returns undefined on any failure (degrade, never drop).
*/
async function resolveOneImage(msg, ctx, inboundDir, imageKey) {
	if (!ctx.transport) return void 0;
	const buf = await ctx.transport.downloadResource({
		messageId: msg.messageId,
		fileKey: imageKey,
		type: "image"
	});
	if (!buf || buf.length === 0) return void 0;
	let localPath;
	if (inboundDir) try {
		const ext = imgExt(sniffImageType(buf));
		const name = `feishu-${sanitizeAttachmentName(msg.messageId)}-${sanitizeAttachmentName(imageKey.slice(-8))}${ext}`;
		mkdirSync(join(inboundDir, "media"), { recursive: true });
		const path = join(inboundDir, "media", name);
		writeFileSync(path, buf);
		localPath = path;
	} catch (err) {
		ctx.logger.warn(`inbound image persist failed: ${err instanceof Error ? err.message : String(err)}`);
	}
	const attach = {
		path: localPath ?? "feishu://image",
		kind: "image",
		name: localPath ?? "feishu-image"
	};
	const store = ctx.attachments;
	if (store?.saveImage) try {
		attach.imageRef = await store.saveImage({
			data: buf,
			mediaType: sniffImageType(buf),
			name: attach.name
		});
	} catch (err) {
		ctx.logger.warn(`inbound image saveImage failed: ${err instanceof Error ? err.message : String(err)}`);
	}
	return attach;
}
function createMessageHandler(deps) {
	const logger = deps.ctx.logger;
	async function handle(msg, compensated) {
		if (!compensated && !deps.dedupe.add(msg.messageId)) {
			logger.info(`drop: duplicate ${msg.messageId}`);
			return "dropped";
		}
		const allowlist = deps.allowlist();
		if (allowlist.length > 0 && !allowlist.includes(msg.senderOpenId)) {
			logger.info(`drop: sender ${msg.senderOpenId} not in allowlist`);
			return "dropped";
		}
		if (!deps.groupTrigger.shouldTrigger(msg)) {
			logger.info(`drop: group policy for ${msg.chatId}`);
			return "dropped";
		}
		if (!compensated) deps.usage?.recordInbound(deps.ctx.conversations?.keyFor(msg) ?? `${msg.chatType}:${msg.chatId}`, msg);
		const reactions = resolveReactions(deps.ctx.cfg().reactions);
		if (deps.ctx.cfg().reactions.enabled && reactions.receipt) try {
			await deps.ctx.sender?.addReaction(msg.messageId, reactions.receipt);
		} catch {
			logger.warn(`receipt reaction failed for ${msg.messageId}`);
		}
		if (await deps.commands.route(msg) === "agent") {
			const cm = deps.ctx.conversations;
			if (!cm) {
				logger.error("message dropped: conversations not assembled (late wiring?)");
				return "dropped";
			}
			const sessionKey = cm.keyFor(msg);
			deps.ctx.router?.upsert({
				sessionKey,
				chatId: msg.chatId,
				chatType: msg.chatType,
				senderOpenId: msg.senderOpenId,
				...msg.senderName ? { senderName: msg.senderName } : {},
				lastMessageId: msg.messageId,
				updatedAt: Date.now()
			});
			const attachments = await resolveInboundAttachments(msg, deps.ctx, deps.inboundDir);
			if ((msg.msgType === "text" || (msg.text ?? "").trim() !== "") && !compensated && deps.wal) try {
				deps.wal.accept({
					messageId: msg.messageId,
					sessionKey,
					chatId: msg.chatId,
					chatType: msg.chatType,
					senderOpenId: msg.senderOpenId,
					text: (msg.text ?? msg.content ?? "").slice(0, 8e3)
				});
				deps.ctx.status.refreshCounters({
					inboundPending: deps.wal.pendingReplays().length,
					inboundFailed: deps.wal.failedCount()
				});
			} catch (err) {
				logger.warn(`inbound-wal accept failed: ${err instanceof Error ? err.message : String(err)}`);
			}
			try {
				await cm.handleMessage(msg, attachments);
				deps.ctx.status.update({ sessions: cm.size() });
			} catch (err) {
				logger.error(`conversation handling failed: ${String(err)}`);
				return "dropped";
			}
		}
		if (compensated) deps.onReinjected?.(msg);
		return "processed";
	}
	return {
		async handleInbound(msg) {
			return handle(msg, false);
		},
		async handleCompensated(msg) {
			await handle(msg, true);
		}
	};
}
//#endregion
//#region src/application/media-retention.ts
/**
* Delete files under `mediaDir` whose mtime is older than
* `retentionHours`. Missing directory / unreadable entries are no-ops so
* the sweeper can never take the bridge down.
*/
function sweepMediaDir(mediaDir, retentionHours, now = Date.now()) {
	if (!(retentionHours > 0)) return {
		deleted: 0,
		errors: 0
	};
	let entries;
	try {
		entries = readdirSync(mediaDir);
	} catch {
		return {
			deleted: 0,
			errors: 0
		};
	}
	const cutoff = now - retentionHours * 36e5;
	let deleted = 0;
	let errors = 0;
	for (const name of entries) {
		const p = join(mediaDir, name);
		try {
			const st = statSync(p);
			if (st.isFile() && st.mtimeMs < cutoff) {
				rmSync(p, {
					force: true,
					maxRetries: 3,
					retryDelay: 100
				});
				deleted++;
			}
		} catch {
			errors++;
		}
	}
	return {
		deleted,
		errors
	};
}
/**
* Start the media retention sweeper: one sweep IMMEDIATELY (clears stale
* files from previous runs — the temp dir survives restarts) and then every
* `intervalMs` (default: hourly). `retentionHours` is a live getter so
* `/lark-config attachments.retentionHours=<n>` applies without a reload.
* Returns a stop function (wired into the Cordis ctx.effect disposer).
*/
function startMediaSweeper(opts) {
	const run = () => {
		try {
			const r = sweepMediaDir(opts.mediaDir, opts.retentionHours());
			if (r.deleted > 0) opts.logger?.info?.(`media sweep: removed ${r.deleted} expired file(s) under ${opts.mediaDir}`);
			if (r.errors > 0) opts.logger?.warn?.(`media sweep: ${r.errors} entr(y/ies) failed under ${opts.mediaDir}`);
		} catch (err) {
			opts.logger?.warn?.(`media sweep failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	};
	run();
	const timer = setInterval(run, opts.intervalMs ?? 36e5);
	timer.unref?.();
	return () => clearInterval(timer);
}
//#endregion
//#region src/application/user-usage.ts
function createUserUsageStore(file, now = Date.now) {
	let records = {};
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		if (parsed && typeof parsed === "object") records = parsed;
	} catch {
		records = {};
	}
	const persist = () => {
		writeFileSync(file, JSON.stringify(records, null, 2), { mode: 384 });
	};
	return {
		recordInbound(sessionKey, message) {
			const at = now();
			const previous = records[sessionKey];
			records[sessionKey] = {
				sessionKey,
				chatId: message.chatId,
				chatType: message.chatType,
				senderOpenId: message.senderOpenId,
				...message.senderName ? { senderName: message.senderName } : {},
				inboundMessages: (previous?.inboundMessages ?? 0) + 1,
				firstSeenAt: previous?.firstSeenAt ?? at,
				lastSeenAt: at
			};
			persist();
		},
		list: () => Object.values(records).map((record) => ({ ...record })).sort((left, right) => right.lastSeenAt - left.lastSeenAt),
		clear() {
			records = {};
			persist();
		}
	};
}
//#endregion
//#region src/application/model-access.ts
/** Split at the first slash; model ids may themselves contain slashes. */
function parseModelRef(value) {
	const text = value.trim();
	const slash = text.indexOf("/");
	if (slash <= 0 || slash === text.length - 1) return void 0;
	const provider = text.slice(0, slash).trim();
	const model = text.slice(slash + 1).trim();
	return provider && model ? {
		provider,
		model
	} : void 0;
}
function modelRef(selection) {
	return `${selection.provider}/${selection.model}`;
}
function isModelAllowed(policy, selection) {
	if (!policy.restricted) return true;
	const ref = typeof selection === "string" ? selection : modelRef(selection);
	return policy.allowedModels.includes(ref);
}
/**
* Resolve the app's effective default without ever escaping its allowlist.
* A corrupt/stale restricted policy with no usable model deliberately yields
* undefined rather than silently falling back to a host-paid model.
*/
function pickEffectiveDefault(policy, hostDefault) {
	const configured = parseModelRef(policy.defaultModel);
	if (configured && isModelAllowed(policy, configured)) return configured;
	if (hostDefault && isModelAllowed(policy, hostDefault)) return hostDefault;
	if (policy.restricted) for (const ref of policy.allowedModels) {
		const parsed = parseModelRef(ref);
		if (parsed) return parsed;
	}
	return hostDefault;
}
function normalizeModelRefs(values) {
	if (!Array.isArray(values)) return [];
	return Array.from(new Set(values.map((value) => parseModelRef(String(value))).filter((value) => Boolean(value)).map(modelRef)));
}
//#endregion
//#region src/application/status-formatter.ts
function formatStatusLine(s) {
	const parts = [
		`连接: ${s.connState.toUpperCase()}${s.wsReady ? " (WS)" : ""}`,
		`outbox: ${s.outboxPending} 待发 / ${s.outboxFailed} 失败`,
		`会话: ${s.sessions}`
	];
	if (s.inboundPending > 0) parts.push(`补发: ${s.inboundPending} 条未完成`);
	if (s.inboundFailed > 0) parts.push(`补发失败: ${s.inboundFailed} 条`);
	if (s.quarantinedUntil) {
		const mins = Math.ceil((s.quarantinedUntil - Date.now()) / 6e4);
		parts.push(`熔断: ${Math.max(0, mins)}min 后重试`);
	}
	if (s.lastError) parts.push(`最近错误: ${s.lastError}`);
	return parts.join(" · ");
}
function statusDetailLines(s) {
	const lines = [
		`状态: ${s.connState}`,
		`WS 就绪: ${s.wsReady}`,
		`上次探活: ${s.lastProbeAt ? new Date(s.lastProbeAt).toISOString() : "—"} (${s.lastProbeOk === void 0 ? "?" : s.lastProbeOk ? "正常" : "失败"})`,
		`outbox 待发: ${s.outboxPending}`,
		`outbox 失败: ${s.outboxFailed}`,
		`入站补发待处理: ${s.inboundPending}`,
		`入站补发失败: ${s.inboundFailed}`,
		`活跃会话: ${s.sessions}`
	];
	if (s.connectedAt) lines.push(`连接时间: ${new Date(s.connectedAt).toISOString()}`);
	if (s.quarantinedUntil) lines.push(`熔断至: ${new Date(s.quarantinedUntil).toISOString()} (${s.quarantinedReason ?? ""})`);
	if (s.owner) lines.push(`持有者: pid ${s.owner.pid} @ ${s.owner.host} (${new Date(s.owner.startedAt).toISOString()})`);
	return lines;
}
/** Mask secrets in a diagnostics dump (config/credentials redaction). */
function redactSecrets(input, secrets) {
	let out = input;
	for (const secret of secrets) {
		if (!secret) continue;
		out = out.split(secret).join("***");
	}
	out = out.replace(/\b[0-9A-Za-z_\-]{32,}\b/g, "***");
	return out;
}
//#endregion
//#region src/application/diagnostics-service.ts
function createDiagnosticsService(deps) {
	return { async build() {
		const s = deps.ctx.status.get();
		const cfg = deps.ctx.cfg();
		const lines = [
			"# dsh-lark-link 诊断包",
			"",
			`生成时间: ${(/* @__PURE__ */ new Date()).toISOString()}`,
			`桥状态: ${deps.ctx.started() ? "运行中" : "未启动"}`,
			...statusDetailLines(s),
			"",
			"## 配置（脱敏）",
			"```json",
			redactSecrets(JSON.stringify(cfg, null, 2), deps.secrets),
			"```"
		];
		if (deps.extra) lines.push("", "## 附加信息", "```json", JSON.stringify(deps.extra, null, 2), "```");
		const issueMd = [
			"## 问题描述",
			"",
			"（请填写：现象 / 复现步骤 / 期望结果）",
			"",
			"## 诊断信息",
			"```",
			...lines,
			"```",
			"",
			"## 环境",
			"- dsh-lark-link: 0.1.0",
			"- Node: " + process.version
		].join("\n");
		return {
			text: lines.join("\n"),
			issueMd
		};
	} };
}
//#endregion
//#region src/common/connection-status.ts
function createStatusStore(file, now = Date.now) {
	let status = {
		connState: "idle",
		outboxPending: 0,
		outboxFailed: 0,
		inboundPending: 0,
		inboundFailed: 0,
		sessions: 0,
		wsReady: false
	};
	if (file) try {
		const raw = readFileSync(file, "utf8");
		status = {
			...status,
			...JSON.parse(raw)
		};
	} catch {}
	const persist = () => {
		if (!file) return;
		try {
			writeFileSync(file, JSON.stringify(status, null, 2), { mode: 384 });
		} catch {}
	};
	return {
		get: () => ({ ...status }),
		update(patch) {
			status = {
				...status,
				...patch
			};
			persist();
			return this.get();
		},
		setConn(state, extra) {
			const patch = {
				connState: state,
				...extra
			};
			if (state === "connected") patch.connectedAt = now();
			status = {
				...status,
				...patch
			};
			persist();
			return this.get();
		},
		refreshCounters(counters) {
			status = {
				...status,
				...counters
			};
			persist();
		}
	};
}
//#endregion
//#region src/common/config.ts
const DEFAULT_CONFIG = {
	credentialRef: "LARK_LINK_APP",
	groupPolicy: "open",
	groupKeywords: ["lark", "小斯"],
	alsoOnReply: true,
	streaming: {
		enabled: true,
		printFrequencyMs: 120,
		printStep: 3
	},
	reactions: {
		enabled: true,
		receipt: "OnIt",
		done: "DONE",
		error: "ERROR"
	},
	attachments: {
		dir: "",
		retentionHours: 168
	},
	outbox: {
		maxAttempts: 50,
		backoffMaxMs: 6e4,
		retainDays: 7,
		pendingCap: 1e4,
		blobThreshold: 24e3
	},
	supervisor: {
		probeIntervalMs: 3e4,
		probeTimeoutMs: 8e3,
		probeFailThreshold: 3,
		maxReconnectAttempts: 8,
		idleKeepaliveMs: 12e5
	},
	quota: {
		windowMinutes: 60,
		limit: 12
	},
	denyList: [],
	sessionIdleTtlMs: 18e5,
	maxSessions: 32,
	allowlist: [],
	workspaceRoot: "",
	workspaceIsolation: true,
	modelAccess: {
		restricted: false,
		allowedModels: [],
		defaultModel: ""
	},
	agentPreset: "code",
	permissionMode: "danger-full-access"
};
/** Keys that may be hot-reloaded via /lark-config (whitelist, never credentials). */
const HOT_RELOADABLE = [
	"groupPolicy",
	"groupKeywords",
	"alsoOnReply",
	"workspaceRoot",
	"workspaceIsolation",
	"agentPreset",
	"permissionMode",
	"streaming",
	"reactions",
	"denyList",
	"allowlist",
	"attachments"
];
/**
* Parse a /lark-config key path into a hot-reload patch.
*
* Accepts BOTH top-level keys ("denyList") and dotted paths under
* object-valued whitelist keys ("streaming.enabled", "streaming.printStep") —
* the dotted form is what users naturally type for the streaming knobs and
* used to be rejected with 不可热改 because only the exact top-level names
* were matched. Unknown top-level segments and unknown/over-deep nested keys
* throw so typos never silently no-op.
*/
function buildHotReloadPatch(key, value) {
	const segments = key.split(".").filter((s) => s !== "");
	if (segments.length === 0) throw new Error(`config key "${key}" is not hot-reloadable`);
	const head = segments[0];
	const rest = segments.slice(1);
	if (!HOT_RELOADABLE.includes(head)) throw new Error(`config key "${head}" is not hot-reloadable`);
	if (rest.length === 0) return { [head]: value };
	if (rest.length > 1) throw new Error(`config key "${key}" is unknown (FeishuConfig nests one level deep)`);
	const nested = DEFAULT_CONFIG[head];
	const nestedKey = rest[0];
	if (typeof nested !== "object" || nested === null || Array.isArray(nested) || !(nestedKey in nested)) throw new Error(`config key "${key}" is unknown (not a configurable nested key)`);
	return { [head]: { [nestedKey]: value } };
}
function deepMerge(base, over) {
	const out = { ...base };
	for (const [k, v] of Object.entries(over ?? {})) {
		if (v === void 0) continue;
		const existing = out[k];
		if (existing !== null && v !== null && typeof existing === "object" && typeof v === "object" && !Array.isArray(existing) && !Array.isArray(v)) out[k] = deepMerge(existing, v);
		else out[k] = v;
	}
	return out;
}
function createConfigStore(stateDir, initialOverrides) {
	const overridesPath = join(stateDir, "runtime-overrides.json");
	mkdirSync(dirname(overridesPath), { recursive: true });
	let overrides = { ...initialOverrides ?? {} };
	try {
		const raw = readFileSync(overridesPath, "utf8");
		const parsed = JSON.parse(raw);
		overrides = deepMerge(overrides, parsed);
	} catch {}
	const get = () => deepMerge(DEFAULT_CONFIG, overrides);
	const persist = (file, data) => {
		try {
			writeFileSync(file, JSON.stringify(data, null, 2), { mode: 384 });
		} catch {}
	};
	return {
		get,
		update(partial) {
			for (const key of Object.keys(partial)) if (!HOT_RELOADABLE.includes(key)) throw new Error(`config key "${key}" is not hot-reloadable`);
			overrides = deepMerge(overrides, partial);
			return get();
		},
		updateManagementPolicy(partial) {
			overrides = deepMerge(overrides, partial);
			return get();
		},
		save() {
			persist(join(stateDir, "config.json"), get());
		},
		saveOverrides() {
			persist(overridesPath, overrides);
		},
		path: () => overridesPath
	};
}
//#endregion
//#region src/common/logger.ts
function createLogger(scope, minLevel = "info") {
	const levelRank = {
		debug: 0,
		info: 1,
		warn: 2,
		error: 3
	};
	const emit = (level, msg, meta) => {
		if (levelRank[level] < levelRank[minLevel]) return;
		const line = `[${(/* @__PURE__ */ new Date()).toISOString()}] [${level.toUpperCase()}] [${scope}] ${msg}${meta ? ` ${JSON.stringify(meta)}` : ""}`;
		if (level === "error") process.stderr.write(line + "\n");
		else process.stdout.write(line + "\n");
	};
	return {
		debug: (m, meta) => emit("debug", m, meta),
		info: (m, meta) => emit("info", m, meta),
		warn: (m, meta) => emit("warn", m, meta),
		error: (m, meta) => emit("error", m, meta)
	};
}
//#endregion
//#region src/common/dedupe-store.ts
const MAX_RECORDS = 1e4;
function createDedupeStore(file, now = Date.now) {
	let records = [];
	try {
		const raw = readFileSync(file, "utf8");
		records = JSON.parse(raw).slice(-1e4);
	} catch {
		records = [];
	}
	const persist = () => {
		try {
			writeFileSync(file, JSON.stringify(records.slice(-1e4), null, 2), { mode: 384 });
		} catch {}
	};
	return {
		seen(messageId) {
			return records.some((r) => r.messageId === messageId);
		},
		add(messageId) {
			if (records.some((r) => r.messageId === messageId)) return false;
			records.push({
				messageId,
				at: now()
			});
			if (records.length > MAX_RECORDS) records = records.slice(-1e4);
			persist();
			return true;
		},
		prune(ttlMs) {
			const cutoff = now() - ttlMs;
			const before = records.length;
			records = records.filter((r) => r.at >= cutoff);
			if (records.length !== before) persist();
		},
		clear() {
			records = [];
			persist();
		}
	};
}
//#endregion
//#region src/inbound/inbound-wal.ts
function createInboundWal(deps) {
	const dir = deps.dir;
	const replayRetentionMs = deps.replayRetentionMs ?? 18e5;
	const maxReplayAttempts = deps.maxReplayAttempts ?? 2;
	const now = deps.now ?? Date.now;
	mkdirSync(dir, { recursive: true });
	/** messageId -> record (bounded set; pruned over time). */
	const records = /* @__PURE__ */ new Map();
	function load() {
		let segs = [];
		try {
			segs = readdirSync(dir).filter((f) => /^seg-.*\.jsonl$/.test(f)).sort();
		} catch {
			segs = [];
		}
		for (const seg of segs) try {
			const lines = readFileSync(join(dir, seg), "utf8").split("\n").filter(Boolean);
			for (const line of lines) try {
				const rec = JSON.parse(line);
				if (rec?.messageId) records.set(rec.messageId, rec);
			} catch {}
		} catch {}
	}
	function persistAll() {
		try {
			const segFile = join(dir, `seg-${Date.now()}.jsonl`);
			const tmp = `${segFile}.tmp`;
			const lines = [...records.values()].map((r) => JSON.stringify(r));
			writeFileSync(tmp, lines.join("\n") + "\n", { mode: 384 });
			renameSync(tmp, segFile);
		} catch {}
	}
	function oldestUnresolved(sessionKey) {
		const rows = [...records.values()].filter((record) => record.sessionKey === sessionKey && record.state !== "delivered" && record.state !== "failed").sort((a, b) => a.acceptedAt - b.acceptedAt);
		let changed = false;
		while (rows[0] && now() - rows[0].acceptedAt > replayRetentionMs) {
			rows[0].state = "failed";
			rows.shift();
			changed = true;
		}
		if (changed) persistAll();
		return rows[0];
	}
	load();
	return {
		accept(rec) {
			const full = {
				...rec,
				acceptedAt: now(),
				attempts: 0,
				state: "accepted"
			};
			records.set(rec.messageId, full);
			persistAll();
			return full;
		},
		delivered(messageId) {
			const rec = records.get(messageId);
			if (!rec || rec.state === "delivered") return;
			rec.state = "delivered";
			persistAll();
		},
		deliveredOldest(sessionKey) {
			const rec = oldestUnresolved(sessionKey);
			if (!rec) return void 0;
			rec.state = "delivered";
			persistAll();
			return { ...rec };
		},
		fail(messageId) {
			const rec = records.get(messageId);
			if (!rec || rec.state === "delivered" || rec.state === "failed") return;
			rec.state = "failed";
			persistAll();
		},
		markReplay(messageId) {
			const rec = records.get(messageId);
			if (!rec) return false;
			if (rec.state === "delivered") return false;
			if (rec.attempts >= maxReplayAttempts) {
				if (rec.state !== "failed") {
					rec.state = "failed";
					persistAll();
				}
				return false;
			}
			if (now() - rec.acceptedAt > replayRetentionMs) return false;
			rec.attempts += 1;
			rec.state = "replayed";
			persistAll();
			return true;
		},
		pendingReplays() {
			const cutoff = now() - replayRetentionMs;
			return [...records.values()].filter((r) => r.state !== "delivered" && r.state !== "failed" && r.attempts < maxReplayAttempts && r.acceptedAt >= cutoff).sort((a, b) => a.acceptedAt - b.acceptedAt);
		},
		prune() {
			const deliveredCutoff = now() - replayRetentionMs;
			let changed = false;
			for (const [id, r] of records) {
				if (!(r.acceptedAt < deliveredCutoff)) continue;
				if (r.state === "delivered" || r.state === "failed" || r.attempts >= maxReplayAttempts) {
					records.delete(id);
					changed = true;
				} else {
					r.state = "failed";
					changed = true;
				}
			}
			if (changed) persistAll();
		},
		remove(messageId) {
			if (records.delete(messageId)) persistAll();
		},
		clear() {
			records.clear();
			try {
				for (const file of readdirSync(dir)) if (/^seg-.*\.jsonl$/.test(file)) rmSync(join(dir, file), { force: true });
			} catch {}
			persistAll();
		},
		failOldest(sessionKey) {
			const rec = oldestUnresolved(sessionKey);
			if (!rec) return void 0;
			rec.state = "failed";
			persistAll();
			return { ...rec };
		},
		failedCount: () => [...records.values()].filter((r) => r.state === "failed").length,
		pendingCount: () => records.size
	};
}
//#endregion
//#region src/inbound/replay-salvage.ts
/** Extract assistant text from a DSH session event's content blocks. */
function assistantTextOf(ev) {
	const e = ev;
	if (e?.type !== "assistant/message") return void 0;
	const blocks = e.data?.message?.content;
	if (!Array.isArray(blocks)) return void 0;
	return blocks.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("");
}
function createReplaySalvage(deps) {
	const salvaged = /* @__PURE__ */ new Set();
	return { async salvage(rec, sessionId) {
		if (!sessionId || salvaged.has(rec.messageId)) return false;
		let events;
		try {
			events = (await deps.loadSession(sessionId))?.events;
		} catch (err) {
			deps.logger?.warn(`replay-salvage: loadSession(${sessionId}) failed: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
		if (!events || events.length === 0) return false;
		for (let i = events.length - 1; i >= 0; i--) {
			const text = assistantTextOf(events[i]);
			if (text === void 0) continue;
			const time = events[i].time;
			if (typeof time !== "number" || time < rec.acceptedAt) return false;
			if (!text || text.trim() === "" || text === "No response.") return false;
			try {
				await deps.enqueue({
					dedupeKey: `wal-salvage:${rec.messageId}`,
					laneKey: rec.sessionKey,
					route: {
						sessionKey: rec.sessionKey,
						chatId: rec.chatId,
						chatType: rec.chatType
					},
					kind: "assistant-output",
					payload: {
						kind: "text",
						text
					}
				});
			} catch (err) {
				deps.logger?.warn(`replay-salvage: enqueue failed for ${rec.messageId}: ${err instanceof Error ? err.message : String(err)}`);
				return false;
			}
			salvaged.add(rec.messageId);
			deps.wal.delivered(rec.messageId);
			deps.logger?.info(`replay-salvage: answered ${rec.messageId} from session ${sessionId} (no agent re-run)`);
			return true;
		}
		return false;
	} };
}
//#endregion
//#region src/common/quota-governor.ts
function createQuotaGovernor(historyFile, opts = {
	windowMinutes: 60,
	limit: 12
}) {
	const now = opts.now ?? Date.now;
	const windowMs = opts.windowMinutes * 6e4;
	let history = [];
	try {
		history = readFileSync(historyFile, "utf8").split("\n").filter(Boolean).map((l) => {
			try {
				return JSON.parse(l);
			} catch {
				return;
			}
		}).filter((r) => r !== void 0);
	} catch {
		history = [];
	}
	const persist = () => {
		try {
			mkdirSync(join(historyFile, ".."), { recursive: true });
			writeFileSync(historyFile, history.slice(-500).map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 384 });
		} catch {}
	};
	const prune = () => {
		const cutoff = now() - windowMs;
		history = history.filter((r) => r.at >= cutoff);
	};
	return {
		recordConnect() {
			prune();
			history.push({
				at: now(),
				ok: true
			});
			persist();
			return history.length;
		},
		recordFailure() {
			prune();
			history.push({
				at: now(),
				ok: false
			});
			persist();
		},
		tripped() {
			prune();
			return history.filter((r) => !r.ok).length >= opts.limit;
		},
		remaining() {
			prune();
			return Math.max(0, opts.limit - history.filter((r) => !r.ok).length);
		},
		resetAt() {
			prune();
			const oldest = history.filter((r) => !r.ok)[0];
			return oldest ? oldest.at + windowMs : void 0;
		},
		reset() {
			history = [];
			persist();
		}
	};
}
//#endregion
//#region src/presentation/task-cards.ts
/**
* Generate a text-based progress bar, e.g. `[████░░░░░░░░░░░░] 25.0%`.
*/
function renderProgressBar(completed, total, width = 14) {
	if (total <= 0) return "[░░░░░░░░░░░░░░] 0.0%";
	const ratio = Math.min(1, Math.max(0, completed / total));
	const filled = Math.round(ratio * width);
	const empty = width - filled;
	return `\`[${"█".repeat(filled) + "░".repeat(empty)}]\` **${(ratio * 100).toFixed(1)}%** (${completed}/${total})`;
}
/**
* Format todo item lines with appropriate visual badges.
*/
function formatTodoList(todos, isFolded = true, maxFoldItems = 6) {
	if (todos.length === 0) return "*(暂无任务清单)*";
	const formatItem = (t, i) => {
		switch (t.status) {
			case "in_progress": return `🔵 **#${i + 1} ${t.content}** *(进行中)*`;
			case "completed": return `🟢 ~#${i + 1} ${t.content}~`;
			default: return `◌ #${i + 1} ${t.content}`;
		}
	};
	if (!isFolded || todos.length <= maxFoldItems) return todos.map((t, i) => formatItem(t, i)).join("\n");
	const inProgIdx = todos.findIndex((t) => t.status === "in_progress");
	const displayItems = [];
	todos.forEach((t, i) => {
		if (i < 3 || inProgIdx !== -1 && Math.abs(i - inProgIdx) <= 1 || i === todos.length - 1) {
			if (!displayItems.some((d) => d.index === i)) displayItems.push({
				item: t,
				index: i
			});
		}
	});
	displayItems.sort((a, b) => a.index - b.index);
	const lines = [];
	let lastIdx = -1;
	for (const { item, index } of displayItems) {
		if (lastIdx !== -1 && index > lastIdx + 1) {
			const hiddenCount = index - lastIdx - 1;
			lines.push(`*... (已折叠 ${hiddenCount} 项待处理任务) ...*`);
		}
		lines.push(formatItem(item, index));
		lastIdx = index;
	}
	if (lastIdx < todos.length - 1) {
		const hiddenCount = todos.length - 1 - lastIdx;
		lines.push(`*... (还有 ${hiddenCount} 项待处理任务已折叠) ...*`);
	}
	return lines.join("\n");
}
/**
* Main Task & Goal Board Card (Schema 2.0).
* Matches the DSH native task monitor UI shown in user screenshots.
*/
function buildTaskBoardCard(state, opts = {}) {
	const isFolded = opts.isFolded ?? state.isFolded ?? true;
	const todos = state.todos ?? [];
	const inProgressCount = todos.filter((t) => t.status === "in_progress").length;
	const completedCount = todos.filter((t) => t.status === "completed").length;
	const pendingCount = todos.filter((t) => t.status === "pending").length;
	const totalCount = todos.length;
	let template = "blue";
	let statusLabel = "执行中";
	if (state.goal) switch (state.goal.phase) {
		case "complete":
			template = "green";
			statusLabel = "已完成";
			break;
		case "paused":
			template = "yellow";
			statusLabel = "已暂停";
			break;
		case "blocked":
			template = "orange";
			statusLabel = "已阻塞";
			break;
		default:
			template = "blue";
			statusLabel = "执行中";
	}
	else if (totalCount > 0 && completedCount === totalCount) {
		template = "green";
		statusLabel = "已完成";
	}
	const elements = [];
	if (state.goal) {
		elements.push({
			tag: "markdown",
			content: `**🎯 进行中的目标**\n${state.goal.objective}`
		});
		if (state.goal.phase === "blocked" && state.goal.blockedReason) elements.push({
			tag: "markdown",
			content: `> ⚠️ **阻塞原因**: \`${state.goal.blockedReason.code}\` - ${state.goal.blockedReason.message}`
		});
		const wsDisplay = state.workspacePath ? state.workspacePath.split("/").filter(Boolean).pop() ?? state.workspacePath : "默认工作区";
		elements.push({
			tag: "column_set",
			flex_mode: "flow",
			background_style: "grey",
			columns: [
				{
					tag: "column",
					width: "weighted",
					weight: 1,
					elements: [{
						tag: "markdown",
						content: `📁 **工作区**\n\`${wsDisplay}\``
					}]
				},
				{
					tag: "column",
					width: "weighted",
					weight: 1,
					elements: [{
						tag: "markdown",
						content: `🔄 **执行轮次**\n\`${state.goal.roundsStarted}\` / ${state.goal.maxGoalRounds}`
					}]
				},
				{
					tag: "column",
					width: "weighted",
					weight: 1,
					elements: [{
						tag: "markdown",
						content: `📊 **总进度**\n${totalCount > 0 ? `${Math.round(completedCount / totalCount * 100)}%` : "0%"}`
					}]
				}
			]
		});
		elements.push({ tag: "hr" });
	}
	elements.push({
		tag: "markdown",
		content: [`**📊 任务总览** ⚡ ${inProgressCount} 进行中 · ⏳ ${pendingCount} 待处理 · ✅ ${completedCount} 已完成`, renderProgressBar(completedCount, totalCount)].join("\n")
	});
	elements.push({
		tag: "markdown",
		content: `**📋 任务执行清单**:\n\n${formatTodoList(todos, isFolded)}`
	});
	elements.push({ tag: "hr" });
	const actionCols = [];
	if (state.goal?.phase === "paused") actionCols.push({
		tag: "column",
		width: "weighted",
		weight: 1,
		elements: [button("▶️ 恢复执行", {
			op: "goal:resume",
			goalId: state.goal.id,
			revision: state.goal.revision
		}, "primary")]
	});
	else if (state.goal?.phase === "active" || !state.goal && inProgressCount > 0) actionCols.push({
		tag: "column",
		width: "weighted",
		weight: 1,
		elements: [button("⏸ 暂停目标", {
			op: "goal:pause",
			goalId: state.goal?.id,
			revision: state.goal?.revision
		})]
	});
	actionCols.push({
		tag: "column",
		width: "weighted",
		weight: 1,
		elements: [button("🛑 终止任务", {
			op: "goal:clear",
			goalId: state.goal?.id,
			revision: state.goal?.revision
		}, "danger")]
	});
	if (totalCount > 6) actionCols.push({
		tag: "column",
		width: "weighted",
		weight: 1,
		elements: [button(isFolded ? "📋 展开详情" : "🔼 收起列表", {
			op: "task:toggle_fold",
			folded: !isFolded
		})]
	});
	elements.push({
		tag: "column_set",
		flex_mode: "flow",
		columns: actionCols
	});
	return {
		schema: "2.0",
		config: {
			update_multi: true,
			streaming_mode: false
		},
		header: {
			title: {
				tag: "plain_text",
				content: `🎯 DSH 任务看板 · ${statusLabel} (${completedCount}/${totalCount})`
			},
			subtitle: {
				tag: "plain_text",
				content: `${inProgressCount} 进行中 · ${pendingCount} 待处理 · ${completedCount} 已完成`
			},
			template
		},
		body: { elements }
	};
}
/**
* Controller Card for `/goal` command when an active goal exists.
*/
function buildGoalControlCard(goal, opts = {}) {
	let template = "blue";
	let phaseDesc = "进行中";
	if (goal.phase === "paused") {
		template = "yellow";
		phaseDesc = "已暂停";
	} else if (goal.phase === "blocked") {
		template = "orange";
		phaseDesc = "已阻塞";
	} else if (goal.phase === "complete") {
		template = "green";
		phaseDesc = "已达成";
	}
	const wsDisplay = opts.workspacePath ? opts.workspacePath.split("/").filter(Boolean).pop() ?? opts.workspacePath : "默认工作区";
	const elements = [{
		tag: "markdown",
		content: `**🎯 当前目标** (${phaseDesc})\n${goal.objective}`
	}];
	if (goal.phase === "blocked" && goal.blockedReason) elements.push({
		tag: "markdown",
		content: `> ⚠️ **阻塞原因**: \`${goal.blockedReason.code}\` - ${goal.blockedReason.message}`
	});
	elements.push({
		tag: "column_set",
		flex_mode: "flow",
		background_style: "grey",
		columns: [
			{
				tag: "column",
				width: "weighted",
				weight: 1,
				elements: [{
					tag: "markdown",
					content: `📁 **工作区**\n\`${wsDisplay}\``
				}]
			},
			{
				tag: "column",
				width: "weighted",
				weight: 1,
				elements: [{
					tag: "markdown",
					content: `🔄 **轮次**\n\`${goal.roundsStarted}\` / ${goal.maxGoalRounds}`
				}]
			},
			{
				tag: "column",
				width: "weighted",
				weight: 1,
				elements: [{
					tag: "markdown",
					content: `🚦 **状态**\n\`${goal.phase}\``
				}]
			}
		]
	});
	elements.push({ tag: "hr" });
	const actionCols = [];
	if (goal.phase === "paused" || goal.phase === "blocked") actionCols.push({
		tag: "column",
		width: "weighted",
		weight: 1,
		elements: [button("▶️ 恢复执行", {
			op: "goal:resume",
			goalId: goal.id,
			revision: goal.revision
		}, "primary")]
	});
	else if (goal.phase === "active") actionCols.push({
		tag: "column",
		width: "weighted",
		weight: 1,
		elements: [button("⏸ 暂停目标", {
			op: "goal:pause",
			goalId: goal.id,
			revision: goal.revision
		})]
	});
	actionCols.push({
		tag: "column",
		width: "weighted",
		weight: 1,
		elements: [button("🛑 清除目标", {
			op: "goal:clear",
			goalId: goal.id,
			revision: goal.revision
		}, "danger")]
	});
	actionCols.push({
		tag: "column",
		width: "weighted",
		weight: 1,
		elements: [button("📋 任务看板", { op: "task:focus_board" })]
	});
	elements.push({
		tag: "column_set",
		flex_mode: "flow",
		columns: actionCols
	});
	return {
		schema: "2.0",
		header: {
			title: {
				tag: "plain_text",
				content: `🎯 DSH 目标控制台 · ${phaseDesc}`
			},
			template
		},
		body: { elements }
	};
}
/**
* Setup/Guide Card for `/goal` command when NO active goal exists.
*/
function buildGoalSetupCard() {
	return {
		schema: "2.0",
		header: {
			title: {
				tag: "plain_text",
				content: "🎯 设定新的 Agent 目标"
			},
			template: "blue"
		},
		body: { elements: [
			{
				tag: "markdown",
				content: [
					"**目标（Goal）** 可驱动 Agent 在多轮循环中自主推进复杂任务，直到目标达成。",
					"",
					"💡 **常用目标快速模板**（点按钮直接触发）："
				].join("\n")
			},
			button("🛠️ 构建与测试工程", { op: "goal:tpl:build" }),
			button("🐞 诊断并修复问题", { op: "goal:tpl:fix" }),
			button("📝 重构模块与补全文档", { op: "goal:tpl:refactor" }),
			{
				tag: "markdown",
				content: [
					"———",
					"或直接输入指令设定自定义目标：",
					"`/goal <你的目标描述>`"
				].join("\n")
			}
		] }
	};
}
/**
* Briefing card sent when an agent session is restored via `/resume`.
*/
function buildSessionResumedCard(briefing) {
	return {
		schema: "2.0",
		header: {
			title: {
				tag: "plain_text",
				content: "🔄 已恢复历史会话"
			},
			template: "blue"
		},
		body: { elements: [{
			tag: "markdown",
			content: `**工作区**: \`${briefing.workspacePath ?? "默认"}\`${briefing.preset ? ` · **模式**: \`${briefing.preset}\`` : ""}`
		}, {
			tag: "markdown",
			content: "💡 **会话已恢复**，直接发送消息即可继续对话。"
		}] }
	};
}
//#endregion
//#region src/presentation/cards.ts
/**
* schema 2.0 按钮：直接作为组件放 elements（平铺、宽度完整不缩略）；
* 交互回传用 behaviors:[{type:"callback",value}]（card.action.trigger 回调返回 value）。
*/
function button(text, value, style) {
	const b = {
		tag: "button",
		width: "fill",
		text: {
			tag: "plain_text",
			content: text
		},
		behaviors: [{
			type: "callback",
			value
		}]
	};
	if (style === "primary") b.type = "primary";
	if (style === "danger") b.type = "danger";
	return b;
}
/**
* Heuristic: does this reply carry markdown worth rendering as a card?
* Matches headings, lists, fenced code, blockquotes, bold, tables and
* paragraph breaks (pi-feishu-link rich-text mode selection).
*/
function looksLikeMarkdown(text) {
	const t = text.trim();
	if (!t) return false;
	if (/(^|\n)\s*(#{1,6}\s|[-*+]\s|\d+\.\s|```|>\s|\*\*|\|.*\|)/.test(t) || t.includes("\n\n")) return true;
	return false;
}
function markdownCard(markdown, opts = {}) {
	return {
		schema: "2.0",
		...opts.header ? { header: {
			title: {
				tag: "plain_text",
				content: opts.header
			},
			template: opts.accent ? "blue" : "grey"
		} } : {},
		body: { elements: [{
			tag: "markdown",
			content: markdown
		}] }
	};
}
/**
* Agent preset options (DSH agent-presets).
*
* `AGENT_PRESETS` is the FALLBACK roster — the four shipped presets — used
* when the live DSH agentPresets service is unreachable. When the service is
* up, the bridge renders the dynamic roster (shipped + user-authored) instead;
* see the DshSessionBackend.listPresets surface.
*/
const AGENT_PRESETS = [
	{
		id: "standard",
		label: "标准模式",
		desc: "全能：文件/Shell/检索/Skills/目标/子代理/工作流",
		trust: "system"
	},
	{
		id: "code",
		label: "PTC 模式",
		desc: "标准能力 + Code Mode（多步操作一次执行，更快）",
		trust: "system"
	},
	{
		id: "minimal",
		label: "极简模式",
		desc: "仅 bash + 文件编辑，轻量省 token",
		trust: "system"
	},
	{
		id: "cordis",
		label: "创造模式",
		desc: "标准能力 + preset 创作工具（面向开发者）",
		trust: "system"
	}
];
/** Permission preset options (dsh-permission-presets). */
const PERMISSION_PRESETS = [
	{
		id: "read-only",
		label: "只读",
		desc: "沙箱只读，危险操作需审批"
	},
	{
		id: "workspace-write",
		label: "工作区写",
		desc: "仅工作区可写，危险操作需审批"
	},
	{
		id: "danger-full-access",
		label: "Full access",
		desc: "全访问 + 审批 never（默认）"
	}
];
/** Append action buttons to a markdown card's body. */
function withButtons(card, buttons) {
	const c = card;
	return {
		...c,
		body: {
			...c.body ?? {},
			elements: [...c.body?.elements ?? [], ...buttons]
		}
	};
}
/**
* Intent-confirmation card (DSH ask_user_question → Feishu).
*
* Single-select (default): one button per option, answered immediately via op
* "uqa:<questionId>:<optionIndex>".
*
* Multi-select (multiSelect === true): a form_container with a
* multi_select_static dropdown; the user taps 提交 and the onSubmit callback
* returns action.form_value.answer (string[] of option indexes — Feishu spells
* the form payload in snake_case; the bridge accepts both spellings) via op
* "uqam:<questionId>".
*
* The footer always invites a plain-text reply as a custom answer.
*/
function questionCard(q) {
	const header = q.header ? { header: {
		title: {
			tag: "plain_text",
			content: q.header
		},
		template: "blue"
	} } : {};
	if (q.multiSelect) {
		const options = (q.options ?? []).map((o, i) => ({
			text: {
				tag: "plain_text",
				content: o.label
			},
			value: String(i)
		}));
		return {
			schema: "2.0",
			...header,
			body: { elements: [
				{
					tag: "markdown",
					content: q.question
				},
				...q.detail ? [{
					tag: "markdown",
					content: q.detail
				}] : [],
				{
					tag: "form_container",
					children: [{
						tag: "multi_select_static",
						name: "answer",
						placeholder: {
							tag: "plain_text",
							content: "请选择（可多选）…"
						},
						options
					}],
					onSubmit: [{
						type: "callback",
						value: { op: `uqam:${q.id}` }
					}]
				},
				{
					tag: "markdown",
					content: "或直接发消息输入自定义答案"
				}
			] }
		};
	}
	const elements = [{
		tag: "markdown",
		content: q.question
	}, ...q.detail ? [{
		tag: "markdown",
		content: q.detail
	}] : []];
	(q.options ?? []).forEach((o, i) => {
		elements.push(button(o.label, { op: `uqa:${q.id}:${i}` }));
	});
	elements.push({
		tag: "markdown",
		content: "或直接发消息输入自定义答案"
	});
	return {
		schema: "2.0",
		...header,
		body: { elements }
	};
}
/** Single-select mode picker card — tap a button to switch (no typing). */
function modeCard(current, presets) {
	return markdownCard([
		"**Agent 模式**（单选，点按钮即切换，下条消息生效）",
		"",
		...(presets && presets.length > 0 ? presets : AGENT_PRESETS).map((p) => `- ${p.label}${p.trust === "user" ? "（自定义）" : ""}${current === p.id ? " ← 当前" : ""}：${p.desc ?? p.id}${p.broken ? `（不可用：${p.broken}）` : ""}`)
	].join("\n"), {
		header: "切换模式",
		accent: true
	});
}
/** Model picker card grouped by provider: provider header + one button per model. */
function modelCard(current, groups) {
	const elements = [{
		tag: "markdown",
		content: `**当前模型**: ${current?.provider ?? "?"}/${current?.model ?? "未设置"}`
	}, {
		tag: "markdown",
		content: "**按供应商选择模型**（点按钮即切换，下条消息生效）"
	}];
	let first = true;
	for (const g of groups) {
		if (g.models.length === 0) continue;
		if (!first) elements.push({ tag: "hr" });
		first = false;
		elements.push({
			tag: "markdown",
			content: `**${g.label ?? g.provider}**`
		});
		for (const m of g.models) elements.push({
			tag: "button",
			width: "fill",
			text: {
				tag: "plain_text",
				content: m.name ?? m.id
			},
			behaviors: [{
				type: "callback",
				value: { op: `model:${g.provider}/${m.id}` }
			}]
		});
	}
	if (first) elements.push({
		tag: "markdown",
		content: "（无可用模型列表）"
	});
	return {
		schema: "2.0",
		header: {
			title: {
				tag: "plain_text",
				content: "切换模型"
			},
			template: "blue"
		},
		body: { elements }
	};
}
/** Model-owned reasoning effort picker for one Feishu conversation. */
function reasoningCard(model, current, defaultEffort, efforts) {
	const effective = current ?? defaultEffort;
	const elements = [{
		tag: "markdown",
		content: [
			`**当前模型**: ${model.provider}/${model.model}`,
			`**当前强度**: ${effective ?? "提供方默认"}${current ? "（本会话指定）" : "（跟随默认）"}`,
			"",
			"选择只影响当前飞书会话，下次模型请求生效，不会清空上下文。"
		].join("\n")
	}, button("跟随模型默认", { op: "reasoning:default" })];
	for (const effort of efforts) {
		elements.push(button(`${effort.name}${effort.id === effective ? "（当前）" : ""}`, { op: `reasoning:${effort.id}` }));
		if (effort.description) elements.push({
			tag: "markdown",
			content: effort.description
		});
	}
	return {
		schema: "2.0",
		header: {
			title: {
				tag: "plain_text",
				content: "切换思考强度"
			},
			template: "blue"
		},
		body: { elements }
	};
}
/** Single-select permission picker card. */
function permissionCard(current) {
	return markdownCard([
		"**权限模式**（单选，点按钮即切换）",
		"",
		...PERMISSION_PRESETS.map((p) => `- ${p.label}${current === p.id ? " ← 当前" : ""}：${p.desc}`)
	].join("\n"), {
		header: "切换权限",
		accent: true
	});
}
/**
* Workspace history picker card (/resume): one button per historical session
* of the CURRENT workspace (newest first).
*
* User-friendliness decisions:
* - Relative times (5 分钟前 / 3 天前) instead of raw timestamps.
* - Stored preset badge per row; the CURRENT session is listed too but its
*   button is disabled (users see where they are).
* - Button op carries the session id URI-ENCODED — the card-action dispatcher
*   splits op at the FIRST ":" and lark-link session ids are full of colons
*   (`lark-link:dm:oc_x:nonce:0`); an unencoded id would lose its prefix and
*   the click would resolve to 未找到会话.
*/
/** Relative time as shown in the pickers (刚刚 / 5 分钟前 / 3 天前). */
function relativeTime(ts, now = Date.now()) {
	const d = Math.max(0, now - ts);
	const m = Math.floor(d / 6e4);
	if (m < 1) return "刚刚";
	if (m < 60) return `${m} 分钟前`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h} 小时前`;
	const day = Math.floor(h / 24);
	if (day < 30) return `${day} 天前`;
	return new Date(ts).toLocaleDateString("zh-CN");
}
function resumeCard(sessions, currentSessionId, opts = {}) {
	const now = opts.now ?? Date.now;
	const elements = [{
		tag: "markdown",
		content: "**恢复历史会话**（点按钮即恢复；或直接回复 `/resume <序号>`）"
	}];
	let n = 0;
	sessions.forEach((s) => {
		const isCurrent = s.id === currentSessionId;
		const rowNumber = isCurrent ? void 0 : ++n;
		const titlePart = s.title ? s.title.slice(0, 32) : "会话";
		const activityAt = s.lastActivityAt ?? s.createdAt;
		const stats = [
			s.preset ? `模式 ${s.preset}` : void 0,
			typeof s.userTurns === "number" ? `${s.userTurns} 轮提问` : void 0,
			typeof s.toolCalls === "number" && s.toolCalls > 0 ? `${s.toolCalls} 次工具` : void 0
		].filter(Boolean);
		elements.push({
			tag: "markdown",
			content: [
				isCurrent ? `**当前 · ${titlePart}**` : `**#${rowNumber} · ${titlePart}**`,
				`${relativeTime(activityAt, now())}${stats.length > 0 ? ` · ${stats.join(" · ")}` : ""}`,
				s.summary ? `> ${s.summary}` : "> 暂无可提取的回复概览"
			].join("\n")
		});
		const btn = button(isCurrent ? "当前会话" : `恢复 #${rowNumber}`, { op: `resume:${encodeURIComponent(s.id)}` });
		if (isCurrent) btn.disabled = true;
		elements.push(btn);
	});
	if (currentSessionId && !sessions.some((s) => s.id === currentSessionId)) elements.push({
		tag: "markdown",
		content: `- 当前会话：刚刚开始（发消息即在此会话继续）`
	});
	if (sessions.length === 0) elements.push({
		tag: "markdown",
		content: "（该工作区暂无历史会话日志）"
	});
	elements.push({
		tag: "markdown",
		content: [
			"———",
			"💡 恢复后**下一条消息接续历史上下文**；此前的会话仍然保留，随时可再 `/resume` 切回。",
			"新起会话用 `/new`；换工作区用 `/workspace <路径>`。",
			"重命名 / 删除 / 迁移项目请用 `/manage`（对话管理）。"
		].join("\n")
	});
	return {
		schema: "2.0",
		header: {
			title: {
				tag: "plain_text",
				content: "恢复历史会话"
			},
			template: "blue"
		},
		body: { elements }
	};
}
/**
* /help — grouped command reference.
*
* The LIST is the primary content (a regression had the panel replace this
* whole card with its generic "✅ 操作已完成" ack, so the list never reached
* the user), followed by a button that opens the control panel so every entry
* is also reachable in one tap.
*/
function helpCard() {
	return withButtons(markdownCard([
		"**可用命令**（点下方按钮进入控制面板，或直接输入）",
		"",
		...[
			{
				title: "会话",
				lines: ["`/new` 新任务（并行，需确认） · `/stop` 停止当前任务", "`/tasks` 任务列表与切换 · `/manage` 对话管理（重命名/删除/迁移项目）"]
			},
			{
				title: "模型与模式",
				lines: ["`/model` 切换模型 · `/reasoning` 思考强度（`/thinking` 同义）", "`/mode` Agent 模式 · `/permission` 权限"]
			},
			{
				title: "工作区与文件",
				lines: ["`/workspace` 目录浏览器（可上下浏览、新建文件夹）", "`/cwd` 查看当前工作区 · `/files [路径]` 列出目录内容"]
			},
			{
				title: "诊断与运维",
				lines: ["`/status` 桥接状态 · `/whoami` 当前会话诊断", "`/usage` 用量 · `/doctor` 诊断包 · `/reconnect` 重连"]
			},
			{
				title: "配置与桥管理",
				lines: ["`/lark-config` 设置面板 · `/stream on|off` 流式开关", "`/lark` 桥管理（setup/start/stop/restart/status）"]
			}
		].flatMap((group) => [
			`**${group.title}**`,
			...group.lines,
			""
		]),
		"`/goal`、`/compact` 等 DSH 命令原样执行；skill 无需前缀，直接描述任务即可。"
	].join("\n"), {
		header: "Lark Link 帮助",
		accent: true
	}), [button("🧭 打开控制面板", { op: "menu" }, "primary")]);
}
/**
* Control panel — the single entry point for every bridge command. `/menu`,
* `/help` and the welcome card all land here; every action is one tap and no
* command needs to be typed from memory.
*/
function commandPanelCard() {
	const groups = [
		{
			title: "概览",
			items: [["📊 桥接状态", "status"], ["🗂 对话管理", "manage"]]
		},
		{
			title: "会话",
			items: [
				["🗂 任务列表", "tasks"],
				["🆕 新任务", "new"],
				["⏹ 停止当前任务", "stop"],
				["📂 工作区", "workspace"],
				["📄 文件", "files"]
			]
		},
		{
			title: "模型与模式",
			items: [
				["🤖 模型", "model"],
				["🧠 思考强度", "reasoning"],
				["🎛 模式", "mode"],
				["🛡 权限", "permission"]
			]
		},
		{
			title: "诊断与运维",
			items: [
				["🩺 诊断包", "doctor"],
				["🔍 当前会话", "whoami"],
				["📈 用量", "usage"],
				["🔌 重连", "reconnect"]
			]
		},
		{
			title: "配置与桥管理",
			items: [
				["⚙️ 设置", "lark-config"],
				["🌊 流式开关", "stream"],
				["🪶 桥管理", "lark"],
				["❓ 帮助", "help"]
			]
		}
	];
	const elements = [{
		tag: "markdown",
		content: "**命令控制面板**\n点按钮直接执行；也可以直接输入文字与 Agent 对话。"
	}];
	for (const group of groups) {
		elements.push({
			tag: "markdown",
			content: `**${group.title}**`
		});
		for (const [label, op] of group.items) elements.push(button(label, { op }));
	}
	return {
		schema: "2.0",
		header: {
			title: {
				tag: "plain_text",
				content: "控制面板"
			},
			template: "blue"
		},
		body: { elements }
	};
}
const sessionLabel = (s) => s.alias ?? s.title ?? "（未命名会话）";
const sessionStats = (s) => [
	s.preset ? `模式 ${s.preset}` : void 0,
	typeof s.userTurns === "number" ? `${s.userTurns} 轮提问` : void 0,
	typeof s.toolCalls === "number" && s.toolCalls > 0 ? `${s.toolCalls} 次工具` : void 0
].filter(Boolean).join(" · ");
/**
* /manage — the conversation-management panel: pick a session, then operate on
* it (rename / delete / migrate project). Recovery itself stays in /resume, and
* the panel always carries an explicit exit button.
*/
function sessionManageCard(input) {
	const now = input.now ?? Date.now;
	const elements = [{
		tag: "markdown",
		content: ["**对话管理**", "选择一条会话后可以重命名 / 删除 / 迁移项目；恢复上下文仍用 `/resume`。"].join("\n")
	}];
	if (input.note) elements.push({
		tag: "markdown",
		content: `✅ ${input.note}`
	});
	input.sessions.forEach((s, index) => {
		const isCurrent = s.id === input.currentSessionId;
		const stats = sessionStats(s);
		elements.push({
			tag: "markdown",
			content: [
				`**#${index + 1} · ${sessionLabel(s)}**${isCurrent ? "（当前）" : ""}`,
				`${relativeTime(s.lastActivityAt ?? s.createdAt, now())}${stats ? ` · ${stats}` : ""}`,
				s.summary ? `> ${s.summary}` : ""
			].filter(Boolean).join("\n")
		});
		elements.push(button("🗂 管理", { op: `manage:pick:${encodeURIComponent(s.id)}` }));
	});
	if (input.sessions.length === 0) elements.push({
		tag: "markdown",
		content: "（该工作区暂无历史会话日志）"
	});
	elements.push({ tag: "hr" });
	elements.push(button("🔄 刷新", { op: "manage:list" }));
	elements.push(button("✖️ 退出对话管理", { op: "manage:exit" }, "primary"));
	return {
		schema: "2.0",
		header: {
			title: {
				tag: "plain_text",
				content: "对话管理"
			},
			template: "blue"
		},
		body: { elements }
	};
}
/** One session's operations. Destructive/live-breaking ones are disabled for
*  the session this conversation is currently using. */
function sessionManageDetailCard(input) {
	const now = input.now ?? Date.now;
	const s = input.session;
	const isCurrent = s.id === input.currentSessionId;
	const id = encodeURIComponent(s.id);
	const stats = sessionStats(s);
	const renamed = Boolean(s.alias && s.title && s.alias !== s.title);
	const elements = [{
		tag: "markdown",
		content: [
			`**名称**：${sessionLabel(s)}${renamed ? `（原名 ${s.title}）` : ""}`,
			`**会话 ID**：\`${s.id}\``,
			`**创建**：${new Date(s.createdAt).toLocaleString("zh-CN")} · **最近活动**：${relativeTime(s.lastActivityAt ?? s.createdAt, now())}`,
			...stats ? [`**统计**：${stats}`] : [],
			...s.cwd ? [`**所属项目**：\`${s.cwd}\``] : [],
			...s.summary ? [`**最近回复**：${s.summary}`] : []
		].join("\n")
	}];
	if (isCurrent) elements.push({
		tag: "markdown",
		content: "ℹ️ 这是当前会话：可以重命名；删除 / 迁移 / 恢复需要先切到别的会话（`/resume` 或 `/new`）。"
	});
	if (input.note) elements.push({
		tag: "markdown",
		content: `✅ ${input.note}`
	});
	elements.push({ tag: "hr" });
	elements.push(button("✏️ 重命名", { op: `manage:rename:${id}` }));
	const resume = button("▶️ 恢复此会话", { op: `manage:resume:${id}` }, "primary");
	const move = button("📦 迁移项目", { op: `manage:move:${id}` });
	const remove = button("🗑 删除", { op: `manage:delete:${id}` }, "danger");
	if (isCurrent) for (const btn of [
		resume,
		move,
		remove
	]) btn.disabled = true;
	elements.push(resume, move, remove);
	elements.push({ tag: "hr" });
	elements.push(button("↩️ 返回列表", { op: "manage:list" }));
	elements.push(button("✖️ 退出对话管理", { op: "manage:exit" }));
	return {
		schema: "2.0",
		header: {
			title: {
				tag: "plain_text",
				content: "对话管理 · 会话详情"
			},
			template: "blue"
		},
		body: { elements }
	};
}
/** Rename form. The bridge keeps the alias; a LIVE session also gets the real
*  DSH title (the host's title service only retitles live sessions). */
function sessionRenameCard(input) {
	const id = encodeURIComponent(input.session.id);
	return {
		schema: "2.0",
		header: {
			title: {
				tag: "plain_text",
				content: "重命名会话"
			},
			template: "blue"
		},
		body: { elements: [
			{
				tag: "markdown",
				content: [
					`当前名称：**${sessionLabel(input.session)}**`,
					"",
					"名称由桥侧保存并显示在对话管理 / `/resume` 中；若该会话正在被使用，会同时更新 DSH 标题。"
				].join("\n")
			},
			{
				tag: "form_container",
				children: [{
					tag: "input",
					name: "alias",
					placeholder: {
						tag: "plain_text",
						content: "新名称（最多 48 字）"
					}
				}],
				onSubmit: [{
					type: "callback",
					value: { op: `manage:rename:submit:${id}` }
				}]
			},
			button("↩️ 返回", { op: `manage:pick:${id}` }),
			{
				tag: "markdown",
				content: "💡 名称最多 48 字；再次重命名会覆盖旧名称。"
			}
		] }
	};
}
/** Migrate-project picker: known projects as buttons, plus a free-form path. */
function sessionMoveCard(input) {
	const id = encodeURIComponent(input.session.id);
	const elements = [{
		tag: "markdown",
		content: [
			`把 **${sessionLabel(input.session)}** 迁移到另一个项目（工作区目录）。`,
			input.session.cwd ? `当前项目：\`${input.session.cwd}\`` : "当前项目：未知",
			"迁移只改变这条会话归属的工作区，不会移动工作区里的任何文件。"
		].join("\n")
	}];
	const candidates = input.targets.filter((target) => target !== input.session.cwd);
	if (candidates.length > 0) {
		elements.push({
			tag: "markdown",
			content: "**选择目标项目**"
		});
		for (const target of candidates) elements.push(button(`📦 ${target}`, { op: `manage:move:to:${id}|${encodeURIComponent(target)}` }));
	} else elements.push({
		tag: "markdown",
		content: "（暂无其他项目，可在下面直接输入目标路径）"
	});
	elements.push({ tag: "hr" });
	elements.push({
		tag: "form_container",
		children: [{
			tag: "input",
			name: "path",
			placeholder: {
				tag: "plain_text",
				content: "或输入目标路径，如 /home/ubuntu/dsh-workspace/demo"
			}
		}],
		onSubmit: [{
			type: "callback",
			value: { op: `manage:move:submit:${id}` }
		}]
	});
	elements.push(button("↩️ 返回", { op: `manage:pick:${id}` }));
	return {
		schema: "2.0",
		header: {
			title: {
				tag: "plain_text",
				content: "迁移项目"
			},
			template: "blue"
		},
		body: { elements }
	};
}
const taskLabel = (row) => row.label ?? row.title ?? (row.historical ? "历史会话" : "任务");
const statusBadge = (row) => row.status === "running" ? "🔵 运行中" : row.status === "idle" ? "⚪ 空闲" : "⚫ 已停止";
const taskStats = (row) => [
	`#${row.seq}`,
	statusBadge(row),
	row.active ? "当前" : void 0,
	row.historical ? "历史" : void 0
].filter(Boolean).join(" · ");
/**
* /tasks — every task this conversation owns, RUNNING FIRST, with one-tap
* switching. Supersedes the old /resume picker: a running task can be opened
* mid-turn, and a historical session is simply a task that is not hosted.
*/
function taskListCard(input) {
	const now = input.now ?? Date.now;
	const rows = [...input.tasks].sort((a, b) => {
		const rank = (row) => row.status === "running" ? 0 : row.status === "idle" ? 1 : 2;
		const byStatus = rank(a) - rank(b);
		if (byStatus !== 0) return byStatus;
		return b.lastActivityAt - a.lastActivityAt;
	});
	const elements = [{
		tag: "markdown",
		content: ["**任务**（运行中优先；点「切换」把消息发到那条任务）", input.workspace ? `工作区：\`${input.workspace}\`` : ""].filter(Boolean).join("\n")
	}];
	if (input.note) elements.push({
		tag: "markdown",
		content: `✅ ${input.note}`
	});
	rows.forEach((row) => {
		elements.push({
			tag: "markdown",
			content: [
				`**#${row.seq} · ${taskLabel(row)}**${row.active ? "（当前）" : ""}`,
				`${taskStats(row)} · ${relativeTime(row.lastActivityAt, now())}`,
				row.summary ? `> ${row.summary}` : ""
			].filter(Boolean).join("\n")
		});
		if (row.taskId) {
			elements.push(button("▶️ 切换", { op: `tasks:switch:${encodeURIComponent(row.taskId)}` }, "primary"));
			if (row.status === "running") elements.push(button("⏹ 停止", { op: `tasks:stop:${encodeURIComponent(row.taskId)}` }));
		} else if (row.sessionId) elements.push(button("▶️ 切换", { op: `tasks:open:${encodeURIComponent(row.sessionId)}` }, "primary"));
		if (row.sessionId) elements.push(button("🗂 管理", { op: `manage:pick:${encodeURIComponent(row.sessionId)}` }));
	});
	if (rows.length === 0) elements.push({
		tag: "markdown",
		content: "（还没有任务，直接发消息或点下面的「新任务」）"
	});
	elements.push({ tag: "hr" });
	elements.push(button("➕ 新任务", { op: "tasks:new" }, "primary"));
	elements.push(button("🔄 刷新", { op: "tasks:list" }));
	elements.push(button("✖️ 退出", { op: "tasks:exit" }));
	return {
		schema: "2.0",
		header: {
			title: {
				tag: "plain_text",
				content: "任务列表"
			},
			template: "blue"
		},
		body: { elements }
	};
}
/**
* Switch/refresh result for ONE task: its state, what it has produced so far
* (including the answer that is still being written) and its controls.
*/
function taskBriefingCard(input) {
	const now = input.now ?? Date.now;
	const row = input.task;
	const running = row.status === "running";
	const parts = [
		`**#${row.seq} · ${taskLabel(row)}**`,
		`状态：${statusBadge(row)}${row.active ? " · 当前任务（新消息发到这里）" : ""}`,
		`最近活动：${relativeTime(row.lastActivityAt, now())}`
	];
	if (input.workspace) parts.push(`工作区：\`${input.workspace}\``);
	if (input.preset) parts.push(`模式：\`${input.preset}\``);
	if (row.sessionId) parts.push(`会话：\`${row.sessionId}\``);
	if (row.summary) parts.push(`> ${row.summary}`);
	if (input.todos && input.todos.length > 0) parts.push("**进度**", ...input.todos.slice(0, 12).map((todo) => todo.status === "completed" ? `- ~~${todo.content}~~` : todo.status === "in_progress" ? `- 🔄 ${todo.content}` : `- ⬜ ${todo.content}`));
	const elements = [{
		tag: "markdown",
		content: parts.join("\n")
	}];
	if (input.note) elements.push({
		tag: "markdown",
		content: `✅ ${input.note}`
	});
	const snap = input.snapshot;
	if (running) elements.push({
		tag: "markdown",
		content: ["🔵 **运行中**：输出继续更新在它自己的卡片里（已为你续上）。", snap?.text ? `**当前进度**\n> ${snap.text.split("\n").slice(-6).join("\n> ").slice(0, 700)}` : "**当前进度**\n> 正在思考或调用工具，还没有可展示的正文。"].join("\n")
	});
	else if (snap?.text) elements.push({
		tag: "markdown",
		content: `**最近输出**\n> ${snap.text.split("\n").slice(-6).join("\n> ").slice(0, 700)}`
	});
	elements.push({ tag: "hr" });
	if (row.taskId) {
		if (running) elements.push(button("⏹ 停止任务", { op: `tasks:stop:${encodeURIComponent(row.taskId)}` }));
		elements.push(button("🔄 刷新状态", { op: `tasks:refresh:${encodeURIComponent(row.taskId)}` }));
	}
	if (row.sessionId) elements.push(button("🗂 管理", { op: `manage:pick:${encodeURIComponent(row.sessionId)}` }));
	elements.push(button("📋 任务列表", { op: "tasks:list" }));
	elements.push(button("✖️ 退出", { op: "tasks:exit" }));
	return {
		schema: "2.0",
		header: {
			title: {
				tag: "plain_text",
				content: "任务"
			},
			template: running ? "green" : "blue"
		},
		body: { elements }
	};
}
/** Delete confirmation — the only destructive action in the panel. */
function sessionDeleteConfirmCard(input) {
	const id = encodeURIComponent(input.session.id);
	return {
		schema: "2.0",
		header: {
			title: {
				tag: "plain_text",
				content: "删除会话"
			},
			template: "red"
		},
		body: { elements: [
			{
				tag: "markdown",
				content: [
					`确认删除 **${sessionLabel(input.session)}**？`,
					"",
					"会移除该会话的持久化日志（含全部历史上下文），**无法恢复**。",
					"当前正在使用的会话不能删除。"
				].join("\n")
			},
			button("🗑 确认删除", { op: `manage:delete:confirm:${id}` }, "danger"),
			button("✖️ 取消", { op: `manage:pick:${id}` })
		] }
	};
}
const decoratePanelCallbacks = (input, cardId) => {
	if (Array.isArray(input)) return input.map((item) => decoratePanelCallbacks(item, cardId));
	if (!input || typeof input !== "object") return input;
	const record = input;
	const out = {};
	for (const [key, value] of Object.entries(record)) if (key === "value" && value && typeof value === "object" && typeof value.op === "string") out[key] = {
		...value,
		_panel_card_id: cardId
	};
	else out[key] = decoratePanelCallbacks(value, cardId);
	return out;
};
const commandPanelShell = (command, expanded, elements, template = "blue") => ({
	schema: "2.0",
	config: { update_multi: true },
	body: { elements: [{
		tag: "collapsible_panel",
		expanded,
		header: {
			title: {
				tag: "plain_text",
				content: `/${command}`
			},
			template,
			icon: {
				tag: "standard_icon",
				token: "down-small-ccm_outlined",
				size: "16px 16px"
			},
			icon_position: "right",
			icon_expanded_angle: -180
		},
		border: {
			color: "grey",
			corner_radius: "5px"
		},
		elements
	}] }
});
function commandRunningCard(command, elapsedSeconds) {
	return commandPanelShell(command, true, [{
		tag: "markdown",
		content: `⏳ **执行中** · ${elapsedSeconds}s`
	}]);
}
function commandCollapsedCard(command, result) {
	return commandPanelShell(command, false, [{
		tag: "markdown",
		content: result ? `✅ ${result}` : "✅ 已完成"
	}], "green");
}
/**
* Same shell as commandCollapsedCard, but the header turns red and the body is
* prefixed ⚠️. Previously a failed command collapsed into the same green
* "✅ 操作已完成" as a success, so failures were indistinguishable from
* no-ops in the Feishu timeline.
*/
function commandFailedCard(command, result) {
	return commandPanelShell(command, false, [{
		tag: "markdown",
		content: result ? `⚠️ ${result}` : "⚠️ 执行失败"
	}], "red");
}
function commandInteractivePanelCard(command, card, cardId) {
	const body = decoratePanelCallbacks(card, cardId)?.body;
	const elements = Array.isArray(body?.elements) ? body.elements : [];
	return commandPanelShell(command, true, elements);
}
/**
* Structured bridge status card: the one-line overview plus the full detail
* block (kept as ONE markdown element so multi-line detail survives — the
* text channel used to fold it into a single clipped line), with the routine
* follow-up actions attached.
*/
function statusCard(statusText, detailLines = []) {
	return {
		schema: "2.0",
		header: {
			title: {
				tag: "plain_text",
				content: "桥接状态"
			},
			template: "blue"
		},
		body: { elements: [
			{
				tag: "markdown",
				content: `**概览**\n${statusText}`
			},
			...detailLines.length > 0 ? [{
				tag: "markdown",
				content: `**明细**\n${detailLines.map((line) => `- ${line}`).join("\n")}`
			}] : [],
			{ tag: "hr" },
			button("🩺 诊断包", { op: "doctor" }),
			button("🔌 重连", { op: "reconnect" }),
			button("🧭 控制面板", { op: "menu" })
		] }
	};
}
/**
* /new confirmation. Resetting the session is cheap for the bridge but
* destroys the conversation context, so it asks before rotating.
*/
function newConfirmCard(input) {
	return {
		schema: "2.0",
		header: {
			title: {
				tag: "plain_text",
				content: "开启新任务"
			},
			template: "orange"
		},
		body: { elements: [
			{
				tag: "markdown",
				content: [
					"将开启一条**全新的任务**：新上下文，与当前任务并行存在。",
					"⚡ 当前任务**不会被停止**，长任务会继续在后台跑，用 `/tasks` 查看与切换。",
					"",
					`📁 工作区: \`${input.workspace}\``
				].join("\n")
			},
			button("✅ 确认新任务", { op: "new:confirm" }, "primary"),
			button("✖️ 取消", { op: "new:cancel" })
		] }
	};
}
/** /stop result plus the natural follow-ups (nothing running should still be
*  actionable instead of dead-ending on a one-line text ack). */
function stopResultCard(input) {
	return {
		schema: "2.0",
		header: {
			title: {
				tag: "plain_text",
				content: "停止任务"
			},
			template: "green"
		},
		body: { elements: [
			{
				tag: "markdown",
				content: input.text
			},
			button("📊 桥接状态", { op: "status" }),
			button("🆕 新会话", { op: "new" })
		] }
	};
}
/**
* Button-driven settings panel for /lark-config. Every toggle rewrites ONE
* hot-reloadable key through the generic `cfg:<key>=<value>` op, so adding a
* switch never needs a new callback branch; the advanced text form stays
* available for keys that need free-form values.
*/
function configPanelCard(input) {
	const state = (value) => value ? "🟢 已开启" : "⚪ 已关闭";
	return {
		schema: "2.0",
		header: {
			title: {
				tag: "plain_text",
				content: "设置"
			},
			template: "blue"
		},
		body: { elements: [
			{
				tag: "markdown",
				content: "**常用设置**（点按钮即时生效，写入 runtime-overrides.json）"
			},
			{
				tag: "markdown",
				content: `**流式卡片** 当前: ${state(input.streamingEnabled)}`
			},
			button("开启流式卡片", { op: "cfg:streaming.enabled=true" }),
			button("关闭流式卡片", { op: "cfg:streaming.enabled=false" }),
			{
				tag: "markdown",
				content: `**表情回执** 当前: ${state(input.reactionsEnabled)}`
			},
			button("开启表情回执", { op: "cfg:reactions.enabled=true" }),
			button("关闭表情回执", { op: "cfg:reactions.enabled=false" }),
			{
				tag: "markdown",
				content: `**群聊触发** 当前: \`${input.groupPolicy}\``
			},
			button("免 @ 全部触发", { op: "cfg:groupPolicy=open" }),
			button("仅 @ 机器人时触发", { op: "cfg:groupPolicy=mention" }),
			button("仅关键词触发", { op: "cfg:groupPolicy=keywords" }),
			{ tag: "hr" },
			{
				tag: "markdown",
				content: `**当前模式** \`${input.agentPreset}\` · **权限** \`${input.permissionMode}\``
			},
			button("🎛 切换模式", { op: "mode" }),
			button("🛡 切换权限", { op: "permission" }),
			{ tag: "hr" },
			{
				tag: "markdown",
				content: [
					"**高级**（文本形式，可改全部热改键）",
					`允许用户: \`${input.allowlist.length > 0 ? input.allowlist.join(", ") : "未限制"}\` · 命令拒绝前缀: \`${input.denyList.length > 0 ? input.denyList.join(", ") : "无"}\``,
					"例：`/lark-config allowlist=ou_xxx`、`/lark-config streaming.printStep=5`"
				].join("\n")
			}
		] }
	};
}
/** /lark — bridge administration without typing subcommands. */
function larkAdminPanelCard(input) {
	return {
		schema: "2.0",
		header: {
			title: {
				tag: "plain_text",
				content: "Lark 桥管理"
			},
			template: "blue"
		},
		body: { elements: [
			{
				tag: "markdown",
				content: `**连接**: \`${input.connState}\` · **凭据**: ${input.configured ? "已配置" : "未配置"}`
			},
			button("▶️ 启动", { op: "lark:start" }, "primary"),
			button("⏹ 停止", { op: "lark:stop" }),
			button("🔄 重启", { op: "lark:restart" }),
			button("📊 桥状态", { op: "lark:status" }),
			button("📱 扫码配置应用", { op: "lark:setup" }),
			button("⚠️ 清除凭据与状态", { op: "lark:uninstall-clean" }, "danger")
		] }
	};
}
/**
* Interactive directory browser for /workspace.
*
* Every navigation re-renders THIS card (the caller updates the same CardKit
* entity through `_panel_card_id`), so browsing never floods the chat. `..` is
* disabled when there is no parent (filesystem root); the conversation's
* current workspace is marked so the user can see where it stands.
*/
function workspaceBrowserCard(input) {
	const isCurrent = input.browsePath === input.workspacePath;
	const elements = [{
		tag: "markdown",
		content: `**当前浏览**\n\`${input.browsePath}\`${isCurrent ? "\n（就是当前工作区）" : `\n当前工作区: \`${input.workspacePath}\``}`
	}];
	const up = button("⬆️ 上一级", { op: input.parentPath ? `ws:up:${encodeURIComponent(input.parentPath)}` : "ws:up" });
	if (!input.parentPath) up.disabled = true;
	elements.push(up);
	elements.push({
		tag: "markdown",
		content: `**子目录**（${input.entries.length}${input.truncated ? "+" : ""}）`
	});
	if (input.entries.length === 0) elements.push({
		tag: "markdown",
		content: "（没有子目录）"
	});
	else {
		for (const entry of input.entries) elements.push(button(`📁 ${entry.name}`, { op: `ws:cd:${encodeURIComponent(entry.path)}` }));
		if (input.truncated) elements.push({
			tag: "markdown",
			content: "*(子目录过多，仅显示前若干个；可先用 `/files` 或进入子目录继续查看)*"
		});
	}
	const encodedBrowse = encodeURIComponent(input.browsePath);
	elements.push({ tag: "hr" });
	elements.push(button("✅ 切换到此目录", { op: `ws:pick:${encodedBrowse}` }, "primary"));
	elements.push(button("🆕 新建文件夹", { op: `ws:mk:${encodedBrowse}` }));
	elements.push(button("✖️ 取消（保持原工作区）", { op: "ws:cancel" }));
	return {
		schema: "2.0",
		header: {
			title: {
				tag: "plain_text",
				content: "选择工作区目录"
			},
			template: "blue"
		},
		body: { elements }
	};
}
/** New-folder form for the workspace browser (falls back to the text form). */
function workspaceNewFolderCard(input) {
	const encodedParent = encodeURIComponent(input.parentPath);
	return {
		schema: "2.0",
		header: {
			title: {
				tag: "plain_text",
				content: "新建文件夹"
			},
			template: "blue"
		},
		body: { elements: [
			{
				tag: "markdown",
				content: `在 \`${input.parentPath}\` 下新建目录。`
			},
			{
				tag: "form_container",
				children: [{
					tag: "input",
					name: "name",
					placeholder: {
						tag: "plain_text",
						content: "文件夹名称（不含路径分隔符）"
					}
				}],
				onSubmit: [{
					type: "callback",
					value: { op: `ws:mk:submit:${encodedParent}` }
				}]
			},
			button("↩️ 返回目录浏览", { op: `ws:back:${encodedParent}` }),
			{
				tag: "markdown",
				content: "表单不可用时，可直接发送 `/workspace mk <名称>`。"
			}
		] }
	};
}
/**
* 网站预览卡：链接按钮用 open_url（在飞书内打开，手机落内置浏览器），
* 刷新/关闭用 callback（服务端管理隧道生命周期）。
*/
function sitePreviewCard(input) {
	const now = input.now ?? Date.now();
	const minutes = Math.max(0, Math.round((input.expiresAt - now) / 6e4));
	const openButton = {
		tag: "button",
		width: "fill",
		text: {
			tag: "plain_text",
			content: "🌐 在飞书内打开"
		},
		type: "primary",
		behaviors: [{
			type: "open_url",
			default_url: `https://applink.feishu.cn/client/web_url/open?mode=window&url=${encodeURIComponent(input.publicUrl)}`
		}]
	};
	const debugButton = {
		tag: "button",
		width: "fill",
		text: {
			tag: "plain_text",
			content: "🐞 调试模式（vConsole）"
		},
		behaviors: [{
			type: "open_url",
			default_url: `${input.debugUrl}`
		}]
	};
	return {
		schema: "2.0",
		header: {
			title: {
				tag: "plain_text",
				content: `🌐 ${input.title}`
			},
			template: "turquoise"
		},
		body: { elements: [
			{
				tag: "markdown",
				content: `**${input.action}** · ${input.label}\n原始地址 \`${input.origin}\` · 约 ${minutes} 分钟后失效`
			},
			openButton,
			debugButton,
			button("🔄 刷新链接（地址会变）", { op: "site:refresh" }),
			button("🛑 关闭预览", { op: "site:stop" }, "danger"),
			{
				tag: "markdown",
				content: `直接链接：${input.publicUrl} · 调试：${input.debugUrl}`
			}
		] }
	};
}
function normalizePreviewTarget(req) {
	const port = typeof req.port === "number" && req.port > 0 ? req.port : void 0;
	if (req.url && port) throw new Error("url 与 port 只能二选一");
	if (req.url && req.dir) throw new Error("url 与 dir 只能二选一");
	if (port && req.dir) throw new Error("port 与 dir 只能二选一");
	if (req.url) {
		const parsed = new URL(req.url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("url 必须是 http/https 地址");
		const pathSuffix = parsed.pathname !== "/" ? parsed.pathname : void 0;
		return {
			kind: "url",
			target: `url:${`${parsed.origin}${parsed.pathname.replace(/\/$/, "")}`}`,
			localUrl: parsed.origin,
			pathSuffix,
			label: `URL ${parsed.host}`
		};
	}
	if (port) return {
		kind: "port",
		target: `port:${port}`,
		localUrl: `http://127.0.0.1:${port}`,
		label: `开发服务器 :${port}`
	};
	if (req.dir) {
		const dir = resolve(req.dir);
		if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`目录不存在或不是目录: ${dir}`);
		const real = realpathSync(dir);
		return {
			kind: "dir",
			target: `dir:${real}`,
			localUrl: "",
			serveDir: real,
			label: `静态目录 ${dir.split(/[\\/]/).pop() || dir}`
		};
	}
	throw new Error("需要提供 url、port 或 dir 之一");
}
/** Pure decision: reuse / restart / replace / create, per conversation. */
function decidePreviewAction(existing, target, alive, now) {
	if (!existing) return "create";
	if (existing.target !== target) return "replace";
	if (!alive || existing.expiresAt <= now) return "restart";
	return "reuse";
}
//#endregion
//#region src/preview/site-preview-net.ts
const MIME = {
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
	mp3: "audio/mpeg"
};
function startStaticServer(dir, logger) {
	const root = realpathSync(dir);
	const server = createServer((req, res) => {
		try {
			const raw = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
			let file = normalize(join(root, raw));
			if (!file.startsWith(root)) {
				res.writeHead(403).end("forbidden");
				return;
			}
			if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
			if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
				res.writeHead(404).end("not found");
				return;
			}
			const ext = file.split(".").pop()?.toLowerCase() ?? "";
			res.writeHead(200, {
				"content-type": MIME[ext] ?? "application/octet-stream",
				"cache-control": "no-cache"
			});
			res.end(readFileSync(file));
		} catch (err) {
			logger.warn(`preview static server error: ${err instanceof Error ? err.message : String(err)}`);
			try {
				res.writeHead(500).end("error");
			} catch {}
		}
	});
	return new Promise((resolvePromise) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			resolvePromise({
				port: typeof address === "object" && address ? address.port : 0,
				stop: () => server.close()
			});
		});
	});
}
function resolveCloudflared() {
	const candidates = [
		process.env.DSH_CLOUDFLARED,
		join(homedir(), ".local", "bin", "cloudflared"),
		"cloudflared"
	].filter(Boolean);
	for (const candidate of candidates) if (candidate.includes("/") || candidate.includes("\\")) {
		if (existsSync(candidate)) return candidate;
	} else if (!spawnSync(candidate, ["--version"], { encoding: "utf8" }).error) return candidate;
	throw new Error("cloudflared 未安装（在主机上运行 scripts/install-cloudflared.sh）");
}
function startTunnelProcess(localUrl, logPath, logger) {
	const bin = resolveCloudflared();
	try {
		mkdirSync(logPath.slice(0, Math.max(logPath.lastIndexOf("/"), 0)), { recursive: true });
	} catch {}
	const child = spawn(bin, [
		"tunnel",
		"--url",
		localUrl,
		"--no-autoupdate"
	], { stdio: [
		"ignore",
		"pipe",
		"pipe"
	] });
	let output = "";
	const collect = (chunk) => {
		output += String(chunk);
		if (output.length > 65536) output = output.slice(-32768);
	};
	child.stdout?.on("data", collect);
	child.stderr?.on("data", collect);
	const stop = () => {
		try {
			child.kill("SIGTERM");
		} catch {}
	};
	return new Promise((resolvePromise, rejectPromise) => {
		const started = Date.now();
		const poll = () => {
			const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(output);
			if (match) {
				resolvePromise({
					pid: child.pid ?? 0,
					publicUrl: match[0],
					stop
				});
				return;
			}
			if (child.exitCode !== null) {
				rejectPromise(/* @__PURE__ */ new Error(`cloudflared 提前退出：${output.slice(-200)}`));
				return;
			}
			if (Date.now() - started > 3e4) {
				stop();
				rejectPromise(/* @__PURE__ */ new Error("cloudflared 30 秒内未建立隧道"));
				return;
			}
			setTimeout(poll, 500);
		};
		setTimeout(poll, 800);
	});
}
//#endregion
//#region src/preview/site-preview-manager.ts
function createSitePreviewManager(deps) {
	const ttlMs = deps.ttlMs ?? 72e5;
	const now = deps.now ?? (() => Date.now());
	const registryPath = join(deps.stateDir, "site-previews.json");
	const entries = /* @__PURE__ */ new Map();
	const timers = /* @__PURE__ */ new Map();
	const logFileFor = (convKey) => join(deps.stateDir, `preview-tunnel-${convKey.replace(/[^a-z0-9]/gi, "-")}.log`);
	const persist = () => {
		try {
			const rows = [...entries.values()].map((entry) => {
				const { stopTunnel: _t, stopServer: _s, ...rest } = entry;
				return rest;
			});
			writeFileSync(registryPath, JSON.stringify(rows, null, 2), { mode: 384 });
		} catch (err) {
			deps.logger.warn(`preview registry persist failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	};
	const pidAlive = (pid) => {
		if (!pid) return false;
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};
	const teardown = (entry) => {
		const timer = timers.get(entry.convKey);
		if (timer) clearTimeout(timer);
		timers.delete(entry.convKey);
		entry.stopTunnel?.();
		entry.stopServer?.();
		entries.delete(entry.convKey);
	};
	const scheduleExpiry = (entry) => {
		const timer = setTimeout(() => {
			deps.logger.info(`preview expired for ${entry.convKey} — tearing down`);
			teardown(entry);
			persist();
		}, Math.max(0, entry.expiresAt - now()));
		timer.unref?.();
		timers.set(entry.convKey, timer);
	};
	const startAll = async (entry) => {
		let localUrl = entry.localUrl;
		let stopServer;
		if (entry.kind === "dir" && entry.serveDir) {
			const staticServer = await (deps.startStatic ?? startStaticServer)(entry.serveDir, deps.logger);
			localUrl = `http://127.0.0.1:${staticServer.port}`;
			entry.serverPort = staticServer.port;
			stopServer = staticServer.stop;
		}
		const tunnel = await (deps.startTunnel ?? startTunnelProcess)(localUrl, logFileFor(entry.convKey), deps.logger);
		entry.localUrl = localUrl;
		entry.publicUrl = `${tunnel.publicUrl}${entry.pathSuffix ?? ""}`;
		entry.debugUrl = `${entry.publicUrl}${entry.publicUrl.includes("?") ? "&" : "?"}debug=1`;
		entry.tunnelPid = tunnel.pid;
		entry.startedAt = now();
		entry.expiresAt = now() + ttlMs;
		entry.stopTunnel = tunnel.stop;
		entry.stopServer = stopServer;
	};
	try {
		const rows = JSON.parse(readFileSync(registryPath, "utf8"));
		for (const row of rows) if (row.expiresAt > now() && pidAlive(row.tunnelPid)) {
			const adopted = {
				...row,
				stopTunnel: () => {
					try {
						process.kill(row.tunnelPid, "SIGTERM");
					} catch {}
				}
			};
			entries.set(row.convKey, adopted);
			scheduleExpiry(adopted);
		}
		if (entries.size) deps.logger.info(`site preview: adopted ${entries.size} live tunnel(s) after reload`);
	} catch {}
	return {
		async publish(req) {
			const target = normalizePreviewTarget(req);
			const existing = entries.get(req.convKey);
			const alive = Boolean(existing && pidAlive(existing.tunnelPid) && existing.expiresAt > now());
			const action = decidePreviewAction(existing && {
				target: existing.target,
				expiresAt: existing.expiresAt
			}, target.target, alive, now());
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
					target: existing.target
				};
			}
			if (existing) teardown(existing);
			const entry = {
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
				...target.serveDir ? { serveDir: target.serveDir } : {},
				...target.pathSuffix ? { pathSuffix: target.pathSuffix } : {}
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
				target: entry.target
			};
		},
		async refresh(convKey, chatId) {
			const existing = entries.get(convKey);
			if (!existing) throw new Error("当前没有进行中的预览");
			const stale = { ...existing };
			teardown(existing);
			const entry = {
				...stale,
				chatId: chatId || stale.chatId
			};
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
				target: entry.target
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
			return entry ? { ...entry } : void 0;
		}
	};
}
//#endregion
//#region src/outbound/task-card-syncer.ts
function createTaskCardSyncer(opts) {
	const states = /* @__PURE__ */ new Map();
	const timers = /* @__PURE__ */ new Map();
	const inFlight = /* @__PURE__ */ new Set();
	const debounceMs = opts.debounceMs ?? 1500;
	const now = opts.now ?? Date.now;
	const ensureState = (sessionKey, workspacePath) => {
		let st = states.get(sessionKey);
		if (!st) {
			st = {
				sessionKey,
				sequence: 0,
				todos: [],
				workspacePath,
				isFolded: true,
				lastUpdatedAt: now()
			};
			states.set(sessionKey, st);
		}
		if (workspacePath) st.workspacePath = workspacePath;
		return st;
	};
	const extractCardId = (res) => res?.card_id ?? res?.data?.card_id;
	async function pushCard(sessionKey) {
		const st = states.get(sessionKey);
		if (!st) return;
		const timer = timers.get(sessionKey);
		if (timer) {
			clearTimeout(timer);
			timers.delete(sessionKey);
		}
		if (inFlight.has(sessionKey)) {
			scheduleDebounce(sessionKey);
			return;
		}
		inFlight.add(sessionKey);
		st.lastUpdatedAt = now();
		try {
			const cardPayload = buildTaskBoardCard(st);
			const cardJsonStr = JSON.stringify(cardPayload);
			if (!st.cardEntityId) {
				const createRes = await opts.api.createCard({
					type: "card_json",
					data: cardJsonStr
				});
				const cardId = extractCardId(createRes);
				if (!cardId) throw new Error("TaskCard create returned no card_id");
				st.cardEntityId = cardId;
				st.sequence = 1;
				if (opts.deliverCard && opts.routeFor) {
					const route = opts.routeFor(sessionKey);
					if (route?.chatId) await opts.deliverCard({
						chatId: route.chatId,
						cardId
					});
				} else await opts.api.deliverCard(cardId);
			} else {
				st.sequence += 1;
				await opts.api.updateCard(st.cardEntityId, {
					card: {
						type: "card_json",
						data: cardJsonStr
					},
					sequence: st.sequence,
					uuid: randomUUID()
				});
			}
		} catch (err) {
			opts.onError?.(err);
		} finally {
			inFlight.delete(sessionKey);
		}
	}
	function scheduleDebounce(sessionKey) {
		if (timers.has(sessionKey)) return;
		const timer = setTimeout(() => {
			timers.delete(sessionKey);
			pushCard(sessionKey);
		}, debounceMs);
		timers.set(sessionKey, timer);
	}
	async function updateGoal(sessionKey, goal, workspacePath) {
		const st = ensureState(sessionKey, workspacePath);
		st.goal = goal;
		if (goal.phase === "complete" || !st.cardEntityId) await pushCard(sessionKey);
		else scheduleDebounce(sessionKey);
	}
	async function updateTodos(sessionKey, todos, workspacePath) {
		const st = ensureState(sessionKey, workspacePath);
		st.todos = todos;
		const allCompleted = todos.length > 0 && todos.every((t) => t.status === "completed");
		if (!st.cardEntityId || allCompleted) await pushCard(sessionKey);
		else scheduleDebounce(sessionKey);
	}
	async function toggleFold(sessionKey, isFolded) {
		const st = states.get(sessionKey);
		if (!st) return;
		st.isFolded = isFolded ?? !st.isFolded;
		await pushCard(sessionKey);
	}
	function getState(sessionKey) {
		return states.get(sessionKey);
	}
	async function flush(sessionKey) {
		const timer = timers.get(sessionKey);
		if (timer) {
			clearTimeout(timer);
			timers.delete(sessionKey);
		}
		await pushCard(sessionKey);
	}
	function disposeSession(sessionKey) {
		const timer = timers.get(sessionKey);
		if (timer) {
			clearTimeout(timer);
			timers.delete(sessionKey);
		}
		states.delete(sessionKey);
		inFlight.delete(sessionKey);
	}
	return {
		updateGoal,
		updateTodos,
		toggleFold,
		getState,
		flush,
		disposeSession
	};
}
//#endregion
//#region src/outbound/command-panel-sync.ts
const extractCardId = (res) => res?.card_id ?? res?.data?.card_id;
/**
* CardKit reports business failures as `{ code, msg }` (usually non-zero code)
* instead of an HTTP error. The SDK resolves those normally, so an invalid card
* or a rejected update used to look like a success and the caller silently did
* nothing. Surface them as real errors so the caller can fall back.
*/
const cardkitError = (res) => {
	if (!res || typeof res !== "object") return void 0;
	const r = res;
	const code = r.code ?? r.data?.code;
	if (typeof code === "number" && code !== 0) return `cardkit error ${code}: ${String(r.msg ?? r.data?.msg ?? "unknown")}`;
};
/** Single-line form — panel HEADERS only (command names are short). */
const oneLine = (value, limit = 180) => String(value || "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, limit);
/**
* Body form used inside a panel. Interior newlines are MEANINGFUL here: the
* old implementation ran every command result through oneLine(), which folded
* multi-line output (e.g. the /status detail block) into a single 180-character
* string and silently discarded the remainder. Bodies are now only trimmed at
* the edges and capped at PANEL_TEXT_LIMIT — anything larger is handed back to
* the durable text channel instead of being clipped (see append()).
*/
const PANEL_TEXT_LIMIT = 4e3;
const panelText = (value, limit = PANEL_TEXT_LIMIT) => String(value || "").replace(/\r\n?/g, "\n").trim().slice(0, limit);
function createCommandPanelSync(api, now = Date.now) {
	const states = /* @__PURE__ */ new Map();
	const byCardId = /* @__PURE__ */ new Map();
	const liveTimers = /* @__PURE__ */ new Map();
	const stateKey = (chatId, id) => `${chatId}\u0000${id}`;
	const cardSequences = /* @__PURE__ */ new Map();
	const nextSequence = (cardId, state) => {
		state.seq += 1;
		const last = cardSequences.get(cardId) ?? 0;
		if (state.seq <= last) state.seq = last + 1;
		cardSequences.set(cardId, state.seq);
		return state.seq;
	};
	const queue = async (state, op) => {
		const run = state.tail.then(op, op);
		state.tail = run.then(() => void 0, () => void 0);
		return run;
	};
	const update = async (state, card) => {
		if (!state.cardId || !api.updateCard) throw new Error("CardKit command panel update unavailable");
		const sequence = nextSequence(state.cardId, state);
		const res = await api.updateCard(state.cardId, {
			card: {
				type: "card_json",
				data: JSON.stringify(card)
			},
			sequence,
			uuid: randomUUID()
		});
		const failure = cardkitError(res);
		if (failure) throw new Error(failure);
	};
	const create = async (state, card) => {
		const created = await api.createCard({
			type: "card_json",
			data: JSON.stringify(card)
		});
		const failure = cardkitError(created);
		if (failure) throw new Error(failure);
		state.cardId = extractCardId(created);
		if (!state.cardId) throw new Error("CardKit command panel create returned no card_id");
		cardSequences.set(state.cardId, 0);
		byCardId.set(state.cardId, state);
		await api.deliverCard(state.cardId, state.chatId);
	};
	const stopTimer = (key) => {
		const timer = liveTimers.get(key);
		if (timer) clearInterval(timer);
		liveTimers.delete(key);
	};
	const ensureState = (chatId, id, command) => {
		const key = stateKey(chatId, id);
		let state = states.get(key);
		if (!state) {
			state = {
				chatId,
				id,
				command: oneLine(command, 48),
				seq: 0,
				startedAt: now(),
				tail: Promise.resolve()
			};
			states.set(key, state);
		}
		return state;
	};
	const collapseState = async (state, result, status = "ok") => {
		stopTimer(stateKey(state.chatId, state.id));
		await queue(state, async () => {
			const card = status === "error" ? commandFailedCard(state.command, panelText(result)) : commandCollapsedCard(state.command, panelText(result));
			if (state.cardId) await update(state, card);
			else await create(state, card);
		});
	};
	return {
		async start(chatId, id, command) {
			if (!chatId || !id) return false;
			const state = ensureState(chatId, id, command);
			state.startedAt = now();
			const key = stateKey(chatId, id);
			stopTimer(key);
			try {
				await queue(state, async () => {
					const card = commandRunningCard(state.command, 0);
					if (state.cardId) await update(state, card);
					else await create(state, card);
				});
				const timer = setInterval(() => {
					const elapsed = Math.max(0, Math.floor((now() - state.startedAt) / 1e3));
					queue(state, () => update(state, commandRunningCard(state.command, elapsed))).catch(() => void 0);
				}, 1e3);
				timer.unref?.();
				liveTimers.set(key, timer);
				return true;
			} catch {
				return false;
			}
		},
		async append(chatId, entry) {
			if (!chatId) return false;
			const id = entry.id ?? randomUUID();
			const state = ensureState(chatId, id, entry.command);
			const oversized = String(entry.result ?? "").length > PANEL_TEXT_LIMIT;
			try {
				await collapseState(state, oversized ? "内容较长，已单独发送（见下条消息）" : entry.result, entry.status);
				return !oversized;
			} catch {
				return false;
			}
		},
		async showCard(chatId, id, command, card) {
			const state = ensureState(chatId, id, command);
			stopTimer(stateKey(chatId, id));
			try {
				await queue(state, async () => {
					if (!state.cardId) await create(state, commandRunningCard(state.command, 0));
					await update(state, commandInteractivePanelCard(state.command, card, state.cardId));
				});
				return true;
			} catch {
				return false;
			}
		},
		adopt(chatId, id, cardId, command) {
			if (!chatId || !id || !cardId) return;
			const state = ensureState(chatId, id, command);
			const previous = byCardId.get(cardId);
			if (previous && previous !== state) {
				if (previous.seq > state.seq) state.seq = previous.seq;
				previous.cardId = void 0;
			}
			state.cardId = cardId;
			byCardId.set(cardId, state);
		},
		async replace(cardId, command, card) {
			let state = byCardId.get(cardId);
			if (!state) {
				state = {
					chatId: "",
					id: `card:${cardId}`,
					command,
					cardId,
					seq: 0,
					startedAt: now(),
					tail: Promise.resolve()
				};
				byCardId.set(cardId, state);
			}
			await queue(state, () => update(state, commandInteractivePanelCard(command, card, cardId)));
		},
		async collapse(cardId, command, result, status = "ok") {
			let state = byCardId.get(cardId);
			if (!state) {
				state = {
					chatId: "",
					id: `card:${cardId}`,
					command,
					cardId,
					seq: 0,
					startedAt: now(),
					tail: Promise.resolve()
				};
				byCardId.set(cardId, state);
			}
			const body = panelText(result);
			await queue(state, () => update(state, status === "error" ? commandFailedCard(command, body) : commandCollapsedCard(command, body)));
		},
		async cancel(chatId, id) {
			const key = stateKey(chatId, id);
			stopTimer(key);
			const state = states.get(key);
			if (state?.cardId) await collapseState(state, "已转交会话处理").catch(() => void 0);
		},
		clear(chatId) {
			for (const [key, state] of states) if (!chatId || state.chatId === chatId) {
				stopTimer(key);
				states.delete(key);
				if (state.cardId) byCardId.delete(state.cardId);
			}
		}
	};
}
//#endregion
//#region src/host/auth-setup.ts
/** Bridge-required event subscription: message arrival. */
const REQUIRED_EVENT = "im.message.receive_v1";
/** Bridge-dependent permission scopes (message + group-all + reactions). */
const SETUP_SCOPES = [
	"im:message",
	"im:message.send_as_bot",
	"im:chat",
	"im:resource",
	"im:message.group_msg",
	"im:message.reactions:write_only"
];
/** Pure function — unit-testable addon builder. */
function buildSetupAddons() {
	return {
		scopes: { tenant: [...SETUP_SCOPES] },
		events: { items: { tenant: [REQUIRED_EVENT] } },
		callbacks: { items: ["card.action.trigger"] }
	};
}
/** Detect Lark (international) vs Feishu (China) from the registerApp result. */
function detectDomain(userInfo) {
	return userInfo?.tenant_brand === "lark" ? "lark" : "feishu";
}
function createAuthSetup(deps) {
	return { async run(opts) {
		opts.onStatusChange?.("创建应用中…");
		const created = await deps.registerApp({
			source: "dsh-lark-link",
			addons: buildSetupAddons(),
			onQRCodeReady: (info) => opts.onQRCodeReady(info),
			onStatusChange: (info) => opts.onStatusChange?.(info.status ?? "…")
		});
		const appId = created.client_id ?? "";
		const appSecret = created.client_secret ?? "";
		if (!appId || !appSecret) throw new Error("registerApp 未返回 client_id/client_secret");
		const domain = detectDomain(created.user_info);
		opts.onStatusChange?.("校验事件订阅…");
		await deps.persist({
			appId,
			appSecret,
			domain
		});
		opts.onStatusChange?.("完成 ✅");
		return {
			appId,
			appSecret,
			domain
		};
	} };
}
/** base64url(gzip(addons)) — matches the SDK's encodeAddons encoding. */
function encodeAddons(addons) {
	const json = JSON.stringify(addons);
	return gzipSync(Buffer.from(json, "utf8")).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function postForm(url, params, signal) {
	let res;
	try {
		res = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Accept: "application/json",
				"User-Agent": "dsh-lark-link (device-code client)"
			},
			body: new URLSearchParams(params).toString(),
			signal
		});
	} catch (err) {
		throw new Error(`registration request failed: ${err instanceof Error ? err.message : String(err)}`);
	}
	let data;
	try {
		data = await res.json();
	} catch {
		data = {};
	}
	if (!res.ok && !data.error) throw new Error(`registration request failed: HTTP ${res.status}`);
	return data;
}
function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(/* @__PURE__ */ new Error("Registration was aborted"));
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		const onAbort = () => {
			cleanup();
			reject(/* @__PURE__ */ new Error("Registration was aborted"));
		};
		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
/**
* registerApp implementation over global fetch. Wire protocol mirrors
* @larksuiteoapi/node-sdk's registerApp (device-code flow against
* accounts.feishu.cn / accounts.larksuite.com), so the QR and created-app
* payload are byte-compatible with the SDK path.
*/
function registerAppWithFetch() {
	return async (options) => {
		const { source, signal, onQRCodeReady, onStatusChange, addons } = options;
		const baseUrl = "https://accounts.feishu.cn";
		const larkBaseUrl = "https://accounts.larksuite.com";
		const endpoint = "/oauth/v1/app/registration";
		const beginRes = await postForm(baseUrl + endpoint, {
			action: "begin",
			archetype: "PersonalAgent",
			auth_method: "client_secret",
			request_user_info: "open_id"
		}, signal);
		const verificationUri = beginRes.verification_uri_complete;
		if (typeof verificationUri !== "string" || verificationUri === "") throw new Error(beginRes.error_description ?? "registerApp begin 未返回 verification_uri_complete");
		let qrUrl;
		try {
			qrUrl = new URL(verificationUri);
		} catch {
			throw new Error(`registerApp begin 返回了无效的 verification_uri_complete: ${verificationUri.slice(0, 80)}`);
		}
		qrUrl.searchParams.set("from", "sdk");
		qrUrl.searchParams.set("source", `node-sdk/${source}`);
		qrUrl.searchParams.set("tp", "sdk");
		if (addons) qrUrl.searchParams.set("addons", encodeAddons(addons));
		onQRCodeReady({
			url: qrUrl.toString(),
			expireIn: beginRes.expires_in ?? 600
		});
		const deviceCode = beginRes.device_code;
		if (!deviceCode) throw new Error("registerApp begin 未返回 device_code");
		let currentBase = baseUrl;
		let interval = (beginRes.interval ?? 5) * 1e3;
		const deadline = Date.now() + (beginRes.expires_in ?? 600) * 1e3;
		let domainSwitched = false;
		while (Date.now() < deadline) {
			if (signal?.aborted) throw new Error("Registration was aborted");
			const pollRes = await postForm(currentBase + endpoint, {
				action: "poll",
				device_code: deviceCode
			}, signal);
			const userInfo = pollRes.user_info;
			if (userInfo?.tenant_brand === "lark" && !domainSwitched) {
				currentBase = larkBaseUrl;
				domainSwitched = true;
				onStatusChange?.({ status: "domain_switched" });
				continue;
			}
			const clientId = pollRes.client_id;
			const clientSecret = pollRes.client_secret;
			if (clientId && clientSecret) return {
				client_id: clientId,
				client_secret: clientSecret,
				user_info: userInfo
			};
			switch (pollRes.error) {
				case "authorization_pending":
					onStatusChange?.({ status: "polling" });
					break;
				case "slow_down":
					interval += 5e3;
					onStatusChange?.({
						status: "slow_down",
						interval: interval / 1e3
					});
					break;
				case "access_denied":
				case "expired_token": throw new Error(pollRes.error_description ?? `注册失败：${String(pollRes.error)}`);
				default: if (pollRes.error) throw new Error(pollRes.error_description ?? `注册失败：${String(pollRes.error)}`);
			}
			await sleep(interval, signal);
		}
		throw new Error("注册轮询超时（二维码已过期），请重新运行 /lark setup");
	};
}
//#endregion
//#region src/host/lark-client.ts
/** Validate credentials submitted by the authenticated local Web UI. */
function normalizeManualCredentials(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("凭据请求必须是对象");
	const input = value;
	const appId = String(input.appId ?? "").trim();
	const appSecret = String(input.appSecret ?? "").trim();
	const domain = input.domain === "lark" ? "lark" : "feishu";
	if (!/^cli_[A-Za-z0-9_-]{4,128}$/.test(appId)) throw new TypeError("App ID 格式无效，应以 cli_ 开头");
	if (appSecret.length < 8 || appSecret.length > 256 || /[\s\u0000-\u001f\u007f]/.test(appSecret)) throw new TypeError("App Secret 格式无效");
	return {
		appId,
		appSecret,
		domain
	};
}
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
function isValidRef(ref) {
	return REF_PATTERN.test(ref);
}
/** Parse the stored JSON blob into credentials; undefined if absent/malformed. */
function parseCredentials(raw) {
	if (!raw) return void 0;
	try {
		const parsed = JSON.parse(raw);
		if (parsed.appId && parsed.appSecret) return {
			appId: parsed.appId,
			appSecret: parsed.appSecret,
			domain: parsed.domain === "lark" ? "lark" : "feishu"
		};
	} catch {}
}
async function resolveCredentials(store, ref) {
	return parseCredentials((await store.resolve(ref))?.value);
}
async function persistCredentials(store, ref, creds) {
	if (!isValidRef(ref)) throw new TypeError(`credential ref "${ref}" must match ${String(REF_PATTERN)}`);
	await store.set(ref, JSON.stringify(creds));
}
async function clearCredentials(store, ref) {
	await store.unset(ref);
}
/** Default loader: dynamic import of the real SDK (kept out of test paths). */
const defaultSdkLoader = async () => await import("@larksuiteoapi/node-sdk");
/**
* Build a FeishuClientLike backed by the real SDK. Event handlers attach via
* `.on()` (forwarded to the EventDispatcher); `ws.start()` boots the WSClient
* with that dispatcher; send/probe/upload calls translate to SDK shapes.
*/
async function buildLarkClient(opts) {
	const sdk = await (opts.sdkLoader ?? defaultSdkLoader)();
	const domain = opts.domain === "lark" ? sdk.Domain.Lark : sdk.Domain.Feishu;
	const dh = sdk.defaultHttpInstance;
	if (dh?.defaults) dh.defaults.proxy = false;
	const clientOpts = {
		appId: opts.appId,
		appSecret: opts.appSecret,
		appType: sdk.AppType.SelfBuild,
		domain,
		loggerLevel: sdk.LoggerLevel.error
	};
	const sdkClient = new sdk.Client(clientOpts);
	const dispatcher = new sdk.EventDispatcher({ loggerLevel: sdk.LoggerLevel.error });
	const wsClient = new sdk.WSClient(clientOpts);
	return {
		on(event, handler) {
			dispatcher.register({ [event]: handler });
		},
		ws: {
			start() {
				try {
					wsClient.start({ eventDispatcher: dispatcher });
				} catch (err) {
					opts.logger?.error(`wsClient.start failed: ${err instanceof Error ? err.message : String(err)}`);
				}
			},
			stop() {
				Promise.resolve(wsClient.stop?.()).catch(() => void 0);
			}
		},
		async getBotInfo() {
			const res = await sdkClient.request({
				url: "/open-apis/bot/v3/info",
				method: "GET"
			});
			const bot = res?.bot ?? (res?.data)?.bot;
			return {
				open_id: bot?.open_id ?? (res?.data)?.open_id,
				name: bot?.app_name
			};
		},
		async sendMessage(params) {
			const p = params;
			return sdkClient.im.message.create({
				params: { receive_id_type: p.receive_id_type },
				data: p.params
			});
		},
		async addReaction(params) {
			const p = params;
			return sdkClient.im.messageReaction.create({
				path: { message_id: p.message_id },
				data: { reaction_type: { emoji_type: p.emoji_type } }
			});
		},
		async listMessages(params) {
			const p = params;
			const res = await sdkClient.im.message.list({ params: {
				...p,
				page_size: 50
			} });
			return { items: (res?.items ?? (res?.data)?.items ?? []).map((i) => ({
				message_id: i.message_id,
				create_time: i.create_time
			})) };
		},
		async uploadFile(params) {
			const p = params;
			const fileType = {
				pdf: "pdf",
				doc: "doc",
				docx: "doc",
				xls: "xls",
				xlsx: "xls",
				ppt: "ppt",
				pptx: "ppt",
				mp4: "mp4",
				opus: "opus"
			}[(p.file_name ?? "").split(".").pop()?.toLowerCase() ?? ""] ?? "stream";
			return sdkClient.im.file.create({ data: {
				file_type: fileType,
				file_name: p.file_name ?? "file",
				file: p.file
			} });
		},
		async uploadImage(params) {
			const p = params;
			return sdkClient.im.image.create({ data: {
				image_type: "message",
				image: p.image
			} });
		},
		async downloadResource(params) {
			const p = params;
			const mr = sdkClient.im?.messageResource;
			let stream;
			if (mr?.get) stream = (await mr.get({
				path: {
					message_id: p.messageId,
					file_key: p.fileKey
				},
				params: { type: p.type }
			}))?.getReadableStream?.();
			else {
				const res = await sdkClient.request({
					url: `/open-apis/im/v1/messages/${p.messageId}/resources/${p.fileKey}`,
					method: "GET",
					params: { type: p.type },
					responseType: "stream"
				});
				stream = res?.getReadableStream?.() ?? res?.data;
			}
			if (!stream) throw new Error(`downloadResource: no stream for ${p.fileKey}`);
			const chunks = [];
			for await (const chunk of stream) chunks.push(Buffer.from(chunk));
			return Buffer.concat(chunks);
		},
		async cardkitCreateCard(payload) {
			return await sdkClient.request({
				url: "/open-apis/cardkit/v1/cards",
				method: "POST",
				data: payload
			});
		},
		async cardkitDeliverCard(params) {
			const p = params;
			return sdkClient.im.message.create({
				params: { receive_id_type: p.chatId.startsWith("oc_") ? "chat_id" : "open_id" },
				data: {
					receive_id: p.chatId,
					msg_type: "interactive",
					content: JSON.stringify({
						type: "card",
						data: { card_id: p.cardId }
					})
				}
			});
		},
		async cardkitStreamText(cardId, elementId, body) {
			return sdkClient.request({
				url: `/open-apis/cardkit/v1/cards/${cardId}/elements/${elementId}/content`,
				method: "PUT",
				data: body
			});
		},
		async cardkitPatchSettings(cardId, body) {
			return sdkClient.request({
				url: `/open-apis/cardkit/v1/cards/${cardId}/settings`,
				method: "PATCH",
				data: body
			});
		},
		async cardkitUpdateCard(cardId, body) {
			return sdkClient.request({
				url: `/open-apis/cardkit/v1/cards/${cardId}`,
				method: "PUT",
				data: body
			});
		}
	};
}
//#endregion
//#region src/common/paths.ts
/** True for a path that is absolute on the CURRENT platform OR Windows-shaped
* (drive letter / UNC) — a superset check so drive paths never get joined
* under a Unix cwd (GH #7). */
function isAbsoluteAny(p) {
	return isAbsolute(p) || win32.isAbsolute(p);
}
/**
* Resolve a /workspace argument against the current workspace (GH #7).
* - `~` / `~/…` expands to the user's home directory
* - absolute (posix OR windows drive/UNC) stays verbatim (normalized)
* - anything else joins onto curWs
*/
function resolveWorkspaceTarget(arg, curWs) {
	const expanded = arg === "~" || arg.startsWith("~/") ? join(homedir(), arg.slice(arg.startsWith("~/") ? 2 : 1)) : arg;
	if (!isAbsoluteAny(expanded)) return resolve(join(curWs, expanded));
	if (win32.isAbsolute(expanded) && !isAbsolute(expanded)) return win32.normalize(expanded);
	return resolve(expanded);
}
/**
* Parent directory, or undefined when `p` already IS a filesystem root.
* `dirname()` is platform-correct: it maps "/" → "/" on posix and "C:\\" →
* "C:\\" (and UNCs to their share root) on Windows, so the browser can offer
* ".." exactly while ascending is still possible.
*/
function parentDirectory(p) {
	const dir = dirname(p);
	return dir === p ? void 0 : dir;
}
/**
* Validate ONE directory name typed by the user (new-folder form / text form).
* Rejects anything that could escape the intended parent or break a path:
* separators, "." / "..", control characters, Windows-reserved punctuation and
* overlong names. Throws with a user-facing message.
*/
function sanitizeDirectoryName(value) {
	const name = String(value ?? "").trim();
	if (!name) throw new Error("文件夹名称不能为空");
	if (name === "." || name === "..") throw new Error("文件夹名称无效");
	if (/[\\/]/.test(name)) throw new Error("文件夹名称不能包含路径分隔符");
	if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error("文件夹名称不能包含控制字符");
	if (/[<>:"|?*]/.test(name)) throw new Error("文件夹名称不能包含 < > : \" | ? * 等字符");
	if (name.length > 100) throw new Error("文件夹名称过长（最多 100 字符）");
	return name;
}
/**
* Decode a URI-encoded path carried by a card callback op. Card actions split
* the op at the FIRST ":" and conversation keys/paths contain colons, so paths
* travel encoded; malformed input falls back to the raw value.
*/
function decodeOpPath(value) {
	const raw = String(value ?? "");
	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
}
function resolveInWorkspacePath(p, root) {
	const abs = isAbsoluteAny(p) ? resolveWorkspaceTarget(p, root) : resolve(join(root, p));
	const rel = win32.isAbsolute(root) || win32.isAbsolute(abs) ? win32.relative(root, abs) : relative(root, abs);
	return {
		abs,
		ok: rel === "" || !rel.startsWith("..") && !isAbsolute(rel) && !win32.isAbsolute(rel)
	};
}
//#endregion
//#region src/index.ts
const name = "dsh-lark-link";
const inject = [
	"tools",
	"commands",
	"agents",
	"systemPrompt",
	"credentials",
	"webServer"
];
async function readWebJson(req, limit = 16384) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
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
function sendWebJson(res, status, value) {
	const r = res;
	r.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store"
	});
	r.end(JSON.stringify(value));
}
/** Bridge state directory (<DSH_HOME>/lark-link, overridable). */
function stateDir() {
	return process.env.DSH_LARK_LINK_HOME ?? join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "lark-link");
}
function apply(ctx, rawConfig) {
	const cfg = rawConfig;
	if (cfg?.enabled === false) return;
	const dir = stateDir();
	mkdirSync(dir, { recursive: true });
	const logger = createLogger("lark-link");
	const configStore = createConfigStore(dir, {
		groupPolicy: cfg?.groupPolicy,
		denyList: cfg?.denyList
	});
	const status = createStatusStore(join(dir, "status.json"));
	const routeStore = createRouteStore(join(dir, "routes.json"));
	const userUsage = createUserUsageStore(join(dir, "user-usage.json"));
	const sessionAliases = createSessionAliasStore(join(dir, "session-aliases.json"));
	const dedupe = createDedupeStore(join(dir, "dedupe.jsonl"));
	const taskRegistry = createTaskRegistry(join(dir, "tasks.json"));
	const inboundWal = createInboundWal({ dir: join(dir, "inbound-wal") });
	const getCfg = () => configStore.get();
	const convCfg = createConversationConfigStore(join(dir, "conversation-overrides.json"));
	const liveModelSelection = {
		provider: "",
		model: ""
	};
	const admService = ctx.get?.("agentDefaultModel");
	const llmService = ctx.get?.("llm");
	let modelCatalogCache;
	const listModelCatalog = async () => {
		if (modelCatalogCache && modelCatalogCache.expiresAt > Date.now()) return modelCatalogCache.groups;
		const groups = [];
		for (const provider of llmService?.listProviders?.() ?? []) {
			const providerId = provider.id ?? "";
			if (!providerId) continue;
			try {
				const models = await llmService?.listModels?.(providerId) ?? [];
				if (models.length > 0) groups.push({
					provider: providerId,
					label: provider.name ?? providerId,
					models
				});
			} catch {}
		}
		modelCatalogCache = {
			expiresAt: Date.now() + 3e4,
			groups
		};
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
	const effectiveBridgeDefault = () => pickEffectiveDefault(getCfg().modelAccess, liveModelSelection.provider && liveModelSelection.model ? liveModelSelection : void 0);
	const liveModels = /* @__PURE__ */ new Map();
	const liveModelFor = (key) => {
		let m = liveModels.get(key);
		if (!m) {
			const o = convCfg.get(key);
			const requested = o.provider && o.model ? {
				provider: o.provider,
				model: o.model
			} : effectiveBridgeDefault();
			const selected = requested && isModelAllowed(getCfg().modelAccess, requested) ? requested : effectiveBridgeDefault();
			m = {
				provider: selected?.provider ?? "",
				model: selected?.model ?? "",
				reasoningEffort: o.reasoningEffort ?? liveModelSelection.reasoningEffort,
				override: Boolean(o.provider && o.model && isModelAllowed(getCfg().modelAccess, {
					provider: o.provider,
					model: o.model
				}))
			};
			liveModels.set(key, m);
		}
		return m;
	};
	const runNonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
	let backend;
	try {
		backend = createDshAdapter({
			ctx,
			sessionPrefix: "lark-link",
			runNonce,
			logger,
			cwd: (key) => workspaceForTaskKey(key),
			preset: (key) => {
				return convCfg.get(key).preset ?? (getCfg().agentPreset || "code");
			},
			modelSelection: { currentFor: (key) => {
				const m = liveModelFor(conversationKeyOf(key));
				if (m.provider && m.model && isModelAllowed(getCfg().modelAccess, m)) return m;
				const fallback = effectiveBridgeDefault();
				if (!fallback) return void 0;
				m.provider = fallback.provider;
				m.model = fallback.model;
				delete m.reasoningEffort;
				m.override = false;
				return m;
			} },
			activeSessionId: (key) => convCfg.get(key).activeSessionId,
			setActiveSessionId: (key, sessionId) => {
				convCfg.set(key, { activeSessionId: sessionId });
			},
			askUserQuestion,
			permissionMode: () => getCfg().permissionMode
		});
	} catch (err) {
		logger.warn(`DSH adapter unavailable — using in-memory backend: ${String(err)}`);
		backend = createMemoryDshBackend();
	}
	let larkClient;
	const getLarkClient = () => larkClient;
	const credStore = {
		resolve: (ref) => ctx.credentials?.resolve(ref) ?? Promise.resolve(void 0),
		set: (ref, value) => ctx.credentials?.set(ref, value) ?? Promise.resolve(),
		unset: (ref) => ctx.credentials?.unset(ref) ?? Promise.resolve()
	};
	let startBlocker;
	const maskId = (id) => id.length <= 8 ? "****" : `${id.slice(0, 6)}…${id.slice(-4)}`;
	let applyManualCredentials;
	let applyBridgeControl;
	let applyBridgePolicy;
	let activeQr;
	const webServer = ctx.webServer;
	if (webServer) {
		ctx.effect(() => webServer.register({
			kind: "exact",
			path: "/plugins/lark-link/qr",
			handler: (_req, res) => {
				const r = res;
				if (activeQr && Date.now() < activeQr.expireAt) {
					r.writeHead(200, {
						"Content-Type": "image/png",
						"Cache-Control": "no-store"
					});
					r.end(activeQr.png);
				} else {
					r.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
					r.end("no active lark-link setup qr (run /lark setup)");
				}
			}
		}), "lark-link: webui qr route");
		ctx.effect(() => webServer.register({
			kind: "exact",
			path: "/plugins/lark-link/status",
			handler: async (_req, res) => {
				const r = res;
				const credentials = await resolveCredentials(credStore, getCfg().credentialRef);
				r.writeHead(200, {
					"Content-Type": "application/json; charset=utf-8",
					"Cache-Control": "no-store"
				});
				r.end(JSON.stringify({
					...status.get(),
					configured: Boolean(credentials),
					...credentials ? {
						appIdMasked: maskId(credentials.appId),
						domain: credentials.domain
					} : {}
				}));
			}
		}), "lark-link: webui status route");
		ctx.effect(() => webServer.register({
			kind: "exact",
			path: "/plugins/lark-link/credentials",
			handler: async (req, res) => {
				if (req.method !== "POST") {
					sendWebJson(res, 405, {
						ok: false,
						error: "仅支持 POST"
					});
					return;
				}
				try {
					if (!applyManualCredentials) throw new Error("Lark Link 尚未完成初始化");
					sendWebJson(res, 200, {
						ok: true,
						...await applyManualCredentials(await readWebJson(req))
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : "手动配置失败";
					sendWebJson(res, error instanceof TypeError ? 400 : 500, {
						ok: false,
						error: message
					});
				}
			}
		}), "lark-link: webui manual credentials route");
		ctx.effect(() => webServer.register({
			kind: "exact",
			path: "/plugins/lark-link/management",
			handler: async (req, res) => {
				if (req.method !== "GET") {
					sendWebJson(res, 405, {
						ok: false,
						error: "仅支持 GET"
					});
					return;
				}
				const credentials = await resolveCredentials(credStore, getCfg().credentialRef);
				const users = userUsage.list().map((usage) => {
					const overrides = convCfg.get(usage.sessionKey);
					const route = routeStore.get(usage.sessionKey);
					return {
						...usage,
						activeSessionId: overrides.activeSessionId ?? route?.sessionId,
						workspaceRoot: overrides.workspaceRoot ?? getCfg().workspaceRoot,
						provider: overrides.provider,
						model: overrides.model,
						reasoningEffort: overrides.reasoningEffort,
						preset: overrides.preset
					};
				});
				const modelCatalog = await listModelCatalog();
				sendWebJson(res, 200, {
					ok: true,
					instance: {
						host: hostname(),
						pid: process.pid
					},
					app: credentials ? {
						appIdMasked: maskId(credentials.appId),
						domain: credentials.domain
					} : null,
					status: status.get(),
					policy: {
						modelAccess: getCfg().modelAccess,
						workspaceRoot: getCfg().workspaceRoot,
						effectiveDefaultModel: effectiveBridgeDefault() ? modelRef(effectiveBridgeDefault()) : ""
					},
					modelCatalog,
					users
				});
			}
		}), "lark-link: webui management route");
		ctx.effect(() => webServer.register({
			kind: "exact",
			path: "/plugins/lark-link/control",
			handler: async (req, res) => {
				if (req.method !== "POST") {
					sendWebJson(res, 405, {
						ok: false,
						error: "仅支持 POST"
					});
					return;
				}
				try {
					const body = await readWebJson(req);
					const action = String(body.action ?? "");
					if (!applyBridgeControl) throw new Error("Lark Link 尚未完成初始化");
					if (![
						"start",
						"stop",
						"restart"
					].includes(action)) throw new TypeError("不支持的管理操作");
					sendWebJson(res, 200, {
						ok: true,
						...await applyBridgeControl(action)
					});
				} catch (error) {
					sendWebJson(res, error instanceof TypeError ? 400 : 500, {
						ok: false,
						error: error instanceof Error ? error.message : "管理操作失败"
					});
				}
			}
		}), "lark-link: webui management control route");
		ctx.effect(() => webServer.register({
			kind: "exact",
			path: "/plugins/lark-link/policy",
			handler: async (req, res) => {
				if (req.method !== "POST") {
					sendWebJson(res, 405, {
						ok: false,
						error: "仅支持 POST"
					});
					return;
				}
				try {
					if (!applyBridgePolicy) throw new Error("Lark Link 尚未完成初始化");
					sendWebJson(res, 200, {
						ok: true,
						...await applyBridgePolicy(await readWebJson(req))
					});
				} catch (error) {
					sendWebJson(res, error instanceof TypeError ? 400 : 500, {
						ok: false,
						error: error instanceof Error ? error.message : "策略保存失败"
					});
				}
			}
		}), "lark-link: webui app policy route");
	}
	const sender = {
		async replyTo(msg, textOrCard) {
			const text = typeof textOrCard === "string" ? textOrCard : JSON.stringify(textOrCard);
			if (typeof textOrCard === "string") await sender.sendText(msg.chatId, text);
			else await sender.sendCard(msg.chatId, textOrCard);
		},
		async sendText(chatId, text) {
			const client = getLarkClient();
			if (!client?.sendMessage) throw new Error("lark client not ready");
			if (looksLikeMarkdown(text) && text.length <= 28e3) {
				await client.sendMessage({
					receive_id_type: chatId.startsWith("oc_") ? "chat_id" : "open_id",
					params: {
						receive_id: chatId,
						msg_type: "interactive",
						content: JSON.stringify(markdownCard(text))
					}
				});
				return;
			}
			await client.sendMessage({
				receive_id_type: chatId.startsWith("oc_") ? "chat_id" : "open_id",
				params: {
					receive_id: chatId,
					msg_type: "text",
					content: JSON.stringify({ text })
				}
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
					content: JSON.stringify(card)
				}
			});
		},
		async addReaction(messageId, emojiType) {
			const client = getLarkClient();
			if (!client?.addReaction) throw new Error("lark client not ready");
			await client.addReaction({
				message_id: messageId,
				emoji_type: emojiType
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
					content: JSON.stringify(type === "image" ? { image_key: fileKey } : { file_key: fileKey })
				}
			});
		},
		async listMessages({ chatId, startTimeMs, endTimeMs }) {
			const client = getLarkClient();
			if (!client?.listMessages) return [];
			return ((await client.listMessages({
				container_id_type: "chat",
				container_id: chatId,
				start_time: String(startTimeMs),
				end_time: String(endTimeMs)
			})).items ?? []).map((i) => ({
				messageId: i.message_id ?? "",
				timestampMs: Number(i.create_time ?? 0)
			}));
		}
	};
	const bridge = createBridgeContext({
		logger,
		cfg: getCfg,
		configStore,
		status,
		backend,
		router: routeStore,
		sender,
		attachmentsRef: () => ctx.get?.("attachments")
	});
	const commandPanelSync = createCommandPanelSync({
		createCard: async (payload) => {
			const client = getLarkClient();
			if (!client?.cardkitCreateCard) throw new Error("CardKit unavailable");
			return client.cardkitCreateCard(payload);
		},
		deliverCard: async (cardId, chatId) => {
			const client = getLarkClient();
			if (!client?.cardkitDeliverCard) throw new Error("CardKit unavailable");
			return client.cardkitDeliverCard({
				chatId,
				cardId
			});
		},
		updateCard: async (cardId, body) => {
			const client = getLarkClient();
			if (!client?.cardkitUpdateCard) throw new Error("CardKit unavailable");
			return client.cardkitUpdateCard(cardId, body);
		}
	});
	const outbox = createOutbox({
		dir: join(dir, "outbox"),
		sender: { async deliver(env, payload) {
			const chatId = env.route.chatId;
			try {
				if (env.kind === "command-reply") {
					const command = env.dedupeKey.includes(":cmd:") ? env.dedupeKey.split(":cmd:")[1]?.split(":")[0] ?? "command" : env.dedupeKey.startsWith("bridge:") ? env.dedupeKey.split(":")[1] ?? "command" : "command";
					if ((payload.kind === "card" ? await commandPanelSync.showCard(chatId, env.dedupeKey, command, payload.card) : await commandPanelSync.append(chatId, {
						id: env.dedupeKey,
						command,
						result: payload.kind === "text" ? payload.text : "命令已完成",
						...payload.kind === "text" && payload.status ? { status: payload.status } : {}
					})) && (payload.kind === "text" || payload.kind === "card")) return { ok: true };
				}
				if (payload.kind === "text") {
					if (payload.card !== void 0) await sender.sendCard(chatId, payload.card);
					else await sender.sendText(chatId, payload.text);
				} else if (payload.kind === "card") await sender.sendCard(chatId, payload.card);
				else if (payload.kind === "media") await sender.sendFile(chatId, payload.fileKey, payload.type);
				else if (payload.kind === "reaction") await sender.addReaction(payload.messageId, payload.emojiType);
				return { ok: true };
			} catch (err) {
				return {
					ok: false,
					retryable: true,
					error: err instanceof Error ? err.message : String(err)
				};
			}
		} },
		cfg: getCfg().outbox,
		onStatsChange: (stats) => {
			try {
				status.refreshCounters({
					outboxPending: stats.pending,
					outboxFailed: stats.failed
				});
			} catch {}
		}
	});
	const streamHandles = /* @__PURE__ */ new Map();
	const cardkitNotified = /* @__PURE__ */ new Set();
	const resolveRawAgent = (handle) => {
		if (!handle) return void 0;
		const h = handle;
		if (h.rawAgent) return h.rawAgent;
		if (h.agentId) {
			const found = (ctx.get?.("agents"))?.get?.(h.agentId);
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
	const routeForTaskKey = (taskKey) => routeStore.get(conversationKeyOf(taskKey));
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
	const routeForSessionId = (sessionId) => {
		const backendKey = bridge.backend?.keyForSessionId?.(sessionId);
		return (backendKey ? routeStore.get(conversationKeyOf(backendKey)) : void 0) ?? routeStore.get(conversationKeyForSessionId(sessionId)) ?? routeStore.all().find((r) => sessionId.includes(r.sessionKey));
	};
	const notifyCardkitFailure = (sessionKey, err) => {
		if (cardkitNotified.has(sessionKey)) return;
		cardkitNotified.add(sessionKey);
		const chatId = routeForTaskKey(sessionKey)?.chatId;
		if (!chatId) return;
		const msg = err instanceof Error ? err.message : String(err);
		sender.sendText(chatId, `⚠️ 流式卡片创建失败，本轮已回退普通消息（原因: ${msg.slice(0, 200)}）。常见排查：应用未开通 CardKit 卡片权限（cardkit:card）、飞书客户端版本过旧、或 stream 文本超限。错误只提示一次。`).catch(() => void 0);
	};
	const taskCardSyncer = createTaskCardSyncer({
		api: {
			createCard: async (payload) => {
				const client = getLarkClient();
				if (!client?.cardkitCreateCard) return void 0;
				return await client.cardkitCreateCard(payload);
			},
			deliverCard: async (cardId) => {},
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
			}
		},
		routeFor: (key) => routeForTaskKey(key),
		deliverCard: async ({ chatId, cardId }) => {
			const client = getLarkClient();
			return client?.cardkitDeliverCard ? await client.cardkitDeliverCard({
				chatId,
				cardId
			}) : {};
		},
		debounceMs: 1500,
		onError: (err) => logger.warn(`task card syncer error: ${err instanceof Error ? err.message : String(err)}`)
	});
	const forwarder = createEventForwarder({
		outbox,
		taskCardSyncer,
		routeFor: (key) => routeForTaskKey(key),
		streamFor: (sessionKey) => {
			const route = routeForTaskKey(sessionKey);
			if (!route) return void 0;
			return {
				route: {
					sessionKey: route.sessionKey,
					chatId: route.chatId,
					chatType: route.chatType,
					threadMessageId: route.threadMessageId
				},
				ensureStream: () => {
					const client = getLarkClient();
					if (!client?.cardkitCreateCard || !client.cardkitDeliverCard) return void 0;
					const existing = streamHandles.get(sessionKey);
					if (existing && !existing.disposed) return existing;
					streamHandles.delete(sessionKey);
					const cfgStream = getCfg().streaming;
					const handle = createCardKitStream({
						api: {
							createCard: async (payload) => {
								try {
									return await client.cardkitCreateCard(payload);
								} catch (err) {
									notifyCardkitFailure(sessionKey, err);
									throw err;
								}
							},
							deliverCard: (cardId) => client.cardkitDeliverCard({
								chatId: route.chatId,
								cardId
							}),
							streamText: (cardId, elementId, body) => client.cardkitStreamText(cardId, elementId, body),
							patchSettings: (cardId, body) => client.cardkitPatchSettings(cardId, body),
							updateCard: (cardId, body) => client.cardkitUpdateCard(cardId, body)
						},
						printFrequencyMs: cfgStream.printFrequencyMs,
						printStep: cfgStream.printStep,
						minPushIntervalMs: 800,
						onCompacted: ({ stage, scale, bytes }) => {
							logger.info(`cardkit stream compacted for ${sessionKey}: stage=${stage} detailScale=${scale.toFixed(2)} bytes=${bytes}`);
						},
						onError: (err) => {
							const errStr = String(err);
							if (!errStr.includes("230020") && !errStr.includes("rate limit")) logger.warn(`cardkit stream error for ${sessionKey}: ${err instanceof Error ? err.message : String(err)}`);
						}
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
							chatType: route.chatType
						},
						kind: "assistant-output",
						payload: {
							kind: "text",
							text
						}
					});
				},
				markDone: (messageId) => bridge.markDone(conversationKeyOf(sessionKey), messageId ?? route.lastMessageId),
				markError: (messageId) => bridge.markError(conversationKeyOf(sessionKey), messageId ?? route.lastMessageId)
			};
		},
		cfg: () => ({ streamingEnabled: getCfg().streaming.enabled }),
		warn: (message) => logger.warn(message),
		onDelivered: (taskOrConversationKey) => {
			try {
				const delivered = inboundWal.deliveredOldest(conversationKeyOf(taskOrConversationKey));
				status.refreshCounters({
					inboundPending: inboundWal.pendingReplays().length,
					inboundFailed: inboundWal.failedCount()
				});
				return delivered?.messageId;
			} catch {
				return;
			}
		}
	});
	const groupTrigger = createGroupTrigger({
		cfg: () => ({
			policy: getCfg().groupPolicy,
			keywords: getCfg().groupKeywords,
			alsoOnReply: getCfg().alsoOnReply
		}),
		botOpenId: () => bridge.botOpenId()
	});
	const diagnostics = createDiagnosticsService({
		ctx: bridge,
		secrets: []
	});
	const pendingQuestions = /* @__PURE__ */ new Map();
	async function askUserQuestion(questions, agentId) {
		const answers = [];
		const key = backend?.keyForSessionId?.(agentId);
		const chatId = (key ? routeForTaskKey(key) : void 0)?.chatId;
		if (!chatId) {
			logger.warn(`ask_user_question: no Feishu route for ${agentId}`);
			return { answers: questions.map((q) => ({
				id: q.id,
				selected: ["(无会话，未回答)"]
			})) };
		}
		for (const q of questions) {
			const answer = await new Promise((resolve) => {
				const timer = setTimeout(() => {
					pendingQuestions.delete(q.id);
					resolve({
						id: q.id,
						selected: ["(超时未回答)"]
					});
				}, 6e5);
				timer.unref?.();
				pendingQuestions.set(q.id, {
					resolve,
					chatId,
					questionId: q.id,
					timer,
					options: q.options ?? []
				});
				sender.sendCard(chatId, questionCard(q)).catch((err) => {
					clearTimeout(timer);
					pendingQuestions.delete(q.id);
					resolve({
						id: q.id,
						selected: [`(卡片发送失败: ${err instanceof Error ? err.message : String(err)})`]
					});
				});
			});
			answers.push(answer);
		}
		return { answers };
	}
	const dshCommands = {
		has: (name, agentId) => {
			try {
				const services = ctx;
				const agent = agentId ? services.agents?.get?.(agentId) : void 0;
				if (!agent) return false;
				return Boolean(services.commands?.find?.(agent, name));
			} catch {
				return false;
			}
		},
		async run(name, rawInput, agentId) {
			try {
				const services = ctx;
				const commands = services.commands;
				const agent = services.agents?.get?.(agentId);
				if (!commands?.execute || !agent) return {
					kind: "error",
					text: "commands service unavailable"
				};
				const line = rawInput.trim() ? `/${name} ${rawInput.trim()}` : `/${name}`;
				const out = await commands.execute(agent, line, new AbortController().signal);
				if (!out?.result) return {
					kind: "error",
					text: `未知命令 /${name}`
				};
				return {
					kind: out.result.kind,
					text: out.result.text
				};
			} catch (err) {
				return {
					kind: "error",
					text: err instanceof Error ? err.message : String(err)
				};
			}
		}
	};
	const durableReply = async (cmdName, msg, textOrCard, opts) => {
		const key = bridge.conversationKeyFor(msg);
		await outbox.enqueue({
			dedupeKey: `bridge:${cmdName}:${msg.messageId}`,
			laneKey: key,
			route: {
				sessionKey: key,
				chatId: msg.chatId,
				chatType: msg.chatType
			},
			kind: "command-reply",
			payload: typeof textOrCard === "string" ? {
				kind: "text",
				text: textOrCard,
				...opts?.status ? { status: opts.status } : {}
			} : {
				kind: "card",
				card: textOrCard
			}
		});
	};
	const ctxGet = (serviceName) => ctx.get?.(serviceName);
	const persistenceSlice = () => ctxGet("sessionPersistence");
	const listConversationSessions = async (key) => {
		const wsRoot = workspaceForTaskKey(key);
		const persistence = persistenceSlice();
		const titleService = ctxGet("sessionTitle");
		const liveSessions = ctxGet("sessions");
		const titleFor = (sid) => {
			try {
				const sess = liveSessions?.get?.(sid);
				if (!sess) return void 0;
				const fromService = titleService?.get?.(sess)?.title;
				if (fromService) return fromService;
				if (sess.events) return extractTitleFromEvents(sess.events);
			} catch {}
		};
		try {
			return await listWorkspaceSessions({
				sessionsRoot: resolveSessionsRoot(),
				cwd: wsRoot,
				persistence: persistence?.list ? {
					list: async () => await persistence.list(),
					inspect: persistence.inspect ? async (id) => await persistence.inspect(id) : void 0,
					load: persistence.load ? async (id) => await persistence.load(id) : void 0,
					readFrom: persistence.readFrom ? async (id, fromSeq) => await persistence.readFrom(id, fromSeq) : void 0,
					open: persistence.open ? async (id, access) => await persistence.open(id, access) : void 0
				} : void 0,
				titleFor
			});
		} catch (err) {
			logger.warn(`session listing failed for ${wsRoot}: ${err instanceof Error ? err.message : String(err)}`);
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
	const workspaceFor = (key) => {
		const base = getCfg().workspaceRoot || join(homedir(), "dsh-workspace");
		const explicit = convCfg.get(key).workspaceRoot;
		if (!getCfg().workspaceIsolation) return explicit ?? base;
		return ensureWorkspaceDir(resolveIsolatedWorkspace(base, taskRegistry.owner(key).id ?? key, explicit));
	};
	/** The user's isolation root (absolute), whether or not an override is in force. */
	const isolationRootFor = (key) => userWorkspaceRoot(getCfg().workspaceRoot || join(homedir(), "dsh-workspace"), taskRegistry.owner(key).id ?? key);
	/** Adapter-facing variant: the argument is a TASK key (`dm:oc_x#2`). */
	const workspaceForTaskKey = (key) => workspaceFor(conversationKeyOf(key));
	/** Live session id of one conversation (agent first, then the stored override). */
	const currentSessionFor = (key) => bridge.backend?.get(key)?.sessionId ?? convCfg.get(key).activeSessionId;
	/** Rows for the management panel: alias applied, current session always shown. */
	const manageRowsFor = async (key) => {
		const list = (await listConversationSessions(key)).map((row) => ({
			id: row.id,
			createdAt: row.createdAt,
			...row.title ? { title: row.title } : {},
			...sessionAliases.get(row.id) ? { alias: sessionAliases.get(row.id) } : {},
			...row.preset ? { preset: row.preset } : {},
			...row.summary ? { summary: row.summary } : {},
			...typeof row.userTurns === "number" ? { userTurns: row.userTurns } : {},
			...typeof row.toolCalls === "number" ? { toolCalls: row.toolCalls } : {},
			...typeof row.lastActivityAt === "number" ? { lastActivityAt: row.lastActivityAt } : {},
			cwd: workspaceFor(key)
		}));
		const current = currentSessionFor(key);
		if (current && !list.some((row) => row.id === current)) {
			const alias = sessionAliases.get(current);
			list.unshift({
				id: current,
				createdAt: Date.now(),
				...alias ? { alias } : {},
				cwd: workspaceFor(key)
			});
		}
		return list;
	};
	/**
	* Every task of one conversation, plus the historical sessions that no task
	* has claimed yet — that union is what replaces the old /resume picker.
	* Status comes from the live agents (running = mid-turn), titles and
	* summaries from the workspace log.
	*/
	const taskRowsFor = async (key) => {
		const tasks = conversations.tasks(key);
		const activeId = conversations.activeTask(key)?.id;
		const sessions = await listConversationSessions(key);
		const bySession = new Map(sessions.map((session) => [session.id, session]));
		const claimed = /* @__PURE__ */ new Set();
		const baseRow = (task) => ({
			taskId: task.id,
			...task.sessionId ? { sessionId: task.sessionId } : {},
			seq: task.seq,
			...task.label ? { label: task.label } : {},
			status: "stopped",
			active: false,
			lastActivityAt: task.lastActivityAt
		});
		const rows = tasks.map((task) => {
			if (task.sessionId) claimed.add(task.sessionId);
			const info = task.sessionId ? bySession.get(task.sessionId) : void 0;
			const alias = task.sessionId ? sessionAliases.get(task.sessionId) : void 0;
			return {
				...baseRow(task),
				status: conversations.statusOf(task.id),
				active: task.id === activeId,
				lastActivityAt: info?.lastActivityAt ?? task.lastActivityAt,
				...alias ? { label: alias } : {},
				...info?.title ? { title: info.title } : {},
				...info?.summary ? { summary: info.summary } : {},
				...info?.preset ? { preset: info.preset } : {}
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
				...alias ? { label: alias } : {},
				...session.title ? { title: session.title } : {},
				...session.summary ? { summary: session.summary } : {},
				...session.preset ? { preset: session.preset } : {}
			});
		}
		return rows;
	};
	/** One task's briefing card (status + what it has produced so far). */
	const taskBriefingFor = async (key, row, note) => {
		const snapshot = row.taskId ? forwarder.snapshot(row.taskId) : void 0;
		return taskBriefingCard({
			task: {
				...row,
				status: row.taskId ? conversations.statusOf(row.taskId) : "stopped",
				active: true,
				lastActivityAt: Date.now()
			},
			...snapshot ? { snapshot } : {},
			workspace: workspaceFor(key),
			preset: convCfg.get(key).preset ?? getCfg().agentPreset,
			...note ? { note } : {}
		});
	};
	/**
	* Make one row the message target. A registered task is switched; a bare
	* historical session is bound to a NEW task and resumed, so "switch" works
	* for anything the listing shows.
	*/
	const switchToTaskRow = async (key, row) => {
		if (row.taskId) {
			const { task } = await conversations.switchTask(key, row.taskId);
			const status = conversations.statusOf(task.id);
			return {
				row: {
					...row,
					taskId: task.id,
					...task.sessionId ? { sessionId: task.sessionId } : {},
					status,
					active: true,
					lastActivityAt: Date.now()
				},
				note: status === "running" ? "已切换到运行中的任务：输出继续更新在它自己的卡片里（已续上流式）" : "已切换到这个任务，下一条消息发到这里"
			};
		}
		if (!row.sessionId) throw new Error("这一行既没有任务也没有会话");
		const { task, agent } = await conversations.resumeTask(key, row.sessionId, { ...row.preset ? { preset: row.preset } : {} });
		const running = !agent.isIdle();
		return {
			row: {
				...row,
				taskId: task.id,
				sessionId: task.sessionId ?? row.sessionId,
				status: running ? "running" : "idle",
				active: true,
				historical: false,
				lastActivityAt: Date.now()
			},
			note: "已接管这条历史会话，下一条消息将续上它的上下文"
		};
	};
	/** Resolve a typed /tasks argument: 1-based index, task id or session prefix. */
	const findTaskRow = (rows, arg) => {
		let sel = arg;
		try {
			if (arg.includes("%")) sel = decodeURIComponent(arg);
		} catch {}
		const index = Number(sel);
		if (Number.isInteger(index) && index >= 1) {
			const viaIndex = rows.find((row) => row.seq === index);
			if (viaIndex) return viaIndex;
		}
		return rows.find((row) => row.taskId === sel || row.sessionId === sel || (row.taskId?.startsWith(sel) ?? false) || (row.sessionId?.startsWith(sel) ?? false));
	};
	/** Session-admin dependencies (live probe + optional service delete). */
	const sessionAdminDeps = () => {
		const persistence = ctxGet("sessionPersistence");
		const serviceDelete = persistence?.delete ?? persistence?.remove ?? persistence?.destroy;
		const live = ctxGet("sessions");
		const agents = ctxGet("agents");
		return {
			sessionsRoot: resolveSessionsRoot(),
			isLive: (id) => Boolean(live?.get?.(id) ?? agents?.get?.(id)),
			onServiceDeleteError: (id, err) => logger.warn(`sessionPersistence.delete refused ${id} (removing the log anyway): ${err instanceof Error ? err.message : String(err)}`),
			...serviceDelete ? { serviceDelete: (id) => serviceDelete.call(persistence, id) } : {}
		};
	};
	/**
	* Shared hot-reload applier for /lark-config (text form) and the `cfg:`
	* card toggles, so both paths validate and persist identically.
	*/
	const applyHotConfig = async (rawKey, rawValue) => {
		const key = rawKey.trim();
		const raw = String(rawValue ?? "").trim();
		let value = raw;
		if (raw === "true" || raw === "false") value = raw === "true";
		else if (raw !== "" && !Number.isNaN(Number(raw))) value = Number(raw);
		try {
			configStore.update(buildHotReloadPatch(key, value));
			configStore.saveOverrides();
			return {
				ok: true,
				key,
				value
			};
		} catch (err) {
			return {
				ok: false,
				message: err instanceof Error && /not hot-reloadable/.test(err.message) ? `"${key}" 不可热改（可改: ${HOT_RELOADABLE.join(", ")}）` : `更新失败: ${err instanceof Error ? err.message : String(err)}`
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
	const buildWorkspaceBrowserCard = (key, browsePath) => {
		const workspacePath = workspaceForTaskKey(key);
		try {
			if (!statSync(browsePath).isDirectory()) throw new Error("不是目录");
			const all = readdirSync(browsePath, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).sort((left, right) => left.name.localeCompare(right.name));
			const entries = all.slice(0, 40).map((entry) => ({
				name: entry.name,
				path: join(browsePath, entry.name)
			}));
			const parentPath = parentDirectory(browsePath);
			return workspaceBrowserCard({
				browsePath,
				workspacePath,
				...parentPath ? { parentPath } : {},
				entries,
				truncated: all.length > 40
			});
		} catch (err) {
			return markdownCard(`**无法浏览该目录**\n\n\`${browsePath}\`\n${err instanceof Error ? err.message : String(err)}`, {
				header: "工作区",
				accent: false
			});
		}
	};
	const bridgeHandler = async (name, _rawInput, msg) => {
		switch (name) {
			case "status":
				await durableReply(name, msg, statusCard(formatStatusLine(status.get()), statusDetailLines(status.get())));
				return true;
			case "feishu-config":
			case "lark-config": {
				const arg = _rawInput.trim();
				if (!arg) {
					await durableReply(name, msg, configPanelCard({
						streamingEnabled: getCfg().streaming.enabled,
						reactionsEnabled: getCfg().reactions.enabled,
						groupPolicy: getCfg().groupPolicy,
						agentPreset: getCfg().agentPreset,
						permissionMode: getCfg().permissionMode,
						allowlist: getCfg().allowlist,
						denyList: getCfg().denyList
					}));
					return true;
				}
				const eq = arg.indexOf("=");
				if (eq === -1) {
					await durableReply(name, msg, "用法：/lark-config key=value（可热改: " + HOT_RELOADABLE.join(", ") + "；嵌套键用点路径，如 streaming.enabled=true）");
					return true;
				}
				const applied = await applyHotConfig(arg.slice(0, eq), arg.slice(eq + 1));
				await durableReply(name, msg, applied.ok ? `已更新 ${applied.key}=${JSON.stringify(applied.value)}` : applied.message, applied.ok ? void 0 : { status: "error" });
				return true;
			}
			case "support":
			case "doctor": {
				const diag = await diagnostics.build();
				const client = getLarkClient();
				if (client?.uploadFile) try {
					const key = bridge.conversationKeyFor(msg);
					const sessionId = bridge.backend?.get(key)?.sessionId ?? findLatestLarkSessionId();
					const zipBuf = sessionId ? await buildSessionExportZip(sessionId, diag.text, diag.issueMd) : void 0;
					if (zipBuf) {
						const fileName = `lark-link-doctor-${Date.now()}.zip`;
						const uploadKey = extractUploadKey(await client.uploadFile({
							file_type: "file",
							file_name: fileName,
							file: zipBuf
						}), "file_key");
						if (uploadKey) {
							await sender.sendFile(msg.chatId, uploadKey, "file");
							await durableReply(name, msg, "✅ 诊断包已发送");
							return true;
						}
					}
					const fileName = `lark-link-doctor-${Date.now()}.md`;
					const buf = Buffer.from(`# dsh-lark-link 诊断包\n\n${diag.text}\n\n${diag.issueMd}\n`, "utf8");
					const uploadKey = extractUploadKey(await client.uploadFile({
						file_type: "file",
						file_name: fileName,
						file: buf
					}), "file_key");
					if (uploadKey) {
						await sender.sendFile(msg.chatId, uploadKey, "file");
						await durableReply(name, msg, "✅ 诊断报告已发送");
						return true;
					}
				} catch (err) {
					logger.warn(`doctor file send failed: ${err instanceof Error ? err.message : String(err)}`);
				}
				await durableReply(name, msg, diag.text);
				return true;
			}
			case "manage":
			case "sessions": {
				const key = bridge.conversationKeyFor(msg);
				const current = currentSessionFor(key);
				const arg = _rawInput.trim();
				if (!arg) {
					await durableReply(name, msg, sessionManageCard({
						sessions: await manageRowsFor(key),
						currentSessionId: current
					}));
					return true;
				}
				const rows = await manageRowsFor(key);
				let sel = arg;
				try {
					if (arg.includes("%")) sel = decodeURIComponent(arg);
				} catch {}
				const index = Number(sel);
				const picked = Number.isInteger(index) && index >= 1 && index <= rows.length ? rows[index - 1] : rows.find((row) => row.id === sel || row.id.startsWith(sel));
				if (!picked) {
					await durableReply(name, msg, sessionManageCard({
						sessions: rows,
						currentSessionId: current,
						note: `未找到会话「${arg}」，请从下面的列表中选择`
					}));
					return true;
				}
				await durableReply(name, msg, sessionManageDetailCard({
					session: picked,
					currentSessionId: current
				}));
				return true;
			}
			case "help":
				await durableReply(name, msg, helpCard());
				return true;
			case "workspace": {
				const arg = _rawInput.trim();
				const wsKey = bridge.conversationKeyFor(msg);
				const curWs = workspaceForTaskKey(wsKey);
				if (!arg) {
					await durableReply(name, msg, buildWorkspaceBrowserCard(wsKey, curWs));
					return true;
				}
				if (arg === "mk" || arg.startsWith("mk ")) {
					try {
						const dirName = sanitizeDirectoryName(arg.slice(2).trim());
						const target = join(curWs, dirName);
						if (existsSync(target)) throw new Error("该目录已存在");
						mkdirSync(target, { recursive: false });
						await durableReply(name, msg, `已创建目录: ${target}\n发送 /workspace 打开浏览器即可切换过去。`);
					} catch (err) {
						await durableReply(name, msg, `创建失败: ${err instanceof Error ? err.message : String(err)}`, { status: "error" });
					}
					return true;
				}
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
				convCfg.set(wsKey, {
					workspaceRoot: target,
					activeSessionId: void 0
				});
				await conversations?.rotate(bridge.conversationKeyFor(msg));
				await durableReply(name, msg, `工作区已切换: ${target}\n当前会话已重置，下一条消息在新工作区生效（其他会话不受影响）。`);
				return true;
			}
			case "tasks": {
				const key = bridge.conversationKeyFor(msg);
				const rows = await taskRowsFor(key);
				const arg = _rawInput.trim();
				if (!arg) {
					await durableReply(name, msg, taskListCard({
						tasks: rows,
						workspace: workspaceFor(key)
					}));
					return true;
				}
				const picked = findTaskRow(rows, arg);
				if (!picked) {
					await durableReply(name, msg, taskListCard({
						tasks: rows,
						workspace: workspaceFor(key),
						note: `没有找到「${arg}」，请从下面的列表里选`
					}));
					return true;
				}
				try {
					const { row, note } = await switchToTaskRow(key, picked);
					await durableReply(name, msg, await taskBriefingFor(key, row, note));
				} catch (err) {
					await durableReply(name, msg, `切换失败：${err instanceof Error ? err.message : String(err)}`, { status: "error" });
				}
				return true;
			}
			case "resume": return bridgeHandler("tasks", _rawInput.trim(), msg);
			case "_legacy_resume_picker": {
				const key = bridge.conversationKeyFor(msg);
				const currentSessionId = currentSessionFor(key);
				const sessions = await listConversationSessions(key);
				logger.info(`resume: ${sessions.length} session(s) for ${workspaceFor(key)}; current=${currentSessionId ?? "none"}`);
				const arg = _rawInput.trim();
				if (!arg) {
					await durableReply(name, msg, resumeCard(sessions, currentSessionId));
					return true;
				}
				let sel = arg;
				try {
					if (arg.includes("%")) sel = decodeURIComponent(arg);
				} catch {}
				const resumable = sessions.filter((s) => s.id !== currentSessionId);
				const pick = /^\d+$/.test(sel) ? resumable[Number(sel) - 1] : resumable.find((s) => s.id === sel || s.id.startsWith(sel) || s.id.endsWith(`:${sel}`));
				if (!pick) {
					await durableReply(name, msg, `未找到会话 «${arg}»（发送 /resume 查看当前工作区的历史会话）`);
					return true;
				}
				try {
					await conversations.resume(key, pick.id, pick.preset ? { preset: pick.preset } : void 0);
					logger.info(`resume: ${key} restored ${pick.id}`);
					const resumedHandle = bridge.backend?.get(key);
					resolveRawAgent(resumedHandle);
					await durableReply(name, msg, buildSessionResumedCard({
						sessionId: pick.id,
						workspacePath: workspaceFor(key),
						preset: pick.preset
					}));
				} catch (err) {
					await durableReply(name, msg, `恢复失败: ${err instanceof Error ? err.message : String(err)}`);
				}
				return true;
			}
			case "goal": {
				const key = bridge.conversationKeyFor(msg);
				const wsRoot = workspaceForTaskKey(key);
				const arg = _rawInput.trim();
				let agentHandle = bridge.backend?.get(key);
				if (!agentHandle) try {
					agentHandle = await bridge.backend?.ensureAgent?.(key);
				} catch {}
				const rawAgent = resolveRawAgent(agentHandle);
				const goalsService = ctx.get?.("goals");
				let currentGoal;
				try {
					currentGoal = rawAgent && goalsService?.get ? goalsService.get(rawAgent) : void 0;
				} catch {
					currentGoal = void 0;
				}
				if (!arg) {
					await durableReply(name, msg, currentGoal ? buildGoalControlCard(currentGoal, { workspacePath: wsRoot }) : buildGoalSetupCard());
					return true;
				}
				if (arg === "pause") {
					if (!currentGoal) {
						await durableReply(name, msg, "当前没有正在运行的目标。");
						return true;
					}
					try {
						goalsService?.pause?.(rawAgent, {
							id: currentGoal.id,
							revision: currentGoal.revision
						});
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
						goalsService?.resume?.(rawAgent, {
							id: currentGoal.id,
							revision: currentGoal.revision
						});
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
						goalsService?.clear?.(rawAgent, {
							id: currentGoal.id,
							revision: currentGoal.revision
						});
						await bridge.conversations?.stop(key);
						await durableReply(name, msg, "🛑 目标已清除并停止当前任务轮次。");
					} catch (err) {
						await durableReply(name, msg, `清除失败: ${err instanceof Error ? err.message : String(err)}`);
					}
					return true;
				}
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
				await durableReply(name, msg, stopResultCard({ text: "已向当前会话发送停止请求，正在运行的轮次会被取消。" }));
				return true;
			}
			case "new": {
				const key = bridge.conversationKeyFor(msg);
				const newWs = workspaceFor(key);
				const newMode = _rawInput.trim();
				if (newMode === "cancel") {
					await durableReply(name, msg, "已取消，保持当前会话。");
					return true;
				}
				if (newMode !== "confirm") {
					await durableReply(name, msg, newConfirmCard({ workspace: newWs }));
					return true;
				}
				const task = conversations.createTask(key);
				await durableReply(name, msg, `已开启任务 #${task.seq}（工作区: ${newWs}）。下一条消息在这里开始全新上下文；之前任务继续运行，用 /tasks 查看与切换。`);
				return true;
			}
			case "model": {
				const arg = _rawInput.trim();
				const modelKey = bridge.conversationKeyFor(msg);
				const mine = liveModelFor(modelKey);
				const current = mine.provider && mine.model ? {
					provider: mine.provider,
					model: mine.model
				} : admService?.currentSelection?.();
				if (!arg) {
					const groups = [];
					for (const p of await listModelCatalog()) {
						const models = p.models.filter((model) => isModelAllowed(getCfg().modelAccess, modelRef({
							provider: p.provider,
							model: model.id
						})));
						if (models.length > 0) groups.push({
							provider: p.provider,
							label: p.label ?? p.provider,
							models
						});
					}
					await durableReply(name, msg, modelCard(current, groups));
					return true;
				}
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
					await durableReply(name, msg, "用法：/model <provider>/<model> 或 /model <model>");
					return true;
				}
				if (!isModelAllowed(getCfg().modelAccess, {
					provider,
					model
				})) {
					await durableReply(name, msg, `该飞书应用未获准使用模型 ${provider}/${model}。请由管理员在 Lark 管理面板中授权。`);
					return true;
				}
				convCfg.set(modelKey, {
					provider,
					model,
					reasoningEffort: void 0
				});
				const entry = liveModelFor(modelKey);
				entry.provider = provider;
				entry.model = model;
				delete entry.reasoningEffort;
				entry.override = true;
				backend?.clearImageUnsupported?.(modelKey);
				await durableReply(name, msg, `模型已切换: ${provider}/${model}\n本会话下次回复生效（会话不中断，其他会话不受影响）。`);
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
				const llm = ctx.get?.("llm");
				let info;
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
					await durableReply(name, msg, reasoningCard({
						provider: selected.provider,
						model: selected.model
					}, selected.reasoningEffort, reasoning.defaultEffort, reasoning.efforts));
					return true;
				}
				if ([
					"default",
					"auto",
					"provider-default"
				].includes(arg)) {
					convCfg.set(key, { reasoningEffort: void 0 });
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
				selected.reasoningEffort = effort.id;
				await durableReply(name, msg, `思考强度已切换为 ${effort.name}（${effort.id}），仅当前飞书会话生效，下次请求生效。`);
				return true;
			}
			case "mode": {
				const live = backend ? await backend.listPresets() : [];
				const roster = live.length > 0 ? live : [...AGENT_PRESETS];
				const arg = _rawInput.trim().toLowerCase();
				if (!arg) {
					await durableReply(name, msg, withButtons(modeCard(getCfg().agentPreset, roster), roster.filter((p) => !p.broken).map((p) => button(p.label, { op: `mode:${p.id}` }))));
					return true;
				}
				if (!roster.some((p) => p.id === arg)) {
					await durableReply(name, msg, `未知模式 ${arg}（可用: ${roster.map((p) => p.id).join(", ")}）`);
					return true;
				}
				convCfg.set(bridge.conversationKeyFor(msg), {
					preset: arg,
					activeSessionId: void 0
				});
				await conversations?.rotate(bridge.conversationKeyFor(msg));
				const picked = roster.find((p) => p.id === arg);
				await durableReply(name, msg, `模式已切换为 ${picked?.label ?? arg}${picked?.trust === "user" ? "（自定义）" : ""}（当前会话已重置，下条消息生效；其他会话不受影响）`);
				return true;
			}
			case "permission": {
				const arg = _rawInput.trim().toLowerCase();
				if (!arg) {
					await durableReply(name, msg, withButtons(permissionCard(getCfg().permissionMode), PERMISSION_PRESETS.map((p) => button(p.label, { op: `permission:${p.id}` }))));
					return true;
				}
				if (!PERMISSION_PRESETS.some((p) => p.id === arg)) {
					await durableReply(name, msg, `未知权限 ${arg}（可用: ${PERMISSION_PRESETS.map((p) => p.id).join(", ")}）`);
					return true;
				}
				try {
					const services = ctx;
					const sessionId = bridge.backend?.get(bridge.conversationKeyFor(msg))?.sessionId;
					const agent = sessionId ? (services.get?.("agents"))?.get?.(sessionId) : void 0;
					const permission = services.get?.("permissionPresets");
					if (agent?.session && permission?.apply) permission.apply(agent.session, arg, (policy) => {
						(services.get?.("approval"))?.setPolicy?.(agent, policy);
					});
				} catch (err) {
					logger.warn(`permission switch failed: ${err instanceof Error ? err.message : String(err)}`);
				}
				configStore.update({ permissionMode: arg });
				configStore.saveOverrides();
				await durableReply(name, msg, `权限已切换为 ${arg}（仅桥接会话生效）`);
				return true;
			}
			case "lark": {
				const sub = _rawInput.trim().split(/\s+/)[0] ?? "";
				if (!sub) {
					const credentials = await resolveCredentials(credStore, getCfg().credentialRef);
					await durableReply(name, msg, larkAdminPanelCard({
						connState: status.get().connState,
						configured: Boolean(credentials)
					}));
					return true;
				}
				await durableReply(name, msg, await runLarkSubcommand(sub.toLowerCase()));
				return true;
			}
			case "menu":
				await durableReply(name, msg, commandPanelCard());
				return true;
			case "cfg": {
				const arg = _rawInput.trim();
				const eq = arg.indexOf("=");
				if (eq === -1) {
					await durableReply(name, msg, "用法：/lark-config <key>=<value>", { status: "error" });
					return true;
				}
				const applied = await applyHotConfig(arg.slice(0, eq), arg.slice(eq + 1));
				await durableReply(name, msg, applied.ok ? `已更新 ${applied.key}=${JSON.stringify(applied.value)}` : applied.message, applied.ok ? void 0 : { status: "error" });
				return true;
			}
			case "stream": {
				const arg = _rawInput.trim().toLowerCase();
				const current = getCfg().streaming.enabled;
				if (arg !== "on" && arg !== "off") {
					await durableReply(name, msg, `流式卡片当前: ${current ? "🟢 已开启" : "⚪ 已关闭"}\n用法: \`/stream on\` 或 \`/stream off\`（也可在 /lark-config 面板点按钮）`);
					return true;
				}
				const applied = await applyHotConfig("streaming.enabled", String(arg === "on"));
				await durableReply(name, msg, applied.ok ? `流式卡片已${arg === "on" ? "开启" : "关闭"}，立即生效。` : applied.message, applied.ok ? void 0 : { status: "error" });
				return true;
			}
			case "reconnect":
				try {
					const result = await applyBridgeControl?.("restart");
					await durableReply(name, msg, `已重连，当前连接状态: \`${result?.connState ?? status.get().connState}\``);
				} catch (err) {
					await durableReply(name, msg, `重连失败: ${err instanceof Error ? err.message : String(err)}`, { status: "error" });
				}
				return true;
			case "cwd": {
				const key = bridge.conversationKeyFor(msg);
				const override = convCfg.get(key);
				const ws = workspaceForTaskKey(key);
				await durableReply(name, msg, `📁 当前工作区: \`${ws}\`\n来源: ${override.workspaceRoot ? "本会话 /workspace 覆盖" : "机器人默认设置"}`);
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
					`- 工作区: \`${workspaceForTaskKey(key)}\` (${override.workspaceRoot ? "本会话覆盖" : "按用户隔离"})`,
					`- 模型: \`${selected.provider && selected.model ? `${selected.provider}/${selected.model}` : "（默认）"}\`${selected.override ? " (本会话覆盖)" : ""}`,
					`- 模式/权限: \`${override.preset ?? getCfg().agentPreset}\` / \`${getCfg().permissionMode}\``,
					`- 连接: \`${status.get().connState}\`${route ? ` · 路由: ${route.chatType} → \`${route.chatId}\`` : ""}`
				];
				await durableReply(name, msg, lines.join("\n"));
				return true;
			}
			case "usage": {
				const records = userUsage.list();
				if (records.length === 0) {
					await durableReply(name, msg, "暂无用量记录（还没有用户向机器人发过消息）。");
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
					...records.length > 20 ? ["", "*（仅显示最近 20 个会话）*"] : []
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
					const entries = readdirSync(target, { withFileTypes: true }).filter((entry) => !entry.name.startsWith(".")).slice(0, 60).map((entry) => entry.isDirectory() ? `📁 ${entry.name}/` : `📄 ${entry.name}`);
					await durableReply(name, msg, [
						`**${target}**`,
						"",
						...entries.length > 0 ? entries : ["（空目录）"]
					].join("\n"));
				} catch (err) {
					await durableReply(name, msg, `无法读取目录 \`${target}\`: ${err instanceof Error ? err.message : String(err)}`, { status: "error" });
				}
				return true;
			}
			default: return false;
		}
	};
	const commandRouter = createCommandRouter({
		ctx: bridge,
		commands: dshCommands,
		bridgeHandler,
		commandProgress: commandPanelSync
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
	const formValuesOf = (payload) => {
		const action = payload?.action;
		const raw = action?.form_value ?? action?.formValue;
		return raw && typeof raw === "object" ? raw : void 0;
	};
	const handleCardAction = async (data) => {
		try {
			const raw = data;
			const value = raw.action?.value ?? {};
			const op = typeof value.op === "string" ? value.op : "";
			const panelCardId = typeof value._panel_card_id === "string" ? value._panel_card_id : "";
			logger.info(`card action data: ${JSON.stringify(raw).slice(0, 600)}`);
			const chatId = raw.context?.open_chat_id ?? raw.operator?.operator_id?.open_id ?? raw.open_id ?? "";
			const messageId = raw.message?.message_id ?? "";
			if (!op) return;
			if (op.startsWith("site:")) {
				const siteKey = routeStore.all().find((r) => r.chatId === chatId)?.sessionKey ?? (chatId.startsWith("oc_") ? `p2p:${chatId}` : `p2p:${chatId}`);
				const candidates = [
					siteKey,
					siteKey.split("#")[0] ?? siteKey,
					chatId
				];
				const entry = candidates.map((candidate) => sitePreviews.get(candidate)).find(Boolean);
				if (op === "site:refresh") {
					if (!entry) {
						await sender.sendText(chatId, "当前没有进行中的预览。");
						return;
					}
					const refreshed = await sitePreviews.refresh(entry.convKey);
					await sender.sendCard(chatId, sitePreviewCard({
						title: refreshed.title,
						publicUrl: refreshed.publicUrl,
						debugUrl: refreshed.debugUrl,
						origin: refreshed.target,
						label: refreshed.label,
						action: "刷新",
						expiresAt: refreshed.expiresAt
					}));
					return;
				}
				if (op === "site:stop") {
					for (const candidate of candidates) sitePreviews.stop(candidate);
					await sender.sendText(chatId, "🛑 预览已关闭，链接失效。");
					return;
				}
			}
			if (op.startsWith("tasks:")) {
				const tasksKey = conversationKeyOf(routeStore.all().find((r) => r.chatId === chatId)?.sessionKey ?? `p2p:${chatId}`);
				const renderTaskCard = async (card) => {
					if (panelCardId) await commandPanelSync.replace(panelCardId, "tasks", card);
					else await sender.sendCard(chatId, card);
				};
				const renderTaskList = async (note) => {
					await renderTaskCard(taskListCard({
						tasks: await taskRowsFor(tasksKey),
						workspace: workspaceFor(tasksKey),
						...note ? { note } : {}
					}));
				};
				/** Row for an id that the listing may no longer contain. */
				const taskRowFor = async (taskId) => (await taskRowsFor(tasksKey)).find((row) => row.taskId === taskId) ?? {
					taskId,
					seq: taskRegistry.taskSeqOf(taskId),
					status: "stopped",
					active: false,
					lastActivityAt: Date.now()
				};
				if (op === "tasks:list") {
					await renderTaskList();
					return;
				}
				if (op === "tasks:exit") {
					if (panelCardId) await commandPanelSync.collapse(panelCardId, "tasks", "已退出任务列表");
					else await sender.sendText(chatId, "已退出任务列表。");
					return;
				}
				if (op === "tasks:new") {
					const task = conversations.createTask(tasksKey);
					await renderTaskCard(await taskBriefingFor(tasksKey, await taskRowFor(task.id), `已开启任务 #${task.seq}：下一条消息发到这里`));
					return;
				}
				if (op.startsWith("tasks:switch:")) {
					const taskId = decodeOpPath(op.slice(13));
					try {
						const { row, note } = await switchToTaskRow(tasksKey, await taskRowFor(taskId));
						await renderTaskCard(await taskBriefingFor(tasksKey, row, note));
					} catch (err) {
						await renderTaskList(`切换失败：${err instanceof Error ? err.message : String(err)}`);
					}
					return;
				}
				if (op.startsWith("tasks:open:")) {
					const sessionId = decodeOpPath(op.slice(11));
					const known = (await taskRowsFor(tasksKey)).find((row) => row.sessionId === sessionId);
					try {
						const { row, note } = await switchToTaskRow(tasksKey, known ?? {
							sessionId,
							seq: 0,
							status: "stopped",
							active: false,
							historical: true,
							lastActivityAt: Date.now()
						});
						await renderTaskCard(await taskBriefingFor(tasksKey, row, note));
					} catch (err) {
						await renderTaskList(`接管失败：${err instanceof Error ? err.message : String(err)}`);
					}
					return;
				}
				if (op.startsWith("tasks:stop:")) {
					const taskId = decodeOpPath(op.slice(11));
					await conversations.stopTask(tasksKey, taskId);
					await renderTaskCard(await taskBriefingFor(tasksKey, await taskRowFor(taskId), "已发送停止请求"));
					return;
				}
				if (op.startsWith("tasks:refresh:")) {
					const taskId = decodeOpPath(op.slice(14));
					await renderTaskCard(await taskBriefingFor(tasksKey, await taskRowFor(taskId)));
					return;
				}
				return;
			}
			if (op.startsWith("manage:")) {
				const manageKey = routeStore.all().find((r) => r.chatId === chatId)?.sessionKey ?? `p2p:${chatId}`;
				const current = currentSessionFor(manageKey);
				const renderManage = async (card) => {
					if (panelCardId) await commandPanelSync.replace(panelCardId, "manage", card);
					else await sender.sendCard(chatId, card);
				};
				const renderList = async (note) => {
					await renderManage(sessionManageCard({
						sessions: await manageRowsFor(manageKey),
						currentSessionId: current,
						...note ? { note } : {}
					}));
				};
				/** Row for the detail/ops views; an unlisted id still renders. */
				const rowFor = async (id) => {
					const found = (await manageRowsFor(manageKey)).find((row) => row.id === id);
					if (found) return found;
					const alias = sessionAliases.get(id);
					return {
						id,
						createdAt: Date.now(),
						...alias ? { alias } : {},
						cwd: workspaceFor(manageKey)
					};
				};
				const renderDetail = async (id, note) => {
					await renderManage(sessionManageDetailCard({
						session: await rowFor(id),
						currentSessionId: current,
						...note ? { note } : {}
					}));
				};
				const formValue = () => raw.action?.formValue;
				if (op === "manage:list") {
					await renderList();
					return;
				}
				if (op === "manage:exit") {
					if (panelCardId) await commandPanelSync.collapse(panelCardId, "manage", "已退出对话管理");
					else await sender.sendText(chatId, "已退出对话管理。");
					return;
				}
				if (op.startsWith("manage:pick:")) {
					await renderDetail(decodeOpPath(op.slice(12)));
					return;
				}
				if (op.startsWith("manage:rename:submit:")) {
					const id = decodeOpPath(op.slice(21));
					try {
						const alias = sessionAliases.set(id, String(formValue()?.alias ?? ""));
						const live = ctxGet("sessions")?.get?.(id);
						const titleService = ctxGet("sessionTitle");
						if (live && titleService?.rename) try {
							titleService.rename(live, alias);
						} catch (err) {
							logger.warn(`manage: DSH title rename failed for ${id}: ${err instanceof Error ? err.message : String(err)}`);
						}
						logger.info(`manage: renamed ${id} to 「${alias}」`);
						await renderDetail(id, `已重命名为「${alias}」`);
					} catch (err) {
						await sender.sendText(chatId, `重命名失败：${err instanceof Error ? err.message : String(err)}`);
					}
					return;
				}
				if (op.startsWith("manage:rename:")) {
					await renderManage(sessionRenameCard({ session: await rowFor(decodeOpPath(op.slice(14))) }));
					return;
				}
				if (op.startsWith("manage:delete:confirm:")) {
					const id = decodeOpPath(op.slice(22));
					try {
						const removed = await deleteSession(sessionAdminDeps(), id);
						sessionAliases.clear(id);
						logger.info(`manage: deleted session ${id} (${removed.dir})`);
						await renderList(`已删除会话「${id}」`);
					} catch (err) {
						await renderDetail(id, `删除失败：${err instanceof Error ? err.message : String(err)}`);
					}
					return;
				}
				if (op === "manage:delete:cancel") {
					await renderList("已取消删除");
					return;
				}
				if (op.startsWith("manage:delete:")) {
					await renderManage(sessionDeleteConfirmCard({ session: await rowFor(decodeOpPath(op.slice(14))) }));
					return;
				}
				if (op.startsWith("manage:move:to:")) {
					const [rawId = "", rawTarget = ""] = op.slice(15).split("|");
					const id = decodeOpPath(rawId);
					try {
						const moved = moveSessionToProject(sessionAdminDeps(), id, decodeOpPath(rawTarget));
						logger.info(`manage: migrated ${id} -> ${moved.to} (cwd ${moved.cwd})`);
						await renderDetail(id, `已迁移到 \`${moved.cwd}\``);
					} catch (err) {
						await renderDetail(id, `迁移失败：${err instanceof Error ? err.message : String(err)}`);
					}
					return;
				}
				if (op.startsWith("manage:move:submit:")) {
					const id = decodeOpPath(op.slice(19));
					const target = String(formValue()?.path ?? "").trim();
					try {
						if (!target) throw new Error("目标路径不能为空");
						if (!isAbsoluteAny(target)) throw new Error("请填写绝对路径");
						const moved = moveSessionToProject(sessionAdminDeps(), id, target);
						logger.info(`manage: migrated ${id} -> ${moved.to} (cwd ${moved.cwd})`);
						await renderDetail(id, `已迁移到 \`${moved.cwd}\``);
					} catch (err) {
						await renderDetail(id, `迁移失败：${err instanceof Error ? err.message : String(err)}`);
					}
					return;
				}
				if (op.startsWith("manage:move:")) {
					await renderManage(sessionMoveCard({
						session: await rowFor(decodeOpPath(op.slice(12))),
						targets: listProjectCwds(sessionAdminDeps())
					}));
					return;
				}
				if (op.startsWith("manage:resume:")) {
					const id = decodeOpPath(op.slice(14));
					const knownRoute = routeStore.all().find((r) => r.chatId === chatId);
					const pseudoMessageId = messageId ? `${messageId}#manage-resume` : `card#${Date.now()}`;
					if (panelCardId) commandPanelSync.adopt(chatId, `bridge:resume:${pseudoMessageId}`, panelCardId, "resume");
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
						timestamp: Date.now()
					});
					return;
				}
				return;
			}
			if (op.startsWith("uqam:")) {
				const questionId = op.slice(5);
				const pending = pendingQuestions.get(questionId);
				if (pending) {
					clearTimeout(pending.timer);
					pendingQuestions.delete(questionId);
					const answer = formValuesOf(raw)?.answer;
					const selected = (Array.isArray(answer) ? answer.map((v) => String(v)) : typeof answer === "string" && answer ? [answer] : []).map((v) => {
						const i = Number(v);
						return Number.isInteger(i) && pending.options[i] ? pending.options[i].label : v;
					});
					sender.sendText(pending.chatId, `已收到你的选择 ✅（${selected.join("、")}）`).catch(() => void 0);
					pending.resolve({
						id: questionId,
						selected
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
					const label = pending.options[optionIndex]?.label ?? String(optionIndex);
					sender.sendText(pending.chatId, `已收到你的选择 ✅（${label}）`).catch(() => void 0);
					pending.resolve({
						id: questionId,
						selected: [label]
					});
				}
				return;
			}
			if (op === "task:toggle_fold") {
				const sessionKey = routeStore.all().find((r) => r.chatId === chatId)?.sessionKey ?? (chatId ? `dm:${chatId}` : "");
				if (sessionKey) {
					const isFolded = typeof value.folded === "boolean" ? value.folded : void 0;
					await taskCardSyncer.toggleFold(sessionKey, isFolded);
				}
				return;
			}
			if (op === "task:focus_board") {
				const sessionKey = routeStore.all().find((r) => r.chatId === chatId)?.sessionKey ?? (chatId ? `dm:${chatId}` : "");
				if (sessionKey) {
					const st = taskCardSyncer.getState(sessionKey);
					if (st) await sender.sendCard(chatId, buildTaskBoardCard(st));
					else await sender.sendText(chatId, "当前会话暂无活跃任务看板。");
				}
				return;
			}
			if (op.startsWith("plan:approve_goal:")) {
				const questionId = op.slice(18);
				const pending = pendingQuestions.get(questionId);
				if (pending) {
					clearTimeout(pending.timer);
					pendingQuestions.delete(questionId);
					sender.sendText(pending.chatId, "已批准方案，正在启动目标执行 🚀").catch(() => void 0);
					pending.resolve({
						id: questionId,
						selected: ["Approve"]
					});
					const sessionKey = routeStore.all().find((r) => r.chatId === chatId)?.sessionKey ?? (chatId ? `dm:${chatId}` : "");
					const agentHandle = sessionKey ? bridge.backend?.get(sessionKey) : void 0;
					const rawAgent = resolveRawAgent(agentHandle);
					const goalsService = ctx.get?.("goals");
					if (rawAgent && goalsService?.create) try {
						const opt = pending.options[0];
						const firstLine = (opt?.description ?? opt?.label ?? "").split("\n")[0] || "执行已批准的规划方案";
						goalsService.create(rawAgent, { objective: firstLine });
					} catch {}
				}
				return;
			}
			if (op.startsWith("plan:approve_plain:")) {
				const questionId = op.slice(19);
				const pending = pendingQuestions.get(questionId);
				if (pending) {
					clearTimeout(pending.timer);
					pendingQuestions.delete(questionId);
					sender.sendText(pending.chatId, "已批准方案 ✅，退出 Plan 模式继续执行。").catch(() => void 0);
					pending.resolve({
						id: questionId,
						selected: ["Approve"]
					});
				}
				return;
			}
			if (op.startsWith("plan:feedback:")) {
				const questionId = op.slice(14);
				const pending = pendingQuestions.get(questionId);
				if (pending) sender.sendText(pending.chatId, "请在聊天框直接回复你的修改建议 💬，Agent 将在 Plan 模式下调整方案。").catch(() => void 0);
				return;
			}
			if (op.startsWith("plan:cancel:")) {
				const questionId = op.slice(12);
				const pending = pendingQuestions.get(questionId);
				if (pending) {
					clearTimeout(pending.timer);
					pendingQuestions.delete(questionId);
					sender.sendText(pending.chatId, "已放弃当前方案 🛑，退出 Plan 模式。").catch(() => void 0);
					const planModeService = ctx.get?.("planMode");
					const sessionKey = routeStore.all().find((r) => r.chatId === chatId)?.sessionKey ?? (chatId ? `dm:${chatId}` : "");
					const agentHandle = sessionKey ? bridge.backend?.get(sessionKey) : void 0;
					const rawAgent = resolveRawAgent(agentHandle);
					if (rawAgent && planModeService?.set) try {
						planModeService.set(rawAgent, false);
					} catch {}
					pending.resolve({
						id: questionId,
						selected: ["Keep planning"]
					});
				}
				return;
			}
			if (op.startsWith("ws:")) {
				const wsKey = routeStore.all().find((r) => r.chatId === chatId)?.sessionKey ?? (chatId ? `dm:${chatId}` : "");
				if (!wsKey) return;
				const renderCard = async (card) => {
					if (panelCardId) await commandPanelSync.replace(panelCardId, "workspace", card);
					else await sender.sendCard(chatId, card);
				};
				const renderBrowser = async (path) => {
					await renderCard(buildWorkspaceBrowserCard(wsKey, path));
				};
				const renderError = async (title, err) => {
					await renderCard(markdownCard(`**${title}**\n\n${err instanceof Error ? err.message : String(err)}`, {
						header: "工作区",
						accent: false
					}));
				};
				/** Isolation guard: with isolation on, browsing stays in the subtree. */
				const insideIsolation = (target) => !getCfg().workspaceIsolation || isInsideWorkspace(isolationRootFor(wsKey), target);
				const navigate = async (target) => {
					if (!insideIsolation(target)) {
						await renderError("已开启用户隔离", `只能在自己的工作区（\`${isolationRootFor(wsKey)}\`）内浏览`);
						return;
					}
					await renderBrowser(target);
				};
				if (op.startsWith("ws:cd:")) {
					await navigate(decodeOpPath(op.slice(6)));
					return;
				}
				if (op.startsWith("ws:up:")) {
					await renderBrowser(decodeOpPath(op.slice(6)));
					return;
				}
				if (op.startsWith("ws:back:")) {
					await renderBrowser(decodeOpPath(op.slice(8)));
					return;
				}
				if (op.startsWith("ws:mk:submit:")) {
					const parent = decodeOpPath(op.slice(13));
					const form = formValuesOf(raw);
					try {
						const folderName = sanitizeDirectoryName(String(form?.name ?? ""));
						const target = join(parent, folderName);
						if (existsSync(target)) throw new Error("该目录已存在");
						mkdirSync(target, { recursive: false });
						await renderBrowser(parent);
					} catch (err) {
						await renderError("新建文件夹失败", err);
					}
					return;
				}
				if (op.startsWith("ws:mk:")) {
					await renderCard(workspaceNewFolderCard({ parentPath: decodeOpPath(op.slice(6)) }));
					return;
				}
				if (op.startsWith("ws:pick:")) {
					const target = decodeOpPath(op.slice(8));
					try {
						if (!statSync(target).isDirectory()) throw new Error("不是目录");
						if (!insideIsolation(target)) throw new Error(`已开启用户隔离：只能切换到自己的目录（${isolationRootFor(wsKey)}）下`);
						convCfg.set(wsKey, {
							workspaceRoot: target,
							activeSessionId: void 0
						});
						await conversations?.rotate(wsKey);
						if (panelCardId) await commandPanelSync.collapse(panelCardId, "workspace", `工作区已切换: ${target}（下一条消息在新工作区生效）`);
						else await sender.sendText(chatId, `工作区已切换: ${target}`);
					} catch (err) {
						await renderError("切换失败", err);
					}
					return;
				}
				if (op === "ws:cancel") {
					if (panelCardId) await commandPanelSync.collapse(panelCardId, "workspace", "已取消，保持原工作区");
					else await sender.sendText(chatId, "已取消，保持原工作区。");
					return;
				}
				return;
			}
			if (op.startsWith("goal:tpl:")) {
				const tpl = op.slice(9);
				const sessionKey = routeStore.all().find((r) => r.chatId === chatId)?.sessionKey ?? (chatId ? `dm:${chatId}` : "");
				workspaceForTaskKey(sessionKey);
				let obj = "构建工程并运行全量测试验证";
				if (tpl === "fix") obj = "诊断并修复当前工程中的已知问题与测试失败";
				else if (tpl === "refactor") obj = "重构核心模块并补齐单元测试与文档";
				let agentHandle = sessionKey ? bridge.backend?.get(sessionKey) : void 0;
				if (!agentHandle && sessionKey) try {
					agentHandle = await bridge.backend?.ensureAgent?.(sessionKey);
				} catch {}
				const rawAgent = resolveRawAgent(agentHandle);
				const goalsService = ctx.get?.("goals");
				try {
					if (rawAgent && goalsService?.create) goalsService.create(rawAgent, { objective: obj });
					await sender.sendText(chatId, `🎯 已设定目标：${obj}\nAgent 将围绕该目标自主执行。`);
				} catch (err) {
					await sender.sendText(chatId, `设定目标失败: ${err instanceof Error ? err.message : String(err)}`);
				}
				return;
			}
			const sep = op.indexOf(":");
			const cmd = sep === -1 ? op : op.slice(0, sep);
			const arg = sep === -1 ? "" : op.slice(sep + 1);
			const knownRoute = routeStore.all().find((r) => r.chatId === chatId);
			const pseudo = {
				messageId: messageId ? `${messageId}#${op}` : `card#${Date.now()}#${op}`,
				chatId,
				chatType: knownRoute?.chatType === "group" ? "group" : "p2p",
				chatMode: knownRoute?.chatType === "group" ? "group_all" : "p2p",
				senderOpenId: chatId,
				msgType: "interactive",
				content: "",
				text: "",
				mentions: [],
				timestamp: Date.now()
			};
			if (panelCardId) commandPanelSync.adopt(chatId, `bridge:${cmd}:${pseudo.messageId}`, panelCardId, cmd);
			await bridgeHandler(cmd, arg, pseudo);
		} catch (err) {
			logger.error(`card action failed: ${String(err)}`);
		}
	};
	const sessionPersistenceService = ctx.get?.("sessionPersistence");
	const replaySalvage = createReplaySalvage({
		loadSession: async (id) => sessionPersistenceService?.load?.(id),
		enqueue: (input) => outbox.enqueue(input),
		wal: inboundWal,
		logger
	});
	const messageHandler = createMessageHandler({
		ctx: bridge,
		commands: commandRouter,
		groupTrigger,
		dedupe,
		usage: userUsage,
		allowlist: () => getCfg().allowlist,
		wal: inboundWal,
		inboundDir: getCfg().attachments.dir.trim() || join(tmpdir(), "dsh-lark-link", "inbound")
	});
	const turnDelivered = /* @__PURE__ */ new Set();
	const conversations = createConversationManager({
		backend,
		registry: taskRegistry,
		maxSessions: getCfg().maxSessions,
		idleTtlMs: getCfg().sessionIdleTtlMs,
		logger,
		onActiveSessionId: (key, sessionId) => {
			convCfg.set(key, { activeSessionId: sessionId });
		},
		onEvent: (key, event) => {
			const conversationKey = conversationKeyOf(key);
			forwarder.onSessionEvent(key, event).catch((e) => logger.warn(`forwarder: ${String(e)}`));
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
			if (event.type === "tool/call" || event.type === "tool/result") turnSupervisor.arm(key);
			if (event.type === "assistant/message") {
				if ((event.text ?? "").trim() !== "") {
					turnSupervisor.disarm(key);
					turnDelivered.add(key);
				} else turnSupervisor.arm(key);
			}
			if (event.type === "turn/end") {
				turnSupervisor.disarm(key);
				streamHandles.delete(key);
				const reason = event.reason;
				const rescuedFinal = String(event.finalText ?? "").trim();
				const noOutput = !turnDelivered.has(key) && (rescuedFinal === "" || rescuedFinal === "No response.");
				const silent = noOutput && (reason === "rejected" || reason === "failed" || reason === "error");
				turnDelivered.delete(key);
				const imageRetryInFlight = silent && backend.consumeImageRetryGrace?.(key);
				if (noOutput && !imageRetryInFlight) {
					inboundWal.failOldest(conversationKey);
					status.refreshCounters({
						inboundPending: inboundWal.pendingReplays().length,
						inboundFailed: inboundWal.failedCount()
					});
				}
				if (imageRetryInFlight) logger.warn(`turn ended '${reason}' for ${key} but an image-degrade retry is in flight; skipping error notice`);
				else if (silent && !getCfg().streaming.enabled) {
					logger.warn(`turn ended '${reason}' with no output for ${key}`);
					const chatId = routeStore.get(key)?.chatId;
					if (chatId) {
						const failure = event.error;
						const detail = failure?.message ?? "";
						const diagnostic = failure?.code === "qwen_gateway_rate_limited" || /Baxia|temporarily rejecting this account/i.test(detail) ? "千问网页触发 Baxia 风控；自动退避重试仍被拒绝。请等待冷却，或使用 /model 切换模型后重试。" : failure?.code === "empty_response" || /empty response/i.test(detail) ? "千问 SSE 已结束，但没有返回正文或有效工具调用。请重试；持续发生时建议 /new 后再试。" : /output changed before already-streamed content/i.test(detail) ? "千问网页在流式输出期间改写了已发送内容，为避免返回截断文本，本轮已拒绝该结果。请重试。" : `模型轮次异常结束${failure?.code ? `（${failure.code}）` : ""}。请重试。`;
						sender.sendText(chatId, `⚠️ 本轮没有产出回复：${diagnostic}`).catch(() => void 0);
					}
				}
				if (noOutput && !imageRetryInFlight && reason !== "aborted" && reason !== "cancelled") queueMicrotask(() => {
					const conversationKey = conversationKeyOf(key);
					conversations.rotate(conversationKey).catch((err) => logger.warn(`automatic failed-turn rotation for ${conversationKey}: ${String(err)}`));
				});
			}
		}
	});
	const turnSupervisor = createTurnSupervisor({
		backend,
		timeoutMs: 6e5,
		logger
	});
	const compensation = createMissedCompensation({
		routes: routeStore,
		listMessages: (p) => sender.listMessages(p),
		reinject: (msg) => messageHandler.handleCompensated(msg),
		logger
	});
	let lastModelSig = liveModelSelection.provider && liveModelSelection.model ? `${liveModelSelection.provider}/${liveModelSelection.model}/${liveModelSelection.reasoningEffort ?? "default"}` : "";
	let modelPollTimer;
	const startModelDefaultPoll = () => {
		if (modelPollTimer || !admService?.currentSelection) return;
		const t = setInterval(() => {
			try {
				if (getCfg().modelAccess.defaultModel) return;
				const cur = admService?.currentSelection?.();
				if (!cur?.provider || !cur.model) return;
				if (!isModelAllowed(getCfg().modelAccess, {
					provider: cur.provider,
					model: cur.model
				})) return;
				const sig = `${cur.provider}/${cur.model}/${cur.reasoningEffort ?? "default"}`;
				if (sig === lastModelSig) return;
				lastModelSig = sig;
				liveModelSelection.provider = cur.provider;
				liveModelSelection.model = cur.model;
				liveModelSelection.reasoningEffort = cur.reasoningEffort;
				logger.info(`bridge default model now ${sig} (GUI-side switch)`);
			} catch {}
		}, 1e4);
		t.unref?.();
		modelPollTimer = t;
	};
	const stopModelDefaultPoll = () => {
		if (modelPollTimer) clearInterval(modelPollTimer);
		modelPollTimer = void 0;
	};
	let lifecycleStarted = false;
	let startPromise;
	let supervisor;
	const startBridgeOnce = async () => {
		if (lifecycleStarted) return;
		const ref = getCfg().credentialRef;
		const creds = await resolveCredentials(credStore, ref);
		if (!creds) {
			startBlocker = `未配置飞书凭据（ref=${ref}）。请先运行 /lark setup 扫码，或设置 DSH_LARK_APP_ID/DSH_LARK_APP_SECRET 后再 /lark setup。`;
			logger.warn(startBlocker);
			return;
		}
		startBlocker = void 0;
		logger.info("starting bridge…");
		try {
			larkClient = await buildLarkClient({
				appId: creds.appId,
				appSecret: creds.appSecret,
				domain: creds.domain,
				logger
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
		const transport = createTransport({
			getClient: () => larkClient ?? {},
			onMessage: async (msg) => {
				const pendingForChat = [...pendingQuestions.values()].find((p) => p.chatId === msg.chatId);
				if (pendingForChat && (msg.text ?? "").trim() !== "") {
					clearTimeout(pendingForChat.timer);
					pendingQuestions.delete(pendingForChat.questionId);
					const text = (msg.text ?? "").trim();
					pendingForChat.resolve({
						id: pendingForChat.questionId,
						selected: [],
						custom: text
					});
					return;
				}
				await messageHandler.handleInbound(msg);
			},
			onEvent: (event, data) => {
				if (event === "card.action.trigger") handleCardAction(data);
			},
			logger
		});
		bridge.setTransport(transport);
		supervisor = createConnectionSupervisor({
			transport,
			quota: createQuotaGovernor(join(dir, "conn-history.jsonl"), {
				windowMinutes: getCfg().quota.windowMinutes,
				limit: getCfg().quota.limit
			}),
			status,
			cfg: {
				probeIntervalMs: getCfg().supervisor.probeIntervalMs,
				probeTimeoutMs: getCfg().supervisor.probeTimeoutMs,
				probeFailThreshold: getCfg().supervisor.probeFailThreshold,
				maxReconnectAttempts: getCfg().supervisor.maxReconnectAttempts,
				idleKeepaliveMs: getCfg().supervisor.idleKeepaliveMs,
				quotaWindowMinutes: getCfg().quota.windowMinutes,
				quotaLimit: getCfg().quota.limit
			},
			logger,
			onStateChange: (state, detail) => {
				if (state === "connected") bridge.setBotOpenId(transport.botOpenId());
				logger.info(`conn state: ${state}${detail ? ` (${detail})` : ""}`);
			}
		});
		await supervisor.start();
		bridge.setBotOpenId(transport.botOpenId());
		status.refreshCounters({
			outboxPending: outbox.pendingCount(),
			outboxFailed: outbox.failedCount(),
			inboundPending: inboundWal.pendingReplays().length,
			inboundFailed: inboundWal.failedCount()
		});
		status.setConn("connected", { wsReady: transport.wsReady() });
		bridge.setStarted(true);
		lifecycleStarted = true;
		(async () => {
			let replayed = 0;
			let salvaged = 0;
			try {
				inboundWal.prune();
				for (const rec of inboundWal.pendingReplays()) {
					if (!inboundWal.markReplay(rec.messageId)) continue;
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
							chatMode: rec.chatType === "p2p" ? "p2p" : "group_all",
							senderOpenId: rec.senderOpenId,
							msgType: "text",
							content: rec.text,
							text: rec.text,
							mentions: [],
							timestamp: rec.acceptedAt
						});
						replayed++;
					} catch (err) {
						logger.warn(`inbound replay failed for ${rec.messageId}: ${err instanceof Error ? err.message : String(err)}`);
					}
				}
				if (replayed > 0 || salvaged > 0) logger.info(`inbound replay: ${salvaged} answered from session logs, ${replayed} re-dispatched`);
				status.refreshCounters({
					inboundPending: inboundWal.pendingReplays().length,
					inboundFailed: inboundWal.failedCount()
				});
			} catch (err) {
				logger.warn(`inbound replay errored: ${err instanceof Error ? err.message : String(err)}`);
			}
		})();
		logger.info("bridge started (in-process) [HMR-RELOAD-MARKER-2]");
	};
	const startBridge = () => {
		if (lifecycleStarted) return Promise.resolve();
		if (startPromise) return startPromise;
		const pending = startBridgeOnce();
		startPromise = pending;
		const release = () => {
			if (startPromise === pending) startPromise = void 0;
		};
		pending.then(release, release);
		return pending;
	};
	const stopBridge = async () => {
		const pending = startPromise;
		if (pending) try {
			await pending;
		} catch {}
		if (!lifecycleStarted) return;
		logger.info("stopping bridge…");
		turnSupervisor.stop();
		stopModelDefaultPoll();
		await supervisor?.stop();
		supervisor = void 0;
		await outbox.stop();
		await conversations.disposeAll();
		bridge.setStarted(false);
		status.setConn("stopped");
		lifecycleStarted = false;
		logger.info("bridge stopped");
	};
	applyBridgePolicy = async (input) => {
		if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("策略内容无效");
		const body = input;
		if (!body.modelAccess || typeof body.modelAccess !== "object") throw new TypeError("缺少模型访问策略");
		const catalog = await listModelCatalog();
		const catalogRefs = new Set(catalog.flatMap((group) => group.models.map((model) => modelRef({
			provider: group.provider,
			model: model.id
		}))));
		const restricted = body.modelAccess.restricted === true;
		const allowedModels = normalizeModelRefs(body.modelAccess.allowedModels);
		const unknownAllowed = allowedModels.filter((ref) => !catalogRefs.has(ref));
		if (unknownAllowed.length > 0) throw new TypeError(`以下模型当前不可用: ${unknownAllowed.join(", ")}`);
		if (restricted && allowedModels.length === 0) throw new TypeError("启用模型白名单时至少保留一个模型");
		let defaultModel = String(body.modelAccess.defaultModel ?? "").trim();
		if (defaultModel) {
			const parsed = parseModelRef(defaultModel);
			if (!parsed || !catalogRefs.has(modelRef(parsed))) throw new TypeError(`默认模型当前不可用: ${defaultModel}`);
			defaultModel = modelRef(parsed);
		}
		if (restricted && defaultModel && !allowedModels.includes(defaultModel)) throw new TypeError("默认模型必须位于允许列表中");
		if (restricted && !defaultModel) defaultModel = allowedModels[0] ?? "";
		const oldWorkspace = getCfg().workspaceRoot;
		const workspaceInput = String(body.workspaceRoot ?? "").trim();
		const workspaceRoot = workspaceInput ? resolveWorkspaceTarget(oldWorkspace || process.cwd(), workspaceInput) : "";
		if (workspaceRoot) {
			if (!existsSync(workspaceRoot)) throw new TypeError(`工作区不存在: ${workspaceRoot}`);
			if (!statSync(workspaceRoot).isDirectory()) throw new TypeError(`工作区不是目录: ${workspaceRoot}`);
		}
		const nextPolicy = {
			restricted,
			allowedModels,
			defaultModel
		};
		const host = admService?.currentSelection?.();
		const firstCatalogModel = catalog[0]?.models[0] ? {
			provider: catalog[0].provider,
			model: catalog[0].models[0].id
		} : void 0;
		const nextDefault = pickEffectiveDefault(nextPolicy, host?.provider && host.model ? {
			provider: host.provider,
			model: host.model
		} : void 0) ?? (!restricted ? firstCatalogModel : void 0);
		if (!nextDefault) throw new TypeError("当前策略无法解析出可用的默认模型");
		configStore.updateManagementPolicy({
			modelAccess: nextPolicy,
			workspaceRoot
		});
		configStore.saveOverrides();
		liveModelSelection.provider = nextDefault.provider;
		liveModelSelection.model = nextDefault.model;
		delete liveModelSelection.reasoningEffort;
		for (const key of convCfg.keys()) {
			const current = convCfg.get(key);
			if (current.provider && current.model && !isModelAllowed(getCfg().modelAccess, {
				provider: current.provider,
				model: current.model
			})) convCfg.set(key, {
				provider: void 0,
				model: void 0,
				reasoningEffort: void 0
			});
		}
		for (const [key, selection] of liveModels) if (!selection.override || !isModelAllowed(getCfg().modelAccess, selection)) {
			selection.provider = nextDefault.provider;
			selection.model = nextDefault.model;
			delete selection.reasoningEffort;
			selection.override = false;
			backend?.clearImageUnsupported?.(key);
		}
		if (workspaceRoot !== oldWorkspace) {
			const keys = /* @__PURE__ */ new Set([...liveModels.keys(), ...userUsage.list().map((usage) => usage.sessionKey)]);
			for (const key of keys) {
				if (convCfg.get(key).workspaceRoot) continue;
				convCfg.set(key, { activeSessionId: void 0 });
				await conversations.rotate(key);
			}
		}
		logger.info(`app policy updated: models=${restricted ? allowedModels.join(",") : "all"} default=${modelRef(nextDefault)} workspace=${workspaceRoot || "process.cwd"}`);
		return {
			modelAccess: getCfg().modelAccess,
			workspaceRoot
		};
	};
	applyManualCredentials = async (input) => {
		const credentials = normalizeManualCredentials(input);
		const previous = await resolveCredentials(credStore, getCfg().credentialRef);
		const appSwitched = Boolean(previous && previous.appId !== credentials.appId);
		await stopBridge();
		if (appSwitched) {
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
				inboundFailed: 0
			});
		}
		await persistCredentials(credStore, getCfg().credentialRef, credentials);
		startBlocker = void 0;
		await startBridge();
		if (!lifecycleStarted) throw new Error(startBlocker ?? "飞书连接未能启动，请检查应用凭据");
		return {
			configured: true,
			appSwitched,
			appIdMasked: maskId(credentials.appId),
			domain: credentials.domain,
			connState: status.get().connState
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
	const sitePreviews = createSitePreviewManager({
		stateDir: stateDir(),
		logger
	});
	ctx.tools.register(defineTool({
		name: "lark_send_local_file",
		description: "Send a local file or image to the current Feishu chat. Feishu-only: it needs the session to be bound to a Feishu conversation, so it fails in the DSH Web GUI.",
		parameters: {
			path: {
				type: "string",
				required: true,
				description: "Absolute local path"
			},
			kind: {
				type: "string",
				required: true,
				description: "image（png/jpeg/webp/gif，其他格式如 svg 自动按 file 发送）| file"
			},
			caption: {
				type: "string",
				description: "Optional caption text"
			}
		},
		output: {
			schema: { type: "string" },
			render: (_args, value) => [{
				type: "text",
				text: value
			}]
		},
		async execute(args, exec) {
			const sessionId = exec.agent?.id ?? "";
			const workspaceRoot = workspaceForTaskKey(conversationKeyForSessionId(sessionId));
			const { abs, ok: inWorkspace } = resolveInWorkspacePath(args.path, workspaceRoot);
			if (!inWorkspace) return "拒绝: 路径不在工作区内";
			const route = routeForSessionId(sessionId);
			if (!route) return "错误: 当前会话未绑定飞书对话，无法发送文件（请在飞书里对我说）";
			const key = route.sessionKey;
			const client = getLarkClient();
			if (!client) return "错误: lark 客户端未就绪";
			const isImage = args.kind === "image" && /\.(png|jpe?g|webp|gif)$/i.test(args.path);
			if (isImage ? !client.uploadImage : !client.uploadFile) return "错误: lark 客户端未就绪";
			let buf;
			try {
				if (statSync(abs).size > 26214400) return "错误: 文件超过 25MB 上限";
				buf = readFileSync(abs);
			} catch (err) {
				return `错误: 读取文件失败 (${err instanceof Error ? err.message : String(err)})`;
			}
			const fileName = args.path.split(/[\\/]/).pop() ?? "file";
			let uploadKey;
			if (isImage) uploadKey = extractUploadKey(await client.uploadImage({ image: buf }), "image_key");
			else uploadKey = extractUploadKey(await client.uploadFile({
				file_type: "file",
				file_name: fileName,
				file: buf
			}), "file_key");
			if (!uploadKey) return "错误: 上传失败";
			const liveCard = streamHandles.get(key);
			if (isImage && liveCard && !liveCard.disposed) {
				await liveCard.image(uploadKey, args.caption || fileName);
				return `已嵌入当前回复卡片 ${args.path}`;
			}
			await sender.sendFile(route.chatId, uploadKey, isImage ? "image" : "file");
			return `已发送 ${args.path}`;
		}
	}));
	ctx.tools.register(defineTool({
		name: "lark_publish_site",
		description: "Publish a webpage/game/front-end artifact as a TEMPORARY public link the user can open on their phone, and deliver a Feishu site card. Provide ONE of: url (an http server already running, e.g. a dev server), port (its port), or dir (a built static directory — served by the bridge). The bridge owns the tunnel lifecycle: same target reuses the previous link, a dead tunnel is refreshed with a new link, a different target replaces the old one. Links expire after ~2h. Works from ANY session; the site card is only delivered when the session is bound to a Feishu chat — otherwise use the returned link in your reply.",
		parameters: {
			url: {
				type: "string",
				description: "http(s) URL already reachable from this host"
			},
			port: {
				type: "number",
				description: "port of an already-running local server"
			},
			dir: {
				type: "string",
				description: "absolute path of a static directory to serve (index.html)"
			},
			title: {
				type: "string",
				description: "optional display title"
			}
		},
		output: {
			schema: { type: "string" },
			render: (_args, value) => [{
				type: "text",
				text: value
			}]
		},
		async execute(args, exec) {
			const sessionId = exec.agent?.id ?? "";
			const route = routeForSessionId(sessionId);
			const convKey = route?.sessionKey ?? (conversationKeyForSessionId(sessionId) || sessionId);
			let result;
			try {
				result = await sitePreviews.publish({
					convKey,
					...route?.chatId ? { chatId: route.chatId } : {},
					url: args.url,
					port: typeof args.port === "number" ? args.port : void 0,
					dir: typeof args.dir === "string" ? args.dir : void 0,
					title: typeof args.title === "string" ? args.title : void 0
				});
			} catch (err) {
				return `错误: ${err instanceof Error ? err.message : String(err)}`;
			}
			let delivery = "当前会话未绑定飞书对话（如 DSH Web GUI），未发卡片；";
			if (route) try {
				await sender.sendCard(route.chatId, sitePreviewCard({
					title: result.title,
					publicUrl: result.publicUrl,
					debugUrl: result.debugUrl,
					origin: result.target,
					label: result.label,
					action: result.action,
					expiresAt: result.expiresAt
				}));
				delivery = "网站卡片已发给用户；";
			} catch (err) {
				logger.warn(`site preview card send failed: ${err instanceof Error ? err.message : String(err)}`);
				delivery = "卡片发送失败；";
			}
			return `已发布（${result.action}）: ${result.publicUrl}（调试 ${result.debugUrl}，约 2 小时有效）。${delivery}把链接也写进回复。`;
		}
	}));
	ctx.tools.register(defineTool({
		name: "lark_config_get",
		description: "Read bridge config (hot-reloadable keys).",
		parameters: {},
		output: {
			schema: { type: "string" },
			render: (_a, v) => [{
				type: "text",
				text: v
			}]
		},
		async execute() {
			return JSON.stringify(getCfg(), null, 2);
		}
	}));
	const commandsCtx = ctx;
	const registerCmd = (name, description, handler, inputHint) => {
		commandsCtx.commands?.register?.({
			name,
			description,
			...inputHint !== void 0 ? { input: { hint: inputHint } } : {},
			handler: async (inv) => ({
				kind: "success",
				text: await handler(inv?.rawInput ?? "")
			})
		});
	};
	const runLarkSubcommand = async (sub) => {
		switch (sub) {
			case "status": return formatStatusLine(status.get());
			case "start":
				await startBridge();
				return lifecycleStarted ? "bridge started" : startBlocker ?? "bridge 未启动";
			case "stop":
				await stopBridge();
				return "bridge stopped";
			case "restart":
				await stopBridge();
				await startBridge();
				return lifecycleStarted ? "bridge restarted" : startBlocker ?? "bridge 未启动";
			case "setup": return await runSetup();
			case "uninstall-clean": return await runUninstallClean();
			default: return "Lark Link 用法：/lark setup | start | stop | restart | status | uninstall-clean";
		}
	};
	registerCmd("lark", "Lark Link bridge — usage: /lark setup|start|stop|restart|status|uninstall-clean", async (rawInput) => runLarkSubcommand((rawInput.trim().split(/\s+/)[0] ?? "").toLowerCase()), "setup|start|stop|restart|status|uninstall-clean");
	/**
	* Locate the DSH session log for a bridge session id. Persisted logs live
	* at <DSH_HOME>/sessions/<workspace-dir>/<encoded-session-id>/session.jsonl.zstd
	* where ":" encodes as "~003A" — scan every workspace dir for the match.
	*/
	/** Scan ~/.dsh/sessions for the most recently written lark-link session id. */
	const findLatestLarkSessionId = () => {
		const sessionsRoot = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "sessions");
		if (!existsSync(sessionsRoot)) return void 0;
		let latest;
		for (const wsDir of readdirSync(sessionsRoot)) {
			const wsPath = join(sessionsRoot, wsDir);
			let entries = [];
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
				if (!latest || mtime > latest.mtime) latest = {
					id: name.replace(/~003A/g, ":"),
					mtime
				};
			}
		}
		return latest?.id;
	};
	const buildSessionExportZip = async (sessionId, diagText, issueMd) => {
		try {
			const services = ctx;
			const persistence = services.get?.("sessionPersistence");
			const query = services.get?.("sessionQuery");
			const files = [];
			let root;
			if (persistence?.readRaw) try {
				root = await persistence.readRaw(sessionId);
			} catch (err) {
				logger.warn(`doctor: sessionPersistence.readRaw failed: ${err instanceof Error ? err.message : String(err)}`);
			}
			else logger.warn("doctor: sessionPersistence service unavailable — falling back to file scan");
			if (root) {
				files.push({
					name: root.filename,
					data: Buffer.from(root.content, "utf8")
				});
				const seen = /* @__PURE__ */ new Set([sessionId]);
				const collect = async (nodes) => {
					for (const node of nodes) {
						const id = node.session.header.id;
						if (seen.has(id)) continue;
						seen.add(id);
						const raw = await persistence?.readRaw?.(id);
						if (raw !== void 0) {
							const safe = id.replace(/[^A-Za-z0-9_-]/g, "_");
							files.push({
								name: `subagents/${safe}/${raw.filename}`,
								data: Buffer.from(raw.content, "utf8")
							});
						}
						await collect(node.descendants ?? []);
					}
				};
				if (query?.traceSession) try {
					await collect((await query.traceSession(sessionId)).descendants);
				} catch (err) {
					logger.warn(`doctor: traceSession failed (subagents skipped): ${err instanceof Error ? err.message : String(err)}`);
				}
			}
			if (files.length === 0) {
				const sessionsRoot = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "sessions");
				const encoded = sessionId.replace(/:/g, "~003A");
				let zstdPath;
				if (existsSync(sessionsRoot)) for (const wsDir of readdirSync(sessionsRoot)) {
					const candidate = join(sessionsRoot, wsDir, encoded, "session.jsonl.zstd");
					if (existsSync(candidate)) {
						zstdPath = candidate;
						break;
					}
				}
				if (!zstdPath) {
					logger.warn(`doctor: no session log found for ${sessionId} (service + file scan)`);
					return;
				}
				const jsonl = zstdDecompressSync(readFileSync(zstdPath)).toString("utf8");
				logger.info(`doctor: file-scan fallback used: ${zstdPath}`);
				files.push({
					name: "session.jsonl",
					data: Buffer.from(jsonl, "utf8")
				});
			}
			files.push({
				name: "ISSUE.md",
				data: Buffer.from(`# dsh-lark-link 诊断包\n\n${diagText}\n\n${issueMd}\n`, "utf8")
			});
			files.push({
				name: "README.txt",
				data: Buffer.from([
					"本压缩包内容：",
					"- session.jsonl: 当前会话的 DSH session log（与 WebUI 右上角 Session log 下载一致）",
					"- subagents/: 子代理会话日志",
					"- ISSUE.md: 脱敏诊断信息（配置/连接状态/Outbox 等）",
					"",
					"将本包直接发给维护者，或贴 ISSUE.md 给 AI 即可定位问题。"
				].join("\n"), "utf8")
			});
			const { zipSync, strToU8 } = await import("fflate");
			const entries = {};
			for (const f of files) entries[f.name] = strToU8(new TextDecoder().decode(f.data));
			const buf = Buffer.from(zipSync(entries, { level: 6 }));
			logger.info(`doctor: zip built (${files.length} files, ${buf.length} bytes)`);
			return buf;
		} catch (err) {
			logger.warn(`doctor: zip build failed: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
	};
	const runSetup = async () => {
		const ref = getCfg().credentialRef;
		const envAppId = process.env.DSH_LARK_APP_ID?.trim();
		const envSecret = process.env.DSH_LARK_APP_SECRET?.trim();
		if (envAppId && envSecret) {
			const envDomain = process.env.DSH_LARK_DOMAIN === "lark" ? "lark" : "feishu";
			await persistCredentials(credStore, ref, {
				appId: envAppId,
				appSecret: envSecret,
				domain: envDomain
			});
			return `凭据已保存（env 手动，appId=${maskId(envAppId)}，domain=${envDomain}）。运行 /lark start 启动。`;
		}
		let qrInfo;
		(async () => {
			const setup = createAuthSetup({
				registerApp: registerAppWithFetch(),
				persist: async (c) => {
					await persistCredentials(credStore, ref, c);
				},
				logger
			});
			try {
				const res = await setup.run({
					onQRCodeReady(info) {
						qrInfo = info;
						QRCode.toBuffer(info.url, {
							type: "png",
							margin: 1,
							width: 256
						}).then((png) => {
							activeQr = {
								png,
								expireAt: Date.now() + info.expireIn * 1e3
							};
						}).catch((e) => logger.warn(`qr png failed: ${e instanceof Error ? e.message : String(e)}`));
						try {
							qrcode.generate(info.url, { small: true }, (qr) => console.log(`\n${qr}`));
						} catch {}
					},
					onStatusChange: (s) => logger.info(`setup: ${s}`)
				});
				logger.info(`setup complete: appId=${res.appId} domain=${res.domain}`);
				activeQr = void 0;
			} catch (err) {
				logger.warn(`setup background failed: ${err instanceof Error ? err.message : String(err)}`);
				activeQr = void 0;
			}
		})();
		const deadline = Date.now() + 3e4;
		while (!qrInfo && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
		if (!qrInfo) return "扫码流程未在 30s 内就绪。可改用手动通道：设 DSH_LARK_APP_ID + DSH_LARK_APP_SECRET 后再 /lark setup。";
		console.log(`飞书授权二维码链接: ${qrInfo.url}（${qrInfo.expireIn} 秒后过期）`);
		return [
			"📱 飞书授权二维码已生成 —— 见左侧 🪶 Lark 面板（或终端），手机飞书扫码确认。",
			"",
			`二维码 ${qrInfo.expireIn} 秒后过期。扫码后凭据在后台写入，运行 /lark start 启动。`,
			`备用链接（手机浏览器打开）：${qrInfo.url}`,
			"看不到二维码？终端也打印了；或用 DSH_LARK_APP_ID/SECRET 手动通道。"
		].join("\n");
	};
	const runUninstallClean = async () => {
		await stopBridge();
		const ref = getCfg().credentialRef;
		await clearCredentials(credStore, ref);
		larkClient = void 0;
		for (const f of [
			"config.json",
			"routes.json",
			"dedupe.jsonl",
			"conn-history.jsonl",
			"status.json",
			"runtime-overrides.json"
		]) try {
			rmSync(join(dir, f), { force: true });
		} catch {}
		try {
			rmSync(join(dir, "outbox"), {
				recursive: true,
				force: true
			});
		} catch {}
		try {
			rmSync(join(dir, "inbound-wal"), {
				recursive: true,
				force: true
			});
		} catch {}
		return `已清除凭据（ref=${ref}）并清理状态目录 ${dir}。重新使用请运行 /lark setup。`;
	};
	try {
		ctx.systemPrompt?.section?.({
			priority: 200,
			section: () => ({
				role: "system",
				content: [
					"你正在通过飞书/Lark 桥接与用户对话。",
					"可用工具: lark_send_local_file（发送本地文件到当前飞书会话）、lark_publish_site（把网页/游戏/前端产物发布成临时公网链接并给用户发网站卡片）、lark_config_get（读取桥配置）。",
					"需要让用户临时查看网页/游戏/前端产物时，调用 lark_publish_site：dev server 跑起来后传 port=<端口>；纯静态产物传 dir=<构建产物目录>。工具会自动管理隧道生命周期（相同目标自动复用旧链接）并把网站卡片发给用户；不要自己拼公网链接，也不要重复发布相同目标。",
					"回复要简洁；长输出会自动流式呈现给用户。"
				].join("\n")
			})
		});
	} catch {}
	ctx.effect(() => {
		startBridge();
		const stopMediaSweeper = startMediaSweeper({
			mediaDir: join(getCfg().attachments.dir.trim() || join(tmpdir(), "dsh-lark-link", "inbound"), "media"),
			retentionHours: () => getCfg().attachments.retentionHours,
			logger
		});
		const sweep = setInterval(() => {
			const n = conversations.sweep();
			status.update({
				sessions: conversations.size(),
				outboxPending: outbox.pendingCount(),
				outboxFailed: outbox.failedCount(),
				inboundPending: inboundWal.pendingReplays().length,
				inboundFailed: inboundWal.failedCount()
			});
			if (n > 0) logger.info(`conversation sweep disposed ${n} idle session(s)`);
		}, 6e4);
		sweep.unref?.();
		return async () => {
			clearInterval(sweep);
			stopMediaSweeper();
			sitePreviews.stopAll();
			await stopBridge();
		};
	});
}
//#endregion
export { apply, inject, name, stateDir };
