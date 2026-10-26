import { Eye, Smartphone, X } from "lucide-react";
import { useState } from "react";

import type { AttendanceTransaction } from "@/lib/attendanceCalculation";
import { geofenceLabel } from "@/lib/attendanceLabels";
import { attendanceMobileEvidencePhotoUrl } from "@/lib/workforceAttendance";

/**
 * GPS and photo of one mobile punch (ATT-006, ATT-014 §19.7). Shown only when the API sent the
 * evidence, which it does only for attendance.clarification.manage. The photo is requested one at a
 * time when the button is pressed; every opening is logged by the server.
 */
export function MobileEvidencePanel({ evidence }: { evidence: NonNullable<AttendanceTransaction["evidence"]> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border bg-surface p-3 text-xs">
      <p className="mb-2 flex items-center gap-1 font-semibold text-brand-heading"><Smartphone className="h-3.5 w-3.5" /> Absen lewat HP</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">Posisi</dt><dd>{geofenceLabel(evidence.geofenceStatus)}</dd>
        <dt className="text-muted-foreground">Lokasi kerja</dt><dd>{evidence.workLocationName ?? "Belum ditetapkan"}{evidence.radiusMeters ? ` (radius ${evidence.radiusMeters} m)` : ""}</dd>
        <dt className="text-muted-foreground">Jarak</dt><dd>{evidence.distanceMeters === null ? "—" : `${Math.round(evidence.distanceMeters)} m dari titik`}</dd>
        <dt className="text-muted-foreground">Akurasi GPS</dt><dd>±{Math.round(evidence.accuracyMeters)} m</dd>
        <dt className="text-muted-foreground">Koordinat</dt><dd className="tabular-nums">{evidence.latitude.toFixed(5)}, {evidence.longitude.toFixed(5)}</dd>
      </dl>
      <button type="button" onClick={() => setOpen(true)} className="mt-3 inline-flex h-8 items-center gap-1 rounded-lg border px-3 font-bold">
        <Eye className="h-3.5 w-3.5" /> Lihat foto
      </button>
      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="Foto absen">
          <div className="w-full max-w-xl rounded-2xl bg-surface-raised p-4 shadow-xl">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-bold">Foto absen</h2>
              <button type="button" aria-label="Tutup" className="rounded-lg p-2 hover:bg-surface" onClick={() => setOpen(false)}><X className="h-4 w-4" /></button>
            </div>
            <img src={attendanceMobileEvidencePhotoUrl(evidence.evidenceId)} alt="Foto absen pegawai" className="max-h-[70vh] w-full rounded-xl bg-black object-contain" />
            <p className="mt-3 text-xs text-muted-foreground">Setiap pembukaan foto dicatat dan foto tidak disimpan di perangkat ini.</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
