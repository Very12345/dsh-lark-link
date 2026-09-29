import { test } from "node:test";
import assert from "node:assert/strict";
import { formValuesOf } from "../../../src/application/card-action.ts";

test("card-action: reads form_value (the spelling Feishu actually sends)", () => {
	// Regression: the bridge read `action.formValue` and therefore saw every
	// form submission as empty — 新建文件夹 / 重命名 / 迁移项目 / 多选问卷 all
	// silently failed. Official v2 callbacks use snake_case.
	const payload = {
		action: {
			value: { op: "manage:rename:submit:session-a" },
			form_value: { alias: "重要会话", Input_x: "1234" },
		},
	};
	assert.deepEqual(formValuesOf(payload), { alias: "重要会话", Input_x: "1234" });
});

test("card-action: still accepts a camelCase payload from older SDK builds", () => {
	assert.deepEqual(formValuesOf({ action: { formValue: { answer: ["1", "2"] } } }), {
		answer: ["1", "2"],
	});
});

test("card-action: button-only actions and junk payloads yield undefined", () => {
	assert.equal(formValuesOf({ action: { value: { op: "manage:list" } } }), undefined);
	assert.equal(formValuesOf({ action: {} }), undefined);
	assert.equal(formValuesOf({}), undefined);
	assert.equal(formValuesOf(undefined), undefined);
	assert.equal(formValuesOf({ action: { form_value: "not-an-object" } }), undefined);
});

test("card-action: an empty submitted form is returned as an empty object, not undefined", () => {
	// An empty object means "the form WAS submitted with nothing filled in" —
	// the caller must surface that as a validation error, not as a missing form.
	assert.deepEqual(formValuesOf({ action: { form_value: {} } }), {});
});
