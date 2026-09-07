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

# 构建 Host ESM bundle 和类型声明.
build:
    pnpm exec tsdown

# 执行项目测试套件.
test:
    pnpm test

# 类型检查, 构建, 测试和打包预览一次完成.
verify:
    just typecheck
    just build
    just test
    pnpm pack --dry-run

# 删除生成的构建产物.
clean:
    rm -rf lib
