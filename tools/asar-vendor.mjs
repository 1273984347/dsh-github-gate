/**
 * Extract a package CLOSURE from an Electron .asar into a node_modules layout
 * that plain Node can resolve.
 *
 * Why this exists: the plugin's Config schema imports
 * `@deepseek-ai/schemastery`, and its tool definitions import
 * `@deepseek-ai/dsh-tools`. Inside the Harness those bare names resolve through
 * the runtime resolution the launcher installs on Node's resolvers — an
 * in-process interception a standalone `node` run cannot see. Rather than let
 * the offline suite silently skip the real libraries (or, worse, stub them and
 * test the stub), this reconstructs the genuine packages so the tests exercise
 * the same code the Harness will.
 *
 * It walks `dependencies` AND `peerDependencies` transitively, because the
 * entry points import their peers statically.
 *
 * Usage: node tools/asar-vendor.mjs <archive> <out-dir> <pkg-root> [<pkg-root>...]
 */

import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { open } from 'node:fs/promises'

const [archive, outDir, ...roots] = process.argv.slice(2)
if (archive === undefined || outDir === undefined || roots.length === 0) {
  console.error('usage: node tools/asar-vendor.mjs <archive> <out-dir> <pkg-root> [<pkg-root>...]')
  process.exit(2)
}

const MODULES_SEGMENT = '/node_modules/'

const handle = await open(archive, 'r')
try {
  const preamble = Buffer.alloc(16)
  await handle.read(preamble, 0, 16, 0)
  const headerSize = preamble.readUInt32LE(4)
  const jsonSize = preamble.readUInt32LE(12)
  const payloadBase = 8 + headerSize

  const headerJson = Buffer.alloc(jsonSize)
  await handle.read(headerJson, 0, jsonSize, 16)
  const tree = JSON.parse(headerJson.toString('utf8'))

  /** @type {Map<string, any>} */
  const entries = new Map()
  /**
   * @param {any} node the current node
   * @param {string} path its archive path
   */
  const walk = (node, path) => {
    if (node.files !== undefined) {
      for (const [key, child] of Object.entries(node.files)) walk(child, `${path}/${key}`)
      return
    }
    entries.set(path, node)
  }
  walk(tree, '')

  /**
   * Read one file's bytes out of the archive.
   * @param {string} path the archive path
   * @returns {Promise<Buffer>} its content
   */
  const read = async (path) => {
    const node = entries.get(path)
    const size = Number(node.size)
    const buffer = Buffer.alloc(size)
    await handle.read(buffer, 0, size, payloadBase + Number(node.offset))
    return buffer
  }

  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })

  /** @type {Set<string>} */
  const done = new Set()
  /** @type {string[]} */
  const queue = [...roots]
  let fileCount = 0

  while (queue.length > 0) {
    const pkgRoot = queue.shift()
    if (done.has(pkgRoot)) continue
    done.add(pkgRoot)
    if (!entries.has(`${pkgRoot}/package.json`)) {
      console.log(`  skip (absent): ${pkgRoot}`)
      continue
    }

    // Write every file under this package, preserving the node_modules tail.
    // The FIRST `/node_modules/` is the anchor: a package with its own nested
    // node_modules must keep that nesting, or a nested dependency would be
    // written at the top level and shadow the real one. The marker's own
    // `node_modules/` segment is consumed, because outDir IS the node_modules
    // root being populated.
    for (const [path, node] of entries) {
      if (!path.startsWith(`${pkgRoot}/`)) continue
      const marker = path.indexOf(MODULES_SEGMENT)
      const relative = marker === -1 ? path.slice(pkgRoot.length + 1) : path.slice(marker + MODULES_SEGMENT.length)
      const target = join(outDir, relative.replaceAll('/', '\\'))
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, await read(path))
      fileCount += 1
    }

    const manifest = JSON.parse((await read(`${pkgRoot}/package.json`)).toString('utf8'))
    const modulesPrefix = pkgRoot.slice(0, pkgRoot.lastIndexOf(MODULES_SEGMENT) + MODULES_SEGMENT.length)
    for (const name of [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]) {
      const depRoot = `${modulesPrefix}${name}`
      if (!done.has(depRoot) && entries.has(`${depRoot}/package.json`)) queue.push(depRoot)
    }
  }

  console.log(`vendored ${done.size} package(s), ${fileCount} file(s) into ${outDir}`)
} finally {
  await handle.close()
}
