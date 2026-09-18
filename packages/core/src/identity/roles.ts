/** Four role tiers, each inheriting the capability of the tier below (USR-001). */
export const ROLES = ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'SELLER'] as const;
export type Role = (typeof ROLES)[number];
