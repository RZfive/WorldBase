import { register } from 'node:module'

/**
 * Loader hooks for running engine TS sources directly under
 * `node --experimental-strip-types`:
 *  - fall back `./x.js` imports to the sibling `./x.ts` source
 *  - stub the `electron` module (engine code only touches it lazily)
 */
register(new URL('./ts-hooks.mjs', import.meta.url))
