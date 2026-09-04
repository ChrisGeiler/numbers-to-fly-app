import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const OVERPASS_ENDPOINTS = [
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass-api.de/api/interpreter",
];

const COUNTRY_BOUNDARIES_URL =
  "https://raw.githubusercontent.com/datasets/geo-countries/main/data/countries.geojson";
const POPULATED_PLACES_URL =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_populated_places.geojson";

const query = `[out:json][timeout:240];
  nwr["sport"~"^(parachuting|skydiving)$"][!"disused"][!"abandoned"];
  out center tags;`;

const EXCLUDED_LOCATION_NAMES = new Set([
  "abeille parachutisme",
  "2 dive",
  "accuracy",
  "aerotrom free fly",
  "dreamfly",
  "freezone",
  "ifly brasilia",
  "ifly brasília",
  "nzone skydive",
  "parachute ascentionnel",
  "phoenix skydive center",
  "pond-fallschirmsport",
  "riggerloftet",
  "riggerværkstedet",
  "sítechnika műanyag sípálya",
  "skydive greater siquijor",
  "skydive key west",
  "skydive moab",
  "skydive surfers paradise",
  "turnul de parașutism",
  "vacuum",
  "سكاي دايف دبي",
  "аэротруба free fly",
  "락하산기술보급소",
]);

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "NumbersToFly/1.0",
      ...options.headers,
    },
    ...options,
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function fetchOpenStreetMapDropzones() {
  const encodedQuery = encodeURIComponent(query);
  let lastError = null;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      return await fetchJson(`${endpoint}?data=${encodedQuery}`);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error("No Overpass endpoint was available.");
}

function pointInRing(lon, lat, ring) {
  let inside = false;

  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [currentLon, currentLat] = ring[index];
    const [previousLon, previousLat] = ring[previous];
    const crossesLatitude = currentLat > lat !== previousLat > lat;

    if (
      crossesLatitude &&
      lon <
        ((previousLon - currentLon) * (lat - currentLat)) /
          (previousLat - currentLat) +
          currentLon
    ) {
      inside = !inside;
    }
  }

  return inside;
}

function pointInPolygon(lon, lat, polygon) {
  if (!pointInRing(lon, lat, polygon[0])) {
    return false;
  }

  return !polygon.slice(1).some((hole) => pointInRing(lon, lat, hole));
}

function featureContainsPoint(feature, lon, lat) {
  const { geometry } = feature;

  if (geometry.type === "Polygon") {
    return pointInPolygon(lon, lat, geometry.coordinates);
  }

  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.some((polygon) =>
      pointInPolygon(lon, lat, polygon),
    );
  }

  return false;
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function slugify(value) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function getCountry(boundaries, lon, lat) {
  const feature = boundaries.features.find((candidate) =>
    featureContainsPoint(candidate, lon, lat),
  );

  return cleanText(feature?.properties?.name) || "Other";
}

function isUsefulSportLocation(name) {
  const normalized = name.toLowerCase();

  if (
    /tandem|\bindoor\b|\bwind tunnel\b|\blanding\b|paragliding|parapente|yamaç paraşütü|packplatz|zielkreis|\brigger/.test(
      normalized,
    ) ||
    EXCLUDED_LOCATION_NAMES.has(normalized)
  ) {
    return false;
  }

  return ![
    "drop zone",
    "dropzone",
    "landing zone",
    "parachute landing area",
    "parachute landing zone",
  ].includes(normalized);
}

function distanceKm(firstLat, firstLon, secondLat, secondLon) {
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const earthRadiusKm = 6371;
  const latDelta = toRadians(secondLat - firstLat);
  const lonDelta = toRadians(secondLon - firstLon);
  const a =
    Math.sin(latDelta / 2) ** 2 +
    Math.cos(toRadians(firstLat)) *
      Math.cos(toRadians(secondLat)) *
      Math.sin(lonDelta / 2) ** 2;

  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getNearestPlace(populatedPlaces, lon, lat) {
  let nearest = null;
  let nearestDistanceKm = Number.POSITIVE_INFINITY;

  for (const feature of populatedPlaces.features) {
    const placeLon = Number(feature.properties?.LONGITUDE);
    const placeLat = Number(feature.properties?.LATITUDE);

    if (!Number.isFinite(placeLat) || !Number.isFinite(placeLon)) {
      continue;
    }

    const nextDistanceKm = distanceKm(lat, lon, placeLat, placeLon);

    if (nextDistanceKm < nearestDistanceKm) {
      nearest = feature;
      nearestDistanceKm = nextDistanceKm;
    }
  }

  return { feature: nearest, distanceKm: nearestDistanceKm };
}

function normalizeCountryName(country) {
  if (country === "United States of America") {
    return "United States";
  }

  if (country === "Czechia") {
    return "Czech Republic";
  }

  return country;
}

function getCoordinates(element) {
  const lat = element.lat ?? element.center?.lat;
  const lon = element.lon ?? element.center?.lon;

  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

function getTown(tags) {
  return (
    cleanText(tags["addr:city"]) ||
    cleanText(tags["addr:town"]) ||
    cleanText(tags["addr:village"]) ||
    cleanText(tags["addr:place"]) ||
    cleanText(tags["is_in:city"]) ||
    cleanText(tags["is_in:town"])
  );
}

function formatGeneratedFile(dropzones) {
  const rows = dropzones
    .map(
      (dropzone) => `  ${JSON.stringify(dropzone)},`,
    )
    .join("\n");

  return `// Generated from OpenStreetMap features tagged sport=parachuting.\n// See scripts/generate-world-sport-dropzones.mjs.\n\nexport const WORLDWIDE_SPORT_DROPZONES = [\n${rows}\n] as const;\n`;
}

const [osmData, boundaries, populatedPlaces] = await Promise.all([
  fetchOpenStreetMapDropzones(),
  fetchJson(COUNTRY_BOUNDARIES_URL),
  fetchJson(POPULATED_PLACES_URL),
]);

const seen = new Set();
const dropzones = [];

for (const element of osmData.elements) {
  const name = cleanText(element.tags?.name);
  const coordinates = getCoordinates(element);

  if (!name || !coordinates || !isUsefulSportLocation(name)) {
    continue;
  }

  const nearestPlace = getNearestPlace(
    populatedPlaces,
    coordinates.lon,
    coordinates.lat,
  );
  const boundaryCountry = getCountry(
    boundaries,
    coordinates.lon,
    coordinates.lat,
  );
  const nearestCountry = cleanText(nearestPlace.feature?.properties?.ADM0NAME);
  const country = normalizeCountryName(
    boundaryCountry === "Other" && nearestPlace.distanceKm <= 120
      ? nearestCountry || boundaryCountry
      : boundaryCountry,
  );

  if (country === "Australia") {
    continue;
  }

  const dedupeKey = `${country}:${slugify(name)}`;

  if (seen.has(dedupeKey)) {
    continue;
  }

  seen.add(dedupeKey);
  const mappedTown = getTown(element.tags ?? {});
  const nearestTown = cleanText(nearestPlace.feature?.properties?.NAME);

  dropzones.push({
    id: `osm-${element.type}-${element.id}`,
    name,
    town:
      mappedTown ||
      (nearestPlace.distanceKm <= 80 ? nearestTown : ""),
    country,
    lat: Number(coordinates.lat.toFixed(6)),
    lon: Number(coordinates.lon.toFixed(6)),
  });
}

dropzones.sort(
  (left, right) =>
    left.country.localeCompare(right.country) ||
    left.name.localeCompare(right.name),
);

const outputPath = fileURLToPath(
  new URL("../src/worldwideSportDropzones.generated.ts", import.meta.url),
);

await writeFile(outputPath, formatGeneratedFile(dropzones), "utf8");
console.log(`Generated ${dropzones.length} worldwide sport drop zones.`);
