// 测试夹具的统一落点: 项目根下的 .tmp (已被 .gitignore 覆盖). 相比系统临时
// 目录, 这里避开了 workspace-write 自动授权的 /tmp 与 os.tmpdir(), 让 "工作
// 区只经 workspaceRoot 一条通道可写" 的前提成立, 同时不往 $HOME 写垃圾.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 项目根下确保存在的 .tmp 目录, 各 spec 的 mkdtemp 夹具以它为根. */
export function projectTmpDir(): string {
  const dir = join(fileURLToPath(new URL('..', import.meta.url)), '.tmp')
  mkdirSync(dir, { recursive: true })
  return dir
}
