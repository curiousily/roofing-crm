const LABELS: Record<string, string> = {
  situs_address: "Address",
  owner_name: "Owner",
  owner_properties: "Properties this owner holds",
  owner_locality: "Owner lives",
  mailing_line1: "Mailing address",
  mailing_city: "Mailing city",
  mailing_state: "Mailing state",
  mailing_zip: "Mailing ZIP",
  ownership_years: "Years owned",
  deed_date: "Deed date",
  year_built: "Year built",
  roof_covering: "Roof covering",
  roof_age_years: "Roof age (years)",
  roof_age_anchor: "Roof age basis",
  roof_age_anchor_date: "Basis date",
  roof_age_confidence: "Confidence",
  market_value: "Market value",
  homestead: "Homestead",
  coordinate_source: "Located by",
  permit_number: "Permit",
  permit_state: "State",
  years_open: "Years open",
  open_since: "Open since",
  issue_date: "Issued",
  contractor_name: "Contractor",
  bbb_rating: "BBB",
  bbb_snapshot_date: "BBB as of",
  distance_miles: "Miles",
  prop_id: "TCAD id",
  next_action_on: "Next action",
};

export function labelOf(column: string): string {
  const label = LABELS[column];
  if (label) return label;
  const words = column.replaceAll("_", " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}
