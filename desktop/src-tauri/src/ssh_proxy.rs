//! 跳板机（ProxyJump）：ProxyCommand 参数拼接 + 两段登录的凭据派发。
//!
//! 为什么值得一个独立模块（而不是塞进已经 2000+ 行的 `ssh_cmds.rs`）：
//!
//! 🔴 跳板机把「一次登录」变成「两段登录」，而原来的凭据自动填充**只有一个槽**——
//! 第一个密码提示就把它吃掉。加了跳板机之后，第一个密码提示是**跳板机的**，
//! 于是**目标机的密码会被打进跳板机的登录框**：既登不上，又在跳板机的日志里
//! 留下一次「用错误密码尝试登录」。派发规则因此必须是纯函数、必须能单测，
//! 而且 `ssh_cmds.rs`（一次性命令 / scp）与 `ssh_helper.rs`（常驻会话）两处
//! 登录循环必须**共用同一份**，否则修了一处漏一处。

use std::path::Path;

use crate::config::SshConnection;

/// ProxyCommand 值里不接受的字符。
///
/// ProxyCommand 的值会被 ssh **再解析一次**：Unix 上交给 `/bin/sh`，Windows 上由
/// ssh 自己切词。这几个字符在两种解析器下语义不同（`$`/反引号在 sh 下会展开，
/// 引号会改变分词），没有一种转义写法能同时对两边正确，所以直接判非法。
/// 代价可以忽略：主机名、用户名、私钥路径里本就不允许出现它们。
const FORBIDDEN: [char; 5] = ['"', '\'', '`', '$', '\n'];

/// 把一个参数包进双引号，供 ProxyCommand 字符串内部使用。
///
/// 含空格的路径必须带引号才不会被切成两个参数——本机 OpenSSH_10.2p1 实测
/// `-i "C:/a b/id_rsa"` 能正确还原成一个参数（内层 ssh 报出的是完整路径）。
fn quote_arg(s: &str) -> Result<String, String> {
    if let Some(c) = s.chars().find(|c| FORBIDDEN.contains(c)) {
        return Err(format!(
            "跳板机配置含非法字符 {c:?}（不允许 双引号 单引号 反引号 $ 与换行）：{s}"
        ));
    }
    Ok(format!("\"{s}\""))
}

/// Windows 路径的反斜杠一律转成正斜杠。
///
/// 反斜杠在 `/bin/sh` 的双引号里是转义符，而 Windows OpenSSH 完全接受正斜杠
/// （`C:/Users/...` 可用）。统一成正斜杠就只剩一条代码路径，不必按平台分叉。
fn slashes(s: &str) -> String {
    s.replace('\\', "/")
}

/// 拼跳板机 `-o ProxyCommand=<value>` 里的 `<value>`。
///
/// **为什么不用 `-J`**：`-J` 的语法只有 `[user@]host[:port]`，塞不进 `-i`——
/// 也就没法给跳板机单独指定私钥。ProxyCommand 可以放一整条命令，跳板机的
/// 端口、私钥、各种 `-o` 都能精确控制。
///
/// `%h` / `%p` 由**外层** ssh 在建立连接时替换成目标机的主机与端口，故不加引号。
/// 保活/主机键策略与主连接保持一致（见 `ssh_cmds::ssh_base_args`）：跳板机这一段
/// 同样会因为交互式确认主机指纹而卡死在无人值守的捕获路径上。
pub fn proxy_command_value(ssh: &Path, jump: &SshConnection) -> Result<String, String> {
    let mut parts = vec![quote_arg(&slashes(&ssh.to_string_lossy()))?];
    parts.push("-p".into());
    parts.push(jump.port.to_string());
    if jump.auth_type == "key" && !jump.key_path.is_empty() {
        parts.push("-i".into());
        parts.push(quote_arg(&slashes(&jump.key_path))?);
        parts.push("-o".into());
        parts.push("IdentitiesOnly=yes".into());
    }
    parts.push("-o".into());
    parts.push("ServerAliveInterval=30".into());
    parts.push("-o".into());
    parts.push("ServerAliveCountMax=3".into());
    parts.push("-o".into());
    parts.push("StrictHostKeyChecking=accept-new".into());
    parts.push("-W".into());
    parts.push("%h:%p".into());
    parts.push(quote_arg(&format!("{}@{}", jump.username, jump.host))?);
    Ok(parts.join(" "))
}

/// 待自动填充的凭据。最多两段登录：先跳板机，后目标机。
///
/// 每个槽**只填一次，且不跨槽兜底**。跳板机密码填错时 ssh 会重复提示 3 次；
/// 如果允许「跳板槽空了就用目标槽」，第 2 次重试就会把目标机密码送给跳板机。
/// 所以槽被取走后就是空——宁可让用户手输，也不串。
#[derive(Debug, Default, Clone)]
pub struct PendingCreds {
    /// `user@host` 整体。存整体而不是只存 host，是为了区分「同一台机器、不同用户」。
    jump_id: String,
    jump_key: String,
    jump_pw: Option<String>,
    jump_pp: Option<String>,
    target_id: String,
    target_key: String,
    pw: Option<String>,
    pp: Option<String>,
}

/// 主机名 / 路径里的「正文字符」。用来做边界判定。
///
/// 不含反斜杠：比对之前路径已经过 `slashes()` 统一成正斜杠。
fn is_ident_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':' | '/')
}

/// 提示里是否**以完整标识**提到了 `needle`（两侧都不能紧贴正文字符）。
///
/// 🔴 不能用裸 `contains`：跳板 `10.0.1.5` 会在目标机的提示
/// `root@10.0.1.50's password:` 里假命中，于是把**堡垒机的密码送进目标机的登录框**——
/// 正是本模块要防的那件事。私钥同理（`id_rsa` 是 `id_rsa2` 的子串）。
fn mentions(hay: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return false;
    }
    let mut from = 0usize;
    while let Some(off) = hay[from..].find(needle) {
        let start = from + off;
        let end = start + needle.len();
        let prev_ok = !matches!(hay[..start].chars().next_back(), Some(c) if is_ident_char(c));
        let next_ok = !matches!(hay[end..].chars().next(), Some(c) if is_ident_char(c));
        if prev_ok && next_ok {
            return true;
        }
        from = start + 1;
    }
    false
}

impl PendingCreds {
    /// 无跳板的直连：行为与改造前的单槽实现一致。
    pub fn direct(conn: &SshConnection, pw: Option<String>, pp: Option<String>) -> Self {
        Self {
            target_id: format!("{}@{}", conn.username, conn.host),
            target_key: conn.key_path.clone(),
            pw,
            pp,
            ..Default::default()
        }
    }

    /// 追加跳板机那一段的凭据。
    pub fn with_jump(
        mut self,
        jump: &SshConnection,
        pw: Option<String>,
        pp: Option<String>,
    ) -> Self {
        self.jump_id = format!("{}@{}", jump.username, jump.host);
        self.jump_key = jump.key_path.clone();
        self.jump_pw = pw;
        self.jump_pp = pp;
        self
    }

    /// 是否还有任何待填明文。全空时调用方可以完全跳过填充分支。
    pub fn has_any(&self) -> bool {
        self.jump_pw.is_some() || self.jump_pp.is_some() || self.pw.is_some() || self.pp.is_some()
    }

    /// 认证窗口关闭：立刻丢掉所有明文（见 `ssh_cmds::CREDENTIAL_FILL_WINDOW`）。
    pub fn clear(&mut self) {
        self.jump_pw = None;
        self.jump_pp = None;
        self.pw = None;
        self.pp = None;
    }

    /// 目标段已经开始 → 跳板段必然已经过去，它的明文没必要再挂在内存里。
    fn drop_jump(&mut self) {
        self.jump_pw = None;
        self.jump_pp = None;
    }

    /// `user@host` 判据是否可用。
    ///
    /// 两端完全相同时任何提示都会同时命中，区分不出是哪一段，只能退回顺序判据。
    fn ids_distinct(&self) -> bool {
        !self.jump_id.is_empty()
            && !self.target_id.is_empty()
            && !self.jump_id.eq_ignore_ascii_case(&self.target_id)
    }

    /// 收到一个**登录密码**提示，返回该填的密码（None = 没有可填的，让用户手输）。
    ///
    /// 判据优先级：
    /// 1. 提示里含跳板机主机名 → 跳板槽。OpenSSH 的提示是
    ///    `ops@bastion's password:`，主机名就在里面，命中即精确。
    /// 2. 提示里含目标机主机名 → 目标槽。
    /// 3. 都没命中 → 按顺序：先跳板、后目标（跳板一定先于目标发生）。
    ///    兜底非 OpenSSH / 本地化提示的服务器。
    pub fn take_password(&mut self, prompt: &str) -> Option<String> {
        let t = prompt.to_lowercase();
        if self.ids_distinct() {
            if mentions(&t, &self.jump_id.to_lowercase()) {
                // 命中跳板段：即使槽已空也**不**回落到目标槽。
                return self.jump_pw.take();
            }
            if mentions(&t, &self.target_id.to_lowercase()) {
                self.drop_jump();
                return self.pw.take();
            }
        }
        if self.jump_pw.is_some() {
            return self.jump_pw.take();
        }
        self.pw.take()
    }

    /// 收到一个**密钥密码短语**提示，返回该填的短语。
    ///
    /// 与密码不同：短语提示是 `Enter passphrase for key '/path/id_rsa':`，
    /// 里面是**私钥路径**而不是主机名，所以判据换成私钥路径（分隔符不敏感）。
    pub fn take_passphrase(&mut self, prompt: &str) -> Option<String> {
        let t = slashes(&prompt.to_lowercase());
        let jk = slashes(&self.jump_key.to_lowercase());
        let tk = slashes(&self.target_key.to_lowercase());
        if !jk.is_empty() && !tk.is_empty() && jk != tk {
            if mentions(&t, &jk) {
                return self.jump_pp.take();
            }
            if mentions(&t, &tk) {
                self.drop_jump();
                return self.pp.take();
            }
        }
        if self.jump_pp.is_some() {
            return self.jump_pp.take();
        }
        self.pp.take()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn(host: &str, user: &str, port: u16) -> SshConnection {
        SshConnection {
            id: format!("id-{host}"),
            name: host.into(),
            host: host.into(),
            port,
            username: user.into(),
            ..Default::default()
        }
    }

    fn key_conn(host: &str, key: &str) -> SshConnection {
        SshConnection {
            auth_type: "key".into(),
            key_path: key.into(),
            ..conn(host, "ops", 22)
        }
    }

    // ─────────────── ProxyCommand 拼接 ───────────────

    #[test]
    fn password_auth_jump_has_no_identity_flag() {
        let v = proxy_command_value(
            Path::new("C:/Windows/System32/OpenSSH/ssh.exe"),
            &conn("bastion.corp.com", "ops", 2222),
        )
        .unwrap();
        assert_eq!(
            v,
            "\"C:/Windows/System32/OpenSSH/ssh.exe\" -p 2222 \
             -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
             -o StrictHostKeyChecking=accept-new -W %h:%p \"ops@bastion.corp.com\""
                .replace("             ", " ")
        );
        assert!(!v.contains("-i "));
    }

    #[test]
    fn spaced_key_path_is_quoted_and_slashed() {
        let v = proxy_command_value(
            Path::new("C:/Windows/System32/OpenSSH/ssh.exe"),
            &key_conn("bastion", "C:\\Users\\me\\my keys\\id_rsa"),
        )
        .unwrap();
        // 引号包住整个路径，否则内层 ssh 会把它切成两个参数。
        assert!(v.contains("-i \"C:/Users/me/my keys/id_rsa\""), "{v}");
        // 只认指定的私钥，与主连接一致。
        assert!(v.contains("-o IdentitiesOnly=yes"), "{v}");
        // 路径里不能残留反斜杠（sh 双引号下它是转义符）。
        assert!(!v.contains('\\'), "{v}");
    }

    #[test]
    fn placeholders_must_stay_unquoted() {
        let v = proxy_command_value(Path::new("ssh"), &conn("bastion", "ops", 22)).unwrap();
        // 外层 ssh 靠字面 %h:%p 替换目标主机/端口，包了引号就不再替换。
        assert!(v.contains(" -W %h:%p "), "{v}");
    }

    #[test]
    fn illegal_chars_are_rejected_not_embedded() {
        for bad in ["bas$tion", "bas`tion", "bas\"tion", "bas'tion"] {
            let r = proxy_command_value(Path::new("ssh"), &conn(bad, "ops", 22));
            assert!(r.is_err(), "{bad} 应该被拒：{r:?}");
        }
    }

    // ─────────────── 凭据派发：密码 ───────────────

    #[test]
    fn direct_matches_old_single_slot_behavior() {
        let target = conn("10.0.1.50", "root", 22);
        let mut c = PendingCreds::direct(&target, Some("tpw".into()), None);
        assert_eq!(
            c.take_password("root@10.0.1.50's password: ").as_deref(),
            Some("tpw")
        );
        // 只填一次。
        assert_eq!(c.take_password("root@10.0.1.50's password: "), None);
    }

    #[test]
    fn distinct_hosts_dispatch_by_hostname() {
        let target = conn("10.0.1.50", "root", 22);
        let jump = conn("bastion.corp.com", "ops", 22);
        let mut c = PendingCreds::direct(&target, Some("tpw".into()), None).with_jump(
            &jump,
            Some("jpw".into()),
            None,
        );
        assert_eq!(
            c.take_password("ops@bastion.corp.com's password: ")
                .as_deref(),
            Some("jpw")
        );
        assert_eq!(
            c.take_password("root@10.0.1.50's password: ").as_deref(),
            Some("tpw")
        );
    }

    #[test]
    fn jump_retry_never_falls_through_to_target() {
        let target = conn("10.0.1.50", "root", 22);
        let jump = conn("bastion.corp.com", "ops", 22);
        let mut c = PendingCreds::direct(&target, Some("tpw".into()), None).with_jump(
            &jump,
            Some("jpw".into()),
            None,
        );
        assert_eq!(
            c.take_password("ops@bastion.corp.com's password: ")
                .as_deref(),
            Some("jpw")
        );
        // 🔴 ssh 对同一段最多提示 3 次；回落就等于把目标机密码送给跳板机。
        assert_eq!(c.take_password("ops@bastion.corp.com's password: "), None);
        assert_eq!(c.take_password("ops@bastion.corp.com's password: "), None);
        // 目标槽完好无损。
        assert_eq!(
            c.take_password("root@10.0.1.50's password: ").as_deref(),
            Some("tpw")
        );
    }

    // 🔴 回归：跳板 `10.0.1.5` 是目标 `10.0.1.50` 的前缀。
    // 裸 `contains` 会让目标机的提示命中跳板分支，于是把**堡垒机密码送进目标机的登录框**
    // （跳板走密钥、jump_pw 还在时），或者让目标密码永远填不上、登录挂死。
    // 旧用例用的是 bastion.corp.com vs 10.0.1.50，两者不重叠，所以测不出来。
    #[test]
    fn overlapping_host_prefix_does_not_misdispatch() {
        let target = conn("10.0.1.50", "root", 22);
        let jump = conn("10.0.1.5", "ops", 22);
        let mut c = PendingCreds::direct(&target, Some("tpw".into()), None).with_jump(
            &jump,
            Some("jpw".into()),
            None,
        );
        assert_eq!(
            c.take_password("ops@10.0.1.5's password: ").as_deref(),
            Some("jpw")
        );
        assert_eq!(
            c.take_password("root@10.0.1.50's password: ").as_deref(),
            Some("tpw")
        );
    }

    /// 连用户名也重叠：`ops` 是 `ops2` 的前缀。
    #[test]
    fn overlapping_user_prefix_does_not_misdispatch() {
        let target = conn("box.local", "ops2", 22);
        let jump = conn("box.local", "ops", 22);
        let mut c = PendingCreds::direct(&target, Some("tpw".into()), None).with_jump(
            &jump,
            Some("jpw".into()),
            None,
        );
        assert_eq!(
            c.take_password("ops2@box.local's password: ").as_deref(),
            Some("tpw"),
            "ops2@... 不该命中 ops@... 这条跳板判据"
        );
    }

    /// 短语判据同理：`id_rsa` 是 `id_rsa2` 的子串。
    #[test]
    fn overlapping_key_path_does_not_misdispatch() {
        let target = key_conn("10.0.1.50", "C:/keys/id_rsa2");
        let jump = key_conn("bastion", "C:/keys/id_rsa");
        let mut c = PendingCreds::direct(&target, None, Some("tpp".into())).with_jump(
            &jump,
            None,
            Some("jpp".into()),
        );
        assert_eq!(
            c.take_passphrase("Enter passphrase for key 'C:/keys/id_rsa2': ")
                .as_deref(),
            Some("tpp"),
            "id_rsa2 不该命中 id_rsa 这条跳板判据"
        );
    }

    #[test]
    fn same_target_falls_back_to_order() {
        // 同一台机器、**同一个用户**、只有端口不同：`user@host` 判据失效
        // （两段提示一模一样），只能退回顺序判据。
        let target = conn("box.local", "ops", 2200);
        let jump = conn("box.local", "ops", 22);
        let mut c = PendingCreds::direct(&target, Some("tpw".into()), None).with_jump(
            &jump,
            Some("jpw".into()),
            None,
        );
        assert_eq!(
            c.take_password("ops@box.local's password: ").as_deref(),
            Some("jpw")
        );
        assert_eq!(
            c.take_password("ops@box.local's password: ").as_deref(),
            Some("tpw")
        );
    }

    #[test]
    fn localized_prompt_falls_back_to_order() {
        let target = conn("10.0.1.50", "root", 22);
        let jump = conn("bastion.corp.com", "ops", 22);
        let mut c = PendingCreds::direct(&target, Some("tpw".into()), None).with_jump(
            &jump,
            Some("jpw".into()),
            None,
        );
        assert_eq!(c.take_password("密码：").as_deref(), Some("jpw"));
        assert_eq!(c.take_password("密码：").as_deref(), Some("tpw"));
    }

    #[test]
    fn jump_secrets_dropped_once_target_stage_starts() {
        let target = conn("10.0.1.50", "root", 22);
        let jump = conn("bastion.corp.com", "ops", 22);
        let mut c = PendingCreds::direct(&target, Some("tpw".into()), None).with_jump(
            &jump,
            Some("jpw".into()),
            Some("jpp".into()),
        );
        // 跳板用密钥登上了，密码槽根本没用上；直接到目标机提示。
        assert_eq!(
            c.take_password("root@10.0.1.50's password: ").as_deref(),
            Some("tpw")
        );
        assert!(!c.has_any(), "跳板段的明文应当已经不在内存里");
    }

    // ─────────────── 凭据派发：密码短语 ───────────────

    #[test]
    fn passphrase_dispatches_by_key_path() {
        // 短语提示里是私钥路径而不是主机名，所以不能用主机名判。
        let target = key_conn("10.0.1.50", "C:/keys/target_rsa");
        let jump = key_conn("bastion", "C:\\keys\\bastion_rsa");
        let mut c = PendingCreds::direct(&target, None, Some("tpp".into())).with_jump(
            &jump,
            None,
            Some("jpp".into()),
        );
        assert_eq!(
            c.take_passphrase("Enter passphrase for key 'C:\\keys\\bastion_rsa': ")
                .as_deref(),
            Some("jpp")
        );
        assert_eq!(
            c.take_passphrase("Enter passphrase for key 'C:/keys/target_rsa': ")
                .as_deref(),
            Some("tpp")
        );
    }

    #[test]
    fn key_jump_and_password_target_do_not_collide() {
        let target = conn("10.0.1.50", "root", 22);
        let jump = key_conn("bastion", "C:/keys/bastion_rsa");
        let mut c = PendingCreds::direct(&target, Some("tpw".into()), None).with_jump(
            &jump,
            None,
            Some("jpp".into()),
        );
        assert_eq!(
            c.take_passphrase("Enter passphrase for key 'C:/keys/bastion_rsa': ")
                .as_deref(),
            Some("jpp")
        );
        assert_eq!(
            c.take_password("root@10.0.1.50's password: ").as_deref(),
            Some("tpw")
        );
    }

    #[test]
    fn clear_disables_every_slot() {
        let target = conn("10.0.1.50", "root", 22);
        let jump = conn("bastion", "ops", 22);
        let mut c = PendingCreds::direct(&target, Some("tpw".into()), Some("tpp".into()))
            .with_jump(&jump, Some("jpw".into()), Some("jpp".into()));
        assert!(c.has_any());
        c.clear();
        assert!(!c.has_any());
        assert_eq!(c.take_password("ops@bastion's password: "), None);
        assert_eq!(c.take_passphrase("Enter passphrase for key 'x': "), None);
    }
}
