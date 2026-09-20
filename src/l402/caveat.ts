/**
 * L402 caveats: `condition=value` strings (aperture `l402/caveat.go`) plus the
 * two satisfiers Aperture applies at verification time (`l402/satisfier.go`):
 *   services              — `services=name:tier,...`; target service must be listed,
 *                           successive caveats must be subsets.
 *   <service>_valid_until — unix seconds; successive caveats must not extend it.
 * Unknown conditions are skipped, per spec.
 */
export interface Caveat { condition: string; value: string }

export const COND_SERVICES = 'services';
export const COND_PREIMAGE = 'preimage';
export const validUntilCondition = (service: string): string => `${service}_valid_until`;

export const encodeCaveat = (c: Caveat): string => `${c.condition}=${c.value}`;

export function decodeCaveat(s: string): Caveat | undefined {
  const i = s.indexOf('=');
  if (i < 0) return undefined;
  return { condition: s.slice(0, i), value: s.slice(i + 1) };
}

export interface Service { name: string; tier: number }

export function encodeServices(services: readonly Service[]): string {
  return services.map((s) => `${s.name}:${s.tier}`).join(',');
}

export function decodeServices(value: string): Service[] {
  if (value === '') return [];
  return value.split(',').map((part) => {
    const i = part.lastIndexOf(':');
    if (i < 0) throw new Error(`invalid service '${part}'`);
    const tier = Number(part.slice(i + 1));
    if (!Number.isInteger(tier) || tier < 0) throw new Error(`invalid tier in '${part}'`);
    return { name: part.slice(0, i), tier };
  });
}

/** A satisfier evaluates every caveat sharing one condition (spec: Step 3). */
export interface Satisfier {
  condition: string;
  /** Each successive caveat must be at least as restrictive as the previous. */
  satisfyPrevious(prev: Caveat, cur: Caveat): boolean;
  /** The final (most restrictive) caveat must permit the current request. */
  satisfyFinal(c: Caveat): boolean;
}

export function servicesSatisfier(targetService: string): Satisfier {
  return {
    condition: COND_SERVICES,
    satisfyPrevious(prev, cur) {
      const prevNames = new Set(decodeServices(prev.value).map((s) => s.name));
      return decodeServices(cur.value).every((s) => prevNames.has(s.name));
    },
    satisfyFinal(c) {
      return decodeServices(c.value).some((s) => s.name === targetService);
    },
  };
}

export function timeoutSatisfier(targetService: string, now: () => number = () => Date.now() / 1000): Satisfier {
  return {
    condition: validUntilCondition(targetService),
    satisfyPrevious(prev, cur) {
      return Number(cur.value) <= Number(prev.value);
    },
    satisfyFinal(c) {
      const t = Number(c.value);
      return Number.isFinite(t) && now() < t;
    },
  };
}

export class CaveatError extends Error {}

/** Verifies decoded caveats against satisfiers; unknown conditions are ignored. */
export function verifyCaveats(caveats: readonly Caveat[], satisfiers: readonly Satisfier[]): void {
  const byCondition = new Map(satisfiers.map((s) => [s.condition, s] as const));
  const groups = new Map<string, Caveat[]>();
  for (const c of caveats) {
    if (!byCondition.has(c.condition)) continue;
    (groups.get(c.condition) ?? groups.set(c.condition, []).get(c.condition)!).push(c);
  }
  for (const [condition, list] of groups) {
    const s = byCondition.get(condition)!;
    for (let i = 1; i < list.length; i++) {
      if (!s.satisfyPrevious(list[i - 1]!, list[i]!)) {
        throw new CaveatError(`caveat '${condition}' is not more restrictive than its predecessor`);
      }
    }
    if (!s.satisfyFinal(list[list.length - 1]!)) {
      throw new CaveatError(`caveat '${encodeCaveat(list[list.length - 1]!)}' not satisfied`);
    }
  }
}
