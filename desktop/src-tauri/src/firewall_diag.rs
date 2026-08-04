//! 防火墙结构化诊断（Windows）。
//!
//! 旧实现只回答「有没有一条像样的 allow 规则」，会在三种情况下给出「假绿」：
//! 1. 规则只覆盖 Public 配置文件，而当前网络是 域/专用 → 规则根本没生效；
//! 2. 规则 `program=` 指向已失效的旧安装路径 → 废规则；
//! 3. 存在 Block 规则（安全警报弹窗点了「取消」会自动生成）→ Block 优先于 Allow。
//!
//! 本模块用 PowerShell 的 NetSecurity cmdlet 取回结构化事实（配置文件状态、当前网络类别、
//! 与本端口相关的全部入站规则），在 Rust 侧做判定并产出可执行的问题清单。
//! netsh 文本解析仅作为 PowerShell 不可用时的兜底（见 `firewall::query_firewall_state`）。

use serde::Serialize;
// `Deserialize` 仅被 `PsProfile` / `PsOut` 的 derive 使用，而那两个 struct 是
// PowerShell 输出解析专属、已限定 cfg(windows)。故此 import 同样要限定平台，
// 否则 mac 上是 unused import —— clippy -D warnings 会判错。
#[cfg(windows)]
use serde::Deserialize;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

// ─── 回传前端的诊断模型 ─────────────────────────────────────────────

/// 一条与本端口相关的入站规则摘要。
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RuleInfo {
    pub name: String,
    /// `Allow` | `Block`。
    pub action: String,
    /// 规则覆盖的配置文件，如 `Any` / `Public` / `Domain, Private`。
    pub profiles: String,
    /// 规则绑定的程序路径；`None` = 不限程序（对任何进程生效）。
    pub program: Option<String>,
    pub local_port: String,
    pub enabled: bool,
}

/// 单个防火墙配置文件（域 / 专用 / 公用）的状态。
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInfo {
    /// `Domain` | `Private` | `Public`。
    pub name: String,
    /// 该配置文件下防火墙是否开启。
    pub enabled: bool,
    /// 默认入站动作是否为「阻止」（绝大多数系统为 true）。
    pub default_inbound_block: bool,
    /// 是否允许本地规则生效。域策略可将其设为 false —— 此时本机加多少规则都无效。
    pub allow_local_rules: bool,
    /// 当前网络连接是否落在此配置文件（判断规则有没有生效的关键）。
    pub active: bool,
    /// 该配置文件下本端口入站是否真的通。
    pub covered: bool,
}

/// 结构化问题项。前端按 `code` 渲染文案与操作按钮，不靠字符串匹配。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    /// 见模块文档中的问题码表：firewallOff / noRule / profileGap / blockRule /
    /// staleRule / duplicateRule / localPolicyBlocked / probeUnavailable。
    pub code: String,
    /// 面向用户的具体描述（已含涉事配置文件名 / 规则名）。
    pub detail: String,
    /// 是否能被「一键修复」解决。false 的项需要用户或 IT 介入。
    pub fixable: bool,
}

/// 完整诊断结果。
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FirewallDiagnosis {
    pub port: u16,
    /// 当前可执行文件路径（规则 `program=` 的比对基准）。
    pub exe: String,
    /// 当前活动配置文件下防火墙是否开启；None = 无法判断。
    pub enabled: Option<bool>,
    /// 最终结论：本端口入站是否真的放行；None = 无法判断。
    pub port_open: Option<bool>,
    pub profiles: Vec<ProfileInfo>,
    /// 当前网络落在的配置文件名列表（可能多张网卡分属不同类别）。
    pub active_profiles: Vec<String>,
    /// 命中本端口、且对本程序生效的 Allow 规则。
    pub allow_rules: Vec<RuleInfo>,
    /// 命中本端口、且对本程序生效的 Block 规则（优先级高于 Allow）。
    pub block_rules: Vec<RuleInfo>,
    /// 命中本端口、但 `program=` 指向别的 cc-bridge 路径的废规则。
    pub stale_rules: Vec<RuleInfo>,
    pub issues: Vec<Issue>,
    /// 诊断来源：`powershell` | `netsh` | `unavailable`。
    pub source: String,
}

impl FirewallDiagnosis {
    /// 是否存在可被「一键修复」处理的问题。
    pub fn has_fixable(&self) -> bool {
        self.issues.iter().any(|i| i.fixable)
    }

    /// 需要提权删除的规则名（阻止规则 + 废规则 + 重复规则）。
    /// 只包含 ASCII 名，非 ASCII 名交由前端以手动命令提示（批处理文件编码不可控）。
    ///
    /// 注意 netsh 按名删除会删掉**同名的全部规则**（安全警报弹窗建的规则常是 TCP+UDP 成对、
    /// 同名且可能指向不同路径）。这是可接受的：删完立即会写入我们自己那条正确规则，
    /// 覆盖不会断；且 `is_ours` 已把范围限在名字或程序路径含 `cc-bridge` 的规则上，不会误删别人的。
    pub fn removable_rule_names(&self) -> Vec<String> {
        let mut names: Vec<String> = Vec::new();
        for r in self.block_rules.iter().chain(self.stale_rules.iter()) {
            if is_batch_safe(&r.name) && !names.contains(&r.name) {
                names.push(r.name.clone());
            }
        }
        names
    }
}

/// 规则名能否安全嵌入批处理文件。
///
/// 两道限制：
/// 1. 仅 ASCII 可见字符——批处理文件的解析编码取决于系统代码页，中文规则名写进去会乱码；
/// 2. 不含 cmd 元字符——规则名来自系统枚举（可能是任意第三方写入的），不能让它拼出额外命令。
///
/// 圆括号不在禁用列表：名字已被双引号包裹，且脚本里没有 if/for 块，括号无害；
/// 而我们自己的规则名 `cc-bridge (7823/TCP)` 就带括号。
pub fn is_batch_safe(name: &str) -> bool {
    !name.is_empty()
        && name.chars().all(|c| c.is_ascii_graphic() || c == ' ')
        && !name.chars().any(|c| "\"%&|<>^".contains(c))
}

// ─── PowerShell 侧原始事实 ──────────────────────────────────────────

#[cfg(windows)]
#[derive(Debug, Deserialize)]
struct PsProfile {
    name: String,
    enabled: bool,
    #[serde(rename = "defaultInboundBlock")]
    default_inbound_block: bool,
    #[serde(rename = "allowLocalRules")]
    allow_local_rules: bool,
}

#[cfg(windows)]
#[derive(Debug, Deserialize)]
struct PsOut {
    #[serde(default)]
    profiles: Vec<PsProfile>,
    #[serde(default)]
    active: Vec<String>,
}

#[cfg(windows)]
/// 一条入站规则的原始字段（值已归一化为英文枚举）。来源：netsh verbose 文本。
///
/// 为何不用 PowerShell 的 `Get-NetFirewallPortFilter`：它的**批量枚举在普通权限下会被
/// Access denied 截断**。实机实测：876 条入站规则只拿到 610 个端口过滤器，462 条（53%）
/// 关联不上，且恰好包含全部 cc-bridge 自己的规则（它们是安全警报弹窗创建的每用户规则）。
/// 要命的是失败还是**静默**的（`-ErrorAction SilentlyContinue` 后只得到部分结果），
/// 会直接得出错结论（明明有规则却报 noRule、有 Block 规则却没看见）。
/// 逐规则关联查询能拿全，但 876 条 × 2 次 CIM 查询太慢；
/// `netsh ... show rule name=all dir=in verbose` 一次调用 3.4s 就能拿全（含程序路径与配置文件）。
#[derive(Debug, Clone, Default)]
struct RawRule {
    name: String,
    /// `Allow` | `Block`。
    action: String,
    /// `Any` 或逗号分隔的 `Domain` / `Private` / `Public`。
    profiles: String,
    /// 规则绑定的程序路径；None = 不限程序。
    program: Option<String>,
    /// `Any` / `7823` / `7800-7900` / 逗号列表。
    local_port: String,
    /// `TCP` / `UDP` / `Any` / 协议号。
    protocol: String,
    enabled: bool,
}

// ─── 规则身份 ───────────────────────────────────────────────────────

/// 我们写入的规则名（带端口）。带端口是为了改端口时能精确删旧建新，
/// 而不是像旧版固定用 `cc-bridge` 那样把不同端口的规则混在一个名字下。
pub fn rule_name(port: u16) -> String {
    format!("cc-bridge ({port}/TCP)")
}

/// v2.3.18 及更早版本写入的固定规则名（无 profile、不幂等、会重复累积）。
/// 修复时一并清除，避免残留规则让诊断产生「假绿」。
pub const LEGACY_RULE_NAME: &str = "cc-bridge";

// ─── 提权修复脚本 ───────────────────────────────────────────────────

/// 构造「一键修复」的提权批处理内容：先清理（旧名 / 阻止 / 废 / 重复规则），再写入正确规则。
///
/// 关键差异（对比旧版单条 add rule）：
/// - `profile=any`：一条规则同时覆盖 域/专用/公用。旧版省略 profile，实测只落到 Public，
///   当前网络是 域 或 专用 时规则完全不生效 —— 这是「必须关防火墙才能用」的直接原因。
/// - `enable=yes`：显式启用，不依赖默认值。
/// - 先 delete 再 add：幂等，重复点击不再堆积规则。
/// - 删除动作全部 `>nul 2>&1` 并忽略退出码（规则不存在时 netsh 返回非 0），
///   最终退出码取自 add rule，因此「修复成功」的判据是新规则真的写进去了。
pub fn build_repair_script(port: u16, exe: &str, remove: &[String]) -> String {
    let mut s = String::from("@echo off\r\n");
    let del = |s: &mut String, name: &str| {
        s.push_str(&format!(
            "netsh advfirewall firewall delete rule name=\"{name}\" dir=in >nul 2>&1\r\n"
        ));
    };
    del(&mut s, LEGACY_RULE_NAME);
    del(&mut s, &rule_name(port));
    for name in remove {
        if is_batch_safe(name) && name != LEGACY_RULE_NAME {
            del(&mut s, name);
        }
    }
    s.push_str(&format!(
        "netsh advfirewall firewall add rule name=\"{}\" dir=in action=allow protocol=TCP \
         localport={port} profile=any enable=yes program=\"{exe}\"\r\n",
        rule_name(port)
    ));
    s.push_str("exit /b %ERRORLEVEL%\r\n");
    s
}

/// 供前端展示 / 复制的等价手动命令（管理员终端执行）。
///
/// 必须带 `program="{exe}"`：与 `build_repair_script` 的「一键修复」保持一致，
/// 只放行本程序，而不是「不限程序」的宽松规则。旧实现漏掉此字段，导致 netsh 损坏走手动路径时
/// 手动命令加的是对所有进程生效的规则，比一键修复更宽松，存在安全隐患。
pub fn manual_command(port: u16, exe: &str) -> String {
    format!(
        "netsh advfirewall firewall add rule name=\"{}\" dir=in action=allow \
         protocol=TCP localport={port} profile=any enable=yes program=\"{exe}\"",
        rule_name(port)
    )
}

// ─── 查询与判定 ─────────────────────────────────────────────────────

/// PowerShell 脚本：只取两件 netsh 给不了的事实 —— 配置文件状态（含
/// `AllowLocalFirewallRules`，域策略屏蔽场景全靠它判）与当前网络类别。
///
/// 规则枚举不在这里做：见 `RawRule` 的说明，`Get-NetFirewallPortFilter` 的批量枚举
/// 在普通权限下会被 Access denied 静默截断，不可用。
#[cfg(windows)]
const PS_DIAG_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$profs = @(Get-NetFirewallProfile | ForEach-Object {
  [pscustomobject]@{
    name = "$($_.Name)"
    enabled = ("$($_.Enabled)" -eq 'True')
    defaultInboundBlock = ("$($_.DefaultInboundAction)" -ne 'Allow')
    allowLocalRules = ("$($_.AllowLocalFirewallRules)" -ne 'False')
  }
})
$active = New-Object System.Collections.ArrayList
try {
  foreach ($c in @(Get-NetConnectionProfile)) {
    $cat = "$($c.NetworkCategory)"
    $name = $null
    if ($cat -eq 'DomainAuthenticated') { $name = 'Domain' }
    elseif ($cat -eq 'Private') { $name = 'Private' }
    elseif ($cat -eq 'Public') { $name = 'Public' }
    if ($name -and -not $active.Contains($name)) { [void]$active.Add($name) }
  }
} catch { }
[pscustomobject]@{
  profiles = $profs
  active = @($active.ToArray())
} | ConvertTo-Json -Depth 6 -Compress
"#;

/// 跑一次 PowerShell 脚本并返回 stdout。脚本写入临时 .ps1 再 `-File` 执行：
/// 避免 `-Command` 长脚本的多层引号转义问题，同时 `-ExecutionPolicy Bypass`
/// 绕开脚本执行策略限制。文件名带 PID，避免多实例并发互相覆盖。
#[cfg(windows)]
fn run_ps_script(script: &str) -> Option<String> {
    let path = std::env::temp_dir().join(format!("cc-bridge-fw-{}.ps1", std::process::id()));
    std::fs::write(&path, script).ok()?;
    let out = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(&path)
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    let _ = std::fs::remove_file(&path);
    let out = out.ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// 启动探测：PowerShell + NetSecurity 模块是否可用。不可用时上层回退 netsh。
#[cfg(windows)]
pub fn probe_powershell_available() -> bool {
    run_ps_script(
        "$ErrorActionPreference='Stop'\nif (Get-Command Get-NetFirewallProfile -ErrorAction SilentlyContinue) { 'ok' } else { exit 1 }\n",
    )
    .map(|s| s.contains("ok"))
    .unwrap_or(false)
}

/// 列举入站规则：`netsh advfirewall firewall show rule name=all dir=in verbose`。
///
/// 细节：
/// - 走 `cmd /c chcp 65001 && netsh …`：强制控制台代码页为 UTF-8，否则中文系统下输出是
///   GBK，`from_utf8_lossy` 会把键名搞成乱码导致解析全失败。
/// - `verbose` 是必需的：不加则不输出「程序」字段，没法判定规则是否指向当前 exe。
#[cfg(windows)]
fn run_netsh_rules() -> Option<String> {
    let out = std::process::Command::new("cmd")
        .args([
            "/c",
            "chcp 65001 >nul && netsh advfirewall firewall show rule name=all dir=in verbose",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// 完整诊断。返回 `None` 表示结构化路径不可用（上层回退到粗粒度 netsh 判定）。
#[cfg(windows)]
pub fn query_diagnosis(port: u16, exe: &str) -> Option<FirewallDiagnosis> {
    let raw = run_ps_script(PS_DIAG_SCRIPT)?;
    let mut value: serde_json::Value = serde_json::from_str(raw.trim()).ok()?;
    // PowerShell 的 ConvertTo-Json 在数组仅 1 个元素时可能塌缩成对象，先规整回数组。
    for key in ["profiles", "active"] {
        let slot = &mut value[key];
        if slot.is_null() {
            *slot = serde_json::Value::Array(Vec::new());
        } else if !slot.is_array() {
            *slot = serde_json::Value::Array(vec![slot.clone()]);
        }
    }
    let out: PsOut = serde_json::from_value(value).ok()?;
    if out.profiles.is_empty() {
        return None;
    }

    // 防火墙关闭短路：若「当前网络所在的全部配置文件」都已关闭，任何入站规则都不可能挡住
    // 端口，无需再跑 ~3.4s 的全量规则枚举。直接给 analyze 传空规则集——其 `enabled==Some(false)`
    // 分支会产出唯一的 firewallOff 问题，不会误报 noRule / blockRule / profileGap 等。
    let rules: Vec<RawRule> = if all_active_profiles_off(&out.profiles, &out.active) == Some(true) {
        Vec::new()
    } else {
        let (blocks, rules) = parse_netsh_rules(&run_netsh_rules()?, port);
        // 一条规则块都没解出来 = 输出格式/编码不对（代码页未生效等）。
        // 此时宁可回退到粗粒度判定，也不能拿空规则集去下「没有任何放行规则」的错结论。
        if blocks == 0 {
            return None;
        }
        rules
    };

    Some(analyze(port, exe, out.profiles, out.active, rules))
}

#[cfg(windows)]
/// 解析 netsh verbose 输出，返回（解出的规则块总数, 命中本端口且为 TCP 的规则）。
///
/// 规则块以「规则名称/Rule Name」行为起点切分，比按空行切分稳（不受空行/CRLF 影响）。
/// 返回块总数是为了让调用方能区分「真的没规则」与「解析失败」——后者必须回退而不是下结论。
fn parse_netsh_rules(text: &str, port: u16) -> (usize, Vec<RawRule>) {
    let mut blocks = 0usize;
    let mut rules: Vec<RawRule> = Vec::new();
    let mut cur: Option<RawRule> = None;

    // 将一个已组装完的规则块收入结果（仅保留 TCP/Any 且命中本端口的）。
    fn flush(cur: Option<RawRule>, port: u16, rules: &mut Vec<RawRule>) {
        let Some(r) = cur else { return };
        let proto_ok = r.protocol.is_empty()
            || r.protocol.eq_ignore_ascii_case("TCP")
            || r.protocol.eq_ignore_ascii_case("Any")
            || r.protocol == "6";
        if proto_ok && port_hit(&r.local_port, port) {
            rules.push(r);
        }
    }

    for line in text.lines() {
        let Some((key, value)) = split_kv(line) else {
            continue;
        };
        match normalize_key(&key).as_str() {
            "rulename" | "规则名称" => {
                flush(cur.take(), port, &mut rules);
                blocks += 1;
                cur = Some(RawRule {
                    name: value,
                    ..Default::default()
                });
            }
            other => {
                let Some(r) = cur.as_mut() else { continue };
                match other {
                    "enabled" | "启用" => r.enabled = is_yes(&value),
                    "action" | "操作" => r.action = norm_action(&value),
                    "profiles" | "配置文件" => r.profiles = norm_profiles(&value),
                    "protocol" | "协议" => r.protocol = norm_any(&value),
                    "localport" | "本地端口" => r.local_port = norm_any(&value),
                    "program" | "程序" => r.program = norm_program(&value),
                    _ => {}
                }
            }
        }
    }
    flush(cur.take(), port, &mut rules);
    (blocks, rules)
}

#[cfg(windows)]
/// 键名归一：去空白 + 小写。netsh 英文输出里有 `Rule Name` / `Edge traversal` 这种带空格的键。
fn normalize_key(key: &str) -> String {
    key.chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_lowercase()
}

#[cfg(windows)]
/// 「是/Yes」→ true。其余（否/No）为 false。
fn is_yes(v: &str) -> bool {
    let v = v.trim();
    v.eq_ignore_ascii_case("yes") || v == "是"
}

#[cfg(windows)]
/// 操作值归一为 `Allow` / `Block`。未识别时原样返回，让上层的匹配自然失败而不是误归类。
fn norm_action(v: &str) -> String {
    let t = v.trim();
    if t.eq_ignore_ascii_case("allow") || t == "允许" {
        "Allow".into()
    } else if t.eq_ignore_ascii_case("block") || t == "阻止" {
        "Block".into()
    } else {
        t.to_string()
    }
}

#[cfg(windows)]
/// 「任何/Any」→ `Any`；其余原样（去空白）。
fn norm_any(v: &str) -> String {
    let t = v.trim();
    if t.eq_ignore_ascii_case("any") || t == "任何" {
        "Any".into()
    } else {
        t.to_string()
    }
}

#[cfg(windows)]
/// 配置文件列表归一：`域,专用,公用` / `Domain,Private,Public` / `任何` → 英文逗号列表或 `Any`。
fn norm_profiles(v: &str) -> String {
    let t = v.trim();
    if t.is_empty() || t.eq_ignore_ascii_case("any") || t == "任何" {
        return "Any".into();
    }
    let parts: Vec<&str> = t
        .split(',')
        .map(|p| {
            let p = p.trim();
            match p {
                "域" => "Domain",
                "专用" => "Private",
                "公用" => "Public",
                other => other,
            }
        })
        .filter(|p| !p.is_empty())
        .collect();
    if parts.is_empty() {
        "Any".into()
    } else {
        parts.join(", ")
    }
}

#[cfg(windows)]
/// 程序字段：`任何/Any/System/空` 视为不限程序（None）。
fn norm_program(v: &str) -> Option<String> {
    let t = v.trim();
    if t.is_empty() || t.eq_ignore_ascii_case("any") || t == "任何" {
        None
    } else {
        Some(t.to_string())
    }
}

#[cfg(windows)]
/// 本地端口字段是否命中目标端口。支持 `Any` / 单值 / 逗号列表 / `a-b` 区间。
fn port_hit(local_port: &str, port: u16) -> bool {
    let lp = local_port.trim();
    if lp.is_empty() || lp.eq_ignore_ascii_case("any") {
        return true;
    }
    let target = port;
    lp.split(',').any(|tok| {
        let t = tok.trim();
        if let Ok(p) = t.parse::<u16>() {
            return p == target;
        }
        if let Some((a, b)) = t.split_once('-') {
            if let (Ok(lo), Ok(hi)) = (a.trim().parse::<u16>(), b.trim().parse::<u16>()) {
                return target >= lo && target <= hi;
            }
        }
        false
    })
}

#[cfg(windows)]
/// 按首个冒号（ASCII 或全角）切分 "键: 值"。错开分隔线与空行。
///
/// 用 `char_indices` 而不是 `find(':') + 1`：全角冒号占 3 字节，按 1 字节切会落在
/// 非字符边界上直接 panic。
fn split_kv(line: &str) -> Option<(String, String)> {
    let (idx, colon) = line.char_indices().find(|(_, c)| *c == ':' || *c == '：')?;
    let key = line[..idx].trim().to_string();
    let val = line[idx + colon.len_utf8()..].trim().to_string();
    if key.is_empty() || key.starts_with('-') {
        return None;
    }
    Some((key, val))
}

#[cfg(not(windows))]
pub fn query_diagnosis(_port: u16, _exe: &str) -> Option<FirewallDiagnosis> {
    None
}

#[cfg(windows)]
/// 规则的 profile 字段是否覆盖某个配置文件。`Any` 覆盖全部。
fn profile_covers(rule_profiles: &str, target: &str) -> bool {
    let rp = rule_profiles.trim();
    if rp.is_empty() || rp.eq_ignore_ascii_case("Any") {
        return true;
    }
    rp.split(',').any(|t| t.trim().eq_ignore_ascii_case(target))
}

#[cfg(windows)]
/// 展开 `%ProgramFiles%` 这类环境变量占位（防火墙规则里常以未展开形式存储）。
fn expand_env(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    let mut rest = path;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) => {
                let name = &after[..end];
                match std::env::var(name) {
                    Ok(v) => out.push_str(&v),
                    // 取不到就原样保留，避免把路径改坏后误判成「不匹配」。
                    Err(_) => {
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                }
                rest = &after[end + 1..];
            }
            None => {
                out.push('%');
                out.push_str(after);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(windows)]
/// Windows 路径等价比较：忽略大小写、统一分隔符、去掉包裹引号并展开环境变量。
fn paths_equal(a: &str, b: &str) -> bool {
    let norm = |s: &str| {
        expand_env(s.trim().trim_matches('"'))
            .replace('/', "\\")
            .to_lowercase()
    };
    norm(a) == norm(b)
}

#[cfg(windows)]
/// 规则是否对「本程序」生效：不限程序的规则同样生效。
fn program_matches(program: &Option<String>, exe: &str) -> bool {
    match program {
        None => true,
        Some(p) => paths_equal(p, exe),
    }
}

#[cfg(windows)]
/// 是否是 cc-bridge 自己的规则（用于判定「废规则」范围，避免误删别人的规则）。
fn is_ours(r: &RawRule, exe: &str) -> bool {
    if r.name.to_lowercase().contains("cc-bridge") {
        return true;
    }
    match &r.program {
        Some(p) => {
            let lower = expand_env(p).to_lowercase();
            lower.contains("cc-bridge") && !paths_equal(p, exe)
        }
        None => false,
    }
}

#[cfg(windows)]
fn to_info(r: &RawRule) -> RuleInfo {
    RuleInfo {
        name: r.name.clone(),
        action: r.action.clone(),
        profiles: r.profiles.clone(),
        program: r.program.clone(),
        local_port: r.local_port.clone(),
        enabled: r.enabled,
    }
}

#[cfg(windows)]
/// 所有「当前网络所在的配置文件」是否都已关闭防火墙。
///
/// 返回 `Some(true)` = 已知且全部关闭（可短路跳过规则枚举）；
/// `Some(false)` = 至少有一个活动配置文件开着；
/// `None` = 无法确定（没有活动配置文件信息，或活动类别对不上任何已知配置文件）。
///
/// 纯函数，便于单测：把短路判断从 `query_diagnosis` 抽出，避开 `#[cfg(windows)]` 带来的测试不可达。
fn all_active_profiles_off(profiles: &[PsProfile], active: &[String]) -> Option<bool> {
    if active.is_empty() {
        return None;
    }
    let active_profiles: Vec<&PsProfile> = profiles
        .iter()
        .filter(|p| active.iter().any(|a| a.eq_ignore_ascii_case(&p.name)))
        .collect();
    if active_profiles.is_empty() {
        return None;
    }
    Some(active_profiles.iter().all(|p| !p.enabled))
}

#[cfg(windows)]
/// 核心判定：把原始事实（配置文件来自 PowerShell、规则来自 netsh）转成结论 + 问题清单。
fn analyze(
    port: u16,
    exe: &str,
    ps_profiles: Vec<PsProfile>,
    ps_active: Vec<String>,
    raw_rules: Vec<RawRule>,
) -> FirewallDiagnosis {
    let is_allow = |r: &RawRule| r.action.eq_ignore_ascii_case("Allow");
    let is_block = |r: &RawRule| r.action.eq_ignore_ascii_case("Block");

    // 当前网络类别取不到时（无网络 / 查询失败），退化为「所有已启用的配置文件」，
    // 宁可多报一个 profileGap，也不要漏报导致用户以为没问题。
    let active: Vec<String> = if ps_active.is_empty() {
        ps_profiles
            .iter()
            .filter(|p| p.enabled)
            .map(|p| p.name.clone())
            .collect()
    } else {
        ps_active.clone()
    };

    let mut profiles: Vec<ProfileInfo> = Vec::new();
    for p in &ps_profiles {
        let allow_hit = raw_rules.iter().any(|r| {
            r.enabled
                && is_allow(r)
                && profile_covers(&r.profiles, &p.name)
                && program_matches(&r.program, exe)
        });
        let block_hit = raw_rules.iter().any(|r| {
            r.enabled
                && is_block(r)
                && profile_covers(&r.profiles, &p.name)
                && program_matches(&r.program, exe)
        });
        // 通的三种情形：该配置文件防火墙关着 / 默认入站就是允许且无阻止规则 / 有允许规则且无阻止规则。
        let covered = !p.enabled || (!block_hit && (!p.default_inbound_block || allow_hit));
        profiles.push(ProfileInfo {
            name: p.name.clone(),
            enabled: p.enabled,
            default_inbound_block: p.default_inbound_block,
            allow_local_rules: p.allow_local_rules,
            active: active.iter().any(|a| a.eq_ignore_ascii_case(&p.name)),
            covered,
        });
    }

    let active_profiles: Vec<&ProfileInfo> = profiles.iter().filter(|p| p.active).collect();
    let enabled = Some(active_profiles.iter().any(|p| p.enabled));
    // 结论取「所有活动配置文件都通」——多网卡分属不同类别时，任一不通都可能让远程连不上。
    let port_open = Some(!active_profiles.is_empty() && active_profiles.iter().all(|p| p.covered));

    let allow_rules: Vec<RuleInfo> = raw_rules
        .iter()
        .filter(|r| is_allow(r) && program_matches(&r.program, exe))
        .map(to_info)
        .collect();
    let block_rules: Vec<RuleInfo> = raw_rules
        .iter()
        .filter(|r| is_block(r) && r.enabled && program_matches(&r.program, exe))
        .map(to_info)
        .collect();
    let stale_rules: Vec<RuleInfo> = raw_rules
        .iter()
        .filter(|r| {
            is_allow(r)
                && r.program.is_some()
                && !program_matches(&r.program, exe)
                && is_ours(r, exe)
        })
        .map(to_info)
        .collect();

    let mut issues: Vec<Issue> = Vec::new();

    if enabled == Some(false) {
        issues.push(Issue {
            code: "firewallOff".into(),
            detail: "当前网络所在的防火墙配置文件已关闭。远程能连入，但本机缺少网络层防护，建议开启防火墙后用下方「一键修复」写入规则。".into(),
            fixable: false,
        });
    }

    if !block_rules.is_empty() {
        let names: Vec<&str> = block_rules.iter().map(|r| r.name.as_str()).collect();
        issues.push(Issue {
            code: "blockRule".into(),
            detail: format!(
                "存在阻止规则「{}」，阻止规则优先级高于允许规则 —— 只要它在，加多少允许规则都不通。这类规则通常是当年 Windows 安全警报弹窗点了「取消」自动生成的。",
                names.join("、")
            ),
            fixable: true,
        });
    }

    // 活动配置文件里没被覆盖的那些，是「必须关防火墙才能用」的真正来源。
    let gap: Vec<&ProfileInfo> = active_profiles
        .iter()
        .copied()
        .filter(|p| p.enabled && !p.covered)
        .collect();
    if !gap.is_empty() && block_rules.is_empty() {
        let names: Vec<String> = gap
            .iter()
            .map(|p| profile_label(&p.name).to_string())
            .collect();
        if allow_rules.is_empty() {
            issues.push(Issue {
                code: "noRule".into(),
                detail: format!(
                    "没有任何放行 {port}/TCP 入站的规则，当前网络（{}）下远程请求会被直接丢弃。",
                    names.join("、")
                ),
                fixable: true,
            });
        } else {
            let covered: Vec<String> = allow_rules
                .iter()
                .filter(|r| r.enabled)
                .map(|r| r.profiles.clone())
                .collect();
            issues.push(Issue {
                code: "profileGap".into(),
                detail: format!(
                    "已有放行规则，但只覆盖 {}，没覆盖当前网络所在的{}。Windows 防火墙规则只在当前活动配置文件下生效，所以规则在、却仍然连不上。",
                    if covered.is_empty() { "（无已启用规则）".to_string() } else { covered.join("、") },
                    names.join("、")
                ),
                fixable: true,
            });
        }
    }

    if !stale_rules.is_empty() {
        let names: Vec<&str> = stale_rules.iter().map(|r| r.name.as_str()).collect();
        issues.push(Issue {
            code: "staleRule".into(),
            detail: format!(
                "有 {} 条规则指向别的 cc-bridge 程序路径（旧安装位置 / 开发版），对当前程序无效，但会让状态检测误判为「已放行」：{}。",
                stale_rules.len(),
                names.join("、")
            ),
            fixable: true,
        });
    }

    let dup = allow_rules.iter().filter(|r| r.enabled).count();
    if dup > 1 {
        issues.push(Issue {
            code: "duplicateRule".into(),
            detail: format!("检测到 {dup} 条重复的放行规则（旧版本每次点「一键开放」都会新增一条）。修复时会合并为一条。"),
            fixable: true,
        });
    }

    for p in &active_profiles {
        if !p.allow_local_rules {
            issues.push(Issue {
                code: "localPolicyBlocked".into(),
                detail: format!(
                    "{}的组策略禁止本地防火墙规则生效（AllowLocalFirewallRules = False）。本机自行添加的规则会被系统忽略，需要由 IT 通过域策略下发放行规则。",
                    profile_label(&p.name)
                ),
                fixable: false,
            });
        }
    }

    FirewallDiagnosis {
        port,
        exe: exe.to_string(),
        enabled,
        port_open,
        active_profiles: active,
        profiles,
        allow_rules,
        block_rules,
        stale_rules,
        issues,
        source: "powershell".into(),
    }
}

/// 配置文件名的中文标签，用于拼装用户可读的提示。
pub fn profile_label(name: &str) -> &str {
    match name.to_lowercase().as_str() {
        "domain" => "「域」网络",
        "private" => "「专用」网络",
        "public" => "「公用」网络",
        _ => "当前网络",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    fn rule(action: &str, profiles: &str, program: Option<&str>) -> RawRule {
        RawRule {
            name: "r".into(),
            action: action.into(),
            profiles: profiles.into(),
            program: program.map(|s| s.to_string()),
            local_port: "7823".into(),
            protocol: "TCP".into(),
            enabled: true,
        }
    }

    #[cfg(windows)]
    fn profs() -> Vec<PsProfile> {
        ["Domain", "Private", "Public"]
            .iter()
            .map(|n| PsProfile {
                name: (*n).to_string(),
                enabled: true,
                default_inbound_block: true,
                allow_local_rules: true,
            })
            .collect()
    }

    const EXE: &str = "C:\\app\\cc-bridge.exe";

    /// 核心回归：规则只覆盖 Public、当前网络是 Private 时，必须判为「不通」+ profileGap。
    /// 旧实现（只看方向/操作/协议/端口）在这里会误报「已放行」。
    #[test]
    #[cfg(windows)]
    fn public_only_rule_does_not_cover_private_network() {
        let d = analyze(
            7823,
            EXE,
            profs(),
            vec!["Private".into()],
            vec![rule("Allow", "Public", Some(EXE))],
        );
        assert_eq!(d.port_open, Some(false));
        assert!(d.issues.iter().any(|i| i.code == "profileGap"));
        assert!(d.has_fixable());
    }

    #[test]
    #[cfg(windows)]
    fn any_profile_rule_covers_private_network() {
        let d = analyze(
            7823,
            EXE,
            profs(),
            vec!["Private".into()],
            vec![rule("Allow", "Any", Some(EXE))],
        );
        assert_eq!(d.port_open, Some(true));
        assert!(d.issues.is_empty());
    }

    /// Block 规则优先于 Allow：两者都在时结论必须是不通。
    #[test]
    #[cfg(windows)]
    fn block_rule_wins_over_allow() {
        let d = analyze(
            7823,
            EXE,
            profs(),
            vec!["Private".into()],
            vec![
                rule("Allow", "Any", Some(EXE)),
                rule("Block", "Any", Some(EXE)),
            ],
        );
        assert_eq!(d.port_open, Some(false));
        assert!(d.issues.iter().any(|i| i.code == "blockRule"));
    }

    /// program= 指向旧路径的规则既不算放行，也要被识别成废规则。
    #[test]
    #[cfg(windows)]
    fn stale_program_path_is_not_coverage() {
        let d = analyze(
            7823,
            EXE,
            profs(),
            vec!["Private".into()],
            vec![rule("Allow", "Any", Some("D:\\old\\cc-bridge.exe"))],
        );
        assert_eq!(d.port_open, Some(false));
        assert!(d.issues.iter().any(|i| i.code == "noRule"));
        assert_eq!(d.stale_rules.len(), 1);
    }

    /// 域策略禁止本地规则时，即使规则齐全也要给出不可修复提示。
    #[test]
    #[cfg(windows)]
    fn local_policy_blocked_is_reported_unfixable() {
        let mut ps = profs();
        ps[1].allow_local_rules = false;
        let d = analyze(
            7823,
            EXE,
            ps,
            vec!["Private".into()],
            vec![rule("Allow", "Any", None)],
        );
        let issue = d
            .issues
            .iter()
            .find(|i| i.code == "localPolicyBlocked")
            .expect("应报告组策略限制");
        assert!(!issue.fixable);
    }

    /// 短路判定：当前活动配置文件全部关闭 → Some(true)，可跳过规则枚举。
    #[test]
    #[cfg(windows)]
    fn all_active_off_true_when_every_active_profile_disabled() {
        let mut ps = profs(); // Domain/Private/Public 全 enabled=true
        ps[1].enabled = false; // 仅当前活动 Private 关闭
        assert_eq!(
            all_active_profiles_off(&ps, &["Private".into()]),
            Some(true)
        );
    }

    /// 多个活动配置中只要有一个开着 → Some(false)，仍需完整检测。
    #[test]
    #[cfg(windows)]
    fn all_active_off_false_when_any_active_enabled() {
        let mut ps = profs();
        ps[1].enabled = false; // Private 关
        ps[2].enabled = false; // Public 关，Domain 仍开
                               // 活动含 Domain（开着）→ 不算全关，仍需完整检测
        assert_eq!(
            all_active_profiles_off(&ps, &["Domain".into(), "Private".into()]),
            Some(false)
        );
    }

    /// 活动配置全部关闭即为短路，即便某个不活动的配置开着也不影响。
    #[test]
    #[cfg(windows)]
    fn all_active_off_true_ignores_inactive_enabled_profile() {
        let mut ps = profs();
        ps[1].enabled = false; // Private 关
        ps[2].enabled = false; // Public 关，Domain 仍开
                               // 活动只有 Private+Public（都关），Domain 虽开着但不活动 → 算全关，可短路
        assert_eq!(
            all_active_profiles_off(&ps, &["Private".into(), "Public".into()]),
            Some(true)
        );
    }

    /// 无活动配置文件信息（或活动类别对不上）→ None，不能贸然判定关闭。
    #[test]
    #[cfg(windows)]
    fn all_active_off_none_when_no_active_info() {
        assert_eq!(all_active_profiles_off(&profs(), &[]), None);
        assert_eq!(all_active_profiles_off(&profs(), &["Foo".into()]), None);
    }

    #[test]
    fn repair_script_writes_profile_any_and_is_idempotent() {
        let s = build_repair_script(7823, EXE, &["cc-bridge.exe".into()]);
        assert!(s.contains("profile=any"), "必须显式写 profile=any");
        assert!(s.contains("enable=yes"));
        assert!(
            s.contains("delete rule name=\"cc-bridge\""),
            "须清理旧版固定名规则"
        );
        assert!(
            s.contains("delete rule name=\"cc-bridge.exe\""),
            "须清理传入的废规则"
        );
        assert!(s.trim_end().ends_with("exit /b %ERRORLEVEL%"));
    }

    /// 手动命令必须与一键修复一致：带 `program=` 只放行本程序，而不是「不限程序」的宽松规则。
    #[test]
    fn manual_command_includes_program_and_profile() {
        let cmd = manual_command(7823, "C:\\app\\cc-bridge.exe");
        assert!(cmd.contains("profile=any"), "手动命令必须覆盖全部配置文件");
        assert!(
            cmd.contains("program=\"C:\\app\\cc-bridge.exe\""),
            "手动命令必须绑定本程序路径，与 build_repair_script 一致"
        );
        assert!(
            cmd.starts_with("netsh advfirewall firewall add rule"),
            "命令结构不被破坏"
        );
    }

    #[test]
    fn batch_safety_rejects_metacharacters() {
        assert!(
            is_batch_safe("cc-bridge (7823/TCP)"),
            "自家规则名（带括号）必须被接受"
        );
        assert!(is_batch_safe("cc-bridge.exe"));
        assert!(!is_batch_safe("evil&calc"));
        assert!(!is_batch_safe("规则名"));
    }

    #[test]
    #[cfg(windows)]
    fn env_vars_in_program_path_are_expanded() {
        std::env::set_var("CCB_TEST_DIR", "C:\\app");
        assert!(paths_equal(
            "%CCB_TEST_DIR%\\cc-bridge.exe",
            "C:\\App\\cc-bridge.exe"
        ));
    }

    // ─── netsh verbose 解析 ──────────────────────────────────

    /// 英文 locale（chcp 65001 下实测就是英文键名）。
    #[cfg(windows)]
    const NETSH_EN: &str = concat!(
        "\r\nRule Name:                            cc-bridge (7823/TCP)\r\n",
        "----------------------------------------------------------------------\r\n",
        "Enabled:                              Yes\r\n",
        "Direction:                            In\r\n",
        "Profiles:                             Domain,Private,Public\r\n",
        "Grouping:                             \r\n",
        "LocalIP:                              Any\r\n",
        "RemoteIP:                             Any\r\n",
        "Protocol:                             TCP\r\n",
        "LocalPort:                            7823\r\n",
        "RemotePort:                           Any\r\n",
        "Edge traversal:                       Defer to user\r\n",
        "Program:                              D:\\soft\\cc-bridge\\cc-bridge.exe\r\n",
        "InterfaceTypes:                       Any\r\n",
        "Security:                             NotRequired\r\n",
        "Rule source:                          Local Setting\r\n",
        "Action:                               Allow\r\n\r\n",
        "Rule Name:                            Other UDP rule\r\n",
        "----------------------------------------------------------------------\r\n",
        "Enabled:                              Yes\r\n",
        "Profiles:                             Public\r\n",
        "Protocol:                             UDP\r\n",
        "LocalPort:                            7823\r\n",
        "Program:                              Any\r\n",
        "Action:                               Allow\r\n",
    );

    /// 中文 locale（GBK 控制台，键名与值都是中文）。
    #[cfg(windows)]
    const NETSH_ZH: &str = concat!(
        "\r\n规则名称:                             cc-bridge\r\n",
        "----------------------------------------------------------------------\r\n",
        "启用:                                 是\r\n",
        "方向:                                 入\r\n",
        "配置文件:                             公用\r\n",
        "协议:                                 TCP\r\n",
        "本地端口:                             任何\r\n",
        "程序:                                 D:\\soft\\cc-bridge\\cc-bridge-desktop.exe\r\n",
        "操作:                                 允许\r\n",
    );

    #[test]
    #[cfg(windows)]
    fn parses_english_netsh_output() {
        let (blocks, rules) = parse_netsh_rules(NETSH_EN, 7823);
        assert_eq!(blocks, 2, "两个规则块都应被识别");
        // UDP 那条必须被滤掉——它不影响 TCP 入站放行。
        assert_eq!(rules.len(), 1, "只应保留 TCP 规则");
        let r = &rules[0];
        assert_eq!(r.name, "cc-bridge (7823/TCP)");
        assert_eq!(r.action, "Allow");
        assert_eq!(r.profiles, "Domain, Private, Public");
        assert_eq!(r.local_port, "7823");
        assert!(r.enabled);
        assert_eq!(
            r.program.as_deref(),
            Some("D:\\soft\\cc-bridge\\cc-bridge.exe")
        );
    }

    /// 中文键名与中文值都要能解析——旧 netsh 解析只认中文，英文系统全漏；
    /// 这里两个方向都锁住。
    #[test]
    #[cfg(windows)]
    fn parses_chinese_netsh_output() {
        let (blocks, rules) = parse_netsh_rules(NETSH_ZH, 7823);
        assert_eq!(blocks, 1);
        assert_eq!(rules.len(), 1);
        let r = &rules[0];
        assert_eq!(r.action, "Allow", "「允许」应归一为 Allow");
        assert_eq!(r.profiles, "Public", "「公用」应归一为 Public");
        assert_eq!(r.local_port, "Any", "「任何」应归一为 Any");
        assert!(r.enabled, "「是」应为 true");
    }

    /// 端口 Any 的规则对任何端口都算命中（实机上 cc-bridge 的规则正是 LocalPort=Any）。
    #[test]
    #[cfg(windows)]
    fn port_any_matches_and_ranges_work() {
        assert!(port_hit("Any", 7823));
        assert!(port_hit("7823", 7823));
        assert!(!port_hit("7824", 7823));
        assert!(port_hit("80,443,7823", 7823));
        assert!(port_hit("7800-7900", 7823));
        assert!(!port_hit("7900-8000", 7823));
    }

    /// 解析失败（拿到的不是规则输出）必须返回 0 块，让调用方回退而不是下「没有规则」的错结论。
    #[test]
    #[cfg(windows)]
    fn garbage_input_yields_zero_blocks() {
        let (blocks, rules) =
            parse_netsh_rules("\u{fffd}\u{fffd}\r\n\u{fffd}\u{fffd} \u{fffd}\r\n", 7823);
        assert_eq!(blocks, 0);
        assert!(rules.is_empty());
    }

    /// 全角冒号不能让切分 panic（中文系统某些输出用全角）。
    #[test]
    #[cfg(windows)]
    fn full_width_colon_does_not_panic() {
        let kv = split_kv("协议：                                 TCP");
        assert_eq!(kv, Some(("协议".into(), "TCP".into())));
    }
}
