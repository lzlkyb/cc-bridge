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
    try:
        sys.argv=['-c',payload]
        exec(source,{})
        saved=json.load(open('.claude/settings.local.json',encoding='utf-8'))
        assert saved['enabledMcpjsonServers']==[json.loads(payload)[0]]
        assert all(rule.startswith('mcp__'+json.loads(payload)[0]+'__') for rule in saved['permissions']['allow'])
        assert not os.path.exists('SHOULD_NOT_EXIST')
    finally:
        # 不恢复 cwd，临时目录清理会因被占用报 WinError 32，把真正的断言/编码错误盖掉。
        os.chdir(original_cwd)
print('PERMISSION_OK')`;
  const python = platform() === "win32" ? "python" : "python3";
  const executed = spawnSync(python, ["-c", harness, JSON.stringify(command)], { encoding: "utf8" });
  expect(executed.status, executed.stderr).toBe(0);
  expect(executed.stdout).toContain("PERMISSION_OK");
  expect(stableShellQuote("a'b")).toBe(`'a'"'"'b'`);
});

// 本机（中文 Windows，cp936）能编码中文，测不出 cp1252 下的失败；CI 的 en-US runner 才能。
// 这里钉住「源码必须自带 encoding」，不依赖运行环境 locale。
it("生成的命令显式声明 UTF-8，不依赖远端或本机 locale", () => {
  const command = buildStablePermissionCommand("project", "/work/x", false, "我的桥");
  // 命令里的 python 源码被单引号包裹，内层单引号会转义成 '"'"'，所以只钉编码标记本身。
  expect(command).toContain("utf-8-sig");
  expect(command).toMatch(/open\(p,'"'"'w'"'"',encoding='/);
});
