import { writeFile } from "node:fs/promises";
import countries from "world-countries";

const coordinates = Object.fromEntries(
  countries
    .filter(
      (country) =>
        /^[A-Z]{2}$/.test(country.cca2) &&
        Array.isArray(country.latlng) &&
        country.latlng.length === 2 &&
        country.latlng.every(Number.isFinite),
    )
    .map((country) => [
      country.cca2,
      country.latlng.map((value) => Number(value.toFixed(5))),
    ])
    .sort(([codeA], [codeB]) => codeA.localeCompare(codeB)),
);

const output = `// Generated from world-countries 5.1.0 (ODbL-1.0).\n// Run: node scripts/generate-roam-country-coordinates.mjs\nexport const COUNTRY_COORDINATES = Object.freeze(${JSON.stringify(
  coordinates,
  null,
  2,
)});\n`;

await writeFile(new URL("../src/data/countryCoordinates.js", import.meta.url), output);
