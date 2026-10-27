import ysqMark from "@/assets/brand/ysq-mark.png";

// ATT-014 §19.2 kop for printed reports, following the owner-approved print mock-up (2026-10-26, D-14-10):
// the full foundation emblem (ysq-mark.png, which has its own background so it stays legible on white
// paper and in black-and-white print) with the foundation name as serif text beside it. The gold
// wordmark and the white logo are not used on paper. Every print document reads these values here.
export const REPORT_LETTERHEAD = {
  logoSrc: ysqMark,
  organizationName: "Yayasan Sabilul Qur'an",
  addressLine: "hcis.sabilulquran.or.id",
  footer: "Dokumen ini dibuat otomatis oleh HCIS Yayasan Sabilul Qur'an. Angka mengikuti hasil perhitungan yang tercantum di atas.",
  /** Optional signature block, bottom right; off by default. */
  signature: null as null | { place: string; label: string; name: string; role: string },
};
