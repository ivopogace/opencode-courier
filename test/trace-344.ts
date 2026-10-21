// TEMPORARY (#344): traces the test renderer's awaits and dumps what is still pending when it is destroyed.
import os from "node:os"
import { jest } from "bun:test"

const log: string[] = []
const pending = new Map<number, string>()
let seq = 0

const push = (line: string) => {
  log.push(`${os.uptime().toFixed(2)} ${line}`)
  if (log.length > 300) log.shift()
}

export const step = (what: string) => push(`T ${what}`)

const brief = (args: unknown[]) =>
  args
    .filter((one) => typeof one !== "function" && (typeof one !== "object" || one === null))
    .map(String)
    .join(",")

function wrap(target: any, name: string, label: string, after?: (self: any) => string) {
  const original = target?.[name]
  if (typeof original !== "function") return push(`no ${label}`)
  try {
    target[name] = function (this: unknown, ...args: unknown[]) {
      const id = ++seq
      push(`> ${label}#${id} ${brief(args)}`)
      let result: any
      try {
        result = original.apply(this, args)
      } catch (error) {
        push(`! ${label}#${id} ${error}`)
        throw error
      }
      if (result && typeof result.then === "function") {
        pending.set(id, label)
        result.then(
          (value: unknown) => {
            pending.delete(id)
            push(`< ${label}#${id} ${typeof value === "object" ? "" : String(value)}`)
          },
          (error: unknown) => {
            pending.delete(id)
            push(`! ${label}#${id} ${error}`)
          },
        )
      } else push(`= ${label}#${id} ${typeof result === "object" ? "" : String(result)}${after ? " " + after(this) : ""}`)
      return result
    }
  } catch (error) {
    push(`cannot wrap ${label}: ${error}`)
  }
}

const sessionState = (session: any) => {
  try {
    return JSON.stringify({
      scheduled: session.scheduled ? String(session.scheduled.deadlineNs) : null,
      output: session.output ? { completed: session.output.completed } : null,
      blocked: session.blocked,
      presentationWait: !!session.presentationWait,
      transition: session.transition?.kind ?? null,
      stopped: session.stopped,
      error: session._error ? String(session._error) : null,
      framePending: session.lib.sessionGetRendererState(session.context, session.session).framePending,
    })
  } catch (error) {
    return `state: ${error}`
  }
}

export function trace(app: { renderer: any }) {
  log.length = 0
  pending.clear()
  const renderer = app.renderer
  const session = renderer.nativeSession
  wrap(renderer, "loop", "loop")
  wrap(renderer, "yieldFrame", "yield")
  wrap(renderer, "presentNativeScene", "present")
  wrap(renderer, "waitForTerminalTransition", "transition")
  wrap(renderer, "queueFrame", "queue")
  wrap(renderer, "scheduleFrame", "scheduleFrame")
  wrap(renderer.nativeScene, "paint", "paint")
  wrap(session, "whenPresented", "whenPresented")
  wrap(session, "schedule", "sessionSchedule")
  wrap(session, "turn", "turn", sessionState)
  renderer.once("destroy", () => {
    if (!pending.size && !process.env.TRACE344_ALWAYS) return
    const lines = [
      `#344 renderer destroyed with ${pending.size} await(s) pending: ${[...pending].map(([id, label]) => `${label}#${id}`).join(" ")}`,
      `scheduler ${JSON.stringify(renderer.getSchedulerState())} rendering=${renderer.rendering} running=${renderer._isRunning} control=${renderer._controlState} canRender=${renderer.canRender} renderTimeout=${!!renderer.renderTimeout} cancelReadyFrame=${!!renderer.cancelReadyFrame} transition=${!!renderer.nativeTerminalTransition} fakeTimers=${(() => { try { return jest.getTimerCount() } catch { return "off" } })()}`,
      `session ${sessionState(session)}`,
      ...log,
    ]
    process.stderr.write(lines.join("\n") + "\n#344 end\n")
  })
}
