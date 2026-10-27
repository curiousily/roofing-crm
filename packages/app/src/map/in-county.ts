import { TRAVIS_COUNTY_RING } from "./travis-county.js";

export function isInTravisCounty(latitude: number, longitude: number): boolean {
  let inside = false;
  for (
    let index = 0, previous = TRAVIS_COUNTY_RING.length - 1;
    index < TRAVIS_COUNTY_RING.length;
    previous = index++
  ) {
    const [currentLongitude, currentLatitude] = TRAVIS_COUNTY_RING[index] ?? [0, 0];
    const [previousLongitude, previousLatitude] = TRAVIS_COUNTY_RING[previous] ?? [0, 0];
    const crosses =
      currentLatitude > latitude !== previousLatitude > latitude &&
      longitude <
        ((previousLongitude - currentLongitude) * (latitude - currentLatitude)) /
          (previousLatitude - currentLatitude) +
          currentLongitude;
    if (crosses) inside = !inside;
  }
  return inside;
}
