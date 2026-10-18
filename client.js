/**
 * Browser half of dsh-github-toolkit — the session-header branch pill.
 *
 * ## Why this file looks the way it does
 *
 * A bundle's Client half is NOT an ES module and is NOT evaluated with injected
 * symbols. The Web shell enqueues it as a plain script that must register a lazy
 * factory with `window.__ModuleLoader__`, and that queue is drained later by the
 * module-system boot:
 *
 *     window.__ModuleLoader__ = { mode: 'queue', pendingQueue, load(r){...}, create(...){...} }
 *
 * The `id` MUST equal the package name; the loader keys the module by it.
 *
 * Two consequences worth stating, because getting either wrong is silent:
 *
 * 1. **No JSX, no TypeScript** — the browser parses this file as written. Build
 *    elements with `React.createElement`.
 * 2. **`styles`, `host` and the tagged `console` are NOT available here.** Those
 *    are parameters of the *evaluated* path (`evaluateClientHalf`), which the
 *    dynamic-cordis runtime uses for plugins defined at run time. An installed
 *    bundle takes the script path and gets only `require`. So there is no
 *    `styles.insert(css)` and no `host.call` — styles are rendered as a React
 *    element (the ui-plugin reference's own suggestion: "Component-local styles
 *    can render as React elements so unmounting removes them"), and host data
 *    will come from the Host half's own route.
 *
 * Styling uses ONLY `--dsw-alias-*` theme tokens, which the Theme provider lists
 * and which every one of them requires in both light and dark. Literal colors are
 * for artwork only. The reference also forbids requiring a Harness Client package
 * such as `dsh-client-ui-primitives`: they change without notice, this file has no
 * type check, and a throwing component blanks the whole slot entry.
 *
 * ## The slot
 *
 * `conversation.session.header.utilities` — "Right-aligned Session utilities in
 * ascending order", a `list` slot in session scope with `replaceRisk: none`. Its
 * catalog warns that reusing a shipped `id` REPLACES that occupant, so this uses
 * an id of its own and sits beside `open-in-app` and `session-log-download`.
 */

window.__ModuleLoader__.load({
  id: 'dsh-github-toolkit',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const SLOT = 'conversation.session.header.utilities'
    const CELL_ID = 'dsh-github-toolkit-branch'
    const ROUTE = '/dsh-github-toolkit/branch'
    const BRANCHES_ROUTE = '/dsh-github-toolkit/branches'
    const SWITCH_ROUTE = '/dsh-github-toolkit/switch'

    /**
     * Component-local stylesheet.
     *
     * Rendered as an element instead of inserted globally, so unmounting the pill
     * removes the rules with it and nothing leaks if the slot collapses.
     */
    const CSS = `
.ghk-pill{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 6px;
  border:1px solid var(--dsw-alias-border-l1);border-radius:6px;
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);
  font-size:12px;line-height:1;font-family:inherit;white-space:nowrap;
  max-width:220px;overflow:hidden;text-overflow:ellipsis;user-select:none}
.ghk-pill-glyph{flex:none;opacity:.75}
.ghk-pill-label{overflow:hidden;text-overflow:ellipsis}
.ghk-pill-idle{color:var(--dsw-alias-state-idle-primary)}
.ghk-pill-detached{color:var(--dsw-alias-state-warn-primary)}
.ghk-pill-broken{color:var(--dsw-alias-state-error-primary);font-weight:600}
.ghk-pr{display:inline-flex;align-items:center;gap:3px;padding-left:5px;margin-left:1px;
  border-left:1px solid var(--dsw-alias-border-l1);font-variant-numeric:tabular-nums}
.ghk-pr-open{color:var(--dsw-alias-state-success-primary)}
.ghk-pr-draft,.ghk-pr-merged,.ghk-pr-closed,.ghk-pr-unknown{color:var(--dsw-alias-state-idle-primary)}
.ghk-pr-changes{color:var(--dsw-alias-state-warn-primary)}
.ghk-pr-dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
/* The trigger. A button only when there is a list to offer, so it gets its own
   interactive states rather than looking clickable when it is not. */
.ghk-pill-button{cursor:pointer;font:inherit}
.ghk-pill-button:hover{background:var(--dsw-alias-bg-layer-2)}
.ghk-pill-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.ghk-pill-open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
/* Fixed, not absolute: the header row's ancestors may clip overflow, and a menu that
   opens into a clipped box is invisible for a reason this code cannot observe.
   Positioned from the trigger's rect on open, on scroll and on resize. */
.ghk-menu{position:fixed;z-index:2147483000;min-width:220px;max-width:340px;
  max-height:60vh;overflow:auto;padding:4px;
  border:1px solid var(--dsw-alias-border-l2);border-radius:8px;
  background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);
  box-shadow:0 8px 24px rgb(0 0 0 / 18%);font-size:12px;line-height:1.5}
.ghk-menu-head{padding:4px 8px 6px;color:var(--dsw-alias-label-secondary);
  border-bottom:1px solid var(--dsw-alias-border-l1);margin-bottom:4px}
.ghk-menu-warn,.ghk-menu-error{padding:5px 8px;margin:2px 0;border-radius:5px;
  color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-bg-layer-2)}
.ghk-menu-error{color:var(--dsw-alias-state-error-primary)}
.ghk-menu-note{padding:6px 8px;color:var(--dsw-alias-label-secondary)}
.ghk-menu-list{display:flex;flex-direction:column}
.ghk-menu-item{display:flex;align-items:center;gap:6px;width:100%;padding:5px 8px;
  border:0;border-radius:5px;background:transparent;color:inherit;
  font:inherit;text-align:left;cursor:pointer}
.ghk-menu-item:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.ghk-menu-item:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.ghk-menu-item:disabled{cursor:default;opacity:.65}
.ghk-menu-current{color:var(--dsw-alias-brand-primary);opacity:1}
.ghk-menu-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-family:var(--ds-font-family-code,ui-monospace,monospace)}
.ghk-menu-tag{flex:none;color:var(--dsw-alias-label-secondary);
  font-variant-numeric:tabular-nums}
.ghk-menu-ahead{color:var(--dsw-alias-state-success-primary)}
.ghk-menu-behind{color:var(--dsw-alias-state-warn-primary)}
`

    /** The branch glyph, in the current text color. */
    function glyph() {
      return h('svg', {
        className: 'ghk-pill-glyph',
        width: 12,
        height: 12,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('circle', { cx: 4.5, cy: 3.5, r: 1.8 }),
        h('circle', { cx: 4.5, cy: 12.5, r: 1.8 }),
        h('circle', { cx: 11.5, cy: 6, r: 1.8 }),
        h('path', { d: 'M4.5 5.3v5.4' }),
        h('path', { d: 'M9.7 6.9c-.7 1.6-2.2 2.6-3.9 2.6' }),
      )
    }

    /**
     * The session-header pill.
     *
     * The branch comes from the Host half's route, keyed by the SESSION id the
     * slot props carry — never by a path, so this component cannot point the Host
     * at a directory of its own choosing. Only `sessionId` is read from props: the
     * same props also expose session snapshots, and subscribing to fewer slices
     * keeps this cell out of unrelated re-renders.
     *
     * @param {{ sessionId?: string }} props the slot props
     * @returns {import('react').ReactElement} the pill
     */
    function BranchPill(props) {
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : ''
      const [state, setState] = React.useState({ phase: 'idle', branch: '', detail: 'loading' })

      React.useEffect(() => {
        if (sessionId === '') {
          setState({ phase: 'idle', branch: '', detail: 'this session has no id yet' })
          return undefined
        }

        let live = true
        /** The in-flight request, aborted before a newer one replaces it. */
        let inFlight

        /**
         * Fetch the branch state once.
         *
         * Called on mount and again whenever the window regains attention. It is
         * deliberately NOT a fixed interval: a branch changes when a person runs
         * `git checkout`, which is rare, while each call costs a `git rev-parse` plus
         * a `gh pr list` round trip. Polling every few seconds would spend that on
         * every open session to observe something that almost never moves — the
         * neighbouring Source Control panel polls because it also has to track
         * working-tree changes, which do move.
         *
         * Focus and visibility are the moments that matter: the user looked away,
         * something changed out there, the user looked back.
         */
        const load = () => {
          if (!live) return
          if (inFlight !== undefined) inFlight.abort()
          const controller = new AbortController()
          inFlight = controller
          fetch(ROUTE + '?sessionId=' + encodeURIComponent(sessionId), {
            signal: controller.signal,
            headers: { accept: 'application/json' },
          })
            .then((response) => {
              if (!response.ok) {
                // A 404 here means the Host row registered no route — the routing
                // layer answered, not us. That is a real breakage and is reported as
                // one instead of looking like an empty branch.
                throw new Error('route ' + response.status)
              }
              return response.json()
            })
            .then((body) => {
              if (!live) return
              if (body && body.ok === true && typeof body.branch === 'string' && body.branch !== '') {
                setState({ phase: 'branch', branch: body.branch, detail: body.branch, pr: body.pr ?? null })
              } else if (body && body.ok === true && body.detached === true) {
                // Detached HEAD is a state, not a branch name: `git rev-parse
                // --abbrev-ref HEAD` prints the literal "HEAD" there, and rendering
                // that as if it were a branch would be a lie.
                setState({ phase: 'detached', branch: '', detail: 'detached HEAD' })
              } else {
                // A well-formed refusal (no workspace, no branch) is a STATE, not a
                // breakage: it stays on the quiet dash.
                setState({ phase: 'idle', branch: '', detail: (body && body.detail) || 'no branch reported' })
              }
            })
            .catch((error) => {
              // An aborted fetch is a newer request replacing this one, or this
              // effect cleaning up. Neither is a failure, and neither may overwrite
              // the state a newer request is about to set.
              if (!live || controller.signal.aborted) return
              if (error && error.name === 'AbortError') return
              // Broken is shown as broken. The first version of this pill rendered a
              // failed bridge exactly like a session with no workspace — a quiet dash
              // — and that is why an unregistered route went unnoticed until it was
              // probed over HTTP by hand.
              setState({ phase: 'broken', branch: '', detail: String((error && error.message) || 'the Host half did not answer') })
            })
        }

        /**
         * Reload when the window regains attention, and only then.
         *
         * `visibilitychange` covers a hidden tab or a minimised window; `focus`
         * covers switching back from another application, which does not always fire
         * the visibility event. Registering both is what makes "come back and it is
         * current" true in practice rather than in theory.
         */
        const onAttention = () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          load()
        }

        load()
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onAttention)
        if (typeof window !== 'undefined') window.addEventListener('focus', onAttention)

        return () => {
          live = false
          if (inFlight !== undefined) inFlight.abort()
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onAttention)
          if (typeof window !== 'undefined') window.removeEventListener('focus', onAttention)
        }
      }, [sessionId])

      // ---------------------------------------------------------------------------
      // Switching, added after the pill shipped as a read-only indicator.
      //
      // The popover is `position: fixed` and placed from the trigger's own rectangle
      // rather than absolutely-positioned inside it. The pill lives in a header row whose
      // ancestors may clip overflow, and a popover that opens into a clipped box is
      // invisible for a reason the code cannot see. `fixed` escapes that. The trade is
      // that it must be repositioned on scroll and resize, which is what the effect below
      // is for.
      // ---------------------------------------------------------------------------
      const [open, setOpen] = React.useState(false)
      /** The branch list, or a refusal. null while loading. */
      const [listing, setListing] = React.useState(null)
      /** The branch currently being switched to, so its row can show that it is busy. */
      const [pending, setPending] = React.useState('')
      /** A refusal from the switch route, shown in the popover rather than swallowed. */
      const [notice, setNotice] = React.useState('')
      const [anchor, setAnchor] = React.useState(null)
      const triggerRef = React.useRef(null)

      const place = React.useCallback(() => {
        const node = triggerRef.current
        if (node === null || typeof node.getBoundingClientRect !== 'function') return
        const rect = node.getBoundingClientRect()
        setAnchor({ top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right) })
      }, [])

      React.useEffect(() => {
        if (!open) return undefined
        place()
        // Reposition rather than close: the trigger keeps its identity while the user
        // scrolls, and closing on scroll would make the list unusable in a long header.
        window.addEventListener('scroll', place, true)
        window.addEventListener('resize', place)
        const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
        document.addEventListener('keydown', onKey)
        return () => {
          window.removeEventListener('scroll', place, true)
          window.removeEventListener('resize', place)
          document.removeEventListener('keydown', onKey)
        }
      }, [open, place])

      React.useEffect(() => {
        if (!open || sessionId === '') return undefined
        let live = true
        setListing(null)
        setNotice('')
        fetch(BRANCHES_ROUTE + '?sessionId=' + encodeURIComponent(sessionId), {
          headers: { accept: 'application/json' },
        })
          .then((response) => response.json())
          .then((body) => { if (live) setListing(body) })
          .catch((error) => {
            if (live) setListing({ ok: false, error: 'bridge-error', detail: String((error && error.message) || error) })
          })
        return () => { live = false }
      }, [open, sessionId])

      /**
       * Ask the Host to switch, then re-read.
       *
       * The branch name is sent as-is; the Host decides whether it is a real ref. No
       * validation happens here on purpose — a client-side check would be a second, weaker
       * copy of the check that matters, and the two could disagree.
       */
      const switchTo = (branch) => {
        if (pending !== '') return
        setPending(branch)
        setNotice('')
        fetch(SWITCH_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ sessionId, branch }),
        })
          .then((response) => response.json())
          .then((body) => {
            if (body && body.ok === true) {
              setOpen(false)
              setState({ phase: 'branch', branch: body.branch, detail: body.branch, pr: null })
              // A full reload, because the PR half of the pill belongs to the OLD branch
              // and reusing it would label the new branch with the previous pull request.
              load()
            } else {
              setNotice((body && body.detail) || (body && body.error) || 'the switch was refused')
            }
          })
          .catch((error) => setNotice(String((error && error.message) || error)))
          .then(() => setPending(''))
      }

      const label = state.phase === 'branch' ? state.branch : state.phase === 'broken' ? '!' : '\u2014'
      const labelClass = state.phase === 'branch'
        ? 'ghk-pill-label'
        : state.phase === 'detached'
          ? 'ghk-pill-label ghk-pill-detached'
          : state.phase === 'broken'
            ? 'ghk-pill-label ghk-pill-broken'
            : 'ghk-pill-label ghk-pill-idle'

      // The PR half of the pill. Absent whenever there is no branch, no pull
      // request for it, or neither route could answer — the branch stays readable in
      // every one of those cases, which is why the Host reports a missing PR as
      // `pr: null` rather than as a failure.
      const pr = state.pr
      // `pr.state === ''` means the git-protocol fallback found the number but knows
      // nothing else — that route reads refs, not the API. Colouring it as an open
      // pull request would state something nobody checked, so an unknown state gets
      // the neutral colour. A state the pill does not know is not a state.
      const known = pr !== undefined && pr !== null && typeof pr.state === 'string' && pr.state !== ''
      const prClass = pr === undefined || pr === null
        ? ''
        : !known
          ? 'ghk-pr ghk-pr-unknown'
          : pr.isDraft
            ? 'ghk-pr ghk-pr-draft'
            : pr.state === 'MERGED'
              ? 'ghk-pr ghk-pr-merged'
              : pr.state === 'CLOSED'
                ? 'ghk-pr ghk-pr-closed'
                : pr.reviewDecision === 'CHANGES_REQUESTED'
                  ? 'ghk-pr ghk-pr-changes'
                  : 'ghk-pr ghk-pr-open'

      /** One line describing the pull request, honest about what is unknown. */
      const prLine = pr === undefined || pr === null
        ? '\nNo pull request for this branch'
        : known
          ? '\nPR #' + pr.number + ' · ' + (pr.isDraft ? 'draft' : pr.state.toLowerCase())
            + (pr.reviewDecision ? ' · ' + pr.reviewDecision.replace(/_/g, ' ').toLowerCase() : '')
            + (pr.title ? '\n' + pr.title : '')
          : '\nPR #' + pr.number + ' (found through git; title and state need gh)'

      const title = state.phase === 'branch'
        ? 'GitHub branch: ' + state.branch + prLine
        : state.phase === 'broken'
          ? 'GitHub branch unavailable — ' + state.detail + ' (the Host route did not answer)'
          : 'GitHub branch: ' + (state.detail || 'not available')

      // The pill is a BUTTON only when there is something to switch: a session with no
      // workspace, or a broken bridge, has no branch list to offer, and making those
      // clickable would promise a menu that can only be empty.
      // Only offer the menu when there is something to put in it.
      //
      // The first version was `sessionId !== '' && state.phase !== 'broken'`, which made the
      // pill a button even when the phase was `idle` — no workspace attached — so the title
      // promised "Click to switch branch" and the click opened an empty menu. A CDP probe
      // against the running app measured exactly that: `title` said "Click to switch branch"
      // while `labelClass` was `ghk-pill-idle` and the popover's rows array was empty.
      //
      // `detached` IS offered: the workspace is there, only HEAD is not on a branch, and a
      // list of local branches is exactly what someone in that state wants.
      const canSwitch = sessionId !== ''
        && (state.phase === 'branch' || state.phase === 'detached')

      const trigger = h(canSwitch ? 'button' : 'span', {
        className: 'ghk-pill' + (canSwitch ? ' ghk-pill-button' : '') + (open ? ' ghk-pill-open' : ''),
        title: canSwitch ? title + '\n\nClick to switch branch' : title,
        type: canSwitch ? 'button' : undefined,
        ref: triggerRef,
        onClick: canSwitch
          ? () => { setOpen((was) => !was) }
          : undefined,
      },
        // NOT the style element. It used to be here, as the pill's first child, which made
        // `el.textContent` return the entire stylesheet instead of the branch name — a CDP
        // probe asking for the label got 2.5 KB of CSS. It is a sibling of the trigger now,
        // so the pill contains only the pill.
        glyph(),
        h('span', { className: labelClass }, label),
        pr ? h('span', { className: prClass },
          h('span', { className: 'ghk-pr-dot' }),
          '#' + pr.number,
        ) : null,
      )

      if (!open || anchor === null) {
        // The stylesheet still has to reach the document, so the trigger is wrapped even
        // with the menu closed.
        return h('span', { className: 'ghk-root' },
          h('style', null, CSS),
          trigger,
        )
      }

      const list = listing
      const rows = list !== null && list.ok === true && Array.isArray(list.branches) ? list.branches : []
      const dirty = list !== null && list.clean === false

      return h('span', { className: 'ghk-root' },
        // The stylesheet has to be in BOTH paths. Adding it only to the closed branch made
        // the menu lose every rule the moment it opened — caught by looking at the two
        // returns side by side, which is the check this comment would otherwise have to be.
        h('style', null, CSS),
        trigger,
        h('div', {
          className: 'ghk-menu',
          style: { top: anchor.top + 'px', right: anchor.right + 'px' },
          role: 'dialog',
          'aria-label': 'Switch branch',
        },
          h('div', { className: 'ghk-menu-head' }, 'Switch branch'),

          // The working-tree warning sits ABOVE the list, because it is the reason a
          // choice below may be refused and a reader should know that before clicking.
          dirty
            ? h('div', { className: 'ghk-menu-warn' },
                (typeof list.modified === 'number' ? list.modified : 'some')
                + ' modified path(s) — a switch may be refused until they are committed or stashed')
            : null,

          notice !== ''
            ? h('div', { className: 'ghk-menu-error' }, notice)
            : null,

          list === null
            ? h('div', { className: 'ghk-menu-note' }, 'loading…')
            : list.ok !== true
              ? h('div', { className: 'ghk-menu-error' },
                  'Could not read the branch list', list.detail ? ' — ' + list.detail : '')
              : rows.length === 0
                ? h('div', { className: 'ghk-menu-note' }, 'this repository has no local branches')
                : h('div', { className: 'ghk-menu-list' },
                    rows.map((entry) => {
                      const isCurrent = entry.name === state.branch
                      // What a screen reader will say, instead of the concatenation of
                      // every child span.
                      //
                      // `textContent` of this row is "devcurrent" — the branch name and the
                      // tag run together with nothing between them. Visually the flex `gap`
                      // separates them and it reads fine; spoken, it is one nonsense word.
                      // Measured, not guessed: a CDP probe reading the open menu returned
                      // exactly `"text":"devcurrent"`.
                      const spoken = (isCurrent ? `${entry.name}, current branch` : `Switch to ${entry.name}`)
                        + (entry.ahead > 0 ? `, ${entry.ahead} ahead` : '')
                        + (entry.behind > 0 ? `, ${entry.behind} behind` : '')
                      return h('button', {
                        key: entry.name,
                        type: 'button',
                        className: 'ghk-menu-item'
                          + (isCurrent ? ' ghk-menu-current' : '')
                          + (pending === entry.name ? ' ghk-menu-pending' : ''),
                        // The current branch is shown but not clickable: switching to the
                        // branch you are on is a no-op that reads as a broken button.
                        disabled: isCurrent || pending !== '',
                        'aria-label': spoken,
                        // The visible label replaces the concatenation above, so the
                        // decorative spans must not be read a second time.
                        'aria-current': isCurrent ? 'true' : undefined,
                        onClick: () => switchTo(entry.name),
                      },
                        h('span', { className: 'ghk-menu-name', 'aria-hidden': 'true' }, entry.name),
                        isCurrent ? h('span', { className: 'ghk-menu-tag', 'aria-hidden': 'true' }, 'current') : null,
                        // Ahead/behind is the second thing a person checks before
                        // switching, and it is already in the data.
                        entry.ahead > 0 ? h('span', { className: 'ghk-menu-tag ghk-menu-ahead', 'aria-hidden': 'true' }, '↑' + entry.ahead) : null,
                        entry.behind > 0 ? h('span', { className: 'ghk-menu-tag ghk-menu-behind', 'aria-hidden': 'true' }, '↓' + entry.behind) : null,
                        pending === entry.name ? h('span', { className: 'ghk-menu-tag' }, 'switching…') : null,
                      )
                    }),
                  ),
        ),
      )
    }
    return {
      inject: ['slots'],
      apply(ctx) {
        // Contribute through the slot, with the registration owned by this
        // effect so unloading the plugin removes the cell again.
        ctx.effect(() => ctx.slots.inject(SLOT, () => ctx.slots.register({
          name: SLOT,
          id: CELL_ID,
          order: 10,
        }, BranchPill)))
      },
    }
  },
})
