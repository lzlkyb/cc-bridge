import { useEffect, useRef } from "react";
import { listen } from "../../../lib/tauri";

interface TrafficEvent {
  connectionId: string;
  at: number;
  toLocal: number;
  toRemote: number;
}

export interface TunnelTrafficSample {
  toLocal: number;
  toRemote: number;
  lastAt: number;
}

interface TunnelStatusEvent {
  connectionId: string;
  state: string;
}

const pulseFrames: Keyframe[] = [
  { strokeDashoffset: "10", opacity: 0 },
  { opacity: 1, offset: 0.12 },
  { opacity: 1, offset: 0.76 },
  { strokeDashoffset: "-100", opacity: 0 },
];
const pulseDuration = 900;

export function TunnelTrafficPulses({ connectionId, motion = true, onSample }: {
  connectionId: string;
  motion?: boolean;
  onSample?: (sample: TunnelTrafficSample) => void;
}) {
  const toLocalPath = useRef<SVGPathElement>(null);
  const toRemotePath = useRef<SVGPathElement>(null);

  useEffect(() => {
    const paths = [toLocalPath.current, toRemotePath.current] as const;
    const animations: Array<Animation | undefined> = [];
    const unlisten: Array<() => void> = [];
    const runtimeId = `stable:${connectionId}`;
    let disposed = false;
    let ready = true;
    let notBefore = Date.now();
    let sampleTimer: ReturnType<typeof setTimeout> | undefined;
    let sample: TunnelTrafficSample = { toLocal: 0, toRemote: 0, lastAt: 0 };
    const lastActivity = [0, 0];

    const clear = () => {
      animations.forEach(animation => animation?.cancel());
      animations.length = 0;
      clearTimeout(sampleTimer);
      sampleTimer = undefined;
      sample = { toLocal: 0, toRemote: 0, lastAt: 0 };
      lastActivity.fill(0);
    };
    const remember = (stop: () => void) => {
      if (disposed) stop();
      else unlisten.push(stop);
    };
    const pulse = (index: number) => {
      const path = paths[index];
      // Dense streams share one glow per direction, with no queue to replay after idle.
      if (!motion || !path?.animate || animations[index]?.playState === "running") return;
      const animation = path.animate(pulseFrames, { duration: pulseDuration, easing: "linear" });
      animations[index] = animation;
      animation.onfinish = () => {
        // Sustain visible flow only while new bytes keep arriving; never replay an idle queue.
        if (!disposed && ready && Date.now() - lastActivity[index] < 350) pulse(index);
      };
    };
    const flush = () => {
      sampleTimer = undefined;
      if (disposed || !ready) return;
      onSample?.(sample);
      const hadBytes = sample.toLocal > 0 || sample.toRemote > 0;
      sample = { ...sample, toLocal: 0, toRemote: 0 };
      if (hadBytes) sampleTimer = setTimeout(flush, 1000);
    };

    void listen<TunnelStatusEvent>("ssh_tunnel_status", event => {
      if (disposed || event.connectionId !== runtimeId) return;
      const nextReady = event.state === "up";
      if (ready !== nextReady) notBefore = Date.now();
      ready = nextReady;
      if (!ready) clear();
    }).then(remember).catch(() => {});

    void listen<TrafficEvent>("stable_tunnel_traffic", event => {
      if (disposed || !ready || event.connectionId !== connectionId
        || event.at < notBefore || Date.now() - event.at > 1000) return;
      if (event.toLocal <= 0 && event.toRemote <= 0) return;
      sample = { toLocal: sample.toLocal + event.toLocal, toRemote: sample.toRemote + event.toRemote, lastAt: event.at };
      if (!sampleTimer) sampleTimer = setTimeout(flush, 1000);
      if (event.toLocal > 0) { lastActivity[0] = Date.now(); pulse(0); }
      if (event.toRemote > 0) { lastActivity[1] = Date.now(); pulse(1); }
    }).then(remember).catch(() => {});

    return () => {
      disposed = true;
      clear();
      unlisten.forEach(stop => stop());
    };
  }, [connectionId, motion, onSample]);

  return <g aria-hidden="true" data-traffic-motion={motion}>
    <path ref={toLocalPath} className="tunnel-route-pulse" pathLength="100"
      d="M0 23C24 23 24 7 52 7H148C176 7 176 23 200 23"/>
    <path ref={toRemotePath} className="tunnel-route-pulse" pathLength="100"
      d="M200 23C176 23 176 39 148 39H52C24 39 24 23 0 23"/>
  </g>;
}
