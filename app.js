import { createNliWidget } from "./nli-widget.js";

const data = window.PORTFOLIO_DATA;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const toneMap = {
  blue: "var(--blue)",
  amber: "var(--amber)",
  red: "var(--red)"
};
const focusSet = ["All", ...new Set(data.projects.flatMap((project) => project.focus))];
let currentFilter = "All";

function escapeText(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function safeHref(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = new URL(value, window.location.href);
    return ["http:", "https:", "mailto:", "tel:"].includes(url.protocol) ? escapeText(value) : "";
  } catch {
    return "";
  }
}

function renderLink(label, href, className = "") {
  const safe = safeHref(href);
  if (!safe) return `<span>${escapeText(label)}</span>`;
  const external = /^https?:/i.test(href);
  return `<a class="${className}" href="${safe}"${external ? ' target="_blank" rel="noreferrer"' : ""}>${escapeText(label)}${external ? ' <span aria-hidden="true">↗</span>' : ""}</a>`;
}

function initProfile() {
  $("[data-profile-summary]").textContent = data.profile.summary;
  $("[data-profile-role]").textContent = data.profile.role;
  $("[data-profile-name]").textContent = `${data.profile.name} (${data.profile.englishName})`;
  $("[data-profile-headline]").textContent = data.profile.headline;

  const contactList = $("[data-contact-list]");
  contactList.innerHTML = data.profile.contacts
    .map((contact) => {
      const value = contact.href ? renderLink(contact.value, contact.href) : escapeText(contact.value);
      return `<div><dt>${escapeText(contact.label)}</dt><dd>${value}</dd></div>`;
    })
    .join("");
}

function initMetrics() {
  const metricGrid = $("[data-metric-grid]");
  metricGrid.innerHTML = data.metrics
    .map(
      (metric) => `
        <article class="metric-card" style="--accent: ${toneMap[metric.tone] || toneMap.blue}">
          <button type="button" data-scroll-target="${escapeText(metric.target)}">
            <span class="metric-label">${escapeText(metric.label)}</span>
            <span class="metric-value">${escapeText(metric.value)}</span>
            <span class="metric-caption">${escapeText(metric.caption)}</span>
            <span class="metric-more">사례에서 확인 <span aria-hidden="true">↗</span></span>
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
        <button type="button" class="${focus === currentFilter ? "is-active" : ""}" data-filter="${escapeText(focus)}" aria-pressed="${focus === currentFilter}">
          ${focus === "All" ? "전체" : escapeText(focus)}
        </button>
      `
    )
    .join("");
}

function initProjectOverview() {
  $("[data-project-overview]").innerHTML = data.projects.map((project, index) => `
    <article class="overview-card">
      <div class="overview-topline"><span class="overview-number">0${index + 1}</span><span>${escapeText(project.period)}</span></div>
      <h3>${escapeText(project.title)}</h3>
      <p>${escapeText(project.description)}</p>
      <div class="overview-focus">${project.focus.map((focus) => `<span>${escapeText(focus)}</span>`).join("")}</div>
      <button type="button" data-scroll-target="project-${escapeText(project.id)}">${project.sections.length}개 문제 해결 사례 <span aria-hidden="true">↗</span></button>
    </article>
  `).join("");
}

function renderProjectMetadata(metadata = []) {
  if (!metadata.length) return "";
  return `<dl class="project-metadata">${metadata.map((item) => `<div><dt>${escapeText(item.label)}</dt><dd>${escapeText(item.value)}</dd></div>`).join("")}</dl>`;
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
        <article class="project-card" id="project-${escapeText(project.id)}" data-project-card>
          <div class="project-top">
            <div>
              <div class="project-title-row">
                <h3>${escapeText(project.title)}</h3>
                <span class="period-pill">${escapeText(project.period)}</span>
              </div>
              <p class="project-description">${escapeText(project.description)}</p>
              ${renderProjectMetadata(project.metadata)}
              <div class="project-links">${(project.links || []).map((link) => renderLink(link.label, link.href, "text-link")).join("")}</div>
              <div class="project-chip-rows">
                <div class="tag-row" aria-label="${escapeText(project.title)} 기술 스택">
                  ${project.tags.map((tag) => `<span>${escapeText(tag)}</span>`).join("")}
                </div>
                <div class="focus-row" aria-label="${escapeText(project.title)} 주요 영역">
                  ${project.focus.map((focus) => `<span>${escapeText(focus)}</span>`).join("")}
                </div>
              </div>
            </div>
          </div>
          <div class="project-sections">
            ${project.sections.map((section, index) => renderCaseBlock(section, index)).join("")}
          </div>
        </article>
      `
    )
    .join("");
}

function renderCaseBlock(section, index) {
  const layoutClass = section.imageLayout === "stacked" ? "has-stacked-images" : "";
  const resultItems = Array.isArray(section.resultDetails) ? section.resultDetails : section.resultDetails ? [section.resultDetails] : [];
  const additionalResults = resultItems.filter((item) => !String(section.result || "").includes(String(item).trim()));

  return `
    <section class="case-block ${layoutClass}" id="${escapeText(section.id)}" data-case-block>
      <div class="case-heading">
        <p class="case-number">CASE 0${index + 1}</p>
        <h4>${escapeText(section.title)}</h4>
      </div>
      <div>
        <p class="case-result"><span class="case-result-label">결과</span>${escapeText(section.result)}</p>
        <div class="case-copy">
          ${renderCaseStep("문제", section.problem)}
          ${renderCaseStep("분석", section.analyze)}
          ${renderCaseStep("행동", section.action)}
          ${renderCaseStep("결과", additionalResults)}
        </div>
        ${renderCaseTables(section.tables)}
        ${renderCaseImages(section.images, section.imageLayout)}
        ${renderCaseExamples(section.examples)}
        ${renderMeasurementNotes(section.measurementNotes)}
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
        ${items.map((item) => `<li>${escapeText(item)}</li>`).join("")}
      </ul>
    </div>
  `;
}

function renderMeasurementNotes(notes = []) {
  if (!notes.length) return "";
  return `<aside class="measurement-notes" aria-label="검증 조건과 한계"><h5>검증 조건과 한계</h5><ul>${notes.map((note) => `<li>${escapeText(note)}</li>`).join("")}</ul></aside>`;
}

function renderCaseExamples(examples = []) {
  if (!examples.length) return "";
  return `<div class="case-examples"><h5>실제 출력 예시</h5><ol>${examples.map((example) => `<li>${escapeText(example)}</li>`).join("")}</ol></div>`;
}

function renderCaseTables(tables = []) {
  if (!tables.length) return "";

  return `
    <div class="case-tables">
      ${tables
        .map(
          (table) => `
            <figure class="case-table">
              <figcaption>${escapeText(table.caption)}</figcaption>
              <div class="table-scroll" tabindex="0" role="region" aria-label="${escapeText(table.caption)} · 가로 스크롤 가능">
                <table>
                  <thead>
                    <tr>
                      ${table.headers.map((header) => `<th scope="col">${escapeText(header)}</th>`).join("")}
                    </tr>
                  </thead>
                  <tbody>
                    ${table.rows
                      .map(
                        (row) => `
                          <tr>
                            ${row.map((cell) => `<td>${escapeText(cell)}</td>`).join("")}
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
              <img src="${safeHref(image.src)}" alt="${escapeText(image.alt)}" ${Number.isSafeInteger(image.width) && image.width > 0 && Number.isSafeInteger(image.height) && image.height > 0 ? `width="${image.width}" height="${image.height}"` : ""} loading="lazy" />
              <figcaption>${escapeText(image.alt)}</figcaption>
            </figure>
          `
        )
        .join("")}
    </div>
  `;
}

function initExperience() {
  const experience = data.experience;
  if (!experience) return;
  const mentoring = experience.mentoring;
  const lists = [
    ["학력·교육", experience.education],
    ["수상", experience.awards],
    ["자격", experience.certifications]
  ];
  $("[data-experience]").innerHTML = `
    <div class="experience-grid">
      ${mentoring ? `<article class="experience-card"><p class="eyebrow">Mentoring</p><h3>${escapeText(mentoring.title)}</h3><p class="experience-period">${escapeText(mentoring.period)}</p><p>${escapeText(mentoring.summary)}</p>${mentoring.href ? renderLink("멘토링 자료", mentoring.href, "text-link") : ""}</article>` : ""}
      <article class="experience-card"><p class="eyebrow">Personal Tools</p><h3>필요한 도구를 직접 만듭니다</h3><ul class="tool-list">${(experience.tools || []).map((tool) => `<li><h4>${renderLink(tool.title, tool.href, "text-link")}</h4><p>${escapeText(tool.summary)}</p></li>`).join("")}</ul></article>
    </div>
    <div class="credential-grid">${lists.filter(([, items]) => items?.length).map(([title, items]) => `<article class="credential-card"><h3>${title}</h3><ul>${items.map((item) => `<li><strong>${escapeText(item.title)}</strong><span>${escapeText(item.period)}</span>${item.href ? renderLink("관련 자료", item.href, "text-link") : ""}</li>`).join("")}</ul></article>`).join("")}</div>
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
  initProjectOverview();
  initFilters();
  renderProjects();
  initExperience();
  nliWidget.init();
  bindEvents();
}

init();
