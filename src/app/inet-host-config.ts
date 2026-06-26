// U5：远端 INET 主机配置的读写编排层（设置面板 → Tauri invoke）。
// 后端命令 get_inet_host_config / set_inet_host_config 已就绪（inet_sim_command.rs）。

import { invoke } from "@tauri-apps/api/core";

export interface InetHostConfig {
  host: string;
  user: string;
  /** INET 环境命令前缀：以 `<inetEnvCmd> -c '<cmd>'` 在 OMNeT++/INET 环境里跑 inet 与 opp_scavetool。 */
  inetEnvCmd: string;
}

/** 读 UI 持久的远端主机配置（无记录时后端回播种当前默认）。 */
export async function getInetHostConfig(): Promise<InetHostConfig> {
  return await invoke<InetHostConfig>("get_inet_host_config");
}

/** 写远端主机配置（保存）。host/user 含非法字符时后端抛错（字符串）。 */
export async function setInetHostConfig(config: InetHostConfig): Promise<void> {
  await invoke("set_inet_host_config", { config });
}
