// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installMobileWebViewCompatibility } from '../src/webview-compat.ts'

const descriptors = {
  replaceChildren: Object.getOwnPropertyDescriptor(Element.prototype, 'replaceChildren'),
}

afterEach(() => {
  restore(Element.prototype, 'replaceChildren', descriptors.replaceChildren)
  vi.unstubAllGlobals()
})

describe('Android System WebView compatibility', () => {
  it('provides the APIs required by the Mobile bundle on WebView 83', () => {
    Reflect.deleteProperty(Element.prototype, 'replaceChildren')
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.set(Array.from({ length: 16 }, (_, index) => index))
        return bytes
      },
    })

    installMobileWebViewCompatibility()

    expect(crypto.randomUUID()).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f')
    class InheritedOnly {
      get inherited(): boolean { return true }
    }
    const inheritedOnly: object = new InheritedOnly()
    expect(Object.hasOwn(inheritedOnly, 'inherited')).toBe(false)
    expect(['first', 'last'].at(-1)).toBe('last')
    expect('a-b-a'.replaceAll('a', 'x')).toBe('x-b-x')
    expect('a'.replaceAll('a', '$&x')).toBe('ax')
    expect('a-b'.replaceAll('-', (match, offset) => `${match}${String(offset)}`)).toBe('a-1b')
    expect(() => 'a'.replaceAll(/a/u, 'x')).toThrow(TypeError)
    expect(new AggregateError(['failure'], 'aggregate')).toMatchObject({
      name: 'AggregateError', message: 'aggregate', errors: ['failure'],
    })
    const root = document.createElement('div')
    root.append('old')
    const child = document.createElement('span')
    child.textContent = 'new'
    root.replaceChildren(child)
    expect(root.innerHTML).toBe('<span>new</span>')
  })
})

function restore(target: object, property: PropertyKey, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) Reflect.deleteProperty(target, property)
  else Object.defineProperty(target, property, descriptor)
}
