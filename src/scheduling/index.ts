import type { TickJob } from "../platform/hub.js"
import { deliverDue, type LaterPorts } from "./later.js"

export { cancel, deliverDue, isScheduled, schedule, scheduledFor } from "./later.js"
export type { LaterEntry, LaterInput, LaterPorts } from "./later.js"
export { addSchedulingTools } from "./tools.js"

/** The scheduler's tick job: due messages, through the first loaded member, whose `later` is every hub-v2 member's LaterPorts. */
export const dueJob: TickJob = (owner, claimed) => deliverDue(owner.later as LaterPorts, claimed)
