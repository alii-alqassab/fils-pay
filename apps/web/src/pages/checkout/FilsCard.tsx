import type { SimulatedCardInput } from "../../types.js";

type Props = {
  card: SimulatedCardInput;
  brand: string | null;
  flipped: boolean;
};

// Group digits in fours, padding with bullets so the plate never looks empty.
function displayPan(pan: string): string {
  const digits = pan.replace(/\D/g, "").slice(0, 16);
  return digits.padEnd(16, "•").replace(/(.{4})(?=.)/g, "$1 ");
}

function displayExpiry(month: number, year: number): string {
  const mm = Number.isFinite(month) && month >= 1 && month <= 12 ? String(month).padStart(2, "0") : "••";
  const yy = Number.isFinite(year) ? String(year).slice(-2) : "••";
  return `${mm}/${yy}`;
}

const LINKS = 18;

/** Shared gold ring: gradient body plus a reeded edge, like the milled rim of the coin. */
function Rim() {
  return (
    <>
      <circle cx="100" cy="100" r="98" className="fils-gold" />
      <circle cx="100" cy="100" r="96" className="fils-reeding" />
      <circle cx="100" cy="100" r="97.5" className="fils-outline" />
    </>
  );
}

function Shield({ cvv }: { cvv: string }) {
  return (
    <svg className="fils-coin-svg" viewBox="0 0 200 200" aria-hidden="true">
      <defs>
        <path id="fils-arc-bottom" d="M 31 100 A 69 69 0 0 0 169 100" />
        <path id="fils-arc-top" d="M 31 100 A 69 69 0 0 1 169 100" />
      </defs>
      <Rim />
      <g className="fils-ring-text">
        <text textAnchor="middle" fontSize="13" letterSpacing="2.2">
          <textPath href="#fils-arc-bottom" startOffset="50%">STATE OF BAHRAIN</textPath>
        </text>
        <text textAnchor="middle" fontSize="15" lang="ar">
          <textPath href="#fils-arc-top" startOffset="50%">دولة البحرين</textPath>
        </text>
        <text x="21" y="104" textAnchor="middle" fontSize="8" transform="rotate(-90 21 100)">1420</text>
        <text x="179" y="104" textAnchor="middle" fontSize="8" transform="rotate(90 179 100)">2000</text>
      </g>
      <circle cx="100" cy="100" r="64" className="fils-silver" />
      <circle cx="100" cy="100" r="64" className="fils-disc-edge" />
      {/* laurel sprigs */}
      <g className="fils-laurel">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <g key={i}>
            <ellipse cx={66 + i * 1.6} cy={118 - i * 9} rx="7" ry="2.6" transform={`rotate(${-35 - i * 8} ${66 + i * 1.6} ${118 - i * 9})`} />
            <ellipse cx={134 - i * 1.6} cy={118 - i * 9} rx="7" ry="2.6" transform={`rotate(${35 + i * 8} ${134 - i * 1.6} ${118 - i * 9})`} />
          </g>
        ))}
      </g>
      {/* shield with three zig-zag peaks */}
      <path className="fils-shield" d="M78 70h44v34c0 14-12 24-22 29-10-5-22-15-22-29Z" />
      <path className="fils-peaks" d="M78 70h44v18l-7.3-12-7.4 12-7.3-12-7.4 12-7.3-12-7.3 12Z" />
      <text x="100" y="152" textAnchor="middle" className="fils-cvv">
        {cvv ? cvv.replace(/./g, "•") : "•••"}
      </text>
      <text x="100" y="159" textAnchor="middle" className="fils-cvv-label">SECURITY CODE</text>
    </svg>
  );
}

function Hundred() {
  const links = Array.from({ length: LINKS }, (_, i) => (360 / LINKS) * i);
  return (
    <svg className="fils-coin-svg" viewBox="0 0 200 200" aria-hidden="true">
      <defs>
        <clipPath id="fils-disc-clip"><circle cx="100" cy="100" r="64" /></clipPath>
      </defs>
      <Rim />
      {/* interlocking chain-link ring: hexagonal links, alternately nudged in/out, with a diamond at each joint */}
      <g className="fils-chain">
        {links.map((deg, i) => (
          <g key={deg} transform={`rotate(${deg} 100 100)`}>
            <path className="fils-link-a" transform={`translate(0 ${i % 2 ? 1.6 : -1.6})`} d="M83 18.5L91 10.5H109L117 18.5L109 26.5H91Z" />
            <path className="fils-link-b" transform={`translate(0 ${i % 2 ? 1.6 : -1.6})`} d="M87 18.5L93 13H107L113 18.5L107 24H93Z" />
            <path className="fils-joint" transform={`rotate(${360 / LINKS / 2} 100 100)`} d="M100 14.5L104 18.5L100 22.5L96 18.5Z" />
          </g>
        ))}
      </g>
      <circle cx="100" cy="100" r="64" className="fils-silver" />
      <circle cx="100" cy="100" r="64" className="fils-disc-edge" />
      <text x="100" y="141" textAnchor="middle" className="fils-100" clipPath="url(#fils-disc-clip)" textLength="100" lengthAdjust="spacingAndGlyphs">100</text>
      <rect x="40" y="91" width="120" height="28" rx="1.5" className="fils-plaque" />
      <text x="100" y="112" textAnchor="middle" className="fils-fils" lang="ar" direction="rtl">فلس</text>
    </svg>
  );
}

export function FilsCard({ card, brand, flipped }: Props) {
  const showBrand = brand && brand !== "unknown" ? brand : null;
  return (
    <div className="fils-card-scene" aria-hidden="true">
      <div className="fils-coin-wrap">
        <div className={`fils-coin${flipped ? " is-flipped" : ""}`}>
          <div className="fils-coin-face">
            <Hundred />
            <span className="fils-coin-shine" />
          </div>
          <div className="fils-coin-face fils-coin-back">
            <Shield cvv={card.cvv} />
            <span className="fils-coin-shine" />
          </div>
        </div>
        <span className="fils-coin-shadow" />
      </div>
      <div className="fils-plate">
        <span className="fils-plate-pan">{displayPan(card.pan)}</span>
        <span className="fils-plate-row">
          <span>{displayExpiry(card.expiryMonth, card.expiryYear)}</span>
          <span>{showBrand ?? "FilsPay"}</span>
        </span>
      </div>
    </div>
  );
}
