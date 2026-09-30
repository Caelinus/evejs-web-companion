import type { CorporationSavedFitting, StageFittingSelection } from "./types.ts";

export function fittingsForHull(fittings: readonly CorporationSavedFitting[], hullTypeID: number): readonly CorporationSavedFitting[] {
  return fittings.filter((fit) => !fit.invalid && fit.shipTypeID === hullTypeID);
}

export function acceptStageFitting(
  selections: Readonly<Record<string, StageFittingSelection>>,
  stageID: string,
  corporationID: number,
  fit: CorporationSavedFitting,
): Record<string, StageFittingSelection> {
  if (fit.invalid || fit.ownerID !== corporationID || !fit.fingerprint || !fit.savedDate) {
    throw new Error("Corporation fitting cannot be accepted.");
  }
  return { ...selections, [stageID]: {
    scope: "CORPORATION", ownerID: corporationID, fittingID: fit.fittingID,
    acceptedFingerprint: fit.fingerprint, acceptedSavedDate: fit.savedDate,
  } };
}
