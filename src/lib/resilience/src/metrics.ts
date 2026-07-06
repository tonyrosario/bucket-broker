import type { BreakerState } from "./circuit-breaker";

/** Why a fallback was activated instead of the primary dependency result. */
export type FallbackReason = "circuit_open" | "operation_failed";

/**
 * Structured metric events. ADR-0004 requires breaker state transitions and
 * fallback activations to be observable; retry and call-result events are
 * included so degraded operation is fully traceable.
 */
export type MetricEvent =
  | {
      type: "breaker_transition";
      dependency: string;
      from: BreakerState;
      to: BreakerState;
      at: number;
    }
  | {
      type: "fallback_activation";
      dependency: string;
      reason: FallbackReason;
      at: number;
    }
  | {
      type: "retry";
      dependency: string;
      attempt: number;
      delayMs: number;
      at: number;
    }
  | {
      type: "call_result";
      dependency: string;
      outcome: "success" | "failure";
      at: number;
    };

/**
 * Pluggable metrics sink. Deliberately NOT bound to CloudWatch: a Lambda wires
 * in an EMF/CloudWatch adapter, tests wire in {@link InMemoryMetricsSink}, and
 * the default is the {@link NoopMetricsSink}.
 */
export interface MetricsSink {
  emit(event: MetricEvent): void;
}

/** Discards all metrics. Safe default so a missing sink never breaks a call. */
export class NoopMetricsSink implements MetricsSink {
  emit(_event: MetricEvent): void {
    // intentionally no-op
  }
}

/** Buffers emitted events in memory. Intended for tests and local inspection. */
export class InMemoryMetricsSink implements MetricsSink {
  public readonly events: MetricEvent[] = [];

  emit(event: MetricEvent): void {
    this.events.push(event);
  }

  /** All events of a given type, narrowed to that variant. */
  ofType<T extends MetricEvent["type"]>(
    type: T,
  ): Extract<MetricEvent, { type: T }>[] {
    return this.events.filter(
      (e): e is Extract<MetricEvent, { type: T }> => e.type === type,
    );
  }
}
