// A stand-in npm registry for the end-to-end test: it serves one package from a local tarball (the
// output of `npm pack`) and redirects every other request to the real registry, so
// `opencode2 plugin add <name>` installs this build exactly as it would a published one.
//
//   REGISTRY_TARBALL=opencode-courier-0.1.0.tgz REGISTRY_PORT=4602 node e2e/registry.mjs
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { createServer } from "node:http"
import { gunzipSync } from "node:zlib"

const port = Number(process.env.REGISTRY_PORT ?? 4602)
const upstream = (process.env.REGISTRY_UPSTREAM ?? "https://registry.npmjs.org").replace(/\/$/, "")
const tarball = readFileSync(process.env.REGISTRY_TARBALL)

// package/package.json from the tarball: a tar of 512-byte headers, each followed by its file.
function manifestOf(tgz) {
  const tar = gunzipSync(tgz)
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const name = tar.toString("utf8", offset, offset + 100).replace(/\0.*$/s, "")
    const size = parseInt(tar.toString("utf8", offset + 124, offset + 136).replace(/\0.*$/s, "").trim() || "0", 8)
    if (name === "package/package.json") return JSON.parse(tar.toString("utf8", offset + 512, offset + 512 + size))
    offset += 512 + Math.ceil(size / 512) * 512
  }
  throw new Error("package/package.json not found in the tarball")
}

const manifest = manifestOf(tarball)
const file = `${manifest.name}-${manifest.version}.tgz`
const tarballPath = `/${manifest.name}/-/${file}`
const packument = (host) => ({
  name: manifest.name,
  "dist-tags": { latest: manifest.version },
  versions: {
    [manifest.version]: {
      ...manifest,
      _id: `${manifest.name}@${manifest.version}`,
      dist: {
        tarball: `http://${host}${tarballPath}`,
        shasum: createHash("sha1").update(tarball).digest("hex"),
        integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
      },
    },
  },
})

createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://registry").pathname)
  if (path === `/${manifest.name}`) {
    res.writeHead(200, { "content-type": "application/json" })
    return res.end(JSON.stringify(packument(req.headers.host)))
  }
  if (path === tarballPath) {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": tarball.length })
    return res.end(tarball)
  }
  res.writeHead(302, { location: `${upstream}${req.url}` })
  res.end()
}).listen(port, "127.0.0.1", () => console.log(`registry for ${manifest.name}@${manifest.version} on ${port}`))
