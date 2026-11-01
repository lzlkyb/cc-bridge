import { useEffect, useRef, useState, type RefObject } from "react";
import type { CcView } from "../../lib/ccReducer";
import type { ClawdActivity } from "../../lib/ccClawd";
import { isAgentTask, taskActive } from "../../lib/ccAgentTasks";
import { findClawdMessage, useClawdMotion } from "../../hooks/useClawdMotion";
import { ClawdCharacter } from "./ClawdCharacter";
import { useClawdPreference } from "../../hooks/useClawdPreference";
import { ClawdTeam } from "./ClawdTeam";
import { ClawdRosterSlot } from "./CcConversationLayout";
import { useClawdTaskStop, type StopTask } from "../../hooks/useClawdTaskStop";

export function ClawdWorkspace({ view, activity, scrollRef, rootRef, startedAt, onStopTask }: {
  view: CcView; activity: ClawdActivity; scrollRef: RefObject<HTMLDivElement>;
  rootRef: RefObject<HTMLDivElement>; startedAt: number | null;
  onStopTask?: StopTask;
}) {
  const homeRef = useRef<HTMLDivElement>(null), petRef = useRef<HTMLButtonElement>(null);
  const [records, setRecords] = useState(false);
  const { reduced, toggle } = useClawdPreference(rootRef);
  const taskStop = useClawdTaskStop(onStopTask);
  const [now, setNow] = useState(Date.now);
  const [celebrate, setCelebrate] = useState(false);
  const wasBusy = useRef(activity.busy);
  useEffect(() => {
    // Restored history is already complete: only celebrate a live transition.
    setCelebrate(wasBusy.current && activity.pose === "complete");
    wasBusy.current = activity.busy;
    const timer = setTimeout(() => setCelebrate(false), 700);
    return () => clearTimeout(timer);
  }, [activity.pose, activity.busy]);
  const wave = useRef<ReturnType<typeof setTimeout>>();
  useClawdMotion({ rootRef, scrollRef, homeRef, petRef, targetId: activity.targetId, reduced });
  useEffect(() => {
    if (!activity.busy) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const visibility = () => {
      clearInterval(timer);
      if (!document.hidden && rootRef.current?.getClientRects().length) { setNow(Date.now()); timer = setInterval(() => setNow(Date.now()), 1000); }
    };
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(visibility);
    if (rootRef.current) observer?.observe(rootRef.current);
    visibility(); document.addEventListener("visibilitychange", visibility);
    return () => { clearInterval(timer); observer?.disconnect(); document.removeEventListener("visibilitychange", visibility); };
  }, [activity.busy, rootRef]);
  useEffect(() => () => clearTimeout(wave.current), []);

  const locate = (id = activity.targetId) => {
    const target = findClawdMessage(scrollRef.current, id);
    if (!target) { setRecords(true); return; }
    setRecords(false);
    scrollRef.current?.dispatchEvent(new Event("cc-reading-jump"));
    // Completed tools can live inside a collapsed execution group.
    const group = target.closest("details");
    if (group instanceof HTMLDetailsElement) group.open = true;
    const disclosure = target.querySelector<HTMLButtonElement>("button[aria-expanded='false']");
    if (!target.querySelector("[data-cc-approval-focus]")) disclosure?.click();
    target.scrollIntoView({ block: "center", behavior: "instant" });
    const focus = target.querySelector<HTMLButtonElement>("[data-cc-approval-focus]") ?? target.querySelector<HTMLButtonElement>("button");
    focus?.focus({ preventScroll: true });
  };
  const interact = () => {
    if (activity.pose === "idle" || activity.pose === "stopped") {
      if (!petRef.current) return;
      petRef.current.dataset.wave = "true"; clearTimeout(wave.current);
      wave.current = setTimeout(() => { if (petRef.current) petRef.current.dataset.wave = "false"; }, 1300);
    } else locate();
  };
  const agents = Object.values(view.tasks ?? {}).filter(isAgentTask);
  const running = agents.filter(taskActive).length;
  const completed = agents.filter(task => task.status === "completed").length;
  const failed = agents.filter(task => task.status === "failed" || task.status === "unknown").length;
  const lastUser = view.messages.map(message => message.kind).lastIndexOf("user");
  const tools = view.messages.slice(view.activityStartIndex ?? Math.max(0, lastUser)).filter(m => m.kind === "tool");
  const closeDetails = () => { setRecords(false); petRef.current?.focus(); };
  useEffect(() => {
    if (!records) return;
    const key = (event: KeyboardEvent) => {
      if (rootRef.current?.closest("[data-cc-panel]")?.classList.contains("hidden")) return;
      if (event.key === "Escape") { event.preventDefault(); setRecords(false); petRef.current?.focus(); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [records, rootRef]);
  return <>
    <button type="button" className="cc-clawd-companion" ref={petRef} aria-label={`Clawd：${activity.label}，${activity.pose === "idle" || activity.pose === "stopped" ? "点击打招呼" : "点击查看"}`} onClick={interact}>
      <ClawdCharacter pose={activity.pose} staticPose={activity.pose === "complete" && !celebrate} />
      <span className="cc-clawd-bubble" aria-hidden="true">{activity.label} · {activity.pose === "idle" || activity.pose === "stopped" ? "点击打招呼" : "点击查看"}</span>
    </button>
    <section className="cc-clawd-dock" data-busy={activity.busy} data-pose={activity.pose} aria-label="Clawd 工作搭档">
      <div className="cc-clawd-status">
        <div className="cc-clawd-home" ref={homeRef} aria-hidden="true" />
        <div className="cc-clawd-copy">
          <div className="cc-clawd-label" role="status" aria-live="polite">{activity.label}</div>
          {activity.busy || activity.pose === "error" || activity.pose === "stopped" ? <div className="cc-clawd-note" title={activity.note}>{activity.note}</div> : null}
          {activity.busy && startedAt !== null && <div className="cc-clawd-note" aria-hidden="true">本轮 {Math.max(0, Math.floor((now - startedAt) / 1000))} 秒</div>}
        </div>
        <div className="cc-clawd-actions">
          {(tools.length > 0 || activity.targetId) && <button type="button" className="cc-clawd-detail" onClick={() => { if (["editing", "approval", "question"].includes(activity.pose)) locate(); else { setRecords(!records); } }}>{activity.pose === "editing" ? "查看修改" : activity.pose === "approval" || activity.pose === "question" ? "查看请求" : "执行记录"}</button>}
          <details className="cc-clawd-preferences"><summary aria-label="Clawd 动态设置">动态</summary><button type="button" aria-label="减少 Clawd 动态效果" aria-pressed={reduced} onClick={toggle}>{reduced ? "恢复动态" : "减少动态"}</button></details>
        </div>
      </div>
      {records && <aside className="cc-clawd-inspector" aria-label="本轮执行记录">
        <div className="cc-clawd-inspector-heading"><strong>本轮执行记录</strong><button type="button" className="cc-clawd-toggle" onClick={closeDetails}>关闭</button></div>
      {records && <div className="cc-clawd-records" aria-label="最近执行记录">
        <button type="button" className="cc-clawd-toggle" onClick={() => setRecords(false)}>收起记录</button>
        {tools.length ? tools.map(m => m.kind === "tool" && <div key={m.id}><button type="button" className="cc-clawd-toggle" onClick={() => locate(m.id)}>{m.tool.name}</button><small>{m.tool.status === "ok" ? "已完成" : m.tool.status === "error" ? "未成功" : view.running ? "运行中" : "尚无结果"}</small></div>) : <div>尚无工具记录</div>}
      </div>}
      </aside>}
    </section>
    {agents.length > 0 && <ClawdRosterSlot><aside className="cc-clawd-roster" aria-label="协作小队" data-clawd-reduced={reduced}>
      <div className="cc-clawd-roster-heading"><strong>协作小队</strong><span>{agents.length} 位成员</span></div>
      <p className="cc-clawd-roster-summary">{running} 项运行中 · {completed} 项完成 · {failed} 项需处理</p>
      <ClawdTeam tasks={view.tasks ?? {}} onLocate={locate} onStop={onStopTask ? taskStop.stop : undefined} feedback={taskStop.feedback} />
    </aside></ClawdRosterSlot>}
  </>;
}
