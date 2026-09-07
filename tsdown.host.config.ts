import { defineConfig } from 'tsdown'

// Host 半区: ESM + 类型声明, cordis loader 直接 import.
export default defineConfig({
  entry: ['src/policy.ts', 'src/fs.ts', 'src/provider.ts'],
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  dts: true,
  sourcemap: true,
  clean: true,
})
