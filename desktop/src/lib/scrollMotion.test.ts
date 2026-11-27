import { afterEach, expect, it, vi } from "vitest";
import { scrollMotion } from "./scrollMotion";

afterEach(() => vi.unstubAllGlobals());

it("keeps easing inside a screen and lands immediately on distant targets", () => {
  vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
  expect(scrollMotion(-240, 480)).toBe("smooth");
  expect(scrollMotion(480, 480)).toBe("smooth");
  expect(scrollMotion(-481, 480)).toBe("instant");
});

it("reads the current system preference when each jump starts", () => {
  const preference = { matches: false };
  vi.stubGlobal("window", { matchMedia: () => preference });
  expect(scrollMotion(240, 480)).toBe("smooth");
  preference.matches = true;
  expect(scrollMotion(240, 480)).toBe("instant");
});
