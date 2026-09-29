export interface ResourcePolicy {
  readonly mode: "ANY_ELIGIBLE" | "PREFER_LIST";
  readonly source: "MANUAL";
  readonly typeIDs: readonly number[];
}

/** Eligible, authoritatively observed resources only. Preference never empties
 * a nonempty candidate set and therefore cannot manufacture target depletion. */
export function preferredResources<T extends { miningYieldTypeID: number | null }>(rows: readonly T[], policy?: ResourcePolicy | null): readonly T[] {
  if (policy?.mode !== "PREFER_LIST" || rows.length === 0) return rows;
  const rank = (row: T) => {
    const index = row.miningYieldTypeID === null ? -1 : policy.typeIDs.indexOf(row.miningYieldTypeID);
    return index < 0 ? policy.typeIDs.length : index;
  };
  const best = Math.min(...rows.map(rank));
  return rows.filter(row => rank(row) === best);
}
