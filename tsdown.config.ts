// Build config for dsh-lark-link (tsdown / rolldown).
// Host half: bundle src/index.ts → dist/index.js (ESM, node), keeping
// @deepseek-ai/* (provided by the harness host at runtime), the Lark SDK and
// node builtins external.
// Client half: bundle src/client/index.ts → dist/client.js in the DSH
// ModuleLoader closure-factory format (window.__ModuleLoader__.load).

import { defineConfig } from "tsdown";

const hostExternals = [
	/^@deepseek-ai\//,
	"@larksuiteoapi/node-sdk",
	"qrcode-terminal",
	/^node:/,
];

export default defineConfig([
	{
		entry: { index: "src/index.ts" },
		outDir: "dist",
		format: ["esm"],
		platform: "node",
		target: "es2024",
		dts: true,
		clean: true,
		fixedExtension: false,
		external: hostExternals,
	},
	{
		entry: { client: "src/client/index.ts" },
		outDir: "dist",
		format: ["cjs"],
		platform: "browser",
		target: "es2024",
		dts: false,
		clean: false,
		fixedExtension: false,
		external: [/^@deepseek-ai\//, "react"],
		outputOptions: {
			entryFileNames: "client.js",
			// The registration id must be the FULL published package name: the
			// client-modules host requests each bundle under its package name
			// (`plugins/?<id>/client.js`) and then asserts the script registered
			// that same id. A bare `dsh-lark-link` never matches, so the browser
			// reports `loaded without registering "@very12345/dsh-lark-link"`.
			banner: `window.__ModuleLoader__.load({ id: "@very12345/dsh-lark-link", factory: (require) => {`,
			intro: "var module = { exports: {} }; var exports = module.exports;",
			footer: "return module.exports; } });",
		},
	},
]);
