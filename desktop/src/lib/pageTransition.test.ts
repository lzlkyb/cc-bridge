import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-dom", () => ({ flushSync: vi.fn((update: () => void) => update()) }));

describe("page transitions", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("document", { hidden: false, documentElement: { dataset: {} } });
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it("commits immediately when snapshots are unavailable", async () => {
    const { transitionPage } = await import("./pageTransition");
    const update = vi.fn();
    transitionPage(update);
    expect(update).toHaveBeenCalledOnce();
    expect(document.documentElement.dataset.pageTransitions).toBeUndefined();
  });

  it.each(["reduced", "hidden"])("does not capture or delay navigation when %s", async mode => {
    const start = vi.fn();
    Object.assign(document, { startViewTransition: start, hidden: mode === "hidden" });
    vi.stubGlobal("window", { matchMedia: () => ({ matches: mode === "reduced" }) });
    const { transitionPage } = await import("./pageTransition");
    const update = vi.fn();
    transitionPage(update);
    expect(start).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledOnce();
  });

  it("commits React inside capture and interrupts previous motion on rapid navigation", async () => {
    const captures: Array<() => void> = [];
    const skipped = vi.fn();
    Object.assign(document, { startViewTransition: (update: () => void) => {
      captures.push(update);
      return { ready: Promise.resolve(), finished: new Promise(() => {}), skipTransition: skipped };
    } });
    const { transitionPage } = await import("./pageTransition");
    const first = vi.fn(), last = vi.fn();
    transitionPage(first);
    expect(first).not.toHaveBeenCalled();
    captures[0]();
    expect(first).toHaveBeenCalledOnce();
    transitionPage(last);
    expect(skipped).toHaveBeenCalledOnce();
    captures[1]();
    expect(last).toHaveBeenCalledOnce();
    expect(document.documentElement.dataset.pageTransitions).toBe("true");
  });

  it("invalidates a pending capture when the user clicks straight back to the current page", async () => {
    let capture: () => void = () => {};
    const skipped = vi.fn();
    Object.assign(document, { startViewTransition: (update: () => void) => {
      capture = update;
      return { ready: Promise.resolve(), finished: new Promise(() => {}), skipTransition: skipped };
    } });
    const { transitionPage } = await import("./pageTransition");
    const stale = vi.fn(), latest = vi.fn();
    transitionPage(stale);
    transitionPage(latest, false);
    capture();
    expect(skipped).toHaveBeenCalledOnce();
    expect(stale).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledOnce();
  });
});
