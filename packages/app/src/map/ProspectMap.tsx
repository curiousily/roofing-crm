import "maplibre-gl/dist/maplibre-gl.css";
import type { Feature, FeatureCollection } from "geojson";
import {
  type GeoJSONSource,
  Map as MapLibreMap,
  type MapMouseEvent,
  NavigationControl,
  setWorkerUrl,
} from "maplibre-gl";
import mapWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { useEffect, useRef } from "react";
import { TRAVIS_COUNTY_RING } from "./travis-county.js";

setWorkerUrl(mapWorkerUrl);

export enum CandidateKind {
  AgedRoof = "aged_roof",
  OpenPermit = "open_permit",
}

export interface MapCandidate {
  kind: CandidateKind;
  index: number;
  latitude: number;
  longitude: number;
  saved: boolean;
}

export interface MapDensityCell {
  kind: CandidateKind;
  latitude: number;
  longitude: number;
  matches: number;
}

export interface MapCenter {
  latitude: number;
  longitude: number;
}

export interface Selection {
  kind: CandidateKind;
  index: number;
}

const STYLE_URL = "https://tiles.openfreemap.org/styles/positron";
const CIRCLE_STEPS = 72;
const MILES_PER_DEGREE = 69;
const FIT_PADDING = 48;
const FULL_TURN = 2 * Math.PI;
const COLORS = {
  agedRoof: "#e8590c",
  openPermit: "#7048e8",
  saved: "#2b8a3e",
  radius: "#1c7ed6",
  county: "#495057",
};
const NOTHING_SELECTED = "";
const DENSITY_COLORS: [CandidateKind, string][] = [
  [CandidateKind.AgedRoof, "232, 89, 12"],
  [CandidateKind.OpenPermit, "112, 72, 232"],
];

enum Layer {
  County = "county",
  Density = "density",
  RadiusFill = "radius-fill",
  RadiusLine = "radius-line",
  Candidates = "candidates",
  Selected = "selected",
  Center = "center",
}

enum Source {
  County = "county",
  Density = "density",
  Radius = "radius",
  Candidates = "candidates",
  Center = "center",
}

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };
const COUNTY: Feature = {
  type: "Feature",
  properties: {},
  geometry: { type: "LineString", coordinates: TRAVIS_COUNTY_RING },
};

const keyOf = ({ kind, index }: Selection) => `${kind}:${index}`;

export function ProspectMap({
  center,
  radiusMiles,
  candidates,
  density,
  selected,
  onPick,
  onSelect,
}: {
  center: MapCenter;
  radiusMiles: number;
  candidates: MapCandidate[];
  density: MapDensityCell[];
  selected: Selection | undefined;
  onPick: (center: MapCenter) => void;
  onSelect: (selection: Selection) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | undefined>(undefined);
  const ready = useRef(false);
  const handlers = useRef({ onPick, onSelect });
  handlers.current = { onPick, onSelect };
  const latest = useRef({ center, radiusMiles, candidates, density, selected });
  latest.current = { center, radiusMiles, candidates, density, selected };

  useEffect(() => {
    if (!container.current) return;
    const instance = new MapLibreMap({
      container: container.current,
      style: STYLE_URL,
      bounds: countyBounds(),
      fitBoundsOptions: { padding: FIT_PADDING },
    });
    instance.addControl(new NavigationControl({ showCompass: false }), "top-right");
    instance.on("load", () => {
      instance.addSource(Source.County, { type: "geojson", data: COUNTY });
      instance.addSource(Source.Radius, { type: "geojson", data: EMPTY });
      instance.addSource(Source.Density, { type: "geojson", data: EMPTY });
      instance.addSource(Source.Candidates, { type: "geojson", data: EMPTY });
      instance.addSource(Source.Center, { type: "geojson", data: EMPTY });
      instance.addLayer({
        id: Layer.County,
        type: "line",
        source: Source.County,
        paint: { "line-color": COLORS.county, "line-width": 2, "line-opacity": 0.7 },
      });
      instance.addLayer({
        id: Layer.RadiusFill,
        type: "fill",
        source: Source.Radius,
        paint: { "fill-color": COLORS.radius, "fill-opacity": 0.06 },
      });
      instance.addLayer({
        id: Layer.RadiusLine,
        type: "line",
        source: Source.Radius,
        paint: { "line-color": COLORS.radius, "line-width": 2, "line-dasharray": [2, 2] },
      });
      for (const [kind, color] of DENSITY_COLORS) {
        instance.addLayer({
          id: `${Layer.Density}-${kind}`,
          type: "heatmap",
          source: Source.Density,
          filter: ["==", ["get", "kind"], kind],
          paint: {
            "heatmap-weight": ["min", 1, ["/", ["ln", ["+", 1, ["get", "matches"]]], 4]],
            "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 8, 4, 11, 12, 14, 28],
            "heatmap-intensity": 0.7,
            "heatmap-opacity": 0.55,
            "heatmap-color": [
              "interpolate",
              ["linear"],
              ["heatmap-density"],
              0,
              `rgba(${color}, 0)`,
              0.3,
              `rgba(${color}, 0.3)`,
              1,
              `rgba(${color}, 0.75)`,
            ],
          },
        });
      }
      instance.addLayer({
        id: Layer.Candidates,
        type: "circle",
        source: Source.Candidates,
        paint: {
          "circle-radius": 5,
          "circle-color": [
            "match",
            ["get", "kind"],
            CandidateKind.OpenPermit,
            COLORS.openPermit,
            COLORS.agedRoof,
          ],
          "circle-stroke-color": ["case", ["get", "saved"], COLORS.saved, "#ffffff"],
          "circle-stroke-width": ["case", ["get", "saved"], 3, 1],
          "circle-opacity": 0.9,
        },
      });
      instance.addLayer({
        id: Layer.Selected,
        type: "circle",
        source: Source.Candidates,
        filter: ["==", ["get", "key"], NOTHING_SELECTED],
        paint: {
          "circle-radius": 10,
          "circle-color": "rgba(0,0,0,0)",
          "circle-stroke-color": "#111",
          "circle-stroke-width": 3,
        },
      });
      instance.addLayer({
        id: Layer.Center,
        type: "circle",
        source: Source.Center,
        paint: {
          "circle-radius": 7,
          "circle-color": "#111",
          "circle-stroke-color": "#fff",
          "circle-stroke-width": 3,
        },
      });
      ready.current = true;
      draw(instance, latest.current);
    });
    instance.on("click", (event: MapMouseEvent) => {
      const [hit] = instance.queryRenderedFeatures(event.point, { layers: [Layer.Candidates] });
      const kind = hit?.properties?.kind as CandidateKind | undefined;
      const index = hit?.properties?.index;
      if (kind && typeof index === "number") handlers.current.onSelect({ kind, index });
      else handlers.current.onPick({ latitude: event.lngLat.lat, longitude: event.lngLat.lng });
    });
    instance.on("mouseenter", Layer.Candidates, () => {
      instance.getCanvas().style.cursor = "pointer";
    });
    instance.on("mouseleave", Layer.Candidates, () => {
      instance.getCanvas().style.cursor = "";
    });
    map.current = instance;
    return () => instance.remove();
  }, []);

  useEffect(() => {
    if (map.current && ready.current)
      draw(map.current, { center, radiusMiles, candidates, density, selected });
  }, [center, radiusMiles, candidates, density, selected]);

  useEffect(() => {
    if (map.current && ready.current) fit(map.current, center, radiusMiles);
  }, [center, radiusMiles]);

  return <div ref={container} className="map" data-testid="prospect-map" />;
}

function draw(
  instance: MapLibreMap,
  {
    center,
    radiusMiles,
    candidates,
    density,
    selected,
  }: {
    center: MapCenter;
    radiusMiles: number;
    candidates: MapCandidate[];
    density: MapDensityCell[];
    selected: Selection | undefined;
  },
) {
  (instance.getSource(Source.Radius) as GeoJSONSource).setData(circle(center, radiusMiles));
  (instance.getSource(Source.Center) as GeoJSONSource).setData({
    type: "Feature",
    properties: {},
    geometry: { type: "Point", coordinates: [center.longitude, center.latitude] },
  });
  (instance.getSource(Source.Density) as GeoJSONSource).setData({
    type: "FeatureCollection",
    features: density.map((cell) => ({
      type: "Feature",
      properties: { kind: cell.kind, matches: cell.matches },
      geometry: { type: "Point", coordinates: [cell.longitude, cell.latitude] },
    })),
  });
  (instance.getSource(Source.Candidates) as GeoJSONSource).setData({
    type: "FeatureCollection",
    features: candidates.map((candidate) => ({
      type: "Feature",
      properties: {
        kind: candidate.kind,
        index: candidate.index,
        saved: candidate.saved,
        key: keyOf(candidate),
      },
      geometry: { type: "Point", coordinates: [candidate.longitude, candidate.latitude] },
    })),
  });
  instance.setFilter(Layer.Selected, [
    "==",
    ["get", "key"],
    selected ? keyOf(selected) : NOTHING_SELECTED,
  ]);
}

function fit(instance: MapLibreMap, center: MapCenter, radiusMiles: number) {
  const latitudeSpan = radiusMiles / MILES_PER_DEGREE;
  const longitudeSpan = latitudeSpan / Math.cos((center.latitude * Math.PI) / 180);
  instance.fitBounds(
    [
      [center.longitude - longitudeSpan, center.latitude - latitudeSpan],
      [center.longitude + longitudeSpan, center.latitude + latitudeSpan],
    ],
    { padding: FIT_PADDING, duration: 600 },
  );
}

function countyBounds(): [[number, number], [number, number]] {
  const longitudes = TRAVIS_COUNTY_RING.map(([longitude]) => longitude);
  const latitudes = TRAVIS_COUNTY_RING.map(([, latitude]) => latitude);
  return [
    [Math.min(...longitudes), Math.min(...latitudes)],
    [Math.max(...longitudes), Math.max(...latitudes)],
  ];
}

function circle(center: MapCenter, radiusMiles: number): Feature {
  const latitudeSpan = radiusMiles / MILES_PER_DEGREE;
  const longitudeSpan = latitudeSpan / Math.cos((center.latitude * Math.PI) / 180);
  const ring = Array.from({ length: CIRCLE_STEPS + 1 }, (_, step) => {
    const angle = (step / CIRCLE_STEPS) * FULL_TURN;
    return [
      center.longitude + longitudeSpan * Math.cos(angle),
      center.latitude + latitudeSpan * Math.sin(angle),
    ];
  });
  return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } };
}
