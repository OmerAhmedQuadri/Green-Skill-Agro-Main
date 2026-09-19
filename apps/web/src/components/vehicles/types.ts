import type { vehicles } from '@gsa/services';

export type Vehicle = vehicles.Vehicle;
export type VehicleListItem = Awaited<ReturnType<typeof vehicles.listVehicles>>[number];
export type Load = vehicles.Load;
export type LoadProposal = vehicles.LoadProposal;
export type VehicleReturn = vehicles.VehicleReturn;
export type Seller = Awaited<ReturnType<typeof vehicles.listSellers>>[number];
export type ClosingDeclaration = vehicles.ClosingDeclaration;
export const RETURN_REASONS = ['EXPIRY_RECALL', 'REDISTRIBUTION', 'SELLER_LEAVING', 'STORE_RETURN', 'VEHICLE_WITHDRAWN', 'MANAGER_RECALL'] as const;
export const LOAD_TONE = { ISSUED: 'warning', DISPUTED: 'danger', CONFIRMED: 'success', CANCELLED: 'neutral' } as const;
