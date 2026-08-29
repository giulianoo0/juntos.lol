//! Filling the file behind the readers.
//!
//! The window keeps the swarm on what a reader is about to need. Once that
//! is all here and the reader has gone quiet — the remux is paused on a full
//! buffer, or nobody has seeked in a while — the peers have nothing left to
//! do, and every byte they could bring in now is a byte the next cold seek
//! does not wait for. So, disk allowing, the selection widens to the whole
//! file. The stream priority still puts the reader's window first; the rest
//! is only asked for when the window is entirely in flight.
//!
//! What a fill brought in is not thrown away when it stops. The host's own
//! background remux moves the reader around the file for minutes, and
//! releasing on every move would discard exactly what it is about to read.
//! The reservation stays at the file's size — `Holding` — until another
//! torrent needs the room, and only then is it given back.

use std::time::Duration;

/// How long the reader must have been still before the fill starts. Long
/// enough that a seek's own reads, and the scan slices that follow it, are
/// not mistaken for quiet.
pub const QUIET: Duration = Duration::from_secs(20);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fill {
    /// The window alone; the sweep releases what falls outside it.
    Off,
    /// The whole file is selected; the reservation is the file's size.
    Filling,
    /// The window alone again, but nothing is released and the reservation
    /// keeps the file's size: what the fill brought in stays.
    Holding,
}

impl Fill {
    pub fn name(self) -> &'static str {
        match self {
            Fill::Off => "off",
            Fill::Filling => "filling",
            Fill::Holding => "holding",
        }
    }
    /// Whether the reservation is the whole file rather than the window.
    pub fn reserves_file(self) -> bool {
        self != Fill::Off
    }
}

/// What the reader looks like right now, as the sweep sees it.
#[derive(Clone, Copy, Debug)]
pub struct Reader {
    /// No hint and no out-of-window read for `QUIET`.
    pub quiet: bool,
    /// Every piece of the playhead's window is already here. True when
    /// there is no playhead at all: nothing is blocking on anything.
    pub window_have: bool,
}

/// The next state, from the current one and what the sweep observed.
/// `fits` is whether the whole file could be reserved right now.
pub fn decide(now: Fill, reader: Reader, fits: bool) -> Fill {
    if !fits {
        return Fill::Off;
    }
    if reader.quiet && reader.window_have {
        return Fill::Filling;
    }
    match now {
        Fill::Filling => Fill::Holding,
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const QUIET_AND_HAVE: Reader = Reader { quiet: true, window_have: true };
    const BUSY: Reader = Reader { quiet: false, window_have: true };
    const WAITING: Reader = Reader { quiet: true, window_have: false };

    #[test]
    fn starts_only_when_the_reader_is_quiet_and_served() {
        assert_eq!(decide(Fill::Off, QUIET_AND_HAVE, true), Fill::Filling);
        assert_eq!(decide(Fill::Off, BUSY, true), Fill::Off);
        assert_eq!(decide(Fill::Off, WAITING, true), Fill::Off);
    }

    #[test]
    fn a_moving_reader_keeps_what_was_filled() {
        assert_eq!(decide(Fill::Filling, BUSY, true), Fill::Holding);
        assert_eq!(decide(Fill::Holding, BUSY, true), Fill::Holding);
        assert_eq!(decide(Fill::Holding, QUIET_AND_HAVE, true), Fill::Filling);
    }

    #[test]
    fn disk_pressure_ends_everything() {
        assert_eq!(decide(Fill::Filling, QUIET_AND_HAVE, false), Fill::Off);
        assert_eq!(decide(Fill::Holding, BUSY, false), Fill::Off);
    }
}
