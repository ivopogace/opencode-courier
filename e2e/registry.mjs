// A stand-in npm registry for the end-to-end test: it serves one package from a local tarball (the
// output of `npm pack`, with the package.json it was packed from) and redirects every other request
// to the real registry, so `opencode plugin add <name>` installs this build exactly as it would a
// published one.
//
//   REGISTRY_TARBALL=opencode-courier-0.1.0.tgz REGISTRY_MANIFEST=package.json node e2e/registry.mjs
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { createServer } from "node:http"

const port = Number(process.env.REGISTRY_PORT ?? 4602)
const upstream = (process.env.REGISTRY_UPSTREAM ?? "https://registry.npmjs.org").replace(/\/$/, "")
const tarball = readFileSync(process.env.REGISTRY_TARBALL)

const manifest = JSON.parse(readFileSync(process.env.REGISTRY_MANIFEST ?? "package.json", "utf8"))
const file = `${manifest.name}-${manifest.version}.tgz`
const tarballPath = `/${manifest.name}/-/${file}`
const shasum = createHash("sha1").update(tarball).digest("hex")
const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`
const packument = (host) => ({
  name: manifest.name,
  "dist-tags": { latest: manifest.version },
  versions: {
    [manifest.version]: {
      ...manifest,
      _id: `${manifest.name}@${manifest.version}`,
      dist: {
        tarball: `http://${host}${tarballPath}`,
        shasum,
        integrity,
      },
    },
  },
})

createServer((req, res) => {
  const path = new URL(req.url, "http://registry").pathname
  if (path === `/${manifest.name}`) {
    res.writeHead(200, { "content-type": "application/json" })
    return res.end(JSON.stringify(packument(req.headers.host)))
  }
  if (path === tarballPath) {
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": tarball.length })
    return res.end(tarball)
  }
  // 307 keeps the method and body of anything other than a GET.
  res.writeHead(307, { location: `${upstream}${req.url}` })
  res.end()
}).listen(port, "127.0.0.1", () => console.log(`registry for ${manifest.name}@${manifest.version} on ${port}`))
