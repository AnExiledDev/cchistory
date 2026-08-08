/**
 * HTTP reverse proxy for intercepting Claude API requests.
 * Replaces claude-trace — works with both Node.js and native binary versions.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as path from "node:path";

const ANTHROPIC_API_HOST = "api.anthropic.com";

export interface ProxyServer {
	port: number;
	logPath: string;
	stop: () => Promise<void>;
}

/**
 * Start a reverse proxy that forwards requests to the Anthropic API
 * and logs request/response pairs as JSONL (matching RequestResponsePair format)
 * @param logDir - Directory to write the JSONL log file
 * @returns ProxyServer with port, logPath, and stop function
 */
export function startProxy(logDir: string): Promise<ProxyServer> {
	fs.mkdirSync(logDir, { recursive: true });
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const logPath = path.join(logDir, `log-${timestamp}.jsonl`);
	const logStream = fs.createWriteStream(logPath, { flags: "a" });

	const server = http.createServer((req, res) => {
		const requestChunks: Buffer[] = [];

		req.on("data", (chunk: Buffer) => {
			requestChunks.push(chunk);
		});

		req.on("end", () => {
			const requestBody = Buffer.concat(requestChunks).toString("utf-8");
			const requestTimestamp = Date.now();

			// Build forwarding headers — replace host, recalculate content-length
			const forwardHeaders: Record<string, string | string[] | undefined> = { ...req.headers };
			delete forwardHeaders.host;
			delete forwardHeaders["content-length"];

			const options: https.RequestOptions = {
				hostname: ANTHROPIC_API_HOST,
				port: 443,
				path: req.url,
				method: req.method,
				headers: {
					...forwardHeaders,
					host: ANTHROPIC_API_HOST,
					"content-length": Buffer.byteLength(requestBody).toString(),
				},
			};

			const proxyReq = https.request(options, (proxyRes) => {
				const responseChunks: Buffer[] = [];

				// Stream response headers and data through immediately
				res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);

				proxyRes.on("data", (chunk: Buffer) => {
					responseChunks.push(chunk);
					res.write(chunk);
				});

				proxyRes.on("end", () => {
					const responseBody = Buffer.concat(responseChunks).toString("utf-8");

					let parsedRequest: unknown;
					let parsedResponse: unknown;
					try {
						parsedRequest = JSON.parse(requestBody);
					} catch {
						parsedRequest = requestBody;
					}
					try {
						parsedResponse = JSON.parse(responseBody);
					} catch {
						// SSE/streaming responses won't parse — store raw string
						parsedResponse = responseBody;
					}

					const pair = {
						request: {
							timestamp: requestTimestamp,
							method: req.method || "POST",
							url: req.url || "/",
							headers: req.headers as Record<string, string>,
							body: parsedRequest,
						},
						response: parsedResponse,
					};

					logStream.write(`${JSON.stringify(pair)}\n`);
					res.end();
				});
			});

			proxyReq.on("error", (err) => {
				console.error(`Proxy forwarding error: ${err.message}`);
				if (!res.headersSent) {
					res.writeHead(502);
				}
				res.end(`Proxy error: ${err.message}`);
			});

			proxyReq.write(requestBody);
			proxyReq.end();
		});
	});

	return new Promise((resolve, reject) => {
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address() as { port: number };
			resolve({
				port: addr.port,
				logPath,
				stop: () =>
					new Promise<void>((resolveStop) => {
						logStream.end(() => {
							server.close(() => resolveStop());
						});
					}),
			});
		});
	});
}
