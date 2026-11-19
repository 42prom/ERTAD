import { describe, expect, it } from "vitest";
import { displayMoney, minorUnits } from "../api/collective";

describe("external funding amounts", () => {
  it("preserves exact minor units from decimal input through display", () => {
    for (const [input, minor] of [
      ["0.01", "1"],
      ["1.1", "110"],
      ["999999999.99", "99999999999"],
    ]) {
      expect(minorUnits(input)).toBe(minor);
      expect(minorUnits(displayMoney(minor, "").trim())).toBe(minor);
    }
    expect(displayMoney("-101", "GEL")).toBe("-1.01 GEL");
  });
  it("rejects rounding, exponent input, zero and amounts beyond the ledger limit", () => {
    for (const value of [
      "1.001",
      "1e3",
      "0",
      "-1",
      "NaN",
      "Infinity",
      "1,20",
      "1000000000",
      "01",
      " 1",
    ]) {
      expect(() => minorUnits(value)).toThrow("INVALID_AMOUNT");
    }
  });
});
