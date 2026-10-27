const EARTH_RADIUS_MILES = 3958.8;
const MILES_PER_DEGREE_LATITUDE = 69.0;

export interface Center {
  name?: string;
  latitude: number;
  longitude: number;
}

export function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function list(values: readonly string[]): string {
  return values.map(literal).join(", ");
}

export function distanceMiles(center: Center): string {
  const radians = (degrees: string) => `radians(${degrees})`;
  return `${EARTH_RADIUS_MILES} * 2 * asin(sqrt(
    pow(sin((${radians("latitude")} - ${radians(String(center.latitude))}) / 2), 2) +
    cos(${radians(String(center.latitude))}) * cos(${radians("latitude")}) *
    pow(sin((${radians("longitude")} - ${radians(String(center.longitude))}) / 2), 2)))`;
}

export function withinBox(center: Center, radiusMiles: number): string {
  const latitudeSpan = radiusMiles / MILES_PER_DEGREE_LATITUDE;
  const longitudeSpan =
    radiusMiles / (MILES_PER_DEGREE_LATITUDE * Math.cos((center.latitude * Math.PI) / 180));
  return `latitude BETWEEN ${center.latitude - latitudeSpan} AND ${center.latitude + latitudeSpan}
    AND longitude BETWEEN ${center.longitude - longitudeSpan} AND ${center.longitude + longitudeSpan}`;
}
