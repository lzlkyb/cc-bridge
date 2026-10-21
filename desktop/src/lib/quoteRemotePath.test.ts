import { expect, it } from "vitest";
import { quoteRemotePath, buildPermissionGrantCommand, buildTokenSedCommand } from "./utils";

it("家目录简写展开 HOME，其余内容不会触发 shell 替换", () => {
  expect(quoteRemotePath("~")).toBe('"$HOME"');
  expect(quoteRemotePath('~/My Project/$(bad)`x"')).toBe('"$HOME/My Project/\\$(bad)\\`x\\""');
  expect(quoteRemotePath('/tmp/~/My Project')).toBe('"/tmp/~/My Project"');
});
it("授权与令牌修复也使用相同的家目录路径语义", () => {
  expect(buildPermissionGrantCommand("project", "~/My Project", false)).toContain('cd "$HOME/My Project" &&');
  expect(buildTokenSedCommand("old", "new", "project", "~/My Project")).toContain('cd "$HOME/My Project" &&');
});
