import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "../components/ui/button";
import { Switch } from "../components/ui/switch";
import { Modal } from "../components/ui/Modal";
import { Menu, MenuItem } from "../components/ui/Menu";
import { Collapse } from "../components/ui/Collapse";
import { SavedHint } from "../components/ui/SavedHint";
import { Tabs, TabsContent } from "../components/ui/tabs";
import { ToastProvider, useToast } from "../components/ui/toast";
import { useCountUp } from "../hooks/useCountUp";
import { Icon } from "../components/ui/icon";
import { toggleTheme } from "../lib/theme";
import { transitionPage } from "../lib/pageTransition";
import "../index.css";
import "../interaction-refinements.css";

/** Isolated, real-component preview: never calls IPC or writes app settings. */
function MotionPreview() {
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState(false);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState("connect");
  const [saved, setSaved] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const { toast } = useToast();
  const count = useCountUp(42, { duration: 500 });
  const navigate = (value: string) => transitionPage(() => setTab(value), value !== tab);
  useEffect(() => () => clearTimeout(timer.current), []);
  const save = () => {
    setBusy(true);
    setSaved(false);
    timer.current = setTimeout(() => { setBusy(false); setSaved(true); }, 900);
  };

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div><h1 className="text-lg font-semibold">交互动效预览</h1><p className="mt-1 text-sm text-muted-foreground">复用实际组件 · 示例操作，不连接本地服务</p></div>
        <Button variant="outline" onClick={toggleTheme}>切换主题</Button>
      </header>
      <section className="rounded-xl border bg-card p-5">
        <h2 className="mb-4 text-sm font-semibold">操作与反馈</h2>
        <div className="flex flex-wrap items-center gap-3">
          <Button data-testid="save" className="gap-1.5" isLoading={busy} loadingText="保存中…" onClick={save}>{!busy && <><Icon name="check" size={14} />保存设置</>}</Button>
          <Button data-testid="neighbor" variant="outline">取消</Button>
          <Button disabled>不可用</Button>
          <Switch checked={checked} onChange={setChecked} ariaLabel="显示说明" />
          {saved && <SavedHint>已保存</SavedHint>}
        </div>
        <Collapse open={checked}><p className="pt-4 text-sm text-muted-foreground">开关即时响应，说明随状态展开；关闭后内容不能被键盘访问。</p></Collapse>
      </section>
      <section className="rounded-xl border bg-card p-5">
        <h2 className="mb-4 text-sm font-semibold">弹层与通知</h2>
        <div className="flex flex-wrap items-center gap-3">
          <Button data-testid="modal-trigger" variant="outline" onClick={() => setOpen(v => !v)}>打开弹窗</Button>
          <Menu trigger={(expanded, toggle) => <Button aria-expanded={expanded} variant="outline" onClick={toggle}>更多操作</Button>}>
            {close => <><MenuItem label="复制配置" icon="copy" onClick={() => { toast("已复制", "success"); close(); }} /><MenuItem label="关闭菜单" onClick={close} /></>}
          </Menu>
          <Button variant="outline" onClick={() => toast("设置已保存", "success")}>成功提示</Button>
          <Button variant="outline" onClick={() => toast("连接失败，请检查网络后重试", "error")}>错误提示</Button>
        </div>
      </section>
      <section className="rounded-xl border bg-card p-5">
        <h2 className="mb-4 text-sm font-semibold">页面切换与状态保留</h2>
        <Tabs value={tab} onValueChange={navigate}>
          <div className="mb-3 flex gap-2">
            <Button variant={tab === "connect" ? "secondary" : "ghost"} onClick={() => navigate("connect")}>连接页</Button>
            <Button variant={tab === "settings" ? "secondary" : "ghost"} onClick={() => navigate("settings")}>设置页</Button>
          </div>
          <TabsContent value="connect" keepMounted className="draft-scroll h-32 overflow-auto">
            <label className="text-sm">草稿<input data-testid="draft" className="ml-3 rounded border bg-background px-3 py-2" placeholder="切页后保留输入" /></label>
            <p className="mt-3 text-sm text-muted-foreground">示例指标：<span data-testid="count" className="tabular-nums">{Math.round(count)}</span></p>
            <div className="h-48" aria-hidden="true" />
          </TabsContent>
          <TabsContent value="settings" keepMounted className="h-32"><p className="text-sm text-muted-foreground">切回连接页，草稿与滚动位置仍在。</p></TabsContent>
        </Tabs>
      </section>
      <Modal open={open} onClose={() => setOpen(false)} ariaLabel="连接设置" className="w-full max-w-md rounded-xl modal-surface p-5">
        <h2 className="mb-3 font-semibold">连接设置</h2>
        <p className="mb-5 text-sm text-muted-foreground">按 Esc、点击遮罩或关闭按钮，均以相同节奏退出。</p>
        <div className="flex justify-end gap-2">
          <Menu trigger={(expanded, toggle) => <Button variant="ghost" aria-expanded={expanded} onClick={toggle}>弹窗选项</Button>}>{close => <MenuItem label="返回弹窗" onClick={close} />}</Menu>
          <Button data-testid="modal-close" variant="outline" onClick={() => setOpen(false)}>关闭弹窗</Button><Button onClick={() => toast("连接配置已保存", "success")}>保存配置</Button>
        </div>
      </Modal>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><ToastProvider><MotionPreview /></ToastProvider></StrictMode>);
