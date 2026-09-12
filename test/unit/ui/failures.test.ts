import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigError } from "../../../src/config/types.js";
import { networkGuidance } from "../../../src/health/labels.js";
import { failureMessage, reportFailure } from "../../../src/ui/failures.js";
import { reset, state } from "./commandsHost.js";

vi.mock("vscode", async () => await import("./commandsHost.js"));
afterEach(() => {
  reset();
  vi.restoreAllMocks();
});

describe("safe failure reporting", () => {
  it.each([
    ["EACCES", "blocked access"],
    ["EPERM", "blocked access"],
    ["EROFS", "read-only"],
    ["ENOSPC", "storage"],
    ["EDQUOT", "quota"],
    ["ENOTDIR", "file is blocking"],
  ])("explains %s through the writer's cause wrapper", (code, expected) => {
    const cause = Object.assign(new Error("private path and contents"), { code });
    const message = failureMessage(
      new ConfigError("ATOMIC_WRITE_FAILED", "private path", { cause }),
      "Failed",
    );
    expect(message).toContain(expected);
    expect(message).not.toContain("private");
    expect(message).toContain("try again");
  });

  it("handles a circular or unknown cause without rendering its contents", () => {
    const error = new Error("private");
    error.cause = error;
    expect(failureMessage(error, "Failed safely")).toBe("Failed safely");
    expect(failureMessage({ secret: "private" }, "Failed safely")).toBe("Failed safely");
  });

  it("does not reject if both logging and the notification fail", async () => {
    const fallback = vi.spyOn(console, "error").mockImplementation(() => {});
    state.answer = () => {
      throw new Error("notification unavailable");
    };
    await expect(
      reportFailure(
        {
          error: () => {
            throw new Error("output unavailable");
          },
        },
        "Couldn't save",
      ),
    ).resolves.toBeUndefined();
    expect(fallback).toHaveBeenCalledWith("Couldn't save");
  });
});

describe("corporate network guidance", () => {
  it("reports TLS evidence without claiming a particular proxy was detected", () => {
    const guidance = networkGuidance("tls");
    expect(guidance.sentence).toContain("certificate problem");
    expect(guidance.hint).toContain("may inspect");
    expect(guidance.hint).toContain("Ask IT");
    expect(guidance.hint).not.toContain("NODE_TLS_REJECT_UNAUTHORIZED");
  });

  it("distinguishes proxy authentication from certificate trust", () => {
    expect(networkGuidance("proxy").sentence).toContain("requires sign-in");
    expect(networkGuidance("timeout").sentence).not.toContain("proxy");
  });
});
