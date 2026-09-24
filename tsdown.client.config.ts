import { defineConfig } from 'tsdown'

// Client 半区: loader 模块形态 — banner/footer 包裹为
// window.__ModuleLoader__.load({ id, factory: (require) => ... }), 平台模块表里的
// react, dsh-client-store 与 ui-primitives 经 factory 注入的 require 解析, 其余全部内联.
export default defineConfig({
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  banner: `window.__ModuleLoader__.load({ id: "dsh-write-protect", factory: (require) => { var module = { exports: {} }; var exports = module.exports;`,
  footer: 'return module.exports; } });',
  outputOptions: { entryFileNames: 'client.js' },
  deps: {
    neverBundle: (specifier: string) =>
      specifier === 'react'
      || specifier === 'react/jsx-runtime'
      || specifier === '@deepseek-ai/dsh-client-store'
      || specifier === '@deepseek-ai/dsh-client-ui-primitives',
  },
})
