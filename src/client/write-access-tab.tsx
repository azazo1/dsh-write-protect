/**
 * 会话区的 "写入权限" tab: 列出本会话内存里的可写授权, 逐条撤回, 以及手动加临时
 * 可写根. 与 "对话" / "轨迹" 并列, 由 `conversation.view` 槽挂上去.
 *
 * 这里只有界面: 取数与写操作走注入的 {@link WriteAccessFace} (Host 的 `/api` 路由),
 * 组件自己只持有"最近一次结果 / 进行中 / 错误"三个本地状态. 撤回之后 Host 会把
 * 这次撤回作为一条消息投进会话, 面板把投递结果如实写出来 —— 没投出去 (会话当前
 * 没有活动的 agent) 就说没投出去, 不要让用户以为模型一定知道了.
 * @module dsh-write-protect/client/write-access-tab
 */

import { useEffect, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
// 只取类型合并: 会话槽位的标准 props (sessionId) 由该包声明.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { GrantsResponse } from '../constants.ts'
import { grantKindLabel, type WriteAccessFace } from './write-access.ts'

/** tab 组件收到的 props: 会话槽位的标准 props + 本插件注入的数据面. */
export type WriteAccessTabProps = ConvViewProps & InjectFace<WriteAccessFace>

interface PanelState {
  /** 有一次请求在飞. */
  loading: boolean
  /** 最近一次失败的原因. */
  error: string
  /** 最近一次成功的结果; 还没拿到时是 undefined. */
  view?: GrantsResponse
  /** 最近一次动作的人话说明 (已填入的路径与通知投递情况). */
  status: string
}

/** 撤回之后的状态说明, 按通知是否真的投出去分开讲. */
function revokeStatus(view: GrantsResponse, path: string): string {
  if (view.notice === 'queued') return `已撤回 ${path}, 并把这次撤回作为一条消息排入本会话 (模型下一步会看到).`
  if (view.notice === 'no-session') return `已撤回 ${path}. 本会话当前没有活动的 agent, 因此没有投递通知.`
  return `已撤回 ${path}.`
}

/** 添加之后的状态说明. */
function addStatus(view: GrantsResponse, path: string): string {
  const kind = view.changed?.kind === undefined ? '' : ` (${grantKindLabel(view.changed.kind)})`
  return `已加入${kind}: ${view.changed?.path ?? path}. 只在本会话内存里, 重启 dsh 后失效.`
}

/**
 * 渲染写入权限面板.
 * @param props - 会话槽位 props 与注入的数据面.
 */
export function WriteAccessTab(props: WriteAccessTabProps) {
  const [state, setState] = useState<PanelState>({ loading: true, error: '', status: '' })
  const [draft, setDraft] = useState('')

  const apply = (
    pending: Promise<GrantsResponse>,
    describe: (view: GrantsResponse) => string,
  ): void => {
    setState(previous => ({ ...previous, loading: true, error: '' }))
    void pending.then((view) => {
      setState({ loading: false, error: '', status: describe(view), view })
    }).catch((caught: unknown) => {
      const message = caught instanceof Error ? caught.message : String(caught)
      setState(previous => ({ ...previous, loading: false, error: message, status: '' }))
    })
  }

  // 会话一换就重读: 槽位按会话渲染, 授权表也是按会话存的.
  useEffect(() => {
    apply(props.load(), () => '')
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只跟着会话 id 重读
  }, [props.sessionId])

  const view = state.view
  const grants = view?.grants ?? []
  const onSubmit = (event: { preventDefault: () => void }): void => {
    event.preventDefault()
    const path = draft.trim()
    if (path.length === 0 || state.loading) return
    setDraft('')
    apply(props.add(path), next => addStatus(next, path))
  }

  return (
    <div className="dsh-wp-tab">
      <div className="dsh-wp-tab-head">
        <span className="dsh-wp-tab-title">写入权限</span>
        <button
          type="button"
          className="dsh-wp-button"
          disabled={state.loading}
          onClick={() => { apply(props.load(), () => '') }}
        >
          {state.loading ? '读取中...' : '刷新'}
        </button>
      </div>
      <p className="dsh-wp-hint">
        本会话内存里的可写授权: 模型申请并经你批准的, 以及你在下面手动加的. 会话结束或重启 dsh 后自动消失.
      </p>
      {view?.mode === 'read-only'
        ? <p className="dsh-wp-warning">当前是 read-only 模式: 这里加的授权要等会话切到 workspace-write 或 danger-full-access 之后才生效.</p>
        : null}
      {state.error === '' ? null : <p className="dsh-wp-invalid">{state.error}</p>}
      {state.status === '' ? null : <p className="dsh-wp-status">{state.status}</p>}

      <p className="dsh-wp-preview-label">
        {`当前授权 (${String(grants.length)}${view === undefined ? '' : ` / ${String(view.maxGrants)}`})`}
      </p>
      {grants.length === 0
        ? <p className="dsh-wp-empty">{view === undefined ? '还没有读到本会话的授权.' : '本会话没有可写授权.'}</p>
        : (
          <ul className="dsh-wp-grants">
            {grants.map(grant => (
              <li key={grant.path} className="dsh-wp-grant">
                <code className="dsh-wp-grant-path">{grant.path}</code>
                <span className="dsh-wp-grant-kind">{grantKindLabel(grant.kind)}</span>
                <button
                  type="button"
                  className="dsh-wp-grant-action"
                  disabled={state.loading}
                  onClick={() => { apply(props.revoke(grant.path), next => revokeStatus(next, grant.path)) }}
                >
                  撤回
                </button>
              </li>
            ))}
          </ul>
        )}

      <form className="dsh-wp-add" onSubmit={onSubmit}>
        <input
          className="dsh-wp-input"
          type="text"
          value={draft}
          disabled={state.loading}
          placeholder="~/scratch 或 out/notes (相对会话工作区)"
          aria-label="要加为临时可写根的路径"
          onChange={(event) => { setDraft(event.target.value) }}
        />
        <button type="submit" className="dsh-wp-button" disabled={state.loading || draft.trim().length === 0}>
          加为临时可写根
        </button>
      </form>
      <p className="dsh-wp-hint">
        工作区内的路径记作保护旁路 (放开命中它的保护条目), 工作区外的记作额外可写根; 两者都只在本会话内存里, 不写配置.
      </p>
      {view === undefined ? null : (
        <p className="dsh-wp-hint">
          工作区根: <code>{view.workspaceRoot}</code>
        </p>
      )}
    </div>
  )
}
