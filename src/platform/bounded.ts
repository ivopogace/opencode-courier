/**
 * Bounded `Set`s and `Map`s of remembered ids that drop their oldest entry past a bound. Functions
 * on the built-ins, not a class, as older plugin copies call `.has` and `.add` on the shared ones.
 */

/** Adds to a bounded set, dropping the oldest entry past `max`; false when the value was there already. */
export function addBounded<T>(set: Set<T>, value: T, max: number) {
  if (set.has(value)) return false
  set.add(value)
  if (set.size > max) set.delete(set.values().next().value!)
  return true
}

/** Sets an entry of a bounded map, dropping the oldest entry past `max`; an existing key keeps its place. */
export function setBounded<K, V>(map: Map<K, V>, key: K, value: V, max: number) {
  map.set(key, value)
  if (map.size > max) map.delete(map.keys().next().value!)
}
