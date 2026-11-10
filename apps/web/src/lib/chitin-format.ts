const WAD = BigInt('1000000000000000000'); // 1e18
const BI_0 = BigInt(0);
const BI_2 = BigInt(2);
const BI_100 = BigInt(100);

export function formatChitinWei(wei: string): string {
  try {
    const v = BigInt(wei);
    const whole = v / WAD;
    const frac = v % WAD;
    if (frac === BigInt(0)) return String(whole);
    let fracStr = frac.toString().padStart(18, '0');
    fracStr = fracStr.replace(/0+$/, '');
    return `${whole}.${fracStr}`;
  } catch {
    return wei;
  }
}

export function formatChitinWeiCapped(wei: string, maxFracDigits: number): string {
  const raw = formatChitinWei(wei);
  const [whole, frac] = raw.split('.');
  if (!frac) return raw;
  const capped = frac.slice(0, Math.max(0, maxFracDigits));
  const trimmed = capped.replace(/0+$/, '');
  const finalFrac = trimmed.length ? trimmed : '0';
  return `${whole}.${finalFrac}`;
}

function stripTrailingZeros(v: string): string {
  if (!v.includes('.')) return v;
  return v.replace(/\.?0+$/, '');
}

function formatCompactFromWei(wei: bigint): string {
  // Format for large values using K/M/B/T suffixes with rounding.
  // Example: 12420 -> 12.42K, 32530000 -> 32.53M
  const units: Array<{ suffix: string; div: bigint }> = [
    { suffix: 'T', div: BigInt('1000000000000') },
    { suffix: 'B', div: BigInt('1000000000') },
    { suffix: 'M', div: BigInt('1000000') },
    { suffix: 'K', div: BigInt('1000') }
  ];

  const wholeChitin = wei / WAD;
  for (const u of units) {
    if (wholeChitin < u.div) continue;
    const divWei = u.div * WAD;
    const scaled100 = (wei * BI_100 + divWei / BI_2) / divWei; // rounded to 2 decimals
    const ip = scaled100 / BI_100;
    const fp = (scaled100 % BI_100).toString().padStart(2, '0');
    return stripTrailingZeros(`${ip}.${fp}${u.suffix}`);
  }
  return stripTrailingZeros(formatChitinWeiCapped(wei.toString(), 4));
}

export function formatChitinWeiUi(wei: string): string {
  try {
    const v = BigInt(wei);
    const abs = v < BI_0 ? -v : v;
    if (abs >= BigInt('1000') * WAD) return (v < BI_0 ? '-' : '') + formatCompactFromWei(abs);
    // Keep smaller values readable; cap fractional digits so we don't render long tails.
    return formatChitinWeiCapped(v.toString(), abs < WAD ? 4 : 2);
  } catch {
    return wei;
  }
}
