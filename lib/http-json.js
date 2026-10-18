/**
 * The two HTTP helpers both route modules need.
 *
 * `sendJson` and `readJsonBody` were copied between the branch-pill routes and the
 * settings routes. Two copies of "write a JSON response" is two places to get the
 * content type, the `no-store` header, or the body cap wrong — and the cap is a
 * real control, not a formality: an unbounded read on a loopback route lets any
 * local process make the Host allocate whatever it sends.
 *
 * @module dsh-github-gate/http-json
 */

/**
 * Write a JSON response.
 *
 * `cache-control: no-store` is deliberate on every route: the branch pill reflects
 * a working tree that `git checkout` changes underneath it, and the settings
 * status reflects a credential that can be rotated at any moment. Neither may be
 * cached by anything between this Host and the page.
 *
 * @param {any} res the response
 * @param {number} status the HTTP status
 * @param {unknown} payload the JSON-serialisable body
 * @returns {void}
 */
export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

/**
 * Read and parse a JSON request body, with a byte cap.
 *
 * Returns `undefined` for anything unusable — empty, oversized, not JSON, or JSON
 * that is not an object — so the caller has one shape to check instead of four.
 *
 * @param {any} req the request
 * @param {number} [limit] the byte cap
 * @returns {Promise<Record<string, unknown> | undefined>} the parsed body, or undefined
 */
export async function readJsonBody(req, limit = 64 * 1024) {
  try {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > limit) return undefined
      chunks.push(chunk)
    }
    const text = Buffer.concat(chunks).toString('utf8')
    if (text.trim() === '') return undefined
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' && Array.isArray(parsed) === false ? parsed : undefined
  } catch {
    return undefined
  }
}
