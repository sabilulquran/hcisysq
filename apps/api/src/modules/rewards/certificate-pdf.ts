// REWARD-001 \§4.3: the award certificate as a one-page PDF (A4 landscape), written by hand so no
// PDF dependency enters the API. Standard Helvetica fonts, WinAnsi text; characters outside it
// are reduced to their base letter or "?". The verification code is printed with the check URL.

const PAGE_WIDTH = 842;
const PAGE_HEIGHT = 595;

// Helvetica advance widths (1/1000 em) for the characters a certificate uses; others get 556.
const WIDTHS: Record<string, number> = {
  " ": 278, "'": 191, "(": 333, ")": 333, ",": 278, "-": 333, ".": 278, "/": 278, ":": 278,
  "\u2014": 1000,
  A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500, K: 667, L: 556, M: 833,
  N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222, k: 500, l: 222, m: 833,
  n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278, u: 556, v: 500, w: 722, x: 500, y: 500, z: 500,
};

/** Reduce text to what WinAnsi Helvetica can draw: accents dropped, unknown characters as "?". */
export function pdfSafeText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2013]/g, "-")
    .replace(/[^\x20-\x7e\u2014]/g, "?");
}

function textWidth(text: string, size: number, bold: boolean): number {
  const units = [...text].reduce((sum, char) => sum + (WIDTHS[char] ?? 556), 0);
  return (units * size * (bold ? 1.06 : 1)) / 1000;
}

function escapePdfString(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    // WinAnsiEncoding puts the em dash at 0x97.
    .replace(/\u2014/g, "\\227");
}

interface Line {
  text: string;
  size: number;
  bold?: boolean;
  y: number;
}

function centered(line: Line): string {
  const text = pdfSafeText(line.text);
  const x = Math.max(36, (PAGE_WIDTH - textWidth(text, line.size, line.bold === true)) / 2);
  return `BT /${line.bold ? "F2" : "F1"} ${line.size} Tf ${x.toFixed(2)} ${line.y} Td (${escapePdfString(text)}) Tj ET`;
}

export interface CertificateInput {
  recipientName: string;
  categoryLabel: string;
  monthLabel: string;
  issuerName: string;
  verificationCode: string;
  verifyUrl: string;
}

export function renderCertificatePdf(input: CertificateInput): Buffer {
  const lines: Line[] = [
    { text: "Yayasan Sabilul Qur'an", size: 16, y: 500 },
    { text: "SERTIFIKAT PENGHARGAAN", size: 30, bold: true, y: 455 },
    { text: "diberikan kepada", size: 14, y: 405 },
    { text: input.recipientName, size: 26, bold: true, y: 365 },
    { text: input.categoryLabel, size: 18, bold: true, y: 320 },
    { text: `Bulan ${input.monthLabel}`, size: 14, y: 292 },
    { text: "atas keistiqamahan membaca Al-Qur'an", size: 13, y: 266 },
    { text: "Kepala Human Capital Management", size: 12, y: 190 },
    { text: input.issuerName, size: 14, bold: true, y: 168 },
    { text: `Kode verifikasi: ${input.verificationCode}`, size: 10, y: 92 },
    { text: `Periksa keaslian di ${input.verifyUrl}`, size: 9, y: 76 },
  ];
  const border = [
    "0.11 0.42 0.33 RG 3 w 24 24 794 547 re S",
    "0.11 0.42 0.33 RG 0.8 w 34 34 774 527 re S",
    "0.4 w 321 210 m 521 210 l S",
  ].join("\n");
  const content = `${border}\n0 0 0 rg\n${lines.map(centered).join("\n")}\n`;

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}endstream`,
    `<< /Title (${escapePdfString(pdfSafeText(`Sertifikat Penghargaan ${input.monthLabel}`))}) /Producer (HCIS REWARD-001) >>`,
  ];
  let body = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 7 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}
