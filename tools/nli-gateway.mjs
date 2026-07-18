import { createServer } from "node:http";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createGatewayConfig, loadDotEnv } from "./nli/config.mjs";
import { loadNliContext as loadContext } from "./nli/context.mjs";
import { assertJsonContentType, createRateLimiter, HttpRequestError, isOriginAllowed, readNliRequest, readRequestJson, sendJson, setCorsHeaders } from "./nli/http.mjs";
import { createModelClient } from "./nli/model-client.mjs";
import { isModelEligible, isModelIntentGrounded, resolveLocally } from "./nli/router.mjs";
import { rejectResponse } from "./nli/responses.mjs";
import { canonicalizeModelResponse, validateNliResponse } from "./nli/validation.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
await loadDotEnv(root);

const defaultConfig = createGatewayConfig();
const defaultContextPromise = loadContext(root);
const defaultModelClient = createModelClient(defaultConfig);
const localResolutionConfidence = 0.8;
const gatewayRevision = defaultConfig.releaseRevision || resolveGatewayRevision(root);

export { validateNliResponse };

export async function loadNliContext() {
  return loadContext(root);
}

export async function resolveNliRequest(message, context = null, options = {}) {
  const safeMessage = String(message || "").trim();
  const baseContext = context || (await defaultContextPromise);
  const nliContext = {
    ...baseContext,
    currentTargetId: typeof options.currentTargetId === "string" ? options.currentTargetId : null
  };
  if (!safeMessage) return rejectResponse();

  const local = resolveLocally(safeMessage, nliContext);
  if (local.confidence >= localResolutionConfidence) return local;
  if (options.useModel === false || !isModelEligible(safeMessage, nliContext, local)) {
    return local.confidence > 0 ? local : rejectResponse();
  }

  const modelClient = options.modelClient || defaultModelClient;
  const modelResponse = await modelClient(safeMessage, nliContext).catch(() => null);
  if (!modelResponse || !isModelIntentGrounded(safeMessage, modelResponse, nliContext)) {
    return local.confidence > 0 ? local : rejectResponse();
  }

  return canonicalizeModelResponse(modelResponse, nliContext) || (local.confidence > 0 ? local : rejectResponse());
}

export async function createNliServer(options = {}) {
  const config = options.config || defaultConfig;
  const context = options.context || (await defaultContextPromise);
  const modelClient = options.modelClient || (config === defaultConfig ? defaultModelClient : createModelClient(config));
  const rateLimiter = createRateLimiter(config);

  const server = createServer(async (request, response) => {
    setCorsHeaders(request, response, config);
    if (!isOriginAllowed(request, config)) {
      sendJson(response, 403, rejectResponse("허용되지 않은 출처의 요청입니다."));
      return;
    }

    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    const url = new URL(request.url || "/", `http://${config.host}:${config.port}`);
    if (request.method === "GET" && url.pathname === "/api/nli/health") {
      sendJson(response, 200, {
        ok: true,
        targets: context.routes.targets.length,
        terms: context.glossary.terms.length,
        revision: config.releaseRevision || gatewayRevision,
        processId: process.pid
      });
      return;
    }

    if (request.method !== "POST" || url.pathname !== "/api/nli") {
      sendJson(response, 404, { error: "Not found" });
      return;
    }

    if (!rateLimiter.consume(request)) {
      sendJson(response, 429, rejectResponse("요청이 너무 많습니다. 잠시 후 다시 시도해주세요."), { "Retry-After": "60" });
      return;
    }

    try {
      assertJsonContentType(request);
      const body = await readRequestJson(request, config.maxRequestBytes);
      const nliRequest = readNliRequest(body, config.maxMessageLength);
      const result = await resolveNliRequest(nliRequest.message, context, {
        currentTargetId: nliRequest.currentTargetId,
        modelClient
      });
      sendJson(response, 200, result);
    } catch (error) {
      const statusCode = error instanceof HttpRequestError ? error.statusCode : 400;
      const message = error instanceof HttpRequestError ? error.publicMessage : "요청을 처리할 수 없습니다.";
      sendJson(response, statusCode, rejectResponse(message));
    }
  });

  server.requestTimeout = config.requestTimeoutMs;
  server.headersTimeout = Math.min(config.requestTimeoutMs, 60_000);
  return server;
}

function resolveGatewayRevision(rootDir) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: rootDir, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await createNliServer();
  server.listen(defaultConfig.port, defaultConfig.host, () => {
    console.log(`NLI gateway listening at http://${defaultConfig.host}:${defaultConfig.port}`);
  });
}
