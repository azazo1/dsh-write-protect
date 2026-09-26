// request_writable_path 的判定语义: 解析 → allow-list 直通 → 规则文件硬保护 →
// 审批 (含四种未获同意的结果) → 授权落到 policy 上.
//
// 真实组合 WriteProtectPolicyService (规则文件与展开都走它), approval 由替身
// 提供 (形状与官方 ctx.approval 一致), 因此不需要 tools 注册表与 agent runtime.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { WriteProtectPolicyService } from '../src/policy.ts'
import { GrantsService, type GrantPolicyHost } from '../src/request-writable-path.ts'
import { handleRequest } from '../src/request-writable-path.ts'
import { projectTmpDir } from './fixture-root.ts'

/** 审批替身的当前决定, 以及它收到过的请求. */
interface FakeApproval {
  outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
  policy: 'ask' | 'never'
  requests: { reason: string, toolName: string, callId: string }[]
}

let base: string
let workspace: string
let outside: string
let ctx: Context
let policy: WriteProtectPolicyService
let grants: GrantsService
let host: GrantPolicyHost
let approval: FakeApproval

const SESSION_ID = 'session-1'

/**
 * 会话替身: policy 解析只用到 id 与 header.cwd, 会话模式投影由下面的替身服务
 * 处理 (不注册任何 unit), 因此不必拉起完整的 session runtime.
 */
function sessionStub(): never {
  return { id: SESSION_ID, header: { cwd: workspace } } as never
}

async function boot(
  readOnlyPaths: string[],
  readonlyFileName = '.readonly',
  maxGrants = 8,
  allowWritableRequests = true,
  deploymentRoot = workspace,
): Promise<void> {
  ctx = new Context()
  approval = { outcome: 'allowed-once', policy: 'ask', requests: [] }
  const fakeApproval = {
    request: (request: { reason: string, toolName: string, callId: string }) => {
      approval.requests.push({ reason: request.reason, toolName: request.toolName, callId: request.callId })
      return Promise.resolve(approval.outcome)
    },
    overrideOf: () => undefined,
    get config() { return { policy: approval.policy } },
  }
  ctx.provide('approval', fakeApproval)
  // 会话模式投影替身: 官方 resolve() 会用 stateOf 读 `sandbox/mode` 覆盖, 这里
  // 直接回 undefined (按部署默认模式解析), 省掉整个 session 运行时.
  ctx.provide('sessionProjections', { register: () => {}, stateOf: () => undefined })
  await ctx.plugin(WriteProtectPolicyService, {
    mode: 'workspace-write',
    workspaceRoot: deploymentRoot,
    readOnlyPaths,
    readonlyFileName,
    maxGrants,
    allowWritableRequests,
  })
  policy = (ctx as unknown as { sandboxPolicy: WriteProtectPolicyService }).sandboxPolicy
  // 授权表用 policy 自己那一个: 生产路径上工具与 policy 共享同一份记录.
  grants = policy.grantsView()
  host = {
    workspaceRootOfSession: (sessionId, cwd) => policy.workspaceRootOfSession(sessionId, cwd),
    resolve: (sessionId, cwd) => policy.resolveForSession(sessionId ?? SESSION_ID, cwd),
    protectedPatternFor: (sessionId, cwd, target) => policy.protectedPatternFor(sessionId ?? SESSION_ID, cwd, target),
    maxGrants: () => maxGrants,
    rulesFilePath: workspaceRoot => policy.rulesFilePath(workspaceRoot),
    allowRequests: () => allowWritableRequests,
  }
  // 让 policy 记住这个会话的工作区根 (真实路径上由 agent loop 的 resolve 完成).
  policy.resolve({ session: sessionStub() })
}

/** 工具执行上下文替身: 只用到 agent (id 与 header.cwd) / callId / signal. */
function exec(callId = 'call-1', sessionId = SESSION_ID, cwd = workspace): ToolRunContext {
  return {
    agent: { session: { id: sessionId, header: { cwd } } },
    callId,
    signal: new AbortController().signal,
  } as unknown as ToolRunContext
}

/** 会话日志里没有 cwd 的执行上下文: 用来验证"判不了就报错"这条 fail-closed 分支. */
function execWithoutCwd(callId = 'call-1', sessionId = SESSION_ID): ToolRunContext {
  return {
    agent: { session: { id: sessionId, header: {} } },
    callId,
    signal: new AbortController().signal,
  } as unknown as ToolRunContext
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(projectTmpDir(), 'dsh-wp-req-')))
  workspace = join(base, 'ws')
  outside = join(base, 'outside')
  mkdirSync(workspace)
  mkdirSync(outside)
})
afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('handleRequest 的直通路径', () => {
  it('工作区外路径经审批后成为本会话的额外可写根', async () => {
    await boot([])
    const result = await handleRequest(ctx, grants, host, outside, '需要在旁边目录写构建产物', exec())
    expect(result.kind).toBe('extra-root')
    expect(result.granted).toBe(true)
    expect(approval.requests).toHaveLength(1)
    expect(approval.requests[0]!.reason).toContain('outside the session workspace')
    expect(approval.requests[0]!.reason).toContain('需要在旁边目录写构建产物')
    expect(policy.resolve({ session: sessionStub() }).writablePaths).toContain(realpathSync(outside))
  })

  it('已在 allow-list 内的路径不需要审批 (平台临时区)', async () => {
    await boot([])
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-wp-req-tmp-')))
    try {
      const result = await handleRequest(ctx, grants, host, tmp, '写临时文件', exec())
      expect(result.kind).toBe('already-writable')
      expect(approval.requests).toHaveLength(0)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('工作区内未被保护的路径不需要审批', async () => {
    await boot(['secrets/'])
    mkdirSync(join(workspace, 'src'))
    const result = await handleRequest(ctx, grants, host, join(workspace, 'src', 'a.ts'), '改源码', exec())
    expect(result.kind).toBe('already-writable')
    expect(approval.requests).toHaveLength(0)
  })

  it('被保护路径下的工作区路径经审批后成为保护旁路', async () => {
    // 目录要在 boot 之前建好: 保护路径的枚举发生在第一次解析时.
    mkdirSync(join(workspace, 'secrets'), { recursive: true })
    await boot(['secrets/'])
    const target = join(workspace, 'secrets', 'token.txt')
    const result = await handleRequest(ctx, grants, host, target, '需要更新测试用密钥', exec())
    expect(result.kind).toBe('override')
    expect(approval.requests[0]!.reason).toContain('overriding write protection')
    const resolved = policy.resolve({ session: sessionStub() })
    expect(resolved.writableOverrides).toContain(target)
    // 旁路不进 writablePaths: 命令沙箱的 allow-list 不因它放宽.
    expect(resolved.writablePaths).not.toContain(target)
  })

  it('规则文件里的条目与设置页文本地位相同, 都能申请旁路', async () => {
    // 规则文件要在 policy 首次解析之前写好: 首次解析才顺带读它.
    writeFileSync(join(workspace, '.readonly'), 'vendor\n')
    mkdirSync(join(workspace, 'vendor'))
    await boot([])
    const result = await handleRequest(ctx, grants, host, join(workspace, 'vendor', 'lib.js'), '升级依赖', exec())
    expect(result.kind).toBe('override')
  })

  it('批过父目录后, 子目录与子文件不再需要申请也不弹窗', async () => {
    mkdirSync(join(workspace, 'secrets', 'deep'), { recursive: true })
    await boot(['secrets/'])
    const parent = join(workspace, 'secrets')
    const first = await handleRequest(ctx, grants, host, parent, '要往这个目录写一批文件', exec('call-1'))
    expect(first.kind).toBe('override')
    expect(approval.requests).toHaveLength(1)
    // 工作着工作着想写子目录: 已在授权覆盖范围内, 直接回"本来就可写".
    const child = await handleRequest(ctx, grants, host, join(workspace, 'secrets', 'deep'), '再往子目录写', exec('call-2'))
    expect(child.kind).toBe('already-writable')
    expect(child.notes.join(' ')).toContain('one grant covers everything under it')
    expect(approval.requests).toHaveLength(1)
    expect(grants.recordOf(SESSION_ID).grants).toHaveLength(1)
  })

  it('批过工作区外的父目录后, 其子目录同样不再需要申请', async () => {
    mkdirSync(join(outside, 'build', 'assets'), { recursive: true })
    await boot([])
    const first = await handleRequest(ctx, grants, host, outside, '构建产物要写在这里', exec('call-1'))
    expect(first.kind).toBe('extra-root')
    const child = await handleRequest(ctx, grants, host, join(outside, 'build'), '写构建子目录', exec('call-2'))
    expect(child.kind).toBe('already-writable')
    expect(approval.requests).toHaveLength(1)
  })

  it('整段保护 (规则文件里一行 **) 时子目录仍可逐个申请', async () => {
    // `.` 在 gitignore 语义下不匹配任何东西 (git check-ignore 同样如此), 整段
    // 保护要写 `**` 或 `/**`.
    mkdirSync(join(workspace, 'a'), { recursive: true })
    writeFileSync(join(workspace, '.readonly'), '**\n')
    await boot([])
    const target = join(workspace, 'a', 'b.txt')
    const result = await handleRequest(ctx, grants, host, target, '写入目录 a', exec())
    expect(result.kind).toBe('override')
    expect(policy.resolve({ session: sessionStub() }).writableOverrides).toContain(target)
  })

  it('整段保护时工作区外侧的路径也照常走额外可写根', async () => {
    writeFileSync(join(workspace, '.readonly'), '/**\n')
    await boot([])
    const result = await handleRequest(ctx, grants, host, outside, '在旁边的目录写产物', exec())
    expect(result.kind).toBe('extra-root')
    expect(policy.resolve({ session: sessionStub() }).writablePaths).toContain(realpathSync(outside))
  })
})

describe('handleRequest 的拒绝路径', () => {
  it('规则文件本身不接受申请', async () => {
    await boot([])
    mkdirSync(join(workspace, 'sub'))
    const error = await handleRequest(ctx, grants, host, join(workspace, '.readonly'), '改规则', exec()).then(
      () => undefined,
      (caught: unknown) => caught,
    )
    expect((error as Error).message).toContain('read-only by design')
    expect(approval.requests).toHaveLength(0)
  })

  it('通配与文件系统根这类无效路径直接拒绝', async () => {
    await boot([])
    await expect(handleRequest(ctx, grants, host, join(outside, '*.log'), '写日志', exec())).rejects.toThrow('glob metacharacters')
    await expect(handleRequest(ctx, grants, host, '/', '放宽根', exec())).rejects.toThrow('filesystem root')
    expect(approval.requests).toHaveLength(0)
  })

  it('用户拒绝时给出拒绝原因', async () => {
    await boot([])
    approval.outcome = 'rejected'
    await expect(handleRequest(ctx, grants, host, outside, '需要写', exec())).rejects.toThrow('the user rejected write access')
    expect(grants.recordOf(SESSION_ID).grants).toHaveLength(0)
  })

  it('审批被取消时给出取消原因', async () => {
    await boot([])
    approval.outcome = 'cancelled'
    await expect(handleRequest(ctx, grants, host, outside, '需要写', exec())).rejects.toThrow('was cancelled')
  })

  it('没有可用审批通道时说明原因', async () => {
    await boot([])
    approval.outcome = 'unavailable'
    await expect(handleRequest(ctx, grants, host, outside, '需要写', exec())).rejects.toThrow('no approval channel is available')
  })

  it('会话审批策略为 never 时不弹窗直接拒绝', async () => {
    await boot([])
    approval.policy = 'never'
    await expect(handleRequest(ctx, grants, host, outside, '需要写', exec())).rejects.toThrow('approval prompts are disabled')
    expect(approval.requests).toHaveLength(0)
  })

  it('allowWritableRequests 关掉时任何调用都被拒且不弹窗', async () => {
    await boot([], '.readonly', 8, false)
    await expect(handleRequest(ctx, grants, host, outside, '需要写', exec())).rejects.toThrow('disabled by this deployment')
    expect(approval.requests).toHaveLength(0)
  })

  it('超过单会话授权上限时拒绝并说明', async () => {
    writeFileSync(join(workspace, '.readonly'), 'a/\nb/\n')
    mkdirSync(join(workspace, 'a'))
    mkdirSync(join(workspace, 'b'))
    await boot([], '.readonly', 1)
    await handleRequest(ctx, grants, host, join(workspace, 'a'), '第一个', exec('call-a'))
    await expect(handleRequest(ctx, grants, host, join(workspace, 'b'), '第二个', exec('call-b'))).rejects.toThrow('maximum of 1')
  })
})

describe('工作区根解析', () => {
  // 部署根换成 outside (里面没有 .git), 会话工作区里有 .git. 若判定回退到部署根,
  // 保护集合会是空的, 工具就会直接答"本来就可写"而不审批 —— 这正是 Host 事件循环
  // 被几十秒同步展开堵死的那条老路径的判定后果.
  it('会话尚未被 resolve 记住时, 用会话 cwd 定位工作区根', async () => {
    // .git 要在 boot 之前建好: 展开结果按 root 做 5s TTL 缓存, boot 里那次 resolve
    // 会先把空结果缓存下来.
    mkdirSync(join(workspace, '.git'))
    await boot(['.git'], '.readonly', 8, true, outside)
    const result = await handleRequest(
      ctx, grants, host, join(workspace, '.git', 'HEAD'), '需要写这个受保护目录', exec('call-fresh', 'session-fresh'),
    )
    expect(result.kind).toBe('override')
    expect(approval.requests).toHaveLength(1)
  })

  it('会话已被 resolve 记住时沿用记下的根', async () => {
    mkdirSync(join(workspace, '.git'))
    await boot(['.git'], '.readonly', 8, true, outside)
    const result = await handleRequest(ctx, grants, host, join(workspace, '.git', 'HEAD'), '再来一次', exec())
    expect(result.kind).toBe('override')
    expect(approval.requests).toHaveLength(1)
  })

  it('会话没有 cwd 且从未被 resolve 过时报错, 不回退部署根', async () => {
    await boot(['.git'], '.readonly', 8, true, outside)
    await expect(handleRequest(
      ctx, grants, host, join(workspace, '.git', 'HEAD'), '没有根', execWithoutCwd('call-no-root', 'session-no-root'),
    )).rejects.toThrow(/has no workspace root/)
    expect(approval.requests).toHaveLength(0)
  })

  it('工作区内的相对路径按工作区根解析, 不会被当成工作区外', async () => {
    // 相对且不存在的路径上 canonicalPath 会原样返回相对形态; 若直接拿它判定, 相对
    // 路径落在 isPathUnder 之外, 就会被当成 extra-root 去问"工作区外写入".
    mkdirSync(join(workspace, '.git'))
    await boot(['.git'], '.readonly', 8, true, outside)
    const result = await handleRequest(ctx, grants, host, join('.git', 'HEAD'), '相对路径申请', exec('call-relative'))
    expect(result.kind).toBe('override')
    expect(result.path).toBe(join(workspace, '.git', 'HEAD'))
    expect(approval.requests[0]!.reason).toContain('overriding write protection')
    expect(approval.requests[0]!.reason).toContain('.git')
    expect(approval.requests[0]!.reason).not.toContain('outside the session workspace')
    // 授权必须记在绝对路径上: 记成相对形态的话, 下一次展开会把它当工作区内条目丢掉,
    // 于是批了也不生效.
    expect(host.resolve(SESSION_ID, workspace)?.writableOverrides).toEqual([join(workspace, '.git', 'HEAD')])
  })
})

describe('GrantsService', () => {
  it('会话之间互不可见, 同一路径重复授权不重复计数', () => {
    const service = new GrantsService(() => 8, () => {})
    expect(service.grant('s1', '/a', 'extra-root').ok).toBe(true)
    expect(service.grant('s1', '/a', 'extra-root').ok).toBe(true)
    expect(service.recordOf('s1').grants).toHaveLength(1)
    expect(service.recordOf('s2').grants).toHaveLength(0)
  })

  it('两类授权分别落到 extraRoots 与 overrides', () => {
    const service = new GrantsService(() => 8, () => {})
    service.grant('s1', '/outside', 'extra-root')
    service.grant('s1', '/ws/protected', 'override')
    expect(service.recordOf('s1').extraRoots).toEqual(['/outside'])
    expect(service.recordOf('s1').overrides).toEqual(['/ws/protected'])
  })

  it('上限按当前配置读取, 超限给出原因', () => {
    let limit = 1
    const service = new GrantsService(() => limit, () => {})
    service.grant('s1', '/a', 'extra-root')
    const outcome = service.grant('s1', '/b', 'extra-root')
    expect(outcome.ok).toBe(false)
    expect(outcome.ok ? '' : outcome.reason).toContain('maximum of 1')
    limit = 2
    expect(service.grant('s1', '/b', 'extra-root').ok).toBe(true)
  })

  it('revoke 同时清掉记录与对应的那一侧清单', () => {
    const service = new GrantsService(() => 8, () => {})
    service.grant('s1', '/outside', 'extra-root')
    service.grant('s1', '/ws/protected', 'override')
    const outcome = service.revoke('s1', '/ws/protected')
    expect(outcome.ok).toBe(true)
    expect(outcome.ok ? outcome.removed.kind : '').toBe('override')
    expect(service.recordOf('s1')).toEqual({
      extraRoots: ['/outside'],
      overrides: [],
      grants: [{ path: '/outside', kind: 'extra-root' }],
    })
    expect(service.revoke('s1', '/outside').ok).toBe(true)
    expect(service.listOf('s1')).toEqual([])
  })

  it('revoke 只认精确路径, 也撤不掉别的会话里那条', () => {
    const service = new GrantsService(() => 8, () => {})
    service.grant('s1', '/ws/protected', 'override')
    service.grant('s2', '/ws/protected', 'override')
    const missing = service.revoke('s1', '/ws/protected/sub')
    expect(missing.ok).toBe(false)
    expect(missing.ok ? '' : missing.reason).toContain('/ws/protected/sub')
    expect(service.revoke('s2', '/ws/protected').ok).toBe(true)
    expect(service.listOf('s1')).toHaveLength(1)
  })
})
