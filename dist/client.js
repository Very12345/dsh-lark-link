window.__ModuleLoader__.load({
	id: "@very12345/dsh-lark-link",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region src/client/index.ts
		const { createElement: h, useState, useEffect } = require("react");
		const win = globalThis;
		const name = "dsh-lark-link-client";
		const inject = ["slots"];
		/**
		* Compatibility shim for the legacy `settingsScope` client service.
		*
		* DSH 0.1.7-rc dropped that service (settings are now declared host-side via
		* `settings.installSection` and rendered by the generic settings UI), but the
		* WebAgent integration plugin shipped INSIDE webagent-dsh-core 7.4.4 still
		* injects it — so its client entry parks at
		* `pending (waiting for service: settingsScope)` and the GUI reports
		* "1 entry did not activate".
		*
		* The adaptation belongs HERE, in our plugin, rather than as a patch to the
		* vendor's versioned code: supplying the legacy contract lets that entry
		* activate untouched. It is deliberately READ-ONLY (`writable: false`): the
		* value the card shows is owned by the profile patch layer
		* (`webagent-integration.patch.yml` sets the search provider), so there is
		* nothing for the GUI to write back.
		*
		* `bind()` must hand back a STABLE snapshot object — the vendor card feeds it
		* to `React.useSyncExternalStore`, which re-renders forever on a new reference.
		*/
		function installLegacySettingsScope(ctx) {
			const compat = ctx;
			if (typeof compat.provide !== "function") return;
			try {
				if (compat.get?.("settingsScope")) return;
				const snapshots = /* @__PURE__ */ new Map();
				compat.provide("settingsScope", { bind(spec) {
					const namespace = String(spec?.namespace ?? "");
					let snapshot = snapshots.get(namespace);
					if (!snapshot) {
						snapshot = {
							status: "ready",
							writable: false,
							value: { provider: "deepseek" }
						};
						snapshots.set(namespace, snapshot);
					}
					return {
						getSnapshot: () => snapshot,
						subscribe: () => () => {},
						set: () => snapshot
					};
				} });
			} catch {}
		}
		function deriveState(s) {
			if (!s) return "loading";
			if (!s.configured) return "setup";
			switch (s.connState) {
				case "connected": return "running";
				case "connecting":
				case "reconnecting": return "connecting";
				case "degraded":
				case "quarantined": return "error";
				default: return "ready";
			}
		}
		const STATE_VIEW = {
			setup: {
				emoji: "⚙️",
				label: "未配置",
				color: "#ffb454",
				bg: "rgba(255,180,84,.12)",
				hint: "手机飞书扫码，或在输入框运行 /lark setup"
			},
			ready: {
				emoji: "✅",
				label: "已配置 · 待启动",
				color: "#7fd1ff",
				bg: "rgba(127,209,255,.12)",
				hint: "开启桥接后，即可从飞书与助手对话。"
			},
			connecting: {
				emoji: "🟡",
				label: "连接中…",
				color: "#ffd66b",
				bg: "rgba(255,214,107,.12)",
				hint: "正在建立飞书长连接"
			},
			running: {
				emoji: "🟢",
				label: "运行中",
				color: "#7ee2a8",
				bg: "rgba(126,226,168,.12)",
				hint: "连接正常，飞书消息会进入当前桥接。"
			},
			error: {
				emoji: "🔴",
				label: "连接异常",
				color: "var(--dsw-alias-label-primary, #1f2937)",
				bg: "rgba(255,138,128,.12)",
				hint: "/lark restart 重连 · /lark status 查看详情"
			}
		};
		const SETTINGS_ICON_SVG = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 16 16\"><path d=\"M8.5611 8.26287L8.59322 8.23075C8.6141 8.20988 8.63658 8.18739 8.65906 8.16652L8.70402 8.12316L8.8373 7.99148L9.02037 7.81324L9.17613 7.65908L9.32226 7.51456L9.47481 7.36361L9.61452 7.22551L9.81043 7.03281C9.84737 6.99588 9.8859 6.96055 9.92444 6.92522C9.9951 6.86099 10.069 6.79836 10.1428 6.73734C10.2119 6.68274 10.2825 6.62975 10.3548 6.57836C10.456 6.5061 10.5603 6.44026 10.6663 6.37603C10.7707 6.31501 10.8783 6.2572 10.9875 6.2026C11.0903 6.15282 11.1963 6.10625 11.3038 6.0645C11.3633 6.04041 11.4243 6.01954 11.4853 5.99866C11.5158 5.98903 11.5463 5.97779 11.5784 5.96815C11.3071 4.90028 10.8109 3.90468 10.122 3.04556C9.98868 2.88016 9.78634 2.78381 9.57438 2.78381H3.94598C3.88817 2.78381 3.84 2.83038 3.84 2.8898C3.84 2.92352 3.85605 2.95403 3.88335 2.97491C5.80391 4.38321 7.39689 6.19297 8.54826 8.27732L8.5611 8.26287Z\" fill=\"currentColor\" opacity=\".65\"/><path d=\"M6.32424 13.2168C9.23077 13.2168 11.7631 11.6126 13.0831 9.24238C13.1297 9.15887 13.1747 9.07537 13.218 8.99026C13.1522 9.11712 13.0783 9.23917 12.9964 9.35478C12.9675 9.39493 12.9386 9.43508 12.9081 9.47522C12.8696 9.525 12.831 9.57157 12.7909 9.61814C12.7588 9.65507 12.7266 9.6904 12.6929 9.72573C12.6255 9.79638 12.5548 9.86383 12.4809 9.92646C12.4392 9.96178 12.3991 9.99551 12.3557 10.0276C12.3059 10.0662 12.2545 10.1031 12.2031 10.1368C12.171 10.1593 12.1373 10.1802 12.1036 10.2011C12.0699 10.2219 12.0345 10.2428 11.9976 10.2637C11.9253 10.3038 11.8499 10.3424 11.7744 10.3761C11.7085 10.405 11.6411 10.4323 11.5737 10.458C11.4998 10.4853 11.4259 10.5094 11.3488 10.5302C11.2348 10.5624 11.1208 10.5864 11.0036 10.6041C10.9201 10.617 10.8334 10.6266 10.7483 10.633C10.6583 10.6394 10.5668 10.641 10.4753 10.641C10.3741 10.6394 10.2729 10.633 10.1702 10.6218C10.0947 10.6137 10.0192 10.6025 9.94375 10.5897C9.87791 10.5784 9.81208 10.564 9.74624 10.5479C9.71091 10.5399 9.67719 10.5302 9.64186 10.5206C9.54551 10.4949 9.44916 10.4676 9.35281 10.4403C9.30464 10.4259 9.25646 10.413 9.20989 10.3986C9.13763 10.3777 9.06698 10.3552 8.99632 10.3327C8.93851 10.3151 8.8807 10.2958 8.82289 10.2765C8.76829 10.2589 8.71209 10.2412 8.65749 10.2219L8.54508 10.1834C8.50012 10.1673 8.45355 10.1513 8.40859 10.1352L8.31224 10.0999C8.24801 10.0774 8.18378 10.0533 8.12115 10.0292C8.08421 10.0148 8.04728 10.0019 8.01035 9.98748C7.96057 9.96821 7.91239 9.94894 7.86261 9.92967C7.81123 9.90879 7.75823 9.88792 7.70685 9.86704L7.60568 9.82529L7.48043 9.7739L7.38408 9.73376L7.28452 9.6904L7.1978 9.65186L7.11912 9.61653L7.03883 9.5796L6.95693 9.54106L6.85255 9.49288L6.74336 9.4415C6.70482 9.42223 6.66628 9.40456 6.62774 9.38529L6.52978 9.33712C4.80192 8.4748 3.24267 7.31218 1.92269 5.90227C1.88254 5.86052 1.8167 5.85731 1.77335 5.89746C1.75247 5.91673 1.73962 5.94563 1.73962 5.97454L1.74284 10.9413V11.3444C1.74284 11.5788 1.85845 11.7972 2.05276 11.9273C3.31654 12.772 4.80353 13.22 6.32424 13.2168Z\" fill=\"currentColor\"/><path d=\"M14.8656 6.21539C13.8844 5.73525 12.7619 5.63248 11.7101 5.92795C11.6652 5.94079 11.6218 5.95364 11.5784 5.96649C11.5479 5.97612 11.5174 5.98576 11.4853 5.997C11.4243 6.01787 11.3633 6.04036 11.3039 6.06284C11.1963 6.10459 11.0919 6.15116 10.9875 6.20094C10.8783 6.25393 10.7707 6.31174 10.6663 6.37276C10.5588 6.43539 10.456 6.50283 10.3548 6.57509C10.2825 6.62648 10.2119 6.67947 10.1428 6.73407C10.0674 6.79509 9.99511 6.85611 9.92445 6.92195C9.88591 6.95728 9.84898 6.99261 9.81044 7.02954L9.61453 7.22224L9.47482 7.36034L9.32227 7.51129L9.17614 7.65581L9.02038 7.80997L8.83892 7.98982L8.70564 8.1215L8.66067 8.16485C8.6398 8.18573 8.61732 8.20821 8.59483 8.22909L8.56272 8.2612L8.51294 8.30777C8.49367 8.32544 8.476 8.34149 8.45673 8.35916C7.97338 8.80397 7.43383 9.18455 6.85413 9.49447L6.9585 9.54265L7.0404 9.58119L7.12069 9.61812L7.19938 9.65345L7.28609 9.69199L7.38565 9.73534L7.482 9.77549L7.60725 9.82688L7.70842 9.86863C7.75981 9.8895 7.8128 9.91038 7.86419 9.93125C7.91236 9.95052 7.96214 9.9698 8.01192 9.98907C8.04886 10.0035 8.08579 10.0164 8.12272 10.0308C8.18696 10.0549 8.25119 10.0774 8.31382 10.1015L8.41016 10.1368C8.45513 10.1529 8.50009 10.1689 8.54666 10.185L8.65907 10.2235C8.71366 10.2412 8.76826 10.2604 8.82447 10.2781C8.88228 10.2974 8.94008 10.315 8.99789 10.3343C9.06855 10.3568 9.14081 10.3777 9.21147 10.4002C9.25964 10.4146 9.30782 10.4291 9.35439 10.4419C9.45073 10.4692 9.54708 10.4965 9.64343 10.5222C9.67876 10.5318 9.71248 10.5399 9.74781 10.5495C9.81365 10.5656 9.87949 10.5784 9.94533 10.5912C10.0208 10.6041 10.0963 10.6153 10.1717 10.6234C10.2745 10.6346 10.3757 10.641 10.4769 10.6426C10.5684 10.6442 10.6599 10.641 10.7498 10.6346C10.8366 10.6282 10.9217 10.6185 11.0052 10.6057C11.1208 10.588 11.2364 10.5623 11.3504 10.5318C11.4259 10.511 11.5014 10.4869 11.5752 10.4596C11.6427 10.4355 11.7101 10.4082 11.776 10.3777C11.8514 10.344 11.9269 10.3054 11.9992 10.2653C12.0345 10.246 12.0698 10.2251 12.1052 10.2026C12.1405 10.1818 12.1726 10.1593 12.2047 10.1384C12.2561 10.1031 12.3075 10.0677 12.3573 10.0292C12.4006 9.99709 12.4424 9.96337 12.4825 9.92804C12.5548 9.86542 12.6254 9.79797 12.6929 9.72732C12.7266 9.69199 12.7587 9.65666 12.7908 9.61973C12.831 9.57316 12.8711 9.52498 12.9081 9.47681C12.9386 9.43827 12.9675 9.39812 12.9964 9.35637C13.0767 9.24075 13.1505 9.12032 13.2164 8.99506L13.2919 8.84572L13.9631 7.50807L13.9711 7.49202C14.1927 7.01348 14.4946 6.58312 14.8656 6.21539Z\" fill=\"currentColor\" opacity=\".45\"/></svg>";
		const SettingsIcon = ({ size = 20 } = {}) => h("svg", {
			width: size,
			height: size,
			"viewBox": "0 0 16 16",
			"aria-hidden": true,
			"focusable": false
		}, h("path", {
			"d": "M8.5611 8.26287L8.59322 8.23075C8.6141 8.20988 8.63658 8.18739 8.65906 8.16652L8.70402 8.12316L8.8373 7.99148L9.02037 7.81324L9.17613 7.65908L9.32226 7.51456L9.47481 7.36361L9.61452 7.22551L9.81043 7.03281C9.84737 6.99588 9.8859 6.96055 9.92444 6.92522C9.9951 6.86099 10.069 6.79836 10.1428 6.73734C10.2119 6.68274 10.2825 6.62975 10.3548 6.57836C10.456 6.5061 10.5603 6.44026 10.6663 6.37603C10.7707 6.31501 10.8783 6.2572 10.9875 6.2026C11.0903 6.15282 11.1963 6.10625 11.3038 6.0645C11.3633 6.04041 11.4243 6.01954 11.4853 5.99866C11.5158 5.98903 11.5463 5.97779 11.5784 5.96815C11.3071 4.90028 10.8109 3.90468 10.122 3.04556C9.98868 2.88016 9.78634 2.78381 9.57438 2.78381H3.94598C3.88817 2.78381 3.84 2.83038 3.84 2.8898C3.84 2.92352 3.85605 2.95403 3.88335 2.97491C5.80391 4.38321 7.39689 6.19297 8.54826 8.27732L8.5611 8.26287Z",
			"fill": "currentColor",
			"opacity": ".65"
		}), h("path", {
			"d": "M6.32424 13.2168C9.23077 13.2168 11.7631 11.6126 13.0831 9.24238C13.1297 9.15887 13.1747 9.07537 13.218 8.99026C13.1522 9.11712 13.0783 9.23917 12.9964 9.35478C12.9675 9.39493 12.9386 9.43508 12.9081 9.47522C12.8696 9.525 12.831 9.57157 12.7909 9.61814C12.7588 9.65507 12.7266 9.6904 12.6929 9.72573C12.6255 9.79638 12.5548 9.86383 12.4809 9.92646C12.4392 9.96178 12.3991 9.99551 12.3557 10.0276C12.3059 10.0662 12.2545 10.1031 12.2031 10.1368C12.171 10.1593 12.1373 10.1802 12.1036 10.2011C12.0699 10.2219 12.0345 10.2428 11.9976 10.2637C11.9253 10.3038 11.8499 10.3424 11.7744 10.3761C11.7085 10.405 11.6411 10.4323 11.5737 10.458C11.4998 10.4853 11.4259 10.5094 11.3488 10.5302C11.2348 10.5624 11.1208 10.5864 11.0036 10.6041C10.9201 10.617 10.8334 10.6266 10.7483 10.633C10.6583 10.6394 10.5668 10.641 10.4753 10.641C10.3741 10.6394 10.2729 10.633 10.1702 10.6218C10.0947 10.6137 10.0192 10.6025 9.94375 10.5897C9.87791 10.5784 9.81208 10.564 9.74624 10.5479C9.71091 10.5399 9.67719 10.5302 9.64186 10.5206C9.54551 10.4949 9.44916 10.4676 9.35281 10.4403C9.30464 10.4259 9.25646 10.413 9.20989 10.3986C9.13763 10.3777 9.06698 10.3552 8.99632 10.3327C8.93851 10.3151 8.8807 10.2958 8.82289 10.2765C8.76829 10.2589 8.71209 10.2412 8.65749 10.2219L8.54508 10.1834C8.50012 10.1673 8.45355 10.1513 8.40859 10.1352L8.31224 10.0999C8.24801 10.0774 8.18378 10.0533 8.12115 10.0292C8.08421 10.0148 8.04728 10.0019 8.01035 9.98748C7.96057 9.96821 7.91239 9.94894 7.86261 9.92967C7.81123 9.90879 7.75823 9.88792 7.70685 9.86704L7.60568 9.82529L7.48043 9.7739L7.38408 9.73376L7.28452 9.6904L7.1978 9.65186L7.11912 9.61653L7.03883 9.5796L6.95693 9.54106L6.85255 9.49288L6.74336 9.4415C6.70482 9.42223 6.66628 9.40456 6.62774 9.38529L6.52978 9.33712C4.80192 8.4748 3.24267 7.31218 1.92269 5.90227C1.88254 5.86052 1.8167 5.85731 1.77335 5.89746C1.75247 5.91673 1.73962 5.94563 1.73962 5.97454L1.74284 10.9413V11.3444C1.74284 11.5788 1.85845 11.7972 2.05276 11.9273C3.31654 12.772 4.80353 13.22 6.32424 13.2168Z",
			"fill": "currentColor"
		}), h("path", {
			"d": "M14.8656 6.21539C13.8844 5.73525 12.7619 5.63248 11.7101 5.92795C11.6652 5.94079 11.6218 5.95364 11.5784 5.96649C11.5479 5.97612 11.5174 5.98576 11.4853 5.997C11.4243 6.01787 11.3633 6.04036 11.3039 6.06284C11.1963 6.10459 11.0919 6.15116 10.9875 6.20094C10.8783 6.25393 10.7707 6.31174 10.6663 6.37276C10.5588 6.43539 10.456 6.50283 10.3548 6.57509C10.2825 6.62648 10.2119 6.67947 10.1428 6.73407C10.0674 6.79509 9.99511 6.85611 9.92445 6.92195C9.88591 6.95728 9.84898 6.99261 9.81044 7.02954L9.61453 7.22224L9.47482 7.36034L9.32227 7.51129L9.17614 7.65581L9.02038 7.80997L8.83892 7.98982L8.70564 8.1215L8.66067 8.16485C8.6398 8.18573 8.61732 8.20821 8.59483 8.22909L8.56272 8.2612L8.51294 8.30777C8.49367 8.32544 8.476 8.34149 8.45673 8.35916C7.97338 8.80397 7.43383 9.18455 6.85413 9.49447L6.9585 9.54265L7.0404 9.58119L7.12069 9.61812L7.19938 9.65345L7.28609 9.69199L7.38565 9.73534L7.482 9.77549L7.60725 9.82688L7.70842 9.86863C7.75981 9.8895 7.8128 9.91038 7.86419 9.93125C7.91236 9.95052 7.96214 9.9698 8.01192 9.98907C8.04886 10.0035 8.08579 10.0164 8.12272 10.0308C8.18696 10.0549 8.25119 10.0774 8.31382 10.1015L8.41016 10.1368C8.45513 10.1529 8.50009 10.1689 8.54666 10.185L8.65907 10.2235C8.71366 10.2412 8.76826 10.2604 8.82447 10.2781C8.88228 10.2974 8.94008 10.315 8.99789 10.3343C9.06855 10.3568 9.14081 10.3777 9.21147 10.4002C9.25964 10.4146 9.30782 10.4291 9.35439 10.4419C9.45073 10.4692 9.54708 10.4965 9.64343 10.5222C9.67876 10.5318 9.71248 10.5399 9.74781 10.5495C9.81365 10.5656 9.87949 10.5784 9.94533 10.5912C10.0208 10.6041 10.0963 10.6153 10.1717 10.6234C10.2745 10.6346 10.3757 10.641 10.4769 10.6426C10.5684 10.6442 10.6599 10.641 10.7498 10.6346C10.8366 10.6282 10.9217 10.6185 11.0052 10.6057C11.1208 10.588 11.2364 10.5623 11.3504 10.5318C11.4259 10.511 11.5014 10.4869 11.5752 10.4596C11.6427 10.4355 11.7101 10.4082 11.776 10.3777C11.8514 10.344 11.9269 10.3054 11.9992 10.2653C12.0345 10.246 12.0698 10.2251 12.1052 10.2026C12.1405 10.1818 12.1726 10.1593 12.2047 10.1384C12.2561 10.1031 12.3075 10.0677 12.3573 10.0292C12.4006 9.99709 12.4424 9.96337 12.4825 9.92804C12.5548 9.86542 12.6254 9.79797 12.6929 9.72732C12.7266 9.69199 12.7587 9.65666 12.7908 9.61973C12.831 9.57316 12.8711 9.52498 12.9081 9.47681C12.9386 9.43827 12.9675 9.39812 12.9964 9.35637C13.0767 9.24075 13.1505 9.12032 13.2164 8.99506L13.2919 8.84572L13.9631 7.50807L13.9711 7.49202C14.1927 7.01348 14.4946 6.58312 14.8656 6.21539Z",
			"fill": "currentColor",
			"opacity": ".45"
		}));
		function installSettingsNavIcon(ctx) {
			const doc = globalThis.document;
			if (!doc?.body || typeof globalThis.MutationObserver !== "function" || typeof ctx.effect !== "function") return;
			ctx.effect(() => {
				const attribute = "data-dsh-plugin-settings-icon", owner = "lark-link";
				const selector = "[data-shortcut-modal=\"settings\"] nav";
				const style = doc.createElement("style");
				const mask = "url(\"data:image/svg+xml," + encodeURIComponent(SETTINGS_ICON_SVG) + "\")";
				const own = selector + " button[" + attribute + "=\"" + owner + "\"]";
				style.textContent = own + ">svg{display:none!important}" + own + "::before{content:\"\";display:block;width:16px;height:16px;flex:none;background:currentColor;-webkit-mask:" + mask + " center/contain no-repeat;mask:" + mask + " center/contain no-repeat}";
				doc.head.appendChild(style);
				const marked = /* @__PURE__ */ new Set();
				let nav = null;
				const decorate = () => {
					for (const button of marked) if (!button.isConnected || button.textContent.trim() !== "飞书 / Lark") {
						if (button.getAttribute(attribute) === owner) button.removeAttribute(attribute);
						marked.delete(button);
					}
					for (const button of Array.from(nav?.querySelectorAll("button") || [])) {
						if (button.textContent.trim() !== "飞书 / Lark" || button.firstElementChild?.tagName.toLowerCase() !== "svg") continue;
						button.setAttribute(attribute, owner);
						marked.add(button);
					}
				};
				const rail = new MutationObserver(decorate);
				const mount = () => {
					const next = doc.querySelector(selector);
					if (next !== nav) {
						rail.disconnect();
						nav = next;
						if (nav) rail.observe(nav, {
							childList: true,
							subtree: true,
							characterData: true
						});
					}
					decorate();
				};
				const root = new MutationObserver(mount);
				root.observe(doc.body, { childList: true });
				mount();
				return () => {
					root.disconnect();
					rail.disconnect();
					style.remove();
					for (const button of marked) if (button.getAttribute(attribute) === owner) button.removeAttribute(attribute);
					marked.clear();
				};
			});
		}
		function apply(ctx) {
			installSettingsNavIcon(ctx);
			installLegacySettingsScope(ctx);
			const LarkLinkSection = () => {
				const [st, setSt] = useState(void 0);
				const [qrTs, setQrTs] = useState(0);
				const [qrLoaded, setQrLoaded] = useState(false);
				const [manualOpen, setManualOpen] = useState(false);
				const [appId, setAppId] = useState("");
				const [appSecret, setAppSecret] = useState("");
				const [domain, setDomain] = useState("feishu");
				const [manualSaving, setManualSaving] = useState(false);
				const [manualError, setManualError] = useState("");
				const [manualNotice, setManualNotice] = useState("");
				const [users, setUsers] = useState([]);
				const [instanceHost, setInstanceHost] = useState("");
				const [controlBusy, setControlBusy] = useState("");
				const [policyOpen, setPolicyOpen] = useState(false);
				const [policySaving, setPolicySaving] = useState(false);
				const [policyDraft, setPolicyDraft] = useState(void 0);
				const [effectiveDefaultModel, setEffectiveDefaultModel] = useState("");
				const [modelCatalog, setModelCatalog] = useState([]);
				useEffect(() => {
					const origin = win.location?.origin ?? "";
					const fetchStatus = () => {
						win.fetch?.(`${origin}/plugins/lark-link/status`).then((r) => r.ok ? r.json() : Promise.reject(/* @__PURE__ */ new Error("status"))).then((j) => setSt(j)).catch(() => setSt((prev) => prev));
						win.fetch?.(`${origin}/plugins/lark-link/management`).then((r) => r.ok ? r.json() : Promise.reject(/* @__PURE__ */ new Error("management"))).then((value) => {
							const management = value;
							if (management.status) setSt((previous) => ({
								...previous,
								...management.status
							}));
							setInstanceHost(String(management.instance?.host ?? ""));
							setUsers(Array.isArray(management.users) ? management.users : []);
							setModelCatalog(Array.isArray(management.modelCatalog) ? management.modelCatalog : []);
							if (management.policy) {
								setEffectiveDefaultModel(management.policy.effectiveDefaultModel ?? "");
								setPolicyDraft((previous) => previous?.dirty ? previous : {
									restricted: management.policy?.modelAccess?.restricted === true,
									allowedModels: management.policy?.modelAccess?.allowedModels ?? [],
									defaultModel: management.policy?.modelAccess?.defaultModel ?? "",
									workspaceRoot: management.policy?.workspaceRoot ?? "",
									dirty: false
								});
							}
						}).catch(() => void 0);
					};
					fetchStatus();
					const stId = setInterval(fetchStatus, 3e3);
					const qrId = setInterval(() => setQrTs(Date.now()), 4e3);
					setQrTs(Date.now());
					return () => {
						clearInterval(stId);
						clearInterval(qrId);
					};
				}, []);
				const state = deriveState(st);
				const origin = win.location?.origin ?? "";
				const showQr = state === "setup";
				const valueOf = (event) => String(event?.target?.value ?? "");
				const saveManualCredentials = () => {
					if (manualSaving) return;
					if (!appId.trim() || !appSecret.trim()) {
						setManualError("请填写 App ID 和 App Secret");
						return;
					}
					setManualSaving(true);
					setManualError("");
					setManualNotice("");
					win.fetch?.(`${origin}/plugins/lark-link/credentials`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							appId: appId.trim(),
							appSecret,
							domain
						})
					}).then(async (response) => {
						const value = await response.json();
						if (!response.ok || !value.ok) throw new Error(value.error || `保存失败（HTTP ${response.status}）`);
						setAppSecret("");
						setManualOpen(false);
						setUsers((previous) => value.appSwitched ? [] : previous);
						setManualNotice(value.appSwitched ? "已切换机器人并清空旧机器人的路由、补发队列和会话映射。" : "凭据已保存，桥接已重新连接。");
						setSt((previous) => ({
							...previous,
							configured: true,
							appIdMasked: value.appIdMasked,
							domain: value.domain,
							connState: value.connState ?? "connected"
						}));
					}).catch((error) => setManualError(error instanceof Error ? error.message : "手动配置失败")).finally(() => setManualSaving(false));
				};
				const runControl = (action) => {
					if (controlBusy) return;
					setControlBusy(action);
					setManualNotice("");
					setManualError("");
					win.fetch?.(`${origin}/plugins/lark-link/control`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ action })
					}).then(async (response) => {
						const value = await response.json();
						if (!response.ok || !value.ok) throw new Error(value.error || `操作失败（HTTP ${response.status}）`);
						setSt((previous) => ({
							...previous,
							connState: value.connState
						}));
						setManualNotice(action === "stop" ? "桥接已停止。" : action === "restart" ? "桥接已重新连接。" : "桥接已启动。");
					}).catch((error) => setManualError(error instanceof Error ? error.message : "管理操作失败")).finally(() => setControlBusy(""));
				};
				const savePolicy = () => {
					if (policySaving || !policyDraft) return;
					if (policyDraft.restricted && policyDraft.allowedModels.length === 0) {
						setManualError("启用模型白名单时至少保留一个模型");
						return;
					}
					setPolicySaving(true);
					setManualError("");
					setManualNotice("");
					win.fetch?.(`${origin}/plugins/lark-link/policy`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							modelAccess: {
								restricted: policyDraft.restricted,
								allowedModels: policyDraft.allowedModels,
								defaultModel: policyDraft.defaultModel
							},
							workspaceRoot: policyDraft.workspaceRoot
						})
					}).then(async (response) => {
						const value = await response.json();
						if (!response.ok || !value.ok) throw new Error(value.error || `保存失败（HTTP ${response.status}）`);
						setPolicyDraft({
							restricted: value.modelAccess?.restricted === true,
							allowedModels: value.modelAccess?.allowedModels ?? [],
							defaultModel: value.modelAccess?.defaultModel ?? "",
							workspaceRoot: value.workspaceRoot ?? "",
							dirty: false
						});
						setManualNotice("模型访问策略和默认工作区已保存。下一轮请求生效。");
					}).catch((error) => setManualError(error instanceof Error ? error.message : "策略保存失败")).finally(() => setPolicySaving(false));
				};
				const view = state === "loading" ? {
					emoji: "…",
					label: "读取状态",
					color: "var(--dsw-alias-label-primary, #1f2937)",
					bg: "rgba(255,255,255,.05)",
					hint: ""
				} : STATE_VIEW[state];
				const extras = [];
				if (st?.outboxPending && st.outboxPending > 0) extras.push(`待发 ${st.outboxPending}`);
				if (st?.outboxFailed && st.outboxFailed > 0) extras.push(`失败 ${st.outboxFailed}`);
				if (st?.inboundFailed && st.inboundFailed > 0) extras.push(`补发失败 ${st.inboundFailed}`);
				const banner = h("span", {
					className: "dshp-status",
					"data-ok": state === "running",
					"data-warn": state === "connecting" || state === "error"
				}, h("span", { className: "dshp-dot" }), view.label);
				const credentialSummary = st?.appIdMasked ? h("div", { style: {
					marginBottom: "10px",
					opacity: .75,
					fontSize: "12px"
				} }, `当前：${st.appIdMasked} · ${st.domain === "lark" ? "Lark" : "飞书"}${instanceHost ? ` · 主机 ${instanceHost}` : ""}`) : null;
				const fieldStyle = {
					boxSizing: "border-box",
					width: "100%",
					padding: "7px 8px",
					border: "1px solid var(--dsw-alias-border-l3, #e4e7ec)",
					borderRadius: "7px",
					background: "var(--dsw-alias-bg-layer-2, #fff)",
					color: "var(--dsw-alias-label-primary, #1f2937)",
					font: "inherit"
				};
				const manualToggle = h("button", {
					type: "button",
					className: "dshp-disclosure",
					"aria-expanded": manualOpen,
					onClick: () => {
						setManualOpen((v) => !v);
						setManualError("");
					}
				}, h("span", null, "机器人凭据"), h("span", null, manualOpen ? "⌄" : "›"));
				const manualForm = manualOpen ? h("div", { style: {
					display: "grid",
					gap: "8px",
					padding: "10px",
					marginBottom: "10px",
					border: "1px solid rgba(255,255,255,.12)",
					borderRadius: "8px",
					background: "var(--dsw-alias-bg-layer-1, #ffffff)"
				} }, h("label", { htmlFor: "lark-app-id" }, "App ID"), h("input", {
					type: "text",
					id: "lark-app-id",
					value: appId,
					autoComplete: "off",
					spellCheck: false,
					placeholder: "cli_xxxxxxxxxxxxxxxx",
					onChange: (event) => setAppId(valueOf(event)),
					style: fieldStyle
				}), h("label", { htmlFor: "lark-app-secret" }, "App Secret"), h("input", {
					type: "password",
					id: "lark-app-secret",
					value: appSecret,
					autoComplete: "new-password",
					spellCheck: false,
					placeholder: "不会回显或写入普通配置",
					onChange: (event) => setAppSecret(valueOf(event)),
					style: fieldStyle
				}), h("label", { htmlFor: "lark-domain" }, "服务区域"), h("select", {
					id: "lark-domain",
					value: domain,
					onChange: (event) => setDomain(valueOf(event) === "lark" ? "lark" : "feishu"),
					style: fieldStyle
				}, h("option", { value: "feishu" }, "飞书（中国大陆）"), h("option", { value: "lark" }, "Lark（国际版）")), manualError ? h("div", { style: {
					color: "var(--dsw-alias-label-primary, #1f2937)",
					whiteSpace: "pre-wrap"
				} }, manualError) : null, h("button", {
					type: "button",
					disabled: manualSaving,
					onClick: saveManualCredentials,
					style: {
						padding: "8px 10px",
						border: "none",
						borderRadius: "7px",
						background: "#3d64df",
						color: "white",
						cursor: manualSaving ? "default" : "pointer",
						opacity: manualSaving ? .65 : 1,
						font: "inherit"
					}
				}, manualSaving ? "保存并重连中…" : "保存并重连")) : null;
				const notice = manualNotice ? h("div", { style: {
					marginBottom: "10px",
					padding: "8px",
					borderRadius: "7px",
					background: "rgba(126,226,168,.1)",
					color: "var(--dsw-alias-label-primary, #1f2937)"
				} }, manualNotice) : null;
				const flatModels = modelCatalog.flatMap((group) => group.models.map((model) => ({
					ref: `${group.provider}/${model.id}`,
					label: `${group.label || group.provider} · ${model.name || model.id}`
				})));
				const policyToggle = h("button", {
					type: "button",
					className: "dshp-disclosure",
					"aria-expanded": policyOpen,
					onClick: () => {
						setPolicyOpen((v) => !v);
						setManualError("");
					}
				}, h("span", null, "模型与工作区"), h("span", null, policyOpen ? "⌄" : "›"));
				const selectableDefaults = flatModels.filter((model) => !policyDraft?.restricted || policyDraft.allowedModels.includes(model.ref));
				const policyForm = policyOpen && policyDraft ? h("div", { style: {
					display: "grid",
					gap: "8px",
					padding: "10px",
					marginBottom: "10px",
					border: "1px solid rgba(255,255,255,.12)",
					borderRadius: "8px",
					background: "var(--dsw-alias-bg-layer-1, #ffffff)"
				} }, h("label", { style: {
					display: "flex",
					gap: "7px",
					alignItems: "center"
				} }, h("input", {
					type: "checkbox",
					checked: policyDraft.restricted,
					onChange: (event) => {
						const restricted = Boolean(event.target?.checked);
						setPolicyDraft((previous) => {
							if (!previous) return previous;
							const allowedModels = restricted && previous.allowedModels.length === 0 ? flatModels.map((model) => model.ref) : previous.allowedModels;
							const defaultModel = restricted && !allowedModels.includes(previous.defaultModel) ? allowedModels[0] ?? "" : previous.defaultModel;
							return {
								...previous,
								restricted,
								allowedModels,
								defaultModel,
								dirty: true
							};
						});
					}
				}), "启用模型白名单"), h("div", { style: {
					opacity: .65,
					fontSize: "12px"
				} }, "启用后，未勾选模型不会出现在 /model 中，直接指定也会被拒绝。"), policyDraft.restricted ? h("div", { style: {
					maxHeight: "170px",
					overflowY: "auto",
					padding: "4px 6px",
					border: "1px solid var(--dsw-alias-border-l3, #c8cdd8)",
					borderRadius: "6px"
				} }, ...flatModels.map((model) => h("label", {
					key: model.ref,
					style: {
						display: "flex",
						gap: "6px",
						alignItems: "flex-start",
						padding: "4px 0"
					}
				}, h("input", {
					type: "checkbox",
					checked: policyDraft.allowedModels.includes(model.ref),
					onChange: (event) => {
						const checked = Boolean(event.target?.checked);
						setPolicyDraft((previous) => {
							if (!previous) return previous;
							const allowedModels = checked ? Array.from(/* @__PURE__ */ new Set([...previous.allowedModels, model.ref])) : previous.allowedModels.filter((value) => value !== model.ref);
							return {
								...previous,
								allowedModels,
								defaultModel: previous.defaultModel === model.ref && !checked ? allowedModels[0] ?? "" : previous.defaultModel,
								dirty: true
							};
						});
					}
				}), h("span", { style: { overflowWrap: "anywhere" } }, model.label)))) : null, h("label", { htmlFor: "lark-default-model" }, "默认模型"), h("select", {
					id: "lark-default-model",
					value: policyDraft.defaultModel,
					onChange: (event) => setPolicyDraft((previous) => previous ? {
						...previous,
						defaultModel: valueOf(event),
						dirty: true
					} : previous),
					style: fieldStyle
				}, ...!policyDraft.restricted ? [h("option", { value: "" }, `跟随 DSH 全局默认${effectiveDefaultModel ? `（${effectiveDefaultModel}）` : ""}`)] : [], ...selectableDefaults.map((model) => h("option", {
					key: model.ref,
					value: model.ref
				}, model.label))), h("label", { htmlFor: "lark-workspace" }, "默认工作区"), h("input", {
					type: "text",
					id: "lark-workspace",
					value: policyDraft.workspaceRoot,
					placeholder: "留空则使用 DSH 进程工作目录",
					onChange: (event) => setPolicyDraft((previous) => previous ? {
						...previous,
						workspaceRoot: valueOf(event),
						dirty: true
					} : previous),
					style: fieldStyle
				}), h("button", {
					type: "button",
					disabled: policySaving || !policyDraft.dirty,
					onClick: savePolicy,
					style: {
						padding: "8px 10px",
						border: "none",
						borderRadius: "7px",
						background: "#3d64df",
						color: "white",
						cursor: policySaving || !policyDraft.dirty ? "default" : "pointer",
						opacity: policySaving || !policyDraft.dirty ? .55 : 1,
						font: "inherit"
					}
				}, policySaving ? "保存中…" : "保存访问策略")) : null;
				const userRows = users.slice(0, 20).map((user) => h("details", {
					className: "dshp-user",
					key: user.sessionKey
				}, h("summary", null, h("span", { className: "dshp-label" }, user.senderName || user.senderOpenId), h("div", { className: "dshp-help" }, `${user.chatType === "p2p" ? "私聊" : "群聊"} · ${user.inboundMessages} 条消息`)), h("div", { className: "dshp-user-meta" }, `聊天：${user.chatId}`), user.activeSessionId ? h("div", { className: "dshp-user-meta" }, `会话：${user.activeSessionId}`) : null, h("div", { className: "dshp-user-meta" }, `最近活跃：${new Date(user.lastSeenAt).toLocaleString()}`)));
				const userPanel = h("section", { className: "dshp-section" }, h("h3", { className: "dshp-heading" }, `用户与对话 · ${users.length}`), h("div", { className: "dshp-panel" }, ...userRows.length ? userRows : [h("div", { className: "dshp-empty" }, "还没有收到消息。连接后，在飞书中给机器人发送消息即可。")]));
				const qrImg = showQr ? h("img", {
					src: `${origin}/plugins/lark-link/qr?t=${qrTs}`,
					alt: "Lark Link setup QR",
					onError: () => setQrLoaded(false),
					onLoad: () => setQrLoaded(true),
					style: {
						width: "220px",
						height: "220px",
						display: qrLoaded ? "block" : "none",
						margin: "0 auto 10px"
					}
				}) : null;
				const qrHint = showQr && !qrLoaded ? h("div", { style: {
					textAlign: "center",
					opacity: .6,
					padding: "8px 0 12px",
					fontSize: "12px"
				} }, "二维码生成中…（若无，确认已在输入框运行 /lark setup）") : null;
				return h("section", { className: "dshp-page" }, h("style", null, "\n.dshp-page{--sp-text:var(--dsw-alias-label-primary,#20242c);--sp-muted:var(--dsw-alias-label-secondary,#69717f);--sp-border:var(--dsw-alias-border-l3,#e4e7ec);--sp-bg:var(--dsw-alias-bg-layer-2,#fff);--sp-soft:var(--dsw-alias-bg-layer-3,#f7f8fa);--sp-accent:#3d64df;color:var(--sp-text);width:100%;max-width:680px;padding:4px 0 24px;font-family:inherit;font-size:14px;line-height:1.5}\n.dshp-page *{box-sizing:border-box}.dshp-header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px}.dshp-title{display:flex;align-items:center;gap:10px;min-width:0}.dshp-symbol{display:grid;place-items:center;flex:none;width:36px;height:36px;border:1px solid var(--sp-border);border-radius:10px;background:var(--sp-soft);font-size:20px}.dshp-page h2{font-size:18px;font-weight:600;line-height:1.5;letter-spacing:normal;margin:0}.dshp-subtitle{color:var(--sp-muted);font-size:13px;margin:4px 0 0}.dshp-status{display:inline-flex;align-items:center;gap:7px;color:var(--sp-muted);font-size:12px;white-space:nowrap;border:1px solid var(--sp-border);border-radius:20px;padding:4px 8px}.dshp-dot{width:6px;height:6px;flex:none;border-radius:50%;background:#969eab}.dshp-status[data-ok=true] .dshp-dot{background:#21936a}.dshp-status[data-warn=true] .dshp-dot{background:#c58c2e}\n.dshp-section{margin-top:18px}.dshp-heading{color:var(--sp-muted);font-weight:600;font-size:13px;margin:0 0 8px}.dshp-panel{background:var(--sp-bg);border:1px solid var(--sp-border);border-radius:10px;overflow:hidden}.dshp-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px}.dshp-row+.dshp-row{border-top:1px solid var(--sp-border)}.dshp-label{font-weight:550;font-size:14px;margin:0}.dshp-help{font-size:12px;color:var(--sp-muted);line-height:1.55;margin:3px 0 0}.dshp-page button,.dshp-page input,.dshp-page select{font:inherit}.dshp-page button{cursor:pointer}.dshp-page button:disabled{cursor:default;opacity:.45}.dshp-page button:focus-visible,.dshp-page input:focus-visible,.dshp-page select:focus-visible{outline:3px solid #8ba9ff;outline-offset:3px}.dshp-switch{position:relative;flex:none;width:40px;height:24px;border:0;border-radius:20px;padding:3px;background:#a0a7b2}.dshp-switch[aria-checked=true]{background:var(--sp-accent)}.dshp-knob{display:block;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px #0002;transform:translateX(0);transition:transform .15s}.dshp-switch[aria-checked=true] .dshp-knob{transform:translateX(16px)}\n.dshp-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap;border:1px solid var(--sp-border);background:var(--sp-bg);color:var(--sp-text);border-radius:7px;padding:6px 10px;font-size:12px!important}.dshp-button:hover{background:var(--sp-soft)}.dshp-primary{background:var(--sp-accent)!important;border-color:var(--sp-accent)!important;color:white!important}.dshp-danger{color:var(--dsw-alias-label-error,#c73f38)}.dshp-footnote{color:var(--sp-muted);font-size:12px;line-height:1.55;margin:8px 2px 0}.dshp-error{color:var(--dsw-alias-label-error,#c73f38);background:var(--sp-soft);border:1px solid var(--sp-border);padding:12px 14px;border-radius:8px;font-size:12px;margin-top:14px}.dshp-footer{font-size:11px;color:var(--sp-muted);margin-top:14px}.dshp-empty{font-size:12px;color:var(--sp-muted);padding:14px 16px}.dshp-option{width:100%;display:flex;align-items:center;gap:10px;text-align:left;padding:10px 12px;border:1px solid transparent;background:transparent;color:var(--sp-text);border-radius:8px}.dshp-option[aria-checked=true]{background:var(--sp-soft);border-color:var(--sp-border)}.dshp-option-copy{flex:1}.dshp-radio{width:16px;height:16px;border:1.5px solid #9ca5b3;border-radius:50%;display:grid;place-items:center;flex:none}.dshp-option[aria-checked=true] .dshp-radio{border-color:var(--sp-accent)}.dshp-option[aria-checked=true] .dshp-radio:after{content:'';width:8px;height:8px;border-radius:50%;background:var(--sp-accent)}.dshp-options{padding:6px}.dshp-actions{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.dshp-tags{display:flex;gap:7px;flex-wrap:wrap}.dshp-tag{font-size:12px;color:var(--sp-muted);background:var(--sp-soft);border:1px solid var(--sp-border);padding:3px 8px;border-radius:6px}.dshp-form{padding:14px 16px;border-top:1px solid var(--sp-border);display:grid;gap:10px}.dshp-page input:not([type=checkbox]),.dshp-page select{min-height:32px;border:1px solid var(--sp-border)!important;border-radius:7px!important;background:var(--sp-bg)!important;color:var(--sp-text)!important;padding:6px 9px!important;font:inherit!important}.dshp-page input[type=checkbox]{accent-color:var(--sp-accent);width:15px;height:15px;flex:none}.dshp-disclosure{width:100%;display:flex;align-items:center;justify-content:space-between;gap:12px;text-align:left;background:transparent;border:0;color:var(--sp-text);padding:12px 16px;font-size:14px;font-weight:550}.dshp-disclosure span:last-child{color:var(--sp-muted)}.dshp-user{padding:10px 16px}.dshp-user+.dshp-user{border-top:1px solid var(--sp-border)}.dshp-user summary{cursor:pointer;list-style:none}.dshp-user summary::-webkit-details-marker{display:none}.dshp-user summary:after{content:'›';float:right;color:var(--sp-muted)}.dshp-user[open] summary:after{content:'⌄'}.dshp-user-meta{color:var(--sp-muted);font-size:12px;overflow-wrap:anywhere;margin-top:6px}\n@media(max-width:520px){.dshp-page h2{font-size:18px}.dshp-header{align-items:flex-start;gap:12px;margin-bottom:18px}.dshp-subtitle{max-width:220px;margin:4px 0 0}.dshp-symbol{width:36px;height:36px;border-radius:10px}.dshp-row,.dshp-form,.dshp-disclosure{padding:12px}.dshp-row{gap:12px;padding:12px 16px}.dshp-status{font-size:11px;padding:4px 8px}}\n@media(prefers-reduced-motion:reduce){.dshp-knob{transition:none}}\n\n          .dshp-lark-form{padding:0 16px 14px}.dshp-lark-form>div{border:0!important;background:transparent!important;padding:0!important;margin:0!important;gap:10px!important}.dshp-lark-form>div>button{border-radius:7px!important;padding:6px 10px!important}.dshp-lark-form label{font-size:13px}.dshp-lark-form [style*=\"max-height\"]{max-height:240px!important;border:1px solid var(--sp-border)!important;padding:10px!important}.dshp-lark-notice{padding:10px 16px}.dshp-qr{padding:16px;text-align:center}.dshp-qr img{border:1px solid var(--sp-border);border-radius:10px;padding:10px;background:white}.dshp-qr p{margin:0;font-size:12px;color:var(--sp-muted)}\n        "), h("header", { className: "dshp-header" }, h("div", { className: "dshp-title" }, h("span", { className: "dshp-symbol" }, h(SettingsIcon)), h("div", null, h("h2", null, "飞书 / Lark"), h("p", { className: "dshp-subtitle" }, "把桌面助手连接到飞书对话。"))), banner), h("div", { className: "dshp-panel" }, h("div", { className: "dshp-row" }, h("div", null, h("p", { className: "dshp-label" }, "启用飞书桥接"), h("p", { className: "dshp-help" }, st?.configured ? "将收到的消息交给 DSH，并同步回复。" : "先扫码或填写机器人凭据，再开启桥接。")), h("div", { className: "dshp-actions" }, st?.configured ? h("button", {
					type: "button",
					className: "dshp-button",
					disabled: !!controlBusy,
					onClick: () => runControl("restart")
				}, controlBusy === "restart" ? "重连中…" : "重新连接") : null, h("button", {
					type: "button",
					className: "dshp-switch",
					role: "switch",
					"aria-label": "启用飞书桥接",
					"aria-checked": state === "running" || state === "connecting",
					disabled: !st?.configured || !!controlBusy,
					onClick: () => runControl(state === "running" || state === "connecting" ? "stop" : state === "error" ? "restart" : "start")
				}, h("span", { className: "dshp-knob" })))), credentialSummary ? h("div", { style: { padding: "0 16px 10px" } }, credentialSummary) : null, extras.length ? h("div", { className: "dshp-row" }, h("p", { className: "dshp-label" }, "消息投递"), h("span", { className: "dshp-help" }, extras.join(" · "))) : null), showQr ? h("section", { className: "dshp-section" }, h("h3", { className: "dshp-heading" }, "扫码配置"), h("div", { className: "dshp-panel dshp-qr" }, qrImg, qrHint, h("p", null, "使用手机飞书扫码，完成机器人配置。"))) : null, notice ? h("div", {
					className: "dshp-lark-notice",
					role: "status"
				}, notice) : null, h("section", { className: "dshp-section" }, h("h3", { className: "dshp-heading" }, "连接与账号"), h("div", { className: "dshp-panel" }, manualToggle, manualForm ? h("div", { className: "dshp-lark-form" }, manualForm) : null)), h("section", { className: "dshp-section" }, h("h3", { className: "dshp-heading" }, "对话偏好"), h("div", { className: "dshp-panel" }, policyToggle, policyForm ? h("div", { className: "dshp-lark-form" }, policyForm) : null)), userPanel, manualError ? h("div", {
					className: "dshp-error",
					role: "alert"
				}, manualError) : null, h("div", { className: "dshp-footer" }, "凭据和对话偏好在确认保存后生效。"));
			};
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "lark-link",
				order: 45,
				label: "飞书 / Lark"
			}, LarkLinkSection));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
