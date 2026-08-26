import { describe, expect, it } from 'vitest'
import { contextForm, contextProvenance, sessionRecallLabels } from '../src/context-provenance.ts'

describe('context provenance', () => {
  it('projects every known producer and preserves readable durable fallbacks', () => {
    expect(contextProvenance(null)).toEqual({ role: 'inject', label: null })
    expect(contextProvenance([])).toEqual({ role: 'inject', label: null })
    expect(contextProvenance({ kind: '' })).toEqual({ role: 'inject', label: null })
    expect(contextProvenance({
      kind: 'session-reference',
      references: [{ label: 'First' }, null, { label: '' }, { label: 'First' }, { label: 'Second' }],
    })).toEqual({ role: 'recall', label: 'First, Second' })
    expect(contextProvenance({ kind: 'session-reference' })).toEqual({
      role: 'recall', label: 'session-reference',
    })
    expect(contextProvenance({
      kind: 'agent-instructions', changes: [{ path: 'AGENTS.md' }, { path: 'packages/AGENTS.md' }],
    })).toEqual({ role: 'inject', label: 'AGENTS.md, packages/AGENTS.md' })
    expect(contextProvenance({ kind: 'agent-instructions', changes: 'invalid' })).toEqual({
      role: 'inject', label: 'agent-instructions',
    })
    expect(contextProvenance({ kind: 'plugin', plugin: 'demo-plugin' })).toEqual({
      role: 'inject', label: 'demo-plugin',
    })
    expect(contextProvenance({ kind: 'plugin' })).toEqual({ role: 'inject', label: 'plugin' })
    expect(contextProvenance({ kind: 'skill-invocation', name: 'demo-skill' })).toEqual({
      role: 'inject', label: 'demo-skill',
    })
    expect(contextProvenance({ kind: 'skill-invocation' })).toEqual({
      role: 'inject', label: 'skill-invocation',
    })
    expect(contextProvenance({ kind: 'workspace-reference', path: 'CONTEXT.md' })).toEqual({
      role: 'inject', label: 'CONTEXT.md',
    })
    expect(contextProvenance({ kind: 'workspace-reference' })).toEqual({
      role: 'inject', label: 'workspace-reference',
    })
    expect(contextProvenance({ kind: 'foreign-producer' })).toEqual({
      role: 'inject', label: 'foreign-producer',
    })
  })

  it('reads recall labels and known forms from untrusted durable sources', () => {
    expect(sessionRecallLabels('invalid')).toEqual([])
    expect(sessionRecallLabels({ kind: 'plugin' })).toEqual([])
    expect(sessionRecallLabels({ kind: 'session-reference', references: 'invalid' })).toEqual([])
    expect(sessionRecallLabels({
      kind: 'session-reference', references: [{ label: 'One' }, { label: 'One' }, { label: 'Two' }],
    })).toEqual(['One', 'Two'])
    expect(contextForm(null)).toBeNull()
    expect(contextForm({ form: '' })).toBeNull()
    expect(contextForm({ form: 'future-form' })).toBeNull()
    expect(contextForm({ form: 'instructions' })).toBe('instructions')
  })
})
