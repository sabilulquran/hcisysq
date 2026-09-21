import { AlertTriangle, Camera, CheckCircle2, Loader2, LocateFixed, LogIn, LogOut, Send } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AppShell } from "@/layouts/AppShell";
import { clockMobileAttendance, getMyWorkforceAttendance, submitAttendanceClarification, type WorkforceSnapshot } from "@/lib/workforceAttendance";
import { cameraErrorMessage, locationErrorMessage, mobileRequestError, prepareMobileClockAttempt, type MobileClockAttempt } from "@/lib/mobileCapture";

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("");
}
function formatTime(value: string | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("id-ID", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Jakarta" }).format(new Date(value));
}
function statusLabel(value: string | undefined) {
  const labels: Record<string, string> = {
    scheduled: "Terjadwal", pending: "Berjalan", present: "Hadir", late: "Terlambat",
    incomplete: "Belum lengkap", leave: "Cuti / Izin", absent: "Tidak hadir", off: "Libur / tanpa jadwal aktif",
    configuration_error: "Jadwal perlu diperiksa",
  };
  return value ? labels[value] ?? value : "Belum dievaluasi";
}

function mobileReadinessMessage(reason: WorkforceSnapshot["mobileReadiness"]["captureReason"]) {
  if (reason === "runtime_disabled") return "Runtime mobile attendance belum diaktifkan. Pengelola perlu menjalankan activation/deployment production yang benar.";
  if (reason === "restricted_media_not_ready") return "Penyimpanan foto terenkripsi belum siap. Pengelola perlu memeriksa keyring restricted media di runtime.";
  return "Server siap menerima presensi HP.";
}

export function EmployeeMobileAttendancePage() {
  const [snapshot, setSnapshot] = useState<WorkforceSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [location, setLocation] = useState<GeolocationPosition | null>(null);
  const [locating, setLocating] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [openingCamera, setOpeningCamera] = useState(false);
  const [photoBase64, setPhotoBase64] = useState<string | null>(null);
  const [busy, setBusy] = useState<"check_in" | "check_out" | null>(null);
  const [retryPending, setRetryPending] = useState(false);
  const [clarifying, setClarifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mode, setMode] = useState<"correction" | "justification">("justification");
  const [kind, setKind] = useState("lateness");
  const [reason, setReason] = useState("");
  const [proposedIn, setProposedIn] = useState("");
  const [proposedOut, setProposedOut] = useState("");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const attemptRef = useRef<MobileClockAttempt | null>(null);
  const sendingRef = useRef(false);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getMyWorkforceAttendance();
      if (mountedRef.current) { setSnapshot(result); setError(null); }
    } catch (cause) {
      if (mountedRef.current) setError("Data presensi belum dapat dimuat. " + mobileRequestError(cause));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, [load]);

  const user = useMemo(() => ({
    name: snapshot?.employee.fullName ?? "Pegawai",
    initials: initials(snapshot?.employee.fullName ?? "P"), position: "Pegawai", unit: "Yayasan Sabilul Qur'an",
  }), [snapshot?.employee.fullName]);
  const captureLocked = busy !== null || retryPending;

  const readLocation = () => {
    if (captureLocked || locating) return;
    setError(null);
    setLocation(null);
    if (!window.isSecureContext) { setError("GPS memerlukan halaman HTTPS. Buka HCIS melalui alamat HTTPS resminya."); return; }
    if (!navigator.geolocation) { setError("Browser ini tidak mendukung pembacaan lokasi. Gunakan browser dengan layanan lokasi aktif."); return; }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (position) => { if (mountedRef.current) { setLocation(position); setLocating(false); } },
      (cause) => { if (mountedRef.current) { setError(locationErrorMessage(cause.code)); setLocating(false); } },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  };

  const startCamera = async () => {
    if (captureLocked || openingCamera) return;
    setError(null);
    setCameraReady(false);
    setPhotoBase64(null);
    if (!window.isSecureContext) { setError("Kamera memerlukan halaman HTTPS. Buka HCIS melalui alamat HTTPS resminya."); return; }
    if (!navigator.mediaDevices?.getUserMedia) { setError("Kamera tidak didukung atau diblokir browser ini. Periksa izin kamera atau gunakan HP."); return; }
    setOpeningCamera(true);
    try {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
      });
      if (!mountedRef.current) { stream.getTracks().forEach((track) => track.stop()); return; }
      streamRef.current = stream;
      if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); }
      if (mountedRef.current) setCameraReady(true);
    } catch (cause) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      if (mountedRef.current) setError(cameraErrorMessage(cause));
    } finally {
      if (mountedRef.current) setOpeningCamera(false);
    }
  };

  const capturePhoto = () => {
    if (captureLocked) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !video.videoWidth || !video.videoHeight) { setError("Gambar kamera belum siap. Tunggu pratinjau kamera sebelum mengambil foto."); return; }
    const scale = Math.min(1, 960 / video.videoWidth);
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) { setError("Browser belum dapat memproses foto kamera."); return; }
    try {
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      setPhotoBase64(canvas.toDataURL("image/jpeg", 0.82).replace(/^data:image\/jpeg;base64,/, ""));
      setNotice("Foto kamera siap. Periksa pratinjau sebelum mengirim presensi.");
      setCameraReady(false);
      streamRef.current?.getTracks().forEach((track) => track.stop());
    } catch (cause) { setError(cameraErrorMessage(cause)); }
  };

  const clock = async (action: "check_in" | "check_out") => {
    if (sendingRef.current) return;
    if (!snapshot?.mobileEnabled) { setError("Presensi HP belum siap atau belum diizinkan server. Hubungi pengelola HCIS."); return; }
    if (!attemptRef.current && (!location || !photoBase64)) { setError("Lengkapi Baca GPS dan Ambil foto sebelum mengirim presensi."); return; }
    if (attemptRef.current && attemptRef.current.action !== action) { setError("Selesaikan pengiriman sebelumnya sebelum memilih aksi lain."); return; }
    sendingRef.current = true;
    setBusy(action);
    setError(null);
    setNotice(null);
    try {
      const input = attemptRef.current ?? {
        action, latitude: location!.coords.latitude, longitude: location!.coords.longitude,
        accuracyMeters: location!.coords.accuracy, photoBase64: photoBase64!,
      };
      const attempt = prepareMobileClockAttempt(input, attemptRef.current);
      attemptRef.current = attempt;
      const result = await clockMobileAttendance(attempt);
      const locationLabels: Record<string, string> = {
        inside: "di dalam area", outside: "di luar area; perlu ditinjau",
        uncertain_accuracy: "akurasi GPS perlu ditinjau", unassigned_location: "lokasi belum terhubung ke jadwal; perlu ditinjau",
      };
      setNotice(result.duplicate ? "Pengiriman ini sudah tercatat; tidak dibuat presensi kedua."
        : (action === "check_in" ? "Clock in" : "Clock out") + " tersimpan — " + (locationLabels[result.geofenceStatus] ?? "bukti diterima") + ".");
      attemptRef.current = null;
      setRetryPending(false);
      setPhotoBase64(null);
      setLocation(null);
      await load();
    } catch (cause) {
      setRetryPending(attemptRef.current !== null);
      setError(mobileRequestError(cause));
    } finally {
      sendingRef.current = false;
      if (mountedRef.current) setBusy(null);
    }
  };

  const resetCapture = () => {
    if (busy !== null) return;
    if (retryPending && !window.confirm("Hasil pengiriman sebelumnya belum pasti. Periksa Riwayat & Jadwal dahulu agar tidak membuat presensi kedua. Tetap mulai pengambilan baru?")) return;
    attemptRef.current = null;
    setRetryPending(false);
    setPhotoBase64(null);
    setLocation(null);
    setError(null);
    setNotice(null);
  };

  const submitClarification = async () => {
    if (!snapshot || !reason.trim() || clarifying) return;
    setClarifying(true);
    setError(null);
    try {
      await submitAttendanceClarification({
        workDate: snapshot.workDate, kind, mode, reason: reason.trim(),
        proposedCheckInAt: mode === "correction" && proposedIn ? new Date(proposedIn + ":00+07:00").toISOString() : null,
        proposedCheckOutAt: mode === "correction" && proposedOut ? new Date(proposedOut + ":00+07:00").toISOString() : null,
      });
      setReason(""); setProposedIn(""); setProposedOut("");
      setNotice("Klarifikasi dikirim ke Human Capital.");
      await load();
    } catch (cause) { setError(mobileRequestError(cause)); }
    finally { setClarifying(false); }
  };

  const ready = snapshot?.mobileEnabled && location !== null && photoBase64 !== null;
  return (
    <AppShell user={user} activeItem="Clock In/Out">
      <section>
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Presensi HP</p>
        <h1 className="mt-1 text-2xl font-bold text-brand-heading sm:text-3xl">Clock In / Out</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">Tekan Baca GPS, buka kamera, lalu ambil foto sebelum mengirim. Tidak ada pelacakan lokasi di latar belakang.</p>
      </section>
      {error ? <div role="alert" className="mt-5 flex gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{error}</div> : null}
      {notice ? <div role="status" className="mt-5 flex gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />{notice}</div> : null}
      {!snapshot ? (
        <div className="mt-6 rounded-3xl border bg-white p-6 text-sm text-muted-foreground">
          {loading ? <span className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Memuat jadwal...</span>
            : <button type="button" className="min-h-11 rounded-xl border px-4 font-bold" onClick={() => void load()}>Muat ulang data presensi</button>}
        </div>
      ) : (
        <>
          <section className="mt-6 grid gap-4 lg:grid-cols-2">
            <article className="rounded-[2rem] border border-border/80 bg-white p-5 shadow-[var(--shadow-soft)]">
              <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">Hari kerja {snapshot.workDate}</p>
              <h2 className="mt-2 text-lg font-bold text-brand-heading">{statusLabel(snapshot.result?.status ?? snapshot.schedule.state)}</h2>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <div className="rounded-2xl bg-surface p-4"><p className="text-xs font-semibold text-muted-foreground">Jadwal masuk</p><p className="mt-1 text-xl font-bold">{formatTime(snapshot.schedule.scheduledStartAt)}</p></div>
                <div className="rounded-2xl bg-surface p-4"><p className="text-xs font-semibold text-muted-foreground">Jadwal keluar</p><p className="mt-1 text-xl font-bold">{formatTime(snapshot.schedule.scheduledEndAt)}</p></div>
              </div>
              <div className="mt-3 rounded-2xl border border-border p-4 text-sm">
                <p className="font-semibold">Lokasi pada jadwal: {snapshot.schedule.workLocation?.name ?? "belum terhubung"}</p>
                {snapshot.schedule.workLocation ? <p className="mt-1 text-xs text-muted-foreground">Radius {snapshot.schedule.workLocation.radiusMeters} m</p>
                  : <p className="mt-1 text-xs leading-5 text-muted-foreground">Membuat lokasi saja belum menghubungkannya ke pegawai. Pastikan lokasi dipilih pada jadwal, lalu periksa tanggal berlaku assignment atau roster.</p>}
              </div>
              {snapshot.schedule.state !== "scheduled" ? <p className="mt-3 rounded-xl bg-amber-50 p-3 text-xs leading-5 text-amber-900">Jadwal tanggal ini belum terbaca sebagai hari kerja. HC perlu memeriksa hari kerja, tanggal berlaku, assignment, dan roster. Bukti presensi tidak otomatis berarti hasil evaluasi sudah benar.</p> : null}
              {snapshot.result ? <p className="mt-3 text-xs leading-5 text-muted-foreground">Aktual masuk {formatTime(snapshot.result.firstCheckInAt)} · keluar {formatTime(snapshot.result.lastCheckOutAt)}{snapshot.result.lateMinutes > 0 ? " · telat " + snapshot.result.lateMinutes + " menit" : ""}{snapshot.result.justified ? " · justifikasi disetujui" : ""}</p> : null}
            </article>
            <article className="rounded-[2rem] border border-border/80 bg-white p-5 shadow-[var(--shadow-soft)]">
              <h2 className="font-bold text-brand-heading">Persiapan presensi</h2>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">Server: {snapshot.mobileEnabled ? "siap" : "belum siap"} · GPS: {location ? "siap" : "belum dibaca"} · Foto: {photoBase64 ? "siap" : "belum diambil"}</p>
              <p className={snapshot.mobileEnabled ? "mt-3 rounded-xl bg-emerald-50 p-3 text-xs leading-5 text-emerald-900" : "mt-3 rounded-xl bg-amber-50 p-3 text-xs leading-5 text-amber-900"}>
                {mobileReadinessMessage(snapshot.mobileReadiness.captureReason)}
              </p>
              <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
                Evaluasi jadwal: {statusLabel(snapshot.mobileReadiness.scheduleState)}
                {snapshot.mobileReadiness.scheduleReason ? ` · ${snapshot.mobileReadiness.scheduleReason}` : ""}
                {" · "}Lokasi jadwal: {snapshot.mobileReadiness.hasWorkLocation ? "terhubung" : "belum terhubung"}.
                Jadwal/lokasi tidak mematikan tombol capture, tetapi menentukan hasil evaluasi dan geofence.
              </p>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <button type="button" disabled={captureLocked || locating || !snapshot.mobileEnabled} onClick={readLocation} className="min-h-12 rounded-2xl border border-border px-4 text-sm font-bold disabled:opacity-50">
                  {locating ? <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> : <LocateFixed className="mr-2 inline h-4 w-4" />}{locating ? "Membaca GPS..." : location ? "GPS ±" + Math.round(location.coords.accuracy) + " m · baca ulang" : "1. Baca GPS"}
                </button>
                <button type="button" disabled={captureLocked || openingCamera || !snapshot.mobileEnabled} onClick={() => void startCamera()} className="min-h-12 rounded-2xl border border-border px-4 text-sm font-bold disabled:opacity-50"><Camera className="mr-2 inline h-4 w-4" />{openingCamera ? "Membuka kamera..." : photoBase64 ? "Ambil ulang foto" : "2. Buka kamera"}</button>
              </div>
              <div className="mt-3 overflow-hidden rounded-2xl border border-border bg-black">
                <video ref={videoRef} playsInline muted className={photoBase64 ? "hidden" : "aspect-video w-full object-cover"} />
                {photoBase64 ? <img src={"data:image/jpeg;base64," + photoBase64} alt="Pratinjau foto yang akan dikirim untuk presensi" className="aspect-video w-full object-contain" /> : null}
              </div>
              <canvas ref={canvasRef} className="hidden" />
              <button type="button" onClick={capturePhoto} disabled={!cameraReady || captureLocked} className="mt-3 min-h-11 w-full rounded-2xl bg-surface px-4 text-sm font-bold disabled:opacity-50">{photoBase64 ? "Foto sudah siap" : "3. Ambil foto"}</button>
              {retryPending ? (
                <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm">
                  <p>Pengiriman belum terkonfirmasi. Data dan nomor pengiriman sebelumnya dipertahankan.</p>
                  <button type="button" disabled={busy !== null} onClick={() => { if (attemptRef.current) void clock(attemptRef.current.action); }} className="mt-3 min-h-11 w-full rounded-xl bg-brand-primary px-3 font-bold text-white disabled:opacity-50">Coba ulang pengiriman yang sama</button>
                  <button type="button" disabled={busy !== null} onClick={resetCapture} className="mt-2 min-h-11 w-full rounded-xl border px-3 text-xs font-semibold">Mulai pengambilan baru</button>
                </div>
              ) : (
                <div className="mt-4 grid grid-cols-2 gap-3">
                  <button type="button" onClick={() => void clock("check_in")} disabled={busy !== null || !ready} className="min-h-12 rounded-2xl bg-brand-primary px-4 text-sm font-bold text-white disabled:opacity-50">{busy === "check_in" ? <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> : <LogIn className="mr-2 inline h-4 w-4" />}Clock in</button>
                  <button type="button" onClick={() => void clock("check_out")} disabled={busy !== null || !ready} className="min-h-12 rounded-2xl border border-brand-primary px-4 text-sm font-bold text-brand-primary-deep disabled:opacity-50">{busy === "check_out" ? <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> : <LogOut className="mr-2 inline h-4 w-4" />}Clock out</button>
                </div>
              )}
              {!ready && !retryPending ? <p className="mt-2 text-xs text-muted-foreground">Tombol aktif setelah server siap, GPS terbaca, dan foto diambil.</p> : null}
            </article>
          </section>
          <section className="mt-5 rounded-[2rem] border border-border/80 bg-white p-5 shadow-[var(--shadow-soft)]">
            <h2 className="text-base font-bold text-brand-heading">Klarifikasi kehadiran</h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">Justifikasi mempertahankan waktu aktual. Koreksi menambahkan usulan waktu baru tanpa mengubah bukti mentah.</p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <select aria-label="Jenis pengajuan" value={mode} onChange={(event) => setMode(event.target.value as "correction" | "justification")} className="h-11 rounded-xl border border-border px-3 text-sm"><option value="justification">Justifikasi</option><option value="correction">Koreksi waktu</option></select>
              <select aria-label="Alasan klarifikasi" value={kind} onChange={(event) => setKind(event.target.value)} className="h-11 rounded-xl border border-border px-3 text-sm"><option value="lateness">Keterlambatan</option><option value="missing_check_in">Jam masuk belum tercatat</option><option value="missing_check_out">Jam keluar belum tercatat</option><option value="machine_issue">Masalah mesin</option><option value="early_leave">Pulang lebih awal</option><option value="outside_geofence">Di luar geofence</option><option value="other">Lainnya</option></select>
            </div>
            {mode === "correction" ? <div className="mt-3 grid gap-3 sm:grid-cols-2"><input type="datetime-local" value={proposedIn} onChange={(event) => setProposedIn(event.target.value)} className="h-11 rounded-xl border border-border px-3 text-sm" aria-label="Usulan jam masuk" /><input type="datetime-local" value={proposedOut} onChange={(event) => setProposedOut(event.target.value)} className="h-11 rounded-xl border border-border px-3 text-sm" aria-label="Usulan jam keluar" /></div> : null}
            <textarea aria-label="Penjelasan klarifikasi" value={reason} maxLength={2000} onChange={(event) => setReason(event.target.value)} placeholder="Tuliskan penjelasan..." className="mt-3 min-h-24 w-full rounded-xl border border-border p-3 text-sm" />
            <button type="button" onClick={() => void submitClarification()} disabled={!reason.trim() || clarifying} className="mt-3 min-h-11 rounded-xl bg-brand-primary px-4 text-sm font-bold text-white disabled:opacity-50"><Send className="mr-2 inline h-4 w-4" />{clarifying ? "Mengirim..." : "Kirim klarifikasi"}</button>
          </section>
        </>
      )}
    </AppShell>
  );
}
