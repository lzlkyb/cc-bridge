import { useState, useRef, useEffect } from "react";
import type { StatusResponse } from "../../../lib/types";
import { buildDisplayHost } from "../../../lib/utils";
import { Button } from "../../ui/button";
import { Icon } from "../../ui/icon";

type TestState = "idle" | "testing" | "ok" | "fail";

/**
 * 引导第 4 步：本机自检。
 * 从本机直接探测 cc-bridge 的 /health，验证服务在跑、令牌有效。
 * 注意：这是本机探测，无法替代远程连通性——若此处通过但远程连不上，通常是 VPN/防火墙问题。
 */
export function StepTest({
  status,
  selectedIp,
  onTested,
}: {
  status?: StatusResponse;
  selectedIp: string;
  /** H3：本步完成态——自检通过后上报，供向导显示“已完成”。 */
  onTested?: () => void;
}) {
  const [state, setState] = useState<TestState>("idle");
  const [detail, setDetail] = useState("");
  // 保存未完成的自检请求/定时器，组件卸载时中止，避免汄漏 + 卸载后 setState 警告。
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const displayHost = buildDisplayHost(status, selectedIp);
  // 本机探测：监听全网卡(0.0.0.0)或未选地址时回退到 127.0.0.1。
  const probeHost = displayHost && displayHost !== "0.0.0.0" ? displayHost : "127.0.0.1";
  const port = status?.port ?? 7823;
  const token = status?.token ?? "";

  const runTest = async () => {
    setState("testing");
    setDetail("");
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const timer = setTimeout(() => ctrl.abort(), 5000);
    timerRef.current = timer;
    try {
      const res = await fetch(`http://${probeHost}:${port}/health`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: ctrl.signal,
      });
      const text = await res.text();
      let ok = false;
      try {
        ok = JSON.parse(text)?.status === "ok";
      } catch {
        /* 非 JSON 响应，按失败处理 */
      }
      if (!mountedRef.current) return; // 组件已卸载，不再 setState
      if (res.ok && ok) {
        setState("ok");
        onTested?.();
        setDetail(
          "服务正常监听，连接命令里的地址与令牌有效。到远程服务器执行连接命令后，Claude Code 即可连回本机读写文件。",
        );
      } else {
        setState("fail");
        setDetail(`服务返回异常（HTTP ${res.status}）。请确认服务已启动、令牌未过期。`);
      }
    } catch {
      if (mountedRef.current) {
        setState("fail");
        setDetail("无法连接到本机服务。请确认已点击「启动服务」，且端口未被占用。");
      }
    } finally {
      clearTimeout(timer);
      timerRef.current = null;
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm leading-relaxed text-muted-foreground">
        点下方按钮，本机直接探测 cc-bridge 服务是否就绪、令牌是否有效。这只是本机自检——若此处通过但远程连不上，通常是 VPN / 防火墙问题，请检查网络连通性。
      </p>

      <Button onClick={runTest} disabled={state === "testing"} className="w-full">
        {state === "testing" ? (
          <Icon name="spinner" size={16} className="animate-spin" />
        ) : (
          <Icon name="plug" size={16} />
        )}
        {state === "testing" ? "测试中…" : "测试连接"}
      </Button>

      {state === "ok" && (
        <div className="flex items-start gap-2 rounded-lg border border-success/30 bg-success/10 p-3 text-sm text-success">
          <Icon name="check" size={16} className="mt-0.5 shrink-0" />
          <span>{detail}</span>
        </div>
      )}
      {state === "fail" && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          <Icon name="alertTriangle" size={16} className="mt-0.5 shrink-0" />
          <span>{detail}</span>
        </div>
      )}
    </div>
  );
}
