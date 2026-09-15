import type { ModelAccessConfig } from "../common/config.ts";

export interface ModelSelection {
	provider: string;
	model: string;
}

/** Split at the first slash; model ids may themselves contain slashes. */
export function parseModelRef(value: string): ModelSelection | undefined {
	const text = value.trim();
	const slash = text.indexOf("/");
	if (slash <= 0 || slash === text.length - 1) return undefined;
	const provider = text.slice(0, slash).trim();
	const model = text.slice(slash + 1).trim();
	return provider && model ? { provider, model } : undefined;
}

export function modelRef(selection: ModelSelection): string {
	return `${selection.provider}/${selection.model}`;
}

export function isModelAllowed(
	policy: ModelAccessConfig,
	selection: ModelSelection | string,
): boolean {
	if (!policy.restricted) return true;
	const ref = typeof selection === "string" ? selection : modelRef(selection);
	return policy.allowedModels.includes(ref);
}

/**
 * Resolve the app's effective default without ever escaping its allowlist.
 * A corrupt/stale restricted policy with no usable model deliberately yields
 * undefined rather than silently falling back to a host-paid model.
 */
export function pickEffectiveDefault(
	policy: ModelAccessConfig,
	hostDefault?: ModelSelection,
): ModelSelection | undefined {
	const configured = parseModelRef(policy.defaultModel);
	if (configured && isModelAllowed(policy, configured)) return configured;
	if (hostDefault && isModelAllowed(policy, hostDefault)) return hostDefault;
	if (policy.restricted) {
		for (const ref of policy.allowedModels) {
			const parsed = parseModelRef(ref);
			if (parsed) return parsed;
		}
	}
	return hostDefault;
}

export function normalizeModelRefs(values: unknown): string[] {
	if (!Array.isArray(values)) return [];
	return Array.from(
		new Set(
			values
				.map((value) => parseModelRef(String(value)))
				.filter((value): value is ModelSelection => Boolean(value))
				.map(modelRef),
		),
	);
}
