// EMP-012 card faces, style B approved by the owner (spec D-01, D-02).
// Every length is a multiple of `--card-u`: 1mm when printed on a 54 × 85.6 mm page, a pixel
// size on screen. The Kartu Siswa of Keluarga SQ (KEL-IMPL-005) mirrors this layout.

import type { CSSProperties, ReactNode } from "react";

import ysqLogoWhite from "@/assets/brand/ysq-logo-white.png";
import ysqMark from "@/assets/brand/ysq-mark.png";
import { formatDate, qrPath, verifyUrl, type EmployeeCard } from "@/lib/employeeCards";

export const CARD_WIDTH_MM = 54;
export const CARD_HEIGHT_MM = 85.6;

const TEAL = "#1DA3A4";
const TEAL_DEEP = "#117A7B";
const TEAL_TEXT = "#0F6F70";
const YELLOW = "#F2C129";
const MUTED = "#5A6666";

const u = (value: number) => `calc(var(--card-u) * ${value})`;

type CardData = Pick<EmployeeCard,
  "fullName" | "employeeNumber" | "positionTitle" | "unitName" | "validUntil" | "verifyCode"
  | "cardNumber" | "edition" | "issuedAt" | "signerName" | "signerTitle">;

interface FaceProps {
  card: CardData;
  /** On screen: pixels per millimetre. Omitted when printing, where 1 unit is 1 mm. */
  scale?: number;
  className?: string;
}

function Face({ scale, className, label, children }: { scale?: number; className?: string; label: string; children: ReactNode }) {
  const style = {
    "--card-u": scale ? `${scale}px` : "1mm",
    width: u(CARD_WIDTH_MM),
    height: u(CARD_HEIGHT_MM),
    position: "relative",
    overflow: "hidden",
    borderRadius: scale ? u(3) : 0,
    background: "#FFFFFF",
    color: "#000000",
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
    printColorAdjust: "exact",
    WebkitPrintColorAdjust: "exact",
    boxSizing: "border-box",
  } as CSSProperties;
  return <section aria-label={label} className={className} style={style}>{children}</section>;
}

function PhotoPlaceholder() {
  return (
    <svg viewBox="0 0 124 168" aria-hidden="true" style={{ width: "100%", height: "100%", display: "block" }}>
      <rect width="124" height="168" fill="#E6EEEE" />
      <circle cx="62" cy="64" r="32" fill="#C3CFCF" />
      <path d="M6 168 C8 122 34 106 62 106 C90 106 116 122 118 168 Z" fill="#AFBDBD" />
    </svg>
  );
}

export function CardQr({ value, size }: { value: string; size: string }) {
  const qr = qrPath(value);
  return (
    <svg role="img" aria-label="QR cek keaslian kartu" viewBox={`0 0 ${qr.size} ${qr.size}`} shapeRendering="crispEdges"
      style={{ width: size, height: size, display: "block" }}>
      <rect width={qr.size} height={qr.size} fill="#FFFFFF" />
      <path d={qr.path} fill="#000000" />
    </svg>
  );
}

/** Long names step down one size so two lines still fit under the photo. */
function nameSize(name: string) {
  if (name.length > 44) return 2.7;
  if (name.length > 28) return 3.1;
  return 3.5;
}

export function EmployeeIdCardFront({ card, photoUrl, scale, className, origin }: FaceProps & { photoUrl?: string | null; origin?: string }) {
  return (
    <Face scale={scale} className={className} label="Kartu pegawai, sisi depan">
      <div style={{ position: "absolute", left: 0, top: 0, width: "100%", height: u(19.7), background: TEAL }} />
      <img src={ysqLogoWhite} alt="Islamic Tahfizh School Sabilul Qur'an"
        style={{ position: "absolute", left: u(2.7), top: u(2.7), width: u(25), height: "auto" }} />
      <span style={{
        position: "absolute", right: u(2.7), top: u(3.7), padding: `${u(0.7)} ${u(1.35)}`, borderRadius: u(0.7),
        background: YELLOW, color: "#000000", fontSize: u(1.7), fontWeight: 800, letterSpacing: "0.06em", lineHeight: 1.2,
      }}>PEGAWAI</span>
      <div style={{
        position: "absolute", left: u(16), top: u(12.3), width: u(22), height: u(29.3), boxSizing: "border-box",
        border: `${u(0.67)} solid #FFFFFF`, borderRadius: u(2), overflow: "hidden", background: "#E6EEEE",
      }}>
        {photoUrl
          ? <img src={photoUrl} alt={`Foto ${card.fullName}`} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
          : <PhotoPlaceholder />}
      </div>
      <div style={{
        position: "absolute", left: 0, top: u(44), width: "100%", boxSizing: "border-box", padding: `0 ${u(3.3)}`,
        display: "flex", flexDirection: "column", alignItems: "center", gap: u(0.7), textAlign: "center",
      }}>
        <span style={{ fontSize: u(nameSize(card.fullName)), lineHeight: 1.15, fontWeight: 800 }}>{card.fullName}</span>
        {card.positionTitle ? <span style={{ fontSize: u(2.15), lineHeight: 1.2, fontWeight: 700, color: TEAL_TEXT }}>{card.positionTitle}</span> : null}
        {card.unitName ? <span style={{ fontSize: u(2), lineHeight: 1.2, color: "#3B4646" }}>{card.unitName}</span> : null}
      </div>
      <div style={{
        position: "absolute", left: u(3.3), right: u(3.3), bottom: u(4.3),
        display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: u(2),
      }}>
        <div style={{ display: "flex", flexDirection: "column", gap: u(1.3) }}>
          <Field label="NIP" value={card.employeeNumber} />
          <Field label="Berlaku s.d." value={formatDate(card.validUntil)} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: u(0.7) }}>
          <CardQr value={verifyUrl(card.verifyCode, origin)} size={u(12.3)} />
          <span style={{ fontSize: u(1.45), color: MUTED }}>Pindai untuk cek</span>
        </div>
      </div>
      <div style={{ position: "absolute", left: 0, bottom: 0, width: "100%", height: u(1.7), background: YELLOW }} />
    </Face>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: u(0.15) }}>
      <span style={{ fontSize: u(1.55), fontWeight: 600, color: MUTED }}>{label}</span>
      <span style={{ fontSize: u(2), fontWeight: 700 }}>{value}</span>
    </div>
  );
}

export function EmployeeIdCardBack({ card, signatureUrl, scale, className }: FaceProps & { signatureUrl?: string | null }) {
  const issued = new Date(new Date(card.issuedAt).getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
  return (
    <Face scale={scale} className={className} label="Kartu pegawai, sisi belakang">
      <div style={{ position: "absolute", left: 0, top: 0, width: "100%", height: u(1.7), background: YELLOW }} />
      <div style={{
        position: "absolute", left: 0, top: u(1.7), width: "100%", bottom: u(16), boxSizing: "border-box",
        padding: `${u(5)} ${u(4)} 0`, display: "flex", flexDirection: "column", alignItems: "center", gap: u(2), textAlign: "center",
      }}>
        <img src={ysqMark} alt="Logo Sabilul Qur'an" style={{ width: u(12), height: u(12) }} />
        <span style={{ fontSize: u(2.35), fontWeight: 800, color: TEAL_TEXT }}>Kartu Identitas Pegawai</span>
        <span style={{ fontSize: u(1.75), lineHeight: 1.5, color: "#2E3838" }}>
          Kartu ini milik Yayasan Sabilul Qur'an dan hanya berlaku selama pemegang tercatat sebagai pegawai aktif.
          Pindai QR di depan untuk cek keaslian.
        </span>
        <span style={{ fontSize: u(1.75), lineHeight: 1.5, fontStyle: "italic", color: "#2E3838" }}>
          Jika menemukan kartu ini, mohon kembalikan ke Sabilul Qur'an atau hubungi +62 851-7520-1627.
        </span>
        <div style={{ flexGrow: 1 }} />
        <div style={{
          width: "100%", display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: u(2),
          textAlign: "left", paddingBottom: u(2.3),
        }}>
          <div style={{ display: "flex", flexDirection: "column", gap: u(0.3), fontSize: u(1.5), color: MUTED }}>
            <span>No. kartu</span>
            <span style={{ fontSize: u(1.85), fontWeight: 700, color: "#000000" }}>{card.cardNumber}</span>
            <span>Cetakan ke-{card.edition} · {formatDate(issued)}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: u(0.3), fontSize: u(1.5), color: MUTED }}>
            <span>{card.signerTitle}</span>
            <div style={{ width: u(16), height: u(5.7), borderBottom: `${u(0.17)} solid #9AA6A6`, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
              {signatureUrl ? <img src={signatureUrl} alt="" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} /> : null}
            </div>
            <span style={{ fontSize: u(1.7), fontWeight: 700, color: "#000000", textAlign: "center" }}>{card.signerName}</span>
          </div>
        </div>
      </div>
      <div style={{
        position: "absolute", left: 0, bottom: 0, width: "100%", height: u(16), boxSizing: "border-box", padding: `${u(2.3)} ${u(3.3)}`,
        background: TEAL_DEEP, color: "#FFFFFF", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center",
        gap: u(0.5), textAlign: "center",
      }}>
        <span style={{ fontSize: u(1.85), fontWeight: 800 }}>www.sabilulquran.or.id</span>
        <span style={{ fontSize: u(1.67), lineHeight: 1.4 }}>Jl. Sekar Kemuning No. 5, Karyamulya,<br />Kesambi, Kota Cirebon</span>
      </div>
    </Face>
  );
}
