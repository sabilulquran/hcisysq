import type { AdminServiceCategory } from "@/lib/adminServices";
import type { EmployeeServiceCategory } from "@/lib/employeeServices";

/**
 * Service category accents from SQ Core direction C (sabilulquran/SQ-Hub
 * docs/design/sq-core-design-system-c.md). They colour icons, labels and
 * markers only; action buttons always stay primary teal and status colours
 * never stand in for a category.
 */
export type ServiceCategoryTone = "attendance" | "leave" | "pay" | "service" | "task";

/** Soft tile with the category icon colour, e.g. the icon square on a service card. */
export const categoryTileClass: Record<ServiceCategoryTone, string> = {
  attendance: "bg-cat-attendance-soft text-cat-attendance",
  leave: "bg-cat-leave-soft text-cat-leave",
  pay: "bg-cat-pay-soft text-cat-pay",
  service: "bg-cat-service-soft text-cat-service",
  task: "bg-cat-task-soft text-cat-task",
};

/** Bare icon colour, e.g. a navigation marker. */
export const categoryIconClass: Record<ServiceCategoryTone, string> = {
  attendance: "text-cat-attendance",
  leave: "text-cat-leave",
  pay: "text-cat-pay",
  service: "text-cat-service",
  task: "text-cat-task",
};

const employeeCategoryTone: Record<EmployeeServiceCategory, ServiceCategoryTone> = {
  "time-attendance": "attendance",
  leave: "leave",
  tasks: "task",
  finance: "pay",
  development: "service",
  "employee-services": "service",
  information: "service",
};

const adminCategoryTone: Record<AdminServiceCategory, ServiceCategoryTone> = {
  attendance: "attendance",
  "payroll-benefits": "pay",
  talent: "service",
  "employee-services": "service",
  organization: "service",
};

export function employeeCategoryToneOf(category: EmployeeServiceCategory): ServiceCategoryTone {
  return employeeCategoryTone[category];
}

export function adminCategoryToneOf(category: AdminServiceCategory): ServiceCategoryTone {
  return adminCategoryTone[category];
}
