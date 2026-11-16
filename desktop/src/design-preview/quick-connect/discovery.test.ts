import { describe, expect, it } from "vitest";
import { connectionPlan, discoveryReducer, initialDiscovery, selectedEntry } from "./discovery";

const detected = (scenario: Parameters<typeof initialDiscovery>[0]) => discoveryReducer(initialDiscovery(scenario), { type: "tick" });
const apply = (state: ReturnType<typeof initialDiscovery>) => {
  let next = discoveryReducer(state, { type: "apply", port: 7823 });
  for (let tick = 0; tick < 3; tick++) next = discoveryReducer(next, { type: "tick" });
  return next;
};
describe("preview connection discovery and migration", () => {
  it("updates only the chosen entry and preserves its project, name and file", () => {
    const state = detected("multiple");
    const selected = discoveryReducer(state, { type: "select", id: state.entries[1].id });
    const next = apply(selected);
    expect(next.phase).toBe("complete");
    expect(next.entries[0]).toEqual(state.entries[0]);
    expect(next.entries[2]).toEqual(state.entries[2]);
    expect(next.entries[1]).toEqual({ ...state.entries[1], url: "http://127.0.0.1:7823/mcp" });
    expect(next.result?.action).toBe("upgrade");
  });
  it("does not overwrite an unknown bridge based on its shared port", () => {
    const state = detected("uncertain");
    expect(state.phase).toBe("choose");
    expect(connectionPlan(state, 7823)).toBeNull();
    expect(apply(state)).toEqual(state);
    const next = apply(discoveryReducer(state, { type: "select", id: state.entries[0].id }));
    expect(selectedEntry(next)?.name).toBe("bridge-tools");
  });
  it("upgrades legacy local configuration without creating a project MCP entry", () => {
    const state = detected("existing-local");
    const next = apply(state);
    expect(next.entries).toHaveLength(1);
    expect(selectedEntry(next)).toMatchObject({ scope: "local", configFile: "~/.claude.json", projectPath: state.entries[0].projectPath, url: "http://127.0.0.1:7823/mcp" });
  });
  it("keeps the selected global scope while switching to stable connection", () => {
    const state = detected("existing-global");
    const next = apply(state);
    expect(selectedEntry(next)).toMatchObject({ id: state.entries[0].id, scope: "user", projectPath: "" });
    expect(next.result?.action).toBe("upgrade");
  });
  it("requires a project selection for first project setup, and reuses existing projects", () => {
    let state = detected("multiple");
    state = discoveryReducer(state, { type: "other-project" });
    expect(connectionPlan(state, 7823)).toBeNull();
    state = discoveryReducer(state, { type: "project", project: state.projects[0] });
    expect(connectionPlan(state, 7823)?.action).toBe("upgrade");
    expect(selectedEntry(apply(state))?.id).toBe("project-0");
  });
  it("does not fall back to adding MCP when inspection fails", () => {
    const state = detected("unavailable");
    expect(connectionPlan(state, 7823)).toBeNull();
    expect(apply(state)).toEqual(state);
    const chosen = discoveryReducer(state, { type: "project", project: state.projects[0] });
    expect(chosen.phase).toBe("checking");
    expect(chosen.scanPath).toBe(state.projects[0].path);
    expect(selectedEntry(discoveryReducer(chosen, { type: "tick" }))?.id).toBe("project-0");
  });
  it("discards the old server target when selecting another server", () => {
    const state = detected("existing-project");
    const next = discoveryReducer(state, { type: "server", scenario: "existing-project", serverId: "dev" });
    expect(next.selectedId).toBeNull();
    expect(next.entries).toEqual([]);
    expect(next.projects[0].path).toBe("/srv/projects/orders");
  });
  it("allows a token-only update, with an explicit indication in the plan", () => {
    const state = detected("token-changed");
    state.entries = state.entries.map(entry => ({ ...entry, url: "http://127.0.0.1:7823/mcp" }));
    const plan = connectionPlan(state, 7823);
    expect(plan).toMatchObject({ tokenUpdate: true, changed: true, before: "http://127.0.0.1:7823/mcp", after: "http://127.0.0.1:7823/mcp" });
  });
});
