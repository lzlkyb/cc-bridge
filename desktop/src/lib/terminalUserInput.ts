import { invoke } from "./tauri";
import { createMotionThrottle, type MotionThrottle } from "./terminalMouseMotion";

type InputInterceptor = (data: string) => boolean;
const interceptors = new Map<string, InputInterceptor>();

/** Observe/buffer user input before IPC; xterm onData observers cannot cancel a send. */
export function interceptTerminalUserInput(sessionId: string, intercept: InputInterceptor): () => void {
  interceptors.set(sessionId, intercept);
  return () => {
    if (interceptors.get(sessionId) === intercept) interceptors.delete(sessionId);
  };
}

/**
 * 每会话一个「鼠标移动削峰器」（见 `lib/terminalMouseMotion.ts`）。
 *
 * 为什么放在这条路口而不是 xterm 的 onData 里：键盘、粘贴、鼠标报告**都**从这里出去，
 * 一处接管就覆盖全部来源；而 onData 的观察者没有取消权（`interceptTerminalUserInput`
 * 的注释就是在说这件事）。
 *
 * 🔴 上限只是防会话 id 无限累积（每次重连都换新 id）。淘汰旧的之前先 dispose，
 * 免得它的定时器在会话已死之后还发一次 `ssh_input`（后端会回「会话不存在」）。
 */
const throttles = new Map<string, MotionThrottle>();
const MAX_THROTTLES = 32;

function throttleFor(sessionId: string): MotionThrottle {
  let throttle = throttles.get(sessionId);
  if (throttle) return throttle;
  if (throttles.size >= MAX_THROTTLES) {
    const oldest = throttles.keys().next().value;
    if (oldest !== undefined) {
      throttles.get(oldest)?.dispose();
      throttles.delete(oldest);
    }
  }
  throttle = createMotionThrottle((pending) => {
    // 削峰路径不 await：调用方（onData）拿不到这条的失败，而鼠标悬停丢一条无感知。
    void invoke("ssh_input", { sessionId, data: pending }).catch(() => {});
  });
  throttles.set(sessionId, throttle);
  return throttle;
}

/**
 * Keyboard, paste, mouse reports and explicit input actions share this route;
 * protocol replies bypass it.
 *
 * 合并高频 SGR 移动报告，减少 IPC 和远端 PTY 写入。
 */
export async function sendTerminalUserInput(sessionId: string, data: string): Promise<void> {
  if (interceptors.get(sessionId)?.(data)) return;
  // null = 已被接管（移动报告：已排队或已丢弃）。否则拿到的是「待发移动报告 + 本条」，
  // 一次 IPC 写完——不能拆成两次 invoke，后端拿的是非公平锁，两次写的顺序不保证。
  const payload = throttleFor(sessionId).push(data);
  if (payload === null) return;
  await invoke("ssh_input", { sessionId, data: payload });
}

/** 会话销毁时释放削峰器（定时器不会在死会话上再发一次）。 */
export function releaseTerminalInputThrottle(sessionId: string): void {
  const throttle = throttles.get(sessionId);
  if (!throttle) return;
  throttle.dispose();
  throttles.delete(sessionId);
}
