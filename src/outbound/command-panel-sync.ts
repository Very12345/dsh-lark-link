import { randomUUID } from "node:crypto";
import {
	commandCollapsedCard,
	commandFailedCard,
	commandInteractivePanelCard,
	commandRunningCard,
} from "../presentation/cards.ts";

export interface CommandPanelApi {
	createCard(payload: unknown): Promise<{ card_id?: string; data?: { card_id?: string } } | undefined>;
	deliverCard(cardId: string, chatId: string): Promise<unknown>;
	updateCard?(cardId: string, body: { card: { type: "card_json"; data: string }; sequence: number; uuid: string }): Promise<unknown>;
}

export interface CommandPanelEntry {
	id?: string;
	command: string;
	result: string;
	at?: number;
	/** Settle the panel red when the command failed (default "ok"). */
	status?: "ok" | "error";
}

export interface CommandPanelSync {
	append(chatId: string, entry: CommandPanelEntry): Promise<boolean>;
	start(chatId: string, id: string, command: string): Promise<boolean>;
	cancel(chatId: string, id: string): Promise<void>;
	showCard(chatId: string, id: string, command: string, card: unknown): Promise<boolean>;
	adopt(chatId: string, id: string, cardId: string, command: string): void;
	replace(cardId: string, command: string, card: unknown): Promise<void>;
	collapse(
		cardId: string,
		command: string,
		result: string,
		status?: "ok" | "error",
	): Promise<void>;
	clear(chatId?: string): void;
}

const extractCardId = (
	res: { card_id?: string; data?: { card_id?: string } } | undefined,
): string | undefined => res?.card_id ?? res?.data?.card_id;

/**
 * CardKit reports business failures as `{ code, msg }` (usually non-zero code)
 * instead of an HTTP error. The SDK resolves those normally, so an invalid card
 * or a rejected update used to look like a success and the caller silently did
 * nothing. Surface them as real errors so the caller can fall back.
 */
const cardkitError = (res: unknown): string | undefined => {
	if (!res || typeof res !== "object") return undefined;
	const r = res as {
		code?: unknown;
		msg?: unknown;
		data?: { code?: unknown; msg?: unknown };
	};
	const code = r.code ?? r.data?.code;
	if (typeof code === "number" && code !== 0) {
		return `cardkit error ${code}: ${String(r.msg ?? r.data?.msg ?? "unknown")}`;
	}
	return undefined;
};

/** Single-line form — panel HEADERS only (command names are short). */
const oneLine = (value: string, limit = 180): string =>
	String(value || "")
		.replace(/[\r\n\t]+/g, " ")
		.replace(/\s{2,}/g, " ")
		.trim()
		.slice(0, limit);

/**
 * Body form used inside a panel. Interior newlines are MEANINGFUL here: the
 * old implementation ran every command result through oneLine(), which folded
 * multi-line output (e.g. the /status detail block) into a single 180-character
 * string and silently discarded the remainder. Bodies are now only trimmed at
 * the edges and capped at PANEL_TEXT_LIMIT — anything larger is handed back to
 * the durable text channel instead of being clipped (see append()).
 */
export const PANEL_TEXT_LIMIT = 4000;

const panelText = (value: string, limit = PANEL_TEXT_LIMIT): string =>
	String(value || "")
		.replace(/\r\n?/g, "\n")
		.trim()
		.slice(0, limit);

export function createCommandPanelSync(
	api: CommandPanelApi,
	now: () => number = Date.now,
): CommandPanelSync {
	type State = {
		chatId: string;
		id: string;
		command: string;
		cardId?: string;
		seq: number;
		startedAt: number;
		tail: Promise<void>;
	};
	const states = new Map<string, State>();
	const byCardId = new Map<string, State>();
	const liveTimers = new Map<string, ReturnType<typeof setInterval>>();
	const stateKey = (chatId: string, id: string): string => `${chatId}\u0000${id}`;
	// Last sequence actually sent per CardKit entity. CardKit DISCARDS an
	// update whose sequence is not newer than the card's current one (it still
	// answers 0/success), so a second state attached to the same card — which is
	// exactly what adopt() does when a button on a rendered panel is clicked —
	// must not restart the counter at 1. Without this the click "did nothing":
	// the update was accepted and dropped.
	const cardSequences = new Map<string, number>();

	const nextSequence = (cardId: string, state: State): number => {
		state.seq += 1;
		const last = cardSequences.get(cardId) ?? 0;
		if (state.seq <= last) state.seq = last + 1;
		cardSequences.set(cardId, state.seq);
		return state.seq;
	};

	const queue = async <T>(state: State, op: () => Promise<T>): Promise<T> => {
		const run = state.tail.then(op, op);
		state.tail = run.then(() => undefined, () => undefined);
		return run;
	};

	const update = async (state: State, card: unknown): Promise<void> => {
		if (!state.cardId || !api.updateCard) throw new Error("CardKit command panel update unavailable");
		const sequence = nextSequence(state.cardId, state);
		const res = await api.updateCard(state.cardId, {
			card: { type: "card_json", data: JSON.stringify(card) },
			sequence,
			uuid: randomUUID(),
		});
		const failure = cardkitError(res);
		if (failure) throw new Error(failure);
	};

	const create = async (state: State, card: unknown): Promise<void> => {
		const created = await api.createCard({ type: "card_json", data: JSON.stringify(card) });
		const failure = cardkitError(created);
		if (failure) throw new Error(failure);
		state.cardId = extractCardId(created);
		if (!state.cardId) throw new Error("CardKit command panel create returned no card_id");
		cardSequences.set(state.cardId, 0);
		byCardId.set(state.cardId, state);
		await api.deliverCard(state.cardId, state.chatId);
	};

	const stopTimer = (key: string): void => {
		const timer = liveTimers.get(key);
		if (timer) clearInterval(timer);
		liveTimers.delete(key);
	};

	const ensureState = (chatId: string, id: string, command: string): State => {
		const key = stateKey(chatId, id);
		let state = states.get(key);
		if (!state) {
			state = {
				chatId,
				id,
				command: oneLine(command, 48),
				seq: 0,
				startedAt: now(),
				tail: Promise.resolve(),
			};
			states.set(key, state);
		}
		return state;
	};

	const collapseState = async (
		state: State,
		result: string,
		status: "ok" | "error" = "ok",
	): Promise<void> => {
		stopTimer(stateKey(state.chatId, state.id));
		await queue(state, async () => {
			const card =
				status === "error"
					? commandFailedCard(state.command, panelText(result))
					: commandCollapsedCard(state.command, panelText(result));
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
					const elapsed = Math.max(0, Math.floor((now() - state.startedAt) / 1000));
					void queue(state, () => update(state, commandRunningCard(state.command, elapsed))).catch(() => undefined);
				}, 1000);
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
			// A body too large for the panel entity is NOT clipped here: settle
			// the panel with a pointer and return false, which makes the caller's
			// durable text channel deliver the full message instead.
			const oversized = String(entry.result ?? "").length > PANEL_TEXT_LIMIT;
			try {
				await collapseState(
					state,
					oversized ? "内容较长，已单独发送（见下条消息）" : entry.result,
					entry.status,
				);
				return !oversized;
			} catch {
				return false;
			}
		},
		async showCard(chatId, id, command, card) {
			const state = ensureState(chatId, id, command);
			stopTimer(stateKey(chatId, id));
			try {
				// Cards WITHOUT callbacks (help / status / resumed briefings) are
				// rendered verbatim instead of being discarded: the old
				// hasCallback() guard collapsed them into "✅ 操作已完成", which is
				// exactly how /help lost its entire command list. Interactive
				// cards render through the same path — their callbacks get
				// _panel_card_id so a click updates THIS card in place.
				await queue(state, async () => {
					if (!state.cardId) await create(state, commandRunningCard(state.command, 0));
					await update(state, commandInteractivePanelCard(state.command, card, state.cardId!));
				});
				return true;
			} catch {
				return false;
			}
		},
		adopt(chatId, id, cardId, command) {
			if (!chatId || !id || !cardId) return;
			const state = ensureState(chatId, id, command);
			// One card, one owner: detach whoever held it before so its (now
			// stale) timer/finalizer can never write to this card again, and
			// continue that card's sequence through nextSequence().
			const previous = byCardId.get(cardId);
			if (previous && previous !== state) {
				if (previous.seq > state.seq) state.seq = previous.seq;
				previous.cardId = undefined;
			}
			state.cardId = cardId;
			byCardId.set(cardId, state);
		},
		async replace(cardId, command, card) {
			let state = byCardId.get(cardId);
			if (!state) {
				state = { chatId: "", id: `card:${cardId}`, command, cardId, seq: 0, startedAt: now(), tail: Promise.resolve() };
				byCardId.set(cardId, state);
			}
			await queue(state, () => update(state!, commandInteractivePanelCard(command, card, cardId)));
		},
		async collapse(cardId, command, result, status = "ok") {
			let state = byCardId.get(cardId);
			if (!state) {
				state = { chatId: "", id: `card:${cardId}`, command, cardId, seq: 0, startedAt: now(), tail: Promise.resolve() };
				byCardId.set(cardId, state);
			}
			const body = panelText(result);
			await queue(state, () =>
				update(
					state!,
					status === "error"
						? commandFailedCard(command, body)
						: commandCollapsedCard(command, body),
				),
			);
		},
		async cancel(chatId, id) {
			const key = stateKey(chatId, id);
			stopTimer(key);
			const state = states.get(key);
			if (state?.cardId) await collapseState(state, "已转交会话处理").catch(() => undefined);
		},
		clear(chatId) {
			for (const [key, state] of states) {
				if (!chatId || state.chatId === chatId) {
					stopTimer(key);
					states.delete(key);
					if (state.cardId) byCardId.delete(state.cardId);
				}
			}
		},
	};
}
