import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireLock, forceUnlock, LockHeld, readLock } from "../src/lock.ts";

function tmpLock(): string {
	return path.join(mkdtempSync(path.join(os.tmpdir(), "train-lock-")), ".lock");
}

describe("per-project lock", () => {
	test("acquire writes owner info and release removes it", () => {
		const lockPath = tmpLock();
		const release = acquireLock(lockPath, "start");
		const info = readLock(lockPath);
		expect(info?.pid).toBe(process.pid);
		expect(info?.command).toBe("start");
		release();
		expect(readLock(lockPath)).toBeNull();
	});

	test("a second acquire by a live owner throws LockHeld", () => {
		const lockPath = tmpLock();
		const release = acquireLock(lockPath, "start");
		expect(() => acquireLock(lockPath, "run-stage")).toThrow(LockHeld);
		release();
	});

	test("a stale lock from a dead pid is reclaimed", () => {
		const lockPath = tmpLock();
		// pid 2^31-1 is effectively guaranteed not to exist.
		writeFileSync(lockPath, JSON.stringify({ pid: 2147483646, since: "2020-01-01T00:00:00.000Z", command: "start" }));
		const release = acquireLock(lockPath, "start");
		expect(readLock(lockPath)?.pid).toBe(process.pid);
		release();
	});

	test("forceUnlock removes a held lock", () => {
		const lockPath = tmpLock();
		acquireLock(lockPath, "start");
		expect(forceUnlock(lockPath)).toBe(true);
		expect(readLock(lockPath)).toBeNull();
	});

	test("release is idempotent", () => {
		const lockPath = tmpLock();
		const release = acquireLock(lockPath, "start");
		release();
		expect(() => release()).not.toThrow();
	});
});
