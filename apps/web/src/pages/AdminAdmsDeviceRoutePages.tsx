import { useParams } from "@tanstack/react-router";

import { AdminAdmsDevicePage } from "@/pages/AdminAdmsDevicePage";

export function AdminAdmsDeviceOverviewRoutePage() {
  const { deviceId } = useParams({ from: "/admin/attendance/devices/$deviceId" });
  return <AdminAdmsDevicePage deviceId={deviceId} section="overview" />;
}

export function AdminAdmsDeviceUsersRoutePage() {
  const { deviceId } = useParams({ from: "/admin/attendance/devices/$deviceId/users" });
  return <AdminAdmsDevicePage deviceId={deviceId} section="users" />;
}

export function AdminAdmsDeviceBiometricsRoutePage() {
  const { deviceId } = useParams({ from: "/admin/attendance/devices/$deviceId/biometrics" });
  return <AdminAdmsDevicePage deviceId={deviceId} section="biometrics" />;
}

export function AdminAdmsDeviceDataRoutePage() {
  const { deviceId } = useParams({ from: "/admin/attendance/devices/$deviceId/data" });
  return <AdminAdmsDevicePage deviceId={deviceId} section="data" />;
}

export function AdminAdmsDeviceTransactionsRoutePage() {
  const { deviceId } = useParams({ from: "/admin/attendance/devices/$deviceId/transactions" });
  return <AdminAdmsDevicePage deviceId={deviceId} section="transactions" />;
}

export function AdminAdmsDeviceCommandsRoutePage() {
  const { deviceId } = useParams({ from: "/admin/attendance/devices/$deviceId/commands" });
  return <AdminAdmsDevicePage deviceId={deviceId} section="commands" />;
}

export function AdminAdmsDeviceOperationsRoutePage() {
  const { deviceId } = useParams({ from: "/admin/attendance/devices/$deviceId/operations" });
  return <AdminAdmsDevicePage deviceId={deviceId} section="operations" />;
}

export function AdminAdmsDeviceSettingsRoutePage() {
  const { deviceId } = useParams({ from: "/admin/attendance/devices/$deviceId/settings" });
  return <AdminAdmsDevicePage deviceId={deviceId} section="settings" />;
}

export function AdminAdmsDeviceMaintenanceRoutePage() {
  const { deviceId } = useParams({ from: "/admin/attendance/devices/$deviceId/maintenance" });
  return <AdminAdmsDevicePage deviceId={deviceId} section="maintenance" />;
}

export function AdminAdmsDeviceDiagnosticsRoutePage() {
  const { deviceId } = useParams({ from: "/admin/attendance/devices/$deviceId/diagnostics" });
  return <AdminAdmsDevicePage deviceId={deviceId} section="diagnostics" />;
}
