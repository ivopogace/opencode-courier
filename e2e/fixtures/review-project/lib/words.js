// Small text helpers.

export function capitalize(word) {
  if (typeof word !== "string") throw new TypeError("capitalize takes a string")
  return word.length === 0 ? "" : word[0].toUpperCase() + word.slice(1)
}
