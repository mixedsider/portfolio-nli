import { createNliWidget } from "./nli-widget.js";

const data = window.PORTFOLIO_DATA;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const toneMap = {
  green: "var(--green)",
  blue: "var(--blue)",
  amber: "var(--amber)",
  red: "var(--red)"
};
const focusSet = ["All", ...new Set(data.projects.flatMap((project) => project.focus))];
let currentFilter = "All";

function initProfile() {
  $("[data-profile-summary]").textContent = data.profile.summary;
  $("[data-profile-role]").textContent = data.profile.role;
  $("[data-profile-name]").textContent = `${data.profile.name} (${data.profile.englishName})`;
  $("[data-profile-headline]").textContent = data.profile.headline;

  const contactList = $("[data-contact-list]");
  contactList.innerHTML = data.profile.contacts
    .map((contact) => {
      const value = contact.href
        ? `<a href="${contact.href}" target="${contact.href.startsWith("http") ? "_blank" : "_self"}" rel="noreferrer">${contact.value}</a>`
        : contact.value;
      return `<div><dt>${contact.label}</dt><dd>${value}</dd></div>`;
    })
    .join("");
}

function initMetrics() {
  const metricGrid = $("[data-metric-grid]");
  metricGrid.innerHTML = data.metrics
    .map(
      (metric) => `
        <article class="metric-card" style="--accent: ${toneMap[metric.tone] || toneMap.green}">
          <button type="button" data-scroll-target="${metric.target}">
            <span class="metric-label">${metric.label}</span>
            <span class="metric-value">${metric.value}</span>
            <span class="metric-caption">${metric.caption}</span>
          </button>
        </article>
      `
    )
    .join("");
}

function initFilters() {
  const filterTabs = $("[data-filter-tabs]");
  filterTabs.innerHTML = focusSet
    .map(
      (focus) => `
        <button type="button" class="${focus === currentFilter ? "is-active" : ""}" data-filter="${focus}">
          ${focus}
        </button>
      `
    )
    .join("");
}

function renderProjects() {
  const projectList = $("[data-project-list]");
  const filteredProjects =
    currentFilter === "All"
      ? data.projects
      : data.projects.filter((project) => project.focus.includes(currentFilter));

  projectList.innerHTML = filteredProjects
    .map(
      (project) => `
        <article class="project-card" id="project-${project.id}" data-project-card>
          <div class="project-top">
            <div>
              <div class="project-title-row">
                <h3>${project.title}</h3>
                <span class="period-pill">${project.period}</span>
              </div>
              <p class="project-description">${project.description}</p>
              <div class="project-chip-rows">
                <div class="tag-row" aria-label="${project.title} 기술 스택">
                  ${project.tags.map((tag) => `<span>${tag}</span>`).join("")}
                </div>
                <div class="focus-row" aria-label="${project.title} 주요 영역">
                  ${project.focus.map((focus) => `<span>${focus}</span>`).join("")}
                </div>
              </div>
            </div>
          </div>
          <div class="project-sections">
            ${project.sections.map(renderCaseBlock).join("")}
          </div>
        </article>
      `
    )
    .join("");
}

function renderCaseBlock(section) {
  const layoutClass = section.imageLayout === "stacked" ? "has-stacked-images" : "";

  return `
    <section class="case-block ${layoutClass}" id="${section.id}" data-case-block>
      <div>
        <h4>${section.title}</h4>
      </div>
      <div>
        <p class="case-result">${section.result}</p>
        <div class="case-copy">
          ${renderCaseStep("Problem", section.problem)}
          ${renderCaseStep("Analyze", section.analyze)}
          ${renderCaseStep("Action", section.action)}
          ${renderCaseStep("Result", section.resultDetails)}
        </div>
        ${renderCaseTables(section.tables)}
        ${renderCaseImages(section.images, section.imageLayout)}
      </div>
    </section>
  `;
}

function renderCaseStep(label, content) {
  const items = Array.isArray(content) ? content : content ? [content] : [];
  if (!items.length) return "";

  return `
    <div class="case-step">
      <strong>${label}</strong>
      <ul>
        ${items.map((item) => `<li>${item}</li>`).join("")}
      </ul>
    </div>
  `;
}

function renderCaseTables(tables = []) {
  if (!tables.length) return "";

  return `
    <div class="case-tables">
      ${tables
        .map(
          (table) => `
            <figure class="case-table">
              <figcaption>${table.caption}</figcaption>
              <div class="table-scroll">
                <table>
                  <thead>
                    <tr>
                      ${table.headers.map((header) => `<th scope="col">${header}</th>`).join("")}
                    </tr>
                  </thead>
                  <tbody>
                    ${table.rows
                      .map(
                        (row) => `
                          <tr>
                            ${row.map((cell) => `<td>${cell}</td>`).join("")}
                          </tr>
                        `
                      )
                      .join("")}
                  </tbody>
                </table>
              </div>
            </figure>
          `
        )
        .join("")}
    </div>
  `;
}

function renderCaseImages(images = [], layout = "grid") {
  if (!images.length) return "";

  return `
    <div class="case-images ${layout === "stacked" ? "is-stacked" : ""}">
      ${images
        .map(
          (image) => `
            <figure>
              <img src="${image.src}" alt="${image.alt}" loading="lazy" />
              <figcaption>${image.alt}</figcaption>
            </figure>
          `
        )
        .join("")}
    </div>
  `;
}

function scrollToTarget(targetId) {
  let target = document.getElementById(targetId);

  if (!target && currentFilter !== "All") {
    currentFilter = "All";
    initFilters();
    renderProjects();
    target = document.getElementById(targetId);
  }
  if (!target) return false;

  $$(".project-card").forEach((card) => card.classList.remove("is-highlighted"));
  const parentCard = target.closest("[data-project-card]");
  if (parentCard) parentCard.classList.add("is-highlighted");

  const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView({ behavior: prefersReducedMotion ? "auto" : "smooth", block: "start" });
  return true;
}

function getCurrentProjectTargetId() {
  const projectCards = $$("[data-project-card]");
  let bestCard = null;
  let bestVisibleArea = 0;

  for (const card of projectCards) {
    const rect = card.getBoundingClientRect();
    const visibleWidth = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
    const visibleHeight = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
    const visibleArea = visibleWidth * visibleHeight;
    if (visibleArea > bestVisibleArea) {
      bestVisibleArea = visibleArea;
      bestCard = card;
    }
  }

  return bestVisibleArea > 0 ? bestCard?.id || null : null;
}

const nliWidget = createNliWidget({ getCurrentTargetId: getCurrentProjectTargetId, navigateToTarget: scrollToTarget });

function bindEvents() {
  document.addEventListener("click", (event) => {
    const scrollButton = event.target.closest("[data-scroll-target]");
    if (scrollButton) {
      scrollToTarget(scrollButton.dataset.scrollTarget);
      return;
    }

    const filterButton = event.target.closest("[data-filter]");
    if (filterButton) {
      currentFilter = filterButton.dataset.filter;
      initFilters();
      renderProjects();
    }
  });

  const nliForm = $("[data-nli-form]");
  if (nliForm) nliForm.addEventListener("submit", nliWidget.handleSubmit);
  $("[data-nli-open]")?.addEventListener("click", () => nliWidget.setOpen(true));
  $("[data-nli-close]")?.addEventListener("click", () => nliWidget.setOpen(false));
  $("[data-nli-minimize]")?.addEventListener("click", nliWidget.toggleMinimized);
  $("[data-nli-clear]")?.addEventListener("click", nliWidget.clearMessages);
}

function init() {
  initProfile();
  initMetrics();
  initFilters();
  renderProjects();
  nliWidget.init();
  bindEvents();
}

init();
