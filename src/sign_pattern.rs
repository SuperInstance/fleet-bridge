/// A sign pattern across a fleet — one `i8` per agent, either `+1` or `-1`.
///
/// This is the **1-bit miracle**: each agent's full high-dimensional state is reduced to
/// a single bit (the sign of its mean). Despite this extreme compression, cross-fleet
/// correlation emerges and is measurable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignPattern {
    /// Signs for each agent: +1 or -1
    pub signs: Vec<i8>,
}

impl SignPattern {
    /// Create a new `SignPattern` from a vector of signs.
    ///
    /// # Panics
    ///
    /// Panics if any sign is not exactly +1 or -1.
    pub fn new(signs: Vec<i8>) -> Self {
        for &s in &signs {
            assert!(s == 1 || s == -1, "Sign must be +1 or -1, got {}", s);
        }
        Self { signs }
    }

    /// Number of agents in this pattern.
    pub fn len(&self) -> usize {
        self.signs.len()
    }

    /// Returns `true` if this pattern is empty.
    pub fn is_empty(&self) -> bool {
        self.signs.is_empty()
    }

    /// Return the sign at index `i`.
    pub fn get(&self, i: usize) -> Option<i8> {
        self.signs.get(i).copied()
    }

    /// Create a zero-initialized pattern (all +1). Useful for testing.
    pub fn zeros(n: usize) -> Self {
        Self {
            signs: vec![1; n],
        }
    }

    /// Compute the Hamming agreement ratio with another pattern (fraction of matching signs).
    pub fn agreement(&self, other: &SignPattern) -> f64 {
        assert_eq!(self.len(), other.len(), "Patterns must have same length");
        if self.len() == 0 {
            return 1.0;
        }
        let matches = self.signs.iter().zip(&other.signs).filter(|(a, b)| a == b).count();
        matches as f64 / self.len() as f64
    }

    /// Flip all signs.
    pub fn invert(&self) -> Self {
        Self {
            signs: self.signs.iter().map(|&s| -s).collect(),
        }
    }
}

impl std::fmt::Display for SignPattern {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[")?;
        for (i, &s) in self.signs.iter().enumerate() {
            if i > 0 {
                write!(f, ", ")?;
            }
            write!(f, "{}", if s == 1 { "+" } else { "-" })?;
        }
        write!(f, "]")
    }
}
