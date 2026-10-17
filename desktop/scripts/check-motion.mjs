/** Real-browser regressions. See docs/交互动效规范与验证-2026-10-17.md for setup. */
/* global document, getComputedStyle, innerWidth, KeyboardEvent, window */
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MOTION } from "../src/lib/motion.ts";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const url = process.env.MOTION_PREVIEW_URL || "http://127.0.0.1:1425/motion-preview.html";
const artifacts = process.env.MOTION_ARTIFACT_DIR || path.join(tmpdir(), "cc-bridge-motion-check");
let browser, context, page;
const errors = [];
before(async () => {
  await mkdir(artifacts, { recursive: true });
  browser = await chromium.launch({
    headless: true,
    ...(process.env.MOTION_BROWSER_PATH ? { executablePath: process.env.MOTION_BROWSER_PATH } : process.platform === "win32" ? { channel: "msedge" } : {}),
  });
});
beforeEach(async () => {
  context = await browser.newContext({ viewport: { width: 1200, height: 800 }, reducedMotion: "no-preference" });
  page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(url);
  await page.getByRole("heading", { name: "交互动效预览" }).waitFor();
});
afterEach(async () => { await context.close(); });
after(async () => {
  await browser.close();
  assert.deepEqual(errors, [], "Browser runtime errors");
  console.log(`Screenshots: ${artifacts}`);
});

test("CSS and JS timing agree; loading never changes button or neighbor geometry", async () => {
  const tokens = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return ["fast", "enter", "exit"].map(name => {
      const value = style.getPropertyValue(`--dur-${name}`).trim();
      return parseFloat(value) * (value.endsWith("ms") ? 1 : 1000);
    });
  });
  assert.deepEqual(tokens, [MOTION.feedback, MOTION.enter, MOTION.exit]);
  const button = page.getByTestId("save"), neighbor = page.getByTestId("neighbor");
  const before = [await button.boundingBox(), await neighbor.boundingBox()];
  await button.click();
  assert.equal(await button.getAttribute("aria-busy"), "true");
  assert.equal(await button.isDisabled(), true);
  assert.deepEqual([await button.boundingBox(), await neighbor.boundingBox()], before);
  await page.getByRole("status").filter({ hasText: "已保存" }).waitFor();
  assert.deepEqual([await button.boundingBox(), await neighbor.boundingBox()], before);
});

test("modal really enters, exits, restores focus, and survives rapid reversal", async () => {
  const trigger = page.getByTestId("modal-trigger");
  await trigger.click();
  const modal = page.getByRole("dialog", { name: "连接设置" });
  await modal.waitFor();
  await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.dataset.state === "open");
  assert.equal(await modal.evaluate(node => getComputedStyle(node).transitionDuration), "0.18s, 0.18s");
  // Read the short exit in the browser task, before remote round-trips can outlast it.
  const exit = await modal.evaluate(async node => {
    node.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await Promise.resolve();
    return { exiting: node.dataset.exiting, duration: getComputedStyle(node).transitionDuration };
  });
  assert.deepEqual(exit, { exiting: "true", duration: "0.14s" });
  await modal.waitFor({ state: "detached" });
  assert.equal(await trigger.evaluate(node => node === document.activeElement), true);
  // Programmatic reversal avoids the backdrop hiding the external trigger.
  await trigger.evaluate(node => node.click());
  await page.getByTestId("modal-close").evaluate(node => node.click());
  await trigger.evaluate(node => node.click());
  await page.waitForTimeout(240);
  assert.equal(await modal.count(), 1);
  assert.equal(await modal.getAttribute("data-state"), "open");
});

test("exiting menus become inert immediately and reopening cancels removal", async () => {
  const trigger = page.getByRole("button", { name: "更多操作" });
  await trigger.click();
  const menu = page.getByRole("menu");
  await menu.waitFor();
  await page.getByRole("menuitem", { name: "关闭菜单" }).click();
  const exiting = page.locator('[role="menu"]');
  assert.equal(await exiting.evaluate(node => node.inert), true);
  await trigger.click();
  await page.waitForTimeout(240);
  assert.equal(await menu.count(), 1);
  assert.equal(await menu.getAttribute("data-state"), "open");
  await page.keyboard.press("Escape");
  await exiting.waitFor({ state: "detached" });
  assert.equal(await trigger.evaluate(node => node === document.activeElement), true);
  await page.getByTestId("modal-trigger").click();
  await page.getByRole("button", { name: "弹窗选项" }).click();
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.getByRole("menuitem").evaluate(node => node === document.activeElement), true);
  await page.keyboard.press("Escape");
  await page.locator('[role="menu"]').waitFor({ state: "detached" });
  assert.equal(await page.getByRole("dialog").count(), 1, "Escape must not also close the parent modal");
});

test("manual and timed toast dismissal both animate; hover pauses lifetime and progress", async () => {
  await page.getByRole("button", { name: "成功提示" }).click();
  const toast = page.locator(".toast");
  await toast.hover();
  assert.equal(await page.locator(".toast-countdown").evaluate(node => getComputedStyle(node).animationPlayState), "paused");
  await page.waitForTimeout(3650);
  assert.equal(await toast.getAttribute("data-state"), "open");
  await toast.getByRole("button", { name: "关闭" }).click();
  assert.equal(await toast.getAttribute("data-exiting"), "true");
  await toast.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "错误提示" }).click();
  const error = page.locator(".toast");
  assert.equal(await error.getAttribute("role"), "alert");
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => document.querySelector(".toast")?.hasAttribute("data-exiting"), undefined, { timeout: 5000 });
  await error.waitFor({ state: "detached" });
});

test("keyboard focus pauses notifications and switch/collapse state remains usable", async () => {
  await page.getByRole("button", { name: "成功提示" }).click();
  const toast = page.locator(".toast");
  await toast.getByRole("button").focus();
  await page.waitForTimeout(3650);
  assert.equal(await toast.getAttribute("data-state"), "open");
  assert.equal(await page.locator(".toast-countdown").evaluate(node => getComputedStyle(node).animationPlayState), "paused");
  await page.keyboard.press("Enter");
  await toast.waitFor({ state: "detached" });
  const toggle = page.getByRole("switch");
  await toggle.focus();
  await page.keyboard.press("Space");
  assert.equal(await toggle.getAttribute("aria-checked"), "true");
  assert.equal(await page.locator(".ui-collapse").evaluate(node => node.inert), false);
  await page.waitForTimeout(200);
  const track = await toggle.boundingBox();
  const thumb = toggle.locator(".sw-thumb");
  const onPosition = await thumb.boundingBox();
  assert.ok(Math.abs(onPosition.x - track.x - 22) < .5, "On-state thumb stays inside its track");
  await toggle.hover();
  await page.mouse.down();
  await page.waitForTimeout(90);
  const pressed = await thumb.boundingBox();
  assert.ok(pressed.x >= track.x && pressed.x + pressed.width <= track.x + track.width, "Press must not add a second translation");
  await page.mouse.up();
  // Mouse release toggled it off; keyboard can turn it on and back off.
  await toggle.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("Space");
  assert.equal(await page.locator(".ui-collapse").evaluate(node => node.inert), true);
});

test("kept pages retain draft, scroll and DOM; transitions never transform the terminal context", async () => {
  await page.getByTestId("draft").fill("保留草稿");
  await page.locator(".draft-scroll").evaluate(node => { node.scrollTop = 50; node.dataset.identity = "preserved"; });
  await page.getByRole("button", { name: "设置页", exact: true }).click();
  await page.getByTestId("draft").waitFor({ state: "hidden" });
  assert.equal(await page.getByTestId("draft").isVisible(), false);
  await page.getByRole("button", { name: "连接页", exact: true }).click();
  await page.getByTestId("draft").waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("draft").inputValue(), "保留草稿");
  assert.deepEqual(await page.locator(".draft-scroll").evaluate(node => [node.dataset.identity, node.scrollTop, getComputedStyle(node).transform]), ["preserved", 50, "none"]);
});

test("page motion really slides and crossfades snapshots; rapid switches never block controls or leave stale pages", async () => {
  const motion = await page.getByRole("button", { name: "设置页", exact: true }).evaluate(async node => {
    const start = document.startViewTransition.bind(document);
    document.startViewTransition = update => {
      const transition = start(update);
      window.pageMotion = transition;
      return transition;
    };
    node.click();
    await window.pageMotion.ready;
    return {
      animations: document.getAnimations().filter(a => ["tab-in", "page-out"].includes(a.animationName)).map(a => ({ name: a.animationName, duration: a.effect.getTiming().duration, frames: a.effect.getKeyframes().map(f => ({ transform: f.transform, opacity: f.opacity })) })),
      transform: getComputedStyle(document.querySelector('[data-page-panel]:not([hidden])')).transform,
      pointerEvents: getComputedStyle(document.documentElement, "::view-transition").pointerEvents,
    };
  });
  assert.equal(motion.transform, "none", "Actual page must not move its fixed descendants");
  assert.equal(motion.pointerEvents, "none");
  assert.ok(motion.animations.some(a => a.name === "tab-in" && a.duration === 200 && a.frames.some(f => f.transform === "translateY(6px)")));
  assert.ok(motion.animations.some(a => a.name === "page-out" && a.duration === 100));
  await page.getByRole("button", { name: "连接页", exact: true }).click();
  await page.getByTestId("draft").waitFor({ state: "visible" });
  await page.getByTestId("draft").fill("转场中可输入");
  await page.evaluate(async () => {
    const buttons = [...document.querySelectorAll("button")];
    const click = label => buttons.find(n => n.textContent === label).click();
    for (const label of ["设置页", "连接页"]) click(label);
    await window.pageMotion.finished;
  });
  assert.equal(await page.getByTestId("draft").isVisible(), true, "The last click wins even before the first capture commits");
  assert.equal(await page.locator('[data-page-panel]:not([hidden])').count(), 1);
  assert.equal(await page.evaluate(() => document.getAnimations().filter(a => ["tab-in", "page-out"].includes(a.animationName)).length), 0);
});

test("older engines retain a visible entry on every visit without remounting the page", async () => {
  await page.addInitScript(() => { document.startViewTransition = undefined; });
  await page.reload();
  const draft = page.getByTestId("draft");
  await draft.fill("旧环境仍保留草稿");
  for (let i = 0; i < 2; i++) {
    await page.getByRole("button", { name: "设置页", exact: true }).click();
    await draft.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "连接页", exact: true }).click();
    await draft.waitFor({ state: "visible" });
    const frames = await page.locator(".draft-scroll").evaluate(node => node.getAnimations().flatMap(a => a.effect.getKeyframes()).map(f => f.transform));
    assert.ok(frames.includes("translateY(6px)"));
    assert.equal(await draft.inputValue(), "旧环境仍保留草稿");
  }
});

test("reduced motion removes spatial movement and JS animation delays, including live preference changes", async () => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  assert.equal(await page.getByTestId("count").innerText(), "42");
  await page.getByTestId("modal-trigger").click();
  const modal = page.getByRole("dialog");
  assert.equal(await modal.evaluate(node => getComputedStyle(node).transform), "none");
  // The app's global guard uses 0.001ms to preserve transition-end semantics.
  assert.ok(await modal.evaluate(node => parseFloat(getComputedStyle(node).transitionDuration) <= .000001));
  await page.keyboard.press("Escape");
  await modal.waitFor({ state: "detached", timeout: 1000 });
  await page.getByRole("button", { name: "成功提示" }).click();
  assert.equal(await page.locator(".toast-countdown").isVisible(), false);
  await page.locator(".toast button").click();
  await page.locator(".toast").waitFor({ state: "detached", timeout: 1000 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.getByTestId("modal-trigger").click();
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await modal.evaluate(node => getComputedStyle(node).transform), "none");
});

test("theme cleanup survives rapid switching; light/dark/narrow previews have no horizontal overflow", async () => {
  const theme = page.getByRole("button", { name: "切换主题" });
  await theme.click();
  await theme.click();
  await theme.click();
  await page.waitForTimeout(420);
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains("theme-transition")), false);
  for (const [name, width, dark] of [["light", 1200, false], ["dark", 1200, true], ["narrow", 560, true]]) {
    await page.setViewportSize({ width, height: 800 });
    await page.evaluate(dark => document.documentElement.classList.toggle("dark", dark), dark);
    await page.screenshot({ path: path.join(artifacts, `${name}.png`), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, name);
  }
  await page.getByTestId("modal-trigger").click();
  await page.waitForTimeout(220);
  await page.screenshot({ path: path.join(artifacts, "modal.png") });
});
