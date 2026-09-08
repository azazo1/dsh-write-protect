# dsh-write-protect

为 DSH 沙箱增加工作区子路径只读保护: 声明过的路径对模型可见的全部写入口保持只读 — 沙箱内的 CLI 命令 (bash 等) 和 write/edit 工具都会被拒绝写入, 读取不受影响.

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

保护路径的默认值统一定义在 `src/constants.ts` 的 `DEFAULT_READ_ONLY_PATHS`, patch 的 policy 行与设置页部署 base 都由它兜底; 需要部署级覆盖时在 patch 行显式给出 `readOnlyPaths`:

```yml
- id: dsh-write-protect-policy
  name: dsh-write-protect
  config:
    mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'
    workspaceRoot: !!js process.cwd()
    # 部署级覆盖示例.
    # readOnlyPaths: ['.git', '//etc/pki']
```

`readOnlyPaths` 的每一项是一行 gitignore 语义的模式, 数组逐行合并为生效文本:

- 不含 `/` 的条目 (如 `.git`, `vendor`) 在工作区内任意层级匹配, 覆盖嵌套仓库等场景.
- 以 `/` 开头或含中间 `/` 的条目锚定到工作区根 (如 `/.git`, `dist/a.txt`); 字面条目即使尚不存在也保留保护, 例如 `git init` 之前的 `/.git`.
- `//` 开头的条目是文件系统绝对路径 (如 `//etc/pki`), 这是本插件的执法扩展, gitignore 没有这个形态.
- 尾部 `/` 表示只匹配目录 (如 `build/`).
- 通配: `*` 匹配单段内任意字符, `?` 匹配单字符, `[...]` 字符类 (含 `[:alpha:]` 等 POSIX 类), `**` 独立成段时递归 (如 `a/**/b`); `\` 转义下一字符 (`\#`, `\!`, 尾部空格用 `\ ` 保留).
- `!` 开头剔除匹配项, 条目按 gitignore 的 last-match-wins 顺序解释; 与 gitignore 的目录剪枝一致, 受保护目录内部无法通过取反重新放行后代.
- 通配条目只匹配展开时刻已存在的路径; 解析结果 canonical 化 (符号链接解析) 并去重.
- 置为空列表 `[]` 即整体停用 (policy 与 fs 行仍挂载, 不产生额外拒绝).

## 设置页

Web Settings 侧边栏的 "写入保护" 页面编辑 gitignore 语义的保护路径文本, 保存后实时生效并持久化:

```text
# 逐行一条模式
.git
secrets/*.pem
!secrets/example.pem
```

- `#` 开头是注释, 空行忽略; `\#`, `\!` 写出字面的 `#`, `!`.
- `!` 开头表示从保护中剔除一条匹配项, 按最后匹配生效的顺序解释; 不能在仍受保护的目录内部重新放行后代.
- 通配与锚定语义同 "配置" 一节, 不再重复.
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

patch 配置与设置页文本都经同一解析器展开 (含通配枚举), 三个半区消费同一份结果.

### 边界与已知限制

- **Landlock** (Linux 上 bwrap 不可用时的回退) 是纯 allow-list 并集, 无法表达子路径例外; 命令会按官方 profile 运行并记录一次告警. Windows 同理不挂载 provider 半区 (保留官方 ACL runner), 由 fs 围栏覆盖 write/edit 工具.
- **bwrap 要求 bind 源存在**: 通配条目枚举出的保护路径在宿主上尚不存在时会跳过 ro-bind 并告警; 需要无条件保护的工作区根路径请用锚定的字面条目 (如 `/.git`), 字面条目不存在时 fs 围栏的拒绝不受影响.
- **通配只覆盖展开时刻已存在的路径**: 展开按 (文本, 工作区) 做 5s TTL 缓存, 新建路径最迟 5s 后纳入保护; glob 遍历受 5000 节点预算约束, 超大工作区中深层路径可能漏展开并产生一次告警.
- **尾部 `/**` 的条目按其命名目录本身保护**: 前缀围栏下与枚举全部后代等价, 同时避免击穿遍历预算, 代价是该目录自身也拒绝写入.
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
