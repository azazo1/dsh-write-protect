import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/policy.ts', 'src/fs.ts', 'src/provider.ts'],
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  dts: true,
  sourcemap: true,
})
