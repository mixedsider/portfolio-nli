import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import vm from "node:vm";

import { normalize } from "./text.mjs";

const MAX_GROUNDED_CANDIDATES = 8;
const MAX_GROUNDED_HISTORY_ITEMS = 6;
const MAX_GROUNDED_HISTORY_ENTRY_BYTES = 480;
const MAX_GROUNDED_HISTORY_BYTES = 2_400;
const MAX_GROUNDED_CARD_EVIDENCE_BYTES = 3_000;
const MAX_GROUNDED_TARGETS = 64;
const MAX_GROUNDED_TERMS = 64;
const MAX_GROUNDED_ALIASES = 12;

export async function loadNliContext(root) {
  const [routes, glossary, prompt, portfolio] = await Promise.all([
    readJson(root, "nli/routes.json"),
    readJson(root, "nli/glossary.json"),
    readText(root, "nli/system-prompt.md"),
    readPortfolioData(root)
  ]);

  assertPortfolioShape(portfolio);

  return {
    routes,
    glossary,
    prompt,
    portfolio,
    targetById: new Map(routes.targets.map((target) => [target.id, target])),
    sectionById: new Map(
      portfolio.projects.flatMap((project) =>
        project.sections.map((section) => [
          section.id,
          {
            ...section,
            projectTitle: project.title
          }
        ])
      )
    ),
    projectByTargetId: new Map(portfolio.projects.map((project) => [`project-${project.id}`, project])),
    termByCanonical: new Map(glossary.terms.map((term) => [normalize(term.term), term]))
  };
}

export function buildContextBlock(context) {
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
  const projects = context.portfolio.projects.map((project) => ({
    id: `project-${project.id}`,
    title: project.title,
    description: project.description,
    tags: project.tags,
    focus: project.focus,
    sections: project.sections.map((section) => ({ id: section.id, title: section.title, result: section.result }))
  }));

  return JSON.stringify({ profile: context.portfolio.profile, metrics: context.portfolio.metrics, routes, terms, projects });
}

export function buildGroundedRequestBlock(request = {}) {
  return JSON.stringify({
    untrustedData: true,
    currentTargetId: boundedString(request.currentTargetId, 128) || null,
    conversation: boundedConversation(request.history),
    candidateSources: boundedCandidateSources(request.candidateSources),
    targets: boundedTargets(request.targets),
    terms: boundedTerms(request.terms)
  });
}

async function readPortfolioData(root) {
  const source = await readText(root, "data/portfolio.js");
  // This repository-owned data file is not user input. The null-prototype context
  // narrows accidental host access, but is not a security boundary for untrusted code.
  const sandbox = Object.create(null);
  sandbox.window = Object.create(null);
  vm.runInNewContext(source, sandbox, {
    filename: "data/portfolio.js",
    timeout: 1_000,
    codeGeneration: { strings: false, wasm: false }
  });
  return sandbox.window.PORTFOLIO_DATA;
}

async function readJson(root, relativePath) {
  return JSON.parse(await readText(root, relativePath));
}

function readText(root, relativePath) {
  return readFile(resolve(root, relativePath), "utf8");
}

function assertPortfolioShape(portfolio) {
  if (!portfolio || !Array.isArray(portfolio.projects) || !portfolio.profile || !Array.isArray(portfolio.metrics)) {
    throw new Error("data/portfolio.js must expose a valid PORTFOLIO_DATA object");
  }
}

function boundedCandidateSources(value) {
  if (!Array.isArray(value)) return [];

  const candidates = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") continue;
    const targetId = boundedString(candidate.targetId || candidate.id, 128);
    if (!targetId || candidates.some((item) => item.id === targetId)) continue;
    candidates.push({
      id: targetId,
      targetId,
      label: boundedString(candidate.label, 256),
      type: boundedString(candidate.type, 64),
      evidence: boundedUtf8String(candidate.evidence, MAX_GROUNDED_CARD_EVIDENCE_BYTES)
    });
    if (candidates.length === MAX_GROUNDED_CANDIDATES) break;
  }
  return candidates;
}

function boundedTargets(value) {
  if (!Array.isArray(value)) return [];

  const targets = [];
  for (const target of value) {
    if (!target || typeof target !== "object") continue;
    const id = boundedString(target.id, 128);
    if (!id || targets.some((item) => item.id === id)) continue;
    targets.push({
      id,
      label: boundedString(target.label, 256),
      type: boundedString(target.type, 64),
      aliases: boundedAliases(target.aliases)
    });
    if (targets.length === MAX_GROUNDED_TARGETS) break;
  }
  return targets;
}

function boundedTerms(value) {
  if (!Array.isArray(value)) return [];

  const terms = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const term = boundedString(entry.term, 128);
    if (!term || terms.some((item) => item.term === term)) continue;
    terms.push({ term, aliases: boundedAliases(entry.aliases) });
    if (terms.length === MAX_GROUNDED_TERMS) break;
  }
  return terms;
}

function boundedAliases(value) {
  if (!Array.isArray(value)) return [];
  const aliases = [];
  for (const alias of value) {
    const text = boundedString(alias, 128);
    if (!text || aliases.includes(text)) continue;
    aliases.push(text);
    if (aliases.length === MAX_GROUNDED_ALIASES) break;
  }
  return aliases;
}

function boundedConversation(value) {
  if (!Array.isArray(value)) return [];

  const selected = value.slice(-MAX_GROUNDED_HISTORY_ITEMS);
  const conversation = [];
  let remainingBytes = MAX_GROUNDED_HISTORY_BYTES;
  for (const entry of selected) {
    if (!entry || typeof entry !== "object" || !["user", "assistant"].includes(entry.role)) continue;
    const text = boundedUtf8String(entry.text, Math.min(MAX_GROUNDED_HISTORY_ENTRY_BYTES, remainingBytes));
    if (!text) continue;
    conversation.push({ role: entry.role, text });
    remainingBytes -= Buffer.byteLength(text, "utf8");
    if (remainingBytes <= 0) break;
  }
  return conversation;
}

function boundedString(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function boundedUtf8String(value, maxBytes) {
  if (typeof value !== "string" || maxBytes <= 0) return "";
  let result = "";
  let usedBytes = 0;
  for (const character of value.trim()) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (usedBytes + characterBytes > maxBytes) break;
    result += character;
    usedBytes += characterBytes;
  }
  return result;
}
