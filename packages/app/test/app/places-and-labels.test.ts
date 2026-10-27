import { describe, expect, it } from "vitest";
import { labelOf } from "../../src/labels.js";
import { isInTravisCounty } from "../../src/map/in-county.js";

describe("isInTravisCounty", () => {
  it("accepts positions inside the county outline and refuses the rest", () => {
    expect(isInTravisCounty(30.2672, -97.7431)).toBe(true);
    expect(isInTravisCounty(30.4394, -97.62)).toBe(true);
    expect(isInTravisCounty(29.4241, -98.4936)).toBe(false);
    expect(isInTravisCounty(30.6333, -97.678)).toBe(false);
    expect(isInTravisCounty(30.1, -98.1)).toBe(false);
  });
});

describe("labelOf", () => {
  it("names columns for people", () => {
    expect(labelOf("owner_locality")).toBe("Owner lives");
    expect(labelOf("roof_age_anchor")).toBe("Roof age basis");
    expect(labelOf("roof_work")).toBe("Roof work");
  });
});
