# Portfolio NLI Existing Design Contract

This is an extraction of the current portfolio surface, not a redesign. It records the visual and interaction contract that exists in `styles.css`, `index.html`, and `app.js` as of 2026-07-19. Later NLI work should preserve this compact, fixed command-panel language unless a separately approved change updates this file.

## 1. Atmosphere & Identity

The portfolio is a light, technical editorial surface: a pale grid background, nearly-black ink, thin green-tinted lines, and restrained green/blue accents. The NLI is not a modal or full chat page. It is a compact command panel that stays anchored to the lower-left corner, using a dark launcher and a bright, softly translucent panel. Its signature is mixed depth: quiet one-pixel separations inside a panel that is lifted with one deliberate soft shadow.

Keep the NLI compact and utilitarian. Do not introduce a new visual language, decorative gradients, oversized rounded corners, or a separate chat-card treatment.

## 2. Color

### Existing root tokens

| Token | Existing value | Current use |
| --- | --- | --- |
| `--bg` | `#f6f7f3` | Page background; start of the NLI message-area gradient. |
| `--surface` | `#ffffff` | Cards, NLI header/form, assistant bubbles. |
| `--surface-strong` | `#ecf1ed` | NLI action controls and input fill. |
| `--ink` | `#16201e` | NLI launcher, submit button, user bubble, primary text. |
| `--muted` | `#63706b` | Message labels and pending message text. |
| `--line` | `#d9dfdb` | Panel dividers, assistant bubble border, form/action-control borders. |
| `--green` | `#1f7a55` | NLI kicker, input focus treatment, typing dots. |
| `--blue` | `#276a9f` | Existing portfolio accent; not currently an NLI state color. |
| `--amber` | `#b96b18` | Existing portfolio accent; not currently an NLI state color. |
| `--red` | `#b94444` | Existing portfolio accent; not currently used by NLI errors. |

### Existing NLI composites and direct values

- Panel background: `rgba(255, 255, 255, 0.96)` over `backdrop-filter: blur(18px)`.
- Message-area background: `linear-gradient(180deg, rgba(246, 247, 243, 0.72), rgba(255, 255, 255, 0.96))`.
- Launcher border/shadow: `rgba(22, 32, 30, 0.16)` and `0 18px 55px rgba(22, 32, 30, 0.18)`.
- Panel border/shadow: `rgba(22, 32, 30, 0.14)` and the same `0 18px 55px rgba(22, 32, 30, 0.18)`.
- Launcher’s inner `strong` block: `rgba(255, 255, 255, 0.14)`.
- Assistant bubble text uses the existing direct value `#34413d`; this is an existing exception, not a newly named token.
- Input focus uses `rgba(31, 122, 85, 0.32)` as a two-pixel inset ring.

### Color rules

- NLI additions must consume the existing variables/composites above; do not add a raw source-chip, hover, loading, or error color.
- A gateway failure is currently text-only inside an assistant bubble. It does not turn red and does not have a separate error surface.
- Do not repurpose `--red` merely because an error is present; that would change the current contract.

## 3. Typography

### Font family

The whole site, including NLI, uses:

`Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans KR", sans-serif`

The global base is `16px` with `line-height: 1.6`; `word-break: keep-all` and `overflow-wrap: break-word` support Korean prose.

### NLI scale (observed in Chrome and defined in CSS)

| Element | Size | Weight | Line height | Notes |
| --- | --- | --- | --- | --- |
| Launcher text | `16px` | `800` on the label span | global `1.6` | Dark launcher label. |
| Launcher badge (`strong`) | `0.92rem` / `14.72px` | computed `700` | global `1.6` | Small, boxed “도우미” marker. |
| Panel kicker | `0.72rem` / `11.52px` | `800` | global `1.6` | Green and uppercase. |
| Panel heading | `1.02rem` / `16.32px` | computed `700` | `1.25` | Short panel question. |
| Header action button | `0.78rem` / `12.48px` | `800` | global `1.6` | Clear/minimize/close controls. |
| Message role label | `0.74rem` / `11.84px` | `800` | global `1.6` | “나” / “도우미”. |
| Message bubble | `0.92rem` / `14.72px` | `400` | `1.55` | Uses `white-space: pre-wrap`. |
| Input | `16px` | `400` | global `1.6` | Native `type="search"`. |
| Submit button | `16px` | `800` | global `1.6` | Compact dark action. |

No NLI letter-spacing is authored. Preserve the Korean-capable font stack and do not add a display or mono face for this widget.

## 4. Spacing & Layout

### Existing 4px basis and real exceptions

The stylesheet does not currently define `--space-*` variables. Its reusable rhythm is nevertheless anchored on 4px steps (`4`, `8`, `12`, `16`, `24`, `32`), while the existing NLI intentionally contains 2px-derived fit-and-finish exceptions (`6`, `10`, `14`, `18`, `22`, `34`, `38`, `42`, `54`, `58`, `72`). Do not normalize those values during feature work; this is a documentation extraction, not a spacing refactor.

| Existing value | Current NLI use |
| --- | --- |
| `4px` | Typing-indicator gap; small label/bubble separation. |
| `6px` | Header-action gap; action/input radius (`8px - 2px`). |
| `8px` | Form gap and padding; standard panel radius. |
| `10px` / `12px` | Launcher gap; bubble padding; message stack gap. |
| `14px` / `16px` | Mobile panel offset/header inset; message padding. |
| `22px` | Desktop fixed offset. |
| `34px` / `42px` | Action-control and input/submit minimum heights. |
| `54px` / `58px` | Mobile/desktop launcher minimum height. |
| `72px` | Header minimum height. |

For a later NLI addition, begin from the existing 4px rhythm and borrow the precise nearby component values instead of introducing another spacing scale.

### Command-panel geometry

- The root is fixed at `left: 22px; bottom: 22px; z-index: 30`.
- Default open geometry: `width: min(470px, calc(100% - 44px))`, `height: min(520px, calc(100svh - 110px))`, `min-width: 360px`, `min-height: 390px`, plus the matching maximums.
- While open, the root has `resize: both`, `overflow: hidden`, and restored pointer events. While collapsed it becomes auto-sized and only the launcher is visible.
- The panel is a two-row grid: header (`auto`) and body (`minmax(0, 1fr)`). The body is a two-row grid: scrollable messages and auto-sized form.
- Message bubbles cap at `88%` width; assistant bubbles align start and user bubbles align end.

### Responsive contract

At `max-width: 480px`, the root moves to `left: 14px; bottom: 14px`, requests `width: calc(100% - 28px)`, removes its `360px` minimum width, keeps a `360px` minimum height, and stacks the form input and submit button. The inherited desktop `max-width: calc(100vw - 44px)` remains active, so the actual current Chrome panel at a `375px` viewport is `331px` wide rather than `347px`. Preserve that behavior unless an approved responsive correction changes the source.

The observed current surface is:

| Viewport | Closed launcher | Open panel | Form behavior |
| --- | --- | --- | --- |
| `375 × 812` | `x:14, y:744, 184.98 × 54px`; label wraps | `x:14, y:278, 331 × 520px` | Input above a full-width submit button. |
| `768 × 900` | `x:22, y:820, 198 × 58px` | `x:22, y:358, 470 × 520px` | Input and submit share one row. |
| `1280 × 900` | `x:22, y:820, 198 × 58px` | `x:22, y:358, 470 × 520px` | Input and submit share one row. |

## 5. Components

### NLI launcher

- **Structure:** native `button.nli-launcher` inside the `aside[data-nli-widget]`; a compact `strong` badge followed by the label span.
- **Default:** dark `--ink` fill, white text, 1px translucent ink border, `8px` radius, elevated NLI shadow. It is absolutely anchored inside the collapsed root.
- **Hover / active:** no authored NLI hover or active selector. Chrome’s observed hover preserves the rest colors, border, and shadow; native press feedback remains browser behavior.
- **Focus:** no custom launcher focus rule. Chrome shows its native `1px auto` outline. Do not suppress native keyboard focus without supplying an equivalent visible focus treatment.
- **Open behavior:** removes `.is-collapsed`, sets `aria-expanded="true"`, renders the message history, and moves focus to the input asynchronously.

### NLI panel and header controls

- **Structure:** `section.nli-panel` contains a `.nli-panel-header` and `.nli-panel-body`. Header controls are three native buttons: clear, minimize, close.
- **Header:** `72px` minimum height, `16px` left inset, `14px` top/right inset, `12px` bottom inset, `1px solid var(--line)` divider, `--surface` background.
- **Controls:** `34px` high, at least `34px` wide, `6px` radius, `1px solid var(--line)`, `--surface-strong` fill, `--ink` text, `0 9px` horizontal padding, `0.78rem`/`800` type.
- **Minimized:** `.is-minimized` changes the visible panel to its header only; the body becomes `display: none`. At `768 × 900`, the observed header-only panel was `470 × 74px`.
- **Close:** restores `.is-collapsed` and `aria-expanded="false"`. Current code does not explicitly return focus to the launcher.

### NLI message log and bubbles

- **Structure:** `div.nli-messages[aria-live="polite"]` contains `.nli-message.is-user` or `.nli-message.is-assistant`, each with a role label and a `p` bubble.
- **Assistant bubble:** start-aligned, `--surface` fill, `1px solid var(--line)`, `8px` radius, `10px 12px` padding, direct existing text color `#34413d`.
- **User bubble:** end-aligned, `--ink` fill and border, white text; all other bubble geometry remains shared.
- **Empty / initial:** one persisted-or-default assistant welcome message is rendered; there is no separate empty-state component.
- **Pending:** the assistant message gains `.is-pending`; its text becomes muted and a three-dot `.nli-typing` indicator appears below it.
- **Error:** the pending bubble text is replaced by the gateway-connectivity message. No error class, red fill, icon, or special border exists today.

### NLI answer-source controls

- **Structure:** an assistant message with one or more gateway-provided `sources` renders a `.nli-message-sources` group of native `button type="button"` controls after the text bubble. Every button carries the existing `data-scroll-target` target ID and its label is rendered as text, never HTML.
- **Default:** source controls reuse the compact NLI header-control treatment: `34px` minimum height, `6px` radius, `1px solid var(--line)`, `--surface-strong` fill, `--ink` text, `0 9px` padding, and `0.78rem` / `800` type. The group wraps with the existing `4px` gap and stays within the assistant message width.
- **Hover / active / focus:** hover and active use the established interactive dark `--ink` fill with white text. Keyboard focus has a visible `2px` existing green input-focus composite outline with a `2px` offset. These controls are not passive tags.
- **Interaction:** rendering sources never scrolls the document. Activating a source uses the existing `scrollToTarget(source.id)` path, including filter reset and project highlighting. A direct `navigate`, project summary, or section summary remains the only gateway response that auto-scrolls on render.

### NLI form

- **Structure:** semantic `form.nli-form` with an `.sr-only` label, native search input, and native submit button.
- **Default:** form has an `8px` gap/padding and a top divider. The input is borderless with `--surface-strong` fill, `6px` radius, `0 14px` padding, and `42px` minimum height. Submit is `--ink` with white text, `6px` radius, `0 16px` padding, and `42px` minimum height.
- **Focus:** only the input has an authored rule: `inset 0 0 0 2px rgba(31, 122, 85, 0.32)`. Header actions and submit rely on native focus behavior.
- **Disabled/loading:** during a request, input and submit receive native `disabled`; both use `cursor: wait` and `opacity: 0.72`.
- **Validation:** blank submission appends an assistant prompt rather than applying an invalid-input visual state.

### Existing chips and the source-control boundary

There was no legacy NLI source chip to imitate exactly. Gateway `sources` now render through the native NLI answer-source control documented above, while response text and direct target navigation retain their existing responsibilities.

The closest existing treatments are:

| Existing pattern | Current geometry | Appropriate meaning |
| --- | --- | --- |
| `.tag-row span` | pill, `4px 9px`, `0.82rem`, `800`, `--surface-strong` | Passive metadata only. |
| `.focus-row span` | pill, `4px 9px`, `0.78rem`, `800`, `1px solid rgba(39, 106, 159, 0.22)`, translucent blue fill | Passive category metadata only. |
| `.filter-tabs button` | `38px` min-height, `8px` radius, `1px solid var(--line)`, `--surface` fill, `--ink`, `0 12px`, `700` | Existing interactive text control. Hover/active use `--ink` fill with white text. |
| `.nli-panel-actions button` | `34px` compact control with the header-control treatment above | Existing compact NLI action; suited to short control labels. |

NLI source navigation uses a real `button type="button"` because the action calls the existing in-page `scrollToTarget(source.id)` path. That preserves filter reset, `.is-highlighted`, and the documented motion preference. Use an anchor only when there is a real URL/destination rather than a JavaScript panel action. A source control retains a visible keyboard focus indication and the existing CSS-variable language; it is never an inert `span` styled as a button.

## 6. Motion & Interaction

### Existing motion

- Opening, closing, and minimizing are immediate class/display changes; no panel transition is authored.
- Pending typing dots run `nli-pulse 1s infinite ease-in-out`, changing only `transform: translateY(...)` and `opacity`; dots two and three delay by `0.15s` and `0.3s`.
- Direct target navigation calls `scrollIntoView({ behavior: "smooth", block: "start" })`; the document also sets `scroll-behavior: smooth`.

### Reduced-motion state

When `prefers-reduced-motion: reduce` is active, the NLI typing dots stop animating and NLI target navigation uses instant `scrollIntoView` behavior instead of smooth scrolling. This applies equally to direct gateway navigation and the new answer-source controls; it preserves the final target, filter reset, and project highlight without introducing a separate motion system.

### Keyboard and semantic interaction

- The launcher has `aria-controls="nli-panel"` and its `aria-expanded` value is kept in sync with open/close state.
- The panel uses `aria-labelledby`; message updates are announced through `aria-live="polite"`.
- The input has a programmatic label, is a native `type="search"`, and the form provides native Enter-to-submit behavior.
- Native buttons provide keyboard activation for launcher, clear, minimize, close, and submit. There are no widget-specific `keydown` handlers, Escape shortcut, focus trap, or explicit focus restoration on close/minimize.
- After a successful, failed, or completed request, the current implementation focuses the input. After a close, observed Chrome focus fell back to `body` rather than being restored to the launcher.

## 7. Depth & Surface

**Current strategy: mixed.** The portfolio combines thin borders, tonal surface shifts, one translucent elevated layer, and a prominent soft shadow. Do not flatten this to borders-only or replace it with a glossy/glass redesign.

| Layer | Existing treatment | Usage |
| --- | --- | --- |
| Base | `--bg` plus a low-contrast fixed grid | Page field behind the NLI. |
| Quiet separation | `1px solid var(--line)` | Header/form dividers, assistant bubbles, controls. |
| Strong dark action | `--ink` fill with white text | Launcher, submit, user bubble. |
| Elevated NLI shell | `rgba(255, 255, 255, 0.96)`, `blur(18px)`, translucent ink border, `0 18px 55px rgba(22, 32, 30, 0.18)` | Fixed panel. |
| Global card depth | `--shadow: 0 18px 55px rgba(22, 32, 30, 0.1)` | Existing non-NLI cards/panels. |

## Extraction Notes

- Source evidence and rendered viewport observations are recorded in `.omo/evidence/task-5-grounded-portfolio-nli.md`.
- This contract intentionally flags remaining gaps (no authored hover/active states for the existing NLI header/form controls and no explicit close-focus restoration) rather than silently filling them with new design decisions. Answer-source controls and the reduced-motion override are implemented behaviors documented above, not gaps.
