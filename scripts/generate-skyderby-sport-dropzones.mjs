import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const SKYDERBY_PLACES_URL = "https://skyderby.io/places?locale=en";

const VERIFIED_DETAILS = new Map([
  [
    "40",
    {
      name: "Dropzone Prostějov",
      town: "Prostějov",
      state: "Olomouc Region",
      aliases: ["DZ Prostejov", "Skydive Prostejov", "Jump-Tandem"],
    },
  ],
  [
    "53",
    {
      name: "Skydive Paraclete XP",
      town: "Raeford",
      state: "North Carolina",
      aliases: ["DZ Paraclete XP", "Paraclete", "Raeford Skydiving"],
    },
  ],
]);

function decodeHtml(value) {
  const namedEntities = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };

  return value
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, code) => {
      if (code.startsWith("#x")) {
        return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
      }

      if (code.startsWith("#")) {
        return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
      }

      return namedEntities[code.toLowerCase()] ?? entity;
    })
    .replace(/\s+/g, " ")
    .trim();
}

function formatGeneratedFile(dropzones) {
  const rows = dropzones
    .map((dropzone) => `  ${JSON.stringify(dropzone)},`)
    .join("\n");

  return `// Generated from public Skyderby places marked data-kind=skydive.\n// See scripts/generate-skyderby-sport-dropzones.mjs.\n\nimport type { SportDropzone } from "./sportDropzones";\n\nexport const SKYDERBY_SPORT_DROPZONES: SportDropzone[] = [\n${rows}\n];\n`;
}

const response = await fetch(SKYDERBY_PLACES_URL, {
  headers: {
    Accept: "text/html",
    "User-Agent": "NumbersToFly/1.0",
  },
});

if (!response.ok) {
  throw new Error(`${response.status} ${response.statusText}`);
}

const html = await response.text();
const countryPattern =
  /<div class="places-country"[^>]*>\s*<div class="places-country-name">(?<country>.*?)<\/div>(?<places>.*?)<\/div>/gs;
const placePattern =
  /<a class="places__item"(?<attributes>[^>]*)data-kind="skydive"(?<remainingAttributes>[^>]*)>(?<name>.*?)<\/a>/gs;
const dropzones = [];

for (const countryMatch of html.matchAll(countryPattern)) {
  const country = decodeHtml(countryMatch.groups?.country ?? "");
  const placesHtml = countryMatch.groups?.places ?? "";

  for (const placeMatch of placesHtml.matchAll(placePattern)) {
    const attributes = `${placeMatch.groups?.attributes ?? ""} data-kind="skydive"${placeMatch.groups?.remainingAttributes ?? ""}`;
    const id = attributes.match(/data-id="(?<value>\d+)"/)?.groups?.value;
    const lat = Number(
      attributes.match(/data-lat="(?<value>[^"]+)"/)?.groups?.value,
    );
    const lon = Number(
      attributes.match(/data-lon="(?<value>[^"]+)"/)?.groups?.value,
    );
    const rawName = decodeHtml(placeMatch.groups?.name ?? "");

    if (
      !id ||
      !country ||
      !rawName ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      /\btandem\b/i.test(rawName)
    ) {
      continue;
    }

    const verifiedDetails = VERIFIED_DETAILS.get(id);
    const name =
      verifiedDetails?.name ?? rawName.replace(/^DZ\s+/i, "").trim();
    const aliases = [
      ...(verifiedDetails?.aliases ?? []),
      ...(name !== rawName ? [rawName] : []),
    ];

    dropzones.push({
      id: `skyderby-${id}`,
      name,
      ...(aliases.length > 0 ? { aliases: [...new Set(aliases)] } : {}),
      town: verifiedDetails?.town ?? "",
      ...(verifiedDetails?.state ? { state: verifiedDetails.state } : {}),
      country,
      lat: Number(lat.toFixed(7)),
      lon: Number(lon.toFixed(7)),
    });
  }
}

dropzones.sort(
  (left, right) =>
    left.country.localeCompare(right.country) ||
    left.name.localeCompare(right.name),
);

const outputPath = fileURLToPath(
  new URL("../src/skyderbySportDropzones.generated.ts", import.meta.url),
);

await writeFile(outputPath, formatGeneratedFile(dropzones), "utf8");
console.log(
  `Generated ${dropzones.length} Skyderby sport drop zones after exclusions.`,
);
