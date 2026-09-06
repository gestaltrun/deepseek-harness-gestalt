import React from 'react'

/** Minimal in-memory store for demo state (no persistence; reset restores defaults). */
export function createStore(initial) {
  let state = initial
  const listeners = new Set()
  const emit = () => listeners.forEach(l => l())
  return {
    get: () => state,
    set(next) { state = typeof next === 'function' ? next(state) : next; emit() },
    subscribe(l) { listeners.add(l); return () => listeners.delete(l) },
  }
}

export function useStore(store) {
  return [React.useSyncExternalStore(store.subscribe, store.get, store.get), store.set]
}
