import type { SshConnection } from "./types";

/** Only passed to ssh_connect; never store these on a connection, tab, or query cache. */
export interface SshOneTimeCredentials { password?: string; passphrase?: string }
export type SshFieldErrors = Partial<Record<"name" | "host" | "port" | "username" | "keyPath", string>>;
export const emptySshConnection = (): SshConnection => ({
  id: "", name: "", host: "", port: 22, username: "", authType: "password",
  rememberPassword: false, encryptedPassword: "", keyPath: "",
  rememberPassphrase: false, encryptedPassphrase: "", proxyJumpId: "",
});
export function validateSshConnection(form: SshConnection): SshFieldErrors {
  const errors: SshFieldErrors = {};
  if (!form.name.trim()) errors.name = "请输入连接名称";
  if (!form.host.trim()) errors.host = "请输入主机 IP 或域名";
  else if (/[\s/@]/.test(form.host.trim())) errors.host = "仅填写主机地址，不包含用户名或路径";
  if (!form.username.trim()) errors.username = "请输入登录用户名";
  if (!Number.isInteger(form.port) || form.port < 1 || form.port > 65535) errors.port = "范围 1–65535";
  if (form.authType === "key" && !form.keyPath.trim()) errors.keyPath = "请选择或填写私钥路径";
  return errors;
}
