// Re-export point for the interlock test, so it imports the real implementations
// rather than reaching across the tree in several directions.
export { gatewayRunCommand } from '../../src/openclaw/run-flags.js'
export { compareVersions } from '../../src/openclaw/versions.js'
