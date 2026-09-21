import { describe, expect, it, vi } from "vitest";

import { renderRendererCodexAccountSection } from "../src/renderer-codex-account-section.js";
import type { RendererCodexAccountSwitchView } from "../src/renderer-codex-account-switch.js";

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly #listeners = new Map<string, () => void>();
  textContent = "";
  title = "";
  type = "";
  disabled = false;
  translate = true;
  constructor(readonly tagName: string) {}
  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  addEventListener(name: string, listener: () => void): void {
    this.#listeners.set(name, listener);
  }
  click(): void {
    if (!this.disabled) this.#listeners.get("click")?.();
  }
}

const fakeDocument = {
  createElement: (tagName: string) => new FakeElement(tagName),
} as unknown as Document;

function all(root: FakeElement): FakeElement[] {
  return [root, ...root.children.flatMap(all)];
}

function view(overrides: Partial<RendererCodexAccountSwitchView> = {}) {
  const base: RendererCodexAccountSwitchView = {
    title: "Codex account",
    current: { name: "work@example.com", detail: "Tightest limit: 7-day limit · 12% left" },
    others: [
      {
        accountId: "home",
        name: "home@example.com",
        detail: "7-day limit · 80% left",
        title: "80% headroom on the binding seven_day window",
        recommended: true,
        disabledReason: null,
      },
      {
        accountId: "old",
        name: "old@example.com",
        detail: "Sign-in needed",
        title: "",
        recommended: false,
        disabledReason: "Sign in again",
      },
    ],
    emptyHint: null,
    switchLabel: "Switch",
    canSwitch: true,
    busy: false,
    status: null,
    auto: null,
    offer: null,
    switchTo: vi.fn(),
    opened: vi.fn(),
    ...overrides,
  };
  return base;
}

function render(input: RendererCodexAccountSwitchView): FakeElement {
  return renderRendererCodexAccountSection(fakeDocument, input, true) as unknown as FakeElement;
}

describe("Composer Codex Account section", () => {
  it("shows the identity with its tightest limit and a manual switch per saved Account", () => {
    const input = view();
    const section = render(input);
    const text = all(section).map(({ textContent }) => textContent);
    expect(text).toContain("work@example.com");
    expect(text).toContain("Tightest limit: 7-day limit · 12% left");
    const switches = all(section).filter(
      ({ tagName, textContent }) => tagName === "button" && textContent === "Switch",
    );
    expect(switches.map(({ disabled }) => disabled)).toEqual([false, true]);
    expect(switches[1]?.title).toBe("Sign in again");
    // Rendering alone never switches.
    expect(input.switchTo).not.toHaveBeenCalled();
    switches[0]?.click();
    switches[1]?.click();
    expect(input.switchTo).toHaveBeenCalledExactlyOnceWith("home");
  });

  it("disables every action and states the reason while busy", () => {
    const input = view({ busy: true, status: { tone: "error", text: "A Turn is running." } });
    const section = render(input);
    const buttons = all(section).filter(({ tagName }) => tagName === "button");
    expect(buttons.every(({ disabled }) => disabled)).toBe(true);
    const status = all(section).find(({ dataset }) => dataset.codexhostAccountStatus === "error");
    expect(status?.textContent).toBe("A Turn is running.");
  });

  it("omits switch actions without the capability", () => {
    const section = render(view({ canSwitch: false }));
    expect(all(section).some(({ tagName }) => tagName === "button")).toBe(false);
  });

  it("runs Switch & Retry only from an explicit click", () => {
    const run = vi.fn();
    const dismiss = vi.fn();
    const section = render(
      view({
        offer: {
          key: "1:offer",
          tone: "warning",
          message: "This account's quota is used up.",
          pillLabel: "Switch",
          action: { label: "Switch to home@example.com and retry", run },
          dismissLabel: "Dismiss",
          dismiss,
        },
      }),
    );
    expect(run).not.toHaveBeenCalled();
    const action = all(section).find(({ dataset }) => "codexhostAccountOfferAction" in dataset);
    expect(action?.textContent).toBe("Switch to home@example.com and retry");
    action?.click();
    expect(run).toHaveBeenCalledOnce();
    all(section)
      .find(({ dataset }) => "codexhostAccountOfferDismiss" in dataset)
      ?.click();
    expect(dismiss).toHaveBeenCalledOnce();
  });
});
