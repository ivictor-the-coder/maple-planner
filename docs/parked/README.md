# Parked code

Files here do not compile and are not part of the build. They are kept because
they contain ideas worth harvesting, not because they work.

## upgrades.ts

Written in wave 1 by the upgrade-finder builder. It imports `StatDelta`,
`relativeDamage` and `damageWith` from `lib/damage.ts` and a module `./cost`.
None of those exist: `damage.ts` exports `damageIndex()` and `marginal()` over a
`DamageInputs` shape, and the cost curves live in `lib/starforce.ts` and
`lib/cubes.ts`. It also assumes printed tooltip units (`iedPct: 35`) where
`damage.ts` takes fractions (`ied: 0.35`) — a silent 100x error had the imports
resolved.

It is a parallel re-implementation of `rules.planAdvice` plus `cubes.rankUpgrades`,
both of which compile and run. What is worth taking from it is the enumeration
logic — gear-tier steps and the budget planner — rewritten against the interfaces
that actually shipped.

Do not restore this file as-is.
