import { z } from "zod";

// ENG-LIST-001 offset pagination shared by every paged list endpoint
// (docs/development/list-pagination-standard.md §3.1).
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

// Out-of-range values fail validation (400) instead of being clamped, so a client never
// silently receives fewer rows than it asked for.
export const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export type PageQuery = z.infer<typeof pageQuerySchema>;

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
}

export function pageOffset({ page, pageSize }: PageQuery): number {
  return (page - 1) * pageSize;
}

export function pagination({ page, pageSize }: PageQuery, total: number): Pagination {
  return { page, pageSize, total, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}
