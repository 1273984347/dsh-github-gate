/**
 * Extract one file from an Electron .asar archive.
 *
 * Used to read files from the dsh installation that plain Node cannot open
 * directly — the YAML parser whose semantics the loader patch depends on, and
 * the runtime manifest whose version decides whether a peer range is admitted.
 *
 * asar layout: uint32(4) | uint32(headerSize) | uint32(jsonSize) | json header
 * | file payloads, where payload offsets are relative to 8 + headerSize.
 *
 * Usage: node tools/asar-extract.mjs <archive> <inner-path> <out-file>
 */

import { open, writeFile } from 'node:fs/promises'

const [archive, innerPath, outFile] = process.argv.slice(2)
if (archive === undefined || innerPath === undefined || outFile === undefined) {
  console.error('usage: node tools/asar-extract.mjs <archive> <inner-path> <out-file>')
  process.exit(2)
}

const handle = await open(archive, 'r')
try {
  const preamble = Buffer.alloc(16)
  await handle.read(preamble, 0, 16, 0)
  const headerSize = preamble.readUInt32LE(4)
  const jsonSize = preamble.readUInt32LE(12)

  const headerJson = Buffer.alloc(jsonSize)
  await handle.read(headerJson, 0, jsonSize, 16)
  const header = JSON.parse(headerJson.toString('utf8'))

  const payloadBase = 8 + headerSize
  const segments = innerPath.split('/').filter((part) => part !== '')

  /** @type {any} */
  let node = header
  for (const segment of segments) {
    const children = node.files
    if (children === undefined || children[segment] === undefined) {
      console.error(`not found in archive: ${innerPath} (missing "${segment}")`)
      process.exit(1)
    }
    node = children[segment]
  }
  if (node.files !== undefined) {
    console.error(`path is a directory, not a file: ${innerPath}`)
    process.exit(1)
  }

  const size = Number(node.size)
  const offset = payloadBase + Number(node.offset)
  const buffer = Buffer.alloc(size)
  await handle.read(buffer, 0, size, offset)
  await writeFile(outFile, buffer)
  console.log(`extracted ${size} bytes -> ${outFile}`)
} finally {
  await handle.close()
}
