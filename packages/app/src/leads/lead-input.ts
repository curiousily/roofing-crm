import type { Row } from "@travis-oracle/query-core";
import { type DatasetRef, LeadSignal, type NewLeadInput } from "../../worker/leads/lead.js";

const MAILING_LINES = ["mailing_line1", "mailing_line2", "mailing_line3"];

export function leadFromProperty(
  row: Row,
  details: Row | undefined,
  dataset: DatasetRef,
): NewLeadInput {
  return withoutEmpty({
    signal: LeadSignal.AgedRoof,
    propId: numberOf(row.prop_id),
    address: textOf(row.situs_address) ?? "",
    latitude: numberOf(row.latitude),
    longitude: numberOf(row.longitude),
    ownerName: textOf(row.owner_name) ?? textOf(details?.owner_name),
    mailingAddress: details ? mailingAddressOf(details) : undefined,
    roofAgeYears: numberOf(row.roof_age_years),
    roofAgeAnchor: textOf(row.roof_age_anchor),
    roofAgeConfidence: textOf(row.roof_age_confidence),
    dataset,
  });
}

export function leadFromPermit(row: Row, dataset: DatasetRef): NewLeadInput {
  return withoutEmpty({
    signal: LeadSignal.OpenPermit,
    propId: numberOf(row.prop_id),
    permitNumber: textOf(row.permit_number),
    address: textOf(row.address) ?? "",
    latitude: numberOf(row.latitude),
    longitude: numberOf(row.longitude),
    permitState: textOf(row.permit_state),
    yearsOpen: numberOf(row.years_open),
    contractorName: textOf(row.contractor_name),
    bbbRating: textOf(row.bbb_rating),
    dataset,
  });
}

export function leadFromHail(
  row: Row,
  details: Row | undefined,
  dataset: DatasetRef,
): NewLeadInput {
  return withoutEmpty({
    ...leadFromProperty(row, details, dataset),
    signal: LeadSignal.Hail,
    hailInches: numberOf(row.max_hail_inches),
    hailDate: textOf(row.last_hail_date),
  });
}

export function leadsFromTopLead(
  row: Row,
  details: Row | undefined,
  dataset: DatasetRef,
): NewLeadInput[] {
  const scored = (points: unknown) => (numberOf(points) ?? 0) > 0;
  const property = leadFromProperty(row, details, dataset);
  return [
    ...(scored(row.roof_points) ? [property] : []),
    ...(scored(row.permit_points)
      ? [{ ...property, signal: LeadSignal.OpenPermit, yearsOpen: numberOf(row.max_years_open) }]
      : []),
    ...(scored(row.hail_points) ? [leadFromHail(row, details, dataset)] : []),
  ];
}

export function withPropertyDetails(input: NewLeadInput, details: Row | undefined): NewLeadInput {
  if (!details) return input;
  return withoutEmpty({
    ...input,
    ownerName: input.ownerName ?? textOf(details.owner_name),
    mailingAddress: input.mailingAddress ?? mailingAddressOf(details),
    roofAgeYears: input.roofAgeYears ?? numberOf(details.roof_age_years),
    roofAgeAnchor: input.roofAgeAnchor ?? textOf(details.roof_age_anchor),
    roofAgeConfidence: input.roofAgeConfidence ?? textOf(details.roof_age_confidence),
    latitude: input.latitude ?? numberOf(details.latitude),
    longitude: input.longitude ?? numberOf(details.longitude),
  });
}

function mailingAddressOf(details: Row): string | undefined {
  const street = [
    ...MAILING_LINES.map((line) => textOf(details[line])),
    textOf(details.mailing_city),
  ].filter((part): part is string => part !== undefined);
  const region = [textOf(details.mailing_state), textOf(details.mailing_zip)]
    .filter(Boolean)
    .join(" ");
  const address = [...street, ...(region ? [region] : [])].join(", ");
  return address || undefined;
}

function textOf(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : undefined;
  return text ? text : undefined;
}

function numberOf(value: unknown): number | undefined {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : undefined;
}

function withoutEmpty<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T;
}
