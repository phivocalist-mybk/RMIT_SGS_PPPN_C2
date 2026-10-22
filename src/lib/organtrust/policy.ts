// Ranking policy for the synthetic kidney waiting list. Bump POLICY_VERSION whenever the formula
// or a weight changes, so every allocation records which rules produced it.
export const POLICY_VERSION = "v1";

export const POLICY_WEIGHTS = {
  perUrgencyLevel: 20, // urgency 1-4
  perHlaPoint: 0.5, // HLA match score 0-100
  perWaitingYear: 8, // capped at 5 years
  maxWaitingYears: 5,
  priorDonorBonus: 10,
};

export const POLICY_DESCRIPTION =
  "score = 20 x urgency + 0.5 x HLA match + 8 x waiting years (max 5) + 10 if prior living donor";

export type RankingInputs = {
  id: string; // pseudonymous patient id
  urgency: number;
  hlaScore: number;
  waitingDays: number;
  priorDonor: boolean;
};

export function scorePatient(p: RankingInputs): number {
  const w = POLICY_WEIGHTS;
  const waitingYears = Math.min(p.waitingDays / 365, w.maxWaitingYears);
  const score =
    p.urgency * w.perUrgencyLevel +
    p.hlaScore * w.perHlaPoint +
    waitingYears * w.perWaitingYear +
    (p.priorDonor ? w.priorDonorBonus : 0);
  return Math.round(score * 100) / 100;
}

export function rankPatients<T extends RankingInputs>(patients: T[]): (T & { score: number; rank: number })[] {
  return patients
    .map((p) => ({ ...p, score: scorePatient(p) }))
    .sort((a, b) => b.score - a.score || b.waitingDays - a.waitingDays)
    .map((p, i) => ({ ...p, rank: i + 1 }));
}
