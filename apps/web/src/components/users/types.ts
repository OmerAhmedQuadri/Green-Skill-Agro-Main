export type Role = 'SUPER_ADMIN' | 'ADMIN' | 'MANAGER' | 'SELLER';
export type Account = {
  id: string; role: Role; name: string; email: string | null; phone: string | null;
  status: 'ACTIVE' | 'DEACTIVATED'; locale: 'en' | 'ar'; mustChangePassword: boolean; version: number;
};
export type AccountDetail = Account & {
  permissions: string[]; overrides: { permission: string; granted: boolean }[]; configurable: string[];
};
