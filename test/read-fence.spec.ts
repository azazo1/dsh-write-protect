// ReadFence: 工具层读拒绝 (派发前按会话 policy 判定) 与搜索结果过滤.
// 判定是纯逻辑 + 少量 fs 探测, 因此这里用真实临时工作区造路径, 直接驱动围栏,
// 不搭完整工具运行时.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { PostToolDecision, PreToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { ReadFence } from '../src/read-fence.ts'
import { projectTmpDir } from './fixture-root.ts'

const ws = realpathSync(mkdtempSync(join(projectTmpDir(), 'dsh-wp-fence-')))
const secretDir = join(ws, 'secret')
const secretFile = join(secretDir, 'token.txt')
const openFile = join(ws, 'notes.md')
mkdirSync(secretDir, { recursive: true })
writeFileSync(secretFile, 'shh\n')
writeFileSync(openFile, 'hello\n')

afterAll(() => {
  rmSync(ws, { recursive: true, force: true })
})

/** 造一个只提供 sandboxPolicy 的 context: 围栏只从这里取判定依据. */
function fenceFor(policy: SandboxExecutionPolicy): ReadFence {
  const ctx = {
    get: (name: string) => name === 'sandboxPolicy' ? { resolve: () => policy } : undefined,
  } as unknown as Context
  return new ReadFence(ctx)
}

function policyOf(extra: Partial<SandboxExecutionPolicy> = {}): SandboxExecutionPolicy {
  return { mode: 'workspace-write', workspaceRoot: ws, ...extra }
}

function readDenied(extra: Partial<SandboxExecutionPolicy> = {}): SandboxExecutionPolicy {
  return policyOf({ readDenyPatterns: 'secret', ...extra })
}

/** 一次工具调用的最小形状: 围栏只读 name / arguments / agent.session. */
function exec(name: string, args: Record<string, unknown>, cwd = ws): ToolExecution {
  return {
    name,
    arguments: args,
    agent: { session: { id: 'session-1', header: { cwd } } },
  } as unknown as ToolExecution
}

const allow: () => Promise<PreToolDecision> = async () => ({ kind: 'allow' })

function success(value: unknown): ToolExecutionResult {
  return { isError: false, value, content: [] } as unknown as ToolExecutionResult
}

const accept: () => Promise<PostToolDecision> = async () => ({ kind: 'accept' })

describe('ReadFence 派发前判定', () => {
  it('目标落在读拒绝范围内时拒绝, 并引导模型走已有授权通道', async () => {
    const fence = fenceFor(readDenied())
    const decision = await fence.preExecute(exec('read', { file_path: secretFile }), allow)
    expect(decision.kind).toBe('deny')
    expect(decision.kind === 'deny' ? decision.reason : '').toContain('request_writable_path')
    expect(decision.kind === 'deny' ? decision.reason : '').toContain('secret')
  })

  it('相对路径按会话 cwd 解析', async () => {
    const fence = fenceFor(readDenied())
    const decision = await fence.preExecute(exec('read', { file_path: 'secret/token.txt' }), allow)
    expect(decision.kind).toBe('deny')
  })

  it('读拒绝范围之外的路径照常放行', async () => {
    const fence = fenceFor(readDenied())
    expect(await fence.preExecute(exec('read', { file_path: openFile }), allow)).toEqual({ kind: 'allow' })
  })

  it('没有读拒绝配置时不拦任何读取', async () => {
    const fence = fenceFor(policyOf())
    expect(await fence.preExecute(exec('read', { file_path: secretFile }), allow)).toEqual({ kind: 'allow' })
  })

  it('danger-full-access 下不介入', async () => {
    const fence = fenceFor(readDenied({ mode: 'danger-full-access' }))
    expect(await fence.preExecute(exec('read', { file_path: secretFile }), allow)).toEqual({ kind: 'allow' })
  })

  it('本会话授权同时解锁读取', async () => {
    const fence = fenceFor(readDenied({ sessionGrantPaths: [secretDir] }))
    expect(await fence.preExecute(exec('read', { file_path: secretFile }), allow)).toEqual({ kind: 'allow' })
  })

  it('grep / glob 的 scope 落在读拒绝范围内时拒绝', async () => {
    const fence = fenceFor(readDenied())
    expect((await fence.preExecute(exec('grep', { pattern: 'x', path: secretDir }), allow)).kind).toBe('deny')
    expect((await fence.preExecute(exec('glob', { pattern: '**/*.txt', path: secretDir }), allow)).kind).toBe('deny')
    // 默认 scope 是整个工作区: scope 本身没命中, 结果侧再逐条过滤.
    expect(await fence.preExecute(exec('grep', { pattern: 'x' }), allow)).toEqual({ kind: 'allow' })
  })

  it('str_replace_editor 只挡读命令 view, 写命令交给写围栏', async () => {
    const fence = fenceFor(readDenied())
    expect((await fence.preExecute(exec('str_replace_editor', { command: 'view', path: secretFile }), allow)).kind).toBe('deny')
    expect(await fence.preExecute(exec('str_replace_editor', { command: 'create', path: join(secretDir, 'new.txt') }), allow))
      .toEqual({ kind: 'allow' })
  })

  it('其余监听器的拒绝优先于本围栏', async () => {
    const fence = fenceFor(readDenied())
    const prior: PreToolDecision = { kind: 'deny', reason: 'other policy' }
    expect(await fence.preExecute(exec('read', { file_path: secretFile }), async () => prior)).toEqual(prior)
  })

  it('没有 policy service 时退化成不拦', async () => {
    const ctx = { get: () => undefined } as unknown as Context
    const fence = new ReadFence(ctx)
    expect(await fence.preExecute(exec('read', { file_path: secretFile }), allow)).toEqual({ kind: 'allow' })
  })
})

describe('ReadFence 结果过滤', () => {
  const matches = [
    { path: 'secret/token.txt', lineNumber: 1, line: 'shh' },
    { path: 'notes.md', lineNumber: 1, line: 'hello' },
  ]

  it('grep 结果里读拒绝路径下的条目被滤掉', async () => {
    const fence = fenceFor(readDenied())
    const decision = await fence.postExecute(exec('grep', { pattern: 'h' }), success({ matches }), accept)
    expect(decision.kind).toBe('accept')
    const value = decision.kind === 'accept' ? decision.value as { matches: unknown[] } : undefined
    expect(value?.matches).toEqual([{ path: 'notes.md', lineNumber: 1, line: 'hello' }])
  })

  it('授权范围内的条目不再被滤掉', async () => {
    const fence = fenceFor(readDenied({ sessionGrantPaths: [secretDir] }))
    const decision = await fence.postExecute(exec('grep', { pattern: 'h' }), success({ matches }), accept)
    expect(decision).toEqual({ kind: 'accept' })
  })

  it('全部命中都被拒绝时整条结果转为错误反馈', async () => {
    const fence = fenceFor(readDenied())
    const decision = await fence.postExecute(
      exec('grep', { pattern: 'shh' }),
      success({ matches: [matches[0]] }),
      accept,
    )
    expect(decision.kind).toBe('block')
  })

  it('glob 结果同样过滤', async () => {
    const fence = fenceFor(readDenied())
    const decision = await fence.postExecute(
      exec('glob', { pattern: '**/*' }),
      success({ root: '.', paths: ['secret/token.txt', 'notes.md'] }),
      accept,
    )
    const value = decision.kind === 'accept' ? decision.value as { paths: string[] } : undefined
    expect(value?.paths).toEqual(['notes.md'])
  })

  it('没有读拒绝配置时不改写结果', async () => {
    const fence = fenceFor(policyOf())
    expect(await fence.postExecute(exec('grep', { pattern: 'h' }), success({ matches }), accept)).toEqual({ kind: 'accept' })
  })
})
