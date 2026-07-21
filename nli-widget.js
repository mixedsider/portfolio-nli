import { createNliMessage, getNliRequestHistory, loadNliMessages, nliWelcomeText, normalizeNliSources, saveNliMessages } from "./nli-history.js";

const defaultEndpoint = "https://portfolio-nli-gateway.mixedsider.cloud/api/nli";

export function createNliWidget({
  documentRoot = document,
  windowRef = window,
  endpoint = defaultEndpoint,
  getCurrentTargetId,
  navigateToTarget
}) {
  const select = (selector) => documentRoot.querySelector(selector);
  let messages = [];
  let delayTimers = [];

  function setPending(isPending) {
    const form = select("[data-nli-form]");
    const input = select("[data-nli-input]");
    const submit = select("[data-nli-submit]");
    form?.classList.toggle("is-pending", isPending);
    if (input) input.disabled = isPending;
    if (submit) submit.disabled = isPending;
  }

  function renderMessages() {
    const messageList = select("[data-nli-messages]");
    if (!messageList) return;

    messageList.replaceChildren();
    for (const message of messages) messageList.append(renderMessage(message));
    messageList.scrollTop = messageList.scrollHeight;
  }

  function renderMessage(message) {
    const item = documentRoot.createElement("div");
    item.className = `nli-message is-${message.role}${message.isPending ? " is-pending" : ""}`;

    const label = documentRoot.createElement("span");
    label.className = "nli-message-label";
    label.textContent = message.role === "user" ? "나" : "도우미";

    const bubble = documentRoot.createElement("p");
    bubble.textContent = message.text;
    item.append(label, bubble);

    if (message.sources.length) item.append(renderSources(message.sources));
    if (message.isPending) item.append(renderTypingIndicator());
    return item;
  }

  function renderSources(sources) {
    const group = documentRoot.createElement("div");
    group.className = "nli-message-sources";
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", "답변 근거 위치");

    for (const source of sources) {
      const button = documentRoot.createElement("button");
      button.type = "button";
      button.dataset.scrollTarget = source.id;
      button.textContent = source.label;
      group.append(button);
    }

    return group;
  }

  function renderTypingIndicator() {
    const dots = documentRoot.createElement("span");
    dots.className = "nli-typing";
    dots.setAttribute("aria-hidden", "true");
    for (let index = 0; index < 3; index += 1) dots.append(documentRoot.createElement("i"));
    return dots;
  }

  function appendMessage(role, text, options = {}) {
    const message = createNliMessage(role, text, options);
    messages = [...messages, message].slice(-30);
    if (!message.isPending) saveMessages();
    renderMessages();
    return message.id;
  }

  function updateMessage(id, text, options = {}) {
    messages = messages.map((message) =>
      message.id === id
        ? { ...message, text, sources: normalizeNliSources(options.sources), isPending: options.isPending === true }
        : message
    );
    saveMessages();
    renderMessages();
  }

  function saveMessages() {
    saveNliMessages(windowRef.localStorage, messages);
  }

  function clearDelayTimers() {
    for (const timer of delayTimers) windowRef.clearTimeout(timer);
    delayTimers = [];
  }

  function setOpen(isOpen) {
    const widget = select("[data-nli-widget]");
    const openButton = select("[data-nli-open]");
    const input = select("[data-nli-input]");
    if (!widget || !openButton) return;

    widget.classList.toggle("is-collapsed", !isOpen);
    widget.classList.remove("is-minimized");
    openButton.setAttribute("aria-expanded", String(isOpen));
    if (isOpen) {
      renderMessages();
      windowRef.setTimeout(() => input?.focus(), 0);
    }
  }

  function toggleMinimized() {
    const widget = select("[data-nli-widget]");
    if (!widget || widget.classList.contains("is-collapsed")) return;
    widget.classList.toggle("is-minimized");
  }

  async function request(message, history) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, history, currentTargetId: getCurrentTargetId() })
    });
    if (!response.ok) throw new Error("NLI request failed");
    return response.json();
  }

  function getResult(result) {
    if (!result || result.intent === "reject_out_of_scope") {
      return { text: result?.message || "포트폴리오 안에서 찾을 수 있는 내용만 이동하거나 설명할 수 있습니다.", sources: [] };
    }

    const shouldMove = ["navigate", "summarize_project", "summarize_section"].includes(result.intent);
    if (result.targetId && shouldMove && !navigateToTarget(result.targetId)) {
      return { text: "해당 위치를 찾지 못했습니다.", sources: [] };
    }

    return {
      text: result.answer || result.message || "요청을 처리했습니다.",
      sources: result.intent === "answer_portfolio" ? normalizeNliSources(result.sources) : []
    };
  }

  async function handleSubmit(event) {
    event.preventDefault();
    const input = select("[data-nli-input]");
    const message = input?.value.trim();
    if (!message) {
      appendMessage("assistant", "찾을 내용을 입력해주세요.");
      return;
    }

    input.value = "";
    const history = getNliRequestHistory(messages);
    appendMessage("user", message);
    const pendingId = appendMessage("assistant", "찾는 중입니다.", { isPending: true });
    setPending(true);
    clearDelayTimers();
    delayTimers = [
      windowRef.setTimeout(() => updateMessage(pendingId, "조금만 기다려주세요. 포트폴리오 내용을 확인하고 있어요.", { isPending: true }), 3000),
      windowRef.setTimeout(() => updateMessage(pendingId, "로컬 LLM 응답을 기다리고 있습니다.", { isPending: true }), 8000)
    ];

    try {
      const answer = getResult(await request(message, history));
      updateMessage(pendingId, answer.text, { sources: answer.sources });
    } catch {
      updateMessage(pendingId, "도우미 Gateway에 연결할 수 없습니다. Gateway가 켜져 있는지 확인해주세요.");
    } finally {
      clearDelayTimers();
      setPending(false);
      input?.focus();
    }
  }

  function init() {
    messages = loadNliMessages(windowRef.localStorage);
    saveMessages();
    renderMessages();
  }

  function clearMessages() {
    messages = [createNliMessage("assistant", nliWelcomeText, { isUiOnly: true })];
    saveMessages();
    renderMessages();
  }

  return { clearMessages, handleSubmit, init, setOpen, toggleMinimized };
}
