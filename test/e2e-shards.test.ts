import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

// e2e/run.sh's shards: every group runs in exactly one shard of any count, in the order of a full run,
// the two groups that restart the server share one, and the matrix in CI names every shard.
const root = resolve(import.meta.dir, "..")

const plan = (env: Record<string, string>) => {
  const run = Bun.spawnSync(["bash", "e2e/run.sh"], { cwd: root, env: { ...process.env, E2E_PLAN: "1", ...env } })
  return { code: run.exitCode, groups: run.stdout.toString().split("\n").filter(Boolean), error: run.stderr.toString() }
}

const all = plan({}).groups

describe("e2e/run.sh shards", () => {
  test("a run without a shard goes through every group, plugin-add last", () => {
    expect(all.length).toBeGreaterThan(10)
    expect(new Set(all).size).toBe(all.length)
    expect(all.at(-1)).toBe("plugin-add")
  })

  for (const n of [1, 2, 3, 4, 5, 8]) {
    test(`${n} shard(s) partition the groups, keep their order and keep the restarts together`, () => {
      const shards = Array.from({ length: n }, (_, index) => plan({ E2E_SHARD: `${index + 1}/${n}` }).groups)
      expect(shards.flat().toSorted()).toEqual(all.toSorted())
      for (const shard of shards) expect(shard).toEqual(all.filter((group) => shard.includes(group)))
      const restarts = shards.filter((shard) => shard.includes("restart-question") || shard.includes("roster"))
      expect(restarts.length).toBe(1)
      expect(restarts[0]).toContain("restart-question")
      expect(restarts[0]).toContain("roster")
      // `native` leaves nativeChildren on, and plugin-add swaps the plugin: both come last in their shard, in this order.
      for (const shard of shards) {
        if (shard.includes("native") && shard.includes("plugin-add")) expect(shard.indexOf("native")).toBeLessThan(shard.indexOf("plugin-add"))
        if (shard.includes("plugin-add")) expect(shard.at(-1)).toBe("plugin-add")
      }
    })
  }

  test("four shards weigh about the same", () => {
    const script = readFileSync(resolve(root, "e2e/run.sh"), "utf8")
    const weights = new Map(
      [...script.match(/^SUITE="([^"]+)"/m)![1]!.matchAll(/(\S+):(\d+)/g)].map((match) => [match[1]!, Number(match[2])] as const),
    )
    const loads = [1, 2, 3, 4].map((k) => plan({ E2E_SHARD: `${k}/4` }).groups.reduce((sum, group) => sum + weights.get(group)!, 0))
    expect(Math.max(...loads) - Math.min(...loads)).toBeLessThanOrEqual(Math.max(...loads) * 0.15)
  })

  test("E2E_GROUPS picks groups, in the order of a full run, and refuses an unknown one", () => {
    expect(plan({ E2E_GROUPS: "skill,depth" }).groups).toEqual(["depth", "skill"])
    const unknown = plan({ E2E_GROUPS: "nope" })
    expect(unknown.code).toBe(2)
    expect(unknown.error).toContain("unknown group nope")
  })

  test("E2E_SHARD must be k/n", () => {
    for (const shard of ["0/4", "5/4", "1", "a/b", "1/0"]) expect(plan({ E2E_SHARD: shard }).code).toBe(2)
  })

  test("the CI matrix names every shard of E2E_SHARD's count", () => {
    const ci = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8")
    const matrix = ci.match(/shard: \[([\d, ]+)\]/)![1]!.split(",").map((value) => Number(value.trim()))
    const count = Number(ci.match(/E2E_SHARD: \$\{\{ matrix\.shard \}\}\/(\d+)/)![1])
    expect(matrix).toEqual(Array.from({ length: count }, (_, index) => index + 1))
    expect(ci).toContain(`shard \${{ matrix.shard }} of ${count}`)
  })
})
