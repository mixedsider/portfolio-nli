const data = window.PORTFOLIO_DATA;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const toneMap = {
  green: "var(--green)",
  blue: "var(--blue)",
  amber: "var(--amber)",
  red: "var(--red)"
};

const nliEndpoint = "http://127.0.0.1:8787/api/nli";
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

  target.scrollIntoView({ behavior: "smooth", block: "start" });
  return true;
}

function setNliStatus(message) {
  const status = $("[data-nli-status]");
  if (!status) return;

  status.textContent = message || "";
}

function setNliPending(isPending) {
  const form = $("[data-nli-form]");
  const input = $("[data-nli-input]");
  const submit = $("[data-nli-submit]");

  if (form) form.classList.toggle("is-pending", isPending);
  if (input) input.disabled = isPending;
  if (submit) submit.disabled = isPending;
}

async function requestNli(message) {
  const response = await fetch(nliEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message })
  });

  if (!response.ok) throw new Error("NLI request failed");
  return response.json();
}

function handleNliResult(result) {
  if (!result || result.intent === "reject_out_of_scope") {
    setNliStatus(result?.message || "포트폴리오 안에서 찾을 수 있는 내용만 이동할 수 있습니다.");
    return;
  }

  if (result.intent === "define_term") {
    setNliStatus(result.answer || result.message);
    return;
  }

  if (result.targetId) {
    const moved = scrollToTarget(result.targetId);
    setNliStatus(moved ? result.answer || result.message : "해당 위치를 찾지 못했습니다.");
    return;
  }

  setNliStatus(result.message || "");
}

async function handleNliSubmit(event) {
  event.preventDefault();

  const input = $("[data-nli-input]");
  const message = input?.value.trim();

  if (!message) {
    setNliStatus("찾을 내용을 입력해주세요.");
    return;
  }

  setNliPending(true);
  setNliStatus("찾는 중입니다.");

  try {
    const result = await requestNli(message);
    handleNliResult(result);
  } catch {
    setNliStatus("NLI Gateway에 연결할 수 없습니다. Gateway가 켜져 있는지 확인해주세요.");
  } finally {
    setNliPending(false);
    input?.focus();
  }
}

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
  if (nliForm) nliForm.addEventListener("submit", handleNliSubmit);
}

function init() {
  initProfile();
  initMetrics();
  initFilters();
  renderProjects();
  bindEvents();
}

init();
