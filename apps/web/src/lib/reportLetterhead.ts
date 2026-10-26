// ATT-014 §19.2 kop for printed reports, following the owner-approved print mock-up (2026-10-26):
// emblem on the left in dark ink on white paper, foundation name and one address line beside it.
// TEMPORARY until the owner sends the dark-ink logo file and the official address line (D-14-10).
// Replace the values here only; every print document reads them from this file.

/** Placeholder emblem in dark ink, to be replaced by the official dark-ink logo file. */
export const PLACEHOLDER_EMBLEM_SVG = `<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
<rect x="2" y="2" width="44" height="44" rx="9" fill="none" stroke="#14130f" stroke-width="2.4"/>
<path d="M14 32V18.5c0-2.6 2.1-4.7 4.7-4.7h10.6c2.6 0 4.7 2.1 4.7 4.7V32" fill="none" stroke="#14130f" stroke-width="2.4" stroke-linecap="round"/>
<path d="M14 32h20" stroke="#14130f" stroke-width="2.4" stroke-linecap="round"/>
<circle cx="24" cy="23.5" r="3.1" fill="#14130f"/></svg>`;

export const REPORT_LETTERHEAD = {
  temporary: true,
  logoSrc: `data:image/svg+xml;utf8,${encodeURIComponent(PLACEHOLDER_EMBLEM_SVG)}`,
  organizationName: "Yayasan Sabilul Qur'an",
  addressLine: "hcis.sabilulquran.or.id",
  footer: "Dokumen ini dibuat otomatis oleh HCIS Yayasan Sabilul Qur'an. Angka mengikuti hasil perhitungan yang tercantum di atas.",
  /** Optional signature block, bottom right; off by default. */
  signature: null as null | { place: string; label: string; name: string; role: string },
};
