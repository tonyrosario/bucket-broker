import { ResiliencePolicy } from "./policy";
import type { ResiliencePolicyOptions } from "./policy";

/**
 * A registry of one {@link ResiliencePolicy} per dependency. Because breaker
 * state must persist across calls, a Lambda constructs the registry once at
 * module scope (surviving warm invocations) and reuses the same policy — and
 * therefore the same breaker — for every call to a given dependency.
 */
export class ResilienceRegistry {
  private readonly policies = new Map<string, ResiliencePolicy>();

  /** Register (or replace) the policy for a dependency and return it. */
  register(opts: ResiliencePolicyOptions): ResiliencePolicy {
    const policy = new ResiliencePolicy(opts);
    this.policies.set(opts.dependency, policy);
    return policy;
  }

  /** Get an existing policy, or `undefined` if the dependency is unregistered. */
  get(dependency: string): ResiliencePolicy | undefined {
    return this.policies.get(dependency);
  }

  /** Get an existing policy or lazily register one from `opts`. */
  getOrRegister(opts: ResiliencePolicyOptions): ResiliencePolicy {
    return this.policies.get(opts.dependency) ?? this.register(opts);
  }
}
