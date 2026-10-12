/** `own` when the message goes to the session that scheduled it. */
export function laterText(entry: { readonly id: string; readonly sessionID: string }, fireAt: string, own: boolean) {
  const next = own
    ? "It arrives when due, after your current turn if one is running, so do not wait for it: once nothing " +
      "else is left to do now, end your turn by replying without calling more tools. If what it checks on " +
      "reports first, cancel it then with courier_cancel."
    : "Cancel it with courier_cancel if it is no longer needed."
  return `Scheduled ${entry.id} for ${fireAt}, to ${entry.sessionID}. ${next}`
}

export const cancelText = (id: string, cancelled: boolean) =>
  cancelled ? `Cancelled ${id}.` : `Nothing pending under ${id}; it may have been delivered.`
