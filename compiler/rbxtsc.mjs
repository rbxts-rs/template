#!/usr/bin/env node
// rbxtsc.mjs: runs this project's compiler, `bin/<target triple>/<bin>[.exe]` next to this file, with the given
// arguments (`node compiler/rbxtsc.mjs build`, as `rbxtsc build`). Node 18 or newer, no npm dependencies.
//
// The binary is not committed. A stamp beside it (`bin/<triple>/.stamp`) holds the config hash it was made from: a
// SHA-256 over Cargo.toml, Cargo.lock, rust-toolchain.toml, .cargo/config.toml and src/**, CRLF read as LF. When the
// stamp does not match the current config:
//   - if the config still hashes to preset.json's `config` and the preset has a binary for this platform, it is
//     downloaded (sha256-checked) and unzipped;
//   - otherwise the binary has to be built with Rust: the launcher says why, then asks (on a terminal), or prints the
//     command and exits 1 (CI). `--build` or RBXTSC_BUILD=1 builds without asking.
//
// Launcher flags (everything else goes to the binary unchanged):
//   --where     print the binary's path and the state of its stamp, then exit
//   --build     build the binary with Rust if it is missing or stale, without asking
//   --rebuild   build the binary with Rust even if it is up to date
//   --          the arguments after it all go to the binary (the -- itself does not), launcher flags included
// A build uses a temporary target folder in the OS temp folder, deleted afterwards (after Ctrl+C too); the next
// build deletes those that killed builds left.
// Environment: RBXTSC_BUILD=1 (as --build); RBXTSC_INTERACTIVE=1 or 0 (ask, reading the answer from stdin, or never
// ask, whatever the terminal is).
//
// README.md (next to this file) covers running, building, plugins and versions.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NAME = "rbxtsc.mjs";
// A clean build of this package with its release profile, measured on a desktop PC (README.md, "Building").
const BUILD_MINUTES = 3;
const LAUNCHER_FLAGS = new Set(["--where", "--build", "--rebuild"]);
// Files the system's file browser leaves in folders (macOS Finder, Windows Explorer): not part of the config.
const IGNORED_FILES = new Set([".DS_Store", "Thumbs.db"]);
// The most bytes an archive entry may unzip to (a binary is some tens of MB).
const MAX_ENTRY_SIZE = 512 * 1024 * 1024;

/** Rust's target triple for this platform, as the preset's `binaries` keys and the `bin/` folders name it. */
export function hostTriple(platform = process.platform, arch = process.arch) {
	const cpu = { x64: "x86_64", arm64: "aarch64" }[arch];
	if (!cpu) return `${arch}-${platform}`;
	if (platform === "win32") return `${cpu}-pc-windows-msvc`;
	if (platform === "darwin") return `${cpu}-apple-darwin`;
	if (platform === "linux") {
		const glibc = process.report?.getReport?.().header?.glibcVersionRuntime;
		return `${cpu}-unknown-linux-${glibc === undefined ? "musl" : "gnu"}`;
	}
	return `${cpu}-${platform}`;
}

/**
 * The config files the hash covers, those that decide what a build makes: paths relative to `dir`, with `/`, sorted by
 * code unit.
 */
export function configFiles(dir) {
	const files = ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", ".cargo/config.toml"].filter((f) => isFile(path.join(dir, f)));
	const walk = (rel) => {
		for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
			const child = `${rel}/${entry.name}`;
			if (entry.isDirectory()) walk(child);
			else if (entry.isFile() && !IGNORED_FILES.has(entry.name)) files.push(child);
		}
	};
	if (fs.existsSync(path.join(dir, "src"))) walk("src");
	return files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The config hash: SHA-256 over each config file's path, its length and its bytes, with CRLF read as LF so a checkout
 * with git's autocrlf hashes as one without. The same for the same checkout on every platform.
 */
export function configHash(dir = HERE) {
	const hash = createHash("sha256");
	for (const file of configFiles(dir)) {
		const bytes = withoutCr(fs.readFileSync(path.join(dir, file)));
		hash.update(`${file}\0${bytes.length}\0`);
		hash.update(bytes);
	}
	return hash.digest("hex");
}

function withoutCr(bytes) {
	if (!bytes.includes(0x0d)) return bytes;
	const out = Buffer.alloc(bytes.length);
	let n = 0;
	for (let i = 0; i < bytes.length; i++) if (!(bytes[i] === 0x0d && bytes[i + 1] === 0x0a)) out[n++] = bytes[i];
	return out.subarray(0, n);
}

/** The entries of a zip archive (no zip64): name, compression method, sizes and where the data starts. */
export function zipEntries(zip) {
	let eocd = -1;
	for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
		if (zip.readUInt32LE(i) === 0x06054b50) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new Error("not a zip archive (no end of central directory)");
	const count = zip.readUInt16LE(eocd + 10);
	let at = zip.readUInt32LE(eocd + 16);
	if (count === 0xffff || at === 0xffffffff) throw new Error("zip64 archives are not supported");
	const entries = [];
	for (let i = 0; i < count; i++) {
		if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error("corrupt zip central directory");
		const method = zip.readUInt16LE(at + 10);
		const compressedSize = zip.readUInt32LE(at + 20);
		const size = zip.readUInt32LE(at + 24);
		const nameLength = zip.readUInt16LE(at + 28);
		const extraLength = zip.readUInt16LE(at + 30);
		const commentLength = zip.readUInt16LE(at + 32);
		const local = zip.readUInt32LE(at + 42);
		const name = zip.toString("utf8", at + 46, at + 46 + nameLength);
		if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error(`corrupt zip entry ${name}`);
		const data = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
		entries.push({ name, method, compressedSize, size, data });
		at += 46 + nameLength + extraLength + commentLength;
	}
	return entries;
}

/** The bytes of a zip entry (stored or deflated), at most `limit` of them. */
export function zipEntryBytes(zip, entry, limit = MAX_ENTRY_SIZE) {
	if (entry.size > limit) throw new Error(`${entry.name}: ${entry.size} bytes unzipped, more than the ${limit} allowed`);
	const raw = zip.subarray(entry.data, entry.data + entry.compressedSize);
	let bytes;
	if (entry.method === 0) {
		bytes = raw;
	} else if (entry.method === 8) {
		try {
			bytes = zlib.inflateRawSync(raw, { maxOutputLength: limit });
		} catch (e) {
			const why = e.code === "ERR_BUFFER_TOO_LARGE" ? `more than the ${limit} bytes allowed` : (e.code ?? e.message);
			throw new Error(`${entry.name}: cannot unzip it (${why})`);
		}
	} else {
		throw new Error(`${entry.name}: unsupported zip compression method ${entry.method}`);
	}
	if (bytes.length !== entry.size) throw new Error(`${entry.name}: unzipped size does not match the archive`);
	return bytes;
}

/** The one file in the archive named `exeName` (at any depth). */
export function extractExe(zip, exeName) {
	const found = zipEntries(zip).filter((e) => !e.name.endsWith("/") && e.name.split("/").pop() === exeName);
	if (found.length !== 1) throw new Error(`the archive has ${found.length} files named ${exeName}, not one`);
	return zipEntryBytes(zip, found[0]);
}

function isFile(p) {
	try {
		return fs.statSync(p).isFile();
	} catch {
		return false;
	}
}

function readText(p) {
	try {
		return fs.readFileSync(p, "utf8");
	} catch {
		return undefined;
	}
}

const say = (line = "") => process.stderr.write(`${line}\n`);
const short = (hash) => (hash ? hash.slice(0, 12) : "none");

/** Everything the launcher knows about this compiler folder. */
export function inspect(dir = HERE) {
	const presetText = readText(path.join(dir, "preset.json"));
	const preset = presetText === undefined ? undefined : JSON.parse(presetText);
	const bin = preset?.bin ?? /\[\[bin\]\][^[]*?name\s*=\s*"([^"]+)"/.exec(readText(path.join(dir, "Cargo.toml")) ?? "")?.[1];
	if (!bin) throw new Error(`${NAME}: no binary name (preset.json's "bin", or a [[bin]] in Cargo.toml)`);
	const triple = hostTriple();
	const exeName = process.platform === "win32" ? `${bin}.exe` : bin;
	const binDir = path.join(dir, "bin", triple);
	const exe = path.join(binDir, exeName);
	const stampPath = path.join(binDir, ".stamp");
	const hash = configHash(dir);
	const stamp = readText(stampPath)?.trim();
	const present = isFile(exe);
	return {
		dir, preset, bin, triple, exeName, binDir, exe, stampPath, hash, stamp, present,
		upToDate: present && stamp === hash,
		presetMatches: preset?.config === hash,
		prebuilt: preset?.binaries?.[triple],
	};
}

function where(s) {
	console.log(`binary: ${s.exe} (${s.present ? "present" : "missing"})`);
	const stamp = !s.present ? "no binary" : s.stamp === undefined ? "missing" : s.stamp === s.hash ? "matches the config" : `stale (made from config ${short(s.stamp)})`;
	console.log(`stamp: ${stamp}`);
	console.log(`config: ${s.hash}`);
	if (s.preset) {
		const fit = s.presetMatches ? "matches" : `differs (preset config ${short(s.preset.config)})`;
		console.log(`preset: ${s.preset.bin} ${s.preset.version}, ${fit}; prebuilt for ${s.triple}: ${s.prebuilt ? s.prebuilt.url : "none"}`);
	} else {
		console.log("preset: none (no preset.json)");
	}
}

async function download(s) {
	const { url, sha256 } = s.prebuilt;
	// https only (redirects are followed: the sha256 pins the bytes); plain http only for the launcher's tests,
	// whose fake release is a local server (tools/test-launcher.mjs sets RBXTSC_TEST_HTTP=1)
	let protocol;
	try {
		protocol = new URL(url).protocol;
	} catch {
		// not a URL
	}
	if (protocol !== "https:" && !(protocol === "http:" && process.env.RBXTSC_TEST_HTTP === "1")) {
		say(`${NAME}: not downloading ${url}: preset.json's binaries must be https: URLs.`);
		return false;
	}
	let zip;
	try {
		const response = await fetch(url, { redirect: "follow" });
		if (!response.ok) {
			say(`${NAME}: could not download ${url}: HTTP ${response.status}`);
			return false;
		}
		// the body too: a connection dropped halfway fails here
		zip = Buffer.from(await response.arrayBuffer());
	} catch (e) {
		say(`${NAME}: could not download ${url}: ${e.cause?.message ?? e.message}`);
		return false;
	}
	const actual = createHash("sha256").update(zip).digest("hex");
	if (actual !== String(sha256).toLowerCase()) {
		say(`${NAME}: sha256 mismatch for ${url}: expected ${sha256}, got ${actual}. Nothing was installed.`);
		return false;
	}
	let exe;
	try {
		exe = extractExe(zip, s.exeName);
	} catch (e) {
		say(`${NAME}: ${url}: ${e.message}`);
		return false;
	}
	install(s, (tmp) => fs.writeFileSync(tmp, exe));
	say(`${NAME}: downloaded ${s.preset.bin} ${s.preset.version} (${s.triple}) from ${url}, sha256 ${actual}`);
	return true;
}

/** Puts a new binary in place (written by `write` to a temporary path first) and stamps it with the config hash. */
function install(s, write, hash = s.hash) {
	fs.mkdirSync(s.binDir, { recursive: true });
	const tmp = `${s.exe}.${process.pid}.tmp`;
	try {
		write(tmp);
		if (process.platform !== "win32") fs.chmodSync(tmp, 0o755);
		fs.rmSync(s.stampPath, { force: true });
		fs.renameSync(tmp, s.exe);
	} catch (e) {
		fs.rmSync(tmp, { force: true });
		throw new Error(`${NAME}: could not write ${s.exe} (${e.code ?? e.message}); is it still running?`);
	}
	fs.writeFileSync(s.stampPath, `${hash}\n`);
}

function why(s) {
	const lines = [`${NAME}: no ${s.bin} binary for this config in ${path.relative(process.cwd(), s.binDir) || "."}.`];
	if (s.present) {
		lines.push(`  The binary there was made from another config (stamp ${short(s.stamp)}, config ${short(s.hash)}).`);
	}
	if (!s.preset) {
		lines.push("  There is no preset.json, so there is no prebuilt binary to download.");
	} else if (!s.presetMatches) {
		lines.push(`  The compiler config (Cargo.toml, Cargo.lock, rust-toolchain.toml, .cargo/config.toml, src/) changed: it hashes to ${short(s.hash)}, no longer`);
		lines.push(`  to the preset's ${short(s.preset.config)} (${s.preset.bin} ${s.preset.version}), so no prebuilt binary fits it.`);
	} else {
		const has = Object.keys(s.preset.binaries ?? {});
		lines.push(`  There is no prebuilt ${s.preset.bin} ${s.preset.version} for ${s.triple} (preset.json has: ${has.join(", ") || "none"}).`);
	}
	return lines;
}

function hasCommand(cmd) {
	const r = spawnSync(cmd, ["--version"], { stdio: "ignore", env: buildEnv() });
	return !r.error && r.status === 0;
}

/** The environment for cargo and rustup: rust-toolchain.toml decides the toolchain, not an inherited override. */
function buildEnv() {
	const env = { ...process.env };
	delete env.RUSTUP_TOOLCHAIN;
	delete env.CARGO_TARGET_DIR;
	delete env.CARGO_BUILD_TARGET;
	return env;
}

/** The rbxts-rs source each crate of the rbxts-rs API resolves to, from `cargo metadata`. */
export function rbxtsSources(metadata) {
	const sources = new Map();
	for (const p of metadata.packages) {
		if (p.name !== "rbxts_cli" && p.name !== "rbxts_plugin") continue;
		const list = sources.get(p.name) ?? [];
		list.push(p.source ?? `path ${path.dirname(p.manifest_path)}`);
		sources.set(p.name, list);
	}
	return sources;
}

function pinnedRev(dir) {
	const toml = readText(path.join(dir, "Cargo.toml")) ?? "";
	const line = /^rbxts_cli\s*=\s*\{([^}]*)\}/m.exec(toml)?.[1] ?? "";
	return /\b(?:tag|rev)\s*=\s*"([^"]+)"/.exec(line)?.[1] ?? "(the rbxts_cli pin in Cargo.toml)";
}

const BUILD_DIR_PREFIX = "rbxtsc-build-";

/**
 * The process a build folder in the OS temp folder belongs to: `rbxtsc-build-<hash prefix>-<pid>` names the launcher
 * that builds in it. `null` for an older launcher's `rbxtsc-build-<hash prefix>`, which names none; `undefined` for
 * any other name.
 */
export function buildDirOwner(name) {
	const match = /^rbxtsc-build-[0-9a-f]{12}(?:-(\d+))?$/.exec(name);
	if (!match) return undefined;
	return match[1] === undefined ? null : Number(match[1]);
}

function processAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		// another user's process
		return e.code === "EPERM";
	}
}

/**
 * Deletes the build folders in `tmp` that no running build holds: those of launchers that are gone (a build killed
 * before it could clean up, such as by closing its terminal), and those of older launchers, which named no owner.
 * Returns the names it deleted.
 */
export function removeStaleBuildDirs(tmp = os.tmpdir()) {
	let entries;
	try {
		entries = fs.readdirSync(tmp, { withFileTypes: true });
	} catch {
		return [];
	}
	const removed = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !entry.name.startsWith(BUILD_DIR_PREFIX)) continue;
		const owner = buildDirOwner(entry.name);
		if (owner === undefined || (owner !== null && owner !== process.pid && processAlive(owner))) continue;
		if (removeDir(path.join(tmp, entry.name))) removed.push(entry.name);
	}
	return removed;
}

/** Deletes a folder; on Windows a process that just ended may hold its files for a moment. */
function removeDir(dir) {
	try {
		fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
		return true;
	} catch {
		return false;
	}
}

/** Ends a process and the processes it started (cargo and its rustc processes). */
function killTree(child) {
	if (process.platform === "win32") {
		spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
	} else {
		child.kill("SIGKILL");
	}
}

/**
 * Runs cargo with `args` and resolves with `{ code, signal, error, interrupted }` once it has ended: `interrupted` is
 * the signal that stopped the launcher meanwhile. The launcher waits for cargo before it deletes the target folder.
 * On Windows Ctrl+C and Ctrl+Break reach cargo and its rustc processes too (one console), which end by themselves;
 * they are ended if they have not after a few seconds, and at once when the console closes. Elsewhere the signal is
 * passed on to cargo.
 */
function runCargo(args, options) {
	return new Promise((resolve) => {
		const child = spawn("cargo", args, options);
		let interrupted;
		let timer;
		const stop = (signal) => {
			interrupted ??= signal;
			if (process.platform !== "win32") {
				child.kill(signal);
			} else if (signal === "SIGINT" || signal === "SIGBREAK") {
				timer ??= setTimeout(() => killTree(child), 5000);
			} else {
				killTree(child);
			}
		};
		for (const signal of SIGNALS) process.on(signal, stop);
		const done = (result) => {
			clearTimeout(timer);
			for (const signal of SIGNALS) process.off(signal, stop);
			resolve({ ...result, interrupted });
		};
		child.on("error", (error) => done({ error }));
		child.on("exit", (code, signal) => done({ code, signal }));
	});
}

/** Builds the binary with Rust: true when built, false when not, or `{ signal }` when a signal stopped the build. */
async function build(s) {
	if (!hasCommand("cargo") || !hasCommand("rustup")) {
		say(`${NAME}: building needs Rust (cargo and rustup), which was not found.`);
		say("  Install rustup from https://rustup.rs, open a new terminal, and run this again. rustup then installs the");
		say(`  Rust version ${path.join(path.relative(process.cwd(), s.dir), "rust-toolchain.toml")} names by itself.`);
		return false;
	}
	const env = buildEnv();
	const cwd = s.dir;
	// rustup installs the toolchain of rust-toolchain.toml if it is missing (older rustup versions do it on the
	// first cargo command instead), without updating rustup itself
	spawnSync("rustup", ["toolchain", "install", "--no-self-update"], { cwd, env, stdio: ["ignore", "ignore", "inherit"] });
	const metadataArgs = ["metadata", "--format-version", "1", "--manifest-path", path.join(cwd, "Cargo.toml")];
	let locked = true;
	let meta = spawnSync("cargo", [...metadataArgs, "--locked"], { cwd, env, encoding: "utf8", maxBuffer: 1 << 28 });
	// "the lock file … needs to be updated but --locked was passed", or "cannot update the lock file … because
	// --locked was passed" (newer cargo)
	if (meta.status !== 0 && /lock file[\s\S]*--locked was passed/.test(meta.stderr ?? "")) {
		locked = false;
		say(`${NAME}: Cargo.lock does not match Cargo.toml (a changed dependency, such as an added plugin): building without`);
		say("  --locked, which updates Cargo.lock. Commit the updated Cargo.lock with the change.");
		meta = spawnSync("cargo", metadataArgs, { cwd, env, encoding: "utf8", maxBuffer: 1 << 28 });
	}
	if (meta.status !== 0) {
		process.stderr.write(meta.stderr ?? "");
		say(`${NAME}: cargo could not read the compiler package${meta.error ? ` (${meta.error.message})` : " (above)"}.`);
		return false;
	}
	for (const [name, sources] of rbxtsSources(JSON.parse(meta.stdout))) {
		if (new Set(sources).size > 1) {
			say(`${NAME}: all plugins must target rbxts-rs ${pinnedRev(cwd)}: ${name} resolves to ${sources.length} copies:`);
			for (const source of sources) say(`  ${source}`);
			say("  Pin each plugin to a version built for that rbxts-rs, or move rbxts_cli to the plugins' rbxts-rs.");
			return false;
		}
	}
	// a build killed before it could delete its target folder left it behind (several GB): the next build does
	const removed = removeStaleBuildDirs();
	if (removed.length > 0) say(`${NAME}: deleted ${removed.length} target folder(s) interrupted builds left in ${os.tmpdir()}`);
	// the launcher's process id in the name: a running build's folder is never another build's or a leftover
	const targetDir = path.join(os.tmpdir(), `${BUILD_DIR_PREFIX}${s.hash.slice(0, 12)}-${process.pid}`);
	const args = ["build", "--release", ...(locked ? ["--locked"] : []), "--target-dir", targetDir];
	say(`${NAME}: building ${s.bin} for ${s.triple} (about ${BUILD_MINUTES} min): cargo ${args.join(" ")}`);
	try {
		const r = await runCargo(args, { cwd, env, stdio: ["ignore", "inherit", "inherit"] });
		if (r.interrupted) {
			say(`${NAME}: the build was stopped (${r.interrupted}); deleting its target folder.`);
			return { signal: r.interrupted };
		}
		if (r.error || r.code !== 0) {
			say(`${NAME}: the build failed${r.error ? ` (${r.error.message})` : ""}.`);
			return false;
		}
		const built = path.join(targetDir, "release", s.exeName);
		// the hash after the build: without --locked, cargo may have updated Cargo.lock
		install(s, (tmp) => fs.copyFileSync(built, tmp), configHash(cwd));
	} finally {
		removeDir(targetDir);
	}
	say(`${NAME}: built ${s.exe}`);
	if (!locked) say(`${NAME}: Cargo.lock was updated; commit it.`);
	return true;
}

async function ask(question) {
	const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: false });
	process.stderr.write(question);
	const answer = await new Promise((resolve) => {
		rl.once("line", resolve);
		rl.once("close", () => resolve(""));
	});
	rl.close();
	// a terminal echoes the answer and its Enter; piped input (RBXTSC_INTERACTIVE=1) does not
	if (!process.stdin.isTTY) process.stderr.write(`${answer}\n`);
	return /^\s*y(es)?\s*$/i.test(answer);
}

function interactive() {
	const forced = process.env.RBXTSC_INTERACTIVE;
	if (forced === "1") return true;
	if (forced === "0") return false;
	return Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

const SIGNALS = process.platform === "win32" ? ["SIGINT", "SIGBREAK", "SIGHUP", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];

/**
 * Runs the binary with inherited stdio and resolves with its exit code, or `{ signal }` when a signal ended it. The
 * launcher's signals go to the binary, and the launcher waits for it to end, so no process is left behind. On Windows
 * Ctrl+C reaches the binary itself (one console); it is given a moment to end on its own before it is stopped.
 */
export function run(exe, args) {
	return new Promise((resolve) => {
		const child = spawn(exe, args, { stdio: "inherit" });
		let timer;
		const forward = (signal) => {
			if (process.platform !== "win32") {
				child.kill(signal);
			} else if (signal === "SIGINT" || signal === "SIGBREAK") {
				timer ??= setTimeout(() => child.kill(), 1000);
			} else {
				child.kill();
			}
		};
		for (const signal of SIGNALS) process.on(signal, forward);
		const done = (result) => {
			clearTimeout(timer);
			for (const signal of SIGNALS) process.off(signal, forward);
			resolve(result);
		};
		child.on("error", (e) => {
			say(`${NAME}: could not run ${exe}: ${e.message}`);
			done(1);
		});
		child.on("exit", (code, signal) => done(code ?? { signal: signal ?? "SIGTERM" }));
	});
}

/** This file's path from the working directory, with `/`. */
function launcherPath(s) {
	return path.relative(process.cwd(), path.join(s.dir, NAME)).split(path.sep).join("/");
}

/** The launcher: returns the exit code, or `{ signal }` for a binary a signal ended. */
export async function main(argv, dir = HERE) {
	// launcher flags before a `--`; everything after it is the binary's
	const end = argv.indexOf("--");
	const own = end < 0 ? argv : argv.slice(0, end);
	const flags = new Set(own.filter((a) => LAUNCHER_FLAGS.has(a)));
	const args = [...own.filter((a) => !LAUNCHER_FLAGS.has(a)), ...(end < 0 ? [] : argv.slice(end + 1))];
	const s = inspect(dir);
	if (flags.has("--where")) {
		where(s);
		return 0;
	}
	const buildAsked = flags.has("--build") || flags.has("--rebuild") || process.env.RBXTSC_BUILD === "1";
	if (flags.has("--rebuild")) {
		const built = await build(s);
		if (built !== true) return built || 1;
	} else if (s.upToDate) {
		// the stamp matches: run it
	} else if (s.presetMatches && s.prebuilt) {
		if (!(await download(s))) {
			say(`  (or build it with Rust: node ${launcherPath(s)} --build)`);
			return 1;
		}
	} else {
		for (const line of why(s)) say(line);
		const command = `node ${launcherPath(s)} --build`;
		if (!buildAsked) {
			if (!interactive()) {
				say(`  To build it with Rust (about ${BUILD_MINUTES} min), run: ${command}`);
				say("  (or set RBXTSC_BUILD=1)");
				return 1;
			}
			if (!(await ask(`Build it with Rust now? This takes about ${BUILD_MINUTES} min. [y/N] `))) {
				say(`${NAME}: not building. To build it later: ${command}`);
				return 1;
			}
		}
		const built = await build(s);
		if (built !== true) return built || 1;
	}
	// `rbxtsc.mjs --build` (or --rebuild) alone only builds
	if (args.length === 0 && (flags.has("--build") || flags.has("--rebuild"))) return 0;
	return run(s.exe, args);
}

// The launcher ends by setting process.exitCode and returning, never with process.exit(): Node 23 on Windows can
// fail a libuv assertion (0xC0000409) when process.exit() follows a failed fetch.
function exitWith(result) {
	if (typeof result === "number") {
		process.exitCode = result;
		return;
	}
	process.exitCode = 128 + (os.constants.signals[result.signal] ?? 15);
	if (process.platform !== "win32") {
		// end the same way the binary did, so a shell sees the signal (no handler is left for it)
		process.kill(process.pid, result.signal);
	}
}

function invokedDirectly() {
	if (!process.argv[1]) return false;
	let invoked;
	try {
		invoked = fs.realpathSync(path.resolve(process.argv[1]));
	} catch {
		return false;
	}
	const self = fileURLToPath(import.meta.url);
	return process.platform === "win32" ? invoked.toLowerCase() === self.toLowerCase() : invoked === self;
}

if (invokedDirectly()) {
	main(process.argv.slice(2)).then(exitWith, (e) => {
		say(e.message);
		process.exitCode = 1;
	});
}
