// Per-project advisory lock. Different projects live in different directories
// and never share state, so they run concurrently with no coordination. The one
// real hazard is two loops driving the SAME project at once (e.g. two `train
// start --project foo`), which would interleave reads/writes of one state.json
// and corrupt it. This lock makes that fail fast and loud instead.
//
// The lock is a file created with the exclusive `wx` flag — atomic on POSIX, so
// only one process can hold it. It records the owning pid + a timestamp, and a
// lock whose pid is no longer alive is treated as stale and reclaimed (covers a
// crashed loop that never released).

import { readFileSync, unlinkSync, writeFileSync } from "node:fs";

type LockInfo = { pid: number; since: string; command: string };

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// ESRCH = no such process; EPERM = exists but not ours (still alive).
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export class LockHeld extends Error {
	constructor(public readonly info: LockInfo) {
		super(
			`Project is already locked by pid ${info.pid} (${info.command}, since ${info.since}). ` +
				"Another train loop is running on this project. Wait for it, or if you are sure it is dead run `train unlock`.",
		);
		this.name = "LockHeld";
	}
}

// Acquire the lock, returning a release function. Throws LockHeld if a live
// process already holds it; reclaims a stale lock left by a dead process.
export function acquireLock(lockPath: string, command: string): () => void {
	const payload = JSON.stringify({ pid: process.pid, since: new Date().toISOString(), command } satisfies LockInfo);
	try {
		writeFileSync(lockPath, payload, { flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const existing = readLock(lockPath);
		if (existing && isAlive(existing.pid)) throw new LockHeld(existing);
		// Stale: the recorded owner is gone. Reclaim it.
		writeFileSync(lockPath, payload);
	}

	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		try {
			unlinkSync(lockPath);
		} catch {
			// Already gone — nothing to release.
		}
	};
	return release;
}

export function readLock(lockPath: string): LockInfo | null {
	try {
		return JSON.parse(readFileSync(lockPath, "utf8")) as LockInfo;
	} catch {
		return null;
	}
}

export function forceUnlock(lockPath: string): boolean {
	try {
		unlinkSync(lockPath);
		return true;
	} catch {
		return false;
	}
}
