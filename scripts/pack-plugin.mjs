#!/usr/bin/env node
/**
 * 打包 npm tarball 到 dist/, 复制一份不带版本号的稳定文件名,
 * 并校验市场安装所需的入口文件. GitHub Release 的 latest/download
 * 只按文件名取值, 稳定名避免下一次发版后 404.
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const distDir = join(root, 'dist')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const versionedName = `${pkg.name}-${pkg.version}.tgz`
const stableName = `${pkg.name}.tgz`

const requiredFiles = [
  'package/package.json',
  'package/cordis.patch.yml',
  'package/lib/policy.mjs',
  'package/lib/fs.mjs',
  'package/lib/provider.mjs',
  'package/lib/client.js',
  'package/lib/policy.d.mts',
  'package/lib/fs.d.mts',
  'package/lib/provider.d.mts',
  'package/README.md',
  'package/LICENSE',
]

function run(command, args) {
  return execFileSync(command, args, { cwd: root, encoding: 'utf8' })
}

mkdirSync(distDir, { recursive: true })
for (const name of readdirSync(distDir)) {
  if (name.endsWith('.tgz') || name === 'SHA256SUMS') {
    rmSync(join(distDir, name))
  }
}

console.log(`packing ${pkg.name}@${pkg.version}`)
run('pnpm', ['pack', '--pack-destination', distDir])

const versionedPath = join(distDir, versionedName)
const listing = run('tar', ['-tzf', versionedPath]).split('\n').filter((line) => line.length > 0)
const listingSet = new Set(listing)

const missing = requiredFiles.filter((file) => !listingSet.has(file))
if (missing.length > 0) {
  throw new Error(`pack 缺少入口文件:\n${missing.map((file) => `  ${file}`).join('\n')}`)
}

const leaked = listing.filter((file) => (
  file.startsWith('package/src/')
  || file.startsWith('package/test/')
  || file.startsWith('package/scripts/')
))
if (leaked.length > 0) {
  throw new Error(`pack 混入了不应发布的路径:\n${leaked.map((file) => `  ${file}`).join('\n')}`)
}

const packedPkg = JSON.parse(run('tar', ['-xOf', versionedPath, 'package/package.json']))
if (packedPkg.dsh?.bundle?.patch !== './cordis.patch.yml') {
  throw new Error('pack 内 package.json 缺少 dsh.bundle.patch')
}
if (packedPkg.dsh?.client?.platform !== 'web') {
  throw new Error('pack 内 package.json 缺少 dsh.client.platform=web')
}
if (typeof packedPkg.repository?.url !== 'string' || packedPkg.repository.url.length === 0) {
  throw new Error('pack 内 package.json 缺少 repository.url, 市场无法把 npm 包和仓库关联')
}

copyFileSync(versionedPath, join(distDir, stableName))
console.log(`packed ${versionedName} and ${stableName} (${String(listing.length)} files)`)
