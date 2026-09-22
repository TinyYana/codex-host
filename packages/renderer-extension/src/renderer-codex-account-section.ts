import type {
  RendererCodexAccountSwitchOffer,
  RendererCodexAccountSwitchView,
} from "./renderer-codex-account-switch.js";

// Inline styles only: this renders into the Codex Desktop document, where the settings
// Tailwind build must never be used.
const MUTED = "color-mix(in srgb, currentColor 62%, transparent)";
const DIVIDER = "1px solid color-mix(in srgb, currentColor 12%, transparent)";
const WARNING = "#c9a227";
const DANGER = "#c45c4a";

function textLine(document: Document, value: string, muted = false): HTMLDivElement {
  const line = document.createElement("div");
  line.textContent = value;
  line.style.fontSize = muted ? "11px" : "12px";
  line.style.overflowWrap = "anywhere";
  if (muted) line.style.color = MUTED;
  return line;
}

function actionButton(document: Document, label: string, emphasis = false): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.style.flex = "0 0 auto";
  button.style.padding = "3px 9px";
  button.style.font = "inherit";
  button.style.fontSize = "11.5px";
  button.style.fontWeight = emphasis ? "600" : "500";
  button.style.color = "inherit";
  button.style.cursor = "pointer";
  button.style.borderRadius = "7px";
  button.style.border = "1px solid color-mix(in srgb, currentColor 22%, transparent)";
  button.style.background = emphasis
    ? "color-mix(in srgb, currentColor 12%, transparent)"
    : "transparent";
  return button;
}

function setDisabled(button: HTMLButtonElement, disabled: boolean, reason?: string | null): void {
  button.disabled = disabled;
  button.style.opacity = disabled ? "0.5" : "1";
  button.style.cursor = disabled ? "not-allowed" : "pointer";
  if (reason) button.title = reason;
}

function renderOffer(
  document: Document,
  offer: RendererCodexAccountSwitchOffer,
  busy: boolean,
): HTMLDivElement {
  const box = document.createElement("div");
  box.dataset.codexhostAccountOffer = offer.tone;
  box.setAttribute("role", "status");
  box.style.display = "grid";
  box.style.gap = "6px";
  box.style.marginBottom = "8px";
  box.style.padding = "8px 9px";
  box.style.borderRadius = "9px";
  box.style.border = `1px solid color-mix(in srgb, ${offer.tone === "warning" ? WARNING : "currentColor"} 40%, transparent)`;
  box.append(textLine(document, offer.message));
  const actions = document.createElement("div");
  actions.style.display = "flex";
  actions.style.flexWrap = "wrap";
  actions.style.gap = "6px";
  if (offer.action) {
    const { run, label } = offer.action;
    const primary = actionButton(document, label, true);
    primary.dataset.codexhostAccountOfferAction = "";
    primary.style.whiteSpace = "normal";
    primary.style.textAlign = "left";
    setDisabled(primary, busy);
    primary.addEventListener("click", () => run());
    actions.append(primary);
  }
  const dismiss = actionButton(document, "×");
  dismiss.dataset.codexhostAccountOfferDismiss = "";
  dismiss.setAttribute("aria-label", offer.dismissLabel);
  dismiss.title = offer.dismissLabel;
  dismiss.addEventListener("click", () => offer.dismiss());
  actions.append(dismiss);
  box.append(actions);
  return box;
}

/** The Codex Account block of the Composer credits popover: identity, other Accounts, switch. */
export function renderRendererCodexAccountSection(
  document: Document,
  view: RendererCodexAccountSwitchView,
  separated: boolean,
): HTMLDivElement {
  const section = document.createElement("div");
  section.dataset.codexhostAccountSwitch = "";
  if (separated) {
    section.style.marginTop = "11px";
    section.style.paddingTop = "10px";
    section.style.borderTop = DIVIDER;
  }
  if (view.offer) section.append(renderOffer(document, view.offer, view.busy));

  const heading = document.createElement("div");
  heading.style.display = "flex";
  heading.style.alignItems = "center";
  heading.style.justifyContent = "space-between";
  heading.style.gap = "8px";
  heading.style.marginBottom = "4px";
  const title = document.createElement("span");
  title.textContent = view.title;
  title.style.fontSize = "11px";
  title.style.fontWeight = "600";
  title.style.color = MUTED;
  heading.append(title);
  if (view.auto) {
    const { enabled, label, toggle } = view.auto;
    const auto = actionButton(document, label, enabled);
    auto.dataset.codexhostAccountAuto = "";
    auto.setAttribute("aria-pressed", String(enabled));
    setDisabled(auto, view.busy);
    auto.addEventListener("click", () => toggle());
    heading.append(auto);
  }
  section.append(heading);

  if (view.current) {
    const current = document.createElement("div");
    current.dataset.codexhostAccountCurrent = "";
    const name = textLine(document, view.current.name);
    name.style.fontWeight = "600";
    name.translate = false;
    current.append(name);
    if (view.current.detail) current.append(textLine(document, view.current.detail, true));
    section.append(current);
  }

  for (const account of view.others) {
    const row = document.createElement("div");
    row.dataset.codexhostAccountOption = account.accountId;
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.justifyContent = "space-between";
    row.style.gap = "10px";
    row.style.marginTop = "7px";
    if (account.title) row.title = account.title;
    const copy = document.createElement("div");
    copy.style.minWidth = "0";
    const name = textLine(document, account.name);
    name.translate = false;
    if (account.recommended) name.style.fontWeight = "600";
    copy.append(name);
    if (account.detail) copy.append(textLine(document, account.detail, true));
    row.append(copy);
    if (view.canSwitch) {
      const button = actionButton(document, view.switchLabel);
      button.setAttribute("aria-label", `${view.switchLabel}: ${account.name}`);
      setDisabled(button, view.busy || account.disabledReason !== null, account.disabledReason);
      button.addEventListener("click", () => view.switchTo(account.accountId));
      row.append(button);
    }
    section.append(row);
  }
  if (view.emptyHint) {
    const hint = textLine(document, view.emptyHint, true);
    hint.style.marginTop = "6px";
    section.append(hint);
  }
  if (view.status) {
    const status = textLine(document, view.status.text, true);
    status.dataset.codexhostAccountStatus = view.status.tone;
    status.setAttribute("role", "status");
    status.style.marginTop = "8px";
    if (view.status.tone === "error") status.style.color = DANGER;
    section.append(status);
  }
  return section;
}
