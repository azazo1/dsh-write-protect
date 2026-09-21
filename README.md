# dsh-write-protect

给 DSH 沙箱补上工作区里某一段路径的只读保护, 典型用途是不让模型改 `.git`. 也可以在 `workspace-write` 下声明工作区外的额外可写根, 让 bash 与 write / edit 写到相邻目录, 而不必切到 `danger-full-access`.

工作区根还能放一份只读规则文件 (默认 `.readonly`), 与设置页的保护路径同语义; 任务要反复写同一片受保护区域时, 模型也可以申请本会话的可写授权 (见下文两节).

write / edit 工具在所有平台都会挡住保护路径, 并放行额外可写根. bash 等命令在 Linux / macOS 上同样生效; Windows 上 bash / pwsh 既挡不住 `.git`, 也拿不到额外可写根. 读取不受影响.

官方沙箱只有 "整个工作区可写" 和 "全只读" 两档, 管不到工作区内部的某一段, 也不能把工作区外的个别目录并进 allow-list; Codex 一类实现默认会保护 `.git`, 本插件补这一块.

## 安装

```shell
dsh plugin --profile web add azazo1/dsh-write-protect
```

固定版本:

```shell
dsh plugin --profile web add azazo1/dsh-write-protect#v0.1.1
```

GitHub Release 同时挂不带版本号的预构建包, 安装时跳过 `allowBuilds`:

```shell
dsh plugin --profile web add https://github.com/azazo1/dsh-write-protect/releases/latest/download/dsh-write-protect.tgz
```

安装后会接管沙箱策略和 write / edit 围栏, Linux / macOS 上还会接管命令沙箱. 改配置即时生效, 不用重启 `dsh web`.

## 配置

保护路径, 额外可写根, 规则文件名, 各项上限与两个开关的默认值都定义在 `src/constants.ts` 的 `DEFAULT_*`, patch 的 policy 行与设置页部署 base 都由它们兜底; 需要部署级覆盖时在 patch 行显式给出字段 (整行替换, `mode` / `workspaceRoot` 必须带上):

```yml
- id: dsh-write-protect-policy
  name: dsh-write-protect
  config:
    mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'
    workspaceRoot: !!js process.cwd()
    # 部署级覆盖示例.
    # readOnlyPaths: ['.git', '//etc/pki']
    # writablePaths: ['../shared-scratch', '//tmp/dsh-extra']
    # hardenBroker: false
    # readonlyFileName: '.readonly'   # 置空即关闭工作区规则文件识别
    # maxReadOnlyEntries: 200
    # maxGrants: 8
    # allowWritableRequests: true   # 置 false 即不许模型申请可写路径
```

`readOnlyPaths` 的每一项是一行 gitignore 语义的模式, 数组逐行合并为生效文本:

- 不含 `/` 的条目 (如 `.git`, `vendor`) 在工作区内任意层级匹配, 覆盖嵌套仓库等场景.
- 以 `/` 开头或含中间 `/` 的条目锚定到工作区根 (如 `/.git`, `dist/a.txt`); 字面条目即使尚不存在也保留保护, 例如 `git init` 之前的 `/.git`.
- `//` 开头的条目是文件系统绝对路径 (如 `//etc/pki`), 这是本插件额外支持的写法, gitignore 没有这种形态.
- 尾部 `/` 表示只匹配目录 (如 `build/`).
- 通配: `*` 匹配单段内任意字符, `?` 匹配单字符, `[...]` 字符类 (含 `[:alpha:]` 等 POSIX 类), `**` 独立成段时递归 (如 `a/**/b`); `\` 转义下一字符 (`\#`, `\!`, 尾部空格用 `\ ` 保留).
- `!` 开头剔除匹配项, 按 gitignore 的 last-match-wins 顺序解释; 受保护目录内部无法通过取反重新放行后代.
- 通配条目只匹配展开时刻已存在的路径; 解析时会解开符号链接并去重.
- 置为空列表 `[]` 即停用保护 (插件仍在, 只是不再多挡任何路径).

`writablePaths` 的每一项是一行字面路径, 不是 gitignore glob:

- 行首 `~` 或 `~/...` 展开为当前用户家目录; `~other` 不支持.
- `$NAME` 与 `${NAME}` 展开为环境变量; 未设置或空值的变量整行丢弃并告警. `\$` 保留字面 `$`.
- 宿主绝对路径 (`/tmp/extra`) 或 `//` 前缀 (`//tmp/extra`) 按文件系统解析.
- 其余相对当前会话工作区, 含 `..` (如 `../sibling-project`).
- 工作区内的路径本来就可写, 展开时忽略并告警; 文件系统根 (`/` 或盘符根) 拒绝, 避免把只读宿主根整棵翻成可写.
- 不支持通配与 `!` 取反. 不存在的路径仍保留词法形态: write / edit 与 Seatbelt 可按前缀放行, bwrap / Landlock 在叠加时跳过并告警.
- 只在 `workspace-write` 下并进 allow-list, 不打穿 `read-only`. 保护路径优先: 额外根内部仍可被保护.
- 置为空列表即不额外放行.

`hardenBroker` 是 macOS broker 逃逸加固的部署 base, 布尔值, 缺省 `true`:

- 开启时在 Seatbelt profile 末尾追加 broker 拒绝形式 (见 "保护范围").
- 关掉后命令按官方 profile 运行, 只影响 macOS, 只影响这一个加固; 保护路径与额外可写根照常.
- 用户在设置页拨动开关后该值不再生效.

`readonlyFileName` / `maxReadOnlyEntries` / `maxGrants` / `allowWritableRequests` 同理, 是只读规则文件与可写申请的部署 base (见后两节), 用户保存过对应字段后该值不再生效.

源码分三块, 边界是"有没有文件系统依赖":

| 文件 | 职责 | 依赖 |
|---|---|---|
| `src/gitignore.ts` | gitignore 语义的解析与**逐路径匹配** (`PatternSet.match`), 规则文件校验与可写申请的保护判定共用 | 纯字符串/正则, **零运行时依赖** |
| `src/patterns.ts` | 把模式**枚举**成具体路径, 供保护路径清单与命令沙箱使用 | `node:fs`、`canonicalPath` |
| `src/fs.ts` / `src/policy.ts` / `src/provider.ts` | 三个挂载点: write/edit 围栏、沙箱策略、进程沙箱 argv 叠加 | DSH 引擎 |

`src/readonly-file.ts` 负责工作区只读规则文件的读取与缓存, `src/path-expand.ts` 负责额外可写根的字面路径展开, `src/request-writable-path.ts` 是可写申请的授权表与 `request_writable_path` 工具.

## 设置页

<img src="https://raw.githubusercontent.com/azazo1/dsh-write-protect/HEAD/docs/screenshots/settings-page.png" alt="写入保护设置页" width="520">

Web Settings 侧边栏的 "写入保护" 页面有五块内容: 保护路径 (gitignore 语义), 额外可写根 (字面路径), 只读规则文件名与两个上限, "模型申请可写路径" 开关, 以及 macOS broker 加固开关. 保存后实时生效并持久化:

```text
# 保护路径
.git
secrets/*.pem
!secrets/example.pem
```

```text
# 额外可写根
../shared-scratch
~/scratch
$HOME/scratch
/tmp/dsh-extra
```

- 保护路径: `#` 开头是注释, 空行忽略; `!` 排除, 按最后匹配生效; 不能在仍受保护的目录内部重新放行后代. 通配与锚定语义同 "配置" 一节. Windows 上的绝对条目写作 `//C:/Users/me/secret`: gitignore 语义里 `\` 是转义符, `/` 才是分隔符.
- 额外可写根: 每行一条字面路径, 不要通配. `~` / `~/...` 为家目录, `$NAME` / `${NAME}` 为环境变量; 绝对路径按文件系统解析, 相对路径 (含 `..`) 相对当前会话工作区. Windows 上 `\` 是分隔符而不是转义符, `C:\Users\me\caches` 与 `~\caches` 都按字面解析; 盘符相对路径 (`C:caches`) 的落点取决于进程当前目录, 会被拒绝并出现在 "未生效" 里.
- 两份文本都按当前会话的工作区根解析, 每个会话各自生效. 开关是全局的, 与工作区无关.
- 预览按钮把当前草稿交给 Host 展开, 不必先保存: 列出生效的保护路径与额外可写根, 工作区规则文件的条目, 本会话已批准的可写授权, 以及被忽略或拒绝的行. 展开使用当前选中会话的 cwd; 没有选中会话时回退到部署工作区根 (通常是 `dsh web` 的启动路径).

`mode` 与 `workspaceRoot` 是官方 policy 行字段的复述 (patch 对整行配置做替换, 必须带上), 取值语义与 base bundle 一致.

## 只读规则文件

工作区根可以放一份与 "保护路径" 同语义的规则文件 (默认 `.readonly`, 可在设置页改名或置空关闭), 逐行追加在设置页文本之后:

```text
# <工作区根>/.readonly
secrets/
/vendor
!vendor/public/**
**
```

- 只认工作区根这一份, 每个会话各读一份; 整段保护工作区写 `**` 或 `/**`, 根下第一层用 `/*`; `/` 与 `.` 匹配不到任何路径, 等于什么都不保护.
- 只接受普通文件 (符号链接拒绝); `//` 绝对条目与越出工作区的 `..` 条目拒绝, 超限条目丢弃, 都只告警不生效.
- **这份文件本身是唯一的硬保护**: 在 `read-only` 与 `workspace-write` 下任何授权都不放行它, 也没有 `request_writable_path` 可受理它; 要改只能换文件名或由你在 DSH 之外编辑. (整个 `danger-full-access` 模式下本插件不介入, 见 "边界与已知限制".)

## 模型申请可写路径

提示词会引导模型: 任务要反复写同一片受保护区域时 (一个目录里的多个文件, 构建产物树, 若干次写入都依赖的工作区外路径), 调 `request_writable_path` 申请本会话的可写授权, 参数是 `path` (字面路径, 支持 `~` / `$VAR` / `//` / 相对含 `..`) 与 `justification` (给你看的一句话理由); 单个文件照旧用 write / edit 工具, 那次被拒就算了.

审批理由会写明在放开什么: 工作区外的路径批准后成为本会话的额外可写根 (bash 与 write / edit 都能写), 工作区内被保护路径只对 write / edit 放行 (命令侧的只读挂载与 Seatbelt 规则在启动前就定好了, 运行期收不回来). 授权只在本会话内存里, 不写 settings, 条数上限 `maxGrants` (默认 8); 关掉 `allowWritableRequests` 后工具的任何调用都被拒, 提示词也不再引导. 保护路径与规则文件条目都在可申请范围内, 因此可以配成 "整个工作区只读 + 逐个目录批准".

## 保护范围

保护路径与额外可写根会同时作用在下面几个入口, 解析结果是同一份:

| 入口 | 哪些系统 | 效果 |
|---|---|---|
| write / edit 工具 | 全平台 | `workspace-write` 下保护路径拒绝, 额外根放行; `danger-full-access` 下全部放行 |
| bash 等命令 | Linux, macOS | 内核级只读 / 额外可写; Windows 做不到, 见下方限制 |
| 提示词 | 全平台 | 先告诉模型哪些不能写, 哪些额外根可写, 需要反复写时怎么申请 |
| 本会话授权 (`request_writable_path`) | 全平台 | 工作区外路径按额外根生效; 保护旁路只影响 write / edit |
| macOS broker 加固 | macOS | 堵住 `open` 经 launchd 把命令挪到沙箱外执行 |

主场景是 `workspace-write`. `read-only` 下官方已挡住全部文件写入, 额外可写根不打穿; 但官方 profile 的 `(allow default)` 在两种模式下都一样, 所以 broker 加固不区分模式.

### macOS broker 逃逸加固

官方 macOS profile 是 `(version 1) (allow default) (deny file-write*) ...`, `mach-lookup` 与 `process-exec` 全开. 而经 launchd 代理启动的进程不继承 Seatbelt profile, 于是沙箱内一条 `open x.app` 就能让启动的进程在沙箱外任意读写, `deny file-write*` 被整条绕开 —— `read-only` 同样会被打穿. 本插件在 profile 末尾追加:

```text
(deny mach-lookup (global-name-prefix "com.apple.coreservices"))
(deny appleevent-send)
(deny mach-priv-task-port)
```

SBPL 按 last-match-wins 解释, 追加在末尾才能盖过 `(allow default)`. `com.apple.coreservices` 是 LaunchServices 的服务名段, `open` / `NSWorkspace` 靠它把请求交给 launchd; 名称过滤器按 reverse-DNS 分段匹配, 所以只能整段拒绝, 收窄到子服务无效. `appleevent-send` 关掉让别的 app 代劳那条路, `mach-priv-task-port` 关掉注入已运行进程的 task port.

加固只做收紧, 不放宽任何位置; 常规命令 (node, git, pnpm, python, curl, tar, rsync 等) 不受影响.

设置页的 "macOS broker 逃逸加固" 开关与 patch 的 `hardenBroker` 控制这一个加固是否生效, 缺省开启. 关掉后 provider 原样返回官方 argv, 适合确实需要从沙箱内驱动宿主 GUI 的场景; 关掉即恢复可以被 `open` 打穿的状态. 保护路径与额外可写根的叠加不受这个开关影响.

patch 配置和设置页文本走同一套解析.

### 边界与已知限制

- **Windows 上 bash 挡不住, 也放不宽**: write / edit 能挡保护路径、能放行额外根; bash / pwsh 两者都不行. Windows 沙箱只能把整个工作区设成可写或不可写.
- **broker 加固只在 macOS 生效**: 官方 macOS profile 的 `(allow default)` 让 `open` 能把命令交给 launchd 在沙箱外跑, 本插件追加的拒绝形式堵住这条路. Linux 的 bwrap 用 mount namespace, 没有 launchd 那类代理通道, 但它的网络命名空间未隔离, 沙箱内仍可连宿主守护进程 (Docker socket, ssh-agent 一类) 让外面代劳, 这类问题本插件不处理.
- **Linux 没有 bwrap, 落到 Landlock 时**: 没法单独保护子路径, 命令按官方沙箱跑并告警一次; 额外可写根可以加 `--rw`. write / edit 两者都生效.
- **完全放开沙箱时** (`danger-full-access`): 本插件整体不介入 —— bash 不进沙箱, write / edit 的保护路径与规则文件判定也跳过. 该模式是用户显式选择的"不设限", 保护只在 `read-only` 与 `workspace-write` 下生效.
- **Linux bwrap 要求路径真实存在**: 通配扫出来的保护路径如果当时还不在磁盘上, 会跳过这条只读挂载并告警. 需要无条件保护的工作区根路径请用字面条目 (如 `/.git`); 字面条目即使还不存在, write / edit 也会拒绝.
- **通配只覆盖展开当时已经存在的路径**: 展开结果缓存 5 秒, 新建路径最迟 5 秒后纳入保护. 已经要保护的目录不会再往里扫, 里面的匹配项不再单独列出; 被 `!` 放行的目录还会继续找. 目录符号链接不跟随, 避免扫到工作区外.
- **尾部 `/**` 按那个目录本身保护**: 和保护其下全部后代等价, 同时避免枚举全部后代, 代价是该目录自己也写不了.
- **规则文件的条目同样受缓存窗口影响**: 规则文件内容按 1 秒 TTL 重读, 改完最迟 1 秒后按新内容判定; 新增的匹配路径还要等下一次枚举 (5 秒 TTL) 才会进命令沙箱的清单, write / edit 侧立刻按新条目判定.
- **授权是会话级内存态**: `request_writable_path` 得到的授权不跨会话, 也不写配置文件; 需要长期生效的额外可写根请写设置页或 patch.
- 指向保护目录内部的符号链接会被拒绝, 指向外部的不受影响.

## 本地开发

```shell
just install    # 安装依赖
just typecheck  # TypeScript 类型检查
just build      # 构建 lib/
just test       # 测试套件 (Seatbelt e2e 仅在 macOS 上运行)
just verify     # 以上全流程 + 打包预览
```

测试覆盖: 路径解析语义 (相对锚定, 解开符号链接, 去重, 通配枚举与取反, 额外可写字面路径), 只读规则文件的解析与校验 (符号链接拒绝, 绝对与越界条目, 条目上限, 缓存与重读), 可写申请的判定矩阵 (直通, 规则文件硬保护, 工作区内旁路, 超限, 四种未获同意的结果) 与授权落到 policy 的通道, bwrap / Seatbelt / Landlock 的命令行叠加, write / edit 工具的拒绝与额外根放行矩阵, settings 通道的 base 与用户覆盖分层, client bundle 的 loader 注册, 以及 macOS 上真实 `sandbox-exec` 的内核级端到端 —— 包括 `open` broker 逃逸的对照组与加固后的拦截验证.

## License

MIT
