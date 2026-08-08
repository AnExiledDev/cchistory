/**
 * Service for downloading and detecting Claude Code native binaries.
 * Handles the transition from Node.js cli.js to compiled Bun binaries (≥ 2.1.113).
 */

import { execSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import chalk from "chalk";
import { quote } from "shell-quote";

const PACKAGE_PREFIX = "@anthropic-ai/claude-code";

/**
 * Detect if the system uses musl libc (Alpine, etc.)
 */
function detectMusl(): boolean {
	if (process.platform !== "linux") return false;
	const report = typeof process.report?.getReport === "function" ? process.report.getReport() : null;
	if (report == null) return false;
	return (report as Record<string, Record<string, unknown>>).header?.glibcVersionRuntime === undefined;
}

/**
 * Get platform key for the current system (matches npm optional dep naming)
 */
export function getPlatformKey(): string {
	const platform = process.platform;
	let cpu = os.arch();

	if (platform === "linux") {
		return `linux-${cpu}${detectMusl() ? "-musl" : ""}`;
	}

	// Rosetta 2: prefer native arm64 binary over x64 under translation
	if (platform === "darwin" && cpu === "x64") {
		const r = spawnSync("sysctl", ["-n", "sysctl.proc_translated"], { encoding: "utf8" });
		if (r.stdout?.trim() === "1") {
			cpu = "arm64";
		}
	}

	return `${platform}-${cpu}`;
}

/**
 * Get the npm package name for the current platform's binary
 */
export function getPlatformPackageName(): string {
	return `${PACKAGE_PREFIX}-${getPlatformKey()}`;
}

/**
 * Download the platform-specific Claude Code binary for a given version
 * @param version - Version to download
 * @param targetDir - Parent directory (binary extracted into targetDir/native-binary/)
 * @returns Absolute path to the extracted binary
 */
export function downloadBinary(version: string, targetDir: string): string {
	const pkg = getPlatformPackageName();
	const binaryDir = path.join(targetDir, "native-binary");
	fs.mkdirSync(binaryDir, { recursive: true });

	console.log(chalk.gray(`  Downloading platform binary ${pkg}@${version}...`));

	try {
		execSync(`npm pack ${quote([`${pkg}@${version}`])}`, {
			cwd: binaryDir,
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch (error) {
		throw new Error(
			`Failed to download platform binary ${pkg}@${version}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const files = fs.readdirSync(binaryDir);
	const tarFile = files.find((f) => f.endsWith(".tgz"));
	if (!tarFile) {
		throw new Error(`Could not find platform package tarball for ${pkg}@${version}`);
	}

	execSync(`tar -xzf ${quote([tarFile])}`, {
		cwd: binaryDir,
		stdio: ["pipe", "pipe", "pipe"],
	});

	const binaryName = process.platform === "win32" ? "claude.exe" : "claude";
	const binaryPath = path.join(binaryDir, "package", binaryName);

	if (!fs.existsSync(binaryPath)) {
		const packageFiles = fs.readdirSync(path.join(binaryDir, "package"));
		throw new Error(`Binary not found at ${binaryPath}. Package contents: ${packageFiles.join(", ")}`);
	}

	fs.chmodSync(binaryPath, 0o755);
	return binaryPath;
}

/**
 * Check if an extracted package uses native binary format (no cli.js)
 * @param packageDir - Path to extracted npm package directory
 * @returns true if the package uses native binary format
 */
export function isNativeBinaryPackage(packageDir: string): boolean {
	return !fs.existsSync(path.join(packageDir, "cli.js"));
}

/**
 * Detect if a file is a native executable (ELF, Mach-O, PE) vs JavaScript
 * @param filePath - Path to the file
 * @returns true if the file is a native binary
 */
export function isNativeBinary(filePath: string): boolean {
	if (filePath.endsWith(".js") || filePath.endsWith(".cjs") || filePath.endsWith(".mjs")) {
		return false;
	}

	try {
		const buf = Buffer.alloc(4);
		const fd = fs.openSync(filePath, "r");
		fs.readSync(fd, buf, 0, 4, 0);
		fs.closeSync(fd);

		// ELF: 7f 45 4c 46
		if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) return true;
		// Mach-O 64-bit: cf fa ed fe
		if (buf[0] === 0xcf && buf[1] === 0xfa && buf[2] === 0xed && buf[3] === 0xfe) return true;
		// Mach-O 32-bit: ce fa ed fe
		if (buf[0] === 0xce && buf[1] === 0xfa && buf[2] === 0xed && buf[3] === 0xfe) return true;
		// Mach-O universal: fe ed fa cf/ce
		if (buf[0] === 0xfe && buf[1] === 0xed && buf[2] === 0xfa) return true;
		// PE (Windows): 4d 5a
		if (buf[0] === 0x4d && buf[1] === 0x5a) return true;

		return false;
	} catch {
		return false;
	}
}
