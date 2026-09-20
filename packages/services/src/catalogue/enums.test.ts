import {
  ATTRIBUTE_MODES, COUNT_UNITS, PACKAGING_TYPES, PO_CLOSE_REASONS, PO_STATUSES, PRODUCT_ATTRIBUTES, STOCK_ACCOUNT_KINDS, STOCK_REFERENCE_TYPES,
  WRITE_OFF_REASONS, WRITE_OFF_STATUSES, VEHICLE_STATUSES, HANDOVER_STATUSES, LOAD_STATUSES, VEHICLE_RETURN_REASONS,
  ATTENDANCE_DAY_STATUSES, ATTENDANCE_SESSION_STATUSES, ODOMETER_FLAGS, CLOSING_STATUSES, NOTIFICATION_KINDS, STORE_STATUSES, CREDIT_MODES,
  SALE_STATUSES, SALE_CANCEL_REASONS, DISCOUNT_REQUEST_STATUSES, DELIVERY_DOCUMENT_STATUSES, DOCUMENT_SEND_CHANNELS, CASH_LEDGER_ENTRY_TYPES,
  SALE_CHANNELS, DISPATCH_STATUSES, DISPATCH_CLOSE_REASONS, CONFIRMATION_MODES, SHORTFALL_RESOLUTIONS, LOST_CLAIM_STATUSES, DISPATCH_EVENT_TYPES,
  RETURN_KINDS, RETURN_CONDITIONS, RETURN_OUTCOMES, SETTLEMENT_ROUTES, SETTLEMENT_STATUSES, CEILING_KINDS,
  AUDIT_STATUSES, AUDIT_OUTCOMES, SURPLUS_STATUSES,
} from '@gsa/core';
import { schema } from '@gsa/db';
import { describe, expect, it } from 'vitest';

// @gsa/db imports nothing from the project (ARCHITECTURE §2), so its enums
// repeat core's values. This keeps the two in step.
describe('database enums mirror core', () => {
  it('CAT-013: product attributes, attribute modes and count units', () => {
    expect(schema.productAttribute.enumValues).toEqual([...PRODUCT_ATTRIBUTES]);
    expect(schema.attributeMode.enumValues).toEqual([...ATTRIBUTE_MODES]);
    expect(schema.countUnit.enumValues).toEqual([...COUNT_UNITS]);
  });

  it('CAT-009: packaging types', () => {
    expect(schema.packagingType.enumValues).toEqual([...PACKAGING_TYPES]);
  });

  it('STK-013: stock accounts and movement references', () => {
    expect(schema.stockAccountKind.enumValues).toEqual([...STOCK_ACCOUNT_KINDS]);
    expect(schema.stockReferenceType.enumValues).toEqual([...STOCK_REFERENCE_TYPES]);
  });

  it('PO-001, PO-007: purchase order states and close reasons', () => {
    expect(schema.poStatus.enumValues).toEqual([...PO_STATUSES]);
    expect(schema.poCloseReason.enumValues).toEqual([...PO_CLOSE_REASONS]);
  });

  it('WRO-002: write-off states and reasons', () => {
    expect(schema.writeOffStatus.enumValues).toEqual([...WRITE_OFF_STATUSES]);
    expect(schema.writeOffReason.enumValues).toEqual([...WRITE_OFF_REASONS]);
  });

  it('VEH-001, VEH-007, VEH-009, STK-012: vehicle, load, handover and return enums', () => {
    expect(schema.vehicleStatus.enumValues).toEqual([...VEHICLE_STATUSES]);
    expect(schema.loadStatus.enumValues).toEqual([...LOAD_STATUSES]);
    expect(schema.handoverStatus.enumValues).toEqual([...HANDOVER_STATUSES]);
    expect(schema.vehicleReturnReason.enumValues).toEqual([...VEHICLE_RETURN_REASONS]);
  });

  it('ATT-005, ATT-012, STK-011: attendance, odometer and closing-stock enums; notification kinds', () => {
    expect(schema.attendanceDayStatus.enumValues).toEqual([...ATTENDANCE_DAY_STATUSES]);
    expect(schema.attendanceSessionStatus.enumValues).toEqual([...ATTENDANCE_SESSION_STATUSES]);
    expect(schema.odometerFlag.enumValues).toEqual([...ODOMETER_FLAGS]);
    expect(schema.closingStatus.enumValues).toEqual([...CLOSING_STATUSES]);
    expect(schema.notificationKind.enumValues).toEqual([...NOTIFICATION_KINDS]);
  });

  it('STO-001, CRD-001: store states and credit modes', () => {
    expect(schema.storeStatus.enumValues).toEqual([...STORE_STATUSES]);
    expect(schema.creditMode.enumValues).toEqual([...CREDIT_MODES]);
  });

  it('SAL-007, PRC-015, DOC-003, CSH-001: sale, discount request, delivery document and cash ledger enums', () => {
    expect(schema.saleStatus.enumValues).toEqual([...SALE_STATUSES]);
    expect(schema.saleCancelReason.enumValues).toEqual([...SALE_CANCEL_REASONS]);
    expect(schema.discountRequestStatus.enumValues).toEqual([...DISCOUNT_REQUEST_STATUSES]);
    expect(schema.deliveryDocumentStatus.enumValues).toEqual([...DELIVERY_DOCUMENT_STATUSES]);
    expect(schema.documentSendChannel.enumValues).toEqual([...DOCUMENT_SEND_CHANNELS]);
    expect(schema.cashLedgerEntryType.enumValues).toEqual([...CASH_LEDGER_ENTRY_TYPES]);
  });

  it('DSP-001, DSP-010, DSP-012, DSP-013: dispatch order enums and the sale channel', () => {
    expect(schema.saleChannel.enumValues).toEqual([...SALE_CHANNELS]);
    expect(schema.dispatchStatus.enumValues).toEqual([...DISPATCH_STATUSES]);
    expect(schema.dispatchCloseReason.enumValues).toEqual([...DISPATCH_CLOSE_REASONS]);
    expect(schema.confirmationMode.enumValues).toEqual([...CONFIRMATION_MODES]);
    expect(schema.shortfallResolution.enumValues).toEqual([...SHORTFALL_RESOLUTIONS]);
    expect(schema.lostClaimStatus.enumValues).toEqual([...LOST_CLAIM_STATUSES]);
    expect(schema.dispatchEventType.enumValues).toEqual([...DISPATCH_EVENT_TYPES]);
    expect(schema.returnKind.enumValues).toEqual([...RETURN_KINDS]);
    expect(schema.returnCondition.enumValues).toEqual([...RETURN_CONDITIONS]);
    expect(schema.returnOutcome.enumValues).toEqual([...RETURN_OUTCOMES]);
    expect(schema.settlementRoute.enumValues).toEqual([...SETTLEMENT_ROUTES]);
    expect(schema.settlementStatus.enumValues).toEqual([...SETTLEMENT_STATUSES]);
    expect(schema.ceilingKindFlag.enumValues).toEqual([...CEILING_KINDS]);
    expect(schema.auditStatus.enumValues).toEqual([...AUDIT_STATUSES]);
    expect(schema.auditOutcome.enumValues).toEqual([...AUDIT_OUTCOMES]);
    expect(schema.surplusStatus.enumValues).toEqual([...SURPLUS_STATUSES]);
  });
});
