import { APP_INFO } from "../../lib/about";
import { Icon } from "../ui/icon";

export function UpdateBrand({ currentVersion, version, ready }: {
  currentVersion?: string; version: string; ready: boolean;
}) {
  const number = version.replace(/^v/, "");
  return <aside className="update-brand" aria-label="升级版本" data-ready={ready || undefined}>
    <span className="update-brand-name">{APP_INFO.name}</span>
    <div className="update-brand-art" aria-hidden="true"><div className="update-logo-slab"><img src="/icon.png" alt="" /></div></div>
    <div className="update-version-origin">{currentVersion ? `v${currentVersion.replace(/^v/, "")}` : "即将体验"}<Icon name="arrowRight" size={14} aria-hidden="true" /><span>升级至</span></div>
    <strong className="update-hero-version" data-long={number.length > 8 || undefined} title={number ? `v${number}` : "新版本"}>{number ? <><span>v</span>{number}</> : "新版本"}</strong>
    <p className="update-brand-caption">更流畅地，<br />把事情做完。</p>
    <span className="update-brand-signature">让每一次协作，更进一步。</span>
  </aside>;
}
