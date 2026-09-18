import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import vm from "node:vm";

import { normalize } from "./text.mjs";
import { boundedCandidateSources, boundedConversation, boundedString } from "./grounded-bounds.mjs";

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
