/**
 * Browser stand-in for `node:url`. `pathToFileURL` is unreachable in the
 * configured loader path (the shell injects the client module system as the
 * loader's internal before any entry imports) and fails loud if that
 * assumption changes.
 */

/** Throwing stand-in for node:url's pathToFileURL (never reached in the browser boot). */
export const pathToFileURL = (): never => {
  throw new Error('node:url is not available in the browser')
}
