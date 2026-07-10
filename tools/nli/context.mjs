import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import vm from "node:vm";

import { normalize } from "./text.mjs";

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

async function readPortfolioData(root) {
  const source = await readText(root, "data/portfolio.js");
  const sandbox = { window: {} };
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
