import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "../../../../lib/tauri";
import { useToast } from "../../../ui/toast";
import type { McpBridgeList, McpBridgeProbe, ServerInput } from "./types";

/**
 * 外挂 MCP 桥的数据层。
 *
 * 🔴 **不挂在设置页的 `onSaved` 全局刷新链上**（§8.1）。那条链每改一个开关
 * 就跑一次，而 `mcp_bridge_list` 里每个 server 都要扫一遍 PATH。只在本卡挂载与
 * 自己的写操作后刷。
 *
 * 所有 mutation 都先拿结果再 `reload()`，不做乐观更新：这里每一次写都会改变
 * 远程的能力边界，界面先于后端亮起来是不能接受的——万一后端拒了，
 * 用户会以为已经开了。
 */
export function useMcpBridge() {
  const [data, setData] = useState<McpBridgeList | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { toast } = useToast();
  // 卸载后不能再 setState：探测最长能跑 60s，用户早就切走了。
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    try {
      const r = await invoke<McpBridgeList>("mcp_bridge_list");
      if (alive.current) setData(r);
    } catch (e) {
      toast(`读取外挂 MCP 列表失败：${e}`, "error");
    }
  }, [toast]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** 包一层：置 busy → 跑 → 刷新。失败时把**原文**报出去。 */
  const run = useCallback(
    async (key: string, fn: () => Promise<void>, okMsg?: string) => {
      setBusy(key);
      try {
        await fn();
        await reload();
        if (okMsg) toast(okMsg, "success");
        return true;
      } catch (e) {
        toast(`${e}`, "error");
        return false;
      } finally {
        if (alive.current) setBusy(null);
      }
    },
    [reload, toast],
  );

  const setMaster = useCallback(
    (enabled: boolean) =>
      run("master", () => invoke("mcp_bridge_set_master", { enabled }), enabled ? "外挂 MCP 桥已开启" : "外挂 MCP 桥已关闭，子进程已停"),
    [run],
  );

  const setEnabled = useCallback(
    (name: string, enabled: boolean) =>
      run(
        name,
        () => invoke("mcp_bridge_set_enabled", { name, enabled }),
        enabled ? `已启用 ${name}` : `已停用 ${name}`,
      ),
    [run],
  );

  const setRemoteCwd = useCallback(
    (name: string, allowed: boolean) =>
      run(
        name,
        () => invoke("mcp_bridge_set_remote_cwd", { name, allowed }),
        allowed ? `${name}：已允许远程指定工作目录` : `${name}：已收回工作目录选择权`,
      ),
    [run],
  );

  const remove = useCallback(
    (name: string) => run(name, () => invoke("mcp_bridge_remove", { name }), `已删除 ${name}`),
    [run],
  );

  const upsert = useCallback(
    (server: ServerInput) =>
      run(server.name, () => invoke("mcp_bridge_upsert", { server }), `已保存 ${server.name}`),
    [run],
  );

  const importSelected = useCallback(
    (names: string[]) =>
      run("import", async () => {
        const r = await invoke<{ imported: string[]; skipped: { name: string; reason: string }[] }>(
          "mcp_bridge_import",
          { names },
        );
        // 部分失败不能静默：用户勾了三条只进去两条得有个交代。
        if (r.skipped.length) {
          toast(`${r.imported.length} 条已导入，${r.skipped.length} 条跳过：${r.skipped[0].reason}`, "warning");
        } else {
          toast(`已导入 ${r.imported.length} 条，均保持关闭`, "success");
        }
      }),
    [run, toast],
  );

  /** 探测。**唯一会真的启动子进程的操作**，所以它必须是用户显式点的。 */
  const probe = useCallback(
    async (name: string) => {
      setBusy(name);
      try {
        const r = await invoke<McpBridgeProbe>("mcp_bridge_probe", { name });
        await reload();
        if (r.state === "ready") toast(`${name}：拓到 ${r.toolCount} 个工具`, "success");
        else toast(`${name} 探测失败，详情见该行`, "error");
      } catch (e) {
        toast(`${e}`, "error");
      } finally {
        if (alive.current) setBusy(null);
      }
    },
    [reload, toast],
  );

  return {
    data,
    busy,
    reload,
    setMaster,
    setEnabled,
    setRemoteCwd,
    remove,
    upsert,
    importSelected,
    probe,
  };
}
