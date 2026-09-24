/**
 * 替换 base 的 `sandbox` 行 (Linux/macOS): 官方 `LocalSandboxProvider` 的
 * runner 链, 功能探测与执法报告全部原样保留, 只在 confine() 返回之后把
 * 额外可写根, 保护路径与本会话授权叠加为对 profile 的额外约束 —
 *   - bwrap: 在 `--` 分隔符之前先插入额外可写根的 `--bind <p> <p>`, 再插入
 *     保护路径的 `--ro-bind <p> <p>`, 最后插入本会话授权的 `--bind`; 后挂载
 *     覆盖早挂载, 因此授权能把被保护的子树重新翻回可写;
 *   - Seatbelt (sandbox-exec): 先追加额外可写 allow, 再追加保护路径 deny, 最后
 *     追加授权 allow —— SBPL 按最后匹配生效, 授权 allow 必须排在 deny 之后才不
 *     会被它盖掉; 不区分模式地追加 broker 逃逸拒绝形式 (见 seatbelt.ts), 否则
 *     官方 profile 的 `(allow default)` 会让沙箱内一条 `open x.app` 把命令交给
 *     launchd 在沙箱外跑 —— 该加固由 policy 的 `hardenBroker` 控制, 设置页可关;
 *   - Landlock 是纯 allow-list 并集, 无法表达"父目录只读, 其中一棵子树可写":
 *     额外可写根可以加 `--rw`, 保护路径与本会话授权都告警一次.
 * Windows 不挂载本行 (保留官方 ACL provider), fs 围栏半区覆盖 write/edit 工具.
 *
 * 官方 Seam 的 `confine()` 自 0.1.6 起是异步的 (`Promise<ConfinedArgv>` 加一个
 * `signal`): 本覆写必须是 async 并 await 官方结果, 否则 `result` 是 Promise,
 * 读 `result.argv` 直接抛 TypeError, 走沙箱的每条命令都会失败 (沙箱看起来整个挂掉).
 * 保护路径的真实清单也在这条 async 路径上取 (`materialize()`), 不占用同步的
 * `policy.resolve()`.
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

/** 去重并保持顺序: 叠加的清单来自缓存与授权两处, 同一路径只该出现一次. */
function unique(paths: readonly string[]): string[] {
  return [...new Set(paths)]
}

export class WriteProtectSandboxProvider extends LocalSandboxProvider {
  private warnedUnsupported = false
  private warnedLandlockOverride = false

  /**
   * 按官方结果包装 argv 后叠加额外可写根, 保护路径, 本会话授权与 broker 逃逸加固.
   * Seatbelt 在两种模式下都要加固: `read-only` 的官方 profile 同样是
   * `(allow default)`, 同样能被 `open` 打穿, 只是额外可写根仍不打穿它.
   *
   * 叠加顺序是有意的 (两条链路都按"后匹配 / 后挂载生效"):
   *   1. 额外可写根 (设置页声明的与经审批的工作区外路径);
   *   2. 保护路径 (ro-bind / deny);
   *   3. 本会话的保护旁路 (`writableOverrides`) —— 它要在保护路径之后才能把被
   *      授权的子树从只读里翻回来, 否则命令侧就永远看不到本会话的授权.
   */
  override async confine(
    argv: readonly string[],
    policy: SandboxPolicy,
    signal?: AbortSignal,
  ): Promise<ConfinedArgv> {
    const result = await super.confine(argv, policy, signal)

    const runner = result.argv[0]
    const separator = result.argv.indexOf('--')
    const profileArgs = separator === -1 ? result.argv.slice(1) : result.argv.slice(1, separator)
    if (runner === 'sandbox-exec') {
      if (policy.mode !== 'workspace-write') return this.hardenSeatbelt(result, policy)
      const overlay = await this.overlayPaths(policy)
      return this.hardenSeatbelt(result, {
        ...policy,
        readOnlyPaths: overlay.protectedPaths,
        writablePaths: overlay.extra,
      })
    }

    if (policy.mode !== 'workspace-write') return result
    const { extra, protectedPaths } = await this.overlayPaths(policy)
    const overrides = policy.writableOverrides ?? []
    if (extra.length === 0 && protectedPaths.length === 0 && overrides.length === 0) return result

    if (runner === 'bwrap' || profileArgs.includes('--ro-bind')) {
      let next = result
      if (extra.length > 0) next = this.withBwrapBinds(next, extra)
      if (protectedPaths.length > 0) next = this.withBwrapReadonly(next, protectedPaths)
      if (overrides.length > 0) next = this.withBwrapOverrideBinds(next, overrides)
      return next
    }
    if (profileArgs.includes('--rw')) {
      let next = result
      if (extra.length > 0) next = this.withLandlockWritable(next, extra)
      if (protectedPaths.length > 0) this.warnUnsupported(runner)
      if (overrides.length > 0) this.warnLandlockOverride()
      return next
    }
    this.warnUnsupported(runner)
    return result
  }

  /**
   * 进程沙箱需要枚举路径. 生产路径上 policy 由本插件的 policy service 生成, 走
   * `materialize()` 等完整异步展开; 本会话授权是审批阶段就定好的绝对路径, 与
   * 缓存里已有的清单一起从 policy 并进来. 单测直接塞 `readOnlyPaths` /
   * `writablePaths` 时沿用那份清单.
   *
   * 取 policy service 走 `ctx.get()` 而不是 `ctx.sandboxPolicy`: 官方
   * `LocalSandboxProvider` 没有声明这个 inject, 直接读会在真实实例里抛
   * "cannot get property ... without inject"; `get()` 不需要声明, 服务缺失时给
   * undefined, 正好落到下面那份按 policy 清单的退路.
   */
  private async overlayPaths(policy: SandboxPolicy): Promise<{ extra: readonly string[], protectedPaths: readonly string[] }> {
    const service = this.ctx.get('sandboxPolicy') as {
      materialize?: (workspaceRoot: string) => Promise<{ readOnly: readonly string[], writable: readonly string[] }>
    } | undefined
    const granted = unique(policy.writablePaths ?? [])
    const protectedPaths = unique(policy.readOnlyPaths ?? [])
    if (typeof policy.readOnlyPatterns === 'string' && typeof service?.materialize === 'function') {
      const snap = await service.materialize(policy.workspaceRoot)
      return {
        extra: unique([...granted, ...snap.writable]),
        protectedPaths: unique([...protectedPaths, ...snap.readOnly]),
      }
    }
    return { extra: granted, protectedPaths }
  }

  /**
   * Seatbelt: 追加额外可写 allow, 保护路径 deny, 本会话旁路的 allow, 最后是
   * broker 逃逸拒绝形式. 结尾的 deny 必须留在 profile 末尾才能盖过 `(allow default)`;
   * 旁路的 allow 又必须排在保护 deny 之后, 否则那条 deny 会盖掉它.
   * `hardenBroker` 被显式关掉时只跳过 broker 拒绝形式, 命令按官方 profile 运行.
   */
  private hardenSeatbelt(result: ConfinedArgv, policy: SandboxPolicy): ConfinedArgv {
    let next = result
    if (policy.mode === 'workspace-write') {
      const extra = policy.writablePaths ?? []
      const protectedPaths = policy.readOnlyPaths ?? []
      const overrides = policy.writableOverrides ?? []
      if (extra.length > 0) next = this.withSeatbeltAllows(next, extra)
      if (protectedPaths.length > 0) next = this.withSeatbeltDenials(next, protectedPaths)
      if (overrides.length > 0) next = this.withSeatbeltAllows(next, overrides)
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
   * bwrap: 在 `--` 分隔符之前插入本会话保护旁路的可写 bind 对. 它必须排在保护
   * 路径的 ro-bind **之后**, 否则那些 ro-bind 会把授权子树又压回只读. 宿主上
   * 尚不存在的路径 bwrap 无法挂载, 跳过并告警 (目录建出来后下一次命令即生效).
   */
  private withBwrapOverrideBinds(result: ConfinedArgv, paths: readonly string[]): ConfinedArgv {
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
    if (missing.length > 0) this.warnMissingOverride(missing)
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

  /**
   * Landlock 是纯 allow-list, 无法表达"父目录只读, 其中一棵子树可写": 把保护
   * 旁路通过 `--rw` 加进去会连同上方被保护的父目录一起放开, 反而扩大权限, 因此
   * 命令侧不叠加它, 只告警一次.
   */
  private warnLandlockOverride(): void {
    if (this.warnedLandlockOverride) return
    this.warnedLandlockOverride = true
    this.ctx.logger?.warn?.('dsh-write-protect: Landlock cannot express a writable subtree inside a protected directory, so session grants apply to the write/edit tools only on this runner (bwrap and macOS Seatbelt honor them for commands too)')
  }

  /** bwrap 无法挂载的缺失保护旁路: 告警, write/edit 侧仍然按授权放行. */
  private warnMissingOverride(paths: readonly string[]): void {
    this.ctx.logger?.warn?.(`dsh-write-protect: bwrap cannot bind missing session grant paths, skipped (write/edit tools still allow them; the command side picks them up once they exist): ${JSON.stringify(paths)}`)
  }
}

export default WriteProtectSandboxProvider
