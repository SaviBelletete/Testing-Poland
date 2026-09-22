/**
 * Quick smoke test for normaliseCountry logic (mirrors the TS implementation).
 * Run: node scripts/test-normalise.mjs
 */

const COUNTRY_ALIASES = {
  uk: ["uk", "gb", "united kingdom", "great britain", "england", "uk bacs"],
  france: ["france", "fr"],
  germany: ["germany", "de", "deutschland"],
  spain: ["spain", "es", "españa"],
  belgium: ["belgium", "be", "belgique", "belgium nl", "belgium fr", "belgium-nl", "belgium-fr", "be nl", "be fr", "belgië"],
  italy: ["italy", "it", "italia"],
  portugal: ["portugal", "pt"],
  austria: ["austria", "at", "österreich"],
  "south africa": ["south africa", "za", "southafrica", "south_africa"],
  egypt: ["egypt", "eg"],
  turkey: ["turkey", "tr", "türkiye", "turkiye"],
  greece: ["greece", "gr"],
  sweden: ["sweden", "se"],
  switzerland: ["switzerland", "ch", "schweiz"],
  norway: ["norway", "no"],
  ireland: ["ireland", "ie"],
  cyprus: ["cyprus", "cy"],
  netherlands: ["netherlands", "nl", "holland", "the netherlands"],
  luxembourg: ["luxembourg", "lu", "luxemburg"],
  poland: ["poland", "pl"],
};

function normaliseCountry(name) {
  const lower = name.toLowerCase().trim();
  for (const [canonical, aliases] of Object.entries(COUNTRY_ALIASES)) {
    if (aliases.includes(lower)) return canonical;
  }
  for (const canonical of Object.keys(COUNTRY_ALIASES)) {
    if (lower.startsWith(canonical + " ") || lower.startsWith(canonical + "-") || lower.startsWith(canonical + "_")) {
      return canonical;
    }
  }
  for (const canonical of Object.keys(COUNTRY_ALIASES)) {
    if (lower.includes(canonical)) return canonical;
  }
  return lower;
}

const cases = [
  [" UK", "uk"],
  ["UK", "uk"],
  [" France", "france"],
  ["Belgium NL", "belgium"],
  [" Italy", "italy"],
  [" Spain", "spain"],
  ["South Africa", "south africa"],
  ["Germany", "germany"],
  ["Turkey", "turkey"],
  ["Luxemburg", "luxembourg"],
  ["Belgium FR", "belgium"],
  ["Netherlands", "netherlands"],
];

let passed = 0, failed = 0;
for (const [input, expected] of cases) {
  const result = normaliseCountry(input);
  const ok = result === expected;
  console.log(`${ok ? "✓" : "✗"} normaliseCountry("${input}") = "${result}" ${ok ? "" : `(expected "${expected}")`}`);
  if (ok) passed++; else failed++;
}
console.log(`\n${passed} passed, ${failed} failed`);
