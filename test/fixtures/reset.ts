import { hub, sharedState } from "../../src/platform/hub.js"
import type { SpawnGate } from "../../src/tree/ports.js"
import { shared as questions } from "../../src/person/question/shared.js"

/**
 * Forgets every remembered id, the spawns under way, the forms shown and the question relay's state, loaded instances
 * and watcher count included. Members, locations and the receiver are left to unloading.
 */
export function resetHub() {
  sharedState<SpawnGate>("spawning", () => ({ reserved: new Set(), turn: Promise.resolve() })).reserved.clear()
  sharedState("inbox", () => new Map<string, string>()).clear()
  sharedState("formsShown", () => new Map<string, unknown>()).clear()
  hub.claimed.clear()
  hub.watched.seen.clear()
  hub.watched.waiting.clear()
  hub.watched.answered.clear()
  hub.forms.told.clear()
  hub.forms.settled.clear()
  questions.questions.clear()
  questions.noticed.clear()
  questions.shown.clear()
  questions.passing.clear()
  questions.answered.clear()
  questions.loaded.clear()
  questions.following = 0
  questions.followed = false
  questions.shutdowns.clear()
  questions.closingWaiters.clear()
}
