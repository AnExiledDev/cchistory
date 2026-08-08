#!/usr/bin/env node

import { spawn } from "node:child_process";
import * as path from "node:path";
import chalk from "chalk";
import { parse, quote } from "shell-quote";
import { extractSystemPrompt, findAndExtractUserMessage } from "./core/content-extractor.js";
import { filterAndSortTools, hasTools, selectBestRequest } from "./core/request-filter.js";
import { downloadBinary, isNativeBinary, isNativeBinaryPackage } from "./services/binary-service.js";
import { exists, readDir, readFile, writeFile } from "./services/file-service.js";
import {
	downloadPackage,
	getAllVersionsBetween,
	getLatestVersion,
	getVersionReleaseDate,
} from "./services/npm-service.js";
import { startProxy } from "./services/proxy-service.js";
import { exec } from "./services/shell-service.js";
import { cleanupTempDir, createTempWorkDir } from "./services/temp-service.js";
import type { RequestResponsePair } from "./types/request.js";

const CCHISTORY_FLAGS = ["--latest", "--binary-path", "--claude-args", "--version", "-v", "--help", "-h"];

/**
 * Spawn Claude as an async child process.
 * Must be async (not execSync) so the reverse proxy event loop can process requests.
 */
function runClaude(
	command: string,
	args: string[],
	options: { cwd: string; env: Record<string, string> },
): Promise<{ code: number; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			env: { ...process.env, ...options.env },
			cwd: options.cwd,
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stderr = "";
		child.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		child.on("error", reject);
		child.on("close", (code) => {
			resolve({ code: code ?? 1, stderr });
		});
	});
}

async function processVersion(
	versionOrLabel: string,
	originalCwd: string,
	customBinaryPath?: string,
	claudeArgs?: string,
) {
	const outputFilename = customBinaryPath
		? `prompts-custom-${new Date().toISOString().replace(/[:.]/g, "-")}.md`
		: `prompts-${versionOrLabel}.md`;
	const outputPath = path.join(originalCwd, outputFilename);
	if (exists(outputPath)) {
		console.log(chalk.gray(`Skipping ${customBinaryPath ? "custom binary" : versionOrLabel} - already exists`));
		return;
	}

	console.log(
		chalk.blue(`Processing ${customBinaryPath ? `custom binary (${customBinaryPath})` : versionOrLabel}...`),
	);

	let binaryPath: string;
	let tmpDir: string | undefined;
	let useNode = false;

	// --- Determine binary path ---
	if (customBinaryPath) {
		binaryPath = customBinaryPath;
		useNode = !isNativeBinary(customBinaryPath);
	} else {
		tmpDir = createTempWorkDir("claude-history");
		const packageDir = path.join(tmpDir, "package");

		downloadPackage(versionOrLabel, tmpDir);
		const tarFile = path.join(tmpDir, `anthropic-ai-claude-code-${versionOrLabel}.tgz`);
		exec(`tar -xzf ${quote([tarFile])}`, { cwd: tmpDir });

		if (isNativeBinaryPackage(packageDir)) {
			// Native binary version (≥ 2.1.113) — download platform-specific binary
			binaryPath = downloadBinary(versionOrLabel, tmpDir);
			useNode = false;
		} else {
			// Old cli.js version
			binaryPath = path.join(packageDir, "cli.js");
			if (!exists(binaryPath)) {
				console.error(chalk.red(`CLI file not found for version ${versionOrLabel}`));
				console.error(chalk.gray("Expected path:"), binaryPath);
				console.error(chalk.gray("Package contents:"));
				try {
					const packageFiles = readDir(packageDir);
					for (const file of packageFiles) {
						console.error(chalk.gray(`  - ${file}`));
					}
				} catch (_e) {
					console.error(chalk.gray("  Could not list package directory"));
				}
				throw new Error(`CLI file not found at ${binaryPath}`);
			}
			useNode = true;
		}
	}

	// --- Create work directory ---
	let workDir: string;
	if (customBinaryPath) {
		tmpDir = createTempWorkDir("claude-history-custom");
		workDir = tmpDir;
	} else {
		if (!tmpDir) throw new Error("Internal error: tmpDir not initialized");
		workDir = tmpDir;
	}

	try {
		// --- Start reverse proxy ---
		const traceDir = path.join(workDir, ".trace-log");
		const proxy = await startProxy(traceDir);

		try {
			// --- Build Claude invocation ---
			const promptArgs = ["-p", `${new Date().toISOString()} is the date. Write a haiku about it.`];

			let additionalArgs: string[] = [];
			if (claudeArgs) {
				const parsed = parse(claudeArgs);
				additionalArgs = parsed.filter((entry): entry is string => typeof entry === "string");
			}

			const command = useNode ? "node" : binaryPath;
			const args = useNode ? [binaryPath, ...promptArgs, ...additionalArgs] : [...promptArgs, ...additionalArgs];

			const env = {
				ANTHROPIC_BASE_URL: `http://127.0.0.1:${proxy.port}`,
				CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
			};

			if (process.env.DEBUG) {
				console.log(chalk.gray(`  Command: ${command} ${args.join(" ")}`));
				console.log(chalk.gray(`  ANTHROPIC_BASE_URL: ${env.ANTHROPIC_BASE_URL}`));
			}

			// --- Run Claude ---
			const result = await runClaude(command, args, { cwd: workDir, env });
			if (result.code !== 0) {
				console.error(chalk.yellow(`  Claude exited with code ${result.code}`));
				if (process.env.DEBUG && result.stderr) {
					console.error(chalk.gray("  stderr:"), result.stderr);
				}
			}
		} finally {
			await proxy.stop();
		}

		// --- Read JSONL log ---
		const logFiles = readDir(traceDir);
		const jsonlFile = logFiles.find((f) => f.endsWith(".jsonl"));

		if (!jsonlFile) {
			throw new Error("No JSONL log file found in trace directory");
		}

		const jsonlPath = path.join(traceDir, jsonlFile);
		const jsonlContent = readFile(jsonlPath);
		const data: RequestResponsePair[] = jsonlContent
			.trim()
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => JSON.parse(line));

		if (process.env.DEBUG) {
			console.log(chalk.gray(`  Found ${data.length} request/response pairs`));
			for (const pair of data) {
				console.log(
					chalk.gray(
						`  - ${pair.request.body.model || "unknown"} (${pair.request.body.tools?.length || 0} tools)`,
					),
				);
			}
		}

		const selectedRequest = selectBestRequest(data);

		if (!hasTools(selectedRequest)) {
			console.warn(chalk.yellow("Warning: Selected request has no tools. This may not be a Claude Code request."));
		}

		const request = selectedRequest.request;

		const userMessage = findAndExtractUserMessage(request.body.messages);
		const systemPrompt = extractSystemPrompt(request.body);
		const tools = filterAndSortTools(request.body.tools);

		const releaseDate = customBinaryPath ? "Custom Binary" : getVersionReleaseDate(versionOrLabel);
		const versionLabel = customBinaryPath ? `Custom Binary (${outputFilename})` : versionOrLabel;

		const indentHeaders = (text: string): string => {
			return text
				.split("\n")
				.map((line) => {
					const match = line.match(/^(#+)(\s+)/);
					if (match) {
						return `#${line}`;
					}
					return line;
				})
				.join("\n");
		};

		const toolsFormatted = tools
			.map((tool) => {
				const schemaStr = JSON.stringify(tool.input_schema, null, 2);
				const indentedDescription = indentHeaders(indentHeaders(tool.description));
				return `## ${tool.name}\n\n${indentedDescription}\n${schemaStr}`;
			})
			.join("\n\n---\n\n");

		const output = `# Claude Code Version ${versionLabel}

Release Date: ${releaseDate}

# User Message

${indentHeaders(userMessage)}

# System Prompt

${indentHeaders(systemPrompt)}

# Tools

${toolsFormatted}
`;

		writeFile(outputPath, output);

		console.log(
			chalk.green(`✓ ${customBinaryPath ? "custom binary" : versionOrLabel} → ${path.basename(outputPath)}`),
		);
	} catch (error) {
		console.error(
			chalk.red(`\nFailed to process ${customBinaryPath ? "custom binary" : `version ${versionOrLabel}`}:`),
		);
		throw error;
	} finally {
		if (tmpDir) {
			cleanupTempDir(tmpDir);
		}
	}
}

async function main() {
	const args = process.argv.slice(2);
	const fetchToLatest = args.includes("--latest");

	const binaryPathIndex = args.indexOf("--binary-path");
	const customBinaryPath =
		binaryPathIndex !== -1 && args[binaryPathIndex + 1] && !CCHISTORY_FLAGS.includes(args[binaryPathIndex + 1])
			? args[binaryPathIndex + 1]
			: undefined;

	if (binaryPathIndex !== -1 && !customBinaryPath) {
		console.error(chalk.red("Error: --binary-path requires a valid path value"));
		process.exit(1);
	}

	const claudeArgsIndex = args.indexOf("--claude-args");
	const claudeArgs = claudeArgsIndex !== -1 && args[claudeArgsIndex + 1] ? args[claudeArgsIndex + 1] : undefined;

	if (claudeArgsIndex !== -1 && !claudeArgs) {
		console.error(chalk.red("Error: --claude-args requires a value"));
		process.exit(1);
	}

	const version = customBinaryPath ? (args[0] && !CCHISTORY_FLAGS.includes(args[0]) ? args[0] : "custom") : args[0];

	const packageJsonPath = path.join(__dirname, "..", "package.json");
	const packageJson = JSON.parse(readFile(packageJsonPath));

	if (args.includes("--version") || args.includes("-v")) {
		console.log(packageJson.version);
		process.exit(0);
	}

	console.log(chalk.cyan(`cchistory v${packageJson.version}`));
	console.log();

	if ((!version || CCHISTORY_FLAGS.includes(version)) && !customBinaryPath) {
		console.log(
			chalk.yellow('Usage: cchistory [version] [--latest] [--binary-path <path>] [--claude-args "<args>"]'),
		);
		console.log(chalk.gray("Examples:"));
		console.log(
			chalk.gray("  cchistory 1.0.0                                          # Extract prompts from version 1.0.0"),
		);
		console.log(
			chalk.gray(
				"  cchistory 1.0.0 --latest                                 # Extract prompts from 1.0.0 to latest",
			),
		);
		console.log(chalk.gray("  cchistory --binary-path /home/claude-code/cli.js         # Use custom binary"));
		console.log(
			chalk.gray('  cchistory --binary-path cli.js --claude-args "--debug"   # Pass args to custom binary'),
		);
		console.log(chalk.gray('  cchistory 1.0.0 --claude-args "--append-system-prompt"   # Pass args to npm version'));
		console.log(chalk.gray("  cchistory --version                                      # Show version"));
		process.exit(1);
	}

	const originalCwd = process.cwd();

	if (customBinaryPath) {
		if (!exists(customBinaryPath)) {
			console.error(chalk.red(`Error: Binary path does not exist: ${customBinaryPath}`));
			process.exit(1);
		}

		if (fetchToLatest) {
			console.warn(chalk.yellow("Warning: --latest flag is ignored when using --binary-path"));
			console.warn(chalk.yellow("Only the custom binary will be processed"));
		}

		if (version && version !== "custom" && !version.startsWith("--")) {
			console.log(chalk.gray(`Note: Using label "${version}" for custom binary output`));
		}
	}

	if (fetchToLatest && !customBinaryPath) {
		const latestVersion = getLatestVersion();
		console.log(chalk.blue(`Fetching versions ${version} → ${latestVersion}`));

		const versions = getAllVersionsBetween(version, latestVersion);
		console.log(chalk.gray(`Found ${versions.length} versions`));

		for (const v of versions) {
			try {
				await processVersion(v, originalCwd, customBinaryPath, claudeArgs);
			} catch (error) {
				console.error(chalk.red(`✗ ${v} failed:`));
				console.error(chalk.gray("  Error:"), error instanceof Error ? error.message : String(error));
				if (error instanceof Error && error.stack && process.env.DEBUG) {
					console.error(chalk.gray("  Stack:"), error.stack);
				}
			}
		}

		console.log(chalk.green(`\nCompleted ${versions.length} versions`));
	} else {
		await processVersion(version, originalCwd, customBinaryPath, claudeArgs);
	}
}

main().catch((error) => {
	console.error(chalk.red("Fatal error:"));
	console.error(chalk.gray("Message:"), error instanceof Error ? error.message : String(error));
	if (error instanceof Error && error.stack && process.env.DEBUG) {
		console.error(chalk.gray("Stack trace:"));
		console.error(error.stack);
	}
	if (!process.env.DEBUG) {
		console.error(chalk.gray("\nTip: Set DEBUG=1 to see full stack traces"));
	}
	process.exit(1);
});
