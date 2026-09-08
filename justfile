# 列出可用的 recipe.
[private]
default:
    @just --list

# 安装项目依赖.
install:
    pnpm install

# 执行 TypeScript 类型检查, 不生成文件.
typecheck:
    pnpm exec tsc --noEmit

# 构建 Host ESM bundle 和 Client loader bundle (含类型声明).
build:
    pnpm exec tsdown --config tsdown.host.config.ts
    pnpm exec tsdown --config tsdown.client.config.ts

# 执行项目测试套件.
test:
    pnpm test

# 类型检查, 构建, 测试和打包预览一次完成.
verify:
    just typecheck
    just build
    just test
    pnpm pack --dry-run

# 删除 node_modules 和 .tmp .
clean:
    rm -rf .tmp/
    rm -rf node_modules/
