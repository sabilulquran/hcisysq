import { DeviceAdminProvider } from "@/components/attendance/device-admin/DeviceAdminContext";
import { DeviceDetailShell, type DeviceAdminSection } from "@/components/attendance/device-admin/DeviceDetailShell";
import { LongRangeRecoveryPanel } from "@/components/attendance/device-admin/LongRangeRecoveryPanel";
import { MappingReviewPanel } from "@/components/attendance/device-admin/MappingReviewPanel";
import { AdminAdmsDeviceBiometricsPage } from "@/pages/AdminAdmsDeviceBiometricsPage";
import { AdminAdmsDeviceCommandsPage } from "@/pages/AdminAdmsDeviceCommandsPage";
import { AdminAdmsDeviceDataPage } from "@/pages/AdminAdmsDeviceDataPage";
import { AdminAdmsDeviceDiagnosticsPage } from "@/pages/AdminAdmsDeviceDiagnosticsPage";
import { AdminAdmsDeviceOperationsPage } from "@/pages/AdminAdmsDeviceOperationsPage";
import { AdminAdmsDeviceMaintenancePage } from "@/pages/AdminAdmsDeviceMaintenancePage";
import { AdminAdmsDeviceOverviewPage } from "@/pages/AdminAdmsDeviceOverviewPage";
import { AdminAdmsDevicePhysicalDeliveryPanel } from "@/pages/AdminAdmsDevicePhysicalDeliveryPanel";
import { AdminAdmsDevicePhysicalParityPage } from "@/pages/AdminAdmsDevicePhysicalParityPage";
import { AdminAdmsDeviceSettingsPage } from "@/pages/AdminAdmsDeviceSettingsPage";
import { AdminAdmsDeviceTransactionsPage } from "@/pages/AdminAdmsDeviceTransactionsPage";
import { AdminAdmsDeviceUsersPage } from "@/pages/AdminAdmsDeviceUsersPage";

function sectionContent(section: DeviceAdminSection) {
  if (section === "overview") return <AdminAdmsDeviceOverviewPage />;
  if (section === "users") {
    return (
      <>
        <MappingReviewPanel />
        <div id="device-user-list">
          <AdminAdmsDeviceUsersPage />
        </div>
      </>
    );
  }
  if (section === "biometrics") return <AdminAdmsDeviceBiometricsPage />;
  if (section === "data") return <AdminAdmsDeviceDataPage />;
  if (section === "transactions") {
    return (
      <>
        <AdminAdmsDeviceTransactionsPage />
        <LongRangeRecoveryPanel />
      </>
    );
  }
  if (section === "commands") return <AdminAdmsDeviceMaintenancePage />;
  if (section === "settings") return <AdminAdmsDeviceSettingsPage />;
  if (section === "maintenance" || section === "operations") return <AdminAdmsDeviceMaintenancePage />;
  if (section === "diagnostics") {
    return (
      <>
        <AdminAdmsDeviceDiagnosticsPage />
        <AdminAdmsDeviceOperationsPage />
        <AdminAdmsDevicePhysicalParityPage />
        <AdminAdmsDevicePhysicalDeliveryPanel />
      </>
    );
  }
  return null;
}

export function AdminAdmsDevicePage({ deviceId, section }: { deviceId: string; section: DeviceAdminSection }) {
  return (
    <DeviceAdminProvider deviceId={deviceId}>
      <DeviceDetailShell section={section}>
        {sectionContent(section)}
      </DeviceDetailShell>
    </DeviceAdminProvider>
  );
}
