/**
 * Read the branch pill out of the RUNNING app, over CDP.
 *
 * ## What this finally is
 *
 * Every round of this project ended with the same sentence: the client half is unverified
 * because there is no DOM access. The pill was reported working only because a person
 * looked at it.
 *
 * Getting here took a wrong turn worth recording. The GUI answers on 127.0.0.1:19387, so the
 * assumption was "browser, therefore cookie". It is not a browser — it is
 * `DeepSeek Harness.exe`, an Electron app that mints its own session internally. There is no
 * cookie, in any browser, because no browser is involved. Time went into trying to copy one
 * out of Chrome before anyone asked *which program the user is actually looking at*.
 *
 * The app does not strip Chromium switches (checked: no `appendSwitch` / `removeSwitch` in
 * the shipped archive), so `--remote-debugging-port` reaches it and the renderer is
 * reachable.
 *
 * ## This never closes anything
 *
 * It attaches to a live application. Closing the "browser" would close the user's app, so
 * the connection is dropped, not the process.
 *
 * Usage:
 *   node tools/probe-ui.mjs --cdp http://127.0.0.1:9222
 */

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'

const PLAYWRIGHT_CANDIDATES = [
  process.env.DSH_PLAYWRIGHT,
  'D:/xiyouji/scripts/node_modules/playwright-core',
  'D:/xiyouji/scripts/node_modules/playwright',
].filter((value) => typeof value === 'string' && value !== '')

const require = createRequire(import.meta.url)
let playwright
for (const candidate of PLAYWRIGHT_CANDIDATES) {
  if (!existsSync(candidate)) continue
  try {
    playwright = require(candidate)
    break
  } catch {
    // try the next candidate
  }
}
if (playwright === undefined) {
  console.error('no Playwright found; set DSH_PLAYWRIGHT to a playwright-core directory')
  process.exitCode = 1
  process.exit(1)
}

const cdpIndex = process.argv.indexOf('--cdp')
const CDP = cdpIndex !== -1 ? process.argv[cdpIndex + 1] : 'http://127.0.0.1:9222'

/**
 * One JSON line per step, so a caller reads structure rather than prose.
 *
 * @param {string} event the event name
 * @param {Record<string, unknown>} [data] the payload
 */
function emit(event, data = {}) {
  console.log(JSON.stringify({ event, ...data }))
}

const browser = await playwright.chromium.connectOverCDP(CDP)
emit('connected', { cdp: CDP, contexts: browser.contexts().length })

// Find the app window. `dsh-app://app/` is the Electron renderer; there may be several, so
// the one carrying the pill is the one to measure.
//
// `--new-window` opens a SECOND renderer instead of reading the one on screen. Reloading a
// page the user is looking at is disruptive and was done once without asking, which earned a
// fair "what is going on?". A fresh page leaves the visible one untouched; it falls back to
// the existing page if the app does not allow another.
const wantNewWindow = process.argv.includes('--new-window')
let page
if (wantNewWindow) {
  for (const context of browser.contexts()) {
    try {
      page = await context.newPage()
      await page.goto('dsh-app://app/', { waitUntil: 'domcontentloaded', timeout: 30_000 })
      emit('new-window', { url: page.url() })
      break
    } catch (error) {
      emit('new-window-failed', { message: String(error?.message ?? error).slice(0, 160) })
      page = undefined
    }
  }
}
if (page === undefined) {
  for (const context of browser.contexts()) {
    for (const candidate of context.pages()) {
      if (candidate.url().startsWith('dsh-app://')) {
        page = candidate
        break
      }
    }
    if (page !== undefined) break
  }
}
if (page === undefined) {
  emit('no-app-page', { pages: browser.contexts().flatMap((c) => c.pages()).map((p) => p.url()) })
  await browser.close()
  process.exitCode = 1
  process.exit(1)
}
emit('page', { url: page.url(), title: await page.title() })

/** Everything worth knowing about the pill, as numbers rather than as a picture. */
const pill = await page.evaluate(async () => {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline && document.querySelector('.ghk-pill') === null) {
    await new Promise((resolve) => { setTimeout(resolve, 200) })
  }
  const el = document.querySelector('.ghk-pill')
  if (el === null) {
    // Say what IS there, so an absent pill is diagnosable rather than a bare null.
    return {
      present: false,
      bodyLength: document.body === null ? 0 : document.body.innerText.length,
      headerLike: document.querySelectorAll('[class*="header" i]').length,
    }
  }
  const rect = el.getBoundingClientRect()
  const style = getComputedStyle(el)
  const label = el.querySelector('.ghk-pill-label')
  const pr = el.querySelector('.ghk-pr')
  return {
    present: true,
    tagName: el.tagName,
    // The distinction the user reported: a span SHOWS the branch, a button CHANGES it.
    interactive: el.tagName === 'BUTTON' && el.disabled !== true,
    text: el.textContent,
    labelText: label === null ? null : label.textContent,
    labelClass: label === null ? null : label.className,
    prText: pr === null ? null : pr.textContent,
    prClass: pr === null ? null : pr.className,
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
    inViewport: rect.top >= 0 && rect.left >= 0
      && rect.bottom <= innerHeight && rect.right <= innerWidth,
    display: style.display,
    visibility: style.visibility,
    cursor: style.cursor,
    title: el.getAttribute('title'),
    overflow: { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth },
  }
})
emit('pill', pill)

if (pill.present === true && pill.interactive === true) {
  // Element-centre, per the UI-debug notes: bare coordinates get swallowed by an overlay.
  await page.mouse.click(pill.rect.x + Math.round(pill.rect.w / 2), pill.rect.y + Math.round(pill.rect.h / 2))
  await page.waitForTimeout(1200)

  const menu = await page.evaluate(() => {
    const el = document.querySelector('.ghk-menu')
    if (el === null) return { open: false }
    const rect = el.getBoundingClientRect()
    return {
      open: true,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      // The design risk: the menu is `position: fixed` and placed from the trigger's rect,
      // so "does it fit on screen" is the property worth asserting.
      fullyInViewport: rect.top >= 0 && rect.left >= 0
        && rect.bottom <= innerHeight && rect.right <= innerWidth,
      position: getComputedStyle(el).position,
      rows: [...el.querySelectorAll('.ghk-menu-item')].map((row) => ({
        // BOTH, because they are different facts and the difference is the point:
        // `text` is what the DOM concatenates ("devcurrent"), `spoken` is what a screen
        // reader is told ("dev, current branch"). Reading only the first is what made the
        // concatenation invisible until a probe printed it.
        text: row.textContent,
        spoken: row.getAttribute('aria-label'),
        disabled: row.disabled === true,
        current: row.className.includes('ghk-menu-current'),
      })),
    }
  })
  emit('popover', menu)

  // Leave the app as it was found.
  if (menu.open === true) {
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    emit('closed-again', { closed: await page.evaluate(() => document.querySelector('.ghk-menu') === null) })
  }
}

emit('result', {
  pillPresent: pill.present === true,
  interactive: pill.interactive === true,
  conclusion: pill.present !== true
    ? 'no pill in this window — no open session has a registered git workspace'
    : pill.interactive === true
      ? 'the pill renders AND is a button: switching is reachable from it'
      : 'the pill renders but is NOT interactive: it shows the branch and cannot change it',
})

// Disconnect, never close: this is the user's running application.
await browser.close()
