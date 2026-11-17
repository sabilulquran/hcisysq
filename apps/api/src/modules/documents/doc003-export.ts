// DOC-004 §4: shaping and checking the one-way DOC-003 export for the Sekretariat
// cutover (SQ-Hub SEK-IMPL-001 §14 langkah 8). Pure functions so the rules can be
// tested without a database; the CLI in `cli/export-doc003.ts` reads the rows.

/** Sekretariat `eksporDoc003Schema`. Kept in sync by DOC-004 C-01. */
export interface EksporDoc003 {
  types: Array<{ code: string; label: string }>;
  issuers: Array<{ code: string; name: string; kind: string }>;
  grants: Array<{ issuerCode: string; personId: string; reason: string }>;
  counters: Array<{ issuerCode: string; typeCode: string; periodKey: string; lastSequence: number }>;
  numbers: Array<{
    sourceId: string;
    issuerCode: string;
    typeCode: string;
    periodKey: string;
    sequence: number;
    letterNumber: string;
    letterDate: string;
    subject: string;
    recipient: string;
    status: "ALLOCATED" | "VOIDED";
    voidedReason: string | null;
    requestedBy: string;
  }>;
}

export interface BarisDoc003 {
  types: Array<{ code: string; label: string }>;
  issuers: Array<{ code: string; name: string; kind: string }>;
  grants: Array<{ issuer_code: string; employee_id: string; reason: string }>;
  counters: Array<{ issuer_code: string; type_code: string; period_key: string; last_sequence: number }>;
  numbers: Array<{
    id: string;
    issuer_code: string;
    type_code: string;
    period_key: string;
    sequence: number;
    letter_number: string;
    letter_date: string;
    subject: string;
    recipient: string;
    status: "ALLOCATED" | "VOIDED";
    void_reason: string | null;
    requested_by_employee_id: string;
  }>;
}

/** DOC-004 C-04: the only identity that leaves HCIS is the employee reference. */
export function personRef(employeeId: string): string {
  return `hcis:employee:${employeeId}`;
}

export function buildEkspor(rows: BarisDoc003): EksporDoc003 {
  return {
    types: rows.types.map((row) => ({ code: row.code, label: row.label })),
    issuers: rows.issuers.map((row) => ({ code: row.code, name: row.name, kind: row.kind })),
    grants: rows.grants.map((row) => ({
      issuerCode: row.issuer_code,
      personId: personRef(row.employee_id),
      reason: row.reason,
    })),
    counters: rows.counters.map((row) => ({
      issuerCode: row.issuer_code,
      typeCode: row.type_code,
      periodKey: row.period_key,
      lastSequence: Number(row.last_sequence),
    })),
    numbers: rows.numbers.map((row) => ({
      sourceId: row.id,
      issuerCode: row.issuer_code,
      typeCode: row.type_code,
      periodKey: row.period_key,
      sequence: Number(row.sequence),
      letterNumber: row.letter_number,
      letterDate: row.letter_date,
      subject: row.subject,
      recipient: row.recipient,
      status: row.status,
      voidedReason: row.void_reason,
      requestedBy: personRef(row.requested_by_employee_id),
    })),
  };
}

/**
 * DOC-004 §4: refuse to write a book the Sekretariat importer would reject, or one
 * that is already inconsistent. Returns every problem at once so one run is enough.
 */
export function validateEkspor(ekspor: EksporDoc003): string[] {
  const problems: string[] = [];
  const typeCodes = new Set(ekspor.types.map((type) => type.code));
  const issuerCodes = new Set(ekspor.issuers.map((issuer) => issuer.code));

  for (const issuer of ekspor.issuers) {
    if (!/^[A-Z0-9][A-Z0-9.-]{1,29}$/.test(issuer.code)) {
      problems.push(`kode penerbit "${issuer.code}" tidak diterima katalog Sekretariat (minimal dua karakter)`);
    }
  }
  for (const type of ekspor.types) {
    if (!/^[0-9A-Z][0-9A-Z-]{0,9}$/.test(type.code)) {
      problems.push(`kode jenis "${type.code}" tidak diterima katalog Sekretariat`);
    }
  }
  for (const grant of ekspor.grants) {
    if (!issuerCodes.has(grant.issuerCode)) {
      problems.push(`grant menunjuk penerbit "${grant.issuerCode}" yang tidak ikut terekspor`);
    }
  }
  for (const counter of ekspor.counters) {
    if (!issuerCodes.has(counter.issuerCode)) {
      problems.push(`penghitung menunjuk penerbit "${counter.issuerCode}" yang tidak ikut terekspor`);
    }
    if (!typeCodes.has(counter.typeCode)) {
      problems.push(`penghitung menunjuk jenis "${counter.typeCode}" yang tidak ikut terekspor`);
    }
  }

  // Highest sequence actually used per issuer x type x period, against the counter.
  const tertinggi = new Map<string, number>();
  for (const number of ekspor.numbers) {
    if (!issuerCodes.has(number.issuerCode)) {
      problems.push(`nomor ${number.letterNumber} menunjuk penerbit "${number.issuerCode}" yang tidak ikut terekspor`);
    }
    if (!typeCodes.has(number.typeCode)) {
      problems.push(`nomor ${number.letterNumber} menunjuk jenis "${number.typeCode}" yang tidak ikut terekspor`);
    }
    if (number.subject.length > 300) problems.push(`perihal nomor ${number.letterNumber} melebihi 300 karakter`);
    if (number.recipient.length > 300) problems.push(`tujuan nomor ${number.letterNumber} melebihi 300 karakter`);
    const key = `${number.issuerCode}\n${number.typeCode}\n${number.periodKey}`;
    tertinggi.set(key, Math.max(tertinggi.get(key) ?? 0, number.sequence));
  }
  const penghitung = new Map<string, number>(
    ekspor.counters.map((counter) => [`${counter.issuerCode}\n${counter.typeCode}\n${counter.periodKey}`, counter.lastSequence]),
  );
  for (const [key, puncak] of tertinggi) {
    const nilai = penghitung.get(key) ?? 0;
    if (nilai < puncak) {
      const [issuer, type, period] = key.split("\n");
      problems.push(`penghitung ${issuer} ${type} ${period} = ${nilai}, lebih kecil dari urut tertinggi ${puncak}`);
    }
  }
  return problems;
}

/** The counts the operator compares with the Sekretariat import result (DOC-004 §9 langkah 5). */
export function ringkasan(ekspor: EksporDoc003): {
  jenis: number;
  penerbit: number;
  grantAktif: number;
  penghitung: number;
  nomorTerpakai: number;
  nomorDibatalkan: number;
  nomorSeluruhnya: number;
  urutTertinggi: Array<{ kunci: string; nilai: number }>;
} {
  const dibatalkan = ekspor.numbers.filter((number) => number.status === "VOIDED").length;
  const puncak = new Map<string, number>();
  for (const counter of ekspor.counters) {
    const kunci = `${counter.issuerCode} ${counter.typeCode} ${counter.periodKey.slice(0, 4)}`;
    puncak.set(kunci, Math.max(puncak.get(kunci) ?? 0, counter.lastSequence));
  }
  return {
    jenis: ekspor.types.length,
    penerbit: ekspor.issuers.length,
    grantAktif: ekspor.grants.length,
    penghitung: ekspor.counters.length,
    nomorTerpakai: ekspor.numbers.length - dibatalkan,
    nomorDibatalkan: dibatalkan,
    nomorSeluruhnya: ekspor.numbers.length,
    urutTertinggi: [...puncak.keys()].sort().map((kunci) => ({ kunci, nilai: puncak.get(kunci)! })),
  };
}
