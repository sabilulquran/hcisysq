export interface MobileCaptureInput {
  action: "check_in" | "check_out";
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  photoBase64: string;
}
export type MobileClockAttempt = Readonly<MobileCaptureInput & { idempotencyKey: string }>;

// An ambiguous network/server response must never create a fresh logical clock.
// Keep the exact payload in memory only; do not persist location/photos to storage.
export function prepareMobileClockAttempt(
  input: MobileCaptureInput,
  previous: MobileClockAttempt | null,
  createKey: () => string = () => crypto.randomUUID(),
): MobileClockAttempt {
  if (previous) {
    const same = previous.action === input.action && previous.photoBase64 === input.photoBase64
      && previous.latitude === input.latitude && previous.longitude === input.longitude
      && previous.accuracyMeters === input.accuracyMeters;
    if (!same) throw new Error("Selesaikan pengiriman sebelumnya atau mulai pengambilan baru secara eksplisit.");
    return previous;
  }
  return Object.freeze({ ...input, idempotencyKey: createKey() });
}

export function locationErrorMessage(code: number): string {
  if (code === 1) return "Izin lokasi ditolak. Pada pengaturan situs di sebelah alamat HCIS, izinkan Lokasi. Periksa juga layanan lokasi perangkat.";
  if (code === 2) return "Lokasi belum dapat ditemukan. Aktifkan layanan lokasi perangkat, lalu coba Baca GPS lagi.";
  if (code === 3) return "Pembacaan GPS melewati batas waktu. Coba lagi di tempat dengan sinyal lokasi lebih baik.";
  return "Lokasi tidak dapat dibaca. Periksa izin lokasi browser dan perangkat.";
}

export function cameraErrorMessage(cause: unknown): string {
  const name = typeof cause === "object" && cause !== null && "name" in cause ? String(cause.name) : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Izin kamera ditolak. Izinkan Kamera pada pengaturan situs HCIS dan pengaturan privasi perangkat.";
  if (name === "NotFoundError" || name === "DevicesNotFoundError") return "Perangkat ini tidak memiliki kamera yang tersedia. Gunakan HP atau sambungkan kamera; foto langsung tetap diperlukan.";
  if (name === "NotReadableError" || name === "TrackStartError") return "Kamera sedang digunakan aplikasi lain atau tidak dapat dibuka. Tutup aplikasi kamera lain, lalu coba lagi.";
  return "Kamera belum dapat dibuka. Periksa kamera serta izin browser, lalu coba lagi.";
}

export function mobileRequestError(cause: unknown): string {
  if (cause && typeof cause === "object" && "status" in cause && "code" in cause) {
    const status = Number(cause.status);
    const rawCode = String(cause.code);
    const code = /^[a-zA-Z0-9_.-]{1,100}$/.test(rawCode) ? rawCode : "REQUEST_FAILED";
    if (status === 401) return `Sesi login berakhir. Masuk kembali. [HTTP ${status} / ${code}]`;
    if (status === 403) return `Akun tidak diizinkan untuk tindakan ini. Hubungi pengelola HCIS. [HTTP ${status} / ${code}]`;
    if (status === 413) return `Ukuran foto terlalu besar. Mulai pengambilan baru dan ambil ulang foto. [HTTP ${status} / ${code}]`;
    if (status >= 500) return `Server belum mengonfirmasi hasil permintaan. Jangan langsung membuat presensi kedua; coba ulang pengiriman yang sama atau periksa riwayat. [HTTP ${status} / ${code}]`;
    const message = cause instanceof Error ? cause.message : "Permintaan tidak dapat diproses.";
    return `${message} [HTTP ${status} / ${code}]`;
  }
  return "Sambungan ke server terputus atau respons belum dapat dibaca. Hasil pengiriman belum pasti; gunakan Coba ulang pengiriman yang sama.";
}
