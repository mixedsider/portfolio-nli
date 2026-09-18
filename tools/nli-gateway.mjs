import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createGatewayConfig, loadDotEnv } from "./nli/config.mjs";
import { loadNliContext as loadContext } from "./nli/context.mjs";
import {
  assertJsonContentType,
  createRateLimiter,
  HttpRequestError,
  isOriginAllowed,
  readNliRequest,
  readRequestJson,
  sendJson,
  setCorsHeaders
} from "./nli/http.mjs";
import { createRequestResolver } from "./nli/request-resolution.mjs";
import { canWriteResponse, observeClientDisconnect, UpstreamUnavailableError } from "./nli/request-deadline.mjs";
import { rejectResponse } from "./nli/responses.mjs";
import { validateNliResponse } from "./nli/validation.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
await loadDotEnv(root);

const defaultConfig = createGatewayConfig();
const defaultContextPromise = loadContext(root);
const defaultResolver = createRequestResolver(defaultConfig, { context: defaultContextPromise });
const gatewayRevision = defaultConfig.releaseRevision || resolveGatewayRevision(root);

export { validateNliResponse };

export async function loadNliContext() {
  return loadContext(root);
}

export function resolveNliRequest(message, context = null, options = {}) {
  return defaultResolver(message, context || defaultContextPromise, options);
}

export async function createNliServer(options = {}) {
  const config = options.config || defaultConfig;
  const context = options.context || (await defaultContextPromise);
  const resolveRequest = createRequestResolver(config, { context, now: options.now, observer: options.observer,
    lfmClient: options.lfmClient, qwenClient: options.qwenClient, verifier: options.verifier });
  const rateLimiter = createRateLimiter(config);

  const server = createServer(async (request, response) => {
    setCorsHeaders(request, response, config);
    if (!isOriginAllowed(request, config)) {
      sendJson(response, 403, gatewayErrorResponse("ORIGIN_NOT_ALLOWED", "허용되지 않은 출처의 요청입니다."));
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
      sendJson(response, 429, gatewayErrorResponse("RATE_LIMITED", "요청이 너무 많습니다. 잠시 후 다시 시도해주세요."), { "Retry-After": "60" });
      return;
    }

    const disconnect = observeClientDisconnect(request, response, options.signal);
    try {
      assertJsonContentType(request);
      const body = await readRequestJson(request, config.maxRequestBytes);
      const nliRequest = readNliRequest(body, config.maxMessageLength);
      const result = await resolveRequest(nliRequest.message, context, {
        currentTargetId: nliRequest.currentTargetId,
        history: nliRequest.history,
        modelClient: options.modelClient,
        useModel: options.useModel,
        signal: disconnect.signal,
        reportUpstreamFailure: true
      });
      if (!canWriteResponse(response)) return;
      sendJson(
        response,
        200,
        result.intent === "reject_out_of_scope"
          ? gatewayErrorResponse("OUT_OF_SCOPE", result.message, result.confidence)
          : result
      );
    } catch (error) {
      if (!canWriteResponse(response)) return;
      if (error instanceof UpstreamUnavailableError) {
        sendJson(response, 503, gatewayErrorResponse("UPSTREAM_UNAVAILABLE", "도우미 응답을 일시적으로 가져오지 못했습니다. 잠시 후 다시 시도해주세요."));
        return;
      }

      const statusCode = error instanceof HttpRequestError ? error.statusCode : 400;
      const message = error instanceof HttpRequestError ? error.publicMessage : "요청을 처리할 수 없습니다.";
      sendJson(response, statusCode, gatewayErrorResponse(requestErrorCode(statusCode), message));
    } finally { disconnect.dispose(); }
  });

  server.requestTimeout = config.requestTimeoutMs;
  server.headersTimeout = Math.min(config.requestTimeoutMs, 60_000);
  return server;
}

function gatewayErrorResponse(errorCode, message, confidence = 1) {
  return { ...rejectResponse(message, confidence), errorCode, requestId: randomUUID() };
}

function requestErrorCode(statusCode) {
  switch (statusCode) {
    case 413:
      return "REQUEST_TOO_LARGE";
    case 415:
      return "UNSUPPORTED_MEDIA_TYPE";
    default:
      return "INVALID_REQUEST";
  }
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
