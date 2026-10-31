//! Filling the file behind the readers.
//!
//! Once the window is all here and the reader has gone quiet (paused on a
//! full buffer, or no seek in a while), the selection widens to the whole
//! file, disk allowing; the stream priority still puts the window first.
//!
//! A fill is kept when it stops, since the host's background remux moves the
//! reader around the file: the reservation stays at the file's size
//! (`Holding`) until another torrent needs the room.

use std::time::Duration;

pub const QUIET: Duration = Duration::from_secs(20);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fill {
    Off,
    Filling,
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
    pub fn reserves_file(self) -> bool {
        self != Fill::Off
    }
}

/// What the reader looks like right now, as the sweep sees it.
#[derive(Clone, Copy, Debug)]
pub struct Reader {
    pub quiet: bool,
    pub window_have: bool,
    /// Someone still holds the file: with nobody, filling it is for no one.
    pub leased: bool,
}

/// The next state, from the current one and what the sweep observed.
/// `fits` is whether the whole file could be reserved right now.
pub fn decide(now: Fill, reader: Reader, fits: bool) -> Fill {
    if !fits || !reader.leased {
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

    const QUIET_AND_HAVE: Reader = Reader { quiet: true, window_have: true, leased: true };
    const BUSY: Reader = Reader { quiet: false, window_have: true, leased: true };
    const WAITING: Reader = Reader { quiet: true, window_have: false, leased: true };
    const LEFT: Reader = Reader { quiet: true, window_have: true, leased: false };

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

    #[test]
    fn nobody_left_holding_the_file_ends_everything() {
        assert_eq!(decide(Fill::Off, LEFT, true), Fill::Off);
        assert_eq!(decide(Fill::Filling, LEFT, true), Fill::Off);
        assert_eq!(decide(Fill::Holding, LEFT, true), Fill::Off);
    }
}
