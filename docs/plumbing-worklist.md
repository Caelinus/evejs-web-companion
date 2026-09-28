# Plumbing worklist — the complete map (canonical driver)

Complete enumeration of every retail-client `{service, method}` that has an eve.js handler and is not yet allowlisted. Produced 2026-07-22 by a fan-out over the decompiled client cross-referenced against eve.js handlers + our allowlist. **588 plumbable pairs.** This doc drives the plumbing loop; the worklist body (phases/batches) follows the header.

> **CORRECTION 2026-07-27:** “complete” below means complete against this document's
> 588-row inventory, not complete against `ClientCodeGrabber/Latest`. A fresh fleet
> feature audit found 17 Latest-used, EveJS-handled calls that this inventory omitted:
> 15 bound `fleetObjectHandler` methods and two `fleetProxy` methods. The checked
> cross-repo manifest is the authority for what is currently allowlisted; feature-level
> Latest source review is still required. Do not repeat “588/588” as a full-parity claim.

> **🏁 STATUS 2026-07-23 — SWEEP COMPLETE: 588/588 plumbed.** 287/287 reads (R57–R85) + 301/301 writes (R86–R106), every batch orchestrator-verified, zero de-allowlisted. The final 3 (marketProxy PLEX/instant-buy financials, R106) were operator-authorized and plumbed reachability-only. All writes confirm-gated; NOT ONE fired live (fast mode — educated-guess decoders/args, QA deferred by operator directive). No UI built (bridge-only). Open follow-ups: (1) the live QA pass over all fast-mode writes (the 3 marketProxy financials need extra care — reachability-only so far); (2) the 30 read + 18 write arg-injection leaks + 1 bind-gateway in `docs/arg-injection-leak-handoff.md` (flag-only, separate session); (3) UI. See `docs/afk-session-log.md` for the full per-batch record.

## Orchestrator plan & scale (READ THIS FIRST)

**Scale is large: 588 pairs ≈ many worker cycles.** The plumbing loop wires them in coherent batches per the PLUMBING CONTRACT (`docs/goal-prompts/r57-plumbing-toplevel-reads.md`): allowlist pair + BFF passthrough + decoder from real bytes + tests, **no UI**.

**Order = reads before writes, top-level before bound:** Phase 1 (top-level reads) → Phase 2 (bound reads) → Phase 3 (top-level writes) → Phase 4 (bound writes).

**Both reads AND writes AUTHORIZED by the operator 2026-07-22:** *"do the writes … remember those are way more situational, so do online research if needed to know context of each operation. But I auth you to get all reads and writes plumbed."* Reads first (UI needs them), then writes.

**READS ownership-leak rule (R63, mandatory per read):** a read is safe to allowlist only if it returns the session's own data OR genuinely public data. Verify LIVE what each read returns for an un-owned entity; skip + cite any that leaks another entity's private/operational data (`GetStructures`, `GetMyCharacterStructures` were skipped for leaking rival structures' fuel/reinforce/vulnerability). The orchestrator's "safe" labels are hints, not guarantees.

**WRITES contract (situational — the operator's caveat):**
- Each write = allowlist pair + BFF **POST** route with an explicit **confirm-gate** (no confirm ⇒ refused, like the existing `TrashItems`/`dockAt` pattern) + response decoder + tests.
- **A 200 is not proof** — a write is confirmed only by re-reading authority.
- **Research context when the operation's semantics/consequences aren't obvious** (WebSearch the EVE operation). Note per write what it does.
- **Live-trigger policy by consequence:** SAFE/reversible writes (`MarkAsRead`, `SetNote`, label edits) may be triggered live and re-read to confirm. FINANCIAL/DESTRUCTIVE writes (`GiveCash`/`GiveCashFromCorpAccount`, `EmptyTrash`/`DeleteMail`/`DeleteContract`, `AcceptContract`/`PlaceBid`, `BuyKillRight`, `InsureShip`, `Eject`/`SafeLogoff`, `TakeOffer`, `BuyMultipleItems`) are verified by **reachability + refusal path only** — do NOT trigger the destructive/financial happy-path on the live world; the confirm-gate must exist and the route must be reachable, but the mutation stays untriggered. Document per write: live-triggered-and-reverted vs reachability-only.
- **GM/admin-gated writes** (`GM_ExpireContract`, `sovMgr.*Skyhooks`) — wire the pair but expect a normal session to 403; note it.

**Each wiring worker must one-line-grep-confirm the `Handle_<Method>` exists before adding a pair** — the handler cites below are inherited from a third-hand enumeration, not independently re-grepped in the consolidation pass. Cheap insurance against a wasted cycle.

**Already done** (not in the 588): R37 assets, R50 corp-wallet, R54 wallet ledger, R55 standings, R56 character sheet, R57 (charFittingMgr.GetFittings, bountyProxy.GetMyKillRights, LPSvc reads), R58 (charMgr social reads — in flight).

---

# EVEJS BFF PLUMBING WORKLIST

Consolidated from the 715 raw rows. Deduplicated by `{service, method}`. Excluded: everything `allowlisted:true` (already wired) and every `NO HANDLER` / name-mismatch row (server work, out of scope). Handler cites are **inherited from the input enumeration, not independently re-grepped** against the handler files in this pass — the wiring worker should do a one-line grep to confirm `Handle_<Method>` exists before adding each pair (cheap insurance; the input is a third-hand enumeration).

Paths without a leading `server/src/...` are relative to `eve.js/server/src/services/`. Allowlist lives in `evejsWebGatewayRuntime.js` (`WEB_CALL_ALLOWLIST`); BFF routes in `evejs-web-poc/src/server.js`.

---

## HARD COUNT

| | reads | writes | total |
|---|---|---|---|
| **top-level** | 176 | 152 | 328 |
| **bound** | 111 | 149 | 260 |
| **total** | **287** | **301** | **588** |

**588 plumbable pairs remain** (excludes the 5 verify-first pairs below, which are NOT in the 588).

Excluded as unplumbable (do not spend a worker on these): `charMgr.GetLocation`, `standingMgr.GetStandingMatrix`, `standingMgr.IsKnownToBeAPlayerCorp`, `crimewatch.GetSafetyLevel`, `skillMgr.GetSkillBundleInfo` (all NO HANDLER), and `securityMgr.get_modified_security_level` (NAME MISMATCH — server only has `Handle_get_modified_systems`; the exact method the client calls does not exist).

---

## VERIFY-FIRST (confirm before wiring — NOT counted in the 588)

1. **certificateMgr** — `GetMyCertificates` (read, certificateMgrService.js:39), `GrantCertificate` (write, :60), `BatchCertificateGrant` (write, :79). Handlers exist but binding is `unknown` and **no client remote-call site was found** (retail derives cert levels client-side from skills). Wire only if a page actually needs them.
2. **bookmarkMgr.GetBookmarks** (read, bookmark/bookmarkService.js:27) — LEGACY. Server-implemented, but the current client routes bookmarks through `accessGroupBookmarkMgr`. No client call site. Skip unless legacy path is needed.
3. **dogmaIM.CharGetInfo** (read, dogmaService.js:9189) — labeled BFF-only convenience, **not found in client source**. `GetAllInfo` is the real client bootstrap. Confirm it's wanted before wiring.
4. **warStatisticMgr.GetKillMail** (read, warStatisticMgrService.js:178) — **binding ambiguous**: reachable top-level AND bound via `GetWarStatistic` moniker. I placed it in top-level reads (Batch R-WAR2); confirm which binding the BFF should expose.
5. **Admin/GM-gated writes** (handlers exist, but gating may reject a normal session): `contractProxy.GM_ExpireContract`, `sovMgr.DestroySkyhooks`, `sovMgr.AcquireSkyhooks`. Counted in the write totals but flag at wire-time — a normal char session likely 403s.

---

## PHASE 1 — TOP-LEVEL READS (176) — safest, wire first

**R-CHAR1 charMgr (12):** GetPublicInfo (charMgrService.js:510), GetHomeStationRow (:666), GetPaperdollState (:700), GetCharacterCreationDate (:707), GetSettingsInfo (:723), GetRecentShipKillsAndLosses (:559), GetCohortsForCharacter (:553), GetPrivateInfoOnCorpChange (:602), GetContactList (:730), GetNote (:1040), GetOwnerNote (:1001), GetOwnerNoteLabels (:987).

**R-CHAR2 charUnboundMgr (7):** GetCohortsForUser (charService.js:1191), GetCharacterLockType (:1511), GetNumCharacters (:1107), GetCharacterInfo (:1248), GetValidRandomName (:1468), ValidateNameEx (:1501), GetQAStarterSystemIDs (:1474).

**R-SKILLGW skillMgr2 (1):** GetMySkillHandler (skillMgr2Service.js:8) — **returns a Moniker/bound object**; wiring this is the gateway that all Phase-2 skillMgr bound reads hang off. Wire trap: response is a bound-object reference, not data.

**R-MAILAUX (5):** mailMgr.GetLabels (mailMgrService.js:398); mailingListsMgr GetJoinedLists (mailingListsMgrService.js:118), GetInfo (:124), GetMembers (:170), GetSettings (:238).

**R-NOTIF notificationMgr (3):** GetByGroupID (:75), GetAllNotifications (:61), GetUnprocessed (:89).

**R-CAL (4):** calendarMgr GetResponsesForCharacter (calendarMgrService.js:150), GetResponsesToEvent (:156); calendarProxy GetEventList (calendarProxyService.js:13), GetEventDetails (:20).

**R-BM accessGroupBookmarkMgr (3):** GetMyActiveBookmarks (:97), GetFolderInfo (:202), SearchFoldersWithAdminAccess (:218).

**R-FIT (4):** charFittingMgr.GetFittings (charFittingMgrService.js:31); corpFittingMgr GetFittings (corpFittingMgrService.js:35), GetCommunityFittings (:50); allianceFittingMgr.GetFittings (allianceFittingMgrService.js:31).

**R-INS insuranceSvc (4):** GetContractForShip (:59), GetInsurancePrice (:43), GetInsurancePrices (:50), GetContracts (:23).

**R-BOUNTY bountyProxy (9):** GetBounties (bountyProxyService.js:460), GetMyBounties (:490), GetMyKillRights (:500), GetKillRightsOnCharacters (:510), GetBountiesAndKillRights (:469), GetTopPilotBounties (:592), GetTopCorpBounties (:596), GetTopAllianceBounties (:600), SearchCharBounties (:616).

**R-PET petitioner (8):** GetMyPetitionsEx (:136), GetCategories (:158), GetCategoryHierarchicalInfo (:163), GetPetitionMessages (:219), MayPetition (:195), IsZendeskEnabled (:103), GetZendeskJwtLink (:118), GetUnreadMessages (:124).

**R-LOOKUP lookupSvc (9):** LookupCharacters (lookupSvcService.js:445), LookupOwners (:498), LookupPCOwners (:515), LookupEvePlayerCharacters (:454), LookupCorporations (:480), LookupFactions (:489), LookupKnownLocationsByGroup (:553), LookupNoneNPCAccountOwners (:531), LookupWarableCorporationsOrAlliances (:576).

**R-ONLINE onlineStatus (3):** GetOnlineStatus (:31), GetInitialState (:41), Prime (:48).

**R-SOCIAL (2):** LSC.GetChannels (lscService.js:46); account.GetDefaultContactCost (accountService.js:628).

**R-LP (2):** LPSvc.GetAllMyCorporationWalletLPBalances (lpService.js:100); LPStoreMgr.GetAvailableOffersFromCorp (lpStoreMgrService.js:520).

**R-CORPMGR corpmgr (9):** GetPublicInfo (corpmgrService.js:439), GetCorporationIDForCharacter (:475), GetCorporations (:481), GetAssetInventory (:534, **wire trap: CRowset via buildCachedMethodCallResult**), GetAssetInventoryForLocation (:553, **CRowset**), SearchAssets (:574), GetAggressionSettings (:487), GetAggressionSettingsForCorps (:500), AuditMember (:510).

**R-MARKET marketProxy (7):** GetCorporationOrders (marketProxyService.js:3498), CorpGetTransactions (:3597, bigint amounts), GetPlexOrders (:3711), GetPlexBest (:3670), GetPlexHistory (:3754), GetPlexOldPriceHistory (:3768), GetPlexNewPriceHistory (:3780).

**R-CONTRACT contractProxy (7):** GetMyBids (contractProxyService.js:728), GetMyContractEscrow (:703), NumOutstandingContracts (:712), GetItemsInContainer (:865), GetItemsInDockableLocation (:878), GetNumItemsInContainers (:873), GetCourierContractFromItemID (:896).

**R-PITOP planetMgr top (2):** GetPlanetsForChar (planetMgrService.js:942), GetMyLaunchesDetails (:1296).

**R-WAR1 warsInfoMgr (6):** GetWarsByOwnerID (warsInfoMgrService.js:146), GetWarsByOwners (:159), GetTop50 (:191), GetWarsRequiringAssistance (:174), GetWarsForStructure (:215), GetPublicWarInfo (:209).

**R-WAR2 warStatisticMgr (1):** GetKillMail (warStatisticMgrService.js:178) — **verify-first binding (see above)**.

**R-AGENT agentMgr (9):** GetMissionJournalInfo (agentMgrService.js:828), GetEntryPoint (:900), GetAgentStaticInfo (:697), GetSolarSystemOfAgent (:678), GetCompletedCareerAgentIDs (:683), GetMyEpicArcStatus (:730), GetInfoServiceDetails (:871), GetDungeonShipRestrictions (:891), GetAgentByID (:1113).

**R-STRUCT structureDirectory (13):** GetMyCharacterStructures (structureDirectoryService.js:432), GetMyCorporationStructures (:438), GetCorporationStructures (:453), GetMyDockableStructures (:457), GetStructures (:469), GetStructureMapData (:489), GetStructureDescription (:507), CheckMyDockingAccessToStructures (:544), GetMyAccessibleOnlineCynoBeaconStructures (:553), GetSolarSystemsWithBeacons (:572), GetValidWarHQs (:587), GetJumpBridgesWithMyAccess (:607), GetNearbyJumpBridges (:612).

**R-SAFETY structureAssetSafety (4):** GetItemsInSafetyForCharacter (:182), GetItemsInSafetyForCorp (:191), GetWrapNames (:208), GetStructuresICanDeliverTo (:219).

**R-SOV sovMgr (6):** GetSovStructuresInfoForLocalSolarSystem (sovMgrService.js:29), GetSovStructuresInfoForSolarSystem (:43), GetSystemSovereigntyInfo (:51), GetInfrastructureHubInfo (:56), GetSovHubFuelAccessGroup (:61), IsOnLocalSovHubFuelAccessGroup (:72).

**R-ESS essMgr (4):** GetDataForClientSolarSystem (essMgrService.js:194), IsClientLinkedToReserveBank (:205), GetMainBankTheftsForClientSolarSystem (:314), GetReserveBankTheftsForClientSolarSystem (:325).

**R-PVP pvpFilamentMgr (6):** GetAllEvents (pvpFilamentMgrService.js:113), GetActiveEvents (:118), GetMostRecentEvent (:123), GetNextEventDate (:128), GetLeaderboard (:133), GetCharacterStatistics (:139).

**R-FLEETADS fleetProxy (2):** GetAvailableFleetAds (fleetProxyService.js:15), GetMyFleetFinderAdvert (:39).

**R-MAP map (17):** GetStationCount (mapService.js:659), GetSolarsystemItems (:572), GetHistory (:495), GetSolarSystemVisits (:510), GetBeaconCount (:517), GetCurrentSovData (:590), GetRecentSovActivity (:596), GetFacWarZoneInfo (:581), GetDeadspaceAgentsMap (:526), GetDeadspaceComplexMap (:532), GetMyExtraMapInfo (:551), GetMyExtraMapInfoAgents (:556), GetConstellationLPData (:561), GetAllRoamingWeatherSystems (:567), GetSecurityModifiedSystems (:436), GetIncursionGlobalReport (:475), GetSystemsInIncursions (:485).

**Gateway MachoBindObjects wired as top-level reads (needed before their Phase-2 bound batches): 4** — dogmaIM.MachoBindObject (dogmaService.js:9601), entity.MachoBindObject (entityService.js:25), scanMgr.GetSystemScanMgr (scanMgrService.js:1534), fleetObjectHandler.MachoBindObject (fleetObjectHandlerService.js:106). All `bound-only` wire-trap gateways. Plus beyonce.GetFormations (beyonceService.js:1752) and ship.GetShipConfiguration (shipService.js:1771) as standalone top-level reads. *(These 6 are already included in the 176 count under their services.)*

---

## PHASE 2 — BOUND READS (111) — need a Moniker/bind step first

**RB-SKILL skillMgr (13)** — hang off `GetMySkillHandler` (Phase 1 R-SKILLGW): GetSkills (skillMgrService.js:317), GetAllSkills (:322), GetAttributes (:312), GetSkillHistory (:280), GetSkillChangesForISIS (:297), GetRespecInfo (:421), GetFreeSkillPoints (:469), GetBoosters (:448), GetImplants (:453), CheckInjectionConstraints (:541), GetSkillPoints (:302), GetDiminishedSpFromInjectors (:552), GetSkillQueue (:275).

**RB-CLONE jumpCloneSvc (6)** — Moniker keyed on solarsystem/station: GetCloneState (jumpCloneService.js:40), GetStationCloneState (:45), GetShipCloneState (:50), GetNumClonesInPilotsStructure (:55), GetPriceForClone (:60), ValidateInstallJumpClone (:65).

**RB-CRIME crimewatch (4)** — bound Moniker (CharGetCrimewatchLocation): GetClientStates (crimewatchService.js:56), GetMySecurityStatus (:82), GetCharacterSecurityStatus (:98), GetSecurityStatusTransactions (:116).

**RB-CORPREG corpRegistry (34)** — bound to corpID (eveMoniker.GetCorpRegistry): GetInfoWindowDataForChar (corpRegistryRuntime.js:2960), GetEveOwners (:1329), GetShareholders (:2189), GetSharesByShareholder (:2175), GetMember (:1935), GetMembersPaged (:1911), GetMembersByIds (:1924), GetMemberTrackingInfo (:2086), GetMemberTrackingInfoSimple (:2101), GetMemberIDsByQuery (:2072), GetMemberIDsWithMoreThanAvgShares (:2818), GetPendingAutoKicks (:2067), GetNumberOfPotentialCEOs (:2105), GetTitles (:2110), GetLabels (:1419), GetCorporateContacts (:1350), GetBulletins (:1524), GetApplications (:1667), GetMyApplications (:1642), GetMyOldApplications (:1657), GetOldApplications (:1673), GetAllianceApplications (:2380), GetCorpWelcomeMail (:1816), GetRecentKills (:2922), GetRecentLosses (:2941), GetAggressionSettings (:2615), GetSuggestedTickerNames (:2497), GetSuggestedAllianceShortNames (:2503), GetStructureReinforceDefault (:2691), DoesMyCorpAcceptStructures (:2659), DoesCorpRestrictCorpMails (:2675), CanLeaveCurrentCorporation (:2743), CanBeKickedOut (:2760), CharGetAllyBaseCost (:2716).

**RB-ALLYREG allianceRegistry (15)** — bound to allianceID: GetAlliance (allianceRegistryRuntime.js:374), GetAlliancePublicInfo (:379), GetRankedAlliances (:384), GetAllianceMembers (:395), GetAllianceMembersOlderThan (:972), GetDaysInAlliance (:966), GetEmploymentRecord (:405), GetRelationships (:816), GetAllianceContacts (:553), GetApplications (:432), GetBulletins (:714), GetBills (:895), GetBillBalance (:913), GetCapitalSystemInfo (:866), GetPrimeTimeInfo (:851).

**RB-PI planetMgr bound (7)** — bound to planetID: GetPlanetInfo (planetMgrService.js:954), GetPlanetResourceInfo (:965), GetResourceData (:979), GetFullNetworkForOwner (:1039), GetCommandPinsForPlanet (:1056), GetExtractorsForPlanet (:1074), GetProgramResultInfo (:1270).

**RB-PITAX planetOrbitalRegistryBroker (1)** — bound to solarSystemID: GetTaxRate (planetOrbitalRegistryBrokerService.js:45).

**RB-WARREG warRegistry (4)** — bound to owner (eveMoniker.GetWar): GetWars (warRegistryService.js:169), GetNegotiations (:177), GetWarNegotiation (:255), IsAllianceOrCorpLocal (:157).

**RB-CORPSTN corpStationMgr (1)** — bound to stationID: DoStandingCheckForStationService (corpStationMgrService.js:183).

**RB-DOGMA dogmaIM (11)** — off dogmaIM.MachoBindObject bind (ship location manager): GetAllInfo (dogmaService.js:8802, full ship+char+module snapshot), ItemGetInfo (:9196), GetTargeters (:6766), GetDroneSettingAttributes (:5301), GetCharacterAttributes (:5275), GetRequiredSkillLevels (:5305), GetLayerDamageValuesByItems (:5418), QueryAllAttributesForItem (:9371), QueryAttributeValue (:9377), FullyDescribeAttribute (:9391), GetLocationInfo (:9417).

**RB-INV invbroker (8)** — off invbroker bind (GetInventory/GetInventoryFromId/MachoBindObject, already allowlisted): GetContainerContents (invBrokerService.js:7102), GetItem (:6621), GetItems (:6655), ListDroneBay (:8387), ListFighterBay (:8393), GetItemDescriptor (:8547), GetAvailableTurretSlots (:8553), GetDamageForCrystals (:6713).

**RB-SCAN scanMgr bound (2)** — off GetSystemScanMgr: GetFullState (scanMgrService.js:1569), GetScanTargetID (:1660).

**RB-FLEET fleetObjectHandler bound (5)** — off MachoBindObject: GetInitState (fleetObjectHandlerService.js:138), GetWings (:152), GetMotd (:159), GetJoinRequests (:163), GetFleetComposition (:169).

---

## PHASE 3 — TOP-LEVEL WRITES (152) — confirm-gated

Reads must be wired before these. **Bold = extra-danger** (irreversible / financial — enforce explicit confirm even beyond normal write-gating).

**W-CHAR1 charMgr (12):** SetCharacterDescription (charMgrService.js:945), SetActivityStatus (:956), LogSettings (:975), AddContact (:887), DeleteContacts (:906), EditContactsRelationshipID (:914), BlockOwners (:929), UnblockOwners (:937), SetNote (:1047), AddOwnerNote (:1014), EditOwnerNote (:1022), RemoveOwnerNote (:1032).

**W-CHAR2 charUnboundMgr (5):** **CancelCharacterDeletePrepare** (charService.js:1456), ToggleValidation (:1480), **CreateCharacterWithDoll** (:824), UpdateCharacterGender (:1116), UpdateCharacterBloodline (:1144).

**W-MAIL mailMgr (13):** MoveToTrash (mailMgrService.js:220), MoveFromTrash (:231), MarkAsRead (:190), MarkAsUnread (:205), **DeleteMail** (:387), **EmptyTrash** (:376, permanent delete), CreateLabel (:408), EditLabel (:427), DeleteLabel (:435), AssignLabels (:440), RemoveLabels (:454), MarkAllAsRead (:331), MoveAllToTrash (:242).

**W-MLIST mailingListsMgr (3):** Join (:143), Leave (:151), Create (:132).

**W-NOTIF notificationMgr (7):** MarkGroupAsProcessed (:97), MarkAllAsProcessed (:112), MarkAsProcessed (:122), **DeleteGroupNotifications** (:132), **DeleteAllNotifications** (:149), **DeleteNotifications** (:161), LogNotificationInteraction (:173).

**W-CAL calendarMgr (7):** CreatePersonalEvent (:22), CreateCorporationEvent (:42), CreateAllianceEvent (:59), EditPersonalEvent (:76), **DeleteEvent** (:100), SendEventResponse (:110), UpdateEventParticipants (:127).

**W-BM accessGroupBookmarkMgr (7):** AddFolder (:119), UpdateFolder (:149), **DeleteFolder** (:183), BookmarkStaticLocation (:303), UpdateBookmark (:379), **DeleteBookmarks** (:413), MoveBookmarksToFolderAndSubfolder (:436).

**W-FIT (5):** charFittingMgr SaveManyFittings (charFittingMgrService.js:67), **DeleteFitting** (:86), **DeleteManyFittings** (:103), UpdateNameAndDescription (:120); corpFittingMgr SaveManyFittings (corpFittingMgrService.js:88).

**W-INS insuranceSvc (2):** **InsureShip** (insuranceService.js:66, spends ISK), UnInsureShip (:82).

**W-BOUNTY (5):** bountyProxy **AddToBounty** (bountyProxyService.js:376, spends ISK), SellKillRight (:525), CancelSellKillRight (:554); killRightMgr **ActivateKillRight** (killRightMgrService.js:171), **BuyKillRight** (:197, spends ISK).

**W-PET petitioner (3):** CreatePetition (petitionerService.js:203), PetitionerChat (:226), CancelPetition (:249).

**W-SOCIAL (1):** LSC.SendMessage (lscService.js:80).

**W-ISK account (3):** SetContactCost (accountService.js:632), **GiveCash** (:697, ISK transfer), **GiveCashFromCorpAccount** (:739, corp ISK transfer).

**W-LP (5):** LPSvc **ExchangeConcordLP** (lpService.js:164), **TransferLPFromMyWalletToOtherCorp** (:120), **TransferLPFromMyCorpWalletToOtherCorp** (:137); LPStoreMgr **TakeOfferForCharacter** (lpStoreMgrService.js:543), **TakeOfferForCorporation** (:569).

**W-MARKET marketProxy (3):** **PlacePlexSellOrder** (marketProxyService.js:4003), ModifyPlexCharOrder (:4245), **BuyMultipleItems** (:3911, instant-buy spends ISK).

**W-CONTRACT contractProxy (11):** CreateContract (contractProxyService.js:803), **AcceptContract** (:819), CompleteContract (:826), **DeleteContract** (:835), **DeleteMultipleContracts** (:841), **PlaceBid** (:850, ISK), FinishAuction (:855), SplitStack (:860), DeleteNotification (:886), DeleteContractNotification (:891), **GM_ExpireContract** (:908, **admin — verify-first**).

**W-IND industryManager (1):** CompleteManyJobs (industryManagerService.js:73).

**W-PITOP planetMgr top (1):** DeleteLaunch (planetMgrService.js:1304).

**W-SHIP ship (14):** Eject (shipService.js:1746), LeaveShip (:1586), BoardStoredShip (:1602), StoreVessel (:1641), AssembleShip (:1327), FitShips (:1469), ConfigureShip (:1797), Scoop (:1173), ScoopToMobileDepotHold (:1191), Jettison (:1240), LaunchFromShip (:1254), LaunchFromContainer (:1267), Drop (:1294), SafeLogoff (:1869).

**W-FIGHTER fighterMgr (9):** LoadFightersToTube (fighterMgrService.js:305), UnloadTubeToFighterBay (:348), LaunchFightersFromTubes (:373), RecallFightersToTubes (:381), ExecuteMovementCommandOnFighters (:395), CmdActivateAbilitySlots (:406), CmdDeactivateAbilitySlots (:423), CmdAbandonFighter (:439), CmdScoopAbandonedFighterFromSpace (:447). *(fighterMgr.GetFightersForShip :263 is the one read, in Phase 1.)*

**W-AGENT agentMgr (4):** RemoveOfferFromJournal (agentMgrService.js:856), GotoLocation (:910), WarpToLocation (:936), WarpToAgentInSpace (:1048).

**W-STRUCT structureDirectory (1):** SetStructureDescription (structureDirectoryService.js:517).

**W-SAFETY structureAssetSafety (3):** MovePersonalAssetsToSafety (:254), MoveCorpAssetsToSafety (:271), MoveSafetyWrapToStructure (:288).

**W-SOV sovMgr (3):** SetSovHubFuelAccessGroup (sovMgrService.js:66), **DestroySkyhooks** (:76, **admin — verify-first**), **AcquireSkyhooks** (:80, **admin — verify-first**).

**W-ESS essMgr (5):** AttemptLinkToMainBank (essMgrService.js:214), AttemptLinkToReserveBank (:239), RequestMainBankUnlink (:264), RequestReserveBankUnlink (:279), **RequestUnlockReserveBank** (:298, ISK payout).

**W-ABYSS abyssalMgr (5):** AbyssalEntranceDeployment (abyssalMgrService.js:73), AbyssalEntranceGateActivation (:81), AbyssalGateActivation (:89), AbyssalEndGateActivation (:97), ClientIsReady (:105).

**W-PVP pvpFilamentMgr (3):** JoinPVPQueue (pvpFilamentMgrService.js:149), LeavePVPQueue (:155), AbyssalPVPEndGateActivation (:160).

**W-FLEETPROXY (5):** fleetObjectHandler.CreateFleet (fleetObjectHandlerService.js:116, top-level); fleetProxy ApplyToJoinFleet (fleetProxyService.js:21), AddFleetFinderAdvert (:29), RemoveFleetFinderAdvert (:34), UpdateAdvertInfo (:44).

**W-FLEETMGR fleetMgr (6):** ForceLeaveFleet (fleetMgrService.js:11), AddToWatchlist (:15), RemoveFromWatchlist (:23), RegisterForDamageUpdates (:31), BroadcastToBubble (:38), BroadcastToSystem (:50).

---

## PHASE 4 — BOUND WRITES (149) — bind + confirm-gate, last

**WB-SKILL skillMgr (8)** — off GetMySkillHandler: CharStartTrainingSkill (skillMgrService.js:402), AbortTraining (:525), ApplyFreeSkillPoints (:504), **ExtractSkills** (:562, destroys SP into injector), **InjectSkillpoints** (:531), SplitSkillInjector (:572), CombineSkillInjector (:582), **InjectSkillIntoBrain** (:353, consumes skillbook). *(Note: `InjectSkillIntoBrain` also exists on dogmaIM :9425 — distinct pair, see WB-DOGMA.)*

**WB-CLONE jumpCloneSvc (8):** **InstallCloneInStation** (jumpCloneService.js:70, ISK), **InstallCloneInStructure** (:75), **CloneJump** (:94), **DestroyInstalledClone** (:89), SetJumpCloneName (:80), OfferShipCloneInstallation (:105), AcceptShipCloneInstallation (:110), CancelShipCloneInstallation (:115).

**WB-CRIME crimewatch (1):** SetSafetyLevel (crimewatchService.js:67).

**WB-CORPREG corpRegistry (43)** — bound to corpID, CEO/director-role-gated (many will 403 without roles — that's expected, not a wiring bug): AddBulletin (:1561), UpdateBulletin (:1598), UpdateBulletinOrder (:1622), DeleteBulletin (:1610), CreateLabel (:1431), EditLabel (:1462), DeleteLabel (:1449), AssignLabels (:1481), RemoveLabels (:1506), AddCorporateContact (:1360), EditCorporateContact (:1378), RemoveCorporateContacts (:1382), EditContactsRelationshipID (:1398), UpdateTitle (:2122), UpdateTitles (:2143), DeleteTitle (:2152), UpdateMember (:1942), UpdateMembers (:1980), UpdateCorporation (:2468), UpdateCorporationAbilities (:2440), UpdateLogo (:2452), UpdateDivisionNames (:2162), SetAccountKey (:1998), SetCorpWelcomeMail (:1821), SetStructureReinforceDefault (:2705), RegisterNewAggressionSettings (:2628), RegisterNewAcceptStructureSettings (:2664), RegisterNewCorpMailRestrictionSettings (:2680), **MoveCompanyShares** (:2201), **MovePrivateShares** (:2205), **PayoutDividend** (:2225, ISK), **KickOutMember** (:2771), **KickOutMembers** (:2789), **ResignFromCEO** (:2840), InsertApplication (:1679), InsertInvitation (:1842), UpdateApplicationOffer (:1711), ExecuteActions (:2031), **AddCorporation** (:2507, ISK), **CreateAlliance** (:2363, ISK), ApplyToJoinAlliance (:2408), DeleteAllianceApplication (:2389), **DeclareWarAgainst** (:2720, ISK).

**WB-ALLYREG allianceRegistry (10)** — bound to allianceID, exec-role-gated: SetRelationship (allianceRegistryRuntime.js:826), DeleteRelationship (:839), AddAllianceContact (:571), AddBulletin (:741), UpdateApplication (:436), **PayBill** (:927, ISK), SetPrimeHour (:857), SetCapitalSystem (:878), DeclareExecutorSupport (:517), UpdateAlliance (:421).

**WB-PI planetMgr bound (4)** — bound to planetID: UserUpdateNetwork (planetMgrService.js:1091), UserLaunchCommodities (:1172), UserTransferCommodities (:1226), **UserAbandonPlanet** (:1259, destroys colony).

**WB-WARREG warRegistry (9)** — bound to owner: CreateWarAllyOffer (warRegistryService.js:186), RetractWarAllyOffer (:210), CreateSurrenderNegotiation (:226), AcceptAllyNegotiation (:261), DeclineAllyOffer (:267), AcceptSurrender (:293), DeclineSurrender (:299), RetractMutualWar (:283), SetOpenForAllies (:315).

**WB-CORPSTN corpStationMgr (1):** MoveCorpHQHere (corpStationMgrService.js:313).

**WB-DOGMA dogmaIM (22)** — off dogmaIM bind: RemoveTargets (dogmaService.js:6742), ClearTargets (:6754), Overload (:8250), OverloadRack (:8267), StopOverload (:8283), StopOverloadRack (:8300), InitiateModuleRepair (:8316), InitiateModuleRepairMany (:8336), StopModuleRepair (:8361), LinkWeapons (:6957), MergeModuleGroups (:6983), PeelAndLink (:7009), UnlinkModule (:7035), LinkAllWeapons (:7054), UnlinkAllModules (:7088), **DestroyWeaponBank** (:7113), LaunchProbes (:8427), ChangeDroneSettings (:5282), **InjectSkillIntoBrain** (:9425), **InjectImplant** (:9430), **DestroyImplant** (:9456, destroys implant), **UseBooster** (:9481, consumes booster).

**WB-INV invbroker (7)** — off invbroker bind: SetLabel (invBrokerService.js:6194), **StripFitting** (:6762), FitFitting (:8031), AssembleCargoContainer (:8418), BreakPlasticWrap (:8424), DeliverToCorpHangar (:8430), DeliverToCorpMember (:8541).

**WB-BEYONCE beyonce (7)** — bound remote-ballpark: CmdGotoPoint (beyonceService.js:2420), CmdGotoBookmark (:2433), CmdAbandonLoot (:2558), CmdFleetTagTarget (:2572), CmdJumpThroughFleet (:2198), BookmarkLocation (:3299), BookmarkScanResult (:3325).

**WB-ENTITY entity (4)** — off entity bind: CmdReturnHome (entityService.js:68), CmdSalvage (:80), CmdAbandonDrone (:88), CmdReconnectToDrones (:92).

**WB-SCAN scanMgr bound (9)** — off GetSystemScanMgr: SignalTrackerRegister (scanMgrService.js:1540), SetProbeDestination (:1592), SetProbeRangeStep (:1619), ConeScan (:1671), RequestScans (:1767), ReconnectToLostProbes (:1883), DestroyProbe (:1908), RecoverProbes (:1923), SetActivityState (:1950).

**WB-FLEET fleetObjectHandler bound (16)** — off MachoBindObject: CreateWing (fleetObjectHandlerService.js:175), CreateSquad (:196), MoveMember (:221), KickMember (:250), MakeLeader (:258), LeaveFleet (:266), DisbandFleet (:273), SetOptions (:280), SetMotdEx (:304), UpdateMemberInfo (:339), SendBroadcast (:363), Invite (:398), MassInvite (:409), AcceptInvite (:375), RejectInvite (:383), Reconnect (:391).

---

## ORCHESTRATOR NOTES

- **Gateway ordering dependency:** RB-SKILL depends on R-SKILLGW; RB-DOGMA/WB-DOGMA on dogmaIM.MachoBindObject; RB-SCAN/WB-SCAN on GetSystemScanMgr; RB-FLEET/WB-FLEET on fleetObjectHandler.MachoBindObject; WB-ENTITY on entity.MachoBindObject; RB-INV/WB-INV on the already-allowlisted invbroker binds. Wire the gateway pair in the same or an earlier batch than its dependents.
- **Wire-trap batches** (need response-shape handling beyond a passthrough): R-CORPMGR (CRowset/cachedMethodCall on GetAssetInventory*), R-MARKET CorpGetTransactions (bigint), and every bound batch (Moniker/bind step). The existing standings/wallet handlers in `server.js` are the pattern for CRowset + cachedMethodCall.
- **Role/gate 403s are not wiring failures:** corpRegistry/allianceRegistry writes, corpStationMgr, sovMgr fuel/skyhook, and GM_* will reject on a session lacking roles. Don't let a worker "fix" a 403 by loosening the handler — that's correct server behavior.
- **The count to hold against:** 588 plumbable pairs (287 read / 301 write; 328 top-level / 260 bound), plus 5 verify-first pairs held out of the total, plus 6 confirmed-unplumbable pairs to never touch.
