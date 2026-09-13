// The assertions for lib/symbols.ts, in the shape lib/rules.ts's __selfTest()
// established: a function that returns { ok, failures } so a scratch script or
// a future test runner can assert ok === true without this repo growing a test
// framework it does not have.
//
// WHY THIS IS A SEPARATE FILE, and not the bottom of symbols.ts.
// One assertion here needs symbols.ts's own export list at runtime — the claim
// in its header that every unsourced constant carries `_UNVERIFIED` and appears
// in UNVERIFIED_SYMBOL_CONSTANTS. A module cannot enumerate its own exports
// without importing itself, and a self-import is a circular import in a file
// three other modules are about to depend on. So the namespace import lives
// here and checkUnverifiedRegistry() — which is in symbols.ts, where a reader
// looking at the registry will find it — is handed the namespace object. That
// is the only reason this file exists; everything else here could have lived
// anywhere.
//
// The other thing this file does that a comment cannot: it reads the published
// tables out of data/guide-graph.json and compares them to the formulas, so a
// guide correction becomes a failing assertion instead of a silent divergence.

import * as S from "./symbols";
import guideGraphRaw from "@/data/guide-graph.json";

interface GuideNode {
  id: string;
  rows?: string[][];
  notes?: string;
  source?: string;
}
const GUIDE_NODES: GuideNode[] = (guideGraphRaw as unknown as { nodes: GuideNode[] }).nodes;

function guideRows(id: string): string[][] {
  const n = GUIDE_NODES.find((x) => x.id === id);
  return n && Array.isArray(n.rows) ? n.rows : [];
}
function num(s: string | undefined): number | null {
  if (!s) return null;
  const m = s.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

/** The reference character, from the observation recorded on 2026-09-12. */
const OBSERVED = {
  cls: "Bow Master",
  playerLevel: 245,
  arcanePower: 1070,
  dex: 20790,
} as const;

const TODAY = new Date(Date.UTC(2026, 8, 13));

export function __symbolSelfTest(): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  const eq = (label: string, got: unknown, want: unknown): void => {
    if (!Object.is(got, want)) failures.push(`${label}: got ${String(got)}, want ${String(want)}`);
  };
  const ok = (label: string, cond: boolean, detail = ""): void => {
    if (!cond) failures.push(detail ? `${label}: ${detail}` : label);
  };

  // Declared up here rather than beside section 12 because the unreadable-level
  // block in section 9b needs it too, and a `const` used above its declaration
  // is a TDZ crash, not a compile error.
  const PRI = [1, 2, 3, 4];
  const LV = ["hi", "mid", "ok"];
  const CONF = ["sourced", "modelled", "placeholder"];
  const checkRecs = (label: string, recs: S.SymbolRec[]): void => {
    const keys = new Set<string>();
    for (const r of recs) {
      ok(`${label}: pri in 1..4`, PRI.includes(r.pri), `pri ${r.pri} on "${r.t}"`);
      ok(`${label}: lv in the Rec vocabulary`, LV.includes(r.lv), `lv ${r.lv}`);
      ok(`${label}: conf in the confidence vocabulary`, r.conf === undefined || CONF.includes(r.conf), `conf ${r.conf}`);
      ok(`${label}: t is a sentence`, r.t.trim().length > 0);
      ok(`${label}: w is a sentence`, r.w.trim().length > 0);
      ok(`${label}: a priced rec carries a cost`, r.cost === undefined || r.cost > 0, `cost ${r.cost}`);
      ok(`${label}: key "${r.key}" is unique`, !keys.has(r.key));
      keys.add(r.key);
    }
  };

  /* ---- 1. the registry is exactly the marked exports, checked not promised */

  for (const f of S.checkUnverifiedRegistry(S)) failures.push(`registry: ${f}`);

  // A check that cannot fail proves nothing, so prove it can. Two negative
  // controls: an unlisted marked export, and a listed name that is not one.
  {
    const withExtra = { ...S, PHANTOM_UNVERIFIED: 1 };
    ok(
      "registry negative control (unlisted marked export)",
      S.checkUnverifiedRegistry(withExtra).some((f) => f.includes("PHANTOM_UNVERIFIED")),
      "checkUnverifiedRegistry did not notice an extra marked export — it is not checking anything",
    );
    const missing: Record<string, unknown> = { ...S };
    delete missing.WEEKLY_RESET_DAY_UTC_UNVERIFIED;
    ok(
      "registry negative control (listed but absent)",
      S.checkUnverifiedRegistry(missing).some((f) => f.includes("WEEKLY_RESET_DAY_UTC_UNVERIFIED")),
      "checkUnverifiedRegistry did not notice a registered constant that no longer exists",
    );
  }

  // Every registry entry has to say something. An empty `why` is a row that
  // looks like disclosure and is not.
  for (const u of S.UNVERIFIED_SYMBOL_CONSTANTS) {
    ok(`registry entry ${u.name} has a reason`, u.why.trim().length > 20, `why is "${u.why}"`);
  }
  for (const p of S.SYMBOL_CONSTANT_PROVENANCE) {
    ok(`provenance row ${p.name} cites something`, p.source.trim().length > 20, `source is "${p.source}"`);
    ok(`provenance row ${p.name} uses the repo vocabulary`, p.conf === "sourced" || p.conf === "modelled", p.conf);
  }

  /* ---- 1b. THE COVERAGE PASS, and the defect it was written for -----------
   *
   * The symmetry controls above can only see constants that already carry the
   * marker. The bug that actually shipped was the opposite: GRAND_SACRED_DAILY
   * as a bare `= 15` with no marker and no row, which is absent from BOTH sets
   * a symmetry check compares, so the sets still matched and it passed. These
   * controls re-introduce that exact defect and require a failure.            */
  {
    const bare = { ...S, GRAND_SACRED_DAILY: 15 };
    ok(
      "coverage: a bare unsourced number is caught",
      S.checkUnverifiedRegistry(bare).some((f) => f.includes("GRAND_SACRED_DAILY")),
      "this is the precise constant that was invisible to the old check — if this passes "
        + "silently the guard is back to proving nothing",
    );
    const bareRecord = { ...S, NEW_MESO_K: { alpha: 1, beta: 2 } };
    ok(
      "coverage: a bare record of numbers is caught",
      S.checkUnverifiedRegistry(bareRecord).some((f) => f.includes("NEW_MESO_K")),
    );
    // A record with ONE registered field must not count as fully covered:
    // GRAND_SACRED_MESO_K.geardock was registered while .tallahart was not, and
    // a root-name match would have hidden the 39.8 exactly that way.
    const halfCovered = {
      ...S,
      GRAND_SACRED_MESO_K: { tallahart: 39.8, geardock: 39.8, newarea: 1 },
    };
    ok(
      "coverage: an uncovered FIELD of a covered record is caught",
      S.checkUnverifiedRegistry(halfCovered).some((f) => f.includes("newarea")),
      "per-field coverage is what stops one registered field vouching for its siblings",
    );
    ok(
      "coverage: the module as it stands passes both passes",
      S.checkUnverifiedRegistry(S).length === 0,
      S.checkUnverifiedRegistry(S).join(" | "),
    );
    // The other half of a useful check: it must stay quiet about things that do
    // not carry game figures. A check that flags prose and area lists gets
    // muted by the next reader, and then catches nothing at all.
    ok(
      "coverage: prose, area lists and boolean flags owe no citation",
      !S.checkUnverifiedRegistry(S).some((f) =>
        /AREA_NAME|RANK_BASIS_WHY|ARCANE_AREAS|NO_ARCANE_LEVELS_WHY|_VERIFIED\b/.test(f)),
      "only game figures owe provenance",
    );
  }
  // The marker debt is a list, not a tolerance. If it empties, this assertion is
  // what tells the next reader the exception can be deleted.
  for (const name of S.UNMARKED_SCALAR_DEBT) {
    ok(
      `marker debt "${name}" is registered as unverified`,
      S.UNVERIFIED_SYMBOL_CONSTANTS.some((u) => u.name === name),
      "an unsourced export whose name does not say so must at least have a registry row",
    );
  }

  /* ---- 2. the Arcane growth table, against the published one --------------- */

  const arc = guideRows("symbols.arcane.cost");
  ok("guide node symbols.arcane.cost present", arc.length === 20, `found ${arc.length} rows`);
  if (arc.length === 20) {
    for (let L = 1; L <= 19; L++) {
      eq(`arcaneSymbolsForLevel(${L}) vs guide`, S.arcaneSymbolsForLevel(L), num(arc[L - 1][1]));
    }
    eq("arcaneSymbolsForLevel(20) is capped", S.arcaneSymbolsForLevel(20), 0);
    eq("cumulative symbols 1->20 vs guide", S.arcaneSymbolsBetween(1, 20), num(arc[19][2]));
    for (const L of [1, 10, 20]) {
      eq(
        `statAtLevel(ARCANE_GRANT_DEFAULT, ${L}) vs guide`,
        S.statAtLevel(S.ARCANE_GRANT_DEFAULT, L),
        num(arc[L - 1][3]),
      );
      eq(`arcaneForceOf(${L}) vs guide`, S.arcaneForceOf(L), num(arc[L - 1][4]));
    }
  }
  eq("six maxed Arcane symbols = ARCANE_FORCE_MAX", S.arcaneForceOf(20) * 6, S.ARCANE_FORCE_MAX);
  eq("six maxed Arcane symbols = 13,200 main stat", S.statAtLevel(S.ARCANE_GRANT_DEFAULT, 20) * 6, 13200);
  eq("an unequipped symbol grants no force", S.arcaneForceOf(0), 0);
  eq("an unequipped symbol grants no stat", S.statAtLevel(S.ARCANE_GRANT_DEFAULT, 0), 0);

  /* ---- 3. the meso formula, against published cells ----------------------- */

  // BOTH ENDS OF THE TABLE IN ALL SIX AREAS. Twelve published cells from
  // digitaltq.com/maplestory-arcane-symbols. Covering every area is the point:
  // an earlier draft of this file asserted four areas, and a mutation test that
  // changed ARCANE_MESO_K.morass from 16 to 15 passed every assertion in it.
  const PUBLISHED_ARCANE_MESO: Array<[S.ArcaneArea, number, number]> = [
    ["vj", 970_000, 36_820_000],
    ["chuchu", 1_210_000, 44_260_000],
    ["lach", 1_450_000, 51_700_000],
    ["arcana", 1_690_000, 59_140_000],
    ["morass", 1_930_000, 66_580_000],
    ["esfera", 2_170_000, 74_020_000],
  ];
  for (const [area, atOne, atNineteen] of PUBLISHED_ARCANE_MESO) {
    eq(`MESO_PER_LEVEL(${area}, 1) vs published`, S.MESO_PER_LEVEL(area, 1), atOne);
    eq(`MESO_PER_LEVEL(${area}, 19) vs published`, S.MESO_PER_LEVEL(area, 19), atNineteen);
  }
  eq("MESO_PER_LEVEL at cap is zero", S.MESO_PER_LEVEL("vj", 20), 0);
  eq("MESO_PER_LEVEL below level 1 is zero", S.MESO_PER_LEVEL("vj", 0), 0);
  eq("arcaneMesoForLevel is MESO_PER_LEVEL", S.arcaneMesoForLevel, S.MESO_PER_LEVEL);

  // The two K ladders, as structure rather than as six independent literals:
  // Arcane steps by 2 from 8, Sacred by 1.8 from 13.2. A single mistyped rung
  // breaks the ladder even where no published cell happens to be asserted.
  const ladder = (label: string, got: number[], first: number, step: number): void => {
    got.forEach((k, i) => {
      if (Math.abs(k - (first + step * i)) > 1e-9) {
        failures.push(`${label}[${i}]: got ${k}, want ${first + step * i}`);
      }
    });
  };
  ladder("ARCANE_MESO_K ladder", S.ARCANE_AREAS.map((a) => S.ARCANE_MESO_K[a]), 8, 2);
  ladder("SACRED_MESO_K ladder", S.SACRED_AREAS.map((a) => S.SACRED_MESO_K[a]), 13.2, 1.8);

  /* ---- 4. Sacred growth and cost ------------------------------------------ */

  const sacredPublished = [29, 76, 141, 224, 325, 444, 581, 736, 909, 1100];
  sacredPublished.forEach((want, i) => eq(`sacredSymbolsForLevel(${i + 1})`, S.sacredSymbolsForLevel(i + 1), want));
  eq("sacredSymbolsForLevel(11) is capped", S.sacredSymbolsForLevel(11), 0);
  eq("sacredSymbolsBetween(1, 11)", S.sacredSymbolsBetween(1, 11), 4565);
  eq("sacredMesoForLevel(cernium, 1)", S.sacredMesoForLevel("cernium", 1), 36_500_000);
  eq("six Sacred symbols at cap = SACRED_FORCE_MAX", S.SACRED_FORCE_PER_LEVEL * 11 * 6, S.SACRED_FORCE_MAX);
  eq(
    "sacredPower of a fully maxed set",
    S.sacredPower({ cernium: 11, arcus: 11, odium: 11, shangrila: 11, arteria: 11, carcion: 11 }),
    660,
  );
  eq("Sacred level 1 = 500 main stat (the sourced half)", S.statAtLevel(S.SACRED_GRANT_DEFAULT_UNVERIFIED, 1), 500);
  ok(
    "the Sacred grant declares itself unverified",
    S.SACRED_GRANT_DEFAULT_UNVERIFIED.verified === false,
    "the +200/level slope is not sourced, so verified must be false",
  );
  ok(
    "Sacred stat is not modelled for Demon Avenger or Xenon",
    S.sacredGrantFor("Demon Avenger") === undefined && S.sacredGrantFor("Xenon") === undefined,
    "a scaled guess here sends a real person to grind",
  );

  /* ---- 5. Grand Sacred: the placeholder must not print -------------------- */

  eq("grandSacredMesoForLevel(tallahart, 10)", S.grandSacredMesoForLevel("tallahart", 10), 3_718_000_000);
  eq(
    "grandSacredMesoForLevel(geardock, 10) refuses rather than copying Tallahart",
    S.grandSacredMesoForLevel("geardock", 10),
    null,
  );
  eq("GRAND_SACRED_MESO_K_VERIFIED.geardock", S.GRAND_SACRED_MESO_K_VERIFIED.geardock, false);
  ok(
    "an unverified Grand Sacred gate says so in its own `why`",
    /UNVERIFIED/i.test(S.grandSacredGate(200, "geardock").why)
      && S.grandSacredGate(200, "geardock").gateVerified === false,
    S.grandSacredGate(200, "geardock").why,
  );
  ok(
    "Tallahart's gate does not carry that warning",
    S.grandSacredGate(200, "tallahart").gateVerified === true
      && !/UNVERIFIED/i.test(S.grandSacredGate(200, "tallahart").why),
  );

  /* ---- 6. THE INCOME SPLIT. Arcane doubled, Sacred 1.5x dailies-only,
   *        Authentic untouched. This is the distinction the brief calls the
   *        first fix, so it gets the most assertions in the file.            */

  const inc = guideRows("symbols.income");
  ok("guide node symbols.income present", inc.length === 6, `found ${inc.length} rows`);
  if (inc.length === 6) {
    const before = (i: number) => num(inc[i][1]);
    const after = (i: number) => num(inc[i][2]);
    const perWeek = (i: number) => num(inc[i][3]);

    eq("ARCANE_DAILY_PER_AREA vs guide", S.ARCANE_DAILY_PER_AREA, after(0));
    eq("ARCANE_WEEKLY_PER_AREA vs guide", S.ARCANE_WEEKLY_PER_AREA, after(1));
    eq("ARCANE_WEEKLY_TOTAL_PER_AREA vs guide", S.ARCANE_WEEKLY_TOTAL_PER_AREA, after(2));
    eq("Arcane daily DOUBLED", after(0)! / before(0)!, 2);
    eq("Arcane weekly DOUBLED", after(1)! / before(1)!, 2);

    eq("SACRED_DAILY_CERNIUM vs guide", S.SACRED_DAILY_CERNIUM, after(3));
    eq("SACRED_DAILY_OTHER vs guide", S.SACRED_DAILY_OTHER, after(4));
    eq("Cernium daily went up 1.5x, NOT 2x", after(3)! / before(3)!, 1.5);
    eq("the other five Grandis areas went up 1.5x, NOT 2x", after(4)! / before(4)!, 1.5);
    ok(
      "Sacred is not modelled at 2x",
      S.SACRED_DAILY_CERNIUM !== before(3)! * 2 && S.SACRED_DAILY_OTHER !== before(4)! * 2,
      "modelling Sacred at 2x overstates Grandis symbol income by a third",
    );

    // DAILIES ONLY. The guide's per-week column is exactly daily x 7 for the
    // Grandis rows and daily x 7 + weekly for the Arcane rows; that difference
    // IS the "no Grandis weekly" claim, so assert it rather than repeat it.
    eq("Cernium per week is dailies only", S.SACRED_DAILY_CERNIUM * 7, perWeek(3));
    eq("other Grandis areas per week is dailies only", S.SACRED_DAILY_OTHER * 7, perWeek(4));
    eq("Arcane per week includes the weekly", S.ARCANE_DAILY_PER_AREA * 7 + S.ARCANE_WEEKLY_PER_AREA, perWeek(2));
    for (const area of S.SACRED_AREAS) {
      eq(`sacredIncomeFor(${area}).weeklyPerArea`, S.sacredIncomeFor(area).weeklyPerArea, 0);
      eq(`sacredIncomeFor(${area}).dailyPerArea`, S.sacredIncomeFor(area).dailyPerArea, S.sacredDailyFor(area));
    }

    // The Grand Sacred cell that the guide itself marks unconfirmed. The guide
    // drives the requirement: if someone confirms it and drops the word, this
    // assertion stops demanding the marker.
    const grandCell = inc[5][2];
    eq("GRAND_SACRED_DAILY_UNVERIFIED vs guide", S.GRAND_SACRED_DAILY_UNVERIFIED, num(grandCell));
    if (/UNCONFIRMED/i.test(grandCell)) {
      ok(
        "the guide's UNCONFIRMED Grand Sacred cell is registered here",
        S.UNVERIFIED_SYMBOL_CONSTANTS.some((u) => u.name === "GRAND_SACRED_DAILY_UNVERIFIED"),
        `guide-graph symbols.income row 6 reads "${grandCell}"`,
      );
    }

    // AUTHENTIC was untouched: there is no Authentic row in the patch table and
    // there must be no Authentic income constant pretending otherwise.
    ok(
      "no Authentic income row in the guide",
      !inc.some((r) => /authentic/i.test(r.join(" "))),
      "the v.271 notes have no Authentic symbol income change",
    );
    ok(
      "no Authentic income constant in symbols.ts",
      !Object.keys(S).some((k) => /AUTHENTIC/.test(k) && /(DAILY|WEEKLY|INCOME)/.test(k)),
      "Authentic Force is a force reading, not an income source",
    );
  }

  /* ---- 7. income simulation ----------------------------------------------- */

  const income = S.defaultArcaneIncome();
  eq("daysToEarn(0)", S.daysToEarn(0, TODAY, income), 0);
  eq("symbolsPerDay at default income", S.symbolsPerDay(income), 360 / 7);
  ok(
    "daysToEarn is monotone in `needed`",
    [1, 50, 360, 2679].every((n, i, a) => i === 0 || S.daysToEarn(n, TODAY, income) >= S.daysToEarn(a[i - 1], TODAY, income)),
  );
  ok(
    "a week of income covers one week's symbols",
    S.daysToEarn(S.ARCANE_WEEKLY_TOTAL_PER_AREA, TODAY, income) <= 7,
    `took ${S.daysToEarn(S.ARCANE_WEEKLY_TOTAL_PER_AREA, TODAY, income)} days`,
  );
  eq(
    "zero income does not loop forever, it returns Infinity",
    S.daysToEarn(10, TODAY, { dailyPerArea: 0, weeklyPerArea: 0, weeklyResetDayUtc: 4, missedDaysPerWeek: 0 }),
    Infinity,
  );
  ok(
    "missing days makes it take longer, never shorter",
    S.daysToEarn(2679, TODAY, { ...income, missedDaysPerWeek: 2 }) > S.daysToEarn(2679, TODAY, income),
  );

  /* ---- 8. the observed character ------------------------------------------ */

  // 95 levels across six equipped symbols. The distribution below is one of
  // thousands that read 1,070 — which is the point of assertion 10.
  const observedLevels: S.ArcaneLevels = { vj: 16, chuchu: 16, lach: 16, arcana: 16, morass: 16, esfera: 15 };
  eq("observed levels sum to 95", Object.values(observedLevels).reduce((a, b) => a + b, 0), 95);
  eq("arcanePower(observed) = the printed 1,070", S.arcanePower(observedLevels), OBSERVED.arcanePower);
  eq(
    "arcaneStatTotal(observed) = 10,700 flat DEX",
    S.arcaneStatTotal(observedLevels, S.ARCANE_GRANT_DEFAULT),
    10700,
  );
  ok(
    "symbols are over half the observed character's main stat",
    S.arcaneStatTotal(observedLevels, S.ARCANE_GRANT_DEFAULT) / OBSERVED.dex > 0.5,
    `${S.arcaneStatTotal(observedLevels, S.ARCANE_GRANT_DEFAULT)} of ${OBSERVED.dex}`,
  );
  eq("arcaneLevelSumFromPower(1070)", S.arcaneLevelSumFromPower(OBSERVED.arcanePower), 95);
  ok("validateArcanePower agrees", S.validateArcanePower(observedLevels, OBSERVED.arcanePower).ok);
  {
    const off = S.validateArcanePower({ ...observedLevels, esfera: 13 }, OBSERVED.arcanePower);
    ok("a two-level misread is reported as two levels", off.ok === false && off.likelyLevelsOff === 2, off.message);
  }

  /* ---- 9. level 0: one convention, not three ------------------------------ */

  {
    const plan = S.planArcane({ vj: 20, chuchu: 20, lach: 20, arcana: 20, morass: 20, esfera: 0 }, OBSERVED.cls, TODAY);
    const esf = plan.areas.find((a) => a.area === "esfera")!;
    ok("a level-0 symbol is flagged unlocked:false", esf.unlocked === false);
    ok("a level-0 symbol carries an explanatory note", esf.note.length > 0, esf.note);
    eq("level-0 levelsRemaining counts upgrade steps", esf.levelsRemaining, 19);
    eq("level-0 symbolsRemaining", esf.symbolsRemaining, 2679);
    eq("level-0 statRemaining includes the base that arrives with the symbol", esf.statRemaining, 2200);
    // The three numbers now describe the same journey. That is the whole fix.
    eq(
      "levelsRemaining and symbolsRemaining agree about where the journey starts",
      esf.symbolsRemaining,
      S.arcaneSymbolsBetween(S.ARCANE_LEVEL_CAP - esf.levelsRemaining, S.ARCANE_LEVEL_CAP),
    );
    ok("the plan headline says some symbols are not unlocked", /not unlocked/.test(plan.headline), plan.headline);
    for (const a of plan.areas) {
      eq(
        `${a.area}: statRemaining matches the grant`,
        a.statRemaining,
        S.statAtLevel(S.ARCANE_GRANT_DEFAULT, 20) - S.statAtLevel(S.ARCANE_GRANT_DEFAULT, a.level),
      );
    }
  }
  {
    const maxed: S.ArcaneLevels = { vj: 20, chuchu: 20, lach: 20, arcana: 20, morass: 20, esfera: 20 };
    const plan = S.planArcane(maxed, OBSERVED.cls, TODAY);
    eq("a maxed account has nothing remaining", plan.levelsRemaining, 0);
    eq("a maxed account owes no mesos", plan.mesosRemaining, 0);
    eq("a maxed account is at ARCANE_FORCE_MAX", plan.forceNow, S.ARCANE_FORCE_MAX);
  }

  /* ---- 9b. AN UNREADABLE LEVEL IS UNKNOWN, NOT ZERO AND NOT FINISHED ------
   *
   * The decision these assertions pin down, so a later edit cannot quietly
   * choose differently: a non-finite or non-integer level means NOBODY KNOWS
   * this level. It is not 0 (which reads as "unowned, 2,679 symbols to go") and
   * it is not maxed (which reads as "finished today"). The old code produced
   * the second: Math.max(0, Math.min(CAP, NaN)) is NaN, arcaneSymbolsBetween
   * returned 0 because its loop guard is false on entry, daysToEarn(0) is 0,
   * and the area was reported FINISHED under a headline reading "NaN symbol
   * levels left (+NaN main stat). Arcane Force NaN of 1320."                 */
  {
    const blank: S.ArcaneLevels = { vj: NaN, chuchu: 16, lach: 16, arcana: 16, morass: 16, esfera: 15 };
    const plan = S.planArcane(blank, OBSERVED.cls, TODAY);

    ok("an unreadable level is named, not absorbed", plan.unreadableAreas.join() === "vj", plan.unreadableAreas.join());
    eq("an unreadable area gets no projection row", plan.areas.length, 5);
    ok("no unreadable area sneaks into the rows", !plan.areas.some((a) => a.area === "vj"));
    ok("the headline never prints NaN", !/NaN/.test(plan.headline), plan.headline);
    ok(
      "an unread area means the ACCOUNT has no finish date",
      plan.maxedOn === null && plan.daysToMax === Infinity,
      `daysToMax ${plan.daysToMax}, maxedOn ${String(plan.maxedOn)}`,
    );
    ok("and the headline does not quote one", !/Maxed on/.test(plan.headline), plan.headline);
    ok(
      "the totals stay finite lower bounds rather than going NaN",
      Number.isFinite(plan.levelsRemaining) && Number.isFinite(plan.statRemaining)
        && Number.isFinite(plan.symbolsRemaining) && Number.isFinite(plan.mesosRemaining),
      `levels ${plan.levelsRemaining}, stat ${plan.statRemaining}`,
    );
    ok("the headline says the figures are floors", /at least/.test(plan.headline), plan.headline);

    // The ranking is the module's whole reason to exist, and it was the worst
    // hit: every comparison against NaN is false, so the unreadable row kept
    // its array position and came out RANKED FIRST.
    const ranked = S.rankArcaneNextLevel(blank, OBSERVED.cls, income, "time");
    ok("an unreadable level is not ranked at all", ranked.every((r) => r.area !== "vj"), ranked.map((r) => r.area).join(","));
    ok("and certainly not ranked #1", ranked[0]?.area !== "vj", ranked[0]?.line ?? "no rows");
    ok("no ranked line prints NaN", ranked.every((r) => !/NaN/.test(r.line)), ranked[0]?.line ?? "no rows");

    // Every shape a blank form field actually arrives in.
    for (const [label, raw] of [["NaN", NaN], ["Infinity", Infinity], ["a fraction", 16.5]] as const) {
      eq(`readSymbolLevel refuses ${label}`, S.readSymbolLevel(raw, S.ARCANE_LEVEL_CAP), null);
      ok(`isUnreadableLevel agrees about ${label}`, S.isUnreadableLevel(raw));
    }
    eq("readSymbolLevel clamps a finite over-cap level", S.readSymbolLevel(999, S.ARCANE_LEVEL_CAP), S.ARCANE_LEVEL_CAP);
    eq("readSymbolLevel clamps a negative level to 0", S.readSymbolLevel(-5, S.ARCANE_LEVEL_CAP), 0);
    eq("readSymbolLevel passes a real level through", S.readSymbolLevel(16, S.ARCANE_LEVEL_CAP), 16);

    eq("daysToEarn(NaN) is Infinity, not zero days", S.daysToEarn(NaN, TODAY, income), Infinity);
    const ck = S.validateArcanePower(blank, OBSERVED.arcanePower);
    ok(
      "the checksum blames the blank field, not the stat window",
      ck.ok === false && ck.likelyLevelsOff === 0 && /blank|whole number/.test(ck.message),
      ck.message,
    );

    // Sacred takes the same treatment, or the bug just moves one tier down.
    const sac = S.planSacred({ cernium: NaN, arcus: 5, odium: 5, shangrila: 5, arteria: 5, carcion: 5 }, OBSERVED.cls, 275, TODAY);
    ok("planSacred names its unreadable areas too", sac.unreadableAreas.join() === "cernium", sac.unreadableAreas.join());
    ok("planSacred quotes no date either", sac.maxedOn === null && !/maxed on/i.test(sac.headline), sac.headline);
    ok("planSacred marks its force as a floor", /at least/.test(sac.headline), sac.headline);
    ok(
      "an unreadable Sacred level is not ranked",
      S.rankSacredNextLevel({ cernium: NaN, arcus: 5, odium: 5, shangrila: 5, arteria: 5, carcion: 5 }, OBSERVED.cls)
        .every((r) => r.area !== "cernium"),
    );

    // And the player is told, rather than left to notice the missing date.
    const state = S.emptySymbolState();
    state.arcane = blank;
    const advice = S.symbolAdvice(state, { cls: OBSERVED.cls, playerLevel: OBSERVED.playerLevel, today: TODAY, reportedArcanePower: OBSERVED.arcanePower });
    checkRecs("unreadable levels", advice.recs);
    ok(
      "an unreadable level produces a pri-1 rec saying so",
      advice.recs.some((r) => r.key === "symbols/unreadable-levels" && r.pri === 1),
      advice.recs.map((r) => r.key).join(" "),
    );
    ok("no rec anywhere prints NaN", advice.recs.every((r) => !/NaN/.test(r.t + r.w)));
    ok(
      "the checksum rec does not also fire and blame the stat window",
      !advice.recs.some((r) => r.key === "symbols/checksum"),
      "two recs for one cause, one of them pointing at the wrong culprit",
    );
  }

  /* ---- 9c. AN OUT-OF-RANGE LEVEL IS CLAMPED, AND THE CLAMP IS REPORTED ----
   *
   * forceNow used to be computed from the RAW levels while every per-area field
   * beside it used the clamped one, so a level of 999 printed "Arcane Force
   * 11110 of 1320" — more than the game's maximum, in a headline.             */
  {
    const over: S.ArcaneLevels = { vj: 999, chuchu: 20, lach: 20, arcana: 20, morass: 20, esfera: 20 };
    const plan = S.planArcane(over, OBSERVED.cls, TODAY);
    ok("forceNow can never exceed forceMax", plan.forceNow <= plan.forceMax, `${plan.forceNow} of ${plan.forceMax}`);
    eq("forceNow agrees with the clamped per-area levels", plan.forceNow, S.ARCANE_FORCE_MAX);
    ok("the clamp is reported rather than silent", plan.clampedAreas.join() === "vj", plan.clampedAreas.join());
    eq("arcanePower is capped at its own maximum", S.arcanePower(over), S.ARCANE_FORCE_MAX);
    eq(
      "sacredPower is capped too",
      S.sacredPower({ cernium: 99, arcus: 99, odium: 99, shangrila: 99, arteria: 99, carcion: 99 }),
      S.SACRED_FORCE_MAX,
    );
    eq("a negative level contributes no force", S.arcanePower({ vj: -5, chuchu: 0, lach: 0, arcana: 0, morass: 0, esfera: 0 }), 0);
    // No GRAND_SACRED_FORCE_MAX was sourced, so this asserts the bound that the
    // file's own constants imply rather than inventing a published maximum.
    eq(
      "grandSacredPower clamps per level",
      S.grandSacredPower({ tallahart: 99, geardock: 99 }),
      S.GRAND_SACRED_AREAS.length * S.GRAND_SACRED_LEVEL_CAP * S.SACRED_FORCE_PER_LEVEL,
    );
    ok(
      "the player is told a level was clamped",
      S.symbolAdvice({ ...S.emptySymbolState(), arcane: over }, { cls: OBSERVED.cls, playerLevel: OBSERVED.playerLevel, today: TODAY })
        .recs.some((r) => r.key === "symbols/clamped-levels"),
    );
  }

  /* ---- 10. the ranking, and the reason it cannot run off Arcane Power ----- */

  {
    const even: S.ArcaneLevels = { vj: 16, chuchu: 16, lach: 16, arcana: 16, morass: 16, esfera: 15 };
    const front: S.ArcaneLevels = { vj: 20, chuchu: 20, lach: 20, arcana: 15, morass: 10, esfera: 10 };
    eq("both distributions read the same Arcane Power", S.arcanePower(even), S.arcanePower(front));
    eq("...and it is the observed 1,070", S.arcanePower(even), OBSERVED.arcanePower);

    const evenTime = S.rankArcaneNextLevel(even, OBSERVED.cls, income, "time");
    const frontTime = S.rankArcaneNextLevel(front, OBSERVED.cls, income, "time");
    ok(
      "identical Arcane Power, different #1 recommendation",
      evenTime[0].area !== frontTime[0].area,
      `both read 1,070 but rank ${evenTime[0].area} and ${frontTime[0].area} first — `
        + "which is why symbolAdvice refuses to guess a distribution",
    );

    // Maxed symbols are not offered.
    ok(
      "maxed symbols are filtered out of the ranking",
      frontTime.every((r) => r.fromLevel < S.ARCANE_LEVEL_CAP) && frontTime.length === 3,
      `${frontTime.length} rows for three unmaxed symbols`,
    );

    // The old sort key was mesosPerStat, which — because every Arcane level
    // grants an identical +100 — is meso order wearing a per-stat label. Assert
    // that equivalence, and then assert the new time key is genuinely different.
    const byPerStat = [...evenTime].sort((a, b) => (a.mesosPerStat ?? Infinity) - (b.mesosPerStat ?? Infinity));
    const byMeso = [...evenTime].sort((a, b) => a.mesos - b.mesos);
    ok(
      "mesosPerStat order IS meso order (the old key was cost-only)",
      byPerStat.every((r, i) => r.area === byMeso[i].area),
    );
    const evenMesos = S.rankArcaneNextLevel(even, OBSERVED.cls, income, "mesos");
    ok(
      "daysOfIncome now changes the ordering",
      evenTime[0].area !== evenMesos[0].area,
      `time ranks ${evenTime[0].area} first, mesos ranks ${evenMesos[0].area} first — `
        + "under the old sort daysOfIncome was computed, printed, and ignored",
    );

    for (const r of evenTime) {
      eq(`${r.area}: every Arcane level grants the same stat`, r.statGain, 100);
      eq(`${r.area}: forceGain`, r.forceGain, S.ARCANE_FORCE_PER_LEVEL);
      eq(`${r.area}: symbols match the growth table`, r.symbols, S.arcaneSymbolsForLevel(r.fromLevel));
      eq(`${r.area}: mesos match the cost table`, r.mesos, S.MESO_PER_LEVEL(r.area as S.ArcaneArea, r.fromLevel));
      eq(`${r.area}: toLevel is fromLevel + 1`, r.toLevel, r.fromLevel + 1);
      ok(`${r.area}: line names the area`, r.line.includes(r.areaName), r.line);
    }
    ok("ranks are 1..n in order", evenTime.every((r, i) => r.rank === i + 1));
  }
  {
    // Sacred rows are priced but carry the unverified stat badge.
    const sac = S.rankSacredNextLevel({ cernium: 5, arcus: 4, odium: 3, shangrila: 2, arteria: 1, carcion: 0 }, OBSERVED.cls);
    ok("unowned Sacred symbols are not offered", sac.every((r) => r.area !== "carcion"), `${sac.length} rows`);
    ok("Sacred rows declare their stat unverified", sac.every((r) => r.statVerified === false));
    ok("Sacred rows say so in the rendered line", sac.every((r) => /unverified/.test(r.line)), sac[0]?.line ?? "no rows");
    for (const r of sac) {
      eq(`sacred ${r.area}: mesos`, r.mesos, S.sacredMesoForLevel(r.area as S.SacredArea, r.fromLevel));
      eq(`sacred ${r.area}: symbols`, r.symbols, S.sacredSymbolsForLevel(r.fromLevel));
    }
    const daRows = S.rankSacredNextLevel({ cernium: 5, arcus: 4, odium: 3, shangrila: 2, arteria: 1, carcion: 0 }, "Demon Avenger");
    ok(
      "Demon Avenger gets null Sacred stat, not a scaled guess",
      daRows.every((r) => r.statGain === null && /not modelled/.test(r.line)),
      daRows[0]?.line ?? "no rows",
    );
  }

  /* ---- 11. the caveat no longer contradicts the constants ----------------- */

  {
    const plan = S.planSacred(
      { cernium: 0, arcus: 0, odium: 0, shangrila: 0, arteria: 0, carcion: 0 },
      OBSERVED.cls,
      275,
      TODAY,
    );
    ok(
      "planSacred no longer tells the player its own verified income is unconfirmed",
      !/NOT confirmed against the v\.271/i.test(plan.caveat),
      plan.caveat,
    );
    ok("the caveat names what actually is unconfirmed: the stat", /unconfirmed half/i.test(plan.caveat), plan.caveat);
    ok("planSacred reports its stat as unverified", plan.statVerified === false);
  }
  {
    const gated = S.planSacred(
      { cernium: 0, arcus: 0, odium: 0, shangrila: 0, arteria: 0, carcion: 0 },
      OBSERVED.cls,
      OBSERVED.playerLevel,
      TODAY,
    );
    ok("the observed Lv 245 character is still gated out of Sacred", gated.gate.unlocked === false);
    eq("15 levels to Sacred", gated.gate.levelsRemaining, S.SACRED_UNLOCK_LEVEL - OBSERVED.playerLevel);
    ok("the gate carries the do-not-buy warning", /Selector/.test(gated.gate.why), gated.gate.why);
    eq("a gated plan has no area rows", gated.areas, null);
  }

  /* ---- 12. the entry point, in the shape rules.ts's Rec needs ------------- */

  {
    const advice = S.symbolAdvice(S.emptySymbolState(), {
      cls: OBSERVED.cls,
      playerLevel: OBSERVED.playerLevel,
      today: TODAY,
      reportedArcanePower: OBSERVED.arcanePower,
    });
    checkRecs("empty state", advice.recs);
    ok(
      "with no levels entered, the first thing said is ask for them",
      advice.recs[0]?.key === "symbols/need-levels",
      advice.recs[0]?.key ?? "no recs",
    );
    eq("with no levels entered there is nothing to rank", advice.ranked.length, 0);
    ok(
      "the refusal explains why the number cannot be inverted",
      /does not invert/.test(advice.recs[0]?.w ?? ""),
      advice.recs[0]?.w ?? "",
    );
    ok(
      "no rec claims a damage number",
      !advice.recs.some((r) => "dmg" in r),
      "converting flat stat to damage is lib/damage.ts's job",
    );
    ok("the advice carries the unverified register", advice.unverified === S.UNVERIFIED_SYMBOL_CONSTANTS);
  }
  {
    const state = S.emptySymbolState();
    state.arcane = { vj: 16, chuchu: 16, lach: 16, arcana: 16, morass: 16, esfera: 15 };
    const advice = S.symbolAdvice(state, {
      cls: OBSERVED.cls,
      playerLevel: OBSERVED.playerLevel,
      today: TODAY,
      reportedArcanePower: OBSERVED.arcanePower,
    });
    checkRecs("observed state", advice.recs);
    ok("the checksum ran", advice.checksum?.ok === true, advice.checksum?.message ?? "no checksum");
    ok("nothing asks for levels that were provided", !advice.recs.some((r) => r.key === "symbols/need-levels"));
    ok(
      "the top rec is a next-level recommendation at pri 1",
      advice.recs[0]?.key.startsWith("symbols/next/") && advice.recs[0]?.pri === 1,
      advice.recs[0]?.key ?? "no recs",
    );
    ok("the top rec is priced", (advice.recs[0]?.cost ?? 0) > 0, String(advice.recs[0]?.cost));
    eq("the top rec is sourced", advice.recs[0]?.conf, "sourced");
    eq("the top rec carries the stat it buys", advice.recs[0]?.statGain, 100);
    eq("three next-level recs by default", advice.recs.filter((r) => r.key.startsWith("symbols/next/")).length, 3);
    ok(
      "the Lv 245 character is warned off Sacred selectors",
      advice.recs.some((r) => r.key === "symbols/sacred-gate"),
    );
    ok(
      "the plan rec quotes a finish date",
      advice.recs.some((r) => r.key === "symbols/arcane-plan" && /Maxed on/.test(r.t)),
      advice.recs.find((r) => r.key === "symbols/arcane-plan")?.t ?? "no plan rec",
    );
    ok(
      "the ranking basis is stated to the player",
      advice.recs[0]?.w.includes(S.RANK_BASIS_WHY.time) === true,
      "a 46M level ranked above a 26M one has to say why in the rec itself",
    );
    eq(
      "and stated exactly once, not on every row",
      advice.recs.filter((r) => r.w.includes(S.RANK_BASIS_WHY.time)).length,
      1,
    );
    ok(
      "ranking by mesos states the other basis",
      S.symbolAdvice(state, { cls: OBSERVED.cls, playerLevel: OBSERVED.playerLevel, today: TODAY, rankBy: "mesos" })
        .recs[0]?.w.includes(S.RANK_BASIS_WHY.mesos) === true,
    );
    ok(
      "ranked covers every unmaxed Arcane symbol",
      advice.ranked.length === 6 && advice.ranked.every((r) => r.tier === "arcane"),
      `${advice.ranked.length} rows`,
    );
  }
  {
    // A mismatched stat window must outrank the advice computed from the levels.
    const state = S.emptySymbolState();
    state.arcane = { vj: 16, chuchu: 16, lach: 16, arcana: 16, morass: 16, esfera: 13 };
    const advice = S.symbolAdvice(state, {
      cls: OBSERVED.cls,
      playerLevel: OBSERVED.playerLevel,
      today: TODAY,
      reportedArcanePower: OBSERVED.arcanePower,
    });
    ok(
      "a checksum failure is the first thing the player reads",
      advice.recs[0]?.key === "symbols/checksum" && advice.recs[0]?.pri === 1,
      advice.recs[0]?.key ?? "no recs",
    );
  }
  {
    // Demon Avenger: the class the hardcoded +100 was always wrong for.
    const state = S.emptySymbolState();
    state.arcane = { vj: 16, chuchu: 16, lach: 16, arcana: 16, morass: 16, esfera: 15 };
    const advice = S.symbolAdvice(state, { cls: "Demon Avenger", playerLevel: 260, today: TODAY });
    checkRecs("demon avenger", advice.recs);
    eq("Demon Avenger's symbols grant HP", advice.arcane.statKind, "hp");
    ok("and that grant is flagged unverified", advice.arcane.statVerified === false);
    eq(
      "so the priced recs are placeholder, not sourced",
      advice.recs.find((r) => r.key.startsWith("symbols/next/"))?.conf,
      "placeholder",
    );
  }

  return { ok: failures.length === 0, failures };
}
