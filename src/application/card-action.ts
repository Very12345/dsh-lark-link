// Card-action callback helpers (schema 2.0 `card.action.trigger`).
//
// Form values live at `action.form_value` — SNAKE_CASE, per the official
// form-container documentation — while this bridge used to read
// `action.formValue`. Neither the Feishu SDK nor the transport normalizes the
// key, so that camelCase read silently returned undefined and EVERY form (新建
// 文件夹 / 重命名 / 迁移项目 / 多选问卷) behaved as if the user had submitted
// nothing. Both spellings are accepted here so neither an SDK change nor a
// hand-built payload can break a form again.

/** Submitted form values of one card action, or undefined when it carried none. */
export function formValuesOf(payload: unknown): Record<string, unknown> | undefined {
	const action = (payload as { action?: Record<string, unknown> } | undefined)?.action;
	const raw = action?.form_value ?? action?.formValue;
	return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
}
