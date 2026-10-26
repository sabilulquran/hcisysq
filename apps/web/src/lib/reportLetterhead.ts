import ysqMark from "@/assets/brand/ysq-mark.png";

// ATT-014 §19.2 kop for printed reports. TEMPORARY until the owner sends the official letterhead text
// and logo file (D-14-10); replace the values here only, every print document reads them from this file.
export const REPORT_LETTERHEAD = {
  temporary: true,
  logoSrc: ysqMark,
  organizationName: "Yayasan Sabilul Qur'an",
  subtitle: "Human Capital Information System (HCIS)",
  signature: null as null | { label: string; role: string },
};
