# dsh-write-protect

为 DSH 沙箱增加工作区子路径只读保护: 声明过的路径 (默认任意层级的 `.git` 目录) 对模型可见的全部写入口保持只读 — 沙箱内的 CLI 命令 (bash 等) 和 write/edit 工具都会被拒绝写入, 读取不受影响.

DSH 官方沙箱只有 "全工作区可写 / 全只读" 两个粒度, 无法对工作区内的子路径 (典型如 `.git`) 收窄; Codex 等实现默认保护 `.git`, 本插件补齐这一块.

## 安装

```shell
dsh plugin --profile web add azazo1/dsh-write-protect
```

固定版本:

```shell
dsh plugin --profile web add azazo1/dsh-write-protect#v0.1.0
```

安装后 patch 会替换 base bundle 的三个行: `sandbox-policy`, `fs-sandbox`, 以及 Linux/macOS 上的 `sandbox`. 配置级修改通过 HMR 实时生效, 无需重启 `dsh web`.

## 配置

保护路径在 patch 的 policy 行配置, 默认 `['**/.git']` 即保护工作区内任意层级的 `.git`:

```yml
- id: dsh-write-protect-policy
  name: dsh-write-protect
  config:
    mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'
    workspaceRoot: !!js process.cwd()
    readOnlyPaths: ['**/.git']
```

`readOnlyPaths` 的每一项:

- 相对路径 (如 `.git`, `node_modules`, `dist/tsconfig.tsbuildinfo`) 相对当前会话的工作区根解析, 每个会话各自指向自己工作区下的同名路径.
- 绝对路径 (如 `/etc/pki`) 原样使用.
- 所有条目在解析时经过 canonical 化 (符号链接解析) 并去重, 与官方 `writableRoots` 的路径身份一致.
- 置为空列表 `[]` 即整体停用 (policy 与 fs 行仍挂载, 不产生额外拒绝).

## 设置页

Web Settings 侧边栏的 "写入保护" 页面编辑 gitignore 风格的保护路径文本, 保存后实时生效并持久化, 覆盖 patch 配置的 `readOnlyPaths` 部署 base (未编辑过时页面展示 base):

```text
# 逐行一条路径
.git
secrets/*.pem
!secrets/example.pem
```

- `#` 开头是注释, 空行忽略.
- `!` 开头表示从保护中剔除一条展开结果 (不能在仍受保护的目录内部重新放行后代).
- `*` 匹配单段内任意字符, `**` 递归匹配后代, `?` 匹配单字符; 通配只匹配展开时刻已存在的路径 (以 `/` 开头的条目按绝对路径解释).
- 相对条目按当前会话的工作区根解析, 每个会话各自生效.

`mode` 与 `workspaceRoot` 是官方 policy 行字段的复述 (patch 对整行配置做替换, 必须带上), 取值语义与 base bundle 一致.

## 执法面

配置的保护路径同时下发到三个执法半区, 彼此共享同一份解析结果:

| 半区 | 挂载范围 | 机制 |
|---|---|---|
| `sandbox` provider | Linux (bwrap), macOS (Seatbelt) | 内核级: bwrap 在可写 bind 之上叠加 `--ro-bind`; Seatbelt 在 profile 末尾追加 `(deny file-write* (subpath ...))` |
| `fs-sandbox` 围栏 | 全平台 | write/edit 工具在官方模式围栏之前追加保护路径检查 |
| systemPrompt 提示 | 全平台 | 告知模型哪些路径受保护, 避免反复尝试 |

保护检查独立于沙箱模式: `danger-full-access` 下进程沙箱整体放开, 但 write/edit 工具对保护路径的拒绝仍然生效; `read-only` 模式下官方围栏本就全量拒绝, 保护检查自动短路. `workspace-write` 是保护的主场景.

配置入口有两个 (设置页覆盖 patch base, 见上一节): patch 配置的 `readOnlyPaths` 数组与设置页的 patterns 文本最终都经同一解析器展开 (含通配枚举), 三个半区消费同一份结果.

### 边界与已知限制

- **Landlock** (Linux 上 bwrap 不可用时的回退) 是纯 allow-list 并集, 无法表达子路径例外; 命令会按官方 profile 运行并记录一次告警. Windows 同理不挂载 provider 半区 (保留官方 ACL runner), 由 fs 围栏覆盖 write/edit 工具.
- **bwrap 要求 bind 源存在**: 保护路径在宿主上尚不存在时 (例如还没 `git init`), 该路径的 ro-bind 会跳过并告警, fs 围栏对该路径的拒绝不受影响.
- **bash 无进程沙箱的模式不受保护**: 进程沙箱由官方 `sandbox` 行的 runner 链决定, 本插件只在被沙箱约束的执行上叠加收窄; `danger-full-access` 下 bash 的写入不经沙箱.
- fs 侧的检查是对模型可控路径的策略 containment (与官方围栏同一威胁模型), 指向保护目录内部的符号链接会被拒绝, 指向外部的不受影响.

## 本地开发

```shell
just install    # 安装依赖
just typecheck  # TypeScript 类型检查
just build      # 构建 lib/
just test       # 测试套件 (Seatbelt e2e 仅在 macOS 上运行)
just verify     # 以上全流程 + 打包预览
```

测试覆盖: 路径解析语义 (相对锚定, canonical 化, 去重, 通配枚举与取反), bwrap/Seatbelt 的 argv 叠加, write/edit 工具的拒绝矩阵 (含符号链接与缺失保护路径), client bundle 的 loader 注册, 以及 macOS 上真实 `sandbox-exec` 的内核级端到端.

## License

MIT
