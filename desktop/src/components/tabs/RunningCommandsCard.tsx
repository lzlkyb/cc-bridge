import { useState, Fragment } from "react";
import { useQuery } from "@tanstack/react-query";
import { invoke } from "../../lib/tauri";
import type { RunningCommandInfo } from "../../lib/types";
import { formatUptime } from "../../lib/utils";
import { Card, CardHeader, CardTitle, CardContent } from "../ui/card";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../ui/table";
import { Badge } from "../ui/badge";
import { useAppHidden } from "../../lib/appVisibility";
import { useToast } from "../ui/toast";
import { useAutoAnimateRM } from "../../hooks/useAutoAnimateRM";
import { CommandOutputPanel } from "./RunningCommandOutput";

/**
 * 运行中的后台命令（run_command(background=true) 启动）。与远程的
 * get_command_output 读取同一份注册表，让本机面板也能看到并一键终止。
 * 无后台命令时不渲染，避免空卡片占地。
 * danger：命令执行已开启时整卡高亮红边 + 提醒，引导用户确认进程可信。
 */
export function RunningCommandsCard({ danger = false }: { danger?: boolean }) {
  // 窗口不可见时停轮询（3s 是全应用最密的一条）。
  const appHidden = useAppHidden();
  const { data: commands, refetch } = useQuery<RunningCommandInfo[]>({
    queryKey: ["runningCommands"],
    queryFn: () => invoke<RunningCommandInfo[]>("list_running_commands"),
    refetchInterval: appHidden ? false : 3000,
  });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // 各行的「终止中」态（可多行同时终止）；toast 带 PID——cleanupSecs=0 时行立即
  // 消失，PID 是用户唯一能对回的线索。
  const [stopping, setStopping] = useState<Set<string>>(new Set());
  // tbody FLIP（设计稿：design/微动画补全-P0P1-设计稿.html）：轮询发现新命令行插入 /
  // 清理宽限期行移除 / 展开输出行插入收回时平滑过渡，而不是闪现闪没。
  // TableBody 已 forwardRef（ui/table 注释里就有审计日志 FLIP 的先例）。
  const tbodyRef = useAutoAnimateRM<HTMLTableSectionElement>();
  // 终止最后一条后的 2s「已清空」过渡：否则卡片瞬间消失，用户以为点到没反应。
  const [justCleared, setJustCleared] = useState(false);
  const { toast } = useToast();

  const toggle = (handle: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(handle)) next.delete(handle);
      else next.add(handle);
      return next;
    });

  const stop = async (handle: string, pid: number) => {
    setStopping((prev) => new Set(prev).add(handle));
    try {
      await invoke("stop_running_command", { handle });
      refetch();
      toast(`已终止 PID ${pid}`, "success");
      if ((commands?.length ?? 0) <= 1) {
        setJustCleared(true);
        setTimeout(() => setJustCleared(false), 2000);
      }
    } catch (e) {
      // 之前静默无反馈：用户点了「终止」什么都没发生，也无法知道该不该重试。
      toast(`终止失败：${e}，请重试`, "error");
    } finally {
      setStopping((prev) => {
        const next = new Set(prev);
        next.delete(handle);
        return next;
      });
    }
  };

  const empty = !commands || commands.length === 0;
  if (empty && !justCleared) return null;

  return (
    <Card id="sec-running" className={danger ? "border-destructive/30" : ""}>
      <CardHeader>
        <CardTitle icon={<Icon name="terminal" />}>运行中的后台命令</CardTitle>
        <p className="text-xs text-muted-foreground">
          已结束的命令会保留一段时间供查看输出（看右侧“状态”区分是否还在跑），之后自动清理。
        </p>
      </CardHeader>
      <CardContent>
        {empty ? (
          <p className="py-4 text-center text-sm text-muted-foreground">命令已清空</p>
        ) : (
        <>
        {/* table-fixed 不能省：默认的 auto 布局下列宽由内容决定，命令列那句 `truncate`
            带的 `white-space:nowrap` 会把该列的 min-content 宽度顶成整条命令的长度，
            单元格拿不到可截断的约束宽度 → 省略号彻底失效，整张表把卡片撑宽，整页出现
            横向滚动，后面的组件被顶出窗口。只加在本实例上，不动共享的 Table 组件。
            它同时也更快：浏览器不需要先量一遍全部内容再定列宽。 */}
        <Table className="cmds table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[80px]">PID</TableHead>
              <TableHead>命令</TableHead>
              <TableHead className="w-[76px]">状态</TableHead>
              <TableHead className="w-[90px]">已运行</TableHead>
              <TableHead className="w-[210px]" />
            </TableRow>
          </TableHeader>
          <TableBody ref={tbodyRef}>
            {commands.map((cmd, i) => (
              <Fragment key={cmd.handle}>
                <TableRow
                  className={`cursor-pointer crow ${i % 2 === 0 ? "bg-muted/20 zebra" : ""}`}
                  onClick={() => toggle(cmd.handle)}
                  onKeyDown={(e) => {
                    // 键盘可达：整行是展开开关（与日志页行展开同一范式）。
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.preventDefault();
                    toggle(cmd.handle);
                  }}
                  tabIndex={0}
                  role="button"
                  aria-expanded={expanded.has(cmd.handle)}
                  title="点击整行任意位置展开/收起输出"
                >
                  <TableCell className="font-mono text-xs">{cmd.pid}</TableCell>
                  <TableCell className="truncate font-mono text-xs" title={cmd.command}>
                    {cmd.command}
                  </TableCell>
                  <TableCell>
                    <CommandStatusBadge running={cmd.running} exitCode={cmd.exitCode} />
                  </TableCell>
                  {/* fixed 布局下列宽不再随内容撑开，不加 nowrap 的话跨天的时长会折行。 */}
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {formatUptime(cmd.elapsedSeconds)}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-nowrap items-center gap-1 whitespace-nowrap">
                      <Button variant="ghost" size="sm" className="whitespace-nowrap" onClick={(e) => { e.stopPropagation(); toggle(cmd.handle); }}>
                        <Icon name={expanded.has(cmd.handle) ? "chevronUp" : "chevronDown"} size={14} />
                        {expanded.has(cmd.handle) ? "收起" : "查看输出"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="whitespace-nowrap text-destructive hover:text-destructive"
                        disabled={stopping.has(cmd.handle)}
                        onClick={(e) => { e.stopPropagation(); stop(cmd.handle, cmd.pid); }}
                      >
                        <Icon name="power" size={14} />
                        {stopping.has(cmd.handle) ? "终止中…" : "终止"}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
                {expanded.has(cmd.handle) && (
                  <TableRow className="bg-muted/5">
                    <TableCell colSpan={5} className="p-0">
                      <CommandOutputPanel handle={cmd.handle} command={cmd.command} />
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            ))}
          </TableBody>
        </Table>
        {danger && (
          <p className="mt-3 flex items-start gap-1.5 text-xs text-destructive">
            <Icon name="alertTriangle" size={13} className="mt-0.5 shrink-0" />
            命令执行已开启，请确认以上进程均来自你信任的会话。
          </p>
        )}
        </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * 后台命令状态徽章：区分“还在跑”/“已成功结束”/“已失败结束”三种状态，
 * 避免用户把处于清理宽限期内的已结束命令误以为还在运行。
 */
function CommandStatusBadge({
  running,
  exitCode,
}: {
  running: boolean;
  exitCode: number | null;
}) {
  if (running) {
    return <Badge variant="default">运行中</Badge>;
  }
  if (exitCode === 0) {
    return <Badge variant="success">已结束</Badge>;
  }
  return (
    <Badge variant="destructive">{exitCode != null ? `失败 (${exitCode})` : "已结束"}</Badge>
  );
}
