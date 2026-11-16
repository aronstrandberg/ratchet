import { Context, Effect, Layer, Redacted, Schema } from "effect"
import { causeText } from "../failure.ts"
import * as Grant from "./grant.ts"
import type { SignIn } from "./sign-in.ts"
import type { System } from "./systems.ts"

/** Nobody is signed in to a system, or the system ended the sign-in. Someone has to sign in again in a browser. */
export class NotSignedIn extends Schema.TaggedError<NotSignedIn>()("NotSignedIn", {
  system: Schema.String,
}) {
  override get message(): string {
    return `Ratchet is not signed in to ${this.system}`
  }
}

/** A sign-in could not be started, finished, read or renewed now. */
export class SignInFailed extends Schema.TaggedError<SignInFailed>()("SignInFailed", {
  system: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `the sign-in to ${this.system} failed: ${causeText(this.cause)}`
  }
}

/** The gateway's sign-ins to the systems it reads as me. */
export interface Interface {
  /** Where the sign-in to each system stands. */
  readonly statuses: Effect.Effect<Readonly<Record<System, Grant.Status>>, SignInFailed>
  /**
   * Starts a sign-in to a system and returns the address to open in a browser. `origin` is where the gateway
   * is reached, which is where the browser is sent back to.
   */
  readonly begin: (system: System, origin: string) => Effect.Effect<string, SignInFailed>
  /** Finishes a sign-in to a system with the address the browser was sent back to. */
  readonly complete: (system: System, callback: string) => Effect.Effect<void, SignInFailed>
  /** A token a system accepts, renewed first when it is about to expire. */
  readonly token: (system: System) => Effect.Effect<Redacted.Redacted<string>, NotSignedIn | SignInFailed>
  /** Says that a system refused a token, so that the next `token` renews it. */
  readonly expire: (system: System, refused: Redacted.Redacted<string>) => Effect.Effect<void, SignInFailed>
}

/** The gateway's sign-ins. */
export class Service extends Context.Service<Service, Interface>()("@ratchet/gateway/SignIns") {}

const decodeReply = Schema.decodeUnknownEffect(Grant.TokenReply)

/** The sign-ins, each held by the Durable Object under its system's name, for the targets given. */
export const layer = (
  objects: DurableObjectNamespace<SignIn>,
  targets: Readonly<Record<System, Grant.Target>>,
): Layer.Layer<Service> => {
  const call = <A>(system: System, use: (object: DurableObjectStub<SignIn>) => Promise<A>) =>
    Effect.tryPromise({
      try: () => use(objects.getByName(system)),
      catch: (cause) => new SignInFailed({ system, cause }),
    })

  const status = (system: System) => call(system, async (object) => await object.status())

  return Layer.succeed(
    Service,
    Service.of({
      statuses: Effect.all({
        "webhook-proxy": status("webhook-proxy"),
        linear: status("linear"),
        "incident-io": status("incident-io"),
        buildkite: status("buildkite"),
        spacelift: status("spacelift"),
      }),
      begin: (system, origin) =>
        call(system, async (object) => await object.begin(targets[system], `${origin}/gateway/sign-ins/${system}/callback`)),
      complete: (system, callback) => call(system, async (object) => await object.complete(callback)),
      token: (system) =>
        call(system, async (object) => await object.token()).pipe(
          Effect.flatMap(decodeReply),
          Effect.mapError((cause) => new SignInFailed({ system, cause })),
          Effect.flatMap(
            Grant.TokenReply.match({
              Token: ({ token }) => Effect.succeed(Redacted.make(token)),
              NotSignedIn: () => Effect.fail(new NotSignedIn({ system })),
            }),
          ),
        ),
      expire: (system, refused) => call(system, async (object) => await object.expire(Redacted.value(refused))),
    }),
  )
}
