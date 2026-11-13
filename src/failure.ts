/** A short text for what caused a failure, for a message people read. */
export const causeText = (cause: unknown): string =>
  cause instanceof Error ? (cause.message === "" ? cause.name : `${cause.name}: ${cause.message}`) : String(cause)

/**
 * The same failure as an error that survives a service binding.
 *
 * A binding carries an error's name and its own `message` and nothing else, so a message that a class
 * computes is copied onto the error here.
 */
export const forBinding = (cause: unknown): Error => {
  const error = new Error(cause instanceof Error && cause.message !== "" ? cause.message : String(cause))

  if (cause instanceof Error) error.name = cause.name

  return error
}
