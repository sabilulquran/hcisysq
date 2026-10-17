import { Landmark } from "lucide-react";

import { canAccessBoard } from "@/lib/authorization";
import type { AuthSession } from "@/types/hcis";

// ORG-010 §1.4: shown only when /auth/me lists board.read; hiding it is not authorization.
const boardNavigation = { label: "Panel Organ Yayasan", href: "/board", icon: Landmark, category: "task" } as const;

export function boardNavigationFor(session: AuthSession | null) {
  return session?.principal.principalType === "EMPLOYEE" && canAccessBoard(session) ? [boardNavigation] : [];
}
