'use strict'

const safeRegex = require('safe-regex2')

const EVENTS = new Set(['join', 'chat', 'world-change'])
const OPERATORS = new Set(['includes', 'exact', 'regex', 'not-includes'])
const STEP_TYPES = new Set(['command', 'delay', 'condition', 'repeat'])

function cleanText (value, label, { required = true, max = 256 } = {}) {
  const text = String(value || '').trim()
  if (required && !text) throw new Error(`${label} cannot be empty`)
  if (text.length > max) throw new Error(`${label} cannot exceed ${max} characters`)
  return text
}

function cleanDelay (value, label = 'Delay') {
  const delayMs = Number(value)
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 600_000) {
    throw new Error(`${label} must be between 0 and 600 seconds`)
  }
  return delayMs
}

function normalizeCondition (raw, label) {
  const operator = OPERATORS.has(raw?.operator) ? raw.operator : 'includes'
  const value = cleanText(raw?.value, `${label} value`)
  if (operator === 'regex') {
    try { new RegExp(value, 'i') } catch { throw new Error(`${label} contains an invalid regular expression`) }
    if (!safeRegex(value)) throw new Error(`${label} regular expression is too complex`)
  }
  return { operator, value }
}

function normalizeSteps (rawSteps, label = 'Workflow', depth = 0, counter = { count: 0 }) {
  if (!Array.isArray(rawSteps)) throw new Error(`${label} steps are invalid`)
  if (depth > 5) throw new Error(`${label} nesting cannot exceed 5 levels`)
  return rawSteps.map((raw, index) => {
    counter.count++
    if (counter.count > 500) throw new Error('Workflow configuration cannot exceed 500 total steps')
    const stepLabel = `${label} step ${index + 1}`
    const type = STEP_TYPES.has(raw?.type) ? raw.type : 'command'
    const id = cleanText(raw?.id || `step-${Date.now()}-${index}`, `${stepLabel} id`, { max: 80 })
    if (type === 'command') {
      return { id, type, text: cleanText(raw?.text, `${stepLabel} command`), delayMs: cleanDelay(raw?.delayMs || 0, `${stepLabel} delay`) }
    }
    if (type === 'delay') return { id, type, delayMs: cleanDelay(raw?.delayMs || 0, `${stepLabel} delay`) }
    if (type === 'condition') {
      return {
        id,
        type,
        condition: normalizeCondition(raw?.condition, stepLabel),
        then: normalizeSteps(raw?.then || [], `${stepLabel} then branch`, depth + 1, counter),
        else: normalizeSteps(raw?.else || [], `${stepLabel} else branch`, depth + 1, counter)
      }
    }
    const count = Number(raw?.count)
    if (!Number.isInteger(count) || count < 1 || count > 50) throw new Error(`${stepLabel} repeat count must be between 1 and 50`)
    return { id, type, count, steps: normalizeSteps(raw?.steps || [], `${stepLabel} repeat`, depth + 1, counter) }
  })
}

function normalizeWorkflowV2 (raw = {}) {
  if (raw == null) raw = {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Workflow 2.0 settings are invalid')
  const flows = raw.flows == null ? [] : raw.flows
  if (!Array.isArray(flows) || flows.length > 50) throw new Error('Workflow 2.0 supports up to 50 flows')
  return {
    enabled: raw.enabled !== false,
    flows: flows.map((flow, index) => {
      const label = `Flow ${index + 1}`
      const event = EVENTS.has(flow?.event) ? flow.event : 'join'
      const normalized = {
        id: cleanText(flow?.id || `flow-${Date.now()}-${index}`, `${label} id`, { max: 80 }),
        name: cleanText(flow?.name || label, `${label} name`, { max: 80 }),
        enabled: flow?.enabled !== false,
        event,
        cooldownMs: cleanDelay(flow?.cooldownMs || 0, `${label} cooldown`),
        steps: normalizeSteps(flow?.steps || [], label)
      }
      if (event === 'chat') normalized.match = normalizeCondition(flow?.match || { operator: 'includes', value: 'message' }, `${label} chat match`)
      return normalized
    })
  }
}

function conditionMatches (condition, context = {}) {
  const source = String(context.message || context.value || '')
  const expected = String(condition?.value || '')
  if (condition?.operator === 'exact') return source.toLowerCase() === expected.toLowerCase()
  if (condition?.operator === 'regex') {
    try { return new RegExp(expected, 'i').test(source) } catch { return false }
  }
  if (condition?.operator === 'not-includes') return !source.toLowerCase().includes(expected.toLowerCase())
  return source.toLowerCase().includes(expected.toLowerCase())
}

module.exports = { EVENTS, OPERATORS, STEP_TYPES, conditionMatches, normalizeWorkflowV2 }
