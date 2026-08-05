import { useState, useEffect } from "react";
import { invoke } from "../../../lib/tauri";
import { Card, CardHeader, CardTitle, CardContent } from "../../ui/card";
import { Button } from "../../ui/button";
import { Icon } from "../../ui/icon";
import { useToast } from "../../ui/toast";
import { SettingsRow } from "../../ui/SettingsRow";
import { isWindows } from "../../../lib/platform";

/* ─── 安装与快捷方式 ─── */

export function InstallGroup({
  platform,
  onReopenOnboarding,
}: {
  /** 用于隐藏「桌面快捷方式」（仅 Windows，见下方注释）。 */
  platform?: string;
  onReopenOnboarding?: () => void;
}) {
  const { toast } = useToast();
  const [dir, setDir] = useState("");
  const [revealing, setRevealing] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    invoke<string>("install_dir")
      .then(setDir)
      .catch(() => setDir(""));
  }, []);

  const handleReveal = async () => {
    setRevealing(true);
    try {
      await invoke("reveal_install_dir");
      toast("已打开安装目录", "success");
    } catch (err) {
      toast(`打开失败：${err}`, "error");
    } finally {
      setRevealing(false);
    }
  };

  const handleCreate = async () => {
    setCreating(true);
    try {
      await invoke("create_desktop_shortcut");
      toast("已创建桌面快捷方式（已覆盖同名项）", "success");
    } catch (err) {
      toast(`创建失败：${err}`, "error");
    } finally {
      setCreating(false);
    }
  };

  return (
    <Card id="set-install">
      <CardHeader>
        <CardTitle icon={<Icon name="package" />}>安装与快捷方式</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <SettingsRow
          label="安装位置"
          sub={<span className="block truncate" title={dir}>{dir || "—"}</span>}
          control={
            <Button
              variant="outline"
              size="sm"
              onClick={handleReveal}
              isLoading={revealing}
              loadingText="打开中..."
              className="gap-1.5 shrink-0"
            >
              <Icon name="folder" size={14} />
              打开目录
            </Button>
          }
        />
        {/* 桌面快捷方式仅 Windows：后端靠 WScript.Shell COM 写 .lnk（靠 powershell），
            mac 上既没有 .lnk 这回事、也没有 powershell——不隐藏的话这个按钮一点就报错。
            mac 的入口是 Dock / 启动台，桌面本来不放应用图标。 */}
        {isWindows(platform) && (
        <SettingsRow
          label="桌面快捷方式"
          sub="误删桌面图标后可一键重建，已存在则覆盖。"
          control={
            <Button
              variant="outline"
              size="sm"
              onClick={handleCreate}
              isLoading={creating}
              loadingText="创建中..."
              className="gap-1.5 shrink-0"
            >
              <Icon name="external" size={14} />
              创建到桌面
            </Button>
          }
        />
        )}
        <SettingsRow
          label="使用引导"
          sub="重新查看首次接入的分步引导。"
          last
          control={
            <Button
              variant="outline"
              size="sm"
              onClick={() => onReopenOnboarding?.()}
              className="gap-1.5 shrink-0"
            >
              <Icon name="info" size={14} />
              重新查看
            </Button>
          }
        />
      </CardContent>
    </Card>
  );
}
