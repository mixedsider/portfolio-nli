import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const port = Number(process.env.NLI_PORT || 8787);
const host = process.env.NLI_HOST || "127.0.0.1";
const lmStudioBaseUrl = process.env.LM_STUDIO_BASE_URL || "http://192.168.0.58:1234/v1";
const lmStudioModel = process.env.LM_STUDIO_MODEL || "google/gemma-4-e4b";
const lmStudioTimeoutMs = Number(process.env.LM_STUDIO_TIMEOUT_MS || 8000);

const intentNames = new Set(["navigate", "define_term", "summarize_section", "reject_out_of_scope"]);
const navigateWords = ["보여", "이동", "열어", "가줘", "보고", "찾아", "섹션", "어디"];
const defineWords = ["뭐야", "뜻", "설명", "의미", "알려줘", "무슨"];
const summarizeWords = ["요약", "정리", "뭘 했", "무슨 프로젝트", "간단히"];
const responseKeys = new Set(["intent", "confidence", "targetId", "term", "message", "answer", "relatedTargets"]);

export async function loadNliContext() {
  const [routes, glossary, prompt, portfolio] = await Promise.all([
    readJson("nli/routes.json"),
    readJson("nli/glossary.json"),
    readText("nli/system-prompt.md"),
    readPortfolioData()
  ]);

  const targetById = new Map(routes.targets.map((target) => [target.id, target]));
  const sectionById = new Map(
    portfolio.projects.flatMap((project) =>
      project.sections.map((section) => [
        section.id,
        {
          ...section,
          projectTitle: project.title
        }
      ])
    )
  );
  const termByCanonical = new Map(glossary.terms.map((term) => [normalize(term.term), term]));

  return {
    routes,
    glossary,
    prompt,
    portfolio,
    targetById,
    sectionById,
    termByCanonical
  };
}

export async function resolveNliRequest(message, context = null, options = {}) {
  const safeMessage = String(message || "").trim();
  const nliContext = context || (await loadNliContext());
  const useModel = options.useModel !== false;

  if (!safeMessage) return rejectResponse();

  const local = resolveLocally(safeMessage, nliContext);
  if (local.confidence >= 0.7) return local;

  if (!useModel) return local.confidence > 0 ? local : rejectResponse();

  const modelResponse = await askModel(safeMessage, nliContext).catch(() => null);
  const guarded = guardModelResponse(modelResponse, nliContext);
  if (guarded) return guarded;

  return local.confidence > 0 ? local : rejectResponse();
}

export async function createNliServer() {
  const context = await loadNliContext();

  return createServer(async (request, response) => {
    setCorsHeaders(response);

    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    const url = new URL(request.url || "/", `http://${host}:${port}`);

    if (request.method === "GET" && url.pathname === "/api/nli/health") {
      sendJson(response, 200, {
        ok: true,
        targets: context.routes.targets.length,
        terms: context.glossary.terms.length,
        model: lmStudioModel,
        lmStudioTimeoutMs,
        lmStudioBaseUrl,
        lmStudioChatCompletionsUrl: buildLmStudioChatCompletionsUrl(lmStudioBaseUrl)
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/nli") {
      try {
        const body = await readRequestJson(request);
        const result = await resolveNliRequest(body.message, context);
        sendJson(response, 200, result);
      } catch {
        sendJson(response, 400, rejectResponse("요청을 처리할 수 없습니다."));
      }
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  });
}

function resolveLocally(message, context) {
  const routeMatch = findBestRoute(message, context.routes.targets);
  const termMatch = findBestTerm(message, context.glossary.terms);
  const normalizedMessage = normalize(message);

  if (termMatch && hasAny(normalizedMessage, defineWords)) {
    return defineTermResponse(termMatch.term, termMatch.score);
  }

  if (routeMatch && hasAny(normalizedMessage, summarizeWords)) {
    return summarizeSectionResponse(routeMatch.target.id, context, routeMatch.score);
  }

  if (routeMatch && (routeMatch.score >= 0.86 || hasAny(normalizedMessage, navigateWords))) {
    return navigateResponse(routeMatch.target.id, routeMatch.score);
  }

  if (termMatch && termMatch.score >= 0.9) {
    return defineTermResponse(termMatch.term, termMatch.score);
  }

  if (routeMatch) {
    return navigateResponse(routeMatch.target.id, Math.min(routeMatch.score, 0.72));
  }

  return rejectResponse("이 포트폴리오에서 이동하거나 설명할 수 있는 내용을 찾지 못했습니다.", 0);
}

function findBestRoute(message, targets) {
  const normalizedMessage = normalize(message);
  const scored = targets
    .map((target) => {
      return {
        target,
        score: routeScore(normalizedMessage, target)
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored[0] || null;
}

function routeScore(normalizedMessage, target) {
  const labelScore = keywordScore(normalizedMessage, target.label);
  const aliasScores = (target.aliases || []).map((alias) => keywordScore(normalizedMessage, alias));
  const projectScore = keywordScore(normalizedMessage, target.project) * 0.35;
  const strongScores = [labelScore, ...aliasScores].filter((score) => score > 0);
  const base = Math.max(labelScore, projectScore, ...aliasScores, 0);
  const specificityBonus = strongScores.length > 1 ? 0.12 : 0;
  const projectBonus = projectScore > 0 && strongScores.length ? 0.08 : 0;

  return Math.min(0.98, base + specificityBonus + projectBonus);
}

function findBestTerm(message, terms) {
  const normalizedMessage = normalize(message);
  const scored = terms
    .map((term) => {
      const keys = [term.term, ...(term.aliases || [])];
      return {
        term,
        score: Math.max(...keys.map((key) => keywordScore(normalizedMessage, key)))
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored[0] || null;
}

function keywordScore(normalizedMessage, keyword) {
  const normalizedKeyword = normalize(keyword);
  if (!normalizedKeyword) return 0;
  if (normalizedMessage === normalizedKeyword) return 1;
  if (normalizedMessage.includes(normalizedKeyword)) return Math.min(0.95, 0.72 + normalizedKeyword.length / 80);

  const compactMessage = compact(normalizedMessage);
  const compactKeyword = compact(normalizedKeyword);
  if (compactMessage.includes(compactKeyword)) return Math.min(0.9, 0.68 + compactKeyword.length / 90);

  return 0;
}

async function askModel(message, context) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), lmStudioTimeoutMs);
  const payload = {
    model: lmStudioModel,
    temperature: 0,
    messages: [
      { role: "system", content: context.prompt },
      { role: "system", content: buildContextBlock(context) },
      { role: "user", content: message }
    ]
  };

  try {
    const response = await fetch(buildLmStudioChatCompletionsUrl(lmStudioBaseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!response.ok) throw new Error(`LM Studio responded with ${response.status}`);

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    return parseJsonObject(content);
  } finally {
    clearTimeout(timeout);
  }
}

function guardModelResponse(modelResponse, context) {
  const validation = validateNliResponse(modelResponse, context, { allowModelAnswer: true });
  if (!validation.ok) return null;

  if (modelResponse.intent === "navigate") {
    return navigateResponse(modelResponse.targetId, modelResponse.confidence);
  }

  if (modelResponse.intent === "define_term") {
    const glossaryTerm = context.termByCanonical.get(normalize(modelResponse.term));
    return defineTermResponse(glossaryTerm, modelResponse.confidence);
  }

  if (modelResponse.intent === "summarize_section") {
    return summarizeSectionResponse(modelResponse.targetId, context, modelResponse.confidence);
  }

  return rejectResponse(modelResponse.message);
}

export function validateNliResponse(response, context, options = {}) {
  const errors = [];
  const allowModelAnswer = options.allowModelAnswer === true;

  if (!isPlainObject(response)) {
    return { ok: false, errors: ["response must be an object"] };
  }

  for (const key of Object.keys(response)) {
    if (!responseKeys.has(key)) errors.push(`unknown property: ${key}`);
  }

  if (!intentNames.has(response.intent)) errors.push("intent is invalid");
  if (typeof response.confidence !== "number" || response.confidence < 0 || response.confidence > 1) {
    errors.push("confidence must be a number between 0 and 1");
  }
  if (typeof response.message !== "string" || !response.message.trim()) {
    errors.push("message is required");
  }

  if (response.intent === "navigate") {
    validateTargetId(response.targetId, context, errors);
  }

  if (response.intent === "define_term") {
    if (typeof response.term !== "string" || !response.term.trim()) {
      errors.push("term is required");
    } else if (!context.termByCanonical.has(normalize(response.term))) {
      errors.push(`unknown term: ${response.term}`);
    }

    if (typeof response.answer !== "string" || !response.answer.trim()) {
      errors.push("answer is required for define_term");
    }

    if (response.relatedTargets !== undefined) validateTargetList(response.relatedTargets, context, errors);
  }

  if (response.intent === "summarize_section") {
    validateTargetId(response.targetId, context, errors);
    if (typeof response.answer !== "string" || !response.answer.trim()) {
      errors.push("answer is required for summarize_section");
    }
  }

  if (response.intent === "reject_out_of_scope") {
    if (!allowModelAnswer && (response.targetId || response.term || response.answer || response.relatedTargets)) {
      errors.push("reject_out_of_scope must not include targetId, term, answer, or relatedTargets");
    }
  }

  return { ok: errors.length === 0, errors };
}

function validateTargetId(targetId, context, errors) {
  if (typeof targetId !== "string" || !targetId.trim()) {
    errors.push("targetId is required");
    return;
  }

  if (!context.targetById.has(targetId)) errors.push(`unknown targetId: ${targetId}`);
}

function validateTargetList(targets, context, errors) {
  if (!Array.isArray(targets)) {
    errors.push("relatedTargets must be an array");
    return;
  }

  for (const targetId of targets) {
    if (typeof targetId !== "string" || !context.targetById.has(targetId)) {
      errors.push(`unknown related targetId: ${targetId}`);
    }
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function navigateResponse(targetId, confidence = 0.85) {
  return {
    intent: "navigate",
    confidence: clampConfidence(confidence),
    targetId,
    message: "해당 위치로 이동합니다."
  };
}

function defineTermResponse(term, confidence = 0.88) {
  return {
    intent: "define_term",
    confidence: clampConfidence(confidence),
    term: term.term,
    message: `${term.term} 용어를 설명합니다.`,
    answer: term.answer,
    relatedTargets: term.relatedTargets || []
  };
}

function summarizeSectionResponse(targetId, context, confidence = 0.84) {
  const section = context.sectionById.get(targetId);
  const target = context.targetById.get(targetId);

  if (!section || !target) return navigateResponse(targetId, confidence);

  return {
    intent: "summarize_section",
    confidence: clampConfidence(confidence),
    targetId,
    message: `${target.label} 사례를 요약합니다.`,
    answer: `${section.projectTitle}의 ${section.title} 사례입니다. ${section.result}`
  };
}

function rejectResponse(message = "이 포트폴리오의 프로젝트 이동, 프로젝트 요약, 등록된 용어 설명만 도와드릴 수 있습니다.", confidence = 1) {
  return {
    intent: "reject_out_of_scope",
    confidence: clampConfidence(confidence),
    message
  };
}

function buildContextBlock(context) {
  const routes = context.routes.targets.map((target) => ({
    id: target.id,
    label: target.label,
    aliases: target.aliases
  }));
  const terms = context.glossary.terms.map((term) => ({
    term: term.term,
    aliases: term.aliases,
    relatedTargets: term.relatedTargets
  }));

  return JSON.stringify({ routes, terms });
}

function buildLmStudioChatCompletionsUrl(baseUrl) {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/$/, "");
  url.pathname = path.endsWith("/v1") ? `${path}/chat/completions` : `${path}/v1/chat/completions`;
  return url.toString();
}

async function readPortfolioData() {
  const source = await readText("data/portfolio.js");
  const sandbox = { window: {} };
  vm.runInNewContext(source, sandbox, { filename: "data/portfolio.js" });
  return sandbox.window.PORTFOLIO_DATA;
}

async function readJson(relativePath) {
  return JSON.parse(await readText(relativePath));
}

async function readText(relativePath) {
  return readFile(resolve(root, relativePath), "utf8");
}

function normalize(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[?!.,:;()[\]{}'"`]/g, " ")
    .replace(/\s+/g, " ");
}

function compact(value) {
  return String(value || "").replace(/\s+/g, "");
}

function hasAny(message, words) {
  return words.some((word) => message.includes(normalize(word)));
}

function clampConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0.8;
  return Math.max(0, Math.min(1, number));
}

function parseJsonObject(content) {
  if (!content) return null;
  try {
    return JSON.parse(content);
  } catch {
    const match = String(content).match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  }
}

async function readRequestJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks).toString("utf8");
  return rawBody ? JSON.parse(rawBody) : {};
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(body));
}

function setCorsHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await createNliServer();
  server.listen(port, host, () => {
    console.log(`NLI gateway listening at http://${host}:${port}`);
    console.log(`LM Studio endpoint: ${lmStudioBaseUrl}`);
    console.log(`LM Studio model: ${lmStudioModel}`);
  });
}
