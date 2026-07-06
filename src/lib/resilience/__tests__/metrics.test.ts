import { InMemoryMetricsSink, NoopMetricsSink } from "../src/metrics";

describe("metrics sinks", () => {
  it("NoopMetricsSink swallows events without throwing", () => {
    const sink = new NoopMetricsSink();
    expect(() =>
      sink.emit({
        type: "call_result",
        dependency: "d",
        outcome: "success",
        at: 1,
      }),
    ).not.toThrow();
  });

  it("InMemoryMetricsSink records events and filters by type", () => {
    const sink = new InMemoryMetricsSink();
    sink.emit({
      type: "breaker_transition",
      dependency: "d",
      from: "closed",
      to: "open",
      at: 1,
    });
    sink.emit({
      type: "fallback_activation",
      dependency: "d",
      reason: "circuit_open",
      at: 2,
    });
    sink.emit({
      type: "fallback_activation",
      dependency: "d",
      reason: "operation_failed",
      at: 3,
    });

    expect(sink.events).toHaveLength(3);
    expect(sink.ofType("fallback_activation")).toHaveLength(2);
    expect(sink.ofType("breaker_transition")[0].to).toBe("open");
  });
});
