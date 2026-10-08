// Reads, removes or sets a key of a plugin's storage straight in the database of the OpenCode under
// test, found in $XDG_DATA_HOME/opencode; the end-to-end test uses it to look at the roster's reverse
// index and the scheduler's owner key, to stand in for an older version of the plugin, which writes
// entries without the index, and for another server holding the owner key.
//
//   bun e2e/kv.ts get roster-by-child/ses_x      # prints the value as JSON, or nothing
//   bun e2e/kv.ts remove roster-by-child/ses_x   # only while the server is stopped
//   bun e2e/kv.ts set scheduler/owner '{"server":"other","at":1}' later/later_x   # while the server is stopped
//
// `set` takes a key the same plugin has stored, whose prefix names the plugin.
import { Database } from "bun:sqlite"
import { readdirSync } from "node:fs"
import { join } from "node:path"

const [action, key] = process.argv.slice(2)
const [value, sibling] = process.argv.slice(4)
if (!["get", "remove", "set"].includes(action!) || !key || (action === "set") !== (sibling !== undefined))
  throw new Error("usage: bun e2e/kv.ts get|remove <key>, or set <key> <json> <a key the plugin stored>")

// OpenCode's own database is directly in its data directory, not in a worktree under it.
const data = join(process.env.XDG_DATA_HOME!, "opencode")
const databases = readdirSync(data)
  .filter((file) => file.endsWith(".db"))
  .map((file) => join(data, file))
const withKv = databases.filter((file) => {
  const db = new Database(file, { readonly: true })
  try {
    return db.query("select 1 from sqlite_master where type = 'table' and name = 'kv'").get() !== null
  } finally {
    db.close()
  }
})
if (withKv.length !== 1) throw new Error(`expected one database with a kv table, found ${withKv.length} in ${databases.join(", ")}`)
const db = new Database(withKv[0]!, action === "get" ? { readonly: true } : { readwrite: true })

// A plugin's keys are stored as `plugin:<its id, hex-encoded>:<key>`.
const rows = db.query("select key, value from kv where key like 'plugin:%'").all() as Array<{ key: string; value: string }>
const named = (name: string) => rows.filter((row) => row.key.slice(row.key.indexOf(":", "plugin:".length) + 1) === name)
const found = named(key)
if (found.length > 1) throw new Error(`${key} is stored by ${found.length} plugins`)
if (action === "get") {
  if (found[0]) console.log(found[0].value)
} else if (action === "set") {
  const [stored, ...others] = named(sibling!)
  if (!stored || others.length > 0) throw new Error(`${sibling} is stored by ${others.length + (stored ? 1 : 0)} plugins`)
  const now = Date.now()
  db.query("insert or replace into kv (key, value, time_created, time_updated) values (?, ?, ?, ?)").run(
    stored.key.slice(0, stored.key.length - sibling!.length) + key,
    JSON.stringify(JSON.parse(value!)),
    now,
    now,
  )
} else {
  for (const row of found) db.query("delete from kv where key = ?").run(row.key)
}
db.close()
