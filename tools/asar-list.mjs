/**
 * List files inside an Electron .asar archive by path substring.
 *
 * Used to inspect how shipped packages are structured, so a comparison against
 * this plugin is made from the real installation rather than from memory.
 *
 * Usage: node tools/asar-list.mjs <archive> <substring> [max]
 */

import { open } from 'node:fs/promises'

const [archive, needle, maxArg] = process.argv.slice(2)
if (archive === undefined || needle === undefined) {
  console.error('usage: node tools/asar-list.mjs <archive> <substring> [max]')
  process.exit(2)
}
const max = maxArg === undefined ? 40 : Number(maxArg)

const handle = await open(archive, 'r')
try {
  const preamble = Buffer.alloc(16)
  await handle.read(preamble, 0, 16, 0)
  const jsonSize = preamble.readUInt32LE(12)
  const headerJson = Buffer.alloc(jsonSize)
  await handle.read(headerJson, 0, jsonSize, 16)
  const root = JSON.parse(headerJson.toString('utf8'))

  /** @type {string[]} */
  const hits = []
  /**
   * @param {any} node the current node
   * @param {string} path its path
   */
  const walk = (node, path) => {
    if (node.files !== undefined) {
      for (const [key, child] of Object.entries(node.files)) walk(child, `${path}/${key}`)
      return
    }
    if (path.includes(needle)) hits.push(`${String(node.size).padStart(8)}  ${path}`)
  }
  walk(root, '')

  console.log(`matches for "${needle}": ${hits.length} (showing ${Math.min(max, hits.length)})`)
  for (const line of hits.slice(0, max)) console.log(line)
} finally {
  await handle.close()
}
