import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { platform } from "node:os";
import { buildStablePermissionCommand, stableShellQuote } from "./stableAccess";

it("自定义接入的权限命令使用原名称，特殊字符不会成为命令", () => {
  const name = "我的桥'$(touch SHOULD_NOT_EXIST)";
  const command = buildStablePermissionCommand("project", "/work/project with spaces", false, name);
  const harness = `import json,shlex,sys,tempfile,os
command=json.loads(sys.argv[1])
parts=shlex.split(command)
assert parts[:3]==['cd','/work/project with spaces','&&']
assert parts[3:5]==['python3','-c']
source,payload=parts[5:7]
assert json.loads(payload)[0]==${JSON.stringify(name)}
original_cwd=os.getcwd()
with tempfile.TemporaryDirectory() as d:
    os.chdir(d)
    sys.argv=['-c',payload]
    exec(source,{})
    saved=json.load(open('.claude/settings.local.json'))
    assert saved['enabledMcpjsonServers']==[json.loads(payload)[0]]
    assert all(rule.startswith('mcp__'+json.loads(payload)[0]+'__') for rule in saved['permissions']['allow'])
    assert not os.path.exists('SHOULD_NOT_EXIST')
    os.chdir(original_cwd)
print('PERMISSION_OK')`;
  const python = platform() === "win32" ? "python" : "python3";
  const executed = spawnSync(python, ["-c", harness, JSON.stringify(command)], { encoding: "utf8" });
  expect(executed.status, executed.stderr).toBe(0);
  expect(executed.stdout).toContain("PERMISSION_OK");
  expect(stableShellQuote("a'b")).toBe(`'a'"'"'b'`);
});
