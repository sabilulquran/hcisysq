// Paket 2 P2-1: aturan murni pendidikan, keahlian, keluarga, dan alamat
// (spec docs/domain/employment-administration-package2.md §4). Data sintetis.

import { describe, expect, it } from "vitest";

import {
  closingDateFor,
  highestEducationLevel,
  isCertificateExpired,
  validateAddress,
  validateEducation,
  validateFamilyMember,
  validateSkill,
  type EducationInput,
  type FamilyMemberInput,
  type SkillInput,
} from "../src/modules/employees/domain/employee-profile.js";

const THIS_YEAR = 2027;

const education: EducationInput = {
  level: "D4_S1",
  institutionName: "  Universitas Sintetis  ",
  major: "Pendidikan Agama Islam",
  startedYear: 2018,
  completedYear: 2022,
  completionStatus: "SELESAI",
  degreeTitle: "S.Pd.",
};

const skill: SkillInput = {
  kind: "SERTIFIKAT",
  name: "Sertifikat Pendidik",
  category: "PENGAJARAN",
  issuer: "Kementerian Agama",
  certificateNumber: "123/SERT/2026",
  issuedOn: "2026-03-01",
  expiresOn: "2031-02-28",
};

const family: FamilyMemberInput = {
  relation: "ANAK",
  fullName: "Anak Sintetis",
  birthDate: "2020-05-17",
  isDependent: true,
  dependentOrder: 1,
  validFrom: "2020-05-17",
};

function expectField<T>(result: ReturnType<typeof validateEducation> | { ok: boolean }, field: string) {
  expect(result.ok).toBe(false);
  if (!result.ok && "failure" in result) {
    expect(result.failure.code).toBe("EMPLOYEE_RECORD_INVALID");
    expect(result.failure.field).toBe(field);
  }
}

describe("EMP-007 pendidikan", () => {
  it("menerima satu riwayat lengkap dan merapikan teksnya", () => {
    const result = validateEducation(education, THIS_YEAR);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.institutionName).toBe("Universitas Sintetis");
    expect(result.value.completedYear).toBe(2022);
  });

  it("menolak tahun yang tidak masuk akal", () => {
    expectField(validateEducation({ ...education, completedYear: 2017 }, THIS_YEAR), "completedYear");
    expectField(validateEducation({ ...education, completedYear: THIS_YEAR + 2 }, THIS_YEAR), "completedYear");
    expectField(validateEducation({ ...education, startedYear: 1800 }, THIS_YEAR), "startedYear");
  });

  it("menerima ijazah yang baru akan terbit tahun depan", () => {
    expect(validateEducation({ ...education, completedYear: THIS_YEAR + 1 }, THIS_YEAR).ok).toBe(true);
  });

  it("mewajibkan tahun selesai hanya bila pendidikannya selesai", () => {
    expectField(validateEducation({ ...education, completedYear: null }, THIS_YEAR), "completedYear");
    expect(validateEducation(
      { ...education, completionStatus: "BELUM_SELESAI", completedYear: null },
      THIS_YEAR,
    ).ok).toBe(true);
  });

  it("mewajibkan nama lembaga", () => {
    expectField(validateEducation({ ...education, institutionName: "   " }, THIS_YEAR), "institutionName");
  });
});

describe("EMP-007 pendidikan tertinggi", () => {
  const verified = (level: Parameters<typeof highestEducationLevel>[0][number]["level"]) => ({
    level,
    completionStatus: "SELESAI" as const,
    verificationStatus: "DIVERIFIKASI" as const,
    voided: false,
  });

  it("mengambil jenjang tertinggi yang selesai dan terverifikasi", () => {
    expect(highestEducationLevel([verified("D4_S1"), verified("S2"), verified("SMA_SEDERAJAT")])).toBe("S2");
  });

  it("mengabaikan yang belum selesai, belum diverifikasi, atau dibatalkan", () => {
    expect(highestEducationLevel([
      { ...verified("S3"), completionStatus: "BELUM_SELESAI" },
      { ...verified("S2"), verificationStatus: "DILAPORKAN" },
      { ...verified("D3"), voided: true },
      verified("D4_S1"),
    ])).toBe("D4_S1");
  });

  it("tidak menyetarakan pondok dengan jenjang formal", () => {
    expect(highestEducationLevel([verified("PONDOK")])).toBeNull();
    expect(highestEducationLevel([verified("PONDOK"), verified("SMA_SEDERAJAT")])).toBe("SMA_SEDERAJAT");
  });

  it("mengembalikan kosong, bukan tebakan, bila tidak ada yang memenuhi", () => {
    expect(highestEducationLevel([])).toBeNull();
    expect(highestEducationLevel([{ ...verified("S2"), verificationStatus: "DILAPORKAN" }])).toBeNull();
  });
});

describe("EMP-008 keahlian dan sertifikat", () => {
  it("menerima sertifikat lengkap", () => {
    const result = validateSkill(skill);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.issuer).toBe("Kementerian Agama");
  });

  it("mewajibkan penerbit dan tanggal terbit hanya untuk sertifikat", () => {
    expectField(validateSkill({ ...skill, issuer: null }), "issuer");
    expectField(validateSkill({ ...skill, issuedOn: null }), "issuedOn");
    expect(validateSkill({ kind: "KEAHLIAN", name: "Tahfidz 10 juz", category: "KEAGAMAAN" }).ok).toBe(true);
  });

  it("menolak masa berlaku yang berakhir sebelum terbit", () => {
    expectField(validateSkill({ ...skill, expiresOn: "2025-01-01" }), "expiresOn");
  });

  it("membiarkan sertifikat tanpa masa berlaku", () => {
    const result = validateSkill({ ...skill, expiresOn: null });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.expiresOn).toBeNull();
  });

  it("menandai yang kedaluwarsa tanpa mengubahnya", () => {
    expect(isCertificateExpired("2026-12-31", "2027-01-01")).toBe(true);
    expect(isCertificateExpired("2027-01-01", "2027-01-01")).toBe(false);
    expect(isCertificateExpired(null, "2027-01-01")).toBe(false);
  });
});

describe("EMP-009 keluarga dan tanggungan", () => {
  it("menerima tanggungan lengkap", () => {
    expect(validateFamilyMember(family).ok).toBe(true);
  });

  it("mewajibkan tanggal lahir untuk tanggungan", () => {
    expectField(validateFamilyMember({ ...family, birthDate: null }), "birthDate");
  });

  it("menolak urutan tanggungan pada yang bukan tanggungan", () => {
    expectField(validateFamilyMember({ ...family, isDependent: false, birthDate: "2020-05-17" }), "dependentOrder");
  });

  it("mewajibkan nomor dan urutan untuk kontak darurat", () => {
    const base: FamilyMemberInput = {
      relation: "PASANGAN", fullName: "Pasangan Sintetis", validFrom: "2019-01-01", isEmergencyContact: true,
    };
    expectField(validateFamilyMember(base), "emergencyPhone");
    expectField(validateFamilyMember({ ...base, emergencyPhone: "0812" }), "emergencyPriority");
    expect(validateFamilyMember({ ...base, emergencyPhone: "0812", emergencyPriority: 1 }).ok).toBe(true);
  });

  it("membuang nomor darurat bila anggota ini bukan kontak darurat", () => {
    const result = validateFamilyMember({ ...family, emergencyPhone: "0812", emergencyPriority: 2 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.emergencyPhone).toBeNull();
      expect(result.value.emergencyPriority).toBeNull();
    }
  });

  it("menolak periode yang berakhir sebelum dimulai", () => {
    expectField(validateFamilyMember({ ...family, validTo: "2019-01-01" }), "validTo");
  });
});

describe("EMP-003 alamat", () => {
  const address = {
    kind: "DOMISILI" as const,
    addressLine: "Jalan Sintetis No. 1",
    city: "Bandung",
    postalCode: "40123",
    validFrom: "2026-01-01",
  };

  it("menerima alamat lengkap dan menolak kode pos yang salah bentuk", () => {
    expect(validateAddress(address).ok).toBe(true);
    expectField(validateAddress({ ...address, postalCode: "4012" }), "postalCode");
  });

  it("mewajibkan alamat dan kota", () => {
    expectField(validateAddress({ ...address, addressLine: "  " }), "addressLine");
    expectField(validateAddress({ ...address, city: "" }), "city");
  });

  it("menutup alamat lama sehari sebelum yang baru berlaku", () => {
    expect(closingDateFor({ validFrom: "2024-01-01", validTo: null }, "2027-03-01")).toBe("2027-02-28");
    expect(closingDateFor({ validFrom: "2024-01-01", validTo: null }, "2028-03-01")).toBe("2028-02-29");
  });

  it("tidak menutup alamat yang memang sudah berakhir", () => {
    expect(closingDateFor({ validFrom: "2020-01-01", validTo: "2022-12-31" }, "2027-03-01")).toBeNull();
  });

  it("tidak menutup alamat yang baru mulai pada hari yang sama", () => {
    expect(closingDateFor({ validFrom: "2027-03-01", validTo: null }, "2027-03-01")).toBeNull();
  });
});
