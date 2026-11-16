/**
 * PAY-003 tax identity (NIK, NPWP) for the bukti potong 1721-A1 (specification
 * section 7.4). The values are sealed with AES-256-GCM under a key derived from
 * the server key with HKDF and a label of its own, so the key that protects
 * sessions never encrypts this data directly. The associated data binds each
 * sealed value to its employee and field: a value copied onto another row or
 * into the other column does not open.
 *
 * Nothing here logs, and no caller may log or audit the opened values (section 8).
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

export type TaxIdentityField = "nik" | "npwp";

const LABEL = "HCIS_PAYROLL_TAX_IDENTITY_V1";

function key(serverKeyHex: string): Buffer {
  if (!/^[a-fA-F0-9]{64}$/.test(serverKeyHex)) throw new Error("Tax identity key is not configured");
  return Buffer.from(hkdfSync("sha256", Buffer.from(serverKeyHex, "hex"), Buffer.alloc(0), LABEL, 32));
}

function aad(employeeId: string, field: TaxIdentityField): Buffer {
  return Buffer.from(JSON.stringify([LABEL, employeeId, field]), "utf8");
}

export function sealTaxIdentity(serverKeyHex: string, employeeId: string, field: TaxIdentityField, value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(serverKeyHex), iv);
  cipher.setAAD(aad(employeeId, field));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", iv, cipher.getAuthTag(), ciphertext].map((part) => (typeof part === "string" ? part : part.toString("base64url"))).join(".");
}

export function openTaxIdentity(serverKeyHex: string, employeeId: string, field: TaxIdentityField, sealed: string): string {
  const [version, iv, tag, ciphertext] = sealed.split(".");
  if (version !== "v1" || !iv || !tag || ciphertext === undefined) throw new Error("Unsupported sealed tax identity");
  const decipher = createDecipheriv("aes-256-gcm", key(serverKeyHex), Buffer.from(iv, "base64url"));
  decipher.setAAD(aad(employeeId, field));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

/** Digits only: "32.01.xx" or "01.234.567.8-901.000" as typed become the bare number. */
export function normalizeTaxNumber(value: string): string {
  return value.replace(/[\s.\-/]/g, "");
}

/** NIK is 16 digits; NPWP is 15 digits (old form) or 16 (NIK-based, PMK 112/2022). */
export function taxNumberProblem(field: TaxIdentityField, digits: string): string | null {
  if (field === "nik") return /^\d{16}$/.test(digits) ? null : "NIK harus 16 digit angka.";
  return /^(\d{15}|\d{16})$/.test(digits) ? null : "NPWP harus 15 atau 16 digit angka.";
}

/** What a screen may show: the last four digits only. */
export function maskTaxNumber(last4: string | null): string | null {
  return last4 === null ? null : `************${last4}`;
}
