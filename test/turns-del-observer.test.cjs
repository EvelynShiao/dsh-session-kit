const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8')
const component = source.slice(source.indexOf('function TurnsDelAction('), source.indexOf('function deletedTurnsDelRange('))

test('message actions do not create per-message global MutationObservers', () => {
  assert.ok(component.length > 1000)
  assert.equal(component.includes('new MutationObserver'), false)
  assert.equal(component.includes('observer.observe(document.body'), false)
  assert.equal(component.includes('revealTurnsDelConcealment'), false)
})

test('per-session shared deletion-range observer remains installed', () => {
  assert.match(source, /function subscribeTurnsDelRanges\(sessionId\)[\s\S]*?new MutationObserver\(\(\) => applyTurnsDelRanges\(sessionId\)\)/)
  assert.match(source, /function TurnsDelRestoreGuard[\s\S]*?return subscribeTurnsDelRanges\(sessionId\)/)
  assert.match(source, /function TurnsDelMarker[\s\S]*?return subscribeTurnsDelRanges\(sessionId\)/)
})
