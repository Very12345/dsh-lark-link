import { readFileSync, writeFileSync } from "node:fs";
import type { ChatType, FeishuInboundMessage } from "../common/types.ts";

export interface UserUsageRecord {
	sessionKey: string;
	chatId: string;
	chatType: ChatType;
	senderOpenId: string;
	senderName?: string;
	inboundMessages: number;
	firstSeenAt: number;
	lastSeenAt: number;
}

export interface UserUsageStore {
	recordInbound(sessionKey: string, message: FeishuInboundMessage): void;
	list(): UserUsageRecord[];
	clear(): void;
}

export function createUserUsageStore(
	file: string,
	now: () => number = Date.now,
): UserUsageStore {
	let records: Record<string, UserUsageRecord> = {};
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<
			string,
			UserUsageRecord
		>;
		if (parsed && typeof parsed === "object") records = parsed;
	} catch {
		records = {};
	}
	const persist = (): void => {
		writeFileSync(file, JSON.stringify(records, null, 2), { mode: 0o600 });
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
				...(message.senderName ? { senderName: message.senderName } : {}),
				inboundMessages: (previous?.inboundMessages ?? 0) + 1,
				firstSeenAt: previous?.firstSeenAt ?? at,
				lastSeenAt: at,
			};
			persist();
		},
		list: () =>
			Object.values(records)
				.map((record) => ({ ...record }))
				.sort((left, right) => right.lastSeenAt - left.lastSeenAt),
		clear() {
			records = {};
			persist();
		},
	};
}
