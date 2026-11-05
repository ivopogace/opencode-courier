import assert from "node:assert/strict"
import test from "node:test"
import { capitalize } from "../lib/words.js"

test("capitalize upper-cases the first letter", () => {
  assert.equal(capitalize("word"), "Word")
})

test("capitalize leaves the empty string alone", () => {
  assert.equal(capitalize(""), "")
})
