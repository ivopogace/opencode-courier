export function addBounded<T>(set: Set<T>, value: T, max: number) {
  if (set.has(value)) return false
  set.add(value)
  if (set.size > max) set.delete(set.values().next().value!)
  return true
}

export function setBounded<K, V>(map: Map<K, V>, key: K, value: V, max: number) {
  map.set(key, value)
  if (map.size > max) map.delete(map.keys().next().value!)
}

export const SEEN_MAX = 1_000

export const claim = (set: Set<string>, value: string) => addBounded(set, value, SEEN_MAX)
