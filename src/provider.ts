/**
 * 替换 base 的 `sandbox` 行 (Linux/macOS): 官方 `LocalSandboxProvider` 的
 * runner 链, 功能探测与执法报告全部原样保留, 只在 confine() 返回之后把
 * 额外可写根, 保护路径与本会话授权叠加为对 profile 的额外约束 —
 *   - bwrap: 在 `--` 分隔符之前先插入 WSL 互操作加固 (tmpfs `/mnt` 与
 *     `/run/WSL` 等, 见 wsl.ts), 再插入额外可写根的 `--bind <p> <p>`, 再插入
 *     保护路径的 `--ro-bind <p> <p>`, 最后插入本会话授权的 `--bind`; 后挂载
 *     覆盖早挂载, 因此授权能把被保护的子树重新翻回可写, 额外根若在 `/mnt`
 *     下也能在 tmpfs 之后重新露出来;
 *   - Seatbelt (sandbox-exec): 先追加额外可写 allow, 再追加保护路径 deny, 最后
 *     追加授权 allow —— SBPL 按最后匹配生效, 授权 allow 必须排在 deny 之后才不
 *     会被它盖掉; 不区分模式地追加 broker 逃逸拒绝形式 (见 seatbelt.ts), 否则
 *     官方 profile 的 `(allow default)` 会让沙箱内一条 `open x.app` 把命令交给
 *     launchd 在沙箱外跑 —— 该加固由 policy 的 `hardenBroker` 控制, 设置页可关;
 *     WSL 上 PE 互操作是同一类代理通道, 由 `hardenWsl` 控制, 设置页可关;
 *   - Landlock 是纯 allow-list 并集, 无法表达"父目录只读, 其中一棵子树可写":
 *     额外可写根可以加 `--rw`, 保护路径与本会话授权都告警一次; WSL 互操作
 *     也表达不了, 只告警一次.
 * Windows 不挂载本行 (保留官方 ACL provider), fs 围栏半区覆盖 write/edit 工具.
 *
 * 官方 Seam 的 `confine()` 自 0.1.6 起是异步的 (`Promise<ConfinedArgv>` 加一个
 * `signal`): 本覆写必须是 async 并 await 官方结果, 否则 `result` 是 Promise,
 * 读 `result.argv` 直接抛 TypeError, 走沙箱的每条命令都会失败 (沙箱看起来整个挂掉).
 * 保护路径的真实清单也在这条 async 路径上取 (`materialize()`), 不占用同步的
 * `policy.resolve()`.
 * @module dsh-write-protect/provider
 */

import { existsSync, lstatSync } from 'node:fs'
import { parse as parsePath } from 'node:path'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { canonicalPath } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import {
  SEATBELT_BROKER_DENIALS,
  appendSeatbeltForms,
  seatbeltRegexDenials,
  seatbeltSubpathAllow,
  seatbeltSubpathDeny,
} from './seatbelt.ts'
import { isWslHost, wslHardenArgs } from './wsl.ts'

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
  declare internals: LocalSandboxProvider['internals'] & {
    /** 测试注入: 覆盖 WSL 探测. 生产路径不设 internals.platform, 走 isWslHost(). */
    probeWsl?: () => boolean
  }
  private warnedUnsupported = false
  private warnedLandlockOverride = false
  private warnedLandlockWsl = false
  private warnedLandlockReadDeny = false

  /**
   * 按官方结果包装 argv 后叠加额外可写根, 保护路径, 读拒绝路径, 本会话授权,
   * broker 逃逸加固与 WSL 互操作加固. Seatbelt 在两种模式下都要加固: `read-only`
   * 的官方 profile 同样是 `(allow default)`, 同样能被 `open` 打穿, 只是额外可写根
   * 仍不打穿它. WSL 加固同理: Windows 进程写的是真实磁盘, `read-only` 的
   * `--ro-bind / /` 一样挡不住, 所以不区分模式.
   *
   * 读拒绝在 `read-only` 下同样叠加: 那个模式限制的是写, 读本来是全开的, 因此
   * 读拒绝不会被官方 profile 覆盖; 对应地, 该模式下只叠加读侧的授权 (Seatbelt 的
   * `allow file-read*` / bwrap 的 `--ro-bind`), 绝不叠加任何写侧放行.
   *
   * 叠加顺序是有意的 (两条链路都按"后匹配 / 后挂载生效"):
   *   0. WSL 互操作加固 (tmpfs `/mnt` 等, 必须早于额外可写 bind, 这样
   *      `/mnt` 下的额外根才能在 tmpfs 之后重新露出来);
   *   1. 额外可写根 (设置页声明的与经审批的工作区外路径);
   *   2. 保护路径 (ro-bind / deny);
   *   3. 读拒绝路径 (tmpfs / `/dev/null` bind / `deny file-read*`);
   *   4. 本会话授权 (`writableOverrides` 与经审批的额外根) —— 它要在保护路径与
   *      读拒绝之后才能把被授权的子树从只读或不可读里翻回来, 否则命令侧就永远
   *      看不到本会话的授权.
   */
  override async confine(
    argv: readonly string[],
    policy: SandboxPolicy,
    signal?: AbortSignal,
  ): Promise<ConfinedArgv> {
    const result = await super.confine(argv, policy, signal)
    // danger-full-access 下引擎根本不会要求 confine (policy.mode 在那条路径上不进
    // 这一层), 因此这里不需要额外的模式判断.

    const runner = result.argv[0]
    const separator = result.argv.indexOf('--')
    const profileArgs = separator === -1 ? result.argv.slice(1) : result.argv.slice(1, separator)
    const isBwrap = runner === 'bwrap' || profileArgs.includes('--ro-bind')
    const isLandlock = profileArgs.includes('--rw')
    const hardenWsl = this.shouldHardenWsl(policy)
    const workspaceWrite = policy.mode === 'workspace-write'
    const overlaid = await this.overlayPolicy(policy)
    // `read-only` 下不叠加任何写侧放行; 授权只用来重新露出可读.
    const extra = workspaceWrite ? overlaid.writablePaths ?? [] : []
    const protectedPaths = workspaceWrite ? overlaid.readOnlyPaths ?? [] : []
    const readDeny = overlaid.readDenyPaths ?? []
    const grants = policy.sessionGrantPaths ?? policy.writableOverrides ?? []
    const hasReadDeny = readDeny.length > 0 || (policy.readDenyPatterns ?? '').trim().length > 0

    if (runner === 'sandbox-exec') return this.hardenSeatbelt(result, overlaid)

    if (isBwrap) {
      let next = result
      if (hardenWsl) next = this.withWslHarden(next, policy)
      if (extra.length > 0) next = this.withBwrapBinds(next, extra)
      if (protectedPaths.length > 0) next = this.withBwrapReadonly(next, protectedPaths)
      if (readDeny.length > 0) next = this.withBwrapReadDeny(next, readDeny)
      // 授权要在保护与读拒绝之后挂回来: workspace-write 下挂成可写, read-only 下
      // 只挂成只读 (那个模式下不叠任何写侧放行). 没有读拒绝可解时不改 argv.
      if (workspaceWrite && grants.length > 0) next = this.withBwrapGrantBinds(next, grants, true)
      else if (hasReadDeny && grants.length > 0) next = this.withBwrapGrantBinds(next, grants, false)
      return next
    }
    if (isLandlock) {
      if (hardenWsl) this.warnLandlockWsl()
      let next = result
      if (extra.length > 0) next = this.withLandlockWritable(next, extra)
      if (protectedPaths.length > 0) this.warnUnsupported(runner)
      if (readDeny.length > 0) this.warnLandlockReadDeny()
      if (grants.length > 0 && workspaceWrite) this.warnLandlockOverride()
      return next
    }
    this.warnUnsupported(runner)
    return result
  }

  /**
   * 取本次 confine 要用的完整路径清单: 生产路径上 policy 由本插件的 policy
   * service 生成, 保护路径与读拒绝路径的真实清单在这条 async 路径上从
   * `materialize()` 取 (同步的 `policy.resolve()` 只带模式原文与缓存快照).
   *
   * `read-only` 下只有确实配了读拒绝时才展开 (写侧在这个模式下没有意义, 白扫盘).
   * 取 policy service 走 `ctx.get()` 而不是 `ctx.sandboxPolicy`: 官方
   * `LocalSandboxProvider` 没有声明这个 inject, 直接读会在真实实例里抛
   * "cannot get property ... without inject"; `get()` 不需要声明, 服务缺失时给
   * undefined, 正好落到下面那份按 policy 清单的退路.
   */
  private async overlayPolicy(policy: SandboxPolicy): Promise<SandboxPolicy> {
    const materialize = this.materializeOf()
    const granted = unique(policy.writablePaths ?? [])
    const protectedPaths = unique(policy.readOnlyPaths ?? [])
    const declaredReadDeny = unique(policy.readDenyPaths ?? [])
    const readDenyText = (policy.readDenyPatterns ?? '').trim()
    // 写侧只在 workspace-write 下有内容; 读拒绝在两种模式下都要展开.
    const wanted = policy.mode === 'workspace-write' || readDenyText.length > 0 || declaredReadDeny.length > 0
    const needsScan = wanted && typeof policy.readOnlyPatterns === 'string' && materialize !== undefined
    if (!needsScan) {
      return { ...policy, writablePaths: granted, readOnlyPaths: protectedPaths, readDenyPaths: declaredReadDeny }
    }
    const snap = await materialize(policy.workspaceRoot)
    return {
      ...policy,
      writablePaths: unique([...granted, ...snap.writable]),
      readOnlyPaths: unique([...protectedPaths, ...snap.readOnly]),
      readDenyPaths: unique([...declaredReadDeny, ...snap.readDeny ?? []]),
    }
  }

  /** policy service 的异步展开入口, 服务缺失或形状不符时为 undefined. */
  private materializeOf(): ((workspaceRoot: string) => Promise<{
    readOnly: readonly string[]
    writable: readonly string[]
    readDeny?: readonly string[]
  }>) | undefined {
    const service = this.ctx.get('sandboxPolicy') as {
      materialize?: (workspaceRoot: string) => Promise<{
        readOnly: readonly string[]
        writable: readonly string[]
        readDeny?: readonly string[]
      }>
    } | undefined
    const materialize = service?.materialize
    return typeof materialize === 'function' ? materialize.bind(service) : undefined
  }

  /**
   * Seatbelt: 按顺序追加额外可写 allow, 保护路径 deny, 读拒绝 deny (枚举清单与
   * 按原文生成的正则), 本会话授权的 allow, 最后是 broker 逃逸拒绝形式. 结尾的
   * deny 必须留在 profile 末尾才能盖过 `(allow default)`; 授权的 allow 又必须
   * 排在保护与读拒绝的 deny 之后, 否则那些 deny 会盖掉它.
   * `hardenBroker` 被显式关掉时只跳过 broker 拒绝形式, 命令按官方 profile 运行.
   */
  private hardenSeatbelt(result: ConfinedArgv, policy: SandboxPolicy): ConfinedArgv {
    return this.appendSeatbelt(result, this.seatbeltForms(policy))
  }

  /** 按"后匹配生效"的顺序拼出这次 confine 要追加的全部 SBPL 形式. */
  private seatbeltForms(policy: SandboxPolicy): string[] {
    const workspaceWrite = policy.mode === 'workspace-write'
    const grants = policy.sessionGrantPaths ?? policy.writableOverrides ?? []
    const forms: string[] = []
    const extra = (workspaceWrite ? policy.writablePaths ?? [] : []).filter(path => !isFilesystemRoot(path))
    if (extra.length > 0) forms.push(seatbeltSubpathAllow(extra, 'file-write*'))
    const protectedPaths = workspaceWrite ? policy.readOnlyPaths ?? [] : []
    if (protectedPaths.length > 0) forms.push(seatbeltSubpathDeny(protectedPaths, 'file-write*'))
    // 按原文生成的正则拒绝: 不依赖枚举清单, 所以会话中途才出现的受保护路径
    // (例如刚被 `git init` 建出来的 `.git`) 在后续命令里同样挡得住.
    if (workspaceWrite) {
      forms.push(...seatbeltRegexDenials(policy.readOnlyPatterns ?? '', policy.workspaceRoot, 'file-write*'))
    }
    const readDeny = policy.readDenyPaths ?? []
    if (readDeny.length > 0) forms.push(seatbeltSubpathDeny(readDeny, 'file-read*'))
    // 读拒绝同样有正则通道: 字面条目不受展开缓存窗口影响.
    forms.push(...seatbeltRegexDenials(policy.readDenyPatterns ?? '', policy.workspaceRoot, 'file-read*'))
    const readable = grants.filter(path => !isFilesystemRoot(path))
    const hasReadDeny = readDeny.length > 0 || (policy.readDenyPatterns ?? '').trim().length > 0
    if (readable.length > 0 && (workspaceWrite || hasReadDeny)) {
      if (workspaceWrite) forms.push(seatbeltSubpathAllow(readable, 'file-write*'))
      // 读侧的 allow 只在确实有读拒绝可解时才追加: 没有读拒绝时 (allow default)
      // 本来就允许读, 多写一条只会让 profile 变复杂.
      if (hasReadDeny) forms.push(seatbeltSubpathAllow(readable, 'file-read*'))
    }
    if (policy.hardenBroker !== false) forms.push(...SEATBELT_BROKER_DENIALS)
    return forms
  }

  /**
   * 当前这次 confine 要不要叠加 WSL 加固. `hardenWsl === false` 显式关掉;
   * 未声明按开启. 测试注入 `internals.platform` 时必须再给 `probeWsl`, 否则
   * 默认否, 避免 WSL 宿主上的 argv 单测被真实探测打乱.
   */
  private shouldHardenWsl(policy: SandboxPolicy): boolean {
    if (policy.hardenWsl === false) return false
    if (typeof this.internals.probeWsl === 'function') return this.internals.probeWsl()
    if (this.internals.platform !== undefined) return false
    return isWslHost()
  }

  /** 在 `--` 之前插入 WSL 互操作加固参数 (tmpfs `/mnt` 等). */
  private withWslHarden(result: ConfinedArgv, policy: SandboxPolicy): ConfinedArgv {
    return this.insertBeforeSeparator(result, wslHardenArgs({
      workspaceRoot: policy.workspaceRoot,
      mode: policy.mode,
    }))
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
   * bwrap: 在 `--` 分隔符之前插入读拒绝挂载. 目录用 `--tmpfs` 盖成空目录,
   * 文件用 `--ro-bind /dev/null` 盖成空文件 —— 两者都让沙箱内的读取拿不到内容,
   * 且必须排在保护路径的 ro-bind 之后 (后挂载覆盖早挂载). 宿主上不存在的路径
   * 跳过并告警 (它还不存在, 也就没什么可读).
   */
  private withBwrapReadDeny(result: ConfinedArgv, paths: readonly string[]): ConfinedArgv {
    const args: string[] = []
    const missing: string[] = []
    for (const path of paths) {
      let isDirectory = false
      try {
        isDirectory = lstatSync(path).isDirectory()
      } catch {
        missing.push(path)
        continue
      }
      if (isDirectory) args.push('--tmpfs', path)
      else args.push('--ro-bind', '/dev/null', path)
    }
    if (missing.length > 0) this.warnMissingReadDeny(missing)
    return this.insertBeforeSeparator(result, args)
  }

  /**
   * bwrap: 在 `--` 分隔符之前插入本会话授权的挂载对. 它必须排在保护路径的
   * ro-bind 与读拒绝挂载 **之后**, 否则那些挂载会把授权子树又压回只读或不可读.
   * `workspace-write` 下挂成可写 bind (`--bind`), `read-only` 下只挂成只读
   * (`--ro-bind`) —— 那个模式下授权只用来恢复可读, 不能打穿只读.
   */
  private withBwrapGrantBinds(result: ConfinedArgv, paths: readonly string[], writable: boolean): ConfinedArgv {
    const binds: string[] = []
    const missing: string[] = []
    for (const path of paths) {
      if (writable && isFilesystemRoot(path)) continue
      if (existsSync(path)) {
        binds.push(writable ? '--bind' : '--ro-bind', path, path)
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

  /**
   * bwrap 无法挂载的缺失读拒绝路径: 告警. 它还不存在, 命令侧也就读不到什么;
   * 等它被创建出来之后, 下一次展开就会把它算进清单.
   */
  private warnMissingReadDeny(paths: readonly string[]): void {
    this.ctx.logger?.warn?.(`dsh-write-protect: bwrap cannot hide missing read-denied paths, skipped (the read tools already fence them by pattern): ${JSON.stringify(paths)}`)
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

  /**
   * Landlock 不能藏挂载点, 也就挡不住 WSL 的 PE 互操作: 只告警一次, 命令按
   * 官方 profile 跑.
   */
  private warnLandlockWsl(): void {
    if (this.warnedLandlockWsl) return
    this.warnedLandlockWsl = true
    this.ctx.logger?.warn?.('dsh-write-protect: Landlock cannot hide WSL interop paths, so Windows PE execution is not blocked on this runner (bwrap honors hardenWsl)')
  }

  /** bwrap 无法挂载的缺失保护旁路: 告警, write/edit 侧仍然按授权放行. */
  private warnMissingOverride(paths: readonly string[]): void {
    this.ctx.logger?.warn?.(`dsh-write-protect: bwrap cannot bind missing session grant paths, skipped (write/edit tools still allow them; the command side picks them up once they exist): ${JSON.stringify(paths)}`)
  }

  /**
   * Landlock 是纯 allow-list, 父目录一旦放行读, 其中的子树就挖不掉: 读拒绝在
   * 这个 runner 上无法表达, 只告警一次 (工具侧围栏照常生效).
   */
  private warnLandlockReadDeny(): void {
    if (this.warnedLandlockReadDeny) return
    this.warnedLandlockReadDeny = true
    this.ctx.logger?.warn?.('dsh-write-protect: Landlock cannot express a read denial inside an allowed root, so sandboxed commands can still read read-denied paths on this runner (the read tools are fenced; prefer bwrap on Linux)')
  }
}

export default WriteProtectSandboxProvider
