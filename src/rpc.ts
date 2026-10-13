// The package's `rpc` entrypoint: the courier's RPC contracts, for a client that calls them.
export { treeRpc, type Summary, type TreeRpc } from "./tree/rpc.js"
export { personRpc, type Answered, type Asks, type PersonRpc } from "./person/rpc.js"
