#!/usr/bin/env bash
# 把本检出安装进一个 DSH profile (Linux / macOS).
#
# 用法 (在检出根目录):
#   ./scripts/install.sh                         # 装进 web profile
#   ./scripts/install.sh headless                # 位置参数等价于 --profile headless
#   ./scripts/install.sh --profile headless      # 同上
#   ./scripts/install.sh --dsh-home ~/.dsh       # 指定 DSH home (默认 $DSH_HOME, 再退到 ~/.dsh)
#
# 注册是自动的: 包声明了 dsh.bundle.patch, `dsh plugin add` 会把它追加进 profile
# 的 dsh.profile.bundles, 该 bundle 的 cordis.patch.yml 层随后把官方的
# sandbox-policy / fs-sandbox 与 Linux / macOS 上的 sandbox 行换成本包的三行,
# 不需要手写 patch.
#
# 为什么要先复制: Node 会把符号链接解析回真实路径, 插件源码在 profile 之外时,
# 从检出目录向上走不到宿主自己的 @deepseek-ai/* (模块回退只覆盖
# $DSH_HOME/profiles 之内的父目录), boot 会报 "Cannot find package
# '@deepseek-ai/dsh-sandbox-local'". 复制到 <profile>/plugins/<pkg> 后即可解析.
# (从 npm registry 或 GitHub 安装没有这个问题: pnpm 会把包物化在 profile 里.)
#
# 引擎版本线: 本包跟随 @deepseek-ai/* 的 0.1.6-alpha.1 (官方
# SandboxProvider.confine() 自该版本起改为异步). 更早的引擎请改用 v0.1.1.
set -euo pipefail

PACKAGE=dsh-write-protect
PROFILE=web
DSH_HOME_DIR=${DSH_HOME:-$HOME/.dsh}
# 脚本在 <包根>/scripts 下, 包根 (检出目录) 是它的上一级.
SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

usage() {
  cat <<'EOF'
用法: ./scripts/install.sh [--profile <名字>] [--dsh-home <目录>] [<profile>]

  --profile <名字>    目标 profile, 默认 web
  --dsh-home <目录>   Harness home, 默认 $DSH_HOME, 再退到 ~/.dsh
  -h, --help          显示本帮助

脚本会把当前检出拷进 <profile>/plugins/dsh-write-protect, 再用
`dsh plugin add` 注册; 装完重启 DSH 应用生效.
EOF
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE=${2:?--profile 需要一个 profile 名}; shift 2 ;;
    --dsh-home) DSH_HOME_DIR=${2:?--dsh-home 需要一个目录}; shift 2 ;;
    -h|--help) usage ;;
    -*) echo "install.sh: 未知参数 $1 (用 -h 看用法)" >&2; exit 2 ;;
    *) PROFILE=$1; shift ;;
  esac
done

command -v dsh >/dev/null 2>&1 || {
  echo "install.sh: 找不到 dsh — 先安装: npm install -g @deepseek-ai/dsh" >&2
  exit 1
}
command -v pnpm >/dev/null 2>&1 || {
  echo "install.sh: 找不到 pnpm — dsh plugin 会转发给它, 请先安装 pnpm" >&2
  exit 1
}
[ -f "$SRC/package.json" ] || { echo "install.sh: $SRC 不是包根目录" >&2; exit 1; }
[ -f "$SRC/lib/provider.mjs" ] || {
  echo "install.sh: 缺少构建产物 lib/ — 先在检出里跑: pnpm install && pnpm run build" >&2
  exit 1
}

PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"
DEST="$PROFILE_DIR/plugins/$PACKAGE"

# 拒绝从已安装的副本运行: 下面的复制会覆盖目标, 而目标正是脚本自身的来源.
PROFILE_DIR_REAL="$(cd "$PROFILE_DIR" 2>/dev/null && pwd -P || printf '%s' "$PROFILE_DIR")"
SRC_REAL="$(cd "$SRC" && pwd -P)"
case "$SRC_REAL" in
  "$PROFILE_DIR_REAL/plugins/$PACKAGE"|"$PROFILE_DIR_REAL/plugins/$PACKAGE"/*)
    echo "install.sh: 拒绝从已安装的副本 $SRC_REAL 安装; 请运行检出目录里自己的 install.sh" >&2
    exit 1
    ;;
esac

# 引擎版本线提醒 (只是提醒: 老引擎上插件会装不上或沙箱不可用).
DSH_VERSION="$(dsh --version 2>/dev/null | head -n 1 | sed 's/^v//' | awk '{print $1}')" || DSH_VERSION=""
case "$DSH_VERSION" in
  0.0.*|0.1.0*|0.1.1*|0.1.2*|0.1.3*|0.1.4*|0.1.5*)
    echo "install.sh: 警告: 当前 dsh $DSH_VERSION 早于 0.1.6-alpha.1, 本版插件需要 0.1.6 的异步 confine() 契约" >&2
    echo "install.sh:        老引擎请改用 v0.1.1: dsh plugin --profile $PROFILE add azazo1/dsh-write-protect#v0.1.1" >&2
    ;;
esac

# 源码比构建产物新时提醒: 复制的是 lib/, 不会顺手构建.
if [ -f "$SRC/src/provider.ts" ] && [ "$SRC/src/provider.ts" -nt "$SRC/lib/provider.mjs" ]; then
  echo "install.sh: 警告: src/ 比 lib/ 新, 装进去的是旧的构建产物; 先跑 pnpm run build" >&2
fi

# 首次使用时初始化 profile: --dump-config 会按内置模板建好 profile 但不启动应用.
if [ ! -f "$PROFILE_DIR/package.json" ]; then
  echo "install.sh: profile '$PROFILE' 不存在, 先初始化"
  if ! DSH_HOME="$DSH_HOME_DIR" dsh --profile "$PROFILE" --dump-config >/dev/null 2>&1; then
    echo "install.sh: '$PROFILE' 不是内置模板 (acp/web/headless/sdk/sdk-minimal), 按 web 模板初始化"
    DSH_HOME="$DSH_HOME_DIR" dsh --profile "$PROFILE" --from-default-profile web --dump-config >/dev/null
  fi
fi

# 复制检出到 profile 内: 排除版本库, 依赖 (宿主提供 peer, 带上会遮蔽宿主),
# 以及测试/打包留下的临时目录.
rm -rf "$DEST"
mkdir -p "$DEST"
tar -C "$SRC" \
  --exclude=./.git \
  --exclude=./node_modules \
  --exclude=./.tmp \
  --exclude=./dist \
  --exclude=./.agent \
  -cf - . | tar -C "$DEST" -xf -
echo "install.sh: 已复制到 $DEST"

# 在 profile 目录里注册, 让 pnpm 把依赖记成指向 profile 内副本的 link:
# (pnpm 落盘的是绝对路径, 所以 profile 目录本身不要整体搬走).
echo "install.sh: 注册到 profile '$PROFILE'"
(cd "$PROFILE_DIR" && DSH_HOME="$DSH_HOME_DIR" dsh plugin --profile "$PROFILE" add "./plugins/$PACKAGE")

BUNDLES="$(node -e "const p=require('$PROFILE_DIR/package.json');console.log((p.dsh?.profile?.bundles??[]).join(', '))" 2>/dev/null || true)"
echo "install.sh: profile bundles = ${BUNDLES:-<读取失败>}"
if ! node -e "const p=require('$PROFILE_DIR/package.json');process.exit((p.dsh?.profile?.bundles??[]).includes('$PACKAGE')?0:1)"; then
  echo "install.sh: 警告: bundles 里没有 $PACKAGE — bundle 层没登记上, 插件不会挂载" >&2
fi

cat <<EOF

install.sh: 完成.

下一步:
  1. 重启 DSH 应用让 bundle 层生效 (web 是 dsh web).
  2. 插件会接管官方的 sandbox-policy / fs-sandbox 与 Linux / macOS 上的 sandbox 行.
  3. 验证: 在受保护工作区跑任意命令应正常返回; 写 .git 内文件应得到 "Read-only file system".
  4. 保护路径与额外可写根在 Web Settings 的 "写入保护" 页调整, 改完即时生效.
EOF