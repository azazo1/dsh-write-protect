/**
 * 替换 base 的 `sandbox` 行 (Linux/macOS): 官方 `LocalSandboxProvider` 的
 * runner 链, 功能探测与执法报告全部原样保留, 只在 confine() 返回之后把
 * 额外可写根与保护路径叠加为对 profile 的额外约束 —
 *   - bwrap: 在 `--` 分隔符之前先插入 `--bind <p> <p>`, 再插入
 *     `--ro-bind <p> <p>`; 后挂载覆盖早挂载, 只读 bind 叠在可写 bind 之上;
 *   - Seatbelt (sandbox-exec): 先追加 `(allow file-write* (subpath "..."))`,
 *     再追加 `(deny file-write* (subpath "..."))`, 显式 deny 收窄更早的 allow;
 *     不区分模式地追加 broker 逃逸拒绝形式 (见 seatbelt.ts), 否则官方 profile 的
 *     `(allow default)` 会让沙箱内一条 `open x.app` 把命令交给 launchd 在沙箱外跑 —
 *     该加固由 policy 的 `hardenBroker` 控制, 设置页可关;
 *   - Landlock 是纯 allow-list 并集, 无法表达子路径例外, 但可以加 `--rw`
 *     放宽额外可写根; 保护路径仍告警一次, 命令按官方 profile 运行.
 * Windows 不挂载本行 (保留官方 ACL provider), fs 围栏半区覆盖 write/edit 工具.
 * @module dsh-write-protect/provider
 */

import { existsSync } from 'node:fs'
import { parse as parsePath } from 'node:path'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { SEATBELT_BROKER_DENIALS, appendSeatbeltForms, sbplString } from './seatbelt.ts'

export const name = 'dsh-write-protect-provider'

/** 文件系统根不能作为额外可写根叠加, 否则会把只读宿主根整棵翻成可写. */
function isFilesystemRoot(path: string): boolean {
  const canonical = canonicalPath(path)
  return canonical === parsePath(canonical).root
}

export class WriteProtectSandboxProvider extends LocalSandboxProvider {
  private warnedUnsupported = false

  /**
   * 按官方结果包装 argv 后叠加额外可写根, 保护路径与 broker 逃逸加固.
   * Seatbelt 在两种模式下都要加固: `read-only` 的官方 profile 同样是
   * `(allow default)`, 同样能被 `open` 打穿, 只是额外可写根仍不打穿它.
   */
  override confine(argv: readonly string[], policy: SandboxPolicy): ConfinedArgv {
    const result = super.confine(argv, policy)

    const runner = result.argv[0]
    const separator = result.argv.indexOf('--')
    const profileArgs = separator === -1 ? result.argv.slice(1) : result.argv.slice(1, separator)
    if (runner === 'sandbox-exec') return this.hardenSeatbelt(result, policy)

    if (policy.mode !== 'workspace-write') return result
    const extra = policy.writablePaths ?? []
    const protectedPaths = policy.readOnlyPaths ?? []
    if (extra.length === 0 && protectedPaths.length === 0) return result

    if (runner === 'bwrap' || profileArgs.includes('--ro-bind')) {
      let next = result
      if (extra.length > 0) next = this.withBwrapBinds(next, extra)
      if (protectedPaths.length > 0) next = this.withBwrapReadonly(next, protectedPaths)
      return next
    }
    if (profileArgs.includes('--rw')) {
      let next = result
      if (extra.length > 0) next = this.withLandlockWritable(next, extra)
      if (protectedPaths.length > 0) this.warnUnsupported(runner)
      return next
    }
    this.warnUnsupported(runner)
    return result
  }

  /**
   * Seatbelt: 追加额外可写 allow (仅 `workspace-write`), 保护路径 deny, 最后是
   * broker 逃逸拒绝形式. 结尾的 deny 必须留在 profile 末尾才能盖过 `(allow default)`.
   * `hardenBroker` 被显式关掉时只跳过 broker 拒绝形式, 命令按官方 profile 运行.
   */
  private hardenSeatbelt(result: ConfinedArgv, policy: SandboxPolicy): ConfinedArgv {
    let next = result
    if (policy.mode === 'workspace-write') {
      const extra = policy.writablePaths ?? []
      const protectedPaths = policy.readOnlyPaths ?? []
      if (extra.length > 0) next = this.withSeatbeltAllows(next, extra)
      if (protectedPaths.length > 0) next = this.withSeatbeltDenials(next, protectedPaths)
    }
    if (policy.hardenBroker === false) return next
    return this.appendSeatbelt(next, SEATBELT_BROKER_DENIALS)
  }

  /** 在 `--` 之前插入一组 profile 参数. */
  private insertBeforeSeparator(result: ConfinedArgv, args: readonly string[]): ConfinedArgv {
    if (args.length === 0) return result
    const separator = result.argv.indexOf('--')
    const insertAt = separator === -1 ? result.argv.length : separator
    return {
      ...result,
      argv: [...result.argv.slice(0, insertAt), ...args, ...result.argv.slice(insertAt)],
    }
  }

  /**
   * bwrap: 在 `--` 分隔符之前插入可写 bind 对. 后挂载覆盖早挂载, 必须出现在
   * 保护路径的 ro-bind 之前. 宿主上不存在或解析为文件系统根的路径跳过.
   */
  private withBwrapBinds(result: ConfinedArgv, paths: readonly string[]): ConfinedArgv {
    const binds: string[] = []
    const missing: string[] = []
    for (const path of paths) {
      if (isFilesystemRoot(path)) continue
      if (existsSync(path)) {
        binds.push('--bind', path, path)
      } else {
        missing.push(path)
      }
    }
    if (missing.length > 0) this.warnMissingWritable(missing)
    return this.insertBeforeSeparator(result, binds)
  }

  /**
   * bwrap: 在 `--` 分隔符之前插入 ro-bind 对. bwrap 要求 bind 源存在, 宿主上
   * 尚不存在的路径跳过并告警 (fs 工具半区仍会拒绝这些路径下的写入).
   */
  private withBwrapReadonly(result: ConfinedArgv, paths: readonly string[]): ConfinedArgv {
    const binds: string[] = []
    const missing: string[] = []
    for (const path of paths) {
      if (existsSync(path)) {
        binds.push('--ro-bind', path, path)
      } else {
        missing.push(path)
      }
    }
    if (missing.length > 0) this.warnMissing(missing)
    return this.insertBeforeSeparator(result, binds)
  }

  /**
   * Landlock: 在 `--` 之前插入 `--rw` 授权. 不存在或文件系统根跳过;
   * 保护路径仍无法表达, 由调用方告警.
   */
  private withLandlockWritable(result: ConfinedArgv, paths: readonly string[]): ConfinedArgv {
    const grants: string[] = []
    const missing: string[] = []
    for (const path of paths) {
      if (isFilesystemRoot(path)) continue
      if (existsSync(path)) {
        grants.push('--rw', path)
      } else {
        missing.push(path)
      }
    }
    if (missing.length > 0) this.warnMissingWritable(missing)
    return this.insertBeforeSeparator(result, grants)
  }

  /**
   * Seatbelt: 在 `-p` 的 profile 文本末尾追加一条合并的 allow 形式. 随后
   * 的 deny 仍由 withSeatbeltDenials 追加, 保护路径优先.
   */
  private withSeatbeltAllows(result: ConfinedArgv, paths: readonly string[]): ConfinedArgv {
    const roots = paths.filter(path => !isFilesystemRoot(path))
    if (roots.length === 0) return result
    return this.appendSeatbelt(result, [`(allow file-write* ${roots.map(path => `(subpath ${sbplString(path)})`).join(' ')})`])
  }

  /**
   * Seatbelt: 在 `-p` 的 profile 文本末尾追加一条合并的 deny 形式. 每条
   * `(subpath "...")` 都经过 SBPL 字符串转义; profile 形状缺失时按不支持
   * 告警并保持官方结果.
   */
  private withSeatbeltDenials(result: ConfinedArgv, paths: readonly string[]): ConfinedArgv {
    const denies = paths.map(path => `(subpath ${sbplString(path)})`).join(' ')
    return this.appendSeatbelt(result, [`(deny file-write* ${denies})`])
  }

  /** 把一组 SBPL 形式追加到 `-p` profile 文本末尾, 形状缺失时告警并保持官方结果. */
  private appendSeatbelt(result: ConfinedArgv, forms: readonly string[]): ConfinedArgv {
    const argv = appendSeatbeltForms(result.argv, forms)
    if (!argv) {
      this.warnUnsupported('sandbox-exec (no -p profile argument)')
      return result
    }
    return { ...result, argv }
  }

  /** 无法表达子路径保护的 runner: 只告警一次, 命令按官方 profile 运行. */
  private warnUnsupported(runner: string | undefined): void {
    if (this.warnedUnsupported) return
    this.warnedUnsupported = true
    this.ctx.logger?.warn?.(`dsh-write-protect: the "${runner}" sandbox rung cannot express protected subpaths; commands still run under the stock profile (prefer bwrap on Linux; macOS Seatbelt is supported)`)
  }

  /** bwrap 无法 ro-bind 的缺失路径: 告警并说明 write/edit 工具侧仍然受保护. */
  private warnMissing(paths: readonly string[]): void {
    this.ctx.logger?.warn?.(`dsh-write-protect: bwrap cannot ro-bind missing paths, skipped (write/edit tools still deny them): ${JSON.stringify(paths)}`)
  }

  /** bwrap / Landlock 无法授权的缺失额外可写根: 告警, fs 围栏仍会按词法放行. */
  private warnMissingWritable(paths: readonly string[]): void {
    this.ctx.logger?.warn?.(`dsh-write-protect: sandbox runner cannot grant missing extra writable roots, skipped (write/edit tools still allow them): ${JSON.stringify(paths)}`)
  }
}

export default WriteProtectSandboxProvider
