import { canonicalPath } from "@deepseek-ai/dsh-sandbox";
import { existsSync, readFileSync } from "node:fs";
//#region src/wsl.ts
/**
* WSL 互操作逃逸加固: 官方 bwrap 只做 mount namespace, 拦不住 Linux 侧
* `execve` 一个 Windows PE.
*
* WSL2 会把 MZ 可执行文件交给 Windows 宿主创建进程; 那个进程不继承 bwrap 的
* 挂载, 可经 UNC (`\\wsl.localhost\...`) 写回真实磁盘, 于是 `--ro-bind` 与
* write / edit 围栏都被绕开. 这与 macOS 上 `open` 经 launchd 逃逸是同一类
* 代理通道.
*
* 加固手段 (后挂载覆盖早挂载, 必须叠在官方 `--ro-bind / /` 之后):
*   1. `--tmpfs /mnt` 藏掉 Windows 盘与 WSLg;
*   2. `--tmpfs /run/WSL` 藏掉 interop 套接字, 工作区里即便有 PE 也连不上
*      Windows;
*   3. `--tmpfs /proc/sys/fs/binfmt_misc` 藏掉 PE binfmt (若该路径存在);
*   4. `--bind /dev/null /init` 挡住 WSL 的 `/init` 互操作入口 (若存在).
* 工作区本身若在 `/mnt` 下 (Windows 盘上的项目), tmpfs 之后把工作区重新
* bind 回去, 否则工作区会一起消失. 工作区是 `/mnt` 或整盘 (`/mnt/c`) 时,
* PE 文件会重新可见, 但仍没有 interop 套接字.
*
* 只在探测到 WSL 时生效; 原生 Linux 的 `/mnt` 常挂其他盘, 不能一律藏掉.
* 关掉 `hardenWsl` 即恢复可被互操作打穿的状态.
* @module dsh-write-protect/wsl
*/
/** 需要用 tmpfs 盖掉的 WSL 互操作入口. bwrap `--tmpfs` 要求 DEST 在宿主上存在. */
const WSL_TMPFS_PATHS = [
	"/mnt",
	"/run/WSL",
	"/proc/sys/fs/binfmt_misc"
];
/** WSL 的 interop 翻译器; 叠 `/dev/null` 让 `exec /init` 失败. */
const WSL_INIT_PATH = "/init";
/** `/init` 的遮罩源. */
const WSL_DEV_NULL = "/dev/null";
/**
* 当前 Host 是否跑在 WSL 上. 读 `/proc/version` 的 Microsoft / WSL 标记;
* 读不到时退回 `/run/WSL` 是否存在. 非 Linux 直接否.
* @returns 探测为 WSL 时为 true.
*/
function isWslHost() {
	if (process.platform !== "linux") return false;
	try {
		return /microsoft|wsl/i.test(readFileSync("/proc/version", "utf8"));
	} catch {
		return existsSync("/run/WSL");
	}
}
/**
* 路径是否落在 `/mnt` 下 (含 `/mnt` 自己). 用于判断 tmpfs `/mnt` 之后要不要
* 把工作区重新 bind 回去.
* @param path - 任意路径, 先走 canonical.
*/
function isUnderMnt(path) {
	const canonical = canonicalPath(path).replace(/\/+$/, "") || "/";
	return canonical === "/mnt" || canonical.startsWith("/mnt/");
}
/**
* 生成叠在官方 bwrap profile 之后的 WSL 加固参数.
* 不存在的 DEST 跳过, 避免 bwrap 直接拒绝整条命令.
* @param options - 工作区根, 模式与存在性探测.
* @returns 交错的 flag / path 参数; 无需加固时为空数组.
*/
function wslHardenArgs(options) {
	const exists = options.exists ?? existsSync;
	const args = [];
	for (const path of WSL_TMPFS_PATHS) if (exists(path)) args.push("--tmpfs", path);
	if (exists("/init") && exists("/dev/null")) args.push("--bind", WSL_DEV_NULL, WSL_INIT_PATH);
	if (isUnderMnt(options.workspaceRoot) && exists(options.workspaceRoot)) {
		const bind = options.mode === "workspace-write" ? "--bind" : "--ro-bind";
		args.push(bind, options.workspaceRoot, options.workspaceRoot);
	}
	return args;
}
//#endregion
export { wslHardenArgs as n, isWslHost as t };

//# sourceMappingURL=wsl-Do9evsHp.mjs.map