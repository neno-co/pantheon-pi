import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const extensionSource = readFileSync(new URL("../src/extension/index.ts", import.meta.url), "utf8");

describe("ACPX monitor extension UI wiring", () => {
	test("binds the Agent Explorer to both slash command and Ctrl-0 shortcut", () => {
		expect(extensionSource).toContain('pi.registerCommand("acpx-monitor"');
		expect(extensionSource).toContain('pi.registerShortcut("ctrl+0"');
		expect(extensionSource).toContain("openPantheonAgentExplorer(ctx)");
	});

	test("requests a wide, tall overlay so Explorer uses available terminal space", () => {
		expect(extensionSource).toContain('width: "95%"');
		expect(extensionSource).toContain('maxHeight: "90%"');
		expect(extensionSource).toContain("minWidth: 80");
	});
});
