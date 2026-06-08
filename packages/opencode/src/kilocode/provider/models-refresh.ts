import { Effect, ScopedCache } from "effect"
import type { InstanceState } from "@/effect/instance-state"

type Listener = () => Effect.Effect<void>

const listeners = new Set<Listener>()

export const notify = Effect.fn("ModelsRefresh.notify")(function* () {
  yield* Effect.forEach([...listeners], (listener) => Effect.exit(listener()), { discard: true })
})

export const watch = <A, E, R>(state: InstanceState<A, E, R>) =>
  Effect.gen(function* () {
    const listener = () => ScopedCache.invalidateAll(state.cache)
    listeners.add(listener)
    yield* Effect.addFinalizer(() => Effect.sync(() => listeners.delete(listener)))
  })
