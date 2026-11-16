import { describe, it, expect } from "vitest";
import { initialLink, transition, compactLink, scenarioLinks, type Scenario } from "./model";
const start = () => transition(initialLink(), { type: "start", port: 7823 });
const run = (scenario: Scenario) => { let state = start(); for (let i = 0; i < 8; i++) state = transition(state, { type: "tick", scenario }); return state; };
describe("one-click preview lifecycle", () => {
  it("reports ready only after every step, never fabricates a Claude call", () => {
    let state = start(); for (let i = 0; i < 4; i++) state = transition(state, { type: "tick", scenario: "normal" });
    expect(state.phase).toBe("running"); state = transition(state, { type: "tick", scenario: "normal" });
    expect(state.phase).toBe("ready"); expect(state.callsSeen).toBe(false);
  });
  it("cancel cannot be undone by a late progress tick", () => {
    const stopped = transition(start(), { type: "stop" });
    expect(transition(stopped, { type: "tick", scenario: "normal" })).toEqual(stopped);
  });
  it("double click preserves progress", () => {
    const state = transition(start(), { type: "tick", scenario: "normal" });
    expect(transition(state, { type: "start", port: 9999 })).toEqual(state);
  });
  it.each(["password", "missing", "denied"] as const)("pauses for %s and resumes from the failed step", scenario => {
    const state = run(scenario); expect(state.phase).toBe("error"); expect(state.issue).toBe(scenario);
    let repaired = transition(state, { type: "repair" }); expect(repaired.step).toBe(state.step);
    for (let i = 0; i < 5; i++) repaired = transition(repaired, { type: "tick", scenario });
    expect(repaired.phase).toBe("ready");
  });
  it("port conflict repairs the endpoint before completion and keeps it during recheck", () => {
    const ready = run("occupied"); expect(ready.phase).toBe("ready"); expect(ready.port).toBe(17823);
    expect(transition(ready, { type: "recheck" }).port).toBe(17823);
  });
  it("separate servers have separate connection and call states", () => {
    const a = transition(run("normal"), { type: "call" }); const b = initialLink();
    expect(a.callsSeen).toBe(true); expect(b.phase).toBe("idle"); expect(b.callsSeen).toBe(false);
  });
  it("keeps setup expanded and collapses only after verified success", () => {
    expect(compactLink(initialLink(), false)).toBe(false);
    expect(compactLink(start(), false)).toBe(false);
    expect(compactLink(run("password"), false)).toBe(false);
    expect(compactLink(run("normal"), false)).toBe(true);
  });
  it("management expands without changing the connection and can be closed", () => {
    const ready = run("normal");
    expect(compactLink(ready, true)).toBe(false);
    expect(ready.phase).toBe("ready");
    expect(compactLink(ready, false)).toBe(true);
  });
  it("daily return and interruption are compact until repair requires input", () => {
    expect(compactLink(scenarioLinks("returning").cloud, false)).toBe(true);
    const failed = scenarioLinks("interrupted").cloud;
    expect(compactLink(failed, false)).toBe(true);
    expect(compactLink(failed, true)).toBe(false);
    expect(failed.issue).toBe("password");
  });
  it("stopped configured links stay compact, reconnection expands, then collapses", () => {
    const stopped = transition(run("normal"), { type: "stop" });
    expect(compactLink(stopped, false)).toBe(true);
    let reconnecting = transition(stopped, { type: "start", port: 7823 });
    expect(reconnecting.configured).toBe(true);
    expect(compactLink(reconnecting, false)).toBe(false);
    for (let i = 0; i < 5; i++) reconnecting = transition(reconnecting, { type: "tick", scenario: "normal" });
    expect(compactLink(reconnecting, false)).toBe(true);
  });
  it("network recovery stays compact and preserves the configured MCP port", () => {
    let state = { ...scenarioLinks("recovery").cloud, port: 17823 };
    for (let i = 0; i < 3; i++) {
      expect(compactLink(state, false)).toBe(true);
      state = transition(state, { type: "tick", scenario: "recovery" });
      expect(state.port).toBe(17823);
    }
    expect(state.phase).toBe("ready");
    const stopped = transition(scenarioLinks("recovery").cloud, { type: "stop" });
    expect(transition(stopped, { type: "tick", scenario: "recovery" }).phase).toBe("stopped");
  });
});
