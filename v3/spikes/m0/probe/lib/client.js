// M0 spike, client half. Mounts into each candidate slot and records the props it receives
// on window.__vgProbe, so they can be read from the browser. Never submits or prompts.
window.__ModuleLoader__.load({
  id: 'vg-probe',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const probe = window.__vgProbe = window.__vgProbe || { slots: {}, errors: [], services: {}, inputs: {}, renders: {} }

    function keysOf(obj) {
      if (!obj || typeof obj !== 'object') return typeof obj
      const out = {}
      for (const k of Object.keys(obj)) {
        const v = obj[k]
        out[k] = typeof v === 'function' ? 'fn' : (v && typeof v === 'object') ? ('obj:' + Object.keys(v).slice(0, 15).join(',')) : v
      }
      return out
    }
    function note(slot, props) {
      probe.slots[slot] = keysOf(props)
      probe.renders[slot] = (probe.renders[slot] || 0) + 1
    }

    function DockProbe(props) {
      note('conversation.input.dock', props)
      let draft
      try { draft = props.useInput ? props.useInput((s) => s) : undefined } catch (e) { probe.errors.push('useInput ' + e) }
      React.useEffect(() => {
        if (typeof props.sessionId === 'string') {
          probe.inputs[props.sessionId] = { actions: props.inputActions, draftState: draft && keysOf(draft), draft: draft && draft.draft }
          probe.inputActionsKeys = keysOf(props.inputActions)
        }
      })
      return null
    }
    function AssistantProbe(props) {
      note('conversation.chat.assistant-actions', props)
      probe.lastAssistantProps = props
      return h('button', { type: 'button', className: 'vg-probe-btn', title: 'vg-probe', onClick: () => { probe.clicked = keysOf(props) } }, 'VG')
    }
    function OverlayProbe(props) {
      note('shell.overlay', props)
      return h('div', { style: { position: 'fixed', left: 8, bottom: 8, zIndex: 99999, fontSize: 11, padding: '2px 6px', borderRadius: 6, background: '#ffd54f', color: '#000', pointerEvents: 'none' } }, 'vg-probe overlay')
    }
    function TabProbe(props) {
      note('sidebar.right.pane.tab', props)
      let info
      try { info = props.useTabInfo ? props.useTabInfo() : undefined } catch (e) { probe.errors.push('useTabInfo ' + e) }
      probe.tabInfo = info && keysOf(info)
      return h('div', { style: { padding: 12 } }, 'VG probe tab. props: ' + Object.keys(props).join(', '))
    }

    probe.fill = (sessionId, text) => {
      const entry = probe.inputs[sessionId]
      if (!entry || !entry.actions || typeof entry.actions.setDraft !== 'function') return 'no setDraft for session'
      entry.actions.setDraft(text)
      return 'ok'
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (!slots) { probe.errors.push('no slots service'); return }
      probe.slotsMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(slots)).concat(Object.keys(slots))
      for (const n of ['sessions', 'sidebarRight', 'sidebarRightTabs', 'layout', 'uiWorkspace', 'conversation', 'connection', 'timer', 'configForms', 'locale']) {
        try { const s = ctx.get(n); probe.services[n] = s ? Object.keys(s).concat(Object.getOwnPropertyNames(Object.getPrototypeOf(s) || {})).filter(k => k !== 'constructor').slice(0, 40) : null }
        catch (e) { probe.services[n] = 'throws ' + e }
      }
      const reg = (name, desc, comp) => {
        try {
          slots.inject(name, () => slots.register(Object.assign({ name }, desc), comp))
          probe['injected:' + name] = true
        } catch (e) { probe.errors.push(name + ' ' + e) }
      }
      reg('conversation.input.dock', { id: 'vg-probe-dock', order: 40 }, DockProbe)
      reg('conversation.chat.assistant-actions', { id: 'vg-probe-actions', order: 40 }, AssistantProbe)
      reg('shell.overlay', { id: 'vg-probe-overlay' }, OverlayProbe)

      // Optional services: declared through ctx.inject so they resolve whenever they exist.
      const svc = (n) => (c) => {
        const s = c.get(n)
        probe.services[n] = s ? Object.keys(s).concat(Object.getOwnPropertyNames(Object.getPrototypeOf(s) || {})).filter(k => k !== 'constructor').slice(0, 50) : null
        probe['svc:' + n] = s
      }
      for (const n of ['sessions', 'sidebarRight', 'layout', 'uiWorkspace', 'conversation', 'timer']) {
        try { ctx.inject([n], svc(n)) } catch (e) { probe.errors.push('inject ' + n + ' ' + e) }
      }
      try {
        ctx.inject(['sidebarRightTabs'], (c) => {
          svc('sidebarRightTabs')(c)
          const tabs = c.get('sidebarRightTabs')
          try {
            const dispose = tabs.register({ id: 'vg-probe/tab', kind: 'vg-probe', title: () => 'VG 探测',
              guide: [{ id: 'vg-probe', title: 'VG 探测', description: 'M0 probe tab' }] })
            probe.tabRegistered = typeof dispose
            c.effect(() => dispose)
          } catch (e) { probe.errors.push('sidebarRightTabs.register ' + e) }
        })
      } catch (e) { probe.errors.push('inject sidebarRightTabs ' + e) }
      reg('sidebar.right.pane.tab', { key: 'vg-probe/tab' }, TabProbe)
    }
    return { inject: ['slots'], apply }
  }
})
