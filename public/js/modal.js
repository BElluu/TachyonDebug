import { el, $ } from './core.js'

export function toast(text, level = 'info', ms = 5000) {
  const box = $('#toasts')
  const t = el('div', { class: `toast ${level}` }, text)
  box.append(t)
  setTimeout(() => t.remove(), ms)
}

// Generic dialog. Returns { close, root, body }.
export function modal({ title, body, actions = [], wide = false, dismissable = true, onClose, className = '' }) {
  const close = () => { root.remove(); onClose?.() }
  const root = el('div', { class: 'overlay', onmousedown: (e) => { if (dismissable && e.target === root) close() } },
    el('div', { class: `dialog chamfer ${wide ? 'wide' : ''} ${className}`, role: 'dialog' },
      title ? el('div', { class: 'dialog-head' }, el('h3', {}, title), dismissable ? el('button', { class: 'icon', title: 'close', onclick: close }, '✕') : null) : null,
      el('div', { class: 'dialog-body' }, body),
      actions.length ? el('div', { class: 'dialog-actions' }, actions) : null))
  document.body.append(root)
  return { close, root, body: root.querySelector('.dialog-body') }
}

export function confirmDialog(text, { ok = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    const m = modal({
      title: 'Please confirm',
      body: el('p', { style: 'white-space:pre-line' }, text),
      onClose: () => resolve(false),
      actions: [
        el('button', { onclick: () => { resolve(false); m.close() } }, 'Cancel'),
        el('button', { class: danger ? 'danger' : 'primary', onclick: () => { resolve(true); m.close() } }, ok)
      ]
    })
  })
}

export function promptDialog(title, label, value = '', { ok = 'OK', extra } = {}) {
  return new Promise((resolve) => {
    const input = el('input', { value, spellcheck: false })
    const done = (v) => { resolve(v); m.close() }
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(input.value.trim() || null) })
    const m = modal({
      title,
      body: [el('label', {}, label), input, extra?.(input)],
      onClose: () => resolve(null),
      actions: [el('button', { onclick: () => done(null) }, 'Cancel'), el('button', { class: 'primary', onclick: () => done(input.value.trim() || null) }, ok)]
    })
    setTimeout(() => { input.focus(); input.select() }, 30)
  })
}
