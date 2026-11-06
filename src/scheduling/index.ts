import type { TickJob } from "../platform/hub.js"
import { deliverDue, type LaterPorts } from "./later.js"

export { cancel, cancelScheduled, deliverDue, isScheduled, schedule, scheduledFor } from "./later.js"
export type { LaterEntry, LaterInput, LaterPorts } from "./later.js"
export { addSchedulingTools } from "./tools.js"

export const dueJob: TickJob = (owner, claimed) => deliverDue(owner.later as LaterPorts, claimed)
