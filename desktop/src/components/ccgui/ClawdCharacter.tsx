import { memo } from "react";
import type { ClawdPose } from "../../lib/ccClawd";
import "./clawd.css";
import type { ClawdRole } from "../../lib/ccClawdIdentity";

/** Fixed vector artwork: state only selects a pose; no model text becomes SVG markup. */
export const ClawdCharacter = memo(function ClawdCharacter({ pose = "idle", staticPose = false, role = "lead", palette, mark = 0 }: { pose?: ClawdPose; staticPose?: boolean; role?: ClawdRole; palette?: number; mark?: number }) {
  return <svg className={`cc-clawd-character${staticPose ? " is-static" : ""}`} data-act={pose} data-role={role} data-palette={palette} data-mark={mark} viewBox="0 0 96 88" aria-hidden="true">
    <ellipse cx="48" cy="78" rx="25" ry="3" fill="currentColor" opacity=".07" />
    <g className="body">
      <g fill="var(--clawd-pet-dark)">
        <path className="leg-l" d="M24 58 Q20 67 24 74 Q27 79 31 74 L34 61Z" />
        <path d="M38 60 L37 73 Q39 80 43 73 L45 61Z" /><path d="M51 61 L53 74 Q57 80 59 73 L59 60Z" />
        <path className="leg-r" d="M64 60 L67 74 Q72 80 75 73 Q78 65 72 57Z" />
      </g>
      <path d="M19 33 Q19 20 34 20 L62 20 Q77 20 78 34 L79 50 Q78 63 63 65 L32 65 Q17 63 17 50Z" fill="currentColor" />
      <path d="M24 30 Q29 24 38 25 L61 25 Q68 25 72 31" fill="none" stroke="var(--clawd-pet-light)" strokeWidth="4" strokeLinecap="round" opacity=".7" />
      <path d="M21 51 Q27 61 40 60 L62 60 Q70 60 75 54 Q71 65 59 65 L34 65 Q23 64 21 55Z" fill="var(--clawd-pet-dark)" opacity=".22" />
      <g fill="currentColor"><path className="hand-l" d="M22 40 Q14 37 11 43 Q7 50 14 54 Q20 57 25 50Z" /><path className="hand-r" d="M73 40 Q82 36 86 43 Q90 49 84 54 Q78 57 72 50Z" /></g>
      <g className="eyes"><g className="eyelids" fill="var(--clawd-face)">
        <ellipse cx="37" cy="42" rx="3.1" ry="5.2" /><ellipse cx="59" cy="42" rx="3.1" ry="5.2" />
        <circle cx="38" cy="40" r=".9" fill="var(--clawd-paper)" /><circle cx="60" cy="40" r=".9" fill="var(--clawd-paper)" />
      </g></g>
      <path className="brows" d="M33 33q4-2 8 0m14 0q4-2 8 0" fill="none" stroke="var(--clawd-face)" strokeWidth="1.4" strokeLinecap="round" opacity=".55" />
      <g fill="var(--clawd-pet-light)" opacity=".5"><ellipse cx="29" cy="50" rx="4" ry="2" /><ellipse cx="68" cy="50" rx="4" ry="2" /></g>
      <path className="mouth" d="M44 52 Q48 55 52 52" stroke="var(--clawd-face)" strokeWidth="1.6" strokeLinecap="round" fill="none" />
      {role === "review" && <g className="clawd-accessory" stroke="var(--clawd-face)" strokeWidth="1.5" fill="none"><rect x="28" y="35" width="17" height="14" rx="4" /><rect x="51" y="35" width="17" height="14" rx="4" /><path d="M45 40h6" /></g>}
      {role === "explore" && <path className="clawd-accessory" d="M24 57q24 10 48 0l-4 8-14-2-7 10-4-10-15 2Z" fill="var(--clawd-paper)" opacity=".8" />}
      {role === "build" && <g className="clawd-accessory" fill="var(--clawd-paper)" opacity=".85"><path d="m15 48 8-4 3 5-8 5Z" /><path d="m72 48 7-4 4 5-8 5Z" /></g>}
      {role === "verify" && <g className="clawd-accessory" stroke="var(--clawd-paper)" strokeWidth="2" fill="none"><path d="m62 29 3 3 5-6" /></g>}
    </g>
    <g className="prop book" stroke="var(--clawd-tool)" strokeWidth="1.7" strokeLinejoin="round">
      <path d="M22 55 Q34 51 48 57 Q61 51 74 55 L73 73 Q60 69 48 75 Q35 69 23 73Z" fill="var(--clawd-paper)" /><path d="M48 57v18" fill="none" />
      <path className="page-line" d="m29 59 12 2m-12 3 12 2m14-5 12-2m-12 7 12-2" opacity=".55" strokeLinecap="round" />
    </g>
    <g className="prop keyboard" stroke="var(--clawd-tool)" strokeWidth="1.7">
      <rect x="21" y="60" width="55" height="16" rx="5" fill="var(--clawd-paper)" /><path d="M28 65h4m4 0h4m4 0h4m4 0h4m4 0h4m4 0h2M35 71h24" strokeLinecap="round" />
    </g>
    <g className="prop terminal" stroke="var(--clawd-tool)" strokeWidth="1.7">
      <rect x="19" y="52" width="59" height="27" rx="5" fill="var(--clawd-paper)" /><path d="m28 61 4 4-4 4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <path className="cursor" d="M39 70h9" stroke="var(--clawd-pet-dark)" strokeLinecap="round" />
    </g>
    <g className="prop thought" fill="var(--clawd-tool)"><circle cx="66" cy="13" r="1.8" /><circle cx="74" cy="10" r="2.1" /><circle cx="83" cy="8" r="2.5" /></g>
    <g className="prop glass" stroke="var(--clawd-tool)" strokeWidth="3.5" strokeLinecap="round"><circle cx="67" cy="56" r="11" fill="var(--clawd-paper)" /><path d="m59 65-9 11" /><path d="M64 51q5-3 8 2" stroke="var(--clawd-pet-light)" strokeWidth="2" fill="none" /></g>
    <g className="prop attention"><rect x="76" y="6" width="15" height="22" rx="7.5" fill="var(--clawd-paper)" /><path d="M83.5 12v6" stroke="var(--clawd-pet-dark)" strokeWidth="2" strokeLinecap="round" /><circle cx="83.5" cy="22" r="1.2" fill="var(--clawd-pet-dark)" /></g>
    <g className="prop tick"><circle cx="80" cy="16" r="10" fill="var(--clawd-paper)" /><path d="m75 16 4 4 7-8" stroke="hsl(var(--success-ink))" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" /></g>
  </svg>;
});
