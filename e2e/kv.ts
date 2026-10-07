// Reads or removes a key of a plugin's storage straight in the database of the OpenCode under test,
// found in $XDG_DATA_HOME/opencode; the end-to-end test uses it to look at the roster's reverse index and
// to stand in for an older version of the plugin, which writes entries without one.
//
//   bun e2e/kv.ts get roster-by-child/ses_x      # prints the value as JSON, or nothing
//   bun e2e/kv.ts remove roster-by-child/ses_x   # only while the server is stopped
import { Database } from "bun:sqlite"
import { readdirSync } from "node:fs"
import { join } from "node:path"

const [action, key] = process.argv.slice(2)
if ((action !== "get" && action !== "remove") || !key) throw new Error("usage: bun e2e/kv.ts get|remove <key>")

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
const found = rows.filter((row) => row.key.slice(row.key.indexOf(":", "plugin:".length) + 1) === key)
if (found.length > 1) throw new Error(`${key} is stored by ${found.length} plugins`)
if (action === "get") {
  if (found[0]) console.log(found[0].value)
} else {
  for (const row of found) db.query("delete from kv where key = ?").run(row.key)
}
db.close()
