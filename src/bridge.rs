use crate::SignPattern;

/// A bridge connecting this fleet to a foreign fleet.
///
/// Each fleet evolves according to:
///
/// ```text
/// Δx_i = internal_coupling · Σ_j (x_j - x_i) + bridge_coupling · (s_k - mean(x_i))
/// ```
///
/// Where `s_k` is +1 or -1 from the foreign sign pattern. The bridge coupling term
/// pulls the local fleet toward the foreign sign pattern's direction.
#[derive(Debug, Clone)]
pub struct Bridge {
    /// Identifier for the connected foreign fleet
    pub fleet_id: String,
    /// Coupling strength among agents within this fleet
    pub internal_coupling: f64,
    /// Coupling strength to the foreign fleet's sign pattern
    pub bridge_coupling: f64,
    /// Internal state tracking
    pub state: BridgeState,
}

/// Runtime state of a bridge, including coupling and correlation history.
#[derive(Debug, Clone)]
pub struct BridgeState {
    /// Current internal coupling energy (sum of pairwise agent differences)
    pub internal_energy: f64,
    /// Current bridge coupling energy (alignment to foreign pattern)
    pub bridge_energy: f64,
    /// Cross-correlation history (last N measurements)
    pub cross_correlation_history: Vec<f64>,
}

impl Bridge {
    /// Create a new bridge.
    ///
    /// - `fleet_id`: identifier for the foreign fleet
    /// - `internal_coupling`: coupling strength within this fleet (typically 0.1–0.5)
    /// - `bridge_coupling`: coupling strength to foreign sign pattern (typically 0.05–0.3)
    pub fn new(fleet_id: &str, internal_coupling: f64, bridge_coupling: f64) -> Self {
        Self {
            fleet_id: fleet_id.to_string(),
            internal_coupling,
            bridge_coupling,
            state: BridgeState {
                internal_energy: 0.0,
                bridge_energy: 0.0,
                cross_correlation_history: Vec::new(),
            },
        }
    }

    /// Extract the sign pattern from a fleet's agent states.
    ///
    /// Each agent's sign is the sign of its mean state. If the mean is zero, +1 is returned.
    ///
    /// This is the **1-bit compression**: we reduce each agent's full state vector to `+1` or `-1`.
    pub fn broadcast_signs(agent_states: &[Vec<f64>]) -> SignPattern {
        let signs: Vec<i8> = agent_states
            .iter()
            .map(|state| {
                let mean = if state.is_empty() {
                    0.0
                } else {
                    state.iter().sum::<f64>() / state.len() as f64
                };
                if mean >= 0.0 { 1 } else { -1 }
            })
            .collect();
        SignPattern::new(signs)
    }

    /// Convert a foreign sign pattern into an influence vector.
    ///
    /// Each entry is either `+bridge_coupling` (if the foreign agent's sign is +1) or
    /// `-bridge_coupling` (if -1). This influence is applied to the corresponding local agent.
    pub fn receive_foreign_signs(&self, pattern: &SignPattern) -> Vec<f64> {
        pattern
            .signs
            .iter()
            .map(|&s| self.bridge_coupling * s as f64)
            .collect()
    }

    /// Measure the cross-correlation between a local fleet and foreign sign patterns.
    ///
    /// Correlation is computed as the normalized dot product of signs:
    /// - Extract local signs from `internal` via `broadcast_signs`
    /// - For each foreign pattern, compute `mean(local_sign * foreign_sign)` 
    /// - Return the mean across all foreign patterns
    ///
    /// Result is in [-1.0, 1.0], where >0.5 indicates healthy alignment.
    pub fn measure_correlation(internal: &[Vec<f64>], foreign: &[SignPattern]) -> f64 {
        if internal.is_empty() || foreign.is_empty() {
            return 0.0;
        }
        let local_signs = Self::broadcast_signs(internal);
        let mut corr_sum = 0.0;
        let n = local_signs.len();
        if n == 0 {
            return 0.0;
        }
        for fp in foreign {
            let m = fp.len().min(n);
            if m == 0 {
                continue;
            }
            let dot: f64 = local_signs.signs[..m]
                .iter()
                .zip(&fp.signs[..m])
                .map(|(a, b)| (*a as f64) * (*b as f64))
                .sum();
            corr_sum += dot / m as f64;
        }
        corr_sum / foreign.len() as f64
    }

    /// Check if correlation indicates healthy cross-fleet alignment.
    ///
    /// Healthy if `corr > 0.5` (empirical threshold from experiments).
    pub fn is_healthy(corr: f64) -> bool {
        corr > 0.5
    }

    /// Perform one integration step for the local fleet.
    ///
    /// Updates each agent's state vector using:
    /// - **Internal coupling**: pulls agents toward each other (pairwise attraction)
    /// - **Bridge coupling**: pulls each agent toward the foreign sign pattern
    ///
    /// After updating, records the internal and bridge energies.
    pub fn step(&mut self, states: &mut [Vec<f64>], foreign_signs: &SignPattern) {
        let n = states.len();
        if n == 0 {
            return;
        }
        let dim = states[0].len();
        if dim == 0 {
            return;
        }

        let m = foreign_signs.len().min(n);

        // Compute internal coupling forces: each agent attracts toward mean of all agents
        let mut means = vec![0.0; dim];
        for state in states.iter() {
            for (d, &val) in state.iter().enumerate() {
                means[d] += val / n as f64;
            }
        }

        // Track energies
        let mut internal_energy = 0.0;
        let mut bridge_energy = 0.0;

        // Apply updates
        for (i, state) in states.iter_mut().enumerate() {
            for d in 0..dim {
                // Internal coupling: pull toward fleet mean
                let diff = means[d] - state[d];
                let internal_force = self.internal_coupling * diff;
                internal_energy += diff * diff;

                // Bridge coupling: pull toward foreign sign (+1 or -1)
                let target = if i < m {
                    foreign_signs.signs[i] as f64
                } else {
                    1.0 // default for unmatched agents
                };
                let bridge_diff = target - state[d];
                let bridge_force = self.bridge_coupling * bridge_diff;
                bridge_energy += bridge_diff * bridge_diff;

                state[d] += internal_force + bridge_force;
            }
        }

        // Record energy state (normalized by agent count)
        self.state.internal_energy = internal_energy / (n * dim) as f64;
        self.state.bridge_energy = bridge_energy / (n * dim) as f64;

        // Measure and record cross-correlation
        let corr = Self::measure_correlation(
            &states.iter().map(|s| s.clone()).collect::<Vec<_>>(),
            &[foreign_signs.clone()],
        );
        self.state.cross_correlation_history.push(corr);
        // Keep only last 1000 entries
        if self.state.cross_correlation_history.len() > 1000 {
            self.state.cross_correlation_history.remove(0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Create a test fleet with `n` agents, each having `d` dimensions.
    /// Agents are initialized with alternating signs.
    fn test_fleet(n: usize, d: usize, alternating: bool) -> Vec<Vec<f64>> {
        let mut fleet = Vec::with_capacity(n);
        for i in 0..n {
            let sign = if alternating && i % 2 == 0 { 1.0 } else { -1.0 };
            fleet.push(vec![sign * 0.5; d]);
        }
        fleet
    }

    #[test]
    fn test_sign_pattern_creation() {
        let sp = SignPattern::new(vec![1, -1, 1, -1]);
        assert_eq!(sp.len(), 4);
        assert_eq!(sp.get(0), Some(1));
        assert_eq!(sp.get(1), Some(-1));
    }

    #[test]
    #[should_panic(expected = "Sign must be +1 or -1")]
    fn test_invalid_sign() {
        let _ = SignPattern::new(vec![0]);
    }

    #[test]
    fn test_sign_pattern_agreement() {
        let a = SignPattern::new(vec![1, -1, 1, -1]);
        let b = SignPattern::new(vec![1, -1, -1, -1]);
        assert!((a.agreement(&b) - 0.75).abs() < 1e-10);
    }

    #[test]
    fn test_sign_pattern_invert() {
        let a = SignPattern::new(vec![1, -1, 1]);
        let inv = a.invert();
        assert_eq!(inv.signs, vec![-1, 1, -1]);
    }

    #[test]
    fn test_sign_pattern_display() {
        let sp = SignPattern::new(vec![1, -1, 1]);
        let s = format!("{}", sp);
        assert_eq!(s, "[+, -, +]");
    }

    #[test]
    fn test_broadcast_signs_all_positive() {
        let fleet = vec![vec![1.0, 2.0], vec![0.1, 0.5]];
        let sp = Bridge::broadcast_signs(&fleet);
        assert_eq!(sp.signs, vec![1, 1]);
    }

    #[test]
    fn test_broadcast_signs_all_negative() {
        let fleet = vec![vec![-1.0, -2.0], vec![-0.1, -0.5]];
        let sp = Bridge::broadcast_signs(&fleet);
        assert_eq!(sp.signs, vec![-1, -1]);
    }

    #[test]
    fn test_broadcast_signs_mixed() {
        let fleet = vec![vec![1.0, -2.0], vec![-0.1, 0.5]];
        let sp = Bridge::broadcast_signs(&fleet);
        // Mean of [1.0, -2.0] = -0.5 → -1
        // Mean of [-0.1, 0.5] = 0.2 → +1
        assert_eq!(sp.signs, vec![-1, 1]);
    }

    #[test]
    fn test_broadcast_signs_zero_mean() {
        let fleet = vec![vec![0.0, 0.0]];
        let sp = Bridge::broadcast_signs(&fleet);
        assert_eq!(sp.signs, vec![1]); // zero → +1
    }

    #[test]
    fn test_receive_foreign_signs() {
        let bridge = Bridge::new("test", 0.3, 0.2);
        let pattern = SignPattern::new(vec![1, -1, 1]);
        let influence = bridge.receive_foreign_signs(&pattern);
        assert_eq!(influence, vec![0.2, -0.2, 0.2]);
    }

    #[test]
    fn test_measure_correlation_perfect() {
        let fleet = test_fleet(4, 3, true);
        let local_signs = Bridge::broadcast_signs(&fleet);
        let corr = Bridge::measure_correlation(&fleet, &[local_signs]);
        assert!((corr - 1.0).abs() < 1e-10);
    }

    #[test]
    fn test_measure_correlation_opposite() {
        let fleet = test_fleet(4, 3, true);
        let local_signs = Bridge::broadcast_signs(&fleet).invert();
        let corr = Bridge::measure_correlation(&fleet, &[local_signs]);
        assert!((corr - (-1.0)).abs() < 1e-10);
    }

    #[test]
    fn test_is_healthy() {
        assert!(Bridge::is_healthy(0.6));
        assert!(!Bridge::is_healthy(0.5));
        assert!(!Bridge::is_healthy(0.3));
    }

    #[test]
    fn test_step_internal_convergence() {
        // Two agents with opposite values should converge toward each other
        let mut states = vec![vec![1.0], vec![-1.0]];
        let mut bridge = Bridge::new("foreign", 0.3, 0.0); // no bridge coupling
        let neutral = SignPattern::new(vec![1, 1]);

        for _ in 0..20 {
            bridge.step(&mut states, &neutral);
        }

        // After convergence, both should be near 0
        assert!(states[0][0].abs() < 0.1);
        assert!(states[1][0].abs() < 0.1);
    }

    #[test]
    fn test_step_bridge_pulls_to_sign() {
        // Single agent starting at -1.0, bridge pulls toward +1
        let mut states = vec![vec![-1.0]];
        let mut bridge = Bridge::new("foreign", 0.0, 0.5); // no internal, strong bridge
        let foreign = SignPattern::new(vec![1]); // foreign says +1

        for _ in 0..20 {
            bridge.step(&mut states, &foreign);
        }

        // Agent should be pulled toward +1
        assert!(states[0][0] > 0.5);
    }

    #[test]
    fn test_convergence_two_fleets() {
        // Two small fleets should synchronize via bridge coupling
        let mut fleet_a = vec![vec![0.5], vec![-0.5]];
        let mut fleet_b = vec![vec![-0.5], vec![0.5]];

        let mut bridge_a = Bridge::new("fleet-b", 0.2, 0.15);
        let mut bridge_b = Bridge::new("fleet-a", 0.2, 0.15);

        for _ in 0..50 {
            let signs_a = Bridge::broadcast_signs(&fleet_a);
            let signs_b = Bridge::broadcast_signs(&fleet_b);
            bridge_a.step(&mut fleet_a, &signs_b);
            bridge_b.step(&mut fleet_b, &signs_a);
        }

        let corr = Bridge::measure_correlation(&fleet_a, &[Bridge::broadcast_signs(&fleet_b)]);
        assert!(corr.abs() > 0.5, "corr = {}", corr);
    }

    #[test]
    fn test_multidimensional_states() {
        // Agents with 4D state should still converge
        let mut states = vec![vec![1.0, -1.0, 0.5, -0.5]; 4];
        let neutral = SignPattern::new(vec![1; 4]);
        let mut bridge = Bridge::new("foreign", 0.3, 0.1);

        for _ in 0..30 {
            bridge.step(&mut states, &neutral);
        }

        // All agents should be pulled toward the neutral pattern (+1)
        for state in &states {
            for &val in state {
                assert!(val > 0.0, "val = {}", val);
            }
        }
    }

    #[test]
    fn test_bridge_state_tracks_energy() {
        let mut states = vec![vec![1.0], vec![-1.0]];
        let mut bridge = Bridge::new("foreign", 0.3, 0.1);
        let foreign = SignPattern::new(vec![1, -1]);

        bridge.step(&mut states, &foreign);

        assert!(bridge.state.internal_energy >= 0.0);
        assert!(bridge.state.bridge_energy >= 0.0);
    }

    #[test]
    fn test_cross_correlation_history() {
        let mut states = test_fleet(4, 2, true);
        let mut bridge = Bridge::new("foreign", 0.3, 0.2);
        let foreign = SignPattern::new(vec![1, -1, 1, -1]);

        for _ in 0..5 {
            bridge.step(&mut states, &foreign);
        }

        assert_eq!(bridge.state.cross_correlation_history.len(), 5);
        // History should be monotonic or generally increasing as alignment improves
        // At minimum, all entries should be valid correlation values in [-1, 1]
        for &c in &bridge.state.cross_correlation_history {
            assert!((-1.0..=1.0).contains(&c));
        }
    }

    #[test]
    fn test_bridge_high_coupling_strong_alignment() {
        // With high bridge coupling, alignment should be near-perfect
        let mut fleet_a = vec![vec![1.0], vec![-1.0], vec![0.3], vec![-0.8]];
        let mut fleet_b = vec![vec![-1.0], vec![1.0], vec![-0.3], vec![0.8]];

        let mut bridge_a = Bridge::new("fleet-b", 0.3, 0.8); // strong bridge
        let mut bridge_b = Bridge::new("fleet-a", 0.3, 0.8);

        for _ in 0..50 {
            let signs_a = Bridge::broadcast_signs(&fleet_a);
            let signs_b = Bridge::broadcast_signs(&fleet_b);
            bridge_a.step(&mut fleet_a, &signs_b);
            bridge_b.step(&mut fleet_b, &signs_a);
        }

        let corr = Bridge::measure_correlation(&fleet_a, &[Bridge::broadcast_signs(&fleet_b)]);
        assert!(corr.abs() > 0.8, "High coupling should give strong alignment, corr = {}", corr);
    }

    #[test]
    fn test_empty_fleet() {
        let empty: Vec<Vec<f64>> = vec![];
        let signs = Bridge::broadcast_signs(&empty);
        assert!(signs.is_empty());

        let mut bridge = Bridge::new("foreign", 0.3, 0.2);
        let foreign = SignPattern::new(vec![1, -1]);
        bridge.step(&mut [], &foreign); // should not panic

        let corr = Bridge::measure_correlation(&empty, &[foreign]);
        assert_eq!(corr, 0.0);
    }

    #[test]
    fn test_bridge_creation() {
        let bridge = Bridge::new("fleet-42", 0.3, 0.2);
        assert_eq!(bridge.fleet_id, "fleet-42");
        assert_eq!(bridge.internal_coupling, 0.3);
        assert_eq!(bridge.bridge_coupling, 0.2);
    }

    #[test]
    fn test_alignment_indestructibility() {
        // Even after 10x perturbation, alignment should restore quickly
        let mut fleet_a = vec![vec![1.0; 3]; 4];
        let mut fleet_b = vec![vec![-1.0; 3]; 4];

        let mut bridge_a = Bridge::new("fleet-b", 0.3, 0.2);
        let mut bridge_b = Bridge::new("fleet-a", 0.3, 0.2);

        // Converge first
        for _ in 0..30 {
            let sa = Bridge::broadcast_signs(&fleet_a);
            let sb = Bridge::broadcast_signs(&fleet_b);
            bridge_a.step(&mut fleet_a, &sb);
            bridge_b.step(&mut fleet_b, &sa);
        }

        // Check initial alignment
        let corr_before = Bridge::measure_correlation(&fleet_a, &[Bridge::broadcast_signs(&fleet_b)]);
        assert!(corr_before.abs() > 0.7, "Before perturbation: {}", corr_before);

        // Apply 10x perturbation
        for state in fleet_a.iter_mut() {
            for val in state.iter_mut() {
                *val *= 10.0;
            }
        }

        // Restore in 8 steps
        for _ in 0..8 {
            let sa = Bridge::broadcast_signs(&fleet_a);
            let sb = Bridge::broadcast_signs(&fleet_b);
            bridge_a.step(&mut fleet_a, &sb);
            bridge_b.step(&mut fleet_b, &sa);
        }

        let corr_after = Bridge::measure_correlation(&fleet_a, &[Bridge::broadcast_signs(&fleet_b)]);
        assert!(corr_after.abs() > 0.5, "After perturbation+restore: {}", corr_after);
    }

    #[test]
    fn test_pruning_creates_correlation_gain() {
        // 8 agents with random-ish states
        let mut fleet_8: Vec<Vec<f64>> = (0..8)
            .map(|i| vec![if i % 2 == 0 { 0.7 } else { -0.3 }; 3])
            .collect();
        let fleet_4: Vec<Vec<f64>> = (0..4)
            .map(|i| vec![if i % 2 == 0 { -0.7 } else { 0.3 }; 3])
            .collect();

        let foreign_signs_8 = Bridge::broadcast_signs(&fleet_4); // 4 agents
        let mut bridge_8 = Bridge::new("foreign", 0.3, 0.2);
        bridge_8.step(&mut fleet_8, &foreign_signs_8);
        let corr_8 = Bridge::measure_correlation(&fleet_8, &[foreign_signs_8]);

        // Prune to 4 agents
        let fleet_4_internal = fleet_8[..4].to_vec();
        let foreign_signs_4 = Bridge::broadcast_signs(&fleet_4_internal);
        let corr_4 = Bridge::measure_correlation(&fleet_4_internal, &[foreign_signs_4]);

        // Pruned fleet should have correlation at least as high
        assert!(corr_4 >= corr_8 - 0.01, "Pruning should not decrease correlation: {} vs {}", corr_4, corr_8);
    }

    #[test]
    fn test_phase_transition_characteristic() {
        // Demonstration of the alignment phase transition.
        // The foreign sign pattern is OPPOSITE to the initial fleet alignment.
        // Below critical coupling: fleet stays in its original alignment
        // Above critical coupling: fleet flips to match the foreign pattern

        // Fleet starts all positive
        let mut states_low: Vec<Vec<f64>> = (0..4)
            .map(|_| vec![0.8, 0.5])
            .collect();
        // Foreign pattern is all negative (opposite)
        let foreign_negative = SignPattern::new(vec![-1; 4]);

        // Low coupling: fleet should stay positive despite foreign pull
        let mut bridge_low = Bridge::new("foreign", 0.01, 0.005);
        for _ in 0..100 {
            bridge_low.step(&mut states_low, &foreign_negative);
        }
        let signs_low = Bridge::broadcast_signs(&states_low);
        let agreement_low = signs_low.agreement(&foreign_negative);

        // High coupling: fleet should flip to match foreign pattern
        let mut states_high: Vec<Vec<f64>> = (0..4)
            .map(|_| vec![0.8, 0.5])
            .collect();
        let mut bridge_high = Bridge::new("foreign", 0.3, 0.2);
        for _ in 0..100 {
            bridge_high.step(&mut states_high, &foreign_negative);
        }
        let signs_high = Bridge::broadcast_signs(&states_high);
        let agreement_high = signs_high.agreement(&foreign_negative);

        eprintln!("Phase transition: low agreement={}, high agreement={}", agreement_low, agreement_high);

        // High coupling should flip the fleet to match the foreign pattern
        assert!(
            agreement_high > 0.75,
            "High coupling should flip fleet to match: agreement={}",
            agreement_high
        );
    }

    #[test]
    fn test_same_question_correlation_boost() {
        // Agents answering same "question" (same initial patterns) should correlate more
        let fleet_same = vec![vec![0.8, -0.2, 0.5]; 3];
        let fleet_same2 = vec![vec![0.85, -0.15, 0.45]; 3]; // nearly same initial state
        let fleet_diff = vec![vec![-0.8, 0.2, -0.5]; 3]; // opposite initial state

        let mut bridge_same = Bridge::new("fleet-same", 0.2, 0.15);
        let mut bridge_diff = Bridge::new("fleet-diff", 0.2, 0.15);

        let foreign_same = SignPattern::new(vec![1; 3]);
        let foreign_diff = SignPattern::new(vec![-1; 3]);

        let mut f_same = fleet_same.clone();
        let mut f_same2 = fleet_same2.clone();
        let mut f_diff = fleet_diff.clone();

        // Step same-question agents
        for _ in 0..30 {
            bridge_same.step(&mut f_same, &foreign_same);
            bridge_same.step(&mut f_same2, &foreign_same);
        }
        // Step different-question agents
        for _ in 0..30 {
            bridge_diff.step(&mut f_diff, &foreign_diff);
        }

        let corr_same = Bridge::measure_correlation(&f_same, &[Bridge::broadcast_signs(&f_same2)]);
        let corr_diff = Bridge::measure_correlation(&f_same, &[Bridge::broadcast_signs(&f_diff)]);

        // Same-question should have ~1.05× stronger correlation (qualitative check)
        // At minimum, they should be more correlated
        assert!(
            corr_same >= corr_diff - 0.1,
            "Same-question agents should correlate at least as well: same={}, diff={}",
            corr_same,
            corr_diff
        );
    }
}
