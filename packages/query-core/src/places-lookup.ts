import { PLACES, type Place } from "./places.js";

const SUGGESTION_COUNT = 12;

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

export function findPlace(name: string): Place {
  const wanted = name.trim().toLowerCase();
  const byName = (predicate: (candidate: string) => boolean) =>
    PLACES.filter((place) => predicate(place.name.toLowerCase())).sort(
      (a, b) => a.name.length - b.name.length,
    )[0];

  const place =
    byName((candidate) => candidate === wanted) ??
    byName((candidate) => candidate.startsWith(wanted)) ??
    byName((candidate) => candidate.includes(wanted));
  if (place) return place;

  const suggestions = PLACES.map((known) => known.name).slice(0, SUGGESTION_COUNT);
  throw new ToolInputError(
    `Unknown place "${name}". Known places include: ${suggestions.join(", ")}.`,
  );
}
