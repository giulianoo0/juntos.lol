//! Sound from several apps, summed into one stereo stream.

use std::collections::VecDeque;

/// Sums the inputs sample by sample, clamping instead of wrapping; a short
/// input counts as silence past its end.
pub fn mix(inputs: &[&[i16]]) -> Vec<i16> {
    let len = inputs.iter().map(|i| i.len()).max().unwrap_or(0);
    (0..len)
        .map(|n| {
            let sum: i32 = inputs.iter().map(|i| i.get(n).copied().unwrap_or(0) as i32).sum();
            sum.clamp(i16::MIN as i32, i16::MAX as i32) as i16
        })
        .collect()
}

/// One app's samples waiting to be mixed. It keeps at most `cap` samples: an
/// app running ahead of the mixer loses its oldest sound instead of drifting
/// later and later.
pub struct Ring {
    samples: VecDeque<i16>,
    cap: usize,
}

impl Ring {
    pub fn new(cap: usize) -> Self {
        Ring { samples: VecDeque::with_capacity(cap), cap }
    }

    pub fn push(&mut self, samples: &[i16]) {
        self.samples.extend(samples);
        let over = self.samples.len().saturating_sub(self.cap);
        self.samples.drain(..over);
    }

    /// Exactly `n` samples, silence where the app had nothing yet.
    pub fn take(&mut self, n: usize) -> Vec<i16> {
        let have = n.min(self.samples.len());
        let mut out: Vec<i16> = self.samples.drain(..have).collect();
        out.resize(n, 0);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_mix_clamps_instead_of_wrapping() {
        assert_eq!(mix(&[&[30_000, -30_000], &[30_000, -30_000]]), vec![i16::MAX, i16::MIN]);
        assert_eq!(mix(&[&[1, 2, 3], &[10]]), vec![11, 2, 3]);
    }

    #[test]
    fn a_ring_drops_the_oldest_and_pads_with_silence() {
        let mut ring = Ring::new(4);
        ring.push(&[1, 2, 3, 4, 5, 6]);
        assert_eq!(ring.take(2), vec![3, 4]);
        assert_eq!(ring.take(4), vec![5, 6, 0, 0]);
    }
}
