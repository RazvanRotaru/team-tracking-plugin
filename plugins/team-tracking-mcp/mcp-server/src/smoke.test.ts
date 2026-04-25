import { describe, expect, it } from "vitest";
import { VERSION } from "./index.js";

describe("smoke", () => {
  it("exports VERSION", () => {
    expect(VERSION).toBe("0.0.1");
  });
});
