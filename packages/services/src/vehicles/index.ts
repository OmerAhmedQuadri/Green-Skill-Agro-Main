export {
  listVehicles, getVehicle, createVehicle, updateVehicle, assignVehicle, unassignVehicle,
  confirmHandover, cancelHandover, listMyHandovers, listSellers, type Vehicle, type Handover,
} from './register';
export { getMyVehicle, vehicleBatches, basePrices, type VehicleBatch, type MyVehicle, type MyVehicleBatch } from './stock';
export {
  proposeLoad, issueLoad, amendLoad, cancelLoad, confirmLoad, disputeLoad, listLoads, getLoad, type Load, type LoadProposal, type ProposedBatch,
} from './loads';
export { recordVehicleReturn, listVehicleReturns, type VehicleReturn } from './returns';
export { declareClosingStock, reviewClosingStock, listClosingStock, type ClosingDeclaration } from './closing';
