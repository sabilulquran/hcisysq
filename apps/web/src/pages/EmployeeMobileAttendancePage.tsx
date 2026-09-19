import { AlertTriangle, Camera, CheckCircle2, Loader2, LocateFixed, LogIn, LogOut, Send } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { AppShell } from "@/layouts/AppShell";
import {
  clockMobileAttendance,
  getMyWorkforceAttendance,
  submitAttendanceClarification,
  type WorkforceSnapshot,
} from "@/lib/workforceAttendance";

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("");
}

function formatTime(value: string | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Jakarta",
  }).format(new Date(value));
}

function statusLabel(value: string | undefined) {
  const labels: Record<string, string> = {
    scheduled: "Terjadwal",
    pending: "Berjalan",
    present: "Hadir",
    late: "Terlambat",
    incomplete: "Belum lengkap",
    leave: "Cuti / Izin",
    absent: "Tidak hadir",
    off: "Libur",
    configuration_error: "Jadwal perlu diperiksa",
  };
  return value ? labels[value] ?? value : "Belum dievaluasi";
}

export function EmployeeMobileAttendancePage() {
  const [snapshot, setSnapshot] = useState<WorkforceSnapshot | null>(null);
  const [location, setLocation] = useState<GeolocationPosition | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [photoBase64, setPhotoBase64] = useState<string | null>(null);
  const [busy, setBusy] = useState<"check_in" | "check_out" | null>(null);
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

  const load = async () => {
    try {
      setSnapshot(await getMyWorkforceAttendance());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Data presensi tidak dapat dimuat.");
    }
  };

  useEffect(() => {
    void load();
    return () => streamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  const user = useMemo(() => ({
    name: snapshot?.employee.fullName ?? "Pegawai",
    initials: initials(snapshot?.employee.fullName ?? "P"),
    position: "Pegawai",
    unit: "Yayasan Sabilul Qur'an",
  }), [snapshot?.employee.fullName]);

  const readLocation = () => {
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (position) => setLocation(position),
      (cause) => setError(cause.message || "Lokasi tidak dapat dibaca."),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    );
  };

  const startCamera = async () => {
    try {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraReady(true);
      setPhotoBase64(null);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Kamera tidak dapat dibuka.");
    }
  };

  const capturePhoto = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !video.videoWidth || !video.videoHeight) return;
    const scale = Math.min(1, 960 / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const context = canvas.getContext("2d");
    if (!context) return;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    setPhotoBase64(canvas.toDataURL("image/jpeg", 0.82).replace(/^data:image\/jpeg;base64,/, ""));
    setNotice("Foto kamera siap digunakan.");
  };

  const clock = async (action: "check_in" | "check_out") => {
    if (!snapshot?.mobileEnabled) {
      setError("Presensi HP belum diaktifkan oleh administrator.");
      return;
    }
    if (!location || !photoBase64) {
      setError("Baca GPS dan ambil foto kamera terlebih dahulu.");
      return;
    }
    setBusy(action);
    setError(null);
    try {
      const result = await clockMobileAttendance({
        action,
        latitude: location.coords.latitude,
        longitude: location.coords.longitude,
        accuracyMeters: location.coords.accuracy,
        photoBase64,
        idempotencyKey: crypto.randomUUID(),
      });
      let locationText = "evidence tersimpan";
      if (result.geofenceStatus === "inside") locationText = "di dalam area";
      if (result.geofenceStatus === "outside") locationText = "di luar area; perlu ditinjau";
      if (result.geofenceStatus === "uncertain_accuracy") locationText = "akurasi GPS perlu ditinjau";
      if (result.geofenceStatus === "unassigned_location") locationText = "lokasi kerja belum ditetapkan";
      setNotice((action === "check_in" ? "Clock in" : "Clock out") + " tersimpan — " + locationText + ".");
      setPhotoBase64(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Presensi gagal disimpan.");
    } finally {
      setBusy(null);
    }
  };

  const submitClarification = async () => {
    if (!snapshot || !reason.trim()) return;
    try {
      await submitAttendanceClarification({
        workDate: snapshot.workDate,
        kind,
        mode,
        reason: reason.trim(),
        proposedCheckInAt: mode === "correction" && proposedIn
          ? new Date(proposedIn + ":00+07:00").toISOString()
          : null,
        proposedCheckOutAt: mode === "correction" && proposedOut
          ? new Date(proposedOut + ":00+07:00").toISOString()
          : null,
      });
      setReason("");
      setProposedIn("");
      setProposedOut("");
      setNotice("Klarifikasi dikirim ke Human Capital.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Klarifikasi gagal dikirim.");
    }
  };

  return (
    <AppShell user={user} activeItem="Kehadiran">
      <section>
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Presensi HP</p>
        <h1 className="mt-1 text-2xl font-bold text-brand-heading sm:text-3xl">Clock In / Out</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
          GPS hanya dibaca saat presensi. Foto diambil langsung dari kamera dan disimpan terenkripsi sebagai evidence kehadiran.
        </p>
      </section>

      {error ? (
        <div className="mt-5 flex gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {error}
        </div>
      ) : null}
      {notice ? (
        <div className="mt-5 flex gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> {notice}
        </div>
      ) : null}

      {!snapshot ? (
        <div className="mt-6 flex items-center gap-2 rounded-3xl border bg-white p-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Memuat jadwal...
        </div>
      ) : (
        <>
          <section className="mt-6 grid gap-4 lg:grid-cols-2">
            <article className="rounded-[2rem] border border-border/80 bg-white p-5 shadow-[var(--shadow-soft)]">
              <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">Hari kerja {snapshot.workDate}</p>
              <h2 className="mt-2 text-lg font-bold text-brand-heading">{statusLabel(snapshot.result?.status ?? snapshot.schedule.state)}</h2>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <div className="rounded-2xl bg-surface p-4">
                  <p className="text-[10px] font-bold uppercase text-muted-foreground">Jadwal masuk</p>
                  <p className="mt-1 text-xl font-bold">{formatTime(snapshot.schedule.scheduledStartAt)}</p>
                </div>
                <div className="rounded-2xl bg-surface p-4">
                  <p className="text-[10px] font-bold uppercase text-muted-foreground">Jadwal keluar</p>
                  <p className="mt-1 text-xl font-bold">{formatTime(snapshot.schedule.scheduledEndAt)}</p>
                </div>
              </div>
              {snapshot.result ? (
                <p className="mt-3 text-xs leading-5 text-muted-foreground">
                  Aktual masuk {formatTime(snapshot.result.firstCheckInAt)} · keluar {formatTime(snapshot.result.lastCheckOutAt)}
                  {snapshot.result.lateMinutes > 0 ? " · telat " + snapshot.result.lateMinutes + " menit" : ""}
                  {snapshot.result.justified ? " · justifikasi disetujui" : ""}
                </p>
              ) : null}
            </article>

            <article className="rounded-[2rem] border border-border/80 bg-white p-5 shadow-[var(--shadow-soft)]">
              <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">Evidence presensi</p>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <button type="button" onClick={readLocation} className="min-h-12 rounded-2xl border border-border px-4 text-sm font-bold">
                  <LocateFixed className="mr-2 inline h-4 w-4" />
                  {location ? "GPS ±" + Math.round(location.coords.accuracy) + " m" : "Baca GPS"}
                </button>
                <button type="button" onClick={() => void startCamera()} className="min-h-12 rounded-2xl border border-border px-4 text-sm font-bold">
                  <Camera className="mr-2 inline h-4 w-4" /> Buka kamera
                </button>
              </div>
              <div className="mt-3 overflow-hidden rounded-2xl border border-border bg-black">
                <video ref={videoRef} playsInline muted className="aspect-video w-full object-cover" />
              </div>
              <canvas ref={canvasRef} className="hidden" />
              <button type="button" onClick={capturePhoto} disabled={!cameraReady} className="mt-3 min-h-11 w-full rounded-2xl bg-surface px-4 text-sm font-bold disabled:opacity-50">
                {photoBase64 ? "Foto siap · ambil ulang" : "Ambil foto"}
              </button>
              {!snapshot.mobileEnabled ? (
                <p className="mt-3 rounded-2xl bg-amber-50 p-3 text-xs leading-5 text-amber-900">
                  Fitur repository sudah tersedia, tetapi runtime mobile attendance masih OFF.
                </p>
              ) : null}
              <div className="mt-4 grid grid-cols-2 gap-3">
                <button type="button" onClick={() => void clock("check_in")} disabled={busy !== null || !snapshot.mobileEnabled} className="min-h-12 rounded-2xl bg-brand-primary px-4 text-sm font-bold text-white disabled:opacity-50">
                  {busy === "check_in" ? <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> : <LogIn className="mr-2 inline h-4 w-4" />}
                  Clock in
                </button>
                <button type="button" onClick={() => void clock("check_out")} disabled={busy !== null || !snapshot.mobileEnabled} className="min-h-12 rounded-2xl border border-brand-primary px-4 text-sm font-bold text-brand-primary-deep disabled:opacity-50">
                  {busy === "check_out" ? <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> : <LogOut className="mr-2 inline h-4 w-4" />}
                  Clock out
                </button>
              </div>
            </article>
          </section>

          <section className="mt-5 rounded-[2rem] border border-border/80 bg-white p-5 shadow-[var(--shadow-soft)]">
            <h2 className="text-base font-bold text-brand-heading">Klarifikasi kehadiran</h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Justifikasi mempertahankan waktu aktual. Koreksi menambahkan usulan waktu baru tanpa mengubah evidence mentah.
            </p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <select value={mode} onChange={(event) => setMode(event.target.value as "correction" | "justification")} className="h-11 rounded-xl border border-border px-3 text-sm">
                <option value="justification">Justifikasi</option>
                <option value="correction">Koreksi waktu</option>
              </select>
              <select value={kind} onChange={(event) => setKind(event.target.value)} className="h-11 rounded-xl border border-border px-3 text-sm">
                <option value="lateness">Keterlambatan</option>
                <option value="missing_check_in">Jam masuk belum tercatat</option>
                <option value="missing_check_out">Jam keluar belum tercatat</option>
                <option value="machine_issue">Masalah mesin</option>
                <option value="early_leave">Pulang lebih awal</option>
                <option value="outside_geofence">Di luar geofence</option>
                <option value="other">Lainnya</option>
              </select>
            </div>
            {mode === "correction" ? (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <input type="datetime-local" value={proposedIn} onChange={(event) => setProposedIn(event.target.value)} className="h-11 rounded-xl border border-border px-3 text-sm" aria-label="Usulan jam masuk" />
                <input type="datetime-local" value={proposedOut} onChange={(event) => setProposedOut(event.target.value)} className="h-11 rounded-xl border border-border px-3 text-sm" aria-label="Usulan jam keluar" />
              </div>
            ) : null}
            <textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Tuliskan penjelasan..." className="mt-3 min-h-24 w-full rounded-xl border border-border p-3 text-sm" />
            <button type="button" onClick={() => void submitClarification()} disabled={!reason.trim()} className="mt-3 min-h-11 rounded-xl bg-brand-primary px-4 text-sm font-bold text-white disabled:opacity-50">
              <Send className="mr-2 inline h-4 w-4" /> Kirim klarifikasi
            </button>
          </section>
        </>
      )}
    </AppShell>
  );
}
