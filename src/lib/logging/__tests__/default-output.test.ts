/**
 * Tests for the default stdout output path of Logger.
 *
 * Logger's default output function writes a JSON line to process.stdout.
 * This is the path taken in production Lambda code when no custom output
 * is provided. We spy on process.stdout.write to verify the format.
 */

import { Logger } from "../src/logger";

describe("Logger — default stdout output", () => {
  let writeSpy: jest.SpyInstance;

  beforeEach(() => {
    writeSpy = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  it("writes a newline-terminated JSON string to process.stdout", () => {
    const logger = new Logger({ service: "stdout-svc", layer: "lambda" });
    logger.info("stdout test");

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const calls = writeSpy.mock.calls as [string, ...unknown[]][];
    const written = calls[0][0];
    expect(written).toMatch(/\n$/);

    const parsed = JSON.parse(written.trim()) as Record<string, unknown>;
    expect(parsed["level"]).toBe("info");
    expect(parsed["message"]).toBe("stdout test");
    expect(parsed["service"]).toBe("stdout-svc");
  });

  it("each log call writes exactly one line", () => {
    const logger = new Logger({ service: "svc", layer: "lyr" });
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(writeSpy).toHaveBeenCalledTimes(4);
  });
});
