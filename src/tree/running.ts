import type { Plugin } from "@opencode/plugin"
import { archivedSinceTurn, busy, endsIdle, type BusyTimes } from "./domain.js"

/**
 * Whether a session runs: by its times (`busy`), unless its archive stamped them since its last turn ended, when its transcript
 * says whether a turn runs since (#324). A transcript that cannot be read leaves it idle, as archived sessions mostly are.
 */
export async function runs(session: Pick<Plugin.Context["session"], "context">, sessionID: string, time: BusyTimes) {
  if (!archivedSinceTurn(time)) return busy(time)
  return session.context({ sessionID }).then((messages) => !endsIdle(messages), () => false)
}
