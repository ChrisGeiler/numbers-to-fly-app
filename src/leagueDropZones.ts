export type DropZoneReference = {
  name: string;
  site: string;
  metres: number | null;
  basis: string;
  note: string;
  source: string;
  url: string;
};

// Source figures remain in their published units. Do not substitute an airport,
// weather-station or town elevation for a parachute landing-area elevation.
export const dropZoneReferences: DropZoneReference[] = [
  {
    name: "ADELAIDE SKYDIVING CENTRE", site: "Lower Light DZ", metres: 17,
    basis: "Skyderby place elevation - checked 11 Nov 2026",
    note: "Published MSL elevation for this Skyderby DZ place record. Confirm that the record matches the landing area used for the jump.",
    source: "Skyderby - Lower Light DZ",
    url: "https://skyderby.io/places/451",
  },
  {
    name: "AIRLIE BEACH SKYDIVERS", site: "Laguna Quays / Midge Point", metres: null,
    basis: "Landing site confirmation needed",
    note: "APF lists Laguna Quays; its DZ directory identifies Midge Point Beach and Laguna Quays. Do not use Whitsunday Airport elevation: that belongs to a different operator/site.",
    source: "APF — Airlie Beach Skydivers",
    url: "https://www.apf.com.au/dealerlocator/locatorDetailsPage.aspx?back=1&storeID=315",
  },
  {
    name: "COASTAL SKYDIVE SA", site: "Semaphore Beach / Aldinga Bay", metres: null,
    basis: "Multiple landing sites · confirmation needed",
    note: "The operator lists separate beach landing sites. Confirm the actual landing point; neither the departure airport nor an assumed zero metres establishes its elevation.",
    source: "Coastal Skydive — locations",
    url: "https://coastalskydive.com.au/about/locations/",
  },
  {
    name: "COMMANDO SKYDIVERS INCORPORATED", site: "Commando DZ", metres: 45,
    basis: "Skyderby place elevation - checked 11 Nov 2026",
    note: "Published MSL elevation for this Skyderby DZ place record. Confirm that the record matches the landing area used for the jump.",
    source: "Skyderby - Commando DZ",
    url: "https://skyderby.io/places/479",
  },
  {
    name: "FAR NORTH FREEFALL CLUB INC.", site: "Tully DZ", metres: 20,
    basis: "Skyderby place elevation - checked 11 Nov 2026",
    note: "Published MSL elevation for this Skyderby DZ place record. Confirm that the record matches the landing area used for the jump.",
    source: "Skyderby - Tully DZ",
    url: "https://skyderby.io/places/555",
  },
  {
    name: "HILLMAN FARM SKYDIVERS", site: "Hillman Farm DZ", metres: 258,
    basis: "Skyderby place elevation - checked 11 Nov 2026",
    note: "Published MSL elevation for this Skyderby DZ place record. Confirm that the record matches the landing area used for the jump.",
    source: "Skyderby - Hillman Farm DZ",
    url: "https://skyderby.io/places/500",
  },
  {
    name: "NEWCASTLE SPORT PARACHUTE CLUB", site: "Elderslie DZ", metres: 34,
    basis: "Skyderby place elevation - checked 11 Nov 2026",
    note: "Published MSL elevation for this Skyderby DZ place record. Confirm that the record matches the landing area used for the jump.",
    source: "Skyderby - Elderslie DZ",
    url: "https://skyderby.io/places/680",
  },
  {
    name: "RAMBLERS PARACHUTE CENTRE", site: "Ramblers, Toogoolawah", metres: 94,
    basis: "Skyderby place elevation - checked 11 Nov 2026",
    note: "Published MSL elevation for this Skyderby DZ place record. Confirm that the record matches the landing area used for the jump.",
    source: "Skyderby - Ramblers, Toogoolawah",
    url: "https://skyderby.io/places/159",
  },
  {
    name: "SA SKYDIVING OPS", site: "Langhorne Creek DZ", metres: 6,
    basis: "Skyderby place elevation - checked 11 Nov 2026",
    note: "Published MSL elevation for this Skyderby DZ place record. Confirm that the record matches the landing area used for the jump.",
    source: "Skyderby - Langhorne Creek DZ",
    url: "https://skyderby.io/places/554",
  },
  {
    name: "SKYDIVE BYRON BAY", site: "Byron Bay / Tyagarah DZ", metres: 7,
    basis: "Skyderby place elevation - checked 11 Nov 2026",
    note: "Published MSL elevation for this Skyderby DZ place record. Confirm that the record matches the landing area used for the jump.",
    source: "Skyderby - Byron Bay / Tyagarah DZ",
    url: "https://skyderby.io/places/597",
  },
  {
    name: "SKYDIVE GREAT OCEAN ROAD", site: "Barwon Heads DZ", metres: 15,
    basis: "Skyderby place elevation - checked 11 Nov 2026",
    note: "Published MSL elevation for this Skyderby DZ place record. Confirm that the record matches the landing area used for the jump.",
    source: "Skyderby - Barwon Heads DZ",
    url: "https://skyderby.io/places/634",
  },
  {
    name: "SKYDIVE JURIEN BAY", site: "Jurien Bay DZ", metres: 3,
    basis: "Skyderby place elevation - checked 11 Nov 2026",
    note: "Published MSL elevation for this Skyderby DZ place record. Confirm that the record matches the landing area used for the jump.",
    source: "Skyderby - Jurien Bay DZ",
    url: "https://skyderby.io/places/355",
  },
  {
    name: "Moruya", site: "Moruya (Skyderby: DZ Skydive Oz)", metres: 5,
    basis: "Skyderby place elevation - checked 11 Nov 2026",
    note: "Published MSL elevation for this Skyderby DZ place record. Confirm that the record matches the landing area used for the jump.",
    source: "Skyderby - Moruya (Skyderby: DZ Skydive Oz)",
    url: "https://skyderby.io/places/337",
  },
  {
    name: "TORQUAY SKYDIVERS", site: "Torquay DZ", metres: 9,
    basis: "Skyderby place elevation - checked 11 Nov 2026",
    note: "Published MSL elevation for this Skyderby DZ place record. Confirm that the record matches the landing area used for the jump.",
    source: "Skyderby - Torquay DZ",
    url: "https://skyderby.io/places/205",
  },
  {
    name: "DARWIN PARACHUTE CLUB", site: "Batchelor Airfield", metres: null,
    basis: "DZ elevation not verified",
    note: "APF identifies Batchelor as the club's site. No primary-source DZ target elevation established; the airport weather station elevation is not the landing-area elevation.",
    source: "APF — DZ directory, ASM 110",
    url: "https://www.apf.com.au/ArticleDocuments/1477/ASM%20110.pdf.aspx?EMBED=Y",
  },
];

export function elevationReference(reference: DropZoneReference): string {
  return reference.metres === null
    ? "Not verified - enter the confirmed DZ elevation manually"
    : `${reference.metres.toFixed(1)} m`;
}
